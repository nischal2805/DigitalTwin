// Asset drawer: risk gauge, explanations, trust, what-if, council, human decision. Built once per selection, updated in place per tick.
import { store, api, badge, LEVEL, ASSET_COLOR, riskColor, riskLevel, pct, num, esc } from "./store.js";
import { gaugeSVG, gaugeUpdate, lineChart, sparkline } from "./charts.js";

const CAPTION = { 1: "IsolationForest (healthy-only)", 2: "max factor deviation", 3: "LLM-estimated" };
const ttfTxt = (v) => (v == null ? "—" : v >= 119 ? "120+" : num(v, 0));
const WARN = '<svg class="dr-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3.5M8 12v.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function mountDrawer(el) {
  let a = null, refs = {}, whatifTimer = null, refreshTimer = null, reqId = 0;
  const councils = {}, ctl = {}, cache = new WeakMap();
  const $ = (k) => refs[k];
  const setHTML = (node, html) => { if (node && cache.get(node) !== html) { node.innerHTML = html; cache.set(node, html); } };
  const setTxt = (node, t) => { if (node && node.textContent !== String(t)) node.textContent = t; };
  const hello = () => store.hello || { actions: {}, allowed: {}, reason_codes: {} };
  const lbl = (x) => hello().actions[x]?.label || x;
  const controls = () => (ctl[a] ||= { action: hello().allowed?.[a]?.includes("derate") ? "derate" : "none", derate: 30, thr: 100 });

  // ------------------------------------------------------------------ skeleton
  function build() {
    const h = hello(), allowed = h.allowed?.[a] || [], c = controls();
    const actOpts = (extra) => `${extra}${allowed.map((x) => `<option value="${esc(x)}">${esc(lbl(x))}</option>`).join("")}`;
    el.innerHTML = `
    <div class="dr-scroll">
      <header class="dr-head">
        <div class="dr-title"><div class="dr-name" data-k="name"></div>
          <div class="dr-health">Twin health <span class="mono" data-k="htxt"></span> (ground truth)</div></div>
        <span class="dr-chip"><i style="background:${ASSET_COLOR[a] || "var(--text-3)"}"></i>${esc(a)}</span>
        <button class="btn ghost dr-x" data-k="close" aria-label="Close drawer" title="Close (Esc)"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </header>
      <div data-k="alert"></div>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">Failure risk</span><span data-k="b-risk"></span></div>
        <div class="dr-gauge" data-k="gauge">${gaugeSVG()}</div>
        <div class="dr-level" data-k="lvl"></div>
        <div class="dr-ttf"><span data-k="ttf"></span><small data-k="ttfm"></small></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">Anomaly</span><span data-k="b-anom"></span></div>
        <div class="dr-meter"><i data-k="abar"></i></div>
        <div class="dr-cap"><span data-k="acap"></span><span class="mono" data-k="anum"></span></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title" data-k="ctitle">Contribution</span><span data-k="b-expl"></span></div>
        <div data-k="contribs"></div><div class="dr-foot" data-k="cfoot"></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">Diagnosis</span></div><div class="dr-call" data-k="diag"></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">Trust meter</span></div>
        <div data-k="review"></div>
        <div class="dr-trust"><svg viewBox="0 0 64 64" class="dr-ring" aria-hidden="true"><circle cx="32" cy="32" r="26" class="rt"/><circle cx="32" cy="32" r="26" class="rv" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 32 32)"/></svg>
          <b class="mono dr-ring-n" data-k="tval"></b>
          <div class="dr-tbars">
            <div><div class="dr-trow"><span>Agreement</span><span class="mono" data-k="agn"></span></div><span class="dr-bar"><i data-k="agb"></i></span><small data-k="ags"></small></div>
            <div><div class="dr-trow"><span>In-distribution</span><span class="mono" data-k="idn"></span></div><span class="dr-bar"><i data-k="idb"></i></span><small data-k="ids"></small></div>
          </div></div><small class="dr-muted" data-k="tcause"></small></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">What-if</span></div>
        <div class="dr-ctl">
          <label class="full"><span>Action</span><select data-k="w-act" aria-label="What-if action">${actOpts('<option value="">None (baseline)</option>')}</select></label>
          <label><span>Derate <b class="mono" data-k="w-dv"></b></span><input type="range" min="0" max="60" step="1" data-k="w-der" aria-label="Derate percent"></label>
          <label><span>Throughput <b class="mono" data-k="w-tv"></b></span><input type="range" min="50" max="115" step="1" data-k="w-thr" aria-label="Throughput percent"></label>
        </div>
        <div class="dr-head2" data-k="w-head">Simulating…</div>
        <div class="dr-chart" data-k="w-chart"></div>
        <div class="dr-leg"><span><i class="dash"></i>baseline</span><span><i style="background:var(--accent)"></i>scenario</span><span><i class="dot"></i>threshold</span></div>
        <div class="dr-foot" data-k="w-src"></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">AI council</span></div>
        <button class="btn dr-wide" data-k="c-btn">Convene AI council</button><div data-k="council"></div></section>

      <section class="dr-sec"><div class="dr-h"><span class="panel-title">AI learned</span></div>
        <div class="dr-thr"><div data-k="thr-spark"></div><div class="dr-thr-n"><span class="mono" data-k="thr-val"></span><small>alert threshold</small></div></div>
        <ul class="dr-learned" data-k="learned"></ul></section>
    </div>
    <div class="dr-decide" data-k="decide">
      <div class="dr-drow">
        <button class="btn primary" data-k="d-ap">Approve</button>
        <button class="btn" data-k="d-mo">Modify</button>
        <button class="btn" data-k="d-ov">Override</button>
      </div>
      <div class="dr-dform" data-k="d-mform" hidden>
        <select data-k="d-act" aria-label="Modify action">${actOpts("")}</select>
        <button class="btn" data-k="d-mgo">Apply</button></div>
      <div class="dr-dform" data-k="d-oform" hidden>
        <select data-k="d-rc" aria-label="Override reason code"><option value="">Reason code (required)…</option>${Object.entries(h.reason_codes || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select>
        <input data-k="d-note" type="text" placeholder="Optional note" aria-label="Override note">
        <button class="btn primary" data-k="d-ogo" disabled>Submit override</button></div>
      <div class="dr-dmsg" data-k="d-msg" role="status" aria-live="polite"></div>
    </div>`;
    refs = {};
    el.querySelectorAll("[data-k]").forEach((n) => (refs[n.dataset.k] = n));
    $("gauge").firstElementChild.classList.add("g");
    $("w-act").value = c.action === "none" ? "" : c.action; $("w-der").value = c.derate; $("w-thr").value = c.thr; syncLabels();
    bind(); renderCouncil();
  }

  function syncLabels() { const c = controls(); setTxt($("w-dv"), c.derate + "%"); setTxt($("w-tv"), c.thr + "%"); }

  function bind() {
    $("close").onclick = () => store.select(null);
    const onCtl = () => { const c = controls(); c.action = $("w-act").value || "none"; c.derate = +$("w-der").value; c.thr = +$("w-thr").value; syncLabels(); clearTimeout(whatifTimer); whatifTimer = setTimeout(runWhatif, 400); };
    ["w-act", "w-der", "w-thr"].forEach((k) => ($(k).oninput = onCtl));
    $("c-btn").onclick = runCouncil;
    $("d-ap").onclick = () => decide({ decision: "approve" });
    $("d-mo").onclick = () => { $("d-oform").hidden = true; $("d-mform").hidden = !$("d-mform").hidden; };
    $("d-ov").onclick = () => { $("d-mform").hidden = true; $("d-oform").hidden = !$("d-oform").hidden; };
    $("d-mgo").onclick = () => { const act = $("d-act").value; decide({ decision: "modify", action: act, ...(act === "derate" ? { params: { pct: controls().derate || 30 } } : {}) }); };
    $("d-rc").onchange = () => ($("d-ogo").disabled = !$("d-rc").value || !store.openAlert(a));
    $("d-ogo").onclick = () => decide({ decision: "override", reason_code: $("d-rc").value, note: $("d-note").value || undefined });
  }

  // ------------------------------------------------------------------ what-if
  async function runWhatif() {
    if (!a) return;
    const asset = a, c = controls(), id = ++reqId;
    $("w-head").classList.add("loading");
    try {
      const body = { asset, action: c.action === "none" ? "" : c.action, derate: c.derate, throughput: c.thr / 100 };
      const r = await api("/api/whatif", body);
      if (a !== asset || id !== reqId) return;
      const b = r.baseline, s = r.scenario, th = store.risk(a)?.threshold ?? 0.5, f = (m) => (m == null ? "no failure within 120 min" : `${m} min`);
      setHTML($("w-head"), b.fail_min == null && s.fail_min == null ? "No failure within 120 min — either way"
        : b.fail_min == null ? `Scenario causes failure at <b class="mono warn-t">${s.fail_min} min</b>` : `Failure pushed from <b class="mono">${f(b.fail_min)}</b> to <b class="mono ${s.fail_min == null || s.fail_min > b.fail_min ? "ok-t" : "warn-t"}">${f(s.fail_min)}</b>`);
      setHTML($("w-chart"), lineChart({ horizon: r.horizon, threshold: th, series: [{ y: b.risk, color: "#8a94a6", dash: true }, { y: s.risk, color: "#3f5bd8", glow: true }],
        markers: [{ x: b.fail_min, color: "#8a94a6" }, { x: s.fail_min, color: "#3f5bd8" }] }));
      setHTML($("w-src"), `risk curves from ${esc(r.level_name)} on a forked twin`);
    } catch (e) { setHTML($("w-head"), `<span class="warn-t">What-if failed: ${esc(e.message)}</span>`); }
    finally { if (id === reqId) $("w-head")?.classList.remove("loading"); }
  }

  // ------------------------------------------------------------------ council
  async function runCouncil() {
    if (!a) return;
    const asset = a, btn = $("c-btn");
    btn.disabled = true; btn.textContent = "Council deliberating…"; $("council").innerHTML = '<div class="dr-shim"></div><div class="dr-shim"></div><div class="dr-shim s"></div>';
    try {
      councils[asset] = await api("/api/council", { alert_id: store.openAlert(asset)?.id, asset });
    } catch (e) { councils[asset] = { error: e.message }; }
    if (a === asset) { btn.disabled = false; btn.textContent = "Convene AI council"; renderCouncil(); }
  }
  function renderCouncil() {
    const c = councils[a]; if (!c) return setHTML($("council"), "");
    if (c.error) return setHTML($("council"), `<div class="dr-err">Council failed: ${esc(c.error)}</div>`);
    const wo = c.work_order || {};
    setHTML($("council"), `<p class="dr-sum">${esc(c.summary)}</p>
      <div class="dr-agents">${(c.agents || []).map((g) => `<div class="dr-agent"><div><b>${esc(g.role)}</b><span class="dr-pill">${esc(g.stance)}</span></div><p>${esc(g.text)}</p></div>`).join("")}</div>
      ${c.withheld ? `<div class="dr-review">${WARN}<span>Recommendation withheld — human review required</span></div>`
        : `<div class="dr-rec"><small>Recommendation</small><b>${esc(lbl(c.recommendation?.action))}</b><p>${esc(c.recommendation?.rationale)}</p></div>`}
      <div class="dr-wo"><small>Work order</small><b>${esc(wo.title)}</b><ol>${(wo.steps || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <div class="dr-muted">Parts: ${(wo.parts || []).length ? esc(wo.parts.join(", ")) : "none"} · Est. downtime ${esc(wo.est_downtime_min ?? "—")} min</div></div>
      <div class="dr-foot">Generated by ${esc(c.generated_by)} from the facts above</div>
      <details class="dr-facts"><summary>facts</summary><pre>${esc(JSON.stringify(c.facts, null, 1))}</pre></details>`);
  }

  // ------------------------------------------------------------------ decisions
  async function decide(body) {
    const al = store.openAlert(a); if (!al) return;
    setHTML($("d-msg"), "Sending…");
    try {
      const r = await api("/api/decision", { alert_id: al.id, ...body });
      setHTML($("d-msg"), `<span class="ok-t">${esc(body.decision)} recorded${r.executed ? " — " + esc(r.executed) : ""}</span>`);
      $("d-mform").hidden = $("d-oform").hidden = true;
    } catch (e) { setHTML($("d-msg"), `<span class="warn-t">${esc(e.message)}</span>`); }
  }

  // ------------------------------------------------------------------ per-tick update
  function rowsFor(level, items) {
    const sig = level + ":" + items.length;
    if ($("contribs")._sig !== sig) {
      $("contribs")._sig = sig;
      $("contribs").innerHTML = items.map(() => `<div class="cb-row"><div class="cb-top"><span class="cb-l"></span><span class="cb-v mono"></span></div><div class="cb-track ${level === 1 ? "div" : ""}"><i class="cb-center"></i><b class="cb-bar"></b></div><div class="cb-sub"></div></div>`).join("");
      cache.delete($("contribs"));
    }
    const max = Math.max(1e-9, ...items.map((i) => Math.abs(i.shap || 0)));
    [...$("contribs").children].forEach((row, i) => {
      const c = items[i], bar = row.querySelector(".cb-bar"), q = (s) => row.querySelector(s);
      setTxt(q(".cb-l"), c.label);
      if (level === 1) {
        const w = (Math.abs(c.shap) / max) * 50, up = c.shap >= 0;
        bar.style.width = w + "%"; bar.style.left = (up ? 50 : 50 - w) + "%"; bar.className = "cb-bar " + (up ? "up" : "down");
        setTxt(q(".cb-v"), `${c.shap >= 0 ? "+" : ""}${num(c.shap, 2)}`);
        setTxt(q(".cb-sub"), `${num(c.share_pct, 1)}% · value ${num(c.value, 2)}${c.expected != null ? ` · exp ${num(c.expected, 2)}` : ""}`);
      } else {
        bar.style.left = "0%"; bar.style.width = Math.min(100, c.share_pct || 0) + "%"; bar.className = "cb-bar one l" + level;
        setTxt(q(".cb-v"), `${num(c.share_pct, 1)}%`);
        setTxt(q(".cb-sub"), level === 2 ? `z=${num(c.z, 2)} · w=${num(c.weight, 2)}` : c.reason || "");
      }
    });
  }

  function update() {
    const t = store.tick, r = store.risk(a), fr = t?.frame?.assets?.[a];
    if (!a || !r || !refs.name) return;
    setTxt($("name"), fr?.name || hello().assets?.[a]?.name || a);
    const hl = fr ? fr.health : 1;
    setTxt($("htxt"), pct(hl).replace("%", " %"));

    // alert banners
    const al = store.openAlert(a), emerg = al && r.p >= 0.9;
    setHTML($("alert"), !al ? "" : `<div class="dr-alert ${emerg ? "emerg" : ""} ${al.escalated ? "esc" : ""}">
      ${WARN}<div><b>${emerg ? "Emergency stop recommended — awaiting human" : "Open alert"}${al.escalated ? ' <span class="dr-esc">ESCALATED</span>' : ""}</b>
      <small>Risk at alert ${pct(al.p)} · plant tick ${esc(al.tick)}</small></div>
      ${emerg ? '<button class="btn bad" data-k="estop">Emergency stop</button>' : ""}</div>`);
    const es = $("alert").querySelector('[data-k="estop"]'); if (es) es.onclick = () => decide({ decision: "modify", action: "emergency_stop" });

    // gauge
    const col = riskColor(r.p);
    gaugeUpdate($("gauge").firstElementChild, { p: r.p, lo: r.p_lo, hi: r.p_hi, thr: r.threshold, color: col });
    setHTML($("b-risk"), badge(r.levels?.risk ?? r.level, r.stale));
    { const L = riskLevel(r.p); setHTML($("lvl"), `<span class="dr-lv ${L.toLowerCase()}">${L}</span>`); }
    setTxt($("ttf"), `Time to failure ~${ttfTxt(r.ttf)} min (band ${ttfTxt(r.ttf_lo)}–${ttfTxt(r.ttf_hi)})`); setTxt($("ttfm"), r.ttf_method ? ` · ${r.ttf_method}` : "");

    // anomaly
    $("abar").style.width = pct(r.anomaly); $("abar").style.background = riskColor(r.anomaly);
    setHTML($("b-anom"), badge(r.levels?.anomaly));
    setTxt($("acap"), CAPTION[r.levels?.anomaly] || ""); setTxt($("anum"), num(r.anomaly, 2));

    // contributions
    setTxt($("ctitle"), r.contrib_title); setHTML($("b-expl"), badge(r.levels?.explanation));
    const lv = r.levels?.explanation ?? r.level; rowsFor(lv, r.contributions || []);
    setTxt($("cfoot"), lv === 1 ? `log-odds; base ${num(r.base_value, 2)}` : "");

    setTxt($("diag"), r.diagnosis || "");

    // trust
    const tr = r.trust || {};
    setHTML($("review"), tr.review ? `<div class="dr-review">${WARN}<span>Human review required — recommendation withheld</span></div>` : "");
    el.querySelector(".rv").setAttribute("stroke-dasharray", `${(tr.value || 0) * 100} 100`); el.querySelector(".rv").style.stroke = riskColor(1 - (tr.value || 0));
    setTxt($("tval"), pct(tr.value));
    $("agb").style.width = pct(tr.agreement); $("idb").style.width = pct(tr.in_dist);
    setTxt($("agn"), pct(tr.agreement)); setTxt($("idn"), pct(tr.in_dist));
    setTxt($("ags"), `${tr.source || ""}${tr.other ? " — " + tr.other : ""}`); setTxt($("ids"), tr.in_dist_source || "");
    setTxt($("tcause"), tr.likely_cause ? `Likely cause: ${tr.likely_cause}` : "");

    // decision bar
    $("d-ap").disabled = !al || !!tr.review; $("d-ap").title = tr.review ? "Approval disabled: trust too low, review required" : "Approve the AI recommendation";
    $("d-mo").disabled = $("d-ov").disabled = $("d-mgo").disabled = !al;
    $("d-ogo").disabled = !al || !$("d-rc").value;
    if (!al && !$("d-msg").textContent.includes("recorded")) setTxt($("d-msg"), "No open alert for this asset — decisions unlock when one fires.");
    else if (al && $("d-msg").textContent.startsWith("No open")) setTxt($("d-msg"), "");

    // learned
    const th = t.thresholds?.[a], learned = (t.learned || []).filter((x) => x.asset === a);
    setHTML($("thr-spark"), sparkline(th?.hist, 150, 34, "var(--text-3)")); setTxt($("thr-val"), num(th?.value, 2));
    setHTML($("learned"), learned.length ? learned.map((x) => `<li>${esc(x.text)} <span class="mono">${num(x.old, 2)} → ${num(x.new, 2)}</span></li>`).join("") : '<li class="dr-muted">Nothing learned yet for this asset.</li>');
  }

  // ------------------------------------------------------------------ open / close
  function open(asset) {
    a = asset; clearInterval(refreshTimer); clearTimeout(whatifTimer); reqId++;
    if (!a) { el.classList.remove("open"); el.setAttribute("aria-hidden", "true"); return; }
    build(); update(); el.classList.add("open"); el.setAttribute("aria-hidden", "false");
    runWhatif(); refreshTimer = setInterval(runWhatif, 15000);
  }
  store.on("select", open);
  store.on("tick", () => a && update());
  store.on("hello", () => a && open(a));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && a) store.select(null); });
  el.setAttribute("role", "complementary"); el.setAttribute("aria-label", "Asset detail"); el.setAttribute("aria-hidden", "true");

  // ------------------------------------------------------------------ director commands
  store.on("cmd:council", () => a && runCouncil());
  store.on("cmd:whatif", (p = {}) => {
    if (!a) return; const c = controls();
    if (p.action !== undefined) c.action = p.action || "none";
    if (p.derate != null) c.derate = p.derate;
    if (p.throughput != null) c.thr = p.throughput <= 2 ? Math.round(p.throughput * 100) : p.throughput;
    $("w-act").value = c.action === "none" ? "" : c.action; $("w-der").value = c.derate; $("w-thr").value = c.thr; syncLabels();
    clearTimeout(whatifTimer); runWhatif();
  });
  store.on("cmd:decision", async (p = {}) => {
    if (!a || !store.openAlert(a)) return;
    if (p.decision === "modify") { $("d-oform").hidden = true; $("d-mform").hidden = false; if (p.action) $("d-act").value = p.action; await wait(900); $("d-mgo").click(); }
    else if (p.decision === "override") {
      $("d-mform").hidden = true; $("d-oform").hidden = false; await wait(500);
      if (p.reason_code) $("d-rc").value = p.reason_code; $("d-ogo").disabled = !$("d-rc").value;
      await wait(500); if (p.note) $("d-note").value = p.note; await wait(700); $("d-ogo").click();
    } else { await wait(600); $("d-ap").click(); }
  });
}
