// Explain / Model Report / Audit Log / Twin Spec tabs. Rendered lazily on first show.
import { store, esc, pct, num, LEVEL, ASSET_ORDER } from "./store.js";

const COL = { F1: "var(--F1)", R1: "var(--R1)", R2: "var(--R2)", CB: "var(--CB)", CL: "var(--CL)" };
const hdr = (t, s) => `<h2>${t}</h2><div class="sub">${s}</div>`;
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const NS = "http://www.w3.org/2000/svg";
const getJSON = async (url) => { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } };
const empty = (t, s) => `<div class="tb"><div class="panel pn empty"><b>${esc(t)}</b>${esc(s)}</div></div>`;
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));
const iqr = (a) => (a ? ` <span class="dim">(${num(a[0], 0)}–${num(a[1], 0)})</span>` : "");

// ---------------------------------------------------------------- Explain
async function mountExplain(el) {
  const d = await getJSON("/api/explain/global");
  if (!d?.available) { el.innerHTML = empty("Global SHAP appears once the LightGBM models are trained", "Train the Level-1 models and reload — until then the Health Engine (Level 2) drives risk."); return; }
  const ids = ASSET_ORDER.filter((a) => d.assets[a]);
  let cur = ids[0];
  el.innerHTML = `<div class="tb">${hdr("Explain", "Global feature importance of the Level-1 LightGBM failure-risk model, SHAP over held-out runs.")}
    <div class="seg pills"></div><div class="grid2"><div class="panel pn"><div class="panel-title">Mean |SHAP| · top 15</div><div class="bars"></div></div>
    <div class="panel pn bsw"><div class="panel-title">Beeswarm · top 10 features</div><div class="sw"></div><div class="legend">low<i></i>high feature value</div><div class="tip"></div></div></div>
    <div class="panel pn how" style="margin:16px 0 0"><div class="panel-title">How to read</div>
    <p><b>Each dot is one held-out minute.</b> A dot to the <b>right of zero</b> pushes the failure-risk up; to the left pushes it down.</p>
    <p><b>Colour</b> shows whether the feature value was low (blue) or high (red) at that minute, ranked within the feature.</p>
    <p><b>Global</b> means averaged over held-out runs, using a balanced sample of faulty and healthy minutes. Values are log-odds contributions of the LightGBM model, computed with <span class="mono">shap.TreeExplainer</span>.</p>
    <p>Live per-tick SHAP for a single asset is in the <b>Live Twin drawer</b>.</p></div></div>`;
  const pills = el.querySelector(".pills"), bars = el.querySelector(".bars"), sw = el.querySelector(".sw"), tip = el.querySelector(".tip"), box = el.querySelector(".bsw");
  const draw = () => {
    const a = d.assets[cur], c = COL[cur];
    pills.innerHTML = ids.map((i) => `<button class="${i === cur ? "on" : ""}" aria-pressed="${i === cur}" data-a="${i}" style="--c:${COL[i]}"><i></i>${i}</button>`).join("");
    const b = a.bars.slice(0, 15), mx = Math.max(...b.map((x) => x.mean_abs)) || 1;
    bars.innerHTML = b.map((x) => `<div class="xb"><span class="lb" title="${esc(x.label)}">${esc(x.label)}</span><span class="tr"><span class="fl" style="background:${c}" data-w="${(x.mean_abs / mx) * 100}"></span></span><span class="v">${f(x.mean_abs)}</span></div>`).join("");
    requestAnimationFrame(() => requestAnimationFrame(() => bars.querySelectorAll(".fl").forEach((e) => (e.style.width = e.dataset.w + "%"))));
    // beeswarm
    const rows = a.beeswarm.slice(0, 10), W = 760, L = 230, R = 20, RH = 44, H = rows.length * RH + 40;
    const all = rows.flatMap((r) => r.points.map((p) => p[0]));
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all), pad = (hi - lo) * 0.04 || 1;
    const X = (v) => L + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (W - L - R);
    const LO = [37, 99, 168], MD = [201, 206, 214], HI = [194, 65, 12];
    const col = (t) => `rgb(${(t < 0.5 ? mix(LO, MD, t * 2) : mix(MD, HI, (t - 0.5) * 2)).join(",")})`;
    let s = `<svg viewBox="0 0 ${W} ${H}" style="max-width:${W}px;width:100%">`;
    const ticks = 6; for (let i = 0; i <= ticks; i++) { const v = lo - pad + ((hi - lo + 2 * pad) * i) / ticks; s += `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${H - 28}" stroke="#e3e6eb" stroke-width="1"/><text x="${X(v)}" y="${H - 12}" text-anchor="middle">${v.toFixed(1)}</text>`; }
    s += `<line x1="${X(0)}" x2="${X(0)}" y1="8" y2="${H - 28}" stroke="#d0d5dd" stroke-width="1.2"/><text x="${(L + W) / 2}" y="${H - 1}" text-anchor="middle" style="font-size:10px">SHAP value (log-odds)</text>`;
    rows.forEach((r, i) => {
      const cy = 8 + RH * i + RH / 2;
      s += `<text x="${L - 10}" y="${cy + 4}" text-anchor="end">${esc(r.label.length > 34 ? r.label.slice(0, 33) + "…" : r.label)}</text><line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" stroke="#eef0f4" stroke-width="1"/>`;
      r.points.forEach((p, j) => { const jit = (((Math.sin((j + 1) * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1 - 0.5) * (RH - 10); // deterministic jitter
        s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${(cy + jit).toFixed(1)}" r="3" fill="${col(p[1])}" fill-opacity=".8" data-t="${esc(r.label)}|${p[0]}|${p[1]}"/>`; });
    });
    sw.innerHTML = s + "</svg>";
    sw.style.opacity = 0; requestAnimationFrame(() => { sw.style.transition = "opacity .15s"; sw.style.opacity = 1; });
  };
  pills.onclick = (e) => { const a = e.target.closest("[data-a]")?.dataset.a; if (a) { cur = a; draw(); } };
  sw.onmousemove = (e) => {
    const t = e.target.dataset?.t; if (!t) { tip.style.opacity = 0; return; }
    const [l, v, r] = t.split("|"), bb = box.getBoundingClientRect();
    tip.innerHTML = `<b>${l}</b><br>SHAP ${Number(v).toFixed(3)} · value rank ${(r * 100).toFixed(0)}%`;
    tip.style.left = Math.min(e.clientX - bb.left + 12, bb.width - 230) + "px"; tip.style.top = e.clientY - bb.top + 14 + "px"; tip.style.opacity = 1;
  };
  sw.onmouseleave = () => (tip.style.opacity = 0);
  draw();
}

// ---------------------------------------------------------------- Model report
async function mountReport(el) {
  const d = await getJSON("/api/report");
  if (!d?.available) { el.innerHTML = empty("Model report not available yet", "It appears once the LightGBM models have been trained and evaluated on held-out runs."); return; }
  const r = d.results, A = ASSET_ORDER.filter((a) => r.assets[a]), as = A.map((a) => r.assets[a]);
  const mean = (k) => as.reduce((s, x) => s + (x.ml[k] || 0), 0) / as.length;
  const med = (g) => { const v = as.map((x) => x[g].median_lead).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const det = as.reduce((s, x) => s + x.ml.detected, 0), fl = as.reduce((s, x) => s + x.ml.failures, 0);
  const kpi = (k, b, s) => `<div class="panel kpi"><div class="k">${k}</div><div class="big">${b}</div><div class="s">${s}</div></div>`;
  const row = (a) => { const x = r.assets[a], m = x.ml; return `<tr><td><b style="color:${COL[a]}">${a}</b> <span class="dim">${esc(x.name)}</span></td><td class="num">${f(m.roc_auc, 4)}${m.roc_auc >= 0.9 ? '<span class="ok-chip">✓ ≥0.90</span>' : ""}</td><td class="num">${f(m.pr_auc, 4)}</td><td class="num">${f(m.precision, 2)} / ${f(m.recall, 2)} / ${f(m.f1, 2)}</td><td class="num">${f(m.brier, 4)}</td><td class="num">${num(m.rul_mae, 2)}</td><td class="num">${pct(m.detection_rate)} <span class="dim">${m.detected}/${m.failures}</span></td><td class="num">${num(m.median_lead, 1)}${iqr(m.lead_iqr)}</td><td class="num">${num(m.false_alarms_per_1000, 2)}</td></tr>`; };
  const pb = (lbl, v, max, c) => `<div class="pb"><span>${lbl}</span><span class="t"><span class="f" style="background:${c}" data-w="${max ? (v / max) * 100 : 0}"></span></span><span class="n">${num(v, 1)}</span></div>`;
  const card = (a) => { const x = r.assets[a], m = x.ml, s = x.static, mxL = Math.max(m.median_lead || 0, s.median_lead || 0, 1), mxF = Math.max(m.false_alarms_per_1000 || 0, s.false_alarms_per_1000 || 0, 0.001);
    const lim = Object.entries(x.limits || {}).map(([t, [dir, v]]) => `${esc(t)} ${dir === "hi" ? ">" : "<"} ${esc(v)}`).join("<br>");
    return `<div class="card"><h4 style="color:${COL[a]}">${a} · ${esc(x.name)}</h4>
      <div class="m">Median lead time (min)</div>${pb("LightGBM", m.median_lead || 0, mxL, "var(--accent)")}${pb("Static", s.median_lead || 0, mxL, "var(--text-3)")}
      <div class="m">Detection rate (%)</div>${pb("LightGBM", m.detection_rate * 100, 100, "var(--accent)")}${pb("Static", s.detection_rate * 100, 100, "var(--text-3)")}
      <div class="m">False alarms / 1000 healthy min</div>${pb("LightGBM", m.false_alarms_per_1000 || 0, mxF, "var(--accent)")}${pb("Static", s.false_alarms_per_1000 || 0, mxF, "var(--text-3)")}
      <div class="lim"><b>Static limits:</b><br>${lim}</div></div>`; };
  const c = r.model_card || {}, sp = c.split || {};
  const dl = (k, v) => (v == null || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`);
  el.innerHTML = `<div class="tb">${hdr("Model report", `Evaluated on held-out runs only (${esc(r.test_runs)} test runs), threshold ${esc(r.threshold)}.`)}
  <div class="kpis">${kpi("Mean ROC-AUC", f(mean("roc_auc"), 4), "across " + as.length + " assets")}${kpi("Mean PR-AUC", f(mean("pr_auc"), 4), "failure-class precision/recall")}
  ${kpi("Failures detected", `${det}/${fl}`, "held-out runs, LightGBM")}${kpi("Median lead time", `${num(med("ml"), 1)} <span style="font-size:13px;color:var(--text-3)">vs ${num(med("static"), 1)}</span>`, "min · ML vs static limits (median of asset medians)")}</div>
  <div class="panel pn"><div class="panel-title">Per-asset metrics</div><div class="scroll"><table><thead><tr><th>Asset</th><th>ROC-AUC</th><th>PR-AUC</th><th>Prec / Rec / F1 @${esc(r.threshold)}</th><th>Brier</th><th>RUL MAE</th><th>Detection</th><th>Median lead (IQR)</th><th>False alarms /1000</th></tr></thead><tbody>${A.map(row).join("")}</tbody></table></div></div>
  <div class="panel pn"><div class="panel-title">LightGBM vs static-limit alarms</div><div class="cmp">${A.map(card).join("")}</div></div>
  <div class="panel pn"><div class="panel-title">Figures</div><div class="figs">${(d.figures || []).map((u) => `<figure><img src="${esc(u)}" alt="${esc(u.split("/").pop())}" loading="lazy"><figcaption>${esc(u.split("/").pop().replace(/\.\w+$/, "").replace(/[_-]+/g, " "))}</figcaption></figure>`).join("")}</div></div>
  <div class="panel pn"><div class="panel-title">Model card</div><dl class="dl">
  ${dl("Created", esc(c.created))}${dl("Rows", c.rows?.toLocaleString())}${dl("Simulated runs", esc(c.n_runs))}${dl("Split (train / val / test runs)", sp.train != null ? `${sp.train} / ${sp.val} / ${sp.test}` : "")}${dl("Seed", esc(c.seed))}${dl("Data hash", `<span class="mono">${esc(c.data_hash)}</span>`)}
  ${dl("Prediction horizon", c.horizon != null ? c.horizon + " min" : "")}${dl("RUL cap", c.rul_cap != null ? c.rul_cap + " min" : "")}${dl("Training time", c.train_seconds != null ? c.train_seconds + " s" : "")}
  ${dl("Features", "raw, twin residual, rolling mean/std (10), slope (20), grade, throughput, upstream slab-temp residual")}${dl("Models", "LGBMClassifier, LGBMRegressor, IsolationForest (healthy-only), IsolationForest (full-coverage)")}${dl("Evaluation", "held-out runs only, split by run_id")}</dl></div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".pb .f").forEach((e) => (e.style.width = e.dataset.w + "%"))));
  el.querySelector(".figs").onclick = (e) => { if (e.target.tagName !== "IMG") return; const lb = document.createElement("div"); lb.className = "lightbox"; lb.innerHTML = `<img src="${esc(e.target.src)}">`; lb.onclick = () => lb.remove(); document.body.append(lb); };
}

// ---------------------------------------------------------------- Audit
function mountAudit(el) {
  el.innerHTML = `<div class="tb">${hdr("Audit log", "Append-only SQLite; UPDATE/DELETE blocked by triggers.")}
  <div class="fbar"><select id="au-actor"><option value="">All actors</option><option>AI</option><option>HUMAN</option><option>TWIN</option></select>
  <select id="au-asset"><option value="">All assets</option>${ASSET_ORDER.map((a) => `<option>${a}</option>`).join("")}</select>
  <input id="au-q" type="search" placeholder="Search events…"><a class="btn" href="/api/audit/export.csv" download>Export CSV</a></div>
  <div class="panel pn" style="padding:0;overflow:hidden"><div class="scroll"><table><thead><tr><th>Time</th><th>Tick</th><th>Actor</th><th>Event</th><th>Asset</th><th>Provenance</th></tr></thead><tbody></tbody></table></div></div></div>`;
  const tb = el.querySelector("tbody"), $ = (i) => el.querySelector(i);
  let seen = null, open = new Set(), timer, rows = [];
  const render = () => {
    tb.innerHTML = rows.map((e) => {
      const L = LEVEL[e.level], t = new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false });
      return `<tr class="ar ${e._new ? "newrow" : ""}" data-id="${e.id}"><td class="num">${t}</td><td class="num">${esc(e.tick)}</td><td><span class="actor ${esc(e.actor)}">${esc(e.actor)}</span></td><td>${esc(e.event)}</td><td>${e.asset ? `<b style="color:${COL[e.asset] || "inherit"}">${esc(e.asset)}</b>` : "—"}</td><td>${L ? `<span class="badge ${L.cls}">${esc(L.short)}</span>` : '<span class="dim">—</span>'}</td></tr>` +
        (open.has(e.id) ? `<tr><td colspan="6"><pre class="pl">${esc(JSON.stringify(e.payload, null, 2))}</pre></td></tr>` : "");
    }).join("") || `<tr><td colspan="6" class="dim">No events.</td></tr>`;
  };
  const load = async () => {
    const p = new URLSearchParams({ actor: $("#au-actor").value, asset: $("#au-asset").value, q: $("#au-q").value, limit: 200 });
    const d = await getJSON("/api/audit?" + p); if (!d) return;
    rows = d.map((e) => ({ ...e, _new: seen && !seen.has(e.id) }));
    seen = new Set(d.map((e) => e.id)); render();
  };
  const reset = () => { seen = null; load(); };
  ["#au-actor", "#au-asset"].forEach((i) => ($(i).onchange = reset));
  let deb; $("#au-q").oninput = () => { clearTimeout(deb); deb = setTimeout(reset, 300); };
  tb.onclick = (e) => { const id = +e.target.closest("tr.ar")?.dataset.id; if (!id) return; open.has(id) ? open.delete(id) : open.add(id); rows.forEach((x) => (x._new = false)); render(); };
  el._start = () => { load(); clearInterval(timer); timer = setInterval(load, 3000); };
  el._stop = () => clearInterval(timer);
  el._start();
}

// ---------------------------------------------------------------- Twin spec
const box = (x, y, w, h, t, s, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#fff" stroke="#d0d5dd" stroke-width="1"/>${c ? `<rect x="${x + 12}" y="${y}" width="${w - 24}" height="3" rx="1.5" fill="${c}"/>` : ""}<text x="${x + w / 2}" y="${y + h / 2 - (s ? 3 : -4)}" text-anchor="middle">${t}</text>${s ? `<text class="s" x="${x + w / 2}" y="${y + h / 2 + 14}" text-anchor="middle">${s}</text>` : ""}`;
function archSvg() {
  const w = 170, g = 40, X = (i) => 20 + i * (w + g), y1 = 30, y2 = 170, h = 70, ar = (x1, y1_, x2, y2_, dash) => `<line x1="${x1}" y1="${y1_}" x2="${x2}" y2="${y2_}" stroke="#3f5bd8" stroke-width="1.3" marker-end="url(#ah)" ${dash ? 'stroke-dasharray="5 4" opacity=".6"' : ""}/>`;
  let s = `<svg viewBox="0 0 1050 330"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#3f5bd8"/></marker></defs>`;
  s += box(X(0), y1, w, h, "Twin (physics)", "simulated plant, 1 Hz", null) + box(X(1), y1, w, h, "Features", "residuals · rolling · slope", null) +
    box(X(2), y1, w, h, "Level 1 · ML", "LightGBM risk + RUL + IsoForest + SHAP", "#1f8a5b") + box(X(3), y1, w, h, "Level 2 · Health Engine", "EMA z-scores, weighted", "#b7791f") + box(X(4), y1, w, h, "Level 3 · LLM API", "estimated risk", "#6d4fc2");
  s += box(X(4), y2, w, h, "Fallback router", "picks first healthy level", "#b7791f") + box(X(3), y2, w, h, "WebSocket", "/ws/stream", null) + box(X(2), y2, w, h, "Dashboard", "risk · SHAP · alerts", null) +
    box(X(1), y2, w, h, "Human decision", "HITL approve / reject", null) + box(X(0), y2, w, h, "Twin actions", "derate · maintain · stop", null);
  for (let i = 0; i < 4; i++) s += ar(X(i) + w, y1 + h / 2, X(i + 1) - 2, y1 + h / 2);
  s += ar(X(4) + w / 2, y1 + h, X(4) + w / 2, y2 - 2);
  for (let i = 4; i > 0; i--) s += ar(X(i), y2 + h / 2, X(i - 1) + w + 2, y2 + h / 2);
  s += ar(X(0) + w / 2, y2, X(0) + w / 2, y1 + h + 2);
  s += box(X(1) + 20, 275, 3 * w + 2 * g - 40, 42, "Audit log", "append-only · every AI, HUMAN and TWIN event", null);
  s += ar(X(1) + w / 2, y2 + h, X(1) + w / 2, 274, true) + ar(X(4) + w / 2, y2 + h, X(4) + w / 2, 296, true).replace(`x2="${X(4) + w / 2}"`, `x2="${X(1) + 3 * w + 2 * g - 20 + 2 - 0}"`);
  return s + "</svg>";
}
async function mountSpec(el) {
  const d = await getJSON("/api/spec");
  if (!d) { el.innerHTML = empty("Twin spec unavailable", "The backend did not return /api/spec."); return; }
  const tagRows = ASSET_ORDER.filter((a) => d.assets[a]).flatMap((a) => d.assets[a].tags.map((t, i) => { const g = d.tags[`${a}.${t}`] || {}; return `<tr><td>${i ? "" : `<b style="color:${COL[a]}">${a}</b> <span class="dim">${esc(d.assets[a].name)}</span>`}</td><td class="mono">${esc(t)}</td><td>${esc(g.label)}</td><td>${esc(g.unit)}</td><td class="num">${esc(g.sigma)}</td><td class="num">${g.limit ? (g.limit[0] === "hi" ? "&gt; " : "&lt; ") + esc(g.limit[1]) : "—"}</td></tr>`; }));
  const faults = ASSET_ORDER.filter((a) => d.faults[a]).map((a) => { const x = d.faults[a];
    return `<div class="fcard" style="--c:${COL[a]}"><h4><span style="color:${COL[a]}">${a}</span> · ${esc(x.name)}</h4><div class="sg">${Object.entries(x.sig).map(([t, v]) => `<span class="${v > 0 ? "up" : "dn"}">${esc(t)} ${v > 0 ? "↑" : "↓"} ${Math.abs(v)}</span>`).join("")}</div><p>${esc(x.story)}</p><p><b>Recommended:</b> ${esc(d.actions[x.action]?.label || x.action)}</p></div>`; }).join("");
  const acts = Object.entries(d.actions).map(([k, a]) => `<tr><td><b>${esc(a.label)}</b><div class="mono dim">${esc(k)}</div></td><td>${esc(a.desc)}</td><td>${a.param ? esc(a.param) : "—"}</td><td>${ASSET_ORDER.filter((x) => d.allowed[x]?.includes(k)).join(", ")}</td></tr>`).join("");
  const scen = Object.entries(d.scenarios).map(([k, s]) => `<div class="fcard"><h4>${esc(k)} · ${esc(s.title)}</h4><p><span class="chip">${esc(s.asset)}</span> <span class="chip">${esc(s.kind)}</span></p><p>${esc(s.blurb)}</p></div>`).join("");
  const wts = ASSET_ORDER.filter((a) => d.engine?.weights?.[a]).flatMap((a) => Object.entries(d.engine.weights[a]).map(([t, w], i) => `<tr><td>${i ? "" : `<b style="color:${COL[a]}">${a}</b>`}</td><td class="mono">${esc(t)}</td><td class="num">${w}</td></tr>`));
  const lv = (c, b, t, dsc) => `<div class="lv ${c}"><span class="badge ${b}">${esc(t)}</span><div class="d">${dsc}</div></div>`;
  el.innerHTML = `<div class="tb">${hdr("Twin spec", "Architecture, fallback chain, tags, equations and fault catalog of the simulated plant.")}<div class="hero">${esc(d.disclaimer)}<small>${esc(d.time)}</small></div>
  <div class="panel pn arch"><div class="panel-title">Architecture</div>${archSvg()}</div>
  <div class="panel pn"><div class="panel-title">Fallback chain</div><div class="fb"><div>${lv("a", "l1", LEVEL[1].name, "LightGBM risk + RUL, IsolationForest anomaly, SHAP contributions.")}${lv("b", "l2", LEVEL[2].name, "Physics-residual health engine, always available.")}${lv("c", "l3", LEVEL[3].name, "LLM-estimated risk when both local levels are unavailable.")}</div>
  <div><div class="panel-title" style="margin-bottom:8px">Triggers to fall back</div><ul class="trig"><li>Model files <b>missing or corrupt</b></li><li>Load or <b>inference exception</b></li><li>Latency <b>&gt; 150 ms × 3 ticks</b></li><li><b>NaN features</b> / sensor dropout</li><li><b>Manual override</b></li></ul><p style="color:var(--ok);font-weight:500">Auto-recover after 10 healthy ticks.</p></div></div></div>
  <div class="panel pn"><div class="panel-title">Tags</div><div class="scroll"><table><thead><tr><th>Asset</th><th>Tag</th><th>Label</th><th>Unit</th><th>Noise σ</th><th>Static limit</th></tr></thead><tbody>${tagRows.join("")}</tbody></table></div></div>
  <div class="panel pn"><div class="panel-title">Equations</div><pre class="eq">${(d.equations || []).map(esc).join("\n\n")}</pre></div>
  <div class="panel pn"><div class="panel-title">Fault catalog</div><div class="cards">${faults}</div></div>
  <div class="panel pn"><div class="panel-title">Actions</div><div class="scroll"><table><thead><tr><th>Action</th><th>Effect</th><th>Param</th><th>Allowed on</th></tr></thead><tbody>${acts}</tbody></table></div></div>
  <div class="panel pn"><div class="panel-title">Scenarios</div><div class="sc">${scen}</div></div>
  <div class="panel pn"><div class="panel-title">Health Engine weights</div><div class="scroll"><table><thead><tr><th>Asset</th><th>Tag</th><th>Weight</th></tr></thead><tbody>${wts.join("")}</tbody></table></div></div></div>`;
}

// ---------------------------------------------------------------- mount
export function mountTabs({ explain, report, audit, spec }) {
  const tabs = { explain: [explain, mountExplain], report: [report, mountReport], audit: [audit, mountAudit], spec: [spec, mountSpec] };
  const done = {};
  const show = (name) => {
    for (const [n, [el]] of Object.entries(tabs)) if (n !== name) el?._stop?.();
    const t = tabs[name]; if (!t || !t[0]) return;
    if (!done[name]) { done[name] = true; t[1](t[0]); } else t[0]._start?.();
  };
  store.on("tab", show);
  show(store.tab);
}
