// Logica pura del ponte WhatsApp (testata in test/core.test.js).
// Converte i messaggi del telefono nel formato che l'assistente di Partner Hub già legge
// (lo stesso dei webhook di Meta), così la logica dell'assistente resta una sola.

export const digits = (s) => String(s || "").replace(/\D/g, "");

const USER = /@s\.whatsapp\.net$/;
const LID = /@lid$/;

/** Numero di telefono (solo cifre) della chat, o "" se non è una chat privata con un numero noto. */
export function phoneOf(key = {}) {
  const jid = String(key.remoteJid || "");
  if (USER.test(jid)) return digits(jid.split("@")[0].split(":")[0]);
  if (LID.test(jid)) {
    const alt = key.senderPn || key.remoteJidAlt || "";
    if (USER.test(alt)) return digits(alt.split("@")[0].split(":")[0]);
    // WhatsApp a volte nasconde il numero dietro un codice interno (@lid): la chat resta gestibile con quel codice.
    const lid = digits(jid.split("@")[0].split(":")[0]);
    return lid ? `lid-${lid}` : "";
  }
  return ""; // gruppi, stati, canali, liste broadcast: ignorati
}

/** Testo e tipo del messaggio. Le didascalie di foto e video valgono come testo. */
export function contentOf(message) {
  let m = message || {};
  m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
  if (typeof m.conversation === "string" && m.conversation) return { type: "text", text: m.conversation };
  if (m.extendedTextMessage?.text) return { type: "text", text: m.extendedTextMessage.text };
  if (m.imageMessage) return m.imageMessage.caption ? { type: "text", text: m.imageMessage.caption } : { type: "image", text: "" };
  if (m.videoMessage) return m.videoMessage.caption ? { type: "text", text: m.videoMessage.caption } : { type: "video", text: "" };
  if (m.documentMessage) return m.documentMessage.caption ? { type: "text", text: m.documentMessage.caption } : { type: "document", text: "" };
  if (m.audioMessage) return { type: "audio", text: "" };
  if (m.stickerMessage) return { type: "sticker", text: "" };
  if (m.locationMessage || m.liveLocationMessage) return { type: "location", text: "" };
  if (m.contactMessage || m.contactsArrayMessage) return { type: "contacts", text: "" };
  if (m.buttonsResponseMessage) return { type: "text", text: m.buttonsResponseMessage.selectedDisplayText || "" };
  if (m.listResponseMessage) return { type: "text", text: m.listResponseMessage.title || "" };
  return null; // reazioni, messaggi di sistema, cancellazioni, sondaggi…: nessuna azione
}

const tsOf = (t) => {
  const n = typeof t === "object" && t !== null ? Number(t.low ?? t) : Number(t);
  return Number.isFinite(n) && n > 0 ? String(n) : String(Math.floor(Date.now() / 1000));
};

/**
 * Trasforma un messaggio del telefono nel payload per Partner Hub.
 * - Messaggio di un cliente → "messages" (l'assistente valuta se rispondere).
 * - Messaggio scritto dal titolare dal telefono → "message_echoes" (l'assistente tace in quella chat).
 * Ritorna null se il messaggio va ignorato.
 */
export function toPayload(msg, ownSentIds = new Set()) {
  const key = msg?.key || {};
  if (!key.id || ownSentIds.has(key.id)) return null; // risposte inviate dal ponte stesso
  const phone = phoneOf(key);
  if (!phone) return null;
  const c = contentOf(msg.message);
  if (!c) return null;
  const body = c.type === "text" ? { text: { body: c.text.slice(0, 4000) } } : {};
  const timestamp = tsOf(msg.messageTimestamp);
  if (key.fromMe) {
    return { entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ id: key.id, to: phone, timestamp, type: c.type, ...body }] } }] }] };
  }
  return { entry: [{ changes: [{ field: "messages", value: {
    contacts: [{ wa_id: phone, profile: { name: String(msg.pushName || "").slice(0, 120) } }],
    messages: [{ id: key.id, from: phone, timestamp, type: c.type, ...body }],
  } }] }] };
}

/**
 * Limite di sicurezza sulle risposte automatiche, per non far sembrare il numero un robot che spamma:
 * al massimo `perChat` risposte per chat all'ora e `perMinute` risposte in tutto al minuto.
 */
export function makeLimiter({ perChat = 8, perMinute = 6 } = {}) {
  const chats = new Map();
  let recent = [];
  return function allow(phone, now = Date.now()) {
    recent = recent.filter((t) => now - t < 60e3);
    const list = (chats.get(phone) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= perMinute || list.length >= perChat) { chats.set(phone, list); return false; }
    list.push(now); recent.push(now); chats.set(phone, list);
    return true;
  };
}

/** Attesa "umana" prima di rispondere: 2-8 secondi in base alla lunghezza del testo. */
export function typingDelay(text, rnd = Math.random()) {
  return Math.round(Math.min(8000, 2000 + String(text || "").length * 35) + rnd * 1000);
}
