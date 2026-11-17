// Scripted ~4 min narrated demo that drives the real backend + UI. See PRD §5/§6.
import { store, api } from "./store.js";

let cancelled = false, paused = false, running = false, skipFlag = false, ui = null, runId = 0;

class Stop extends Error {}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Wait until cond() is truthy, or timeout (fallback). Pauses freeze the clock; Skip aborts the step.
async function until(cond, timeout = 30000) {
  let waited = 0;
  while (true) {
    if (cancelled) throw new Stop();
    if (skipFlag) return false;
    if (!paused) {
      try { if (cond()) return true; } catch { /* tick not ready */ }
      if (waited >= timeout) return false;
      waited += 200;
    }
    await sleep(200);
  }
}
const wait = (ms) => until(() => false, ms);

const tk = () => store.tick;
const hasAlert = (a) => !!tk()?.alerts?.some((x) => x.asset === a);
const assetState = () => tk()?.frame?.state ?? null; // line-wide: RUNNING / MAINTENANCE / E-STOP / TRIPPED
const speed = (n) => api("/api/speed", { speed: n }).catch(() => {});
const safe = (p) => p.catch(() => {});

// ---------------------------------------------------------------- caption overlay
function buildUI() {
  const el = document.createElement("div");
  el.className = "dir-caption";
  el.innerHTML = `
    <div class="dir-bar"><i></i></div>
    <div class="dir-body">
      <div class="dir-head"><span class="dir-step"></span><span class="dir-title"></span></div>
      <div class="dir-text"></div>
      <div class="dir-ctl">
        <button class="btn ghost" data-a="pause">Pause</button>
        <button class="btn ghost" data-a="skip">Skip &rarr;</button>
        <button class="btn bad" data-a="stop">Stop</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "pause") setPaused(!paused);
    else if (a === "skip") skipFlag = true;
    else if (a === "stop") director.stop();
  });
  return el;
}
function setPaused(p) {
  paused = p;
  if (ui) { ui.querySelector('[data-a="pause"]').textContent = p ? "Resume" : "Pause"; ui.classList.toggle("paused", p); }
}
function onKey(e) {
  if (!running || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); setPaused(!paused); }
  else if (e.key === "ArrowRight") skipFlag = true;
  else if (e.key === "Escape") director.stop();
}

let stepNo = 0, total = 0;
function say(title, text) {
  stepNo++;
  ui.querySelector(".dir-step").textContent = `${stepNo} / ${total}`;
  ui.querySelector(".dir-title").textContent = title;
  ui.querySelector(".dir-text").textContent = text;
  ui.querySelector(".dir-bar i").style.width = `${(stepNo / total) * 100}%`;
  ui.classList.add("show");
  store.emit("caption", { text: `${title}. ${text}`, step: stepNo, total });
}
// Narrate: show caption, hold for ms (skippable), then clear skip flag.
async function beat(title, text, ms = 7000) {
  say(title, text);
  await wait(ms);
  skipFlag = false;
}
// Run a waiting phase with a skip-safe wrapper.
async function phase(fn) { await fn(); skipFlag = false; }

// ---------------------------------------------------------------- script
const STEPS = [
  async () => {
    await safe(api("/api/reset", {}));
    await safe(api("/api/admin/fallback", { level: "auto" }));
    await speed(1);
    store.select(null); store.setTab("live");
    await beat("Meet the digital twin",
      "A physics-based twin of a hot-strip mill: five assets, one tick per plant-minute. Every number you see flows through an AI chain: ML, then the Health Engine, then an LLM, each stamped with a provenance badge.", 11000);
  },
  async () => {
    await beat("Scenario 1: bearing wear on R1", "Injecting a slow bearing fault into Roughing Mill R1. Watch the risk climb.", 4000);
    await safe(api("/api/inject", { scenario: "S1" }));
    await speed(3);
    await phase(() => until(() => (tk()?.risks?.R1?.p ?? 0) > 0.3, 45000));
    say("What is driving the risk", "SHAP attributes the rising risk to vibration and bearing temperature, computed live by LightGBM.");
    await phase(() => until(() => hasAlert("R1"), 60000));
    await speed(1);
    store.select("R1");
    await beat("Alert raised: R1 drawer", "The risk gauge, the remaining-useful-life band and the SHAP contribution bars all carry the green ML badge.", 9000);
  },
  async () => {
    await beat("What if we act?", "The twin can simulate alternatives before anyone commits. First: planned maintenance now.", 3500);
    store.emit("cmd:whatif", { action: "planned_maintenance" });
    await beat("Planned maintenance", "Failure is pushed far beyond the horizon, at the cost of a short planned stop.", 6000);
    store.emit("cmd:whatif", { action: "derate", derate: 30 });
    await beat("Or derate 30%", "Running slower buys time: the failure moves out, but throughput is lost. The operator sees the trade-off.", 6000);
  },
  async () => {
    store.emit("cmd:council", {});
    await beat("Agent council", "Three agents deliberate: a reliability engineer, a production planner and a safety officer.", 6000);
    await beat("Work order and provenance", "They converge on a work order, and the provenance line records exactly which model produced it.", 6000);
  },
  async () => {
    store.emit("cmd:decision", { decision: "approve" });
    await beat("Human approves", "The twin executes the maintenance, and the alert threshold adapts. Watch for the AI learned toast and the impact ticker.", 8000);
    await phase(() => until(() => assetState("R1") !== "MAINTENANCE", 40000));
    if (assetState("R1") === "MAINTENANCE") await safe(api("/api/action", { action: "restart", asset: "R1" }));
  },
  async () => {
    await safe(api("/api/inject", { scenario: "S3" }));
    store.select("R1"); await speed(2);
    await beat("Scenario 3: sensor glitch", "A faulty vibration sensor spikes. The anomaly meter rises while physics cross-checks disagree.", 7000);
    await phase(() => until(() => (tk()?.risks?.R1?.trust?.value ?? 1) < 0.5, 25000));
    await beat("Trust drops below 0.5", "Human review required: recommendation withheld. The system refuses to guess on untrustworthy data.", 7000);
    if (hasAlert("R1")) store.emit("cmd:decision", { decision: "override", reason_code: "SENSOR_FAULT", note: "Loose accelerometer cable" });
    else await safe(api("/api/action", { action: "recalibrate_sensor", asset: "R1" }));
    await beat("Human stays in control", "The operator flags a sensor fault and recalibrates. The AI advises, the human decides.", 6000);
  },
  async () => {
    await speed(1);
    await safe(api("/api/inject", { scenario: "S6" }));
    await beat("Scenario 6: model outage", "The ML service goes down. The badge flips to amber: FALLBACK 1, Health Engine. Bars are retitled Factor contribution and the dashboard keeps running.", 10000);
    await safe(api("/api/admin/fallback", { level: "llm" }));
    await beat("Force LLM fallback", "Fallback 2 asks an LLM to estimate risk (purple badge). With no LLM key it stays on the Engine: the chain degrades gracefully.", 10000);
    await safe(api("/api/admin/fallback", { level: "auto" }));
    await speed(3);
    await phase(() => until(() => tk()?.ai?.level === 1, 40000));
    await speed(1);
    await beat("Auto-recovery", "Once the model is healthy again the badge returns to green, with no operator action.", 5000);
  },
  async () => {
    await beat("Scenario 2: cooling pump cavitation", "Injecting cavitation in the cooling bed pump. Running at 3x until the alert fires.", 4000);
    await safe(api("/api/inject", { scenario: "S2" }));
    await speed(3);
    await phase(() => until(() => hasAlert("CB"), 60000));
    await speed(1);
    store.select("CB");
    await wait(2500);
    store.emit("cmd:decision", { decision: "modify", action: "switch_standby_pump" });
    await beat("Modified: switch to standby pump", "The operator picks a cheaper action than the council proposed. Failure prevented, and the impact ticker shows the saving.", 9000);
  },
  async () => {
    store.select(null);
    store.setTab("report");
    await beat("Model report", "Honest held-out metrics: LightGBM against static alarm limits.", 8000);
    store.setTab("explain");
    await beat("Global explainability", "Global SHAP shows which signals the model trusts across the whole plant.", 7000);
    store.setTab("audit");
    await beat("Audit log", "Every decision is recorded with its provenance level, who decided and why.", 7000);
    store.setTab("live");
    await beat("Sahayak", "Physics twin, explainable AI, graceful fallback, and a human always in the loop. Thank you.", 6000);
  },
];

async function cleanup() {
  await safe(api("/api/speed", { speed: 1 }));
  await safe(api("/api/admin/fallback", { level: "auto" }));
}

export const director = {
  get running() { return running; },
  async start() {
    if (running) return;
    running = true; cancelled = false; skipFlag = false; stepNo = 0;
    const id = ++runId;
    total = 23; // number of say() calls in STEPS
    ui ||= buildUI();
    setPaused(false);
    document.addEventListener("keydown", onKey);
    try {
      for (const step of STEPS) { await step(); skipFlag = false; }
    } catch (e) {
      if (!(e instanceof Stop)) console.error("director", e);
    }
    if (id !== runId) return; // a newer run owns the UI
    await cleanup();
    running = false;
    document.removeEventListener("keydown", onKey);
    ui?.classList.remove("show");
    store.emit("caption", null);
  },
  stop() { if (running) cancelled = true; },
};

// ---------------------------------------------------------------- presentation mode
let hideTimer;
function onMove() {
  document.body.classList.remove("cursor-hidden");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.body.classList.add("cursor-hidden"), 3000);
}
export function togglePresentation() {
  const on = document.body.classList.toggle("presenting");
  store.presentation = on;
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    document.addEventListener("mousemove", onMove);
    onMove();
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    document.removeEventListener("mousemove", onMove);
    clearTimeout(hideTimer);
    document.body.classList.remove("cursor-hidden");
  }
  store.emit("present", on);
}
