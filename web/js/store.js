// Shared state, event bus, WebSocket and REST helpers. Every module imports from here.
//
// Events (store.on(name, fn)):
//   'hello'   (helloMsg)        static catalog: assets, tags, actions, allowed, faults, scenarios, levels, reason_codes, assumptions
//   'tick'    (tickMsg)         every twin tick (see /tick_sample.json for the exact shape)
//   'event'   (evt)             each item of tickMsg.events: {kind: alert|emergency|fallback|recover|learned|failure|prevented|action|decision|scenario, text, asset, payload}
//   'conn'    (bool)            websocket connected?
//   'select'  (assetId|null)    asset selected (opens / closes the drawer)
//   'tab'     (name)            live | explain | report | audit | spec
//   'caption' ({text, step, total} | null)   demo director caption
//   'present' (bool)            presentation mode toggled
// UI commands (emitted by the demo director, handled by app.js drawer):
//   'cmd:council'  ()                         run council for the selected asset
//   'cmd:whatif'   ({action, derate, throughput})  set what-if controls and run it
//   'cmd:decision' ({decision, action?, reason_code?, note?})  decide on the selected asset's open alert

const listeners = {};

export const store = {
  hello: null,
  tick: null,
  connected: false,
  selected: null,
  tab: "live",
  presentation: false,
  on(evt, fn) { (listeners[evt] ||= []).push(fn); return () => (listeners[evt] = listeners[evt].filter((f) => f !== fn)); },
  emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(evt, e); } }); },
  select(asset) { this.selected = asset; this.emit("select", asset); },
  setTab(name) { this.tab = name; this.emit("tab", name); },
  risk(asset) { return this.tick?.risks?.[asset]; },
  openAlert(asset) { return this.tick?.alerts?.find((a) => a.asset === asset); },
};

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws, backoff = 500, pinger;
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws/stream`);
    ws.onopen = () => {
      backoff = 500; store.connected = true; store.emit("conn", true);
      pinger = setInterval(() => ws.readyState === 1 && ws.send("ping"), 15000);
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "hello") { store.hello = msg; store.emit("hello", msg); return; }
      store.tick = msg;
      store.emit("tick", msg);
      (msg.events || []).forEach((e) => store.emit("event", e));
    };
    ws.onclose = () => {
      clearInterval(pinger); store.connected = false; store.emit("conn", false);
      setTimeout(open, backoff); backoff = Math.min(backoff * 2, 5000);
    };
  };
  open();
}

// ---------- shared formatting helpers
export const LEVEL = {
  1: { cls: "l1", name: "ML · LightGBM + SHAP", short: "ML", color: "var(--ml)" },
  2: { cls: "l2", name: "FALLBACK 1 · Health Engine", short: "ENGINE", color: "var(--engine)" },
  3: { cls: "l3", name: "FALLBACK 2 · LLM-estimated", short: "LLM", color: "var(--llm)" },
};
export const badge = (level, stale) =>
  `<span class="badge ${stale ? "stale" : LEVEL[level]?.cls || "l2"}" title="Provenance of this output">${LEVEL[level]?.name || "?"}${stale ? " · STALE" : ""}</span>`;
export const riskClass = (p) => (p < 0.3 ? "risk-low" : p < 0.6 ? "risk-med" : p < 0.85 ? "risk-high" : "risk-crit");
export const riskColor = (p) => (p < 0.3 ? "#1f8a5b" : p < 0.6 ? "#b7791f" : p < 0.85 ? "#c2410c" : "#b42318");
// muted asset identity colours (same as tokens.css --F1 … --CL and the report figures)
export const ASSET_COLOR = { F1: "#c2410c", R1: "#2563a8", R2: "#6d4fc2", CB: "#0f7f75", CL: "#a8336b" };
export const riskLevel = (p) => (p < 0.3 ? "LOW" : p < 0.6 ? "MEDIUM" : p < 0.85 ? "HIGH" : "CRITICAL");
export const pct = (x, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
export const num = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));
export const inr = (x) => "₹" + Math.round(x).toLocaleString("en-IN");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const ASSET_ORDER = ["F1", "R1", "R2", "CB", "CL"];
