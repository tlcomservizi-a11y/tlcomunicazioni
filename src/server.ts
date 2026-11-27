import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import { api } from "./routes/api.js";
import { receiveWebhook, verifyWebhook } from "./channels/whatsapp.js";
import { all, one } from "./db.js";
import { generateProposals } from "./agents/manager.js";
import { AgentUnavailableError } from "./agents/client.js";
import { nowLocal } from "./schedule.js";
import { runFollowups } from "./followup.js";

const app = express();
app.set("trust proxy", 1);
app.use(
  express.json({
    limit: "1mb",
    // Serve il corpo grezzo per verificare la firma dei webhook di Meta.
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(cookieParser());

// Il widget della chat gira sui siti dei clienti: le API pubbliche accettano richieste da altri domini.
app.use("/api/public", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.get("/webhooks/whatsapp", verifyWebhook);
app.post("/webhooks/whatsapp", receiveWebhook);
app.use("/api", api);
app.use(express.static("public", { extensions: ["html"] }));
app.get(/^\/app(\/.*)?$/, (_req, res) => res.sendFile("app/index.html", { root: "public" }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Dati non validi", details: err.issues });
    return;
  }
  if (err instanceof Anthropic.AuthenticationError) {
    console.error("[ia] chiave API non valida");
    res.status(502).json({ error: "Agenti IA non configurati: controlla ANTHROPIC_API_KEY." });
    return;
  }
  if (err instanceof Anthropic.RateLimitError) {
    res.status(503).json({ error: "Gli agenti sono molto occupati, riprova tra poco." });
    return;
  }
  if (err instanceof Anthropic.APIError) {
    console.error("[ia]", err.status, err.message);
    res.status(502).json({ error: "Errore temporaneo degli agenti IA, riprova." });
    return;
  }
  if (err instanceof AgentUnavailableError || err instanceof Anthropic.AnthropicError) {
    // Es. credenziali mancanti o rete: l'SDK fallisce prima di ricevere una risposta.
    console.error("[ia]", err.message);
    res.status(502).json({ error: "Agenti IA non configurati: imposta ANTHROPIC_API_KEY sul server." });
    return;
  }
  console.error(err);
  res.status(500).json({ error: (err as Error).message ?? "Errore interno" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`TL agenti attivo su http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Attenzione: ANTHROPIC_API_KEY non impostata, gli agenti non potranno rispondere.");
});

// Proposte automatiche: una volta al giorno, dalle 8 alle 9, per le attività che non ne hanno ancora oggi.
if (process.env.AUTO_PROPOSALS === "1") {
  setInterval(async () => {
    const hour = Number(nowLocal().slice(11, 13));
    if (hour !== 8) return;
    for (const b of all<{ id: number }>("SELECT id FROM businesses WHERE ai_enabled = 1")) {
      const done = one("SELECT 1 FROM proposals WHERE business_id = ? AND date(created_at) = date('now') AND action_type != 'nota'", b.id);
      if (done) continue;
      await generateProposals(b.id).catch((e) => console.error("[proposte]", b.id, e.message));
    }
  }, 10 * 60 * 1000);
}

// Follow-up automatici: ogni 10 minuti, per le attività che li hanno attivati (solo lun-sab 9-20).
setInterval(async () => {
  for (const b of all<{ id: number }>("SELECT id FROM businesses WHERE followup_enabled = 1 AND ai_enabled = 1")) {
    const r = await runFollowups(b.id).catch((e) => {
      console.error("[follow-up]", b.id, e.message);
      return null;
    });
    if (r?.sent) console.log(`[follow-up] attività ${b.id}: ${r.sent} inviati`);
  }
}, 10 * 60 * 1000);
