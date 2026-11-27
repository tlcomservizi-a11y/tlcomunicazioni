// Chat TL da incollare in qualsiasi sito:
// <script src="https://TUO-DOMINIO/widget.js" data-tl="slug-attivita" async></script>
(function () {
  var script = document.currentScript || document.querySelector("script[data-tl]");
  if (!script) return;
  var slug = script.getAttribute("data-tl");
  var base = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#0f3d3e";
  var key = "tl_visitor_" + slug;
  var visitor;
  try {
    visitor = localStorage.getItem(key);
    if (!visitor) localStorage.setItem(key, (visitor = "v-" + Math.random().toString(36).slice(2) + Date.now().toString(36)));
  } catch (e) {
    visitor = "v-" + Math.random().toString(36).slice(2);
  }
  var lastId = 0;
  var bizName = "";

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000";
  var shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<style>" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,sans-serif}" +
    ".fab{width:58px;height:58px;border-radius:50%;border:0;background:" + color + ";color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:grid;place-items:center}" +
    ".fab svg{width:26px;height:26px}" +
    ".panel{position:absolute;right:0;bottom:72px;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 110px));background:#fff;color:#17211f;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}" +
    ".panel.open{display:flex}" +
    ".head{background:" + color + ";color:#fff;padding:14px 16px;font-weight:600}" +
    ".head small{display:block;font-weight:400;opacity:.85;font-size:12px}" +
    ".msgs{flex:1;overflow-y:auto;padding:12px;background:#f6f4ef;display:flex;flex-direction:column;gap:8px}" +
    ".b{max-width:85%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".in{background:#fff;align-self:flex-start;border:1px solid #e2ddd2}" +
    ".out{background:#d9efe6;align-self:flex-end}" +
    ".typing{color:#5d6965;font-style:italic}" +
    "form{display:flex;gap:6px;padding:10px;border-top:1px solid #e2ddd2;background:#fff}" +
    "input{flex:1;padding:10px 12px;border:1px solid #e2ddd2;border-radius:10px;font-size:14px;outline:none;color:#17211f;background:#fff}" +
    "button.s{border:0;border-radius:10px;background:" + color + ";color:#fff;padding:0 14px;font-weight:600;cursor:pointer}" +
    "</style>" +
    '<div class="panel" part="panel"><div class="head"><span class="n">Scrivici</span><small>Di solito rispondiamo in pochi secondi</small></div>' +
    '<div class="msgs"></div><form><input placeholder="Scrivi un messaggio…" maxlength="2000" /><button class="s">Invia</button></form></div>' +
    '<button class="fab" aria-label="Apri la chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H8l-4 4z"/></svg></button>';

  var panel = shadow.querySelector(".panel");
  var msgs = shadow.querySelector(".msgs");
  var input = shadow.querySelector("input");
  var poll;

  function add(text, cls) {
    var d = document.createElement("div");
    d.className = "b " + cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function refresh() {
    fetch(base + "/api/public/" + slug + "/messages?visitor_id=" + encodeURIComponent(visitor) + "&after=" + lastId)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        (d.messages || []).forEach(function (m) {
          lastId = Math.max(lastId, m.id);
          if (!shadow.querySelector('[data-id="' + m.id + '"]')) {
            var el = add(m.text, m.author === "cliente" ? "out" : "in");
            el.setAttribute("data-id", m.id);
          }
        });
      })
      .catch(function () {});
  }

  fetch(base + "/api/public/" + slug)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      bizName = d.name || "";
      if (bizName) shadow.querySelector(".n").textContent = bizName;
    })
    .catch(function () {});

  shadow.querySelector(".fab").onclick = function () {
    var open = panel.classList.toggle("open");
    if (open) {
      if (!msgs.children.length) add("Ciao! Come possiamo aiutarti?", "in");
      refresh();
      poll = setInterval(refresh, 6000);
      input.focus();
    } else clearInterval(poll);
  };

  shadow.querySelector("form").onsubmit = function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    add(text, "out");
    var t = add("sta scrivendo…", "in typing");
    fetch(base + "/api/public/" + slug + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: visitor, text: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function () { t.remove(); msgs.innerHTML = ""; lastId = 0; refresh(); })
      .catch(function () { t.textContent = "Messaggio non inviato, riprova."; });
  };

  document.body.appendChild(host);
})();
