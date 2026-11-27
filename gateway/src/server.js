// Ponte WhatsApp di TL Comunicazioni.
// Si collega al WhatsApp del telefono con il QR code (come WhatsApp Web), passa i messaggi dei clienti
// all'assistente di Partner Hub e invia le sue risposte. Pannello con QR e stato su http://<host>:PORT
// protetto da password. Le risposte manuali del titolare dal telefono vengono segnalate a Partner Hub,
// che in quella chat lascia parlare la persona.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import pino from "pino";
import makeWASocket, { normalizeMessageContent, Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";
import { classify, makeLimiter, typingDelay, digits } from "./core.js";

const VERSIONE = "6";
const env = (k, d = "") => process.env[k] || d;
const PORT = Number(env("PORT", "3100"));
const PANEL_PASSWORD = env("PANEL_PASSWORD");
const HUB_URL = env("HUB_WEBHOOK_URL", "https://tl-comunicazioni-partner-hub-6a08e961.base44.app/functions/whatsappWebhook");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const AUTH_DIR = path.resolve(env("AUTH_DIR", "data/sessione"));

if (!PANEL_PASSWORD || PANEL_PASSWORD.length < 10) throw Error("Imposta PANEL_PASSWORD (almeno 10 caratteri)");
if (!GATEWAY_SECRET) throw Error("Imposta GATEWAY_SECRET (lo stesso valore di TL_GATEWAY_SECRET in Partner Hub)");

const logger = pino({ level: env("LOG_LEVEL", "fatal") }); // la finestra mostra solo le righe del ponte
const state = { status: "avvio", qr: "", me: "", since: new Date().toISOString(), lastError: "", handled: 0, replied: 0, received: 0, ignored: 0, errors: 0, lastEvent: "", lastIgnored: "" };
const ownSentIds = new Set();
const jidByPhone = new Map(); // per rispondere sulla stessa chat (anche quelle con identificativo @lid)
const allow = makeLimiter();
let sock = null;
let retry = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function remember(id) { ownSentIds.add(id); if (ownSentIds.size > 2000) ownSentIds.delete(ownSentIds.values().next().value); }

async function forward(payload) {
  const r = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tl-gateway-secret": GATEWAY_SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw Error(`Partner Hub HTTP ${r.status}`);
  return r.json();
}

async function reply(to, text) {
  const jid = jidByPhone.get(to) || `${to}@s.whatsapp.net`;
  if (!allow(to)) { logger.warn({ to }, "limite di sicurezza: risposta non inviata"); return; }
  try { await sock.sendPresenceUpdate("composing", jid); } catch {}
  await sleep(typingDelay(text));
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) remember(sent.key.id);
  try { await sock.sendPresenceUpdate("paused", jid); } catch {}
  state.replied++;
}

const hhmm = () => new Date().toLocaleTimeString("it-IT");
async function onMessage(msg) {
  state.received++;
  // Chat con numero nascosto (@lid): si recupera il numero vero dalla mappa di WhatsApp, se disponibile.
  const k = msg.key || {};
  if (/@lid$/.test(k.remoteJid || "") && !k.remoteJidAlt && !k.senderPn) {
    try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID(k.remoteJid); if (pn) k.remoteJidAlt = pn; } catch {}
  }
  try { msg.message = normalizeMessageContent(msg.message) || msg.message; } catch {}
  const { payload, reason } = classify(msg, ownSentIds);
  if (!payload) {
    state.ignored++; state.lastIgnored = `${hhmm()} ${reason}`;
    console.log(`[${hhmm()}] messaggio ignorato: ${reason}`);
    return;
  }
  const v = payload.entry[0].changes[0].value;
  const phone = v.messages?.[0]?.from || v.message_echoes?.[0]?.to;
  if (phone) jidByPhone.set(phone, msg.key.remoteJid);
  if (v.message_echoes) { await send(payload, phone, "scritto da te sul telefono"); return; }
  // Messaggi del cliente: si aspetta qualche secondo di silenzio, così più messaggi di fila ricevono una risposta sola.
  const b = buffers.get(phone) || { messages: [], contacts: v.contacts || [], timer: null };
  b.messages.push(...v.messages);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    buffers.delete(phone);
    const batch = { entry: [{ changes: [{ field: "messages", value: { contacts: b.contacts, messages: b.messages } }] }] };
    send(batch, phone, b.messages.length > 1 ? `dal cliente (${b.messages.length} messaggi)` : "dal cliente")
      .catch((e) => { state.errors++; state.lastError = `${hhmm()} ${e.message}`; console.log(`[${hhmm()}] ERRORE nell'inoltro a Partner Hub: ${e.message}`); });
  }, PAUSE_MS);
  buffers.set(phone, b);
}

const PAUSE_MS = 6000;
const buffers = new Map();
async function send(payload, phone, kind) {
  const res = await forward(payload);
  state.handled++;
  state.lastEvent = `${hhmm()} messaggio ${kind} inoltrato a Partner Hub`;
  console.log(`[${hhmm()}] messaggio ${kind} inoltrato a Partner Hub, risposte da inviare: ${(res?.replies || []).length}`);
  for (const r of res?.replies || []) {
    if (r?.to && r?.text && digits(r.to) === digits(phone)) await reply(phone, String(r.text).slice(0, 1500));
  }
}

async function start() {
  // Le sessioni create con la libreria precedente non decifrano i messaggi: al primo avvio della v4 si ricomincia con un nuovo QR.
  const marker = path.join(AUTH_DIR, "versione-libreria.txt");
  if (fs.existsSync(path.join(AUTH_DIR, "creds.json")) && (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== "7")) {
    console.log("Sessione della versione precedente: va ricollegato WhatsApp con un nuovo QR.");
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(marker, "7");
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    auth, version, logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false, // il telefono continua a ricevere le notifiche
    syncFullHistory: false,
    emitOwnEvents: false,
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) { if (state.status !== "da_collegare") console.log(`[${hhmm()}] QR pronto: apri http://localhost:${PORT} e inquadralo dal telefono`); state.status = "da_collegare"; state.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }); }
    if (u.connection === "open") {
      retry = 0;
      Object.assign(state, { status: "collegato", qr: "", me: digits(String(sock.user?.id || "").split(":")[0]), since: new Date().toISOString(), lastError: "" });
      console.log("WhatsApp collegato:", state.me);
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      state.lastError = String(u.lastDisconnect?.error?.message || code || "");
      if (code === DisconnectReason.loggedOut) {
        // Scollegato dal telefono: si cancella la sessione e si mostra un nuovo QR.
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        Object.assign(state, { status: "scollegato", me: "", qr: "" });
        retry = 0;
      } else {
        state.status = "riconnessione";
      }
      const wait = Math.min(60000, 2000 * 2 ** retry++);
      setTimeout(() => start().catch((e) => { state.lastError = e.message; }), wait);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return; // ignora la cronologia sincronizzata al collegamento
    for (const m of messages) {
      try { await onMessage(m); } catch (e) { state.errors++; state.lastError = `${hhmm()} ${e.message}`; console.log(`[${hhmm()}] ERRORE nell'inoltro a Partner Hub: ${e.message}`); }
    }
  });
}

// ---------- Pannello (QR e stato) ----------
function authorized(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(PANEL_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Ponte WhatsApp TL</title><style>
body{font-family:system-ui,sans-serif;background:#f4f7f7;color:#13302f;margin:0;padding:24px;display:flex;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 12px #0001;padding:24px;max-width:420px;width:100%;text-align:center}
h1{font-size:20px;margin:0 0 4px}small{color:#5b7170}img{width:280px;height:280px;margin:16px auto;display:block}
.st{display:inline-block;padding:6px 12px;border-radius:99px;font-weight:600;margin:12px 0}
.ok{background:#d9f5e3;color:#11643a}.wait{background:#fff1cc;color:#7a5200}.ko{background:#fde0e0;color:#8a1f1f}
ol{text-align:left;font-size:14px;line-height:1.6}button{border:0;border-radius:10px;padding:10px 16px;background:#8a1f1f;color:#fff;font-weight:600;cursor:pointer}
</style></head><body><div class="card"><h1>Ponte WhatsApp</h1><small>TL Comunicazioni – Connessi alle tue esigenze · versione ${VERSIONE}</small><div id="c">Caricamento…</div></div>
<script>
async function load(){const s=await (await fetch('/stato')).json();const c=document.getElementById('c');
if(s.status==='collegato'){c.innerHTML='<div class="st ok">Collegato</div><p>Numero: <b>+'+s.me+'</b><br>Messaggi ricevuti: '+s.received+' · inoltrati: '+s.handled+' · ignorati: '+s.ignored+' · errori: '+s.errors+'<br>Risposte inviate: '+s.replied+'</p>'+(s.lastEvent?'<p><small>Ultimo inoltrato: '+s.lastEvent+'</small></p>':'')+(s.lastIgnored?'<p><small>Ultimo ignorato: '+s.lastIgnored+'</small></p>':'')+(s.lastError?'<p style="color:#8a1f1f"><small>Ultimo errore: '+s.lastError+'</small></p>':'')+'<p><button onclick="if(confirm(\\'Scollegare WhatsApp dal ponte?\\'))fetch(\\'/scollega\\',{method:\\'POST\\'}).then(load)">Scollega</button>';}
else if(s.qr){c.innerHTML='<div class="st wait">Da collegare</div><img alt="QR code" src="'+s.qr+'"><ol><li>Apri WhatsApp Business sul telefono</li><li>Menu ⋮ → <b>Dispositivi collegati</b> → <b>Collega un dispositivo</b></li><li>Inquadra questo QR</li></ol>';}
else{c.innerHTML='<div class="st ko">'+s.status+'</div><p>'+(s.lastError||'Attendo il QR…')+'</p>';}}
load();setInterval(load,4000);
</script></body></html>`;

http.createServer(async (req, res) => {
  if (req.url === "/salute") { res.writeHead(200).end(state.status); return; }
  if (!authorized(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Ponte WhatsApp TL"' }).end("Accesso riservato"); return; }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE); return; }
  if (req.method === "GET" && req.url === "/stato") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state)); return; }
  if (req.method === "POST" && req.url === "/scollega") {
    try { await sock?.logout(); } catch {}
    res.writeHead(200).end("ok"); return;
  }
  res.writeHead(404).end("Non trovato");
}).listen(PORT, () => console.log(`Ponte WhatsApp versione ${VERSIONE} - pannello su http://localhost:${PORT}`));

start().catch((e) => { state.status = "errore"; state.lastError = e.message; console.error(e); });
