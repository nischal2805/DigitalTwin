// Synthesized mill ambience + event cues (WebAudio only). AudioContext is created lazily on a user gesture.
import { store } from "./store.js";

const KEY = "sahayak.sound";
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
let ctx = null, master = null, cueBus = null, drone = null, droneG = null, rumbleG = null, rumbleF = null, hissG = null;
let inited = false;

function noiseBuffer(brown) {
  const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}
function noiseSrc(brown) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(brown); s.loop = true; s.start();
  return s;
}

function ensure() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
  cueBus = ctx.createGain(); cueBus.gain.value = 1; cueBus.connect(master);
  // drone: two detuned saws through a low-pass
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 180;
  droneG = ctx.createGain(); droneG.gain.value = 0;
  drone = [ctx.createOscillator(), ctx.createOscillator()];
  drone.forEach((o, i) => { o.type = "sawtooth"; o.frequency.value = 48 + i * 0.6; o.connect(lp); o.start(); });
  lp.connect(droneG); droneG.connect(master);
  // rumble: brown noise
  rumbleF = ctx.createBiquadFilter(); rumbleF.type = "lowpass"; rumbleF.frequency.value = 120;
  rumbleG = ctx.createGain(); rumbleG.gain.value = 0;
  noiseSrc(true).connect(rumbleF); rumbleF.connect(rumbleG); rumbleG.connect(master);
  // hiss: high-passed white noise (water spray)
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 3500;
  hissG = ctx.createGain(); hissG.gain.value = 0;
  noiseSrc(false).connect(hp); hp.connect(hissG); hissG.connect(master);
  applyEnabled();
}

function applyEnabled() {
  if (!ctx) return;
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(sound.enabled ? 0.25 : 0, ctx.currentTime, 0.15);
}

const live = () => ctx && sound.enabled && ctx.state === "running";

function tone(freq, t0, dur, type, vol, freq2, dest) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (freq2) o.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(dest || cueBus);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

function klaxon() {
  const t0 = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  o.type = "sawtooth"; f.type = "lowpass"; f.frequency.value = 1500;
  for (let i = 0; i < 8; i++) o.frequency.setValueAtTime(i % 2 ? 820 : 560, t0 + i * 0.25);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.2, t0 + 0.05);
  g.gain.setValueAtTime(0.2, t0 + 1.9); g.gain.linearRampToValueAtTime(0, t0 + 2.0);
  o.connect(f); f.connect(g); g.connect(cueBus); o.start(t0); o.stop(t0 + 2.05);
}

function boom() {
  const t0 = ctx.currentTime;
  tone(95, t0, 1.0, "sine", 0.6, 32);
  const n = ctx.createBufferSource(); n.buffer = noiseBuffer(true);
  const f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = "lowpass"; f.frequency.value = 200;
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.5, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
  n.connect(f); f.connect(g); g.connect(cueBus); n.start(t0); n.stop(t0 + 1);
}

function cue(kind) {
  const t0 = ctx.currentTime;
  switch (kind) {
    case "alert": tone(660, t0, 0.35, "sine", 0.22); tone(880, t0 + 0.18, 0.45, "sine", 0.22); break;
    case "emergency": klaxon(); break;
    case "fallback": tone(700, t0, 0.28, "triangle", 0.2, 340); break;
    case "recover": tone(340, t0, 0.28, "triangle", 0.2, 800); break;
    case "learned": [1568, 2093, 2637, 3136].forEach((f, i) => tone(f, t0 + i * 0.06, 0.3, "sine", 0.06)); break;
    case "failure": boom(); break;
    case "prevented": [523.25, 659.25, 783.99].forEach((f, i) => tone(f, t0 + i * 0.04, 1.2, "triangle", 0.09)); break;
    case "decision": case "action": tone(1000, t0, 0.05, "sine", 0.1, 600); break;
    default: break;
  }
}

export const sound = {
  enabled: false,
  init() {
    if (inited) return;
    inited = true;
    this.enabled = localStorage.getItem(KEY) === "1";
    // a persisted "on" still needs one user gesture before audio may start
    const unlock = () => { if (this.enabled) ensure(); };
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    store.on("tick", (m) => {
      if (!live()) return;
      const fr = m?.frame, lvl = fr?.state === "RUNNING" ? clamp(fr?.u ?? 0, 0, 1.2) : 0;
      const now = ctx.currentTime;
      droneG.gain.setTargetAtTime(0.1 * lvl, now, 0.4);
      drone.forEach((o, i) => o.frequency.setTargetAtTime(44 + 30 * lvl + i * 0.6, now, 0.5));
      rumbleG.gain.setTargetAtTime(0.35 * lvl, now, 0.4);
      rumbleF.frequency.setTargetAtTime(80 + 120 * lvl, now, 0.5);
      const wf = fr?.assets?.CB?.tags?.WaterFlow, ratio = wf?.v != null ? clamp(wf.v / (wf.exp || wf.v || 1), 0, 1.3) : 0.6;
      hissG.gain.setTargetAtTime(0.03 * ratio * lvl, now, 0.4);
    });
    store.on("event", (e) => { if (live()) cue(e?.kind); });
  },
  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem(KEY, this.enabled ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    if (this.enabled) ensure(); else applyEnabled();
    if (ctx && this.enabled) applyEnabled();
    return this.enabled;
  },
};
