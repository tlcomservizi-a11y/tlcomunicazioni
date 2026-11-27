import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { run } from "../db.js";

// Credenziali: ANTHROPIC_API_KEY (o un profilo `ant auth login`).
export const anthropic = new Anthropic();
export const MODEL = process.env.TL_MODEL ?? "claude-opus-5-5";

export class AgentUnavailableError extends Error {}

export type Effort ="low" | "medium" | "high" | "xhigh" | "max";

export interface AgentResult {
  text: string;
  refused: boolean;
}

/**
 * Esegue un agente con il tool runner dell'SDK: Claude chiama i tool finché ha finito.
 * - system: blocco stabile (istruzioni + profilo attività) messo in cache.
 * - fallback lato server: se il modello rifiuta, l'API riprova sul modello di riserva.
 */
export async function runAgent(opts: {
  businessId: number;
  agent: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: BetaRunnableTool<any>[];
  effort?: Effort;
  maxIterations?: number;
}): Promise<AgentResult> {
  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: opts.messages,
    tools: opts.tools,
    output_config: { effort: opts.effort ?? "medium" },
    max_iterations: opts.maxIterations ?? 10,
  });

  let last: Anthropic.Beta.BetaMessage | undefined;
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  try {
    for await (const message of runner) {
      last = message;
      inTok += message.usage.input_tokens;
      outTok += message.usage.output_tokens;
      cacheTok += message.usage.cache_read_input_tokens ?? 0;
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw err;
    // Errori prima della chiamata (es. credenziali mancanti) o di rete.
    throw new AgentUnavailableError((err as Error).message);
  }
  if (!last) throw new Error("Nessuna risposta dal modello");

  run(
    `INSERT INTO agent_runs (business_id, agent, model, input_tokens, output_tokens, cache_read_tokens, stop_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    opts.businessId,
    opts.agent,
    last.model,
    inTok,
    outTok,
    cacheTok,
    last.stop_reason ?? "",
  );

  if (last.stop_reason === "refusal") return { text: "", refused: true };
  const text = last.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text, refused: false };
}

/** Converte la cronologia (autore + testo) in messaggi alternati user/assistant validi per l'API. */
export function toApiMessages(
  rows: { role: "user" | "assistant"; text: string }[],
): Anthropic.Beta.BetaMessageParam[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const r of rows) {
    if (!r.text.trim()) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === r.role) prev.text += `\n${r.text}`;
    else out.push({ ...r });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.map((m) => ({ role: m.role, content: m.text }));
}
