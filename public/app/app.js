// TL Agenti – app del titolare (vanilla JS, nessuna build).
const root = document.getElementById("root");
let me = null;
let pollTimer = null;

// ---------- utilità ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth")) {
    me = null;
    location.hash = "#/accedi";
    throw new Error("Accesso richiesto");
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : {};
  if (!res.ok) throw new Error(data.error ?? `Errore ${res.status}`);
  return data;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

const initials = (n) => (n || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const fmtTime = (s) => {
  if (!s) return "";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
};
// Appuntamenti: ora locale "YYYY-MM-DDTHH:MM" (già in ora italiana)
const fmtAppt = (s) => {
  const d = new Date(`${s}:00`);
  return d.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" }) + " · " + s.slice(11, 16);
};
const statusPill = (s) =>
  `<span class="pill ${s === "cliente" ? "ok" : s === "in trattativa" ? "accent" : s === "perso" ? "" : "warn"}">${esc(s)}</span>`;
const HOT = 70;
const scorePill = (s) =>
  s === null || s === undefined ? "" : `<span class="pill ${s >= HOT ? "hot" : s >= 40 ? "" : "cold"}" title="Valutazione del contatto">${s >= HOT ? "🔥 " : ""}${s}</span>`;
const channelName = (c) => ({ whatsapp: "WhatsApp", sito: "Sito", test: "Prova", manuale: "Manuale" })[c] ?? c;

const icons = {
  oggi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  chiedi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v11H8l-4 4z"/></svg>',
  contatti: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/></svg>',
  altro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

// ---------- layout ----------
function shell(active, title, body, { composer = false, badge = 0 } = {}) {
  const tabs = [
    ["oggi", "Oggi"],
    ["chiedi", "Chiedi a TL"],
    ["chat", "Chat"],
    ["contatti", "Contatti"],
    ["altro", "Altro"],
  ];
  root.innerHTML = `
  <div class="shell ${composer ? "has-composer" : ""}">
    <header class="topbar"><div class="logo">TL</div><h1>${esc(title)}</h1><span class="pill">${esc(me?.business?.name ?? "")}</span></header>
    <nav class="tabbar">${tabs
      .map(
        ([k, l]) =>
          `<a href="#/${k}" class="${active === k ? "active" : ""}">${icons[k]}<span>${l}</span>${
            k === "chat" && badge ? `<span class="dot">${badge}</span>` : ""
          }</a>`,
      )
      .join("")}</nav>
    <main id="main">${body}</main>
  </div>`;
  return document.getElementById("main");
}

// ---------- accesso ----------
async function viewAuth(mode = "accedi") {
  let status = { signup_open: false, first_setup: false };
  try {
    status = await api("/auth/status");
  } catch {}
  if (status.first_setup) mode = "registrati";
  if (!status.signup_open) mode = "accedi";
  const reg = mode === "registrati";
  const setup = status.first_setup;
  root.innerHTML = `
  <div class="auth">
    <div class="logo">TL</div>
    <h2>${setup ? "Configura TL Agenti" : reg ? "Attiva i tuoi agenti TL" : "Bentornato"}</h2>
    <p class="sub">${setup ? "Primo avvio: crea l'account amministratore di TL. Poi potrai aggiungere i colleghi da Altro → Team." : reg ? "Due minuti: crea l'account, poi raccontaci la tua attività." : "Accedi per vedere cosa hanno fatto i tuoi agenti."}</p>
    <form id="f" class="card">
      ${reg ? `<label>Nome dell'attività</label><input type="text" name="business_name" required value="${setup ? "TL Comunicazioni" : ""}" placeholder="Es. Centro estetico Aurora" />
      <label>Settore</label><input type="text" name="sector" placeholder="Es. estetica, idraulico, pizzeria" />
      <label>Città</label><input type="text" name="city" placeholder="Es. Milano" />
      <label>Il tuo nome</label><input type="text" name="name" />` : ""}
      <label>Email</label><input type="email" name="email" required autocomplete="email" />
      <label>Password</label><input type="password" name="password" required minlength="8" autocomplete="${reg ? "new-password" : "current-password"}" />
      <div class="error" id="err"></div>
      <button class="btn block" style="margin-top:16px">${reg ? "Crea account" : "Accedi"}</button>
    </form>
    <p class="sub" style="text-align:center;margin-top:14px">${
      setup ? "" : reg ? `Hai già un account? <a href="#/accedi">Accedi</a>` : status.signup_open ? `Non hai un account? <a href="#/registrati">Registrati</a>` : "Accesso riservato al team TL Comunicazioni."
    }</p>
  </div>`;
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      await api(reg ? "/auth/register" : "/auth/login", { body });
      await loadMe();
      location.hash = reg ? "#/impostazioni?benvenuto=1" : "#/oggi";
    } catch (err) {
      document.getElementById("err").textContent = err.message;
    }
  };
}

async function loadMe() {
  me = await api("/me");
}

// ---------- Oggi ----------
function creditsBanner(bl) {
  if (!bl?.enabled) return "";
  const left = bl.plan_credits + bl.extra_credits;
  if (!bl.can_use_ai)
    return `<div class="banner"><span class="grow">${bl.status === "trial_scaduta" ? "La prova gratuita è finita." : "Crediti IA esauriti."} L'assistente non risponde più ai clienti.</span><a class="btn small" href="#/piano">Ricarica</a></div>`;
  if (bl.status === "past_due")
    return `<div class="banner"><span class="grow">Il pagamento dell'abbonamento non è andato a buon fine.</span><a class="btn small" href="#/piano">Controlla</a></div>`;
  if (left < bl.plan_credits_total * 0.15)
    return `<div class="banner"><span class="grow">Restano ${left} crediti IA.</span><a class="btn small" href="#/piano">Ricarica</a></div>`;
  if (bl.status === "trial" && bl.trial_ends_at) {
    const days = Math.ceil((Date.parse(bl.trial_ends_at) - Date.now()) / 864e5);
    if (days <= 5) return `<div class="banner"><span class="grow">La prova gratuita finisce tra ${days} giorni.</span><a class="btn small" href="#/piano">Scegli il piano</a></div>`;
  }
  return "";
}

async function viewOggi() {
  const [d, p, bl] = await Promise.all([api("/dashboard"), api("/proposals"), api("/billing")]);
  me.billing = bl;
  const hour = new Date().getHours();
  const hello = hour < 13 ? "Buongiorno" : hour < 18 ? "Buon pomeriggio" : "Buonasera";
  const todo = p.proposals.filter((x) => x.status === "da fare");
  const done = p.proposals.filter((x) => x.status === "fatto").slice(0, 3);
  const main = shell(
    "oggi",
    "Oggi",
    `
    <p class="hello">${hello}${me.user.name ? ", " + esc(me.user.name.split(" ")[0]) : ""}</p>
    <p class="sub">Ecco cosa hanno fatto i tuoi agenti.</p>
    ${creditsBanner(me.billing)}
    ${!me.business.services ? `<div class="banner">Gli agenti non conoscono ancora servizi e prezzi. <a href="#/impostazioni">Completa la scheda</a></div>` : ""}
    <div class="stats">
      <div class="stat"><b>${d.contatti_oggi}</b><span>Contatti oggi</span></div>
      <div class="stat"><b>${d.risposte_7g}</b><span>Risposte (7 giorni)</span></div>
      <div class="stat"><b>${d.appuntamenti_futuri}</b><span>Appuntamenti in agenda</span></div>
      <div class="stat"><b>${d.chat_in_attesa}</b><span>Chat che aspettano te</span></div>
    </div>

    ${
      d.caldi.length
        ? `<div class="section-title">Contatti caldi da non perdere</div>
    <div class="card"><ul class="list">${d.caldi
      .map(
        (c) => `<li onclick="location.hash='#/chat/${c.id}'" style="cursor:pointer"><div class="avatar">${esc(initials(c.name || c.external_id))}</div>
        <div class="grow"><div class="title">${esc(c.name || c.external_id)}</div><div class="meta">${esc(c.qualification)}</div></div>${scorePill(c.score)}</li>`,
      )
      .join("")}</ul></div>`
        : ""
    }
    ${
      me.business.followup_enabled
        ? `<p class="sub" style="margin:12px 2px 0">Follow-up automatici negli ultimi 7 giorni: <b>${d.followup_7g}</b> inviati, <b>${d.risposte_dopo_followup_7g}</b> clienti hanno risposto.</p>`
        : `<p class="sub" style="margin:12px 2px 0">I follow-up automatici sono spenti. <a href="#/impostazioni">Attivali</a> per ricontattare da soli chi non risponde.</p>`
    }

    <div class="section-title">TL ti propone</div>
    <div class="card">
      <div id="proposals">${
        todo.length
          ? todo.map(proposalHtml).join("")
          : `<div class="empty">Nessuna proposta aperta.<br/>Chiedi a TL di analizzare i numeri e suggerirti cosa fare.</div>`
      }${done.map(proposalHtml).join("")}</div>
      <button class="btn secondary block" id="gen" style="margin-top:10px">${icons.spark} Analizza e proponi</button>
    </div>

    <div class="section-title">Ultimi contatti</div>
    <div class="card"><ul class="list">${
      d.ultimi_contatti.length
        ? d.ultimi_contatti
            .map(
              (c) => `<li onclick="location.hash='#/chat/${c.id}'" style="cursor:pointer"><div class="avatar">${esc(initials(c.name || c.external_id))}</div>
              <div class="grow"><div class="title">${esc(c.name || c.external_id)}</div><div class="meta">${channelName(c.channel)} · ${fmtTime(c.last_message_at)}</div></div>${scorePill(c.score)} ${statusPill(c.status)}</li>`,
            )
            .join("")
        : `<li class="empty">Ancora nessun contatto. Collega WhatsApp o il widget del sito da <a href="#/impostazioni">Impostazioni</a>.</li>`
    }</ul></div>

    <div class="section-title">Prossimi appuntamenti</div>
    <div class="card"><ul class="list">${
      d.prossimi_appuntamenti.length
        ? d.prossimi_appuntamenti
            .map((a) => `<li><div class="grow"><div class="title">${esc(a.name || "Senza nome")}</div><div class="meta">${esc(a.service)}</div></div><span class="pill">${fmtAppt(a.starts_at)}</span></li>`)
            .join("")
        : `<li class="empty">Nessun appuntamento in arrivo.</li>`
    }</ul></div>
  `,
    { badge: d.da_leggere },
  );
  bindProposals(main, viewOggi);
  main.querySelector("#gen").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "TL sta leggendo i numeri…";
    try {
      const r = await api("/proposals/generate", { body: {} });
      toast(`${r.created} nuove proposte`);
      viewOggi();
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
    }
  };
}

function proposalHtml(p) {
  const done = p.status === "fatto";
  return `<div class="proposal ${done ? "done" : ""}">
    <div class="icon">${done ? icons.check : icons.spark}</div>
    <div class="grow">
      <div class="title">${esc(p.title)}</div>
      <div class="detail">${esc(done ? p.result || p.detail : p.detail)}</div>
      ${
        done
          ? `<span class="pill ok">Fatto</span>`
          : `<div class="row">
              ${p.action_type === "nota" ? "" : `<button class="btn small" data-exec="${p.id}">Fallo per me</button>`}
              ${p.action_type === "nota" && JSON.parse(p.action_payload || "{}").contact_id ? `<a class="btn small" href="#/chat/${JSON.parse(p.action_payload).contact_id}">Apri chat</a>` : ""}
              <button class="btn small ghost" data-dismiss="${p.id}">${p.action_type === "nota" ? "Fatto" : "No, grazie"}</button>
            </div>`
      }
    </div></div>`;
}

function bindProposals(el, refresh) {
  el.querySelectorAll("[data-exec]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        b.textContent = "Sto facendo…";
        try {
          const r = await api(`/proposals/${b.dataset.exec}/execute`, { body: {} });
          toast(r.result);
        } catch (e) {
          toast(e.message);
        }
        refresh();
      }),
  );
  el.querySelectorAll("[data-dismiss]").forEach(
    (b) =>
      (b.onclick = async () => {
        await api(`/proposals/${b.dataset.dismiss}/dismiss`, { body: {} });
        refresh();
      }),
  );
}

// ---------- Chiedi a TL ----------
async function viewChiedi() {
  const { messages } = await api("/assistant");
  const main = shell(
    "chiedi",
    "Chiedi a TL",
    `
    <div class="chat" id="chat">
      ${
        messages.length
          ? messages.map((m) => `<div class="bubble ${m.role === "user" ? "out" : "in"}">${esc(m.text)}</div>`).join("")
          : `<div class="card"><b>Parla con TL come a un collaboratore.</b><p class="sub" style="margin:6px 0 0">Scrivi o tocca il microfono. TL legge i numeri, risponde ai clienti, sposta appuntamenti e prepara le pubblicità.</p></div>`
      }
    </div>
    <div class="suggestions">
      ${["Quanti contatti sono arrivati oggi?", "Chi non risponde da 3 giorni? Ricontattali tu", "Fammi una campagna per la mia zona", "Cosa ho in agenda domani?"]
        .map((s) => `<button data-s="${esc(s)}">${esc(s)}</button>`)
        .join("")}
    </div>
    <div class="composer">
      <button class="btn secondary" id="mic" title="Parla">${icons.mic}</button>
      <textarea id="txt" placeholder="Chiedi a TL…" rows="1"></textarea>
      <button class="btn" id="send" title="Invia">${icons.send}</button>
    </div>
  `,
    { composer: true },
  );
  const chat = main.querySelector("#chat");
  const txt = main.querySelector("#txt");
  window.scrollTo(0, document.body.scrollHeight);

  async function send(text) {
    if (!text.trim()) return;
    if (!messages.length) chat.innerHTML = "";
    chat.insertAdjacentHTML("beforeend", `<div class="bubble out">${esc(text)}</div><div class="bubble in typing" id="typing">TL sta lavorando…</div>`);
    txt.value = "";
    window.scrollTo(0, document.body.scrollHeight);
    try {
      const { reply } = await api("/assistant", { body: { text } });
      document.getElementById("typing").outerHTML = `<div class="bubble in">${esc(reply)}</div>`;
      messages.push({});
      speak(reply);
    } catch (e) {
      document.getElementById("typing").outerHTML = `<div class="bubble in">⚠️ ${esc(e.message)}</div>`;
    }
    window.scrollTo(0, document.body.scrollHeight);
  }
  main.querySelector("#send").onclick = () => send(txt.value);
  txt.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(txt.value);
    }
  };
  main.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => send(b.dataset.s)));
  setupVoice(main.querySelector("#mic"), (t) => send(t));
}

let lastInputWasVoice = false;
function setupVoice(btn, onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.onclick = () => toast("Il riconoscimento vocale non è supportato da questo browser. Prova con Chrome o Safari.");
    return;
  }
  btn.onclick = () => {
    const rec = new SR();
    rec.lang = "it-IT";
    rec.interimResults = false;
    btn.classList.add("listening");
    rec.onresult = (e) => {
      lastInputWasVoice = true;
      onText(e.results[0][0].transcript);
    };
    rec.onerror = () => toast("Non ho sentito bene, riprova.");
    rec.onend = () => btn.classList.remove("listening");
    rec.start();
  };
}
function speak(text) {
  if (!lastInputWasVoice || !window.speechSynthesis) return;
  lastInputWasVoice = false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "it-IT";
  speechSynthesis.speak(u);
}

// ---------- Chat ----------
async function viewChatList() {
  const { contacts } = await api("/contacts");
  const unread = contacts.reduce((s, c) => s + c.unread, 0);
  shell(
    "chat",
    "Conversazioni",
    `<div class="card"><ul class="list">${
      contacts.length
        ? contacts
            .map(
              (c) => `<li onclick="location.hash='#/chat/${c.id}'" style="cursor:pointer">
            <div class="avatar">${esc(initials(c.name || c.external_id))}</div>
            <div class="grow"><div class="title">${esc(c.name || c.external_id)} ${scorePill(c.score)} ${c.ai_paused ? '<span class="pill warn">aspetta te</span>' : ""}</div>
            <div class="meta">${esc(c.last_text ?? "")}</div></div>
            <div style="text-align:right"><div class="meta">${fmtTime(c.last_message_at)}</div>${c.unread ? `<span class="pill accent">${c.unread}</span>` : `<span class="pill">${channelName(c.channel)}</span>`}</div>
          </li>`,
            )
            .join("")
        : `<li class="empty">Nessuna conversazione. Prova l'assistente da <a href="#/prova">Altro → Prova l'assistente</a>.</li>`
    }</ul></div>`,
    { badge: unread },
  );
}

async function viewThread(id) {
  const { contact: c, messages } = await api(`/contacts/${id}/messages`);
  const main = shell(
    "chat",
    c.name || c.external_id,
    `
    <div class="thread-head">
      <div class="avatar">${esc(initials(c.name || c.external_id))}</div>
      <div class="grow"><b>${esc(c.name || "Senza nome")}</b><div class="meta" style="color:var(--muted);font-size:13px">${channelName(c.channel)} · ${esc(c.phone || c.external_id)}</div></div>
      ${scorePill(c.score)} ${statusPill(c.status)}
    </div>
    ${c.score !== null ? `<p class="sub" style="margin:-4px 2px 12px;font-size:13.5px">Valutazione TL: ${esc(c.qualification)}</p>` : ""}
    ${
      c.ai_paused
        ? `<div class="banner"><span class="grow">L'assistente è in pausa: questa chat aspetta una tua risposta.</span><button class="btn small" id="resume">Riattiva</button></div>`
        : `<div class="row" style="margin-bottom:12px"><span class="pill ok">Risponde l'assistente</span><span class="spacer"></span><button class="btn small ghost" id="pause">Rispondo io</button></div>`
    }
    <div class="chat">${messages
      .map(
        (m) => `<div class="bubble ${m.author === "cliente" ? "in" : "out"}">${esc(m.text)}<div class="who">${
          m.kind === "followup" ? "Follow-up automatico" : m.author === "agente" ? "Assistente TL" : m.author === "titolare" ? "Tu" : ""
        } ${fmtTime(m.created_at)}</div></div>`,
      )
      .join("")}</div>

    <div class="section-title">Scheda contatto</div>
    <form class="card" id="crm">
      <label>Nome</label><input type="text" name="name" value="${esc(c.name)}" />
      <label>Stato</label><select name="status">${["nuovo", "in trattativa", "cliente", "perso"].map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <label>Interesse</label><input type="text" name="interest" value="${esc(c.interest)}" />
      <label>Email</label><input type="email" name="email" value="${esc(c.email)}" />
      <label>Note</label><textarea name="notes">${esc(c.notes)}</textarea>
      <button class="btn" style="margin-top:12px">Salva</button>
    </form>

    <div class="composer">
      <textarea id="txt" placeholder="Scrivi come titolare…" rows="1"></textarea>
      <button class="btn" id="send">${icons.send}</button>
    </div>`,
    { composer: true },
  );
  window.scrollTo(0, 0);
  const toggle = async (paused) => {
    await api(`/contacts/${id}`, { method: "PATCH", body: { ai_paused: paused } });
    viewThread(id);
  };
  main.querySelector("#resume")?.addEventListener("click", () => toggle(false));
  main.querySelector("#pause")?.addEventListener("click", () => toggle(true));
  main.querySelector("#crm").onsubmit = async (e) => {
    e.preventDefault();
    await api(`/contacts/${id}`, { method: "PATCH", body: Object.fromEntries(new FormData(e.target)) });
    toast("Contatto salvato");
  };
  const txt = main.querySelector("#txt");
  main.querySelector("#send").onclick = async () => {
    if (!txt.value.trim()) return;
    try {
      await api(`/contacts/${id}/messages`, { body: { text: txt.value } });
      if (!c.ai_paused) await api(`/contacts/${id}`, { method: "PATCH", body: { ai_paused: true } });
      viewThread(id);
    } catch (e) {
      toast(e.message);
    }
  };
  pollTimer = setInterval(async () => {
    const r = await api(`/contacts/${id}/messages`).catch(() => null);
    if (r && r.messages.length !== messages.length) viewThread(id);
  }, 5000);
}

// ---------- Contatti (CRM) ----------
async function viewContatti(status = "") {
  const qs = status === "caldi" ? "?hot=1" : status ? `?status=${encodeURIComponent(status)}` : "";
  const { contacts } = await api(`/contacts${qs}`);
  const main = shell(
    "contatti",
    "Contatti",
    `
    <div class="row" style="margin-bottom:12px">
      ${["", "caldi", "nuovo", "in trattativa", "cliente", "perso"]
        .map((s) => `<button class="btn small ${s === status ? "" : "secondary"}" data-f="${s}">${s === "caldi" ? "🔥 Caldi" : s || "Tutti"}</button>`)
        .join("")}
      <span class="spacer"></span><button class="btn small accent" id="add">+ Nuovo</button>
    </div>
    <form class="card" id="new" hidden>
      <label>Nome</label><input type="text" name="name" required />
      <label>Telefono (con prefisso, es. +39…)</label><input type="tel" name="phone" />
      <label>Interesse</label><input type="text" name="interest" />
      <button class="btn" style="margin-top:12px">Aggiungi</button>
    </form>
    <div class="card"><ul class="list">${
      contacts.length
        ? contacts
            .map(
              (c) => `<li onclick="location.hash='#/chat/${c.id}'" style="cursor:pointer"><div class="avatar">${esc(initials(c.name || c.external_id))}</div>
          <div class="grow"><div class="title">${esc(c.name || c.external_id)}</div><div class="meta">${esc(c.qualification || c.interest || channelName(c.channel))}</div></div>${scorePill(c.score)} ${statusPill(c.status)}</li>`,
            )
            .join("")
        : `<li class="empty">Nessun contatto.</li>`
    }</ul></div>`,
  );
  main.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => viewContatti(b.dataset.f)));
  main.querySelector("#add").onclick = () => (main.querySelector("#new").hidden = false);
  main.querySelector("#new").onsubmit = async (e) => {
    e.preventDefault();
    await api("/contacts", { body: Object.fromEntries(new FormData(e.target)) });
    viewContatti(status);
  };
}

// ---------- Altro ----------
function viewAltro() {
  const items = [
    ["agenda", "Agenda", "Appuntamenti fissati dagli agenti e da te"],
    ["pubblicita", "Pubblicità", "Inserzioni preparate da TL da approvare"],
    ["agenti", "Il tuo team di agenti", "Chi fa cosa"],
    ["prova", "Prova l'assistente", "Scrivi come se fossi un cliente"],
    ["impostazioni", "La tua attività e i canali", "Servizi, prezzi, orari, WhatsApp, widget del sito"],
    ...(me.billing?.enabled ? [["piano", "Piano e crediti", "Abbonamento, crediti IA rimasti, ricariche"]] : []),
    ["team", "Team TL", "Colleghi con accesso, cambio password"],
  ];
  const main = shell(
    "altro",
    "Altro",
    `<div class="card"><ul class="list">${items
      .map(([k, t, d]) => `<li onclick="location.hash='#/${k}'" style="cursor:pointer"><div class="grow"><div class="title">${t}</div><div class="meta">${d}</div></div><span>›</span></li>`)
      .join("")}
      <li id="logout" style="cursor:pointer"><div class="grow"><div class="title">Esci</div></div></li></ul></div>`,
  );
  main.querySelector("#logout").onclick = async () => {
    await api("/auth/logout", { body: {} });
    me = null;
    location.hash = "#/accedi";
  };
}

async function viewAgenda() {
  const { appointments } = await api("/appointments");
  const main = shell(
    "altro",
    "Agenda",
    `
    <form class="card" id="new">
      <b>Nuovo appuntamento</b>
      <label>Quando</label><input type="datetime-local" name="starts_at" required />
      <label>Servizio</label><input type="text" name="service" />
      <label>Note</label><input type="text" name="notes" />
      <button class="btn" style="margin-top:12px">Aggiungi</button>
    </form>
    <div class="section-title">In arrivo</div>
    <div class="card"><ul class="list">${
      appointments.length
        ? appointments
            .map(
              (a) => `<li><div class="grow"><div class="title">${fmtAppt(a.starts_at)}</div><div class="meta">${esc(a.contact_name || "Senza nome")} · ${esc(a.service)} ${
                a.created_by === "agente" ? "· fissato da TL" : ""
              }</div></div><button class="btn small ghost" data-del="${a.id}">Annulla</button></li>`,
            )
            .join("")
        : `<li class="empty">Nessun appuntamento in arrivo.</li>`
    }</ul></div>`,
  );
  main.querySelector("#new").onsubmit = async (e) => {
    e.preventDefault();
    await api("/appointments", { body: Object.fromEntries(new FormData(e.target)) });
    viewAgenda();
  };
  main.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Annullare l'appuntamento?")) return;
        await api(`/appointments/${b.dataset.del}`, { method: "DELETE" });
        viewAgenda();
      }),
  );
}

async function viewPubblicita() {
  const { ads } = await api("/ads");
  const main = shell(
    "altro",
    "Pubblicità",
    `
    <p class="sub">TL scrive le inserzioni partendo dalla tua scheda. Approva quelle che ti piacciono. La pubblicazione automatica su Meta e Google Ads arriverà a breve: per ora copia il testo nel tuo gestore inserzioni.</p>
    <a class="btn block" href="#/chiedi" style="margin-bottom:14px">${icons.spark} Chiedi a TL una nuova campagna</a>
    ${
      ads.length
        ? ads
            .map(
              (a) => `<div class="ad">
          <div class="row"><span class="pill">${esc(a.platform)}</span><span class="pill ${a.status === "approvata" ? "ok" : "warn"}">${esc(a.status)}</span><span class="spacer"></span><b>${Number(a.daily_budget).toFixed(0)} €/giorno</b></div>
          <h4>${esc(a.headline)}</h4><p>${esc(a.body)}</p>
          <div class="meta" style="color:var(--muted);font-size:13px">Pulsante: ${esc(a.cta)} · Pubblico: ${esc(a.audience)}</div>
          ${
            a.status === "bozza"
              ? `<div class="row" style="margin-top:10px"><button class="btn small" data-ok="${a.id}">Approva</button><button class="btn small ghost" data-no="${a.id}">Scarta</button></div>`
              : `<button class="btn small secondary" style="margin-top:10px" data-copy="${a.id}">Copia testo</button>`
          }
        </div>`,
            )
            .join("")
        : `<div class="card empty">Nessuna inserzione ancora.</div>`
    }`,
  );
  const set = (id, status) => api(`/ads/${id}`, { method: "PATCH", body: { status } }).then(viewPubblicita);
  main.querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => set(b.dataset.ok, "approvata")));
  main.querySelectorAll("[data-no]").forEach((b) => (b.onclick = () => set(b.dataset.no, "scartata")));
  main.querySelectorAll("[data-copy]").forEach(
    (b) =>
      (b.onclick = () => {
        const a = ads.find((x) => String(x.id) === b.dataset.copy);
        navigator.clipboard?.writeText(`${a.headline}\n\n${a.body}\n\n${a.cta}`);
        toast("Testo copiato");
      }),
  );
}

function viewAgenti() {
  const depts = [
    ["Manager", "Coordina il team e lavora per portarti più fatturato", [["TL Manager", "Parla con te, legge i numeri, propone azioni", 1]]],
    ["Vendite e clienti", "Parla con i clienti e chiude", [
      ["Vendite WhatsApp", "Risponde in pochi secondi, anche di notte", 1],
      ["Vendite sito", "La chat sul tuo sito web", 1],
      ["Follow-up", "Ricontatta chi non ha risposto", 1],
      ["Instagram e Messenger", "In arrivo", 0],
    ]],
    ["Segreteria e agenda", "Tiene in ordine gli appuntamenti", [
      ["Agenda", "Propone orari liberi e prenota", 1],
      ["Promemoria", "In arrivo", 0],
    ]],
    ["Pubblicità e contenuti", "Porta nuovi contatti", [
      ["Copywriter inserzioni", "Scrive le pubblicità per Meta, Google e TikTok", 1],
      ["Pubblicazione Meta Ads", "In arrivo", 0],
      ["Social e blog", "In arrivo", 0],
    ]],
    ["Dati e strategia", "Legge i numeri e decide le mosse", [
      ["Analista", "Contatti, risposte, appuntamenti", 1],
      ["Proposte del giorno", "Cosa fare oggi, in parole semplici", 1],
    ]],
  ];
  shell(
    "altro",
    "Il tuo team",
    `<p class="sub">Partono tutti dalla stessa scheda: quello che vendi, a chi e come lo dici.</p>${depts
      .map(
        ([n, d, ag]) => `<div class="card dept"><h3>${n}</h3><div class="sub" style="margin:0">${d}</div><div class="agents">${ag
          .map(([a, s, live]) => `<div class="agent ${live ? "live" : ""}"><b>${a}</b><span>${s}</span></div>`)
          .join("")}</div></div>`,
      )
      .join("")}`,
  );
}

// ---------- Prova l'assistente ----------
function viewProva() {
  let visitor = null;
  try {
    visitor = localStorage.getItem("tl_test_visitor");
    if (!visitor) localStorage.setItem("tl_test_visitor", (visitor = "prova-" + Math.random().toString(36).slice(2, 10)));
  } catch {
    visitor = "prova-" + Math.random().toString(36).slice(2, 10);
  }
  const main = shell(
    "altro",
    "Prova l'assistente",
    `<p class="sub">Scrivi come se fossi un cliente. Le risposte usano la tua scheda e la tua agenda vere (gli appuntamenti di prova finiscono in Agenda).</p>
     <div class="chat" id="chat"></div>
     <div class="composer"><textarea id="txt" placeholder="Es. Buonasera, quanto costa…?" rows="1"></textarea><button class="btn" id="send">${icons.send}</button></div>`,
    { composer: true },
  );
  const chat = main.querySelector("#chat");
  const txt = main.querySelector("#txt");
  const slug = me.business.slug;
  fetch(`/api/public/${slug}/messages?test=1&visitor_id=${visitor}`)
    .then((r) => r.json())
    .then(({ messages }) => {
      chat.innerHTML = messages.map((m) => `<div class="bubble ${m.author === "cliente" ? "out" : "in"}">${esc(m.text)}</div>`).join("");
      window.scrollTo(0, document.body.scrollHeight);
    });
  async function send() {
    const text = txt.value.trim();
    if (!text) return;
    txt.value = "";
    chat.insertAdjacentHTML("beforeend", `<div class="bubble out">${esc(text)}</div><div class="bubble in typing" id="typing">sta scrivendo…</div>`);
    window.scrollTo(0, document.body.scrollHeight);
    const r = await fetch(`/api/public/${slug}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: visitor, text, test: true }),
    }).then((r) => r.json());
    document.getElementById("typing").outerHTML = `<div class="bubble in">${esc(
      r.reply ?? r.error ?? "(Assistente in pausa: la chat è passata al titolare)",
    )}</div>`;
    window.scrollTo(0, document.body.scrollHeight);
  }
  main.querySelector("#send").onclick = send;
  txt.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
}

// ---------- Team ----------
async function viewTeam() {
  const { users, me: myId } = await api("/team");
  const main = shell(
    "altro",
    "Team TL",
    `<div class="card"><ul class="list">${users
      .map(
        (u) => `<li><div class="avatar">${esc(initials(u.name || u.email))}</div><div class="grow"><div class="title">${esc(u.name || u.email)}${u.id === myId ? " (tu)" : ""}</div><div class="meta">${esc(u.email)}</div></div>${
          u.id === myId ? "" : `<button class="btn small ghost" data-del="${u.id}">Rimuovi</button>`
        }</li>`,
      )
      .join("")}</ul></div>
    <form class="card" id="add">
      <b>Aggiungi un collega</b>
      <label>Nome</label><input type="text" name="name" />
      <label>Email</label><input type="email" name="email" required />
      <label>Password iniziale (almeno 8 caratteri)</label><input type="text" name="password" required minlength="8" autocomplete="off" />
      <p class="hint">Comunicagliela di persona: potrà cambiarla da qui.</p>
      <button class="btn" style="margin-top:8px">Aggiungi</button>
    </form>
    <form class="card" id="pw">
      <b>Cambia la tua password</b>
      <label>Password attuale</label><input type="password" name="current" required autocomplete="current-password" />
      <label>Nuova password</label><input type="password" name="password" required minlength="8" autocomplete="new-password" />
      <button class="btn secondary" style="margin-top:12px">Cambia password</button>
    </form>`,
  );
  main.querySelector("#add").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/team", { body: Object.fromEntries(new FormData(e.target)) });
      toast("Collega aggiunto");
      viewTeam();
    } catch (err) {
      toast(err.message);
    }
  };
  main.querySelector("#pw").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/me/password", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
      toast("Password cambiata");
      e.target.reset();
    } catch (err) {
      toast(err.message);
    }
  };
  main.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Rimuovere l'accesso a questo collega?")) return;
        await api(`/team/${b.dataset.del}`, { method: "DELETE" });
        viewTeam();
      }),
  );
}

// ---------- Piano e crediti ----------
const AGENT_NAMES = { vendite: "Risposte ai clienti", manager: "Chiedi a TL", "manager-proposte": "Proposte del giorno", "follow-up": "Follow-up automatici" };
const STATUS_NAMES = { trial: "Prova gratuita", trial_scaduta: "Prova gratuita finita", active: "Attivo", past_due: "Pagamento non riuscito", canceled: "Disdetto" };

async function viewPiano(esito) {
  const bl = await api("/billing");
  me.billing = bl;
  const o = bl.offer;
  const left = bl.plan_credits + bl.extra_credits;
  const pct = Math.min(100, Math.round((bl.plan_credits / Math.max(1, bl.plan_credits_total)) * 100));
  const activePlan = bl.status === "active" || bl.status === "past_due";
  const main = shell(
    "altro",
    "Piano e crediti",
    !bl.enabled
      ? `<div class="card"><b>Pagamenti non attivi su questo server.</b><p class="sub" style="margin:6px 0 0">Gli agenti funzionano senza limiti di crediti. Per attivarli imposta le chiavi Stripe (vedi README).</p></div>`
      : `
    ${esito === "ok" ? `<div class="banner" style="background:var(--ok-soft);color:var(--ok)">Pagamento ricevuto, grazie! I crediti compaiono qui appena Stripe conferma (pochi secondi).</div>` : ""}
    ${creditsBanner(bl)}
    <div class="card">
      <div class="row"><b style="font-size:17px">${bl.plan === "yearly" ? "Piano annuale" : bl.plan === "monthly" ? "Piano mensile" : "Prova gratuita"}</b><span class="spacer"></span>
      <span class="pill ${bl.status === "active" || bl.status === "trial" ? "ok" : "warn"}">${STATUS_NAMES[bl.status] ?? bl.status}</span></div>
      ${bl.status === "trial" && bl.trial_ends_at ? `<p class="sub" style="margin:6px 0 0">Fino al ${new Date(bl.trial_ends_at).toLocaleDateString("it-IT", { day: "numeric", month: "long" })}</p>` : ""}
      <div class="stats" style="margin-top:14px;grid-template-columns:repeat(2,1fr)">
        <div class="stat"><b>${left}</b><span>Crediti IA disponibili</span></div>
        <div class="stat"><b>${bl.extra_credits}</b><span>di cui extra (non scadono)</span></div>
      </div>
      <div class="meter" aria-label="Crediti del piano rimasti"><span style="width:${pct}%"></span></div>
      <p class="hint">${bl.plan_credits} di ${bl.plan_credits_total} crediti del ${bl.plan === "trial" ? "periodo di prova" : "mese"}. Una risposta a un cliente costa in genere 1-3 crediti.</p>
      ${bl.has_portal ? `<button class="btn secondary block" id="portal" style="margin-top:10px">Gestisci abbonamento, fatture e carta</button>` : ""}
    </div>

    ${
      activePlan
        ? ""
        : `<div class="section-title">Scegli il piano</div>
    <div class="plans">
      <div class="card plan"><b>Mensile</b><div class="price">${o.monthly_eur} €<small>/mese</small></div>
        <p class="hint">${o.plan_credits} crediti IA al mese, tutti gli agenti, senza vincoli.</p>
        <button class="btn block" data-buy="monthly" ${o.available.monthly ? "" : "disabled"}>Attiva</button></div>
      <div class="card plan best"><span class="pill accent">Risparmi ${Math.round(100 - (o.yearly_eur / (o.monthly_eur * 12)) * 100)}%</span><b>Annuale</b><div class="price">${o.yearly_eur} €<small>/anno</small></div>
        <p class="hint">${o.plan_credits} crediti IA ogni mese, tutti gli agenti.</p>
        <button class="btn accent block" data-buy="yearly" ${o.available.yearly ? "" : "disabled"}>Attiva</button></div>
    </div>`
    }
    <div class="card" style="margin-top:14px">
      <div class="row"><div class="grow"><b>Pacchetto ${o.pack_credits} crediti</b><div class="hint">${o.pack_eur} € una tantum, non scadono. Si usano quando finiscono quelli del piano.</div></div>
      <button class="btn secondary" data-buy="pack" ${o.available.pack ? "" : "disabled"}>Compra</button></div>
    </div>

    <div class="section-title">Consumo ultimi 30 giorni</div>
    <div class="card"><ul class="list">${
      bl.usage_30d.length
        ? bl.usage_30d.map((u) => `<li><div class="grow"><div class="title">${esc(AGENT_NAMES[u.agent] ?? u.agent)}</div><div class="meta">${u.chiamate} ${u.chiamate === 1 ? "operazione" : "operazioni"}</div></div><b>${u.crediti ?? 0} ${u.crediti === 1 ? "credito" : "crediti"}</b></li>`).join("")
        : `<li class="empty">Nessun consumo ancora.</li>`
    }</ul></div>`,
  );
  main.querySelectorAll("[data-buy]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          location.href = (await api("/billing/checkout", { body: { kind: b.dataset.buy } })).url;
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      }),
  );
  main.querySelector("#portal")?.addEventListener("click", async () => {
    try {
      location.href = (await api("/billing/portal", { body: {} })).url;
    } catch (e) {
      toast(e.message);
    }
  });
}

// ---------- Impostazioni ----------
function viewImpostazioni(welcome) {
  const b = me.business;
  const days = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
  const webhook = `${location.origin}/webhooks/whatsapp`;
  const snippet = `<script src="${location.origin}/widget.js" data-tl="${b.slug}" async></script>`;
  const main = shell(
    "altro",
    "La tua attività",
    `
    ${welcome ? `<div class="banner">Benvenuto! Racconta la tua attività: gli agenti la imparano una volta e la usano con tutti i clienti.</div>` : ""}
    <form id="f">
      <div class="card">
        <b>La tua attività</b>
        <label>Nome</label><input type="text" name="name" value="${esc(b.name)}" required />
        <label>Settore</label><input type="text" name="sector" value="${esc(b.sector)}" />
        <label>Città o zona servita</label><input type="text" name="city" value="${esc(b.city)}" />
        <label>Cosa fai e per chi<div class="hint">Due o tre frasi: cosa ti rende diverso, che clienti servi.</div></label>
        <textarea name="description">${esc(b.description)}</textarea>
        <label>Servizi e prezzi<div class="hint">Uno per riga, es. "Pulizia viso – 60 € (a novembre 48 €), 50 minuti".</div></label>
        <textarea name="services" style="min-height:140px">${esc(b.services)}</textarea>
        <label>Domande frequenti e info utili<div class="hint">Parcheggio, pagamenti, zone servite, cosa portare…</div></label>
        <textarea name="faq">${esc(b.faq)}</textarea>
        <label>Tono di voce</label><input type="text" name="tone" value="${esc(b.tone)}" />
      </div>
      <div class="card">
        <b>Prequalifica dei contatti</b>
        <label>Il tuo cliente ideale e come riconoscerlo<div class="hint">Es. "Zona Milano e provincia. Interessante se vuole un intervento entro 30 giorni e ha un budget sopra 300 €. Non seguiamo condomini." L'assistente fa le domande giuste e dà a ogni contatto un voto da 0 a 100: sopra 70 ti avvisa.</div></label>
        <textarea name="qualification_rules">${esc(b.qualification_rules)}</textarea>
      </div>
      <div class="card">
        <b>Follow-up automatici</b>
        <label class="toggle" style="margin-top:10px"><input type="checkbox" name="followup_enabled" ${b.followup_enabled ? "checked" : ""}/> Ricontatta da solo chi smette di rispondere</label>
        <p class="hint">Messaggi brevi scritti sulla conversazione, solo dal lunedì al sabato tra le 9 e le 20. Si ferma appena il cliente risponde, prenota o viene segnato come perso.</p>
        <label>Dopo quante ore di silenzio</label><input type="number" name="followup_after_hours" value="${b.followup_after_hours}" min="1" max="720" />
        <label>Quanti tentativi al massimo</label><input type="number" name="followup_max" value="${b.followup_max}" min="0" max="5" />
        <label>Modello WhatsApp per i follow-up oltre 24 ore (facoltativo)<div class="hint">WhatsApp permette testo libero solo entro 24 ore dall'ultimo messaggio del cliente. Oltre serve un modello approvato da Meta in italiano, con un parametro per il nome (es. "Ciao {{1}}, posso ancora aiutarti?"). Scrivi qui il suo nome.</div></label>
        <input type="text" name="wa_followup_template" value="${esc(b.wa_followup_template)}" placeholder="es. followup_cliente" />
        <div id="fu" class="hint" style="margin-top:12px"></div>
        <button type="button" class="btn small secondary" id="furun" style="margin-top:8px">Invia ora i follow-up in coda</button>
      </div>
      <div class="card">
        <b>Orari e agenda</b>
        <p class="hint">Formato "09:00-13:00, 15:00-19:00". Lascia vuoto se chiuso.</p>
        <div class="hours">${days.map((d) => `<span>${d}</span><input type="text" name="h_${d}" value="${esc(b.hours[d] ?? "")}" />`).join("")}</div>
        <label>Durata di un appuntamento (minuti)</label><input type="number" name="slot_minutes" value="${b.slot_minutes}" min="10" max="480" />
      </div>
      <div class="card">
        <label class="toggle"><input type="checkbox" name="ai_enabled" ${b.ai_enabled ? "checked" : ""}/> L'assistente risponde ai clienti</label>
        <p class="hint">Se lo spegni, i messaggi arrivano comunque nelle Chat e rispondi tu.</p>
      </div>
      <div class="card">
        <b>WhatsApp Business</b>
        <p class="hint">Serve un numero collegato a WhatsApp Business Platform (Meta). In Meta for Developers imposta il webhook su<br/><code>${esc(webhook)}</code> con il verify token del server, campo "messages".</p>
        <label>Phone number ID</label><input type="text" name="wa_phone_number_id" value="${esc(b.wa_phone_number_id)}" />
        <label>Token di accesso<div class="hint">${b.wa_token_set ? "Già impostato: lascia vuoto per non cambiarlo." : "Token permanente dell'utente di sistema."}</div></label>
        <input type="password" name="wa_token" autocomplete="off" />
      </div>
      <div class="card">
        <b>Chat sul tuo sito</b>
        <p class="hint">Incolla questa riga prima di &lt;/body&gt; nel tuo sito (WordPress, Wix, Shopify…).</p>
        <div class="code">${esc(snippet)}</div>
      </div>
      <button class="btn block" style="margin-top:14px">Salva</button>
    </form>`,
  );
  const fu = main.querySelector("#fu");
  const loadQueue = () =>
    api("/followups").then(({ in_coda }) => {
      fu.textContent = in_coda.length
        ? `In coda ora: ${in_coda.map((c) => `${c.name} (tentativo ${c.tentativo})`).join(", ")}`
        : "Nessun contatto in attesa di follow-up in questo momento.";
    });
  loadQueue();
  main.querySelector("#furun").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("/followups/run", { body: {} });
      toast(`${r.sent} follow-up inviati${r.skipped.length ? `, ${r.skipped.length} saltati` : ""}`);
      if (r.skipped.length) fu.textContent = r.skipped.map((s) => `${s.contact}: ${s.reason}`).join(" · ");
      else loadQueue();
    } catch (err) {
      toast(err.message);
    }
    e.target.disabled = false;
  };
  main.querySelector("#f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get("name"),
      sector: fd.get("sector"),
      city: fd.get("city"),
      description: fd.get("description"),
      services: fd.get("services"),
      faq: fd.get("faq"),
      tone: fd.get("tone"),
      slot_minutes: Number(fd.get("slot_minutes")),
      hours: Object.fromEntries(days.map((d) => [d, String(fd.get(`h_${d}`) ?? "")])),
      ai_enabled: fd.get("ai_enabled") === "on",
      qualification_rules: fd.get("qualification_rules"),
      followup_enabled: fd.get("followup_enabled") === "on",
      followup_after_hours: Number(fd.get("followup_after_hours")),
      followup_max: Number(fd.get("followup_max")),
      wa_followup_template: fd.get("wa_followup_template"),
      wa_phone_number_id: fd.get("wa_phone_number_id"),
      wa_token: fd.get("wa_token") || undefined,
    };
    try {
      me.business = (await api("/business", { method: "PUT", body })).business;
      toast("Salvato. Gli agenti usano già i nuovi dati.");
      if (welcome) location.hash = "#/prova";
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- router ----------
async function route() {
  clearInterval(pollTimer);
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "registrati" || parts[0] === "accedi") return viewAuth(parts[0]);
  if (!me) {
    try {
      await loadMe();
    } catch {
      return viewAuth(parts[0] === "registrati" ? "registrati" : "accedi");
    }
  }
  try {
    switch (parts[0]) {
      case "chiedi": return await viewChiedi();
      case "chat": return parts[1] ? await viewThread(parts[1]) : await viewChatList();
      case "contatti": return await viewContatti();
      case "altro": return viewAltro();
      case "agenda": return await viewAgenda();
      case "pubblicita": return await viewPubblicita();
      case "agenti": return viewAgenti();
      case "prova": return viewProva();
      case "team": return await viewTeam();
      case "piano": return await viewPiano(new URLSearchParams(query).get("esito"));
      case "impostazioni": return viewImpostazioni(new URLSearchParams(query).has("benvenuto"));
      default: return await viewOggi();
    }
  } catch (e) {
    if (me) toast(e.message);
  }
}

window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
