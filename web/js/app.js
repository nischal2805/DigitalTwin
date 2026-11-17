// Sahayak — app shell: boot overlay, top bar, live twin (hero, cards, impact, KPIs, feed), toasts, tab switching.
import { store, api, connect, riskColor, pct, num, inr, esc, ASSET_ORDER, ASSET_COLOR } from "./store.js";
import { createMill } from "./mill.js";
import { sound } from "./sound.js";
import { mountDrawer } from "./drawer.js";
import { mountTabs } from "./tabs.js";
import { director, togglePresentation } from "./director.js";

const $ = (id) => document.getElementById(id);
const ICONS = {
  alert: "M12 3l10 18H2zM12 10v5M12 18v.5",
  emergency: "M12 3l10 18H2zM12 10v5M12 18v.5",
  failure: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8 8l8 8M16 8l-8 8",
  fallback: "M13 2L4 14h7l-1 8 9-12h-7z",
  recover: "M20 6L9 17l-5-5",
  prevented: "M12 2l8 4v6c0 5-3.500 8-8 10-4.500-2-8-5-8-10V6zM9 12l2 2 4-4",
  learned: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 4 3 3 0 0 0 5 1V4a3 3 0 0 0-3 0zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 4 3 3 0 0 1-5 1",
  action: "M5 12h14M13 6l6 6-6 6",
  decision: "M5 12l4 4L19 6",
  scenario: "M12 3v18M3 12h18",
  info: "M12 8v.5M12 11v6M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z",
};
const icon = (k) => `<svg class="ic" viewBox="0 0 24 24"><path d="${ICONS[k] || ICONS.info}"/></svg>`;
const LABEL = { alert: "Alert", emergency: "Emergency", failure: "Failure", fallback: "Fallback", recover: "Recovered", prevented: "Prevented", learned: "AI learned", action: "Action", decision: "Decision", scenario: "Scenario", info: "Notice" };
const act = (path, body) => api(path, body).catch((e) => toast({ kind: "failure", text: e.message }));

// ---------- number tweening (only restarts when target changes)
function tween(el, to, fmt, dur = 600) {
  if (to == null || Number.isNaN(to)) { el.textContent = "—"; el._t = null; return; }
  if (el._t === to) return;
  if (document.hidden) { el._t = el._cur = to; el.textContent = fmt(to); return; } // rAF is paused in hidden tabs
  const from = el._cur ?? to; el._t = to; cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el._cur = from + (to - from) * e; el.textContent = fmt(el._cur);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
const clock = (t) => { const m = 360 + Math.round(t || 0); const d = Math.floor(m / 1440) + 1, h = Math.floor(m / 60) % 24; return `Day ${d} · ${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

// ---------- boot overlay
const boot = $("boot");
let booted = false, firstTick = true;
function updateBoot(p) {
  if (booted || !p) return;
  $("boot-stage").textContent = p.stage || "Starting…";
  $("boot-fill").style.width = `${Math.max(3, (p.pct || 0) * 100)}%`;
  $("boot-pct").textContent = `${Math.round((p.pct || 0) * 100)}%`;
  if (p.ready) {
    booted = true; $("boot-fill").style.width = "100%";
    if (firstTick) boot.classList.add("fast");
    setTimeout(() => { boot.classList.add("hide"); setTimeout(() => boot.remove(), 900); }, firstTick ? 50 : 350);
  }
}

// ---------- tabs
const sections = { live: $("tab-live"), explain: $("tab-explain"), report: $("tab-report"), audit: $("tab-audit"), spec: $("tab-spec") };
const tabBtns = [...document.querySelectorAll("#tabs button")];
tabBtns.forEach((b) => b.addEventListener("click", () => store.setTab(b.dataset.tab)));
let mill;
store.on("tab", (name) => {
  tabBtns.forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
  Object.entries(sections).forEach(([k, el]) => el.classList.toggle("active", k === name));
  if (name === "live") requestAnimationFrame(() => mill?.resize());
});
window.addEventListener("resize", () => mill?.resize());

// ---------- top bar: link + AI chips
store.on("conn", (ok) => {
  const c = $("chip-link"); c.classList.toggle("lost", !ok);
  if (!ok) $("link-txt").textContent = "Link lost";
  else updateLink();
});
function updateLink() {
  if (!store.connected) return;
  const s = store.tick?.speed || 1; $("link-txt").textContent = `Live · ${s > 1 ? `×${s}` : "1 Hz"}`;
}
function updateAI(ai) {
  const chip = $("chip-ai"); const lv = ai.level || 1;
  chip.className = `badge l${lv}`;
  const names = ai.names || {}, reasons = ai.reasons || {};
  const recov = Math.max(0, ...Object.values(ai.recover || { x: 0 }));
  let txt = `${{ 1: "ML model", 2: "Health Engine", 3: "LLM-estimated" }[lv]}`;
  if (lv > 1 && ai.mode === "auto" && recov > 0) txt += ` · recovering ${recov}/10`;
  $("ai-txt").textContent = txt;
  chip.title = Object.keys(names).map((k) => `${k}: ${names[k]}${reasons[k] ? ` — ${reasons[k]}` : ""}`).join("\n");
  $("ai-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === ai.mode));
  $("btn-outage").classList.toggle("on", !!ai.outage); $("btn-outage").textContent = ai.outage ? "Outage active" : "Simulate outage";
}

// ---------- controls
$("ai-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) act("/api/admin/fallback", { level: b.dataset.m }); });
$("btn-outage").addEventListener("click", () => act("/api/admin/fallback", { level: "outage", ticks: 30 }));
$("btn-reset").addEventListener("click", () => act("/api/reset", {}));
$("speed").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) act("/api/speed", { speed: +b.dataset.s }); });
$("btn-inject").addEventListener("click", () => act("/api/inject", { scenario: $("scn-select").value }));
$("btn-sound").addEventListener("click", () => { const on = sound.toggle(); $("btn-sound").classList.toggle("on", on); $("btn-sound").title = on ? "Sound on" : "Sound off"; });
$("btn-demo").addEventListener("click", () => (director.running ? director.stop() : director.start()));
$("btn-present").addEventListener("click", () => togglePresentation());
const syncDemo = () => { const b = $("btn-demo"); b.classList.toggle("running", !!director.running); b.querySelector("span").textContent = director.running ? "Stop demo" : "Run demo"; };
store.on("caption", syncDemo);
setInterval(syncDemo, 800);
store.on("present", (on) => { document.body.classList.toggle("presenting", !!on); setTimeout(() => mill?.resize(), 50); });

// ---------- hello: scenarios, grades, impact tooltips
store.on("hello", (h) => {
  const sel = $("scn-select"), keep = sel.value;
  sel.innerHTML = Object.entries(h.scenarios || {}).map(([id, s]) => `<option value="${esc(id)}" title="${esc(s.blurb)}">${esc(id)} · ${esc(s.title)}</option>`).join("");
  if (keep) sel.value = keep;
  $("op-grade").innerHTML = (h.grades || []).map((g, i) => `<option value="${i}">${esc(g)}</option>`).join("");
  buildImpact(h.assumptions || {});
  updateBoot(h.progress);
});

// ---------- hero
const thr = $("op-thr"); let dragging = false;
thr.addEventListener("input", () => { dragging = true; $("op-thr-v").textContent = `${thr.value}%`; });
thr.addEventListener("change", () => { dragging = false; act("/api/control", { throughput: +thr.value / 100 }); });
$("op-grade").addEventListener("change", (e) => act("/api/control", { grade: +e.target.value }));
$("btn-restart").addEventListener("click", () => act("/api/action", { action: "restart" }));
$("btn-repair").addEventListener("click", () => act("/api/reset", {}));

function updateHero(f) {
  const st = $("hs-state"); const key = (f.state || "").replace(/[^A-Z]/g, "");
  st.className = `state-pill ${key}`; st.textContent = { RUNNING: "Running", MAINTENANCE: "Maintenance", ESTOP: "E-stop", TRIPPED: "Tripped" }[f.state] || f.state;
  $("hs-reason").textContent = f.stop_reason || "";
  tween($("hs-u"), (f.u || 0) * 100, (v) => `${v.toFixed(0)}%`, 400);
  $("hs-grade").textContent = f.grade_name || "—";
  tween($("hs-tons"), f.produced_t || 0, (v) => `${Math.round(v).toLocaleString("en-IN")} t`, 500);
  $("hs-clock").textContent = clock(f.t);
  if (!dragging && document.activeElement !== thr) { thr.value = Math.round((f.u_set ?? 0.95) * 100); $("op-thr-v").textContent = `${thr.value}%`; }
  const g = $("op-grade"); if (document.activeElement !== g && g.value !== String(f.grade)) g.value = String(f.grade);
  const stopped = key === "ESTOP" || key === "MAINTENANCE";
  $("btn-restart").hidden = !stopped; $("btn-repair").hidden = key !== "TRIPPED";
}

// ---------- asset cards (built once, updated in place)
const cards = {};
function buildCards() {
  const wrap = $("cards"); if (wrap.children.length) return;
  ASSET_ORDER.forEach((a) => {
    const el = document.createElement("div"); el.className = "card"; el.dataset.a = a; el.tabIndex = 0; el.setAttribute("role", "button");
    el.style.setProperty("--ac", ASSET_COLOR[a]);
    el.innerHTML = `<div class="c-head"><span class="c-id">${a}</span><span class="c-name"></span><span class="c-alert">Alert</span></div>
      <div class="c-risk"><div class="c-p num">0%</div>
        <svg class="c-spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points=""/></svg></div>
      <div class="c-foot"><span class="c-ttf num">—</span><span class="c-prov"></span></div>
      <div class="c-fail">Failed</div>`;
    el.addEventListener("click", () => store.select(a));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); store.select(a); } });
    wrap.appendChild(el);
    cards[a] = { el, p: el.querySelector(".c-p"), poly: el.querySelector("polyline"), ttf: el.querySelector(".c-ttf"), prov: el.querySelector(".c-prov"), name: el.querySelector(".c-name"), bkey: "" };
  });
}
function updateCards(t) {
  buildCards();
  ASSET_ORDER.forEach((a) => {
    const c = cards[a], r = t.risks?.[a], fa = t.frame?.assets?.[a]; if (!r) return;
    const col = riskColor(r.p);
    c.name.textContent = fa?.name || store.hello?.assets?.[a]?.name || "";
    tween(c.p, r.p * 100, (v) => `${Math.round(v)}%`); c.p.style.color = col;
    const s = r.spark || [], n = s.length;
    if (n > 1) c.poly.setAttribute("points", s.map((v, i) => `${(i * 100 / (n - 1)).toFixed(1)},${(29 - Math.min(1, v) * 27).toFixed(1)}`).join(" "));
    c.poly.setAttribute("stroke", col);
    c.ttf.textContent = r.ttf == null ? "TTF —" : r.ttf >= 119.5 ? "TTF 120+ min" : `TTF ~${Math.round(r.ttf)} min`;
    const bk = `${r.level}|${r.stale}`;
    if (bk !== c.bkey) { c.bkey = bk; const L = { 1: ["ML", "--ml"], 2: ["Engine", "--engine"], 3: ["LLM", "--llm"] }[r.level] || ["?", "--text-3"];
      c.prov.style.color = r.stale ? "var(--text-3)" : `var(${L[1]})`; c.prov.innerHTML = `<i></i>${L[0]}${r.stale ? " · stale" : ""}`; }
    c.el.classList.toggle("alert", !!t.alerts?.some((x) => x.asset === a));
    c.el.classList.toggle("failed", !!fa?.failed);
  });
}
store.on("select", (a) => {
  Object.entries(cards).forEach(([k, c]) => c.el.classList.toggle("sel", k === a));
  document.body.classList.toggle("drawer-open", !!a);
  setTimeout(() => mill?.resize(), 380);
});

// ---------- impact + KPI panels
const impEls = {}, kpiEls = {};
function buildImpact(as) {
  const items = [
    ["failures_prevented", "Failures prevented", "Alerts acted on early that avoided an unplanned trip."],
    ["avoided_downtime_min", "Downtime avoided", `Unplanned repair = ${as.unplanned_repair_min ?? 240} min vs planned maintenance = ${as.planned_maintenance_min ?? 30} min; difference counted per prevented failure.`],
    ["cost_saved_inr", "Cost saved", `Avoided downtime × ₹${(as.cost_per_min_inr ?? 22000).toLocaleString("en-IN")}/min.`],
    ["tons_protected", "Tons protected", `Avoided downtime × ${as.tons_per_min ?? 10} t/min of output.`],
    ["unplanned_failures", "Unplanned failures", "Assets that failed before maintenance was done."],
  ];
  const g = $("imp-grid"); g.innerHTML = "";
  items.forEach(([k, l, tip]) => {
    const d = document.createElement("div"); d.className = `imp-item${k === "unplanned_failures" ? " sec bad" : ""}`;
    d.innerHTML = `<div class="l">${esc(l)} <i class="info" title="${esc(tip)}">i</i></div><div class="v">0</div>`;
    g.appendChild(d); impEls[k] = d.querySelector(".v");
  });
}
function buildKpis() {
  const g = $("kpi-grid"); if (g.children.length) return;
  [["agreement", "Human–AI agreement"], ["overrides", "Overrides"], ["avg_ttd_s", "Avg time-to-decision"], ["alerts", "Alerts raised"]].forEach(([k, l]) => {
    const d = document.createElement("div"); d.className = "kpi"; d.innerHTML = `<div class="v">—</div><div class="l">${esc(l)}</div>`;
    g.appendChild(d); kpiEls[k] = d.querySelector(".v");
  });
}
buildKpis();
function updateImpact(t) {
  const i = t.impact || {}; if (!impEls.cost_saved_inr) return;
  tween(impEls.failures_prevented, i.failures_prevented, (v) => Math.round(v));
  tween(impEls.avoided_downtime_min, i.avoided_downtime_min, (v) => `${Math.round(v)} min`);
  tween(impEls.cost_saved_inr, i.cost_saved_inr, (v) => inr(v), 900);
  tween(impEls.tons_protected, i.tons_protected, (v) => `${Math.round(v).toLocaleString("en-IN")} t`);
  tween(impEls.unplanned_failures, i.unplanned_failures, (v) => Math.round(v));
  const k = t.kpis || {};
  if (k.agreement == null) { kpiEls.agreement.textContent = "—"; kpiEls.agreement._t = null; } else tween(kpiEls.agreement, k.agreement * 100, (v) => `${Math.round(v)}%`);
  tween(kpiEls.overrides, k.overrides, (v) => Math.round(v));
  if (k.avg_ttd_s == null) { kpiEls.avg_ttd_s.textContent = "—"; kpiEls.avg_ttd_s._t = null; } else tween(kpiEls.avg_ttd_s, k.avg_ttd_s, (v) => `${v.toFixed(1)} s`);
  tween(kpiEls.alerts, k.alerts, (v) => Math.round(v));
}

// ---------- event feed + toasts
const feed = $("feed");
feed.innerHTML = `<li class="empty">No events yet</li>`;
function addFeed(e) {
  feed.querySelector(".empty")?.remove();
  const li = document.createElement("li"); li.className = `k-${e.kind}`;
  li.innerHTML = `<span class="tm">${esc(clock(store.tick?.frame?.t).replace("Day ", "D").replace(" · ", " "))}</span><i class="dt"></i><span>${esc(e.text)}</span>`;
  feed.prepend(li); while (feed.children.length > 30) feed.lastChild.remove();
}
const toasts = $("toasts");
function toast(e) {
  const kind = ICONS[e.kind] ? e.kind : "info";
  const el = document.createElement("div"); el.className = `toast k-${kind} ${kind === "emergency" ? "emergency" : ""}`;
  el.innerHTML = `<b>${esc(LABEL[kind])}</b>${esc(e.text)}`;
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 320); };
  el.addEventListener("click", () => { if (e.kind === "alert" && e.asset) store.select(e.asset); kill(); });
  toasts.appendChild(el);
  while (toasts.children.length > 3) toasts.firstChild.remove();
  setTimeout(kill, kind === "emergency" ? 20000 : 5000); // emergencies linger longer; the drawer banner stays until a decision
}
store.on("event", (e) => {
  addFeed(e); toast(e);
  if (e.kind === "alert" && e.asset && (store.selected == null || !store.openAlert(store.selected))) store.select(e.asset);
});

// ---------- tick
store.on("tick", (t) => {
  updateBoot(t.progress); firstTick = false;
  if (t.frame) updateHero(t.frame);
  updateCards(t); updateImpact(t);
  if (t.ai) updateAI(t.ai);
  updateLink();
  document.querySelectorAll("#speed button").forEach((b) => b.classList.toggle("on", +b.dataset.s === (t.speed || 1)));
});

// ---------- init
mill = createMill($("mill"));
mountTabs({ explain: sections.explain, report: sections.report, audit: sections.audit, spec: sections.spec });
mountDrawer($("drawer"));
sound.init();
buildCards();
connect();

// keep fixed overlays (drawer, toasts) below the top bar, whose height changes with wrapping / presenting mode
new ResizeObserver(([e]) => document.documentElement.style.setProperty("--topbar-h", `${Math.ceil(e.target.getBoundingClientRect().height)}px`))
  .observe(document.getElementById("topbar"));
