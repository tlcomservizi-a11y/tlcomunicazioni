// Follow-up automatici: ricontatta chi ha smesso di rispondere, con messaggi scritti dall'IA
// a partire dalla conversazione. Si ferma appena il cliente risponde o dopo N tentativi.
import { addMessage, all, getBusiness, run, type Business, type Contact } from "./db.js";
import { generateText } from "./agents/client.js";
import { canUseAI } from "./billing.js";
import { businessCard } from "./agents/profile.js";
import { sendToContact } from "./channels/send.js";
import { sendWhatsAppTemplate } from "./channels/whatsapp.js";
import { describeNow, freeSlots, nowLocal } from "./schedule.js";

const NO_FOLLOWUP = "NESSUN_FOLLOWUP";

const FOLLOWUP_SYSTEM = `Scrivi messaggi di follow-up per una piccola attività italiana, a clienti che hanno smesso di rispondere in chat.

Regole:
- Massimo due frasi, tono umano e non insistente, come un messaggio WhatsApp. Niente markdown.
- Riprendi esattamente il punto in cui la conversazione si era fermata e offri un aiuto concreto (per esempio due orari liberi, o rispondere a un dubbio).
- Usa il nome del cliente se lo conosci. Non inventare prezzi o promozioni che non sono nella scheda.
- Al secondo tentativo o successivi, chiudi con gentilezza lasciando la porta aperta.
- Se un follow-up non ha senso (il cliente ha già detto di no, ha chiesto di non essere contattato, la richiesta era chiusa o fuori target), rispondi solo con ${NO_FOLLOWUP}.
- Rispondi solo con il testo del messaggio da inviare.`;

/** Orario in cui è educato scrivere: lun-sab, 9-20 ora italiana. */
export function politeHour(): boolean {
  const now = nowLocal();
  const day = new Date(`${now.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const hour = Number(now.slice(11, 13));
  return day !== 0 && hour >= 9 && hour < 20;
}

/** Contatti in attesa di follow-up per un'attività. */
export function dueContacts(b: Business): Contact[] {
  return all<Contact>(
    `SELECT c.* FROM contacts c
     WHERE c.business_id = ? AND c.ai_paused = 0
       AND c.channel IN ('whatsapp', 'test')
       AND c.status NOT IN ('cliente', 'perso')
       AND (c.score IS NULL OR c.score >= 30)
       AND c.followup_count < ?
       AND c.last_customer_at IS NOT NULL
       AND c.last_message_at <= datetime('now', '-' || ? || ' hours')
       AND (SELECT author FROM messages m WHERE m.contact_id = c.id ORDER BY id DESC LIMIT 1) IN ('agente', 'titolare')
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.contact_id = c.id AND a.status = 'confermato' AND a.starts_at >= ?)
     ORDER BY c.score DESC NULLS LAST, c.last_message_at
     LIMIT 50`,
    b.id,
    b.followup_max,
    b.followup_after_hours,
    nowLocal(),
  );
}

export interface FollowupReport {
  sent: number;
  skipped: { contact: string; reason: string }[];
}

async function followupOne(b: Business, c: Contact): Promise<string | null> {
  const label = c.name || c.external_id;
  // WhatsApp: testo libero solo entro 24 ore dall'ultimo messaggio del cliente.
  const insideWindow =
    c.channel !== "whatsapp" ||
    (c.last_customer_at !== null && Date.parse(c.last_customer_at.replace(" ", "T") + "Z") > Date.now() - 23 * 3600e3);

  if (!insideWindow) {
    if (!b.wa_followup_template) {
      run("UPDATE contacts SET followup_count = ? WHERE id = ?", b.followup_max, c.id);
      return "oltre le 24 ore di WhatsApp e nessun modello approvato impostato";
    }
    await sendWhatsAppTemplate(b, c.external_id, b.wa_followup_template, c.name?.split(" ")[0] ?? "");
    addMessage(b.id, c.id, "agente", `[modello WhatsApp "${b.wa_followup_template}"]`, "followup");
    run("UPDATE contacts SET followup_count = followup_count + 1 WHERE id = ?", c.id);
    return null;
  }

  const history = all<{ author: string; text: string }>(
    "SELECT author, text FROM (SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 30) ORDER BY id",
    c.id,
  );
  const transcript = history.map((m) => `${m.author === "cliente" ? "Cliente" : "Attività"}: ${m.text}`).join("\n");
  const slots = freeSlots(b, undefined, 4, 6);
  const res = await generateText({
    businessId: b.id,
    agent: "follow-up",
    system: `${FOLLOWUP_SYSTEM}\n\n${businessCard(b)}`,
    messages: [
      {
        role: "user",
        content: `Adesso è ${describeNow()}.
Cliente: ${c.name || "nome non noto"}; interesse: ${c.interest || "non indicato"}; valutazione: ${c.score ?? "non valutato"} ${c.qualification}.
Tentativo di follow-up n. ${c.followup_count + 1} di ${b.followup_max}.
Orari liberi utili: ${JSON.stringify(slots)}

<conversazione>
${transcript}
</conversazione>

Scrivi il messaggio di follow-up.`,
      },
    ],
  });
  const text = res.text.trim();
  if (res.refused || !text || text.includes(NO_FOLLOWUP)) {
    run("UPDATE contacts SET followup_count = ? WHERE id = ?", b.followup_max, c.id);
    return `nessun follow-up opportuno per ${label}`;
  }
  await sendToContact(c, text, "agente", "followup");
  run("UPDATE contacts SET followup_count = followup_count + 1 WHERE id = ?", c.id);
  return null;
}

/** Esegue i follow-up dovuti per un'attività. force=true ignora fascia oraria e interruttore. */
export async function runFollowups(businessId: number, force = false): Promise<FollowupReport> {
  const b = getBusiness(businessId);
  const report: FollowupReport = { sent: 0, skipped: [] };
  if (!force && (!b.followup_enabled || !b.ai_enabled || !politeHour())) return report;
  if (!canUseAI(b)) {
    report.skipped.push({ contact: "tutti", reason: "crediti IA esauriti" });
    return report;
  }
  for (const c of dueContacts(b)) {
    try {
      const skip = await followupOne(b, c);
      if (skip) report.skipped.push({ contact: c.name || c.external_id, reason: skip });
      else report.sent++;
    } catch (e) {
      report.skipped.push({ contact: c.name || c.external_id, reason: (e as Error).message });
    }
  }
  return report;
}
