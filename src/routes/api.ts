import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { addMessage, all, getBusiness, getContact, HOT_SCORE, one, run, upsertContact, type Business, type Contact } from "../db.js";
import { dueContacts, runFollowups } from "../followup.js";
import { PUBLIC_SIGNUP } from "../config.js";
import { billingSummary, createCheckout, createPortal, PLAN, startTrial } from "../billing.js";
import { checkPassword, createSession, destroySession, hashPassword, requireAuth, type AuthedRequest } from "../auth.js";
import { askManager, executeProposal, generateProposals } from "../agents/manager.js";
import { replyToCustomer } from "../agents/sales.js";
import { sendToContact } from "../channels/send.js";
import { bookAppointment, cancelAppointment, nowLocal } from "../schedule.js";

export const api = Router();

const bid = (req: Request) => (req as AuthedRequest).businessId;

function publicBusiness(b: Business) {
  const { wa_token, stripe_customer_id, stripe_subscription_id, ...rest } = b;
  return { ...rest, wa_token_set: !!wa_token || !!process.env.WHATSAPP_TOKEN, hours: JSON.parse(b.hours || "{}") };
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "attivita";
  let slug = base;
  for (let i = 2; one("SELECT 1 FROM businesses WHERE slug = ?", slug); i++) slug = `${base}-${i}`;
  return slug;
}

const DEFAULT_HOURS = JSON.stringify({
  lun: "09:00-13:00, 15:00-19:00",
  mar: "09:00-13:00, 15:00-19:00",
  mer: "09:00-13:00, 15:00-19:00",
  gio: "09:00-13:00, 15:00-19:00",
  ven: "09:00-13:00, 15:00-19:00",
  sab: "09:00-13:00",
  dom: "",
});

// ---------- Accesso ----------

const hasUsers = () => !!one("SELECT 1 FROM users LIMIT 1");

api.get("/auth/status", (_req, res) => {
  res.json({ signup_open: PUBLIC_SIGNUP || !hasUsers(), first_setup: !hasUsers() });
});

api.post("/auth/register", (req, res) => {
  // Uso esclusivo TL: si può registrare solo il primo account (configurazione iniziale).
  if (!PUBLIC_SIGNUP && hasUsers()) {
    res.status(403).json({ error: "Registrazione chiusa. Chiedi a un amministratore TL di crearti un accesso." });
    return;
  }
  const body = z
    .object({
      email: z.string().email(),
      password: z.string().min(8),
      name: z.string().optional(),
      business_name: z.string().min(2),
      sector: z.string().optional(),
      city: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Controlla i dati: email valida e password di almeno 8 caratteri." });
    return;
  }
  const f = body.data;
  if (one("SELECT 1 FROM users WHERE email = ?", f.email.toLowerCase())) {
    res.status(409).json({ error: "Esiste già un account con questa email." });
    return;
  }
  const b = run(
    "INSERT INTO businesses (slug, name, sector, city, hours) VALUES (?, ?, ?, ?, ?)",
    slugify(f.business_name),
    f.business_name,
    f.sector ?? "",
    f.city ?? "",
    DEFAULT_HOURS,
  );
  const u = run(
    "INSERT INTO users (email, password_hash, name, business_id) VALUES (?, ?, ?, ?)",
    f.email.toLowerCase(),
    hashPassword(f.password),
    f.name ?? "",
    Number(b.lastInsertRowid),
  );
  startTrial(Number(b.lastInsertRowid));
  createSession(res, Number(u.lastInsertRowid));
  res.json({ ok: true });
});

// Offerta pubblica (prezzi mostrati nella landing)
api.get("/offer", (_req, res) => {
  res.json({
    monthly_eur: PLAN.monthlyEur,
    yearly_eur: PLAN.yearlyEur,
    plan_credits: PLAN.credits,
    trial_days: PLAN.trialDays,
    pack_eur: PLAN.packEur,
    pack_credits: PLAN.packCredits,
  });
});

api.post("/auth/login", (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase();
  const user = one<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", email);
  if (!user || !checkPassword(String(req.body?.password ?? ""), user.password_hash)) {
    res.status(401).json({ error: "Email o password non corretti." });
    return;
  }
  createSession(res, user.id);
  res.json({ ok: true });
});

api.post("/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------- Widget pubblico (chat del sito) ----------

api.get("/public/:slug", (req, res) => {
  const b = one<Business>("SELECT * FROM businesses WHERE slug = ?", req.params.slug);
  if (!b) {
    res.status(404).json({ error: "Attività non trovata" });
    return;
  }
  res.json({ name: b.name, sector: b.sector });
});

const lastHit = new Map<string, number>();

api.post("/public/:slug/chat", async (req, res) => {
  const b = one<Business>("SELECT * FROM businesses WHERE slug = ?", req.params.slug);
  const visitor = String(req.body?.visitor_id ?? "").slice(0, 64);
  const text = String(req.body?.text ?? "").trim().slice(0, 2000);
  if (!b || !visitor || !text) {
    res.status(400).json({ error: "Richiesta non valida" });
    return;
  }
  // Limite semplice: un messaggio ogni 2 secondi per visitatore.
  const key = `${b.id}:${visitor}`;
  if (Date.now() - (lastHit.get(key) ?? 0) < 2000) {
    res.status(429).json({ error: "Troppi messaggi, riprova tra un attimo." });
    return;
  }
  lastHit.set(key, Date.now());

  const channel = req.body?.test ? "test" : "sito";
  const contact = upsertContact(b.id, channel, visitor, { name: req.body?.name });
  addMessage(b.id, contact.id, "cliente", text);
  const reply = await replyToCustomer(b.id, contact.id);
  res.json({ reply, paused: reply === null });
});

api.get("/public/:slug/messages", (req, res) => {
  const b = one<Business>("SELECT id FROM businesses WHERE slug = ?", req.params.slug);
  const visitor = String(req.query.visitor_id ?? "");
  const channel = req.query.test ? "test" : "sito";
  const c = b && one<Contact>("SELECT * FROM contacts WHERE business_id = ? AND channel = ? AND external_id = ?", b.id, channel, visitor);
  if (!c) {
    res.json({ messages: [] });
    return;
  }
  res.json({
    messages: all("SELECT id, author, text, created_at FROM messages WHERE contact_id = ? AND id > ? ORDER BY id", c.id, Number(req.query.after ?? 0)),
  });
});

// ---------- Area riservata ----------

api.use(requireAuth);

api.get("/me", (req, res) => {
  const user = one("SELECT id, email, name FROM users WHERE id = ?", (req as AuthedRequest).userId);
  const b = getBusiness(bid(req));
  res.json({ user, business: publicBusiness(b), billing: billingSummary(b) });
});

api.put("/business", (req, res) => {
  const f = z
    .object({
      name: z.string().min(2),
      sector: z.string(),
      city: z.string(),
      description: z.string(),
      services: z.string(),
      faq: z.string(),
      tone: z.string(),
      slot_minutes: z.coerce.number().int().min(10).max(480),
      hours: z.record(z.string(), z.string()),
      owner_phone: z.string(),
      wa_phone_number_id: z.string(),
      wa_token: z.string().optional(),
      ai_enabled: z.boolean(),
      qualification_rules: z.string(),
      followup_enabled: z.boolean(),
      followup_after_hours: z.coerce.number().int().min(1).max(720),
      followup_max: z.coerce.number().int().min(0).max(5),
      wa_followup_template: z.string(),
    })
    .partial()
    .parse(req.body);
  const cur = getBusiness(bid(req));
  const next = {
    ...cur,
    ...f,
    hours: f.hours ? JSON.stringify(f.hours) : cur.hours,
    ai_enabled: f.ai_enabled === undefined ? cur.ai_enabled : Number(f.ai_enabled),
    wa_token: f.wa_token ? f.wa_token : cur.wa_token,
    followup_enabled: f.followup_enabled === undefined ? cur.followup_enabled : Number(f.followup_enabled),
  };
  run(
    `UPDATE businesses SET name=?, sector=?, city=?, description=?, services=?, faq=?, tone=?, slot_minutes=?, hours=?,
     owner_phone=?, wa_phone_number_id=?, wa_token=?, ai_enabled=?, qualification_rules=?, followup_enabled=?,
     followup_after_hours=?, followup_max=?, wa_followup_template=? WHERE id=?`,
    next.name, next.sector, next.city, next.description, next.services, next.faq, next.tone, next.slot_minutes, next.hours,
    next.owner_phone, next.wa_phone_number_id, next.wa_token, next.ai_enabled, next.qualification_rules, next.followup_enabled,
    next.followup_after_hours, next.followup_max, next.wa_followup_template, cur.id,
  );
  res.json({ business: publicBusiness(getBusiness(cur.id)) });
});

api.get("/dashboard", (req, res) => {
  const id = bid(req);
  const today = nowLocal().slice(0, 10);
  const count = (sql: string, ...p: any[]) => one<{ n: number }>(sql, id, ...p)!.n;
  res.json({
    contatti_oggi: count("SELECT count(*) n FROM contacts WHERE business_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')"),
    contatti_7g: count("SELECT count(*) n FROM contacts WHERE business_id = ? AND created_at >= datetime('now', '-7 days')"),
    risposte_7g: count("SELECT count(*) n FROM messages WHERE business_id = ? AND author = 'agente' AND created_at >= datetime('now', '-7 days')"),
    appuntamenti_futuri: count("SELECT count(*) n FROM appointments WHERE business_id = ? AND status = 'confermato' AND starts_at >= ?", nowLocal()),
    chat_in_attesa: count("SELECT count(*) n FROM contacts WHERE business_id = ? AND ai_paused = 1"),
    contatti_caldi: count("SELECT count(*) n FROM contacts WHERE business_id = ? AND score >= ? AND status NOT IN ('cliente','perso')", HOT_SCORE),
    followup_7g: count("SELECT count(*) n FROM messages WHERE business_id = ? AND kind = 'followup' AND created_at >= datetime('now', '-7 days')"),
    risposte_dopo_followup_7g: count(
      `SELECT count(DISTINCT f.contact_id) n FROM messages f WHERE f.business_id = ? AND f.kind = 'followup' AND f.created_at >= datetime('now', '-7 days')
       AND EXISTS (SELECT 1 FROM messages r WHERE r.contact_id = f.contact_id AND r.author = 'cliente' AND r.id > f.id)`,
    ),
    caldi: all(
      `SELECT id, name, external_id, channel, score, qualification FROM contacts
       WHERE business_id = ? AND score >= ? AND status NOT IN ('cliente','perso') ORDER BY score DESC, last_message_at DESC LIMIT 5`,
      id,
      HOT_SCORE,
    ),
    da_leggere: count("SELECT coalesce(sum(unread),0) n FROM contacts WHERE business_id = ?"),
    ultimi_contatti: all(
      "SELECT id, name, channel, external_id, status, score, last_message_at FROM contacts WHERE business_id = ? ORDER BY last_message_at DESC LIMIT 5",
      id,
    ),
    prossimi_appuntamenti: all(
      `SELECT a.id, a.starts_at, a.service, c.name FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.business_id = ? AND a.status = 'confermato' AND substr(a.starts_at,1,10) >= ? ORDER BY a.starts_at LIMIT 5`,
      id,
      today,
    ),
    uso_ia_30g: one(
      "SELECT count(*) chiamate, coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens FROM agent_runs WHERE business_id = ? AND created_at >= datetime('now','-30 days')",
      id,
    ),
  });
});

// Contatti / CRM
api.get("/contacts", (req, res) => {
  const q = `%${String(req.query.q ?? "")}%`;
  const status = req.query.status ? String(req.query.status) : null;
  const minScore = req.query.hot ? HOT_SCORE : null;
  res.json({
    contacts: all(
      `SELECT c.*, (SELECT text FROM messages m WHERE m.contact_id = c.id ORDER BY id DESC LIMIT 1) last_text
       FROM contacts c WHERE business_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR score >= ?)
       AND (name LIKE ? OR phone LIKE ? OR external_id LIKE ? OR interest LIKE ?)
       ORDER BY ${minScore ? "score DESC," : ""} last_message_at DESC LIMIT 200`,
      bid(req), status, status, minScore, minScore, q, q, q, q,
    ),
  });
});

api.post("/contacts", (req, res) => {
  const f = z.object({ name: z.string().min(1), phone: z.string().default(""), email: z.string().default(""), interest: z.string().default("") }).parse(req.body);
  const digits = f.phone.replace(/\D/g, "");
  const c = digits
    ? upsertContact(bid(req), "whatsapp", digits, { name: f.name, phone: f.phone })
    : upsertContact(bid(req), "manuale", `m-${Date.now()}`, { name: f.name });
  run("UPDATE contacts SET email = ?, interest = ? WHERE id = ?", f.email, f.interest, c.id);
  res.json({ contact: getContact(bid(req), c.id) });
});

api.patch("/contacts/:id", (req, res) => {
  const c = getContact(bid(req), Number(req.params.id));
  if (!c) {
    res.sendStatus(404);
    return;
  }
  const f = z
    .object({ name: z.string(), email: z.string(), phone: z.string(), status: z.string(), interest: z.string(), notes: z.string(), ai_paused: z.boolean() })
    .partial()
    .parse(req.body);
  run(
    "UPDATE contacts SET name=?, email=?, phone=?, status=?, interest=?, notes=?, ai_paused=? WHERE id=?",
    f.name ?? c.name, f.email ?? c.email, f.phone ?? c.phone, f.status ?? c.status, f.interest ?? c.interest,
    f.notes ?? c.notes, f.ai_paused === undefined ? c.ai_paused : Number(f.ai_paused), c.id,
  );
  res.json({ contact: getContact(bid(req), c.id) });
});

api.get("/contacts/:id/messages", (req, res) => {
  const c = getContact(bid(req), Number(req.params.id));
  if (!c) {
    res.sendStatus(404);
    return;
  }
  run("UPDATE contacts SET unread = 0 WHERE id = ?", c.id);
  res.json({ contact: c, messages: all("SELECT id, author, text, kind, created_at FROM messages WHERE contact_id = ? ORDER BY id", c.id) });
});

api.post("/contacts/:id/messages", async (req, res) => {
  const c = getContact(bid(req), Number(req.params.id));
  const text = String(req.body?.text ?? "").trim();
  if (!c || !text) {
    res.sendStatus(400);
    return;
  }
  await sendToContact(c, text, "titolare");
  res.json({ ok: true });
});

// Agenda
api.get("/appointments", (req, res) => {
  const from = String(req.query.from ?? nowLocal().slice(0, 10));
  const to = String(req.query.to ?? "9999-12-31");
  res.json({
    appointments: all(
      `SELECT a.*, c.name contact_name, c.phone contact_phone FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.business_id = ? AND a.status = 'confermato' AND substr(a.starts_at,1,10) BETWEEN ? AND ? ORDER BY a.starts_at`,
      bid(req), from, to,
    ),
  });
});

api.post("/appointments", (req, res) => {
  const f = z.object({ starts_at: z.string(), service: z.string().default(""), contact_id: z.number().int().optional(), notes: z.string().optional() }).parse(req.body);
  const r = bookAppointment(getBusiness(bid(req)), { contactId: f.contact_id ?? null, startsAt: f.starts_at, service: f.service, notes: f.notes, createdBy: "titolare", force: true });
  res.json(r);
});

api.delete("/appointments/:id", (req, res) => {
  res.json({ ok: cancelAppointment(bid(req), Number(req.params.id)) });
});

// Proposte
api.get("/proposals", (req, res) => {
  res.json({
    proposals: all("SELECT * FROM proposals WHERE business_id = ? ORDER BY (status = 'da fare') DESC, id DESC LIMIT 50", bid(req)),
  });
});
api.post("/proposals/generate", async (req, res) => {
  res.json({ created: await generateProposals(bid(req)) });
});
api.post("/proposals/:id/execute", async (req, res) => {
  res.json({ result: await executeProposal(bid(req), Number(req.params.id)) });
});
api.post("/proposals/:id/dismiss", (req, res) => {
  run("UPDATE proposals SET status = 'scartata' WHERE id = ? AND business_id = ?", Number(req.params.id), bid(req));
  res.json({ ok: true });
});

// Pubblicità
api.get("/ads", (req, res) => {
  res.json({ ads: all("SELECT * FROM ad_drafts WHERE business_id = ? AND status != 'scartata' ORDER BY id DESC", bid(req)) });
});
api.patch("/ads/:id", (req, res) => {
  const f = z
    .object({ status: z.enum(["bozza", "approvata", "scartata"]), headline: z.string(), body: z.string(), cta: z.string(), audience: z.string(), daily_budget: z.number() })
    .partial()
    .parse(req.body);
  const ad = one("SELECT * FROM ad_drafts WHERE id = ? AND business_id = ?", Number(req.params.id), bid(req));
  if (!ad) {
    res.sendStatus(404);
    return;
  }
  const n = { ...ad, ...f };
  run("UPDATE ad_drafts SET status=?, headline=?, body=?, cta=?, audience=?, daily_budget=? WHERE id=?", n.status, n.headline, n.body, n.cta, n.audience, n.daily_budget, ad.id);
  res.json({ ok: true });
});

// Chiedi a TL (agente manager)
api.get("/assistant", (req, res) => {
  res.json({ messages: all("SELECT id, role, text, created_at FROM owner_chat WHERE business_id = ? ORDER BY id DESC LIMIT 60", bid(req)).reverse() });
});
api.post("/assistant", async (req, res) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 4000);
  if (!text) {
    res.sendStatus(400);
    return;
  }
  res.json({ reply: await askManager(bid(req), text) });
});
api.delete("/assistant", (req, res) => {
  run("DELETE FROM owner_chat WHERE business_id = ?", bid(req));
  res.json({ ok: true });
});

// Follow-up automatici
api.get("/followups", (req, res) => {
  const b = getBusiness(bid(req));
  res.json({
    in_coda: dueContacts(b).map((c) => ({ id: c.id, name: c.name || c.external_id, tentativo: c.followup_count + 1, score: c.score })),
    inviati: all(
      `SELECT m.id, m.text, m.created_at, c.id contact_id, c.name, c.external_id FROM messages m JOIN contacts c ON c.id = m.contact_id
       WHERE m.business_id = ? AND m.kind = 'followup' ORDER BY m.id DESC LIMIT 20`,
      b.id,
    ),
  });
});
api.post("/followups/run", async (req, res) => {
  res.json(await runFollowups(bid(req), true));
});

// Piano e crediti
api.get("/billing", (req, res) => {
  res.json(billingSummary(getBusiness(bid(req))));
});
api.post("/billing/checkout", async (req, res) => {
  const kind = z.enum(["monthly", "yearly", "pack"]).parse(req.body?.kind);
  const user = one<{ email: string }>("SELECT email FROM users WHERE id = ?", (req as AuthedRequest).userId)!;
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ url: await createCheckout(getBusiness(bid(req)), kind, origin, user.email) });
});
api.post("/billing/portal", async (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ url: await createPortal(getBusiness(bid(req)), origin) });
});

// Team: colleghi TL con accesso alla stessa attività
api.get("/team", (req, res) => {
  res.json({
    me: (req as AuthedRequest).userId,
    users: all("SELECT id, email, name, created_at FROM users WHERE business_id = ? ORDER BY id", bid(req)),
  });
});
api.post("/team", (req, res) => {
  const f = z.object({ email: z.string().email(), name: z.string().default(""), password: z.string().min(8) }).parse(req.body);
  if (one("SELECT 1 FROM users WHERE email = ?", f.email.toLowerCase())) {
    res.status(409).json({ error: "Esiste già un utente con questa email." });
    return;
  }
  run("INSERT INTO users (email, password_hash, name, business_id) VALUES (?, ?, ?, ?)", f.email.toLowerCase(), hashPassword(f.password), f.name, bid(req));
  res.json({ ok: true });
});
api.delete("/team/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === (req as unknown as AuthedRequest).userId) {
    res.status(400).json({ error: "Non puoi rimuovere te stesso." });
    return;
  }
  run("DELETE FROM sessions WHERE user_id = ? AND user_id IN (SELECT id FROM users WHERE business_id = ?)", id, bid(req));
  run("DELETE FROM users WHERE id = ? AND business_id = ?", id, bid(req));
  res.json({ ok: true });
});
api.put("/me/password", (req, res) => {
  const f = z.object({ current: z.string(), password: z.string().min(8) }).parse(req.body);
  const u = one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", (req as AuthedRequest).userId)!;
  if (!checkPassword(f.current, u.password_hash)) {
    res.status(400).json({ error: "La password attuale non è corretta." });
    return;
  }
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(f.password), (req as AuthedRequest).userId);
  res.json({ ok: true });
});
