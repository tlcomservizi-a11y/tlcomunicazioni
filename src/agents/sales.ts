// Agente Vendite: risponde ai clienti (WhatsApp, widget del sito) a nome dell'attività.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { addMessage, all, getBusiness, getContact, HOT_SCORE, one, run, type Business, type Contact } from "../db.js";
import { bookAppointment, cancelAppointment, describeNow, freeSlots, upcomingForContact } from "../schedule.js";
import { runAgent, toApiMessages } from "./client.js";
import { OutOfCreditsError } from "../billing.js";
import { businessCard } from "./profile.js";

const SALES_SYSTEM = `Sei l'assistente commerciale di una piccola attività italiana e rispondi ai suoi clienti in chat (WhatsApp o chat del sito) a nome dell'attività.

Obiettivo: rispondere subito e bene, dare informazioni corrette e, quando ha senso, portare il cliente a fissare un appuntamento o a lasciare i suoi dati.

Come lavori:
- Usa solo le informazioni nella scheda <attivita>. Se un prezzo o un dettaglio non c'è, non inventarlo: di' che verifichi con il titolare e usa handoff_to_owner.
- Scrivi come un messaggio WhatsApp: frasi brevi, niente elenchi lunghi, niente markdown (niente asterischi o titoli). Al massimo un'emoji quando è naturale.
- Rispetta il tono di voce indicato nella scheda.
- Per proporre orari usa sempre get_available_slots e proponi 2 o 3 alternative concrete. Fissa con book_appointment solo dopo che il cliente ha scelto un orario preciso.
- Quando il cliente ti dice il nome, cosa gli interessa, email o telefono, salvali con update_contact. Aggiorna lo stato a "in trattativa" quando mostra interesse concreto e a "cliente" quando prenota.
- Prequalifica: in base alle regole di qualifica della scheda, raccogli con naturalezza le informazioni che mancano (una domanda per messaggio, mai un interrogatorio). Appena hai elementi nuovi, valuta il contatto con qualify_lead; aggiorna la valutazione se cambia qualcosa.
- Se il cliente chiede una persona, è arrabbiato, ha un reclamo, chiede sconti fuori listino o qualcosa che non sai gestire, usa handoff_to_owner e digli che il titolare lo ricontatterà a breve.
- Non dire mai di essere un'intelligenza artificiale se non te lo chiedono; se te lo chiedono, dillo con naturalezza: sei l'assistente digitale dell'attività.
- Rispondi in italiano, o nella lingua in cui scrive il cliente.

La tua risposta finale (il testo dopo eventuali tool) è esattamente il messaggio che verrà inviato al cliente.`;

function salesTools(b: Business, contact: Contact) {
  return [
    betaZodTool({
      name: "get_available_slots",
      description:
        "Restituisce gli orari liberi per un appuntamento a partire da una data (YYYY-MM-DD), per i giorni successivi. Usalo prima di proporre orari al cliente.",
      inputSchema: z.object({
        from_date: z.string().describe("Data di partenza YYYY-MM-DD; ometti per partire da oggi").optional(),
        days: z.number().int().min(1).max(14).describe("Quanti giorni guardare, default 5").optional(),
      }),
      run: async ({ from_date, days }) => {
        const slots = freeSlots(b, from_date, days ?? 5);
        if (!slots.length) return "Nessun orario libero nel periodo richiesto (o orari di apertura non configurati).";
        return JSON.stringify(slots);
      },
    }),
    betaZodTool({
      name: "book_appointment",
      description:
        "Fissa un appuntamento per questo cliente in un orario libero. Usalo solo dopo che il cliente ha confermato giorno e ora.",
      inputSchema: z.object({
        starts_at: z.string().describe("Inizio in ora italiana, formato YYYY-MM-DDTHH:MM"),
        service: z.string().describe("Servizio richiesto"),
        customer_name: z.string().describe("Nome del cliente, se noto").optional(),
        notes: z.string().optional(),
      }),
      run: async ({ starts_at, service, customer_name, notes }) => {
        if (customer_name && !contact.name) {
          run("UPDATE contacts SET name = ? WHERE id = ?", customer_name, contact.id);
        }
        const r = bookAppointment(b, { contactId: contact.id, startsAt: starts_at, service, notes, createdBy: "agente" });
        if (!r.ok) return `Non prenotato: ${r.error}. Proponi un altro orario libero.`;
        run("UPDATE contacts SET status = 'cliente' WHERE id = ? AND status != 'cliente'", contact.id);
        return `Appuntamento confermato (id ${r.id}) per ${starts_at}, servizio: ${service}.`;
      },
    }),
    betaZodTool({
      name: "list_my_appointments",
      description: "Elenca i prossimi appuntamenti di questo cliente (per spostarli o annullarli).",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(upcomingForContact(b.id, contact.id)),
    }),
    betaZodTool({
      name: "cancel_appointment",
      description: "Annulla un appuntamento di questo cliente, se lo chiede esplicitamente.",
      inputSchema: z.object({ appointment_id: z.number().int() }),
      run: async ({ appointment_id }) =>
        cancelAppointment(b.id, appointment_id, contact.id) ? "Appuntamento annullato." : "Appuntamento non trovato.",
    }),
    betaZodTool({
      name: "update_contact",
      description: "Salva nel CRM i dati che il cliente ha comunicato. Passa solo i campi nuovi.",
      inputSchema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        interest: z.string().describe("Servizio o prodotto che interessa al cliente").optional(),
        status: z.enum(["nuovo", "in trattativa", "cliente", "perso"]).optional(),
        note: z.string().describe("Nota breve da aggiungere alla scheda").optional(),
      }),
      run: async (f) => {
        const c = getContact(b.id, contact.id)!;
        run(
          "UPDATE contacts SET name = ?, email = ?, phone = ?, interest = ?, status = ?, notes = ? WHERE id = ?",
          f.name ?? c.name,
          f.email ?? c.email,
          f.phone ?? c.phone,
          f.interest ?? c.interest,
          f.status ?? c.status,
          f.note ? `${c.notes ? c.notes + "\n" : ""}${f.note}` : c.notes,
          c.id,
        );
        return "Contatto aggiornato.";
      },
    }),
    betaZodTool({
      name: "qualify_lead",
      description:
        "Valuta quanto è promettente il contatto secondo le regole di qualifica della scheda. 0-39 poco interessante o fuori target, 40-69 da coltivare, 70-100 caldo (il titolare viene avvisato).",
      inputSchema: z.object({
        score: z.number().int().min(0).max(100),
        reason: z.string().describe("Motivazione in una frase, con i fatti emersi (zona, budget, tempi, bisogno)"),
      }),
      run: async ({ score, reason }) => {
        const before = getContact(b.id, contact.id)!;
        run("UPDATE contacts SET score = ?, qualification = ? WHERE id = ?", score, reason, contact.id);
        if (score >= HOT_SCORE && (before.score ?? 0) < HOT_SCORE) {
          run(
            "INSERT INTO proposals (business_id, title, detail, action_type, action_payload) VALUES (?, ?, ?, 'nota', ?)",
            b.id,
            `Contatto caldo: ${before.name || before.external_id} (${score}/100)`,
            reason,
            JSON.stringify({ contact_id: contact.id }),
          );
        }
        return "Valutazione salvata.";
      },
    }),
    betaZodTool({
      name: "handoff_to_owner",
      description:
        "Passa la conversazione al titolare: l'assistente smette di rispondere a questo cliente finché il titolare non lo riattiva.",
      inputSchema: z.object({ reason: z.string().describe("Perché serve il titolare, in una frase") }),
      run: async ({ reason }) => {
        run("UPDATE contacts SET ai_paused = 1 WHERE id = ?", contact.id);
        run(
          "INSERT INTO proposals (business_id, title, detail, action_type, action_payload) VALUES (?, ?, ?, 'nota', ?)",
          b.id,
          `Rispondi a ${contact.name || contact.external_id}`,
          reason,
          JSON.stringify({ contact_id: contact.id }),
        );
        return "Conversazione passata al titolare. Avvisa il cliente che verrà ricontattato a breve.";
      },
    }),
  ];
}

// Una risposta alla volta per contatto: messaggi ravvicinati vengono gestiti in ordine.
const queues = new Map<number, Promise<unknown>>();

/**
 * Genera e salva la risposta dell'agente all'ultimo messaggio del cliente.
 * Ritorna il testo da inviare, o null se l'assistente è in pausa per questo contatto.
 */
export function replyToCustomer(businessId: number, contactId: number): Promise<string | null> {
  const prev = queues.get(contactId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doReply(businessId, contactId));
  queues.set(contactId, next);
  next
    .finally(() => {
      if (queues.get(contactId) === next) queues.delete(contactId);
    })
    .catch(() => {}); // l'errore lo gestisce chi ha chiamato replyToCustomer
  return next;
}

async function doReply(businessId: number, contactId: number): Promise<string | null> {
  const b = getBusiness(businessId);
  const contact = getContact(businessId, contactId);
  if (!contact || !b.ai_enabled || contact.ai_paused) return null;

  const history = all<{ author: string; text: string }>(
    "SELECT author, text FROM (SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 40) ORDER BY id",
    contactId,
  );
  // Già risposto all'ultimo messaggio del cliente (es. due webhook ravvicinati)?
  if (!history.length || history[history.length - 1].author !== "cliente") return null;

  const messages = toApiMessages(
    history.map((m) => ({ role: m.author === "cliente" ? "user" : "assistant", text: m.text })),
  );
  // Contesto variabile in coda all'ultimo messaggio, così il system prompt resta in cache.
  const lastMsg = messages[messages.length - 1];
  const known = [
    contact.name && `nome: ${contact.name}`,
    contact.interest && `interesse: ${contact.interest}`,
    `stato: ${contact.status}`,
    contact.score !== null && `valutazione attuale: ${contact.score}/100 (${contact.qualification})`,
    `canale: ${contact.channel}`,
  ]
    .filter(Boolean)
    .join(", ");
  lastMsg.content = `<contesto>Adesso è ${describeNow()}. Cliente: ${known}.</contesto>\n\n${lastMsg.content}`;

  let res: { text: string; refused: boolean };
  try {
    res = await runAgent({
      businessId,
      agent: "vendite",
      system: `${SALES_SYSTEM}\n\n${businessCard(b)}`,
      messages,
      tools: salesTools(b, contact),
      effort: "low",
    });
  } catch (err) {
    // IA non raggiungibile: il cliente riceve comunque una risposta e la chat passa al titolare.
    console.error("[vendite] agente non disponibile:", (err as Error).message);
    const noCredits = err instanceof OutOfCreditsError;
    if (noCredits && !one("SELECT 1 FROM proposals WHERE business_id = ? AND title = 'Crediti IA esauriti' AND status = 'da fare'", businessId)) {
      run(
        "INSERT INTO proposals (business_id, title, detail, action_type, action_payload) VALUES (?, 'Crediti IA esauriti', ?, 'nota', '{}')",
        businessId,
        "L'assistente non risponde più ai clienti: ricarica da Altro → Piano e crediti. Le chat in arrivo aspettano te.",
      );
    }
    run(
      "INSERT INTO proposals (business_id, title, detail, action_type, action_payload) VALUES (?, ?, ?, 'nota', ?)",
      businessId,
      `Rispondi a ${contact.name || contact.external_id}`,
      noCredits ? "Crediti IA esauriti: il cliente aspetta una tua risposta." : "L'assistente non era disponibile: il cliente aspetta una tua risposta.",
      JSON.stringify({ contact_id: contactId }),
    );
    res = { text: "", refused: true };
  }

  let text = res.text;
  if (res.refused || !text) {
    run("UPDATE contacts SET ai_paused = 1 WHERE id = ?", contactId);
    text = "Grazie per il messaggio! Le risponderemo personalmente a breve.";
  }
  addMessage(businessId, contactId, "agente", text);
  return text;
}
