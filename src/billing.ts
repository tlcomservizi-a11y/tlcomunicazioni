// Abbonamenti (Stripe) e crediti IA.
// 1 credito = CREDIT_USD dollari di costo reale dell'IA (default 1 centesimo).
// Ogni attività ha crediti del piano (si ricaricano ogni mese) e crediti extra acquistati (non scadono).
import Stripe from "stripe";
import type { Request, Response } from "express";
import { all, db, getBusiness, one, run, type Business } from "./db.js";

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const PLAN = {
  credits: num(process.env.PLAN_CREDITS, 1000),
  trialDays: num(process.env.TRIAL_DAYS, 14),
  trialCredits: num(process.env.TRIAL_CREDITS, 200),
  packCredits: num(process.env.PACK_CREDITS, 500),
  creditUsd: num(process.env.CREDIT_USD, 0.01),
  // Prezzi mostrati nell'app e nella landing: devono coincidere con i prezzi creati su Stripe.
  monthlyEur: num(process.env.PRICE_MONTHLY_EUR, 99),
  yearlyEur: num(process.env.PRICE_YEARLY_EUR, 799),
  packEur: num(process.env.PRICE_PACK_EUR, 49),
};

const PRICE_IDS = {
  monthly: process.env.STRIPE_PRICE_MONTHLY ?? "",
  yearly: process.env.STRIPE_PRICE_YEARLY ?? "",
  pack: process.env.STRIPE_PRICE_PACK ?? "",
};

export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
/** Senza chiave Stripe (sviluppo o installazione interna) i crediti non vengono applicati. */
export const billingEnabled = !!stripe;

export class OutOfCreditsError extends Error {
  constructor() {
    super("Crediti IA esauriti: ricarica dal menu Altro → Piano e crediti.");
  }
}

// ---------- costo delle chiamate ----------

// $ per milione di token: input, output, lettura cache, scrittura cache.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-fable-5-2": [8, 40, 0.2, 10],
};

export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function creditsFor(u: Usage): number {
  const key = Object.keys(PRICES).find((k) => u.model.startsWith(k));
  const [i, o, cr, cw] = PRICES[key ?? "claude-opus-5-5"];
  const usd = (u.input * i + u.output * o + u.cacheRead * cr + u.cacheWrite * cw) / 1e6;
  return Math.max(1, Math.ceil(usd / PLAN.creditUsd));
}

// ---------- saldo ----------

function trialExpired(b: Business) {
  return b.plan_status === "trial" && !!b.trial_ends_at && b.trial_ends_at < new Date().toISOString();
}

export function canUseAI(b: Business): boolean {
  if (!billingEnabled) return true;
  if (b.plan_status === "canceled" || trialExpired(b)) return b.extra_credits > 0;
  return b.plan_credits + b.extra_credits > 0;
}

export function ensureCredits(businessId: number) {
  if (!canUseAI(getBusiness(businessId))) throw new OutOfCreditsError();
}

/** Scala i crediti: prima quelli del piano, poi gli extra. Il saldo non scende sotto zero. */
export function charge(businessId: number, credits: number, reason: string) {
  if (!billingEnabled || credits <= 0) return;
  db.exec("BEGIN");
  try {
    const b = getBusiness(businessId);
    const fromPlan = Math.min(credits, Math.max(0, b.plan_credits));
    const fromExtra = Math.min(credits - fromPlan, Math.max(0, b.extra_credits));
    run("UPDATE businesses SET plan_credits = plan_credits - ?, extra_credits = extra_credits - ? WHERE id = ?", fromPlan, fromExtra, businessId);
    run("INSERT INTO credit_ledger (business_id, delta, reason) VALUES (?, ?, ?)", businessId, -credits, reason);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function grant(businessId: number, field: "plan_credits" | "extra_credits", credits: number, reason: string, reset = false) {
  run(
    `UPDATE businesses SET ${field} = ${reset ? "?" : `${field} + ?`}${field === "plan_credits" ? ", credits_reset_at = datetime('now')" : ""} WHERE id = ?`,
    credits,
    businessId,
  );
  run("INSERT INTO credit_ledger (business_id, delta, reason) VALUES (?, ?, ?)", businessId, credits, reason);
}

// Attività create prima dei piani: partono con la prova gratuita.
for (const b of all<{ id: number }>("SELECT id FROM businesses WHERE trial_ends_at IS NULL AND plan_status = 'trial'")) {
  startTrial(b.id);
}

/** Prova gratuita per una nuova attività. */
export function startTrial(businessId: number) {
  run(
    "UPDATE businesses SET plan = 'trial', plan_status = 'trial', trial_ends_at = ? WHERE id = ?",
    new Date(Date.now() + PLAN.trialDays * 864e5).toISOString(),
    businessId,
  );
  grant(businessId, "plan_credits", PLAN.trialCredits, "Prova gratuita", true);
}

/** Ricarica mensile per i piani attivi (serve soprattutto per l'annuale, che Stripe fattura una volta l'anno). */
export function monthlyRefill() {
  const due = all<{ id: number }>(
    `SELECT id FROM businesses WHERE plan_status IN ('active', 'past_due') AND plan IN ('monthly', 'yearly')
     AND (credits_reset_at IS NULL OR credits_reset_at <= datetime('now', '-1 month'))`,
  );
  for (const b of due) grant(b.id, "plan_credits", PLAN.credits, "Ricarica mensile del piano", true);
}

export function billingSummary(b: Business) {
  return {
    enabled: billingEnabled,
    plan: b.plan,
    status: trialExpired(b) ? "trial_scaduta" : b.plan_status,
    trial_ends_at: b.trial_ends_at,
    plan_credits: Math.max(0, b.plan_credits),
    extra_credits: Math.max(0, b.extra_credits),
    plan_credits_total: b.plan === "trial" ? PLAN.trialCredits : PLAN.credits,
    can_use_ai: canUseAI(b),
    has_portal: !!b.stripe_customer_id,
    offer: {
      monthly_eur: PLAN.monthlyEur,
      yearly_eur: PLAN.yearlyEur,
      pack_eur: PLAN.packEur,
      plan_credits: PLAN.credits,
      pack_credits: PLAN.packCredits,
      trial_days: PLAN.trialDays,
      available: { monthly: !!PRICE_IDS.monthly, yearly: !!PRICE_IDS.yearly, pack: !!PRICE_IDS.pack },
    },
    usage_30d: all(
      `SELECT agent, count(*) chiamate, sum(credits) crediti FROM agent_runs
       WHERE business_id = ? AND created_at >= datetime('now', '-30 days') GROUP BY agent ORDER BY crediti DESC`,
      b.id,
    ),
    ledger: all("SELECT delta, reason, created_at FROM credit_ledger WHERE business_id = ? AND delta > 0 ORDER BY id DESC LIMIT 10", b.id),
  };
}

// ---------- Stripe: checkout, portale, webhook ----------

export async function createCheckout(b: Business, kind: "monthly" | "yearly" | "pack", origin: string, email: string) {
  if (!stripe) throw new Error("Pagamenti non configurati");
  const price = PRICE_IDS[kind];
  if (!price) throw new Error("Questo piano non è ancora disponibile");
  const session = await stripe.checkout.sessions.create({
    mode: kind === "pack" ? "payment" : "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(b.id),
    metadata: { business_id: String(b.id), kind },
    ...(b.stripe_customer_id ? { customer: b.stripe_customer_id } : { customer_email: email }),
    ...(kind === "pack" ? { customer_creation: "always" as const } : { subscription_data: { metadata: { business_id: String(b.id), kind } } }),
    allow_promotion_codes: true,
    locale: "it",
    success_url: `${origin}/app#/piano?esito=ok`,
    cancel_url: `${origin}/app#/piano`,
  });
  return session.url;
}

export async function createPortal(b: Business, origin: string) {
  if (!stripe || !b.stripe_customer_id) throw new Error("Nessun abbonamento da gestire");
  const session = await stripe.billingPortal.sessions.create({ customer: b.stripe_customer_id, return_url: `${origin}/app#/piano` });
  return session.url;
}

const byCustomer = (id: string | null | undefined) =>
  id ? one<Business>("SELECT * FROM businesses WHERE stripe_customer_id = ?", id) : undefined;
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id);

function mapStatus(s: Stripe.Subscription.Status): string {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid" || s === "incomplete") return "past_due";
  return "canceled";
}

export function handleStripeEvent(event: Stripe.Event) {
  // Idempotenza: Stripe può reinviare lo stesso evento.
  if (one("SELECT 1 FROM stripe_events WHERE id = ?", event.id)) return;
  db.exec("BEGIN");
  try {
    applyStripeEvent(event);
    run("INSERT INTO stripe_events (id) VALUES (?)", event.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function applyStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const businessId = Number(s.client_reference_id ?? s.metadata?.business_id);
      if (!businessId || !one("SELECT 1 FROM businesses WHERE id = ?", businessId)) return;
      const customer = idOf(s.customer);
      if (customer) run("UPDATE businesses SET stripe_customer_id = ? WHERE id = ?", customer, businessId);
      const kind = s.metadata?.kind;
      if (s.mode === "payment" && kind === "pack" && s.payment_status === "paid") {
        grant(businessId, "extra_credits", PLAN.packCredits, "Pacchetto crediti");
      } else if (s.mode === "subscription") {
        run(
          "UPDATE businesses SET plan = ?, plan_status = 'active', stripe_subscription_id = ? WHERE id = ?",
          kind === "yearly" ? "yearly" : "monthly",
          idOf(s.subscription) ?? "",
          businessId,
        );
        grant(businessId, "plan_credits", PLAN.credits, "Attivazione abbonamento", true);
      }
      return;
    }
    case "invoice.paid": {
      const inv = event.data.object;
      const b = byCustomer(idOf(inv.customer));
      // Il primo pagamento è già gestito da checkout.session.completed.
      if (b && inv.billing_reason === "subscription_cycle") {
        run("UPDATE businesses SET plan_status = 'active' WHERE id = ?", b.id);
        grant(b.id, "plan_credits", PLAN.credits, "Rinnovo abbonamento", true);
      }
      return;
    }
    case "invoice.payment_failed": {
      const b = byCustomer(idOf(event.data.object.customer));
      if (b) run("UPDATE businesses SET plan_status = 'past_due' WHERE id = ?", b.id);
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const b = byCustomer(idOf(sub.customer));
      if (!b) return;
      const status = event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status);
      run("UPDATE businesses SET plan_status = ? WHERE id = ?", status, b.id);
      if (status === "canceled") run("UPDATE businesses SET plan_credits = 0 WHERE id = ?", b.id);
      return;
    }
  }
}

export function stripeWebhook(req: Request, res: Response) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    res.sendStatus(404);
    return;
  }
  let event: Stripe.Event;
  try {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
    event = stripe.webhooks.constructEvent(raw, req.get("stripe-signature") ?? "", secret);
  } catch {
    res.status(400).send("Firma non valida");
    return;
  }
  try {
    handleStripeEvent(event);
  } catch (e) {
    console.error("[stripe]", event.type, e);
    res.sendStatus(500); // Stripe riproverà
    return;
  }
  res.json({ received: true });
}
