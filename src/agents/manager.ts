// Agente Manager ("Chiedi a TL"): parla con il titolare, legge i numeri, agisce su sua richiesta
// e prepara proposte da approvare con un tocco.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { all, getBusiness, getContact, HOT_SCORE, one, run, type Business, type Contact } from "../db.js";
import { bookAppointment, cancelAppointment, describeNow, freeSlots, nowLocal } from "../schedule.js";
import { sendToContact } from "../channels/send.js";
import { runAgent, toApiMessages } from "./client.js";
import { businessCard } from "./profile.js";

const MANAGER_SYSTEM = `Sei l'agente manager di TL, il team di agenti IA che lavora per una piccola attività italiana. Parli con il titolare, che ti scrive o ti parla dal telefono come a un collaboratore.

Il tuo lavoro: portare più clienti e più fatturato all'attività. Coordini gli altri agenti:
- l'agente Vendite risponde da solo ai clienti su WhatsApp e sul sito e fissa gli appuntamenti;
- l'agente Pubblicità prepara le inserzioni (tu le crei come bozze con create_ad_draft; il titolare le approva);
- l'agente Dati legge i numeri (tu usi get_overview, list_contacts, list_appointments).

Come lavori:
- Rispondi in italiano semplice, breve e concreto, con numeri veri presi dai tool. Mai inventare dati.
- Quando il titolare chiede di fare qualcosa ("rispondi tu a Luca", "sposta l'appuntamento", "fammi una campagna"), fallo con i tool e conferma in una riga cosa hai fatto.
- Le azioni verso i clienti (send_message_to_contact) falle solo se il titolare l'ha chiesto esplicitamente o ha detto sì a una tua proposta in questa conversazione. Se è una tua idea, chiedi prima: "Lo faccio?".
- Quando ti chiedono consigli o "cosa faccio oggi", leggi i dati e crea proposte concrete con create_proposals: ogni proposta deve essere un'azione eseguibile con un tocco.
- Scrivi testo semplice, adatto al telefono: niente tabelle, al massimo un elenco breve.
- Ogni contatto ha una valutazione 0-100 data dall'agente Vendite secondo le regole di qualifica (${HOT_SCORE}+ = caldo). Quando il titolare chiede "chi devo chiamare" o simili, parti dai contatti caldi.
- I follow-up automatici (se attivi) ricontattano da soli chi non risponde; non proporre follow-up manuali per gli stessi contatti.
- Puoi aggiornare la scheda dell'attività (servizi, prezzi, orari, tono) con update_business_profile quando il titolare te lo dice.
- La pubblicazione automatica su Meta/Google Ads non è ancora collegata: le inserzioni restano bozze approvate che il titolare pubblica dal suo account. Dillo se te lo chiedono.`;

function contactLabel(c: Contact) {
  return `${c.name || "(senza nome)"} · ${c.channel} ${c.phone || c.external_id}`;
}

function managerTools(b: Business) {
  return [
    betaZodTool({
      name: "get_overview",
      description: "Numeri principali dell'attività negli ultimi N giorni: contatti, messaggi, appuntamenti, risposte fuori orario.",
      inputSchema: z.object({ days: z.number().int().min(1).max(90).describe("Default 7").optional() }),
      run: async ({ days }) => {
        const d = `-${days ?? 7} days`;
        const q = (sql: string) => one<{ n: number }>(sql, b.id, d)!.n;
        return JSON.stringify({
          periodo_giorni: days ?? 7,
          nuovi_contatti: q("SELECT count(*) n FROM contacts WHERE business_id = ? AND created_at >= datetime('now', ?)"),
          messaggi_clienti: q("SELECT count(*) n FROM messages WHERE business_id = ? AND author = 'cliente' AND created_at >= datetime('now', ?)"),
          risposte_agente: q("SELECT count(*) n FROM messages WHERE business_id = ? AND author = 'agente' AND created_at >= datetime('now', ?)"),
          appuntamenti_fissati: q("SELECT count(*) n FROM appointments WHERE business_id = ? AND status = 'confermato' AND created_at >= datetime('now', ?)"),
          contatti_per_stato: all("SELECT status, count(*) n FROM contacts WHERE business_id = ? GROUP BY status", b.id),
          chat_in_attesa_del_titolare: one<{ n: number }>("SELECT count(*) n FROM contacts WHERE business_id = ? AND ai_paused = 1", b.id)!.n,
          contatti_caldi_aperti: one<{ n: number }>("SELECT count(*) n FROM contacts WHERE business_id = ? AND score >= ? AND status NOT IN ('cliente','perso')", b.id, HOT_SCORE)!.n,
          followup_automatici_inviati: q("SELECT count(*) n FROM messages WHERE business_id = ? AND kind = 'followup' AND created_at >= datetime('now', ?)"),
          followup_automatici_attivi: !!b.followup_enabled,
          bozze_pubblicita: one<{ n: number }>("SELECT count(*) n FROM ad_drafts WHERE business_id = ? AND status = 'bozza'", b.id)!.n,
        });
      },
    }),
    betaZodTool({
      name: "list_contacts",
      description: "Elenca i contatti del CRM, filtrabili per stato o per giorni senza risposta del cliente.",
      inputSchema: z.object({
        status: z.enum(["nuovo", "in trattativa", "cliente", "perso"]).optional(),
        silent_for_days: z.number().int().min(1).describe("Solo contatti il cui ultimo messaggio è più vecchio di N giorni").optional(),
        min_score: z.number().int().min(0).max(100).describe(`Solo contatti con valutazione almeno questa (caldi: ${HOT_SCORE})`).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: async ({ status, silent_for_days, min_score, limit }) => {
        const rows = all<Contact>(
          `SELECT * FROM contacts WHERE business_id = ?
           AND (? IS NULL OR status = ?)
           AND (? IS NULL OR last_message_at < datetime('now', '-' || ? || ' days'))
           AND (? IS NULL OR score >= ?)
           ORDER BY last_message_at DESC LIMIT ?`,
          b.id,
          status ?? null,
          status ?? null,
          silent_for_days ?? null,
          silent_for_days ?? null,
          min_score ?? null,
          min_score ?? null,
          limit ?? 30,
        );
        return JSON.stringify(
          rows.map((c) => ({
            id: c.id,
            contatto: contactLabel(c),
            stato: c.status,
            interesse: c.interest,
            valutazione: c.score === null ? "non valutato" : `${c.score}/100 – ${c.qualification}`,
            followup_automatici_inviati: c.followup_count,
            ultimo_messaggio: c.last_message_at,
            assistente_in_pausa: !!c.ai_paused,
          })),
        );
      },
    }),
    betaZodTool({
      name: "get_conversation",
      description: "Legge gli ultimi messaggi con un contatto.",
      inputSchema: z.object({ contact_id: z.number().int() }),
      run: async ({ contact_id }) => {
        const c = getContact(b.id, contact_id);
        if (!c) return "Contatto non trovato.";
        const msgs = all("SELECT author, text, created_at FROM (SELECT * FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 30) ORDER BY id", c.id);
        return JSON.stringify({ contatto: contactLabel(c), stato: c.status, note: c.notes, messaggi: msgs });
      },
    }),
    betaZodTool({
      name: "send_message_to_contact",
      description:
        "Invia un messaggio a un contatto sul suo canale (WhatsApp o sito), a nome dell'attività. Solo se il titolare l'ha chiesto o approvato.",
      inputSchema: z.object({ contact_id: z.number().int(), text: z.string().min(1) }),
      run: async ({ contact_id, text }) => {
        const c = getContact(b.id, contact_id);
        if (!c) return "Contatto non trovato.";
        try {
          await sendToContact(c, text, "agente");
          return `Inviato a ${contactLabel(c)}.`;
        } catch (e) {
          return `Invio non riuscito: ${(e as Error).message}`;
        }
      },
    }),
    betaZodTool({
      name: "update_contact",
      description: "Aggiorna stato, note o dati di un contatto; può anche riattivare o mettere in pausa l'assistente per quel contatto.",
      inputSchema: z.object({
        contact_id: z.number().int(),
        name: z.string().optional(),
        status: z.enum(["nuovo", "in trattativa", "cliente", "perso"]).optional(),
        interest: z.string().optional(),
        note: z.string().optional(),
        assistant_paused: z.boolean().optional(),
      }),
      run: async (f) => {
        const c = getContact(b.id, f.contact_id);
        if (!c) return "Contatto non trovato.";
        run(
          "UPDATE contacts SET name = ?, status = ?, interest = ?, notes = ?, ai_paused = ? WHERE id = ?",
          f.name ?? c.name,
          f.status ?? c.status,
          f.interest ?? c.interest,
          f.note ? `${c.notes ? c.notes + "\n" : ""}${f.note}` : c.notes,
          f.assistant_paused === undefined ? c.ai_paused : Number(f.assistant_paused),
          c.id,
        );
        return "Contatto aggiornato.";
      },
    }),
    betaZodTool({
      name: "list_appointments",
      description: "Appuntamenti confermati tra due date (YYYY-MM-DD). Default: da oggi per 7 giorni.",
      inputSchema: z.object({ from_date: z.string().optional(), to_date: z.string().optional() }),
      run: async ({ from_date, to_date }) => {
        const from = from_date ?? nowLocal().slice(0, 10);
        const to = to_date ?? "9999-12-31";
        return JSON.stringify(
          all(
            `SELECT a.id, a.starts_at, a.service, a.notes, c.id contact_id, c.name, c.phone FROM appointments a
             LEFT JOIN contacts c ON c.id = a.contact_id
             WHERE a.business_id = ? AND a.status = 'confermato' AND substr(a.starts_at,1,10) BETWEEN ? AND ?
             ORDER BY a.starts_at LIMIT 50`,
            b.id,
            from,
            to,
          ),
        );
      },
    }),
    betaZodTool({
      name: "get_available_slots",
      description: "Orari liberi in agenda a partire da una data.",
      inputSchema: z.object({ from_date: z.string().optional(), days: z.number().int().min(1).max(14).optional() }),
      run: async ({ from_date, days }) => JSON.stringify(freeSlots(b, from_date, days ?? 5)),
    }),
    betaZodTool({
      name: "book_appointment",
      description: "Fissa un appuntamento (anche senza contatto). force=true ignora orari e sovrapposizioni, solo se il titolare lo chiede.",
      inputSchema: z.object({
        starts_at: z.string().describe("YYYY-MM-DDTHH:MM, ora italiana"),
        service: z.string(),
        contact_id: z.number().int().optional(),
        notes: z.string().optional(),
        force: z.boolean().optional(),
      }),
      run: async (f) => {
        const r = bookAppointment(b, {
          contactId: f.contact_id ?? null,
          startsAt: f.starts_at,
          service: f.service,
          notes: f.notes,
          createdBy: "titolare",
          force: f.force,
        });
        return r.ok ? `Appuntamento fissato (id ${r.id}).` : `Non fissato: ${r.error}`;
      },
    }),
    betaZodTool({
      name: "cancel_appointment",
      description: "Annulla un appuntamento.",
      inputSchema: z.object({ appointment_id: z.number().int() }),
      run: async ({ appointment_id }) =>
        cancelAppointment(b.id, appointment_id) ? "Annullato." : "Appuntamento non trovato.",
    }),
    betaZodTool({
      name: "create_ad_draft",
      description:
        "Crea una bozza di inserzione pubblicitaria scritta per questa attività. Il titolare la vede nella sezione Pubblicità e la approva.",
      inputSchema: z.object({
        platform: z.enum(["Meta (Facebook e Instagram)", "Google Ads", "TikTok Ads"]),
        headline: z.string().describe("Titolo breve, max 40 caratteri"),
        body: z.string().describe("Testo dell'inserzione, max 300 caratteri"),
        cta: z.string().describe("Invito all'azione, es. 'Scrivici su WhatsApp'"),
        audience: z.string().describe("Pubblico: zona, età, interessi"),
        daily_budget: z.number().min(1).max(500).describe("Budget giornaliero suggerito in euro"),
      }),
      run: async (f) => {
        const r = run(
          "INSERT INTO ad_drafts (business_id, platform, headline, body, cta, audience, daily_budget) VALUES (?, ?, ?, ?, ?, ?, ?)",
          b.id,
          f.platform,
          f.headline,
          f.body,
          f.cta,
          f.audience,
          f.daily_budget,
        );
        return `Bozza creata (id ${r.lastInsertRowid}).`;
      },
    }),
    betaZodTool({
      name: "create_proposals",
      description:
        "Crea proposte che il titolare approva con un tocco su 'Fallo per me'. Tipi: followup (invia lo stesso messaggio a dei contatti), ad_draft (approva una bozza di inserzione esistente), nota (promemoria).",
      inputSchema: z.object({
        proposals: z
          .array(
            z.object({
              title: z.string().describe("Azione in una riga, es. 'Ricontatta 4 persone su WhatsApp'"),
              detail: z.string().describe("Perché conviene, con il dato che lo giustifica"),
              action_type: z.enum(["followup", "ad_draft", "nota"]),
              contact_ids: z.array(z.number().int()).describe("Per followup").optional(),
              message: z.string().describe("Per followup: testo da inviare, personalizzabile con {nome}").optional(),
              ad_draft_id: z.number().int().describe("Per ad_draft").optional(),
            }),
          )
          .min(1)
          .max(6),
      }),
      run: async ({ proposals }) => {
        for (const p of proposals) {
          run(
            "INSERT INTO proposals (business_id, title, detail, action_type, action_payload) VALUES (?, ?, ?, ?, ?)",
            b.id,
            p.title,
            p.detail,
            p.action_type,
            JSON.stringify({ contact_ids: p.contact_ids, message: p.message, ad_draft_id: p.ad_draft_id }),
          );
        }
        return `${proposals.length} proposte create.`;
      },
    }),
    betaZodTool({
      name: "update_business_profile",
      description:
        "Aggiorna la scheda dell'attività usata da tutti gli agenti. hours è un oggetto con chiavi lun..dom e valori tipo '09:00-13:00, 15:00-19:00' (stringa vuota = chiuso).",
      inputSchema: z.object({
        description: z.string().optional(),
        services: z.string().describe("Elenco completo servizi e prezzi (sostituisce il precedente)").optional(),
        faq: z.string().optional(),
        tone: z.string().optional(),
        qualification_rules: z.string().describe("Cliente ideale e regole per valutare i contatti (sostituisce le precedenti)").optional(),
        city: z.string().optional(),
        slot_minutes: z.number().int().min(10).max(480).optional(),
        hours: z
          .object({
            lun: z.string().optional(),
            mar: z.string().optional(),
            mer: z.string().optional(),
            gio: z.string().optional(),
            ven: z.string().optional(),
            sab: z.string().optional(),
            dom: z.string().optional(),
          })
          .optional(),
      }),
      run: async (f) => {
        const cur = getBusiness(b.id);
        const hours = f.hours ? JSON.stringify({ ...JSON.parse(cur.hours || "{}"), ...f.hours }) : cur.hours;
        run(
          "UPDATE businesses SET description = ?, services = ?, faq = ?, tone = ?, qualification_rules = ?, city = ?, slot_minutes = ?, hours = ? WHERE id = ?",
          f.description ?? cur.description,
          f.services ?? cur.services,
          f.faq ?? cur.faq,
          f.tone ?? cur.tone,
          f.qualification_rules ?? cur.qualification_rules,
          f.city ?? cur.city,
          f.slot_minutes ?? cur.slot_minutes,
          hours,
          b.id,
        );
        return "Scheda attività aggiornata.";
      },
    }),
  ];
}

/** Messaggio del titolare a "Chiedi a TL". Salva domanda e risposta. */
export async function askManager(businessId: number, text: string): Promise<string> {
  const asked = run("INSERT INTO owner_chat (business_id, role, text) VALUES (?, 'user', ?)", businessId, text);
  try {
    return await answerOwner(businessId);
  } catch (err) {
    // Se l'agente non risponde, la domanda non resta appesa nella cronologia.
    run("DELETE FROM owner_chat WHERE id = ?", asked.lastInsertRowid);
    throw err;
  }
}

async function answerOwner(businessId: number): Promise<string> {
  const history = all<{ role: "user" | "assistant"; text: string }>(
    "SELECT role, text FROM (SELECT * FROM owner_chat WHERE business_id = ? ORDER BY id DESC LIMIT 30) ORDER BY id",
    businessId,
  );
  const messages = toApiMessages(history);
  const last = messages[messages.length - 1];
  last.content = `<contesto>Adesso è ${describeNow()}.</contesto>\n\n${last.content}`;

  const b = getBusiness(businessId);
  const res = await runAgent({
    businessId,
    agent: "manager",
    system: `${MANAGER_SYSTEM}\n\n${businessCard(b)}`,
    messages,
    tools: managerTools(b),
    effort: "medium",
    maxIterations: 14,
  });
  const reply = res.refused ? "Su questa richiesta non posso aiutarti." : res.text || "Fatto.";
  run("INSERT INTO owner_chat (business_id, role, text) VALUES (?, 'assistant', ?)", businessId, reply);
  return reply;
}

/** Analisi giornaliera: l'agente legge i numeri e crea le proposte del giorno. */
export async function generateProposals(businessId: number): Promise<number> {
  const before = one<{ n: number }>("SELECT count(*) n FROM proposals WHERE business_id = ?", businessId)!.n;
  const b = getBusiness(businessId);
  await runAgent({
    businessId,
    agent: "manager-proposte",
    system: `${MANAGER_SYSTEM}\n\n${businessCard(b)}`,
    messages: [
      {
        role: "user",
        content: `<contesto>Adesso è ${describeNow()}.</contesto>\n\nAnalisi del giorno: leggi i numeri, i contatti che non rispondono da qualche giorno, le chat in attesa e l'agenda. Poi crea da 3 a 5 proposte concrete con create_proposals (se serve una campagna, crea prima la bozza con create_ad_draft e poi una proposta ad_draft con il suo id). Non inviare messaggi ai clienti: proponi soltanto. Chiudi con una riga di riepilogo.`,
      },
    ],
    tools: managerTools(b),
    effort: "medium",
    maxIterations: 14,
  });
  return one<{ n: number }>("SELECT count(*) n FROM proposals WHERE business_id = ?", businessId)!.n - before;
}

/** "Fallo per me": esegue una proposta approvata dal titolare. */
export async function executeProposal(businessId: number, proposalId: number): Promise<string> {
  const p = one("SELECT * FROM proposals WHERE id = ? AND business_id = ?", proposalId, businessId);
  if (!p) throw new Error("Proposta non trovata");
  if (p.status !== "da fare") return p.result || "Già gestita";
  const payload = JSON.parse(p.action_payload || "{}");
  let result = "Fatto";

  if (p.action_type === "followup") {
    let sent = 0;
    const errors: string[] = [];
    for (const id of payload.contact_ids ?? []) {
      const c = getContact(businessId, id);
      if (!c) continue;
      const text = String(payload.message ?? "").replaceAll("{nome}", c.name?.split(" ")[0] || "").replace(/\s+([,!.])/g, "$1");
      try {
        await sendToContact(c, text, "agente");
        sent++;
      } catch (e) {
        errors.push(`${c.name || c.external_id}: ${(e as Error).message}`);
      }
    }
    if (sent === 0 && errors.length) throw new Error(`Nessun messaggio inviato: ${errors.join("; ")}`);
    result = `Inviati ${sent} messaggi${errors.length ? `; non inviati: ${errors.join("; ")}` : ""}`;
  } else if (p.action_type === "ad_draft" && payload.ad_draft_id) {
    run("UPDATE ad_drafts SET status = 'approvata' WHERE id = ? AND business_id = ?", payload.ad_draft_id, businessId);
    result = "Inserzione approvata";
  }
  run("UPDATE proposals SET status = 'fatto', result = ? WHERE id = ?", result, proposalId);
  return result;
}
