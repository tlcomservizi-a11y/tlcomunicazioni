// WhatsApp Business Cloud API (Meta): ricezione via webhook e invio messaggi.
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { addMessage, one, upsertContact, type Business } from "../db.js";
import { replyToCustomer } from "../agents/sales.js";

const GRAPH = "https://graph.facebook.com/v21.0";

export async function sendWhatsApp(b: Business, to: string, text: string): Promise<void> {
  const token = b.wa_token || process.env.WHATSAPP_TOKEN;
  if (!b.wa_phone_number_id || !token) throw new Error("WhatsApp non configurato per questa attività");
  const res = await fetch(`${GRAPH}/${b.wa_phone_number_id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
}

/** GET: verifica del webhook richiesta da Meta. */
export function verifyWebhook(req: Request, res: Response) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (expected && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === expected) {
    res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  } else {
    res.sendStatus(403);
  }
}

function validSignature(req: Request): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // consigliato impostarlo in produzione
  const sig = req.get("x-hub-signature-256") ?? "";
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** POST: messaggi in arrivo. Risponde subito 200 a Meta e lavora in background. */
export function receiveWebhook(req: Request, res: Response) {
  if (!validSignature(req)) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const b = one<Business>("SELECT * FROM businesses WHERE wa_phone_number_id = ?", phoneNumberId);
      if (!b) continue;
      const names = new Map<string, string>(
        (value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? ""]),
      );
      for (const m of value.messages ?? []) {
        const from: string = m.from;
        let text: string;
        if (m.type === "text") text = m.text?.body ?? "";
        else if (m.type === "button") text = m.button?.text ?? "";
        else if (m.type === "interactive") text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
        else text = `[il cliente ha inviato un contenuto di tipo ${m.type}]`;
        if (!text) continue;

        const contact = upsertContact(b.id, "whatsapp", from, { name: names.get(from), phone: `+${from}` });
        addMessage(b.id, contact.id, "cliente", text);
        replyToCustomer(b.id, contact.id)
          .then((reply) => (reply ? sendWhatsApp(b, from, reply) : undefined))
          .catch((err) => console.error("[whatsapp] risposta non inviata:", err));
      }
    }
  }
}
