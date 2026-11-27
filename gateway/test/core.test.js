import test from "node:test";
import assert from "node:assert/strict";
import { phoneOf, contentOf, toPayload, makeLimiter, typingDelay } from "../src/core.js";

test("numero della chat: privati sì, gruppi e stati no", () => {
  assert.equal(phoneOf({ remoteJid: "393331234567@s.whatsapp.net" }), "393331234567");
  assert.equal(phoneOf({ remoteJid: "393331234567:12@s.whatsapp.net" }), "393331234567");
  assert.equal(phoneOf({ remoteJid: "123456789@lid", senderPn: "393331234567@s.whatsapp.net" }), "393331234567");
  assert.equal(phoneOf({ remoteJid: "123456789@lid" }), "lid-123456789");
  assert.equal(phoneOf({ remoteJid: "120363000000@g.us" }), "");
  assert.equal(phoneOf({ remoteJid: "status@broadcast" }), "");
});

test("contenuto: testo, didascalie, allegati, messaggi di sistema", () => {
  assert.deepEqual(contentOf({ conversation: "Ciao" }), { type: "text", text: "Ciao" });
  assert.deepEqual(contentOf({ extendedTextMessage: { text: "Fibra ferma" } }), { type: "text", text: "Fibra ferma" });
  assert.deepEqual(contentOf({ imageMessage: { caption: "La bolletta" } }), { type: "text", text: "La bolletta" });
  assert.deepEqual(contentOf({ imageMessage: {} }), { type: "image", text: "" });
  assert.deepEqual(contentOf({ audioMessage: {} }), { type: "audio", text: "" });
  assert.deepEqual(contentOf({ ephemeralMessage: { message: { conversation: "x" } } }), { type: "text", text: "x" });
  assert.equal(contentOf({ reactionMessage: { text: "👍" } }), null);
  assert.equal(contentOf({ protocolMessage: {} }), null);
});

test("payload per Partner Hub: cliente → messages, titolare dal telefono → message_echoes", () => {
  const inb = toPayload({ key: { id: "A1", remoteJid: "393331234567@s.whatsapp.net", fromMe: false }, pushName: "Mario", messageTimestamp: 1764230000, message: { conversation: "Ho la linea ferma" } });
  const v = inb.entry[0].changes[0].value;
  assert.equal(v.messages[0].from, "393331234567");
  assert.equal(v.messages[0].text.body, "Ho la linea ferma");
  assert.equal(v.messages[0].timestamp, "1764230000");
  assert.equal(v.contacts[0].profile.name, "Mario");

  const echo = toPayload({ key: { id: "B1", remoteJid: "393331234567@s.whatsapp.net", fromMe: true }, messageTimestamp: 1764230005, message: { conversation: "Ti chiamo io" } });
  const e = echo.entry[0].changes[0];
  assert.equal(e.field, "smb_message_echoes");
  assert.equal(e.value.message_echoes[0].to, "393331234567");

  assert.equal(toPayload({ key: { id: "C1", remoteJid: "393331234567@s.whatsapp.net", fromMe: true }, message: { conversation: "risposta AI" } }, new Set(["C1"])), null);
  assert.equal(toPayload({ key: { id: "D1", remoteJid: "120363@g.us" }, message: { conversation: "gruppo" } }), null);
  const media = toPayload({ key: { id: "E1", remoteJid: "393331234567@s.whatsapp.net" }, message: { audioMessage: {} } });
  assert.equal(media.entry[0].changes[0].value.messages[0].type, "audio");
  assert.equal(media.entry[0].changes[0].value.messages[0].text, undefined);
});

test("limite di sicurezza sulle risposte", () => {
  const allow = makeLimiter({ perChat: 2, perMinute: 3 });
  const t = 1_000_000;
  assert.equal(allow("a", t), true);
  assert.equal(allow("a", t + 1), true);
  assert.equal(allow("a", t + 2), false); // massimo 2 per chat all'ora
  assert.equal(allow("b", t + 3), true);
  assert.equal(allow("c", t + 4), false); // massimo 3 al minuto in tutto
  assert.equal(allow("c", t + 61_000), true);
});

test("attesa prima di rispondere tra 2 e 9 secondi", () => {
  assert.equal(typingDelay("", 0), 2000);
  assert.ok(typingDelay("x".repeat(1000), 0.99) <= 9000);
});

test("motivo dello scarto e account hosted", async () => {
  const { classify } = await import("../src/core.js");
  assert.equal(classify({ key: { id: "1", remoteJid: "1203@g.us" }, message: { conversation: "x" } }).reason, "gruppo");
  assert.equal(classify({ key: { id: "2", remoteJid: "status@broadcast" }, message: { conversation: "x" } }).reason, "stato");
  assert.match(classify({ key: { id: "3", remoteJid: "393331234567@s.whatsapp.net" }, message: { reactionMessage: {} } }).reason, /reactionMessage/);
  assert.ok(classify({ key: { id: "4", remoteJid: "393331234567@hosted" }, message: { conversation: "ciao" } }).payload);
  assert.ok(classify({ key: { id: "5", remoteJid: "123@hosted.lid" }, message: { conversation: "ciao" } }).payload);
});
