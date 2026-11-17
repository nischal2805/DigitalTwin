// Sahayak hot-strip mill: procedural 2D canvas side view, F1 -> R1 -> R2 -> CB -> CL. No assets, no libs.
import { store, riskColor, ASSET_ORDER } from "./store.js";

const COL = { F1: "#ff8a3d", R1: "#38bdf8", R2: "#a78bfa", CB: "#34d399", CL: "#f472b6" };
const SHORT = { F1: "Furnace", R1: "Roughing", R2: "Finishing", CB: "Cooling", CL: "Coiler" };
const CX = { F1: 0.105, R1: 0.30, R2: 0.465, CB: 0.71, CL: 0.91 }; // centre x (fraction of W)
const HIT = { F1: [0.025, 0.185], R1: [0.245, 0.355], R2: [0.41, 0.59], CB: [0.605, 0.815], CL: [0.84, 0.98] };
const TOPY = { F1: 0.35, R1: 0.28, R2: 0.28, CB: 0.30, CL: 0.40 }; // label connector target (fraction of H)
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rnd = Math.random;
const lerp = (a, b, k) => a + (b - a) * k;

const TST = [[550, 90, 14, 10], [650, 150, 24, 12], [750, 205, 45, 12], [900, 255, 110, 22], [1050, 255, 170, 60], [1200, 255, 238, 190]];
function tcol(T, a = 1) {
  let i = 0;
  while (i < TST.length - 2 && T > TST[i + 1][0]) i++;
  const A = TST[i], B = TST[i + 1], k = clamp((T - A[0]) / (B[0] - A[0]), 0, 1);
  return `rgba(${(lerp(A[1], B[1], k)) | 0},${(lerp(A[2], B[2], k)) | 0},${(lerp(A[3], B[3], k)) | 0},${a})`;
}

function sprite(size, stops) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

const FL_N = ["rgba(255,110,20,", "rgba(255,190,50,", "rgba(255,250,210,"];
const FL_F = ["rgba(70,40,30,", "rgba(220,100,30,", "rgba(255,180,90,"];
const FL_S = [1, 0.66, 0.36];

export function createMill(canvas) {
  const ctx = canvas.getContext("2d");
  const parent = canvas.parentElement || canvas;
  const RM = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const shakeMul = RM ? 0.25 : 1;

  const glowS = sprite(64, [[0, "rgba(255,200,120,1)"], [0.35, "rgba(255,120,30,.5)"], [1, "rgba(255,80,0,0)"]]);
  const whiteS = sprite(64, [[0, "rgba(255,255,255,.9)"], [0.5, "rgba(230,240,250,.4)"], [1, "rgba(220,230,240,0)"]]);
  const darkS = sprite(64, [[0, "rgba(30,28,30,.9)"], [0.5, "rgba(40,38,40,.45)"], [1, "rgba(40,38,40,0)"]]);
  const smokeS = sprite(64, [[0, "rgba(90,70,70,.8)"], [0.5, "rgba(60,50,52,.4)"], [1, "rgba(50,40,42,0)"]]);
  let stripePat = null;

  let W = 800, H = 300, dpr = 1, pY = 0, fY = 0;
  let t = 0, last = 0, raf = 0;
  let hover = null;
  const mouse = { x: 0, y: 0 };
  let bg = null;
  let rot = 0, flow = 0;

  // ---- eased scene state
  const KEYS = ["u", "heat", "fuelI", "foul", "r1shake", "r1bear", "r2shake", "r2oil", "spray", "sputter", "tex", "mis", "flutter", "dim", "maint"];
  const E = { u: 0.18, heat: 0.8, fuelI: 1, foul: 0, r1shake: 0, r1bear: 0, r2shake: 0, r2oil: 0, spray: 0.6, sputter: 0, tex: 620, mis: 0, flutter: 0, dim: 0, maint: 0 };
  const T = Object.assign({}, E);
  const P = { F1: 0, R1: 0, R2: 0, CB: 0, CL: 0 };
  const FL = {};
  ASSET_ORDER.forEach((a) => (FL[a] = { alert: false, over: false, failed: false, glitch: false }));
  let coilFrac = 0.3, hasTick = false, running = false;

  // ---- particles (struct of arrays)
  const N = RM ? 150 : 400;
  const px = new Float32Array(N), py = new Float32Array(N), pvx = new Float32Array(N), pvy = new Float32Array(N);
  const plf = new Float32Array(N), pmx = new Float32Array(N), psz = new Float32Array(N), pty = new Uint8Array(N);
  let cur = 0, steamP = 0.5;
  // types: 0 spark, 1 soot, 2 steam, 3 water, 4 smoke
  function spawn(type, x, y, vx, vy, life, size) {
    for (let k = 0; k < N; k++) {
      const i = (cur + k) % N;
      if (plf[i] <= 0) {
        px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy; plf[i] = life; pmx[i] = life; psz[i] = size; pty[i] = type; cur = i + 1;
        return;
      }
    }
  }
  const cnt = (r, dt) => { const n = r * dt * (RM ? 0.4 : 1); let k = Math.floor(n); if (rnd() < n - k) k++; return k; };

  function stepParticles(dt) {
    for (let i = 0; i < N; i++) {
      if (plf[i] <= 0) continue;
      plf[i] -= dt;
      const ty = pty[i];
      if (plf[i] <= 0) {
        if (ty === 3 && rnd() < steamP) spawn(2, px[i], pY - H * 0.01, (rnd() - 0.5) * W * 0.012, -H * (0.08 + rnd() * 0.08), 1.2 + rnd(), H * 0.016);
        continue;
      }
      if (ty === 0) pvy[i] += H * 1.6 * dt;
      else if (ty === 3) pvy[i] += H * 0.3 * dt;
      else { psz[i] += dt * H * (ty === 2 ? 0.035 : 0.025); pvx[i] += (rnd() - 0.5) * W * 0.02 * dt; }
      px[i] += pvx[i] * dt; py[i] += pvy[i] * dt;
    }
  }
  function drawParticles() {
    ctx.save();
    // puffs
    for (let ty = 1; ty <= 4; ty++) {
      if (ty === 3) continue;
      const spr = ty === 1 ? darkS : ty === 2 ? whiteS : smokeS, ba = ty === 2 ? 0.4 : 0.55;
      for (let i = 0; i < N; i++) {
        if (plf[i] <= 0 || pty[i] !== ty) continue;
        const a = plf[i] / pmx[i], s = psz[i];
        ctx.globalAlpha = ba * a * Math.min(1, (1 - a) * 6 + 0.1);
        ctx.drawImage(spr, px[i] - s, py[i] - s, s * 2, s * 2);
      }
    }
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "rgba(150,210,255,.9)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      if (plf[i] <= 0 || pty[i] !== 3) continue;
      ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - pvx[i] * 0.03, py[i] - pvy[i] * 0.03);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#ffb84d";
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      if (plf[i] <= 0 || pty[i] !== 0) continue;
      ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - pvx[i] * 0.035, py[i] - pvy[i] * 0.035);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---- helpers
  const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  function glowAt(x, y, r, a, spr = glowS, sy = 1) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.drawImage(spr, x - r, y - r * sy, r * 2, r * 2 * sy);
    ctx.restore();
  }
  const tagOf = (a, n) => store.tick?.frame?.assets?.[a]?.tags?.[n];

  // ---- layout / background
  function resize() {
    const r = parent.getBoundingClientRect();
    let w = Math.floor(r.width || canvas.clientWidth || 800);
    let h = Math.floor(r.height || canvas.clientHeight || 0);
    if (h < 60) h = Math.floor(w / 3);
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = Math.max(w, 200); H = Math.max(h, 80);
    canvas.style.width = W + "px"; canvas.style.height = H + "px"; canvas.style.display = "block";
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    pY = H * 0.55; fY = H * 0.88;
    renderBg();
  }

  function renderBg() {
    bg = document.createElement("canvas");
    bg.width = canvas.width; bg.height = canvas.height;
    const g = bg.getContext("2d");
    g.scale(dpr, dpr);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#06080c"); sky.addColorStop(0.7, "#10141b"); sky.addColorStop(1, "#0a0c10");
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // far columns + trusses
    g.fillStyle = "#0b0f15";
    const cs = W / 9;
    for (let x = cs * 0.4; x < W; x += cs) { g.fillRect(x, H * 0.1, W * 0.016, fY - H * 0.1); }
    g.strokeStyle = "rgba(255,255,255,.035)"; g.lineWidth = 1;
    for (let x = cs * 0.4; x < W; x += cs) {
      g.beginPath();
      for (let y = H * 0.12; y < fY - H * 0.1; y += H * 0.14) { g.moveTo(x, y); g.lineTo(x + cs, y + H * 0.14); g.moveTo(x + cs, y); g.lineTo(x, y + H * 0.14); }
      g.stroke();
    }
    // near columns
    g.fillStyle = "#080a0e";
    for (let x = W * 0.02; x < W; x += W / 4.6) { g.fillRect(x, 0, W * 0.026, H); g.fillRect(x - W * 0.004, fY - H * 0.04, W * 0.034, H * 0.05); }
    // crane rail / girder
    const gd = g.createLinearGradient(0, H * 0.075, 0, H * 0.115);
    gd.addColorStop(0, "#222a35"); gd.addColorStop(1, "#11161d");
    g.fillStyle = gd; g.fillRect(0, H * 0.075, W, H * 0.04);
    g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(0, H * 0.075, W, 1);
    // faint grid
    g.strokeStyle = "rgba(120,160,200,.035)";
    g.beginPath();
    for (let x = 0; x < W; x += W / 24) { g.moveTo(x, H * 0.12); g.lineTo(x, fY); }
    for (let y = H * 0.2; y < fY; y += H / 10) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    // floor
    const fl = g.createLinearGradient(0, fY, 0, H);
    fl.addColorStop(0, "#1a1f27"); fl.addColorStop(1, "#090b0e");
    g.fillStyle = fl; g.fillRect(0, fY, W, H - fY);
    g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(0, fY, W, 1.5);
    g.strokeStyle = "rgba(240,190,40,.12)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, fY + (H - fY) * 0.78); g.lineTo(W, fY + (H - fY) * 0.78); g.stroke();
    // maintenance hazard pattern
    const oc = document.createElement("canvas"); oc.width = oc.height = 28;
    const o = oc.getContext("2d");
    o.fillStyle = "#f5b301"; o.fillRect(0, 0, 28, 28);
    o.fillStyle = "#15120a"; o.beginPath(); o.moveTo(0, 14); o.lineTo(14, 0); o.lineTo(28, 0); o.lineTo(0, 28); o.fill();
    o.beginPath(); o.moveTo(14, 28); o.lineTo(28, 14); o.lineTo(28, 28); o.fill();
    stripePat = ctx.createPattern(oc, "repeat");
  }

  // ---- update: targets -> eased state
  function update(dt) {
    const tk = store.tick, fr = tk?.frame, A = fr?.assets;
    hasTick = !!tk;
    const state = fr?.state ?? "IDLE";
    running = state === "RUNNING";
    const tripped = state === "TRIPPED" || state === "E-STOP";
    T.u = hasTick ? (running ? clamp(fr.u ?? 0, 0, 1.5) : 0) : 0.18;
    T.dim = tripped ? 1 : 0;
    T.maint = state === "MAINTENANCE" ? 1 : 0;
    const ft = tagOf("F1", "FurnaceTemp"), fu = tagOf("F1", "FuelFlow");
    T.heat = ft?.v != null ? clamp(ft.v / 1250, 0.5, 1.15) : 0.8;
    T.fuelI = fu?.v != null ? clamp(fu.v / (fu.exp || fu.v || 1), 0.3, 1.6) : 1;
    T.foul = clamp(Math.max(ft?.v != null ? (ft.exp - ft.v) / 30 : 0, fu?.v != null ? (fu.v - fu.exp) / 200 : 0), 0, 1);
    const r1v = tagOf("R1", "Vibration"), r1b = tagOf("R1", "BearingTemp");
    T.r1shake = r1v?.v != null ? clamp(Math.max(0, r1v.v - r1v.exp) / 6, 0, 1.5) : 0;
    T.r1bear = r1b?.v != null ? clamp((r1b.v - r1b.exp) / 25, 0, 1) : 0;
    const r2v = tagOf("R2", "Vibration"), r2o = tagOf("R2", "OilTemp");
    T.r2shake = r2v?.v != null ? clamp(Math.max(0, r2v.v - r2v.exp) / 6, 0, 1.5) : 0;
    T.r2oil = r2o?.v != null ? clamp((r2o.v - r2o.exp) / 25, 0, 1) : 0;
    const wf = tagOf("CB", "WaterFlow"), pp = tagOf("CB", "PumpPressure"), se = tagOf("CB", "StripExitTemp");
    T.spray = wf?.v != null ? clamp(wf.v / (wf.exp || wf.v || 1), 0, 1.3) : 0.6;
    T.sputter = pp?.v != null ? clamp((1 - pp.v / (pp.exp || pp.v || 1)) * 1.8, 0, 1) : 0;
    T.tex = se?.v != null ? clamp(se.v, 450, 850) : 620;
    const mi = tagOf("CL", "Misalignment"), tn = tagOf("CL", "Tension");
    T.mis = mi?.v != null ? clamp((mi.v - 0.15) / 1.0, 0, 1.3) : 0;
    T.flutter = clamp((tn?.v != null ? Math.abs(tn.v - tn.exp) / 3 : 0) + T.mis * 0.6, 0, 1.5);
    coilFrac = ((fr?.produced_t ?? 0) % 300) / 300;
    const k = 1 - Math.exp(-dt * 4), ku = 1 - Math.exp(-dt * 2.5);
    for (let i = 0; i < KEYS.length; i++) { const key = KEYS[i]; E[key] += (T[key] - E[key]) * (key === "u" ? ku : k); }
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], rk = tk?.risks?.[a], f = FL[a];
      P[a] += ((rk?.p ?? 0) - P[a]) * k;
      f.over = (rk?.p ?? 0) >= (rk?.threshold ?? 0.5);
      f.alert = !!tk?.alerts?.some((x) => x.asset === a);
      f.failed = !!A?.[a]?.failed;
      let gl = false; const tags = A?.[a]?.tags;
      if (tags) for (const key in tags) if (tags[key]?.glitch) { gl = true; break; }
      f.glitch = gl;
    }
    rot += E.u * dt * 3.2;
    flow += E.u * dt * W * 0.11;
    spawnAmbient(dt);
    stepParticles(dt);
  }

  function shakeOf(amt) {
    const a = amt * H * 0.006 * shakeMul * clamp(E.u * 3, 0, 1);
    return [Math.sin(t * 61) * a + Math.sin(t * 97) * a * 0.5, Math.sin(t * 73) * a * 0.6];
  }

  function spawnAmbient(dt) {
    // furnace soot/smoke
    const cxF = CX.F1 * W, topF = pY - 0.2 * H;
    const fr = 2 + E.foul * 40;
    for (let n = cnt(fr, dt); n > 0; n--) spawn(E.foul > 0.15 ? 1 : 4, cxF - 0.04 * W + (rnd() - 0.5) * 6, topF - 0.1 * H, (rnd() - 0.3) * W * 0.01, -H * (0.12 + rnd() * 0.08), 2 + rnd() * 1.5, H * 0.015);
    // R1 sparks
    const hot1 = Math.max(P.R1 >= 0.6 ? P.R1 : 0, E.r1bear > 0.6 ? E.r1bear : 0);
    if (hot1 > 0 && E.u > 0.05) for (let n = cnt(hot1 * 40, dt); n > 0; n--) spawn(0, CX.R1 * W, pY, W * (0.05 + rnd() * 0.12), -H * (0.2 + rnd() * 0.5), 0.5 + rnd() * 0.5, 1);
    // R2 gearbox smoke
    if (E.r2oil > 0.1) for (let n = cnt(E.r2oil * 20, dt); n > 0; n--) spawn(4, (CX.R2 + 0.085) * W + (rnd() - 0.5) * 0.04 * W, pY - 0.13 * H, (rnd() - 0.5) * W * 0.01, -H * (0.1 + rnd() * 0.08), 1.8 + rnd(), H * 0.014);
    // CB spray
    const dens = E.spray * (0.12 + 0.88 * clamp(E.u / 0.5, 0, 1));
    const x0 = 0.61 * W, x1 = 0.81 * W, hy = pY - 0.15 * H;
    steamP = 0.35 + 0.5 * clamp((E.tex - 450) / 350, 0, 1);
    for (let i = 0; i < 6; i++) {
      if (!headerOn(i)) continue;
      const xi = x0 + ((i + 0.5) / 6) * (x1 - x0);
      for (let n = cnt(dens * 16, dt); n > 0; n--) {
        const vy = H * (0.85 + rnd() * 0.3), y0 = hy + 0.02 * H;
        spawn(3, xi + (rnd() - 0.5) * 0.03 * W, y0, (rnd() - 0.5) * W * 0.01, vy, (pY - 0.008 * H - y0) / vy, 1);
      }
    }
    // failed assets: smoke
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i];
      if (FL[a].failed) for (let n = cnt(30, dt); n > 0; n--) spawn(4, lerp(HIT[a][0], HIT[a][1], rnd()) * W, pY - 0.08 * H, (rnd() - 0.5) * W * 0.012, -H * (0.1 + rnd() * 0.1), 2 + rnd(), H * 0.02);
    }
  }
  function headerOn(i) {
    if (E.sputter < 0.03) return true;
    return (Math.sin(t * 7 + i * 2.1) * 0.5 + 0.5) > E.sputter * (i % 2 ? 0.9 : 0.55);
  }

  // ---- drawing
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    if (bg) ctx.drawImage(bg, 0, 0, W, H); else { ctx.fillStyle = "#0a0d12"; ctx.fillRect(0, 0, W, H); }
    drawHazeCrane();
    drawHalosAndPools();
    drawTable();
    drawStrip();
    drawF1(); drawR1(); drawR2(); drawCB(); drawCL();
    drawParticles();
    drawFailedAndGlitch();
    drawOverlays();
    drawLabels();
    if (!hasTick) {
      ctx.fillStyle = "rgba(200,215,230,.45)"; ctx.font = `500 ${clamp(H * 0.035, 10, 14)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Awaiting twin telemetry…", W / 2, H * 0.95);
    }
    if (hover && hasTick) drawTooltip(hover);
  }

  function drawHazeCrane() {
    for (let i = 0; i < 7; i++) {
      const x = ((i * 0.17 + t * 0.006 * (1 + (i % 3))) % 1.4 - 0.2) * W, y = fY - H * (0.15 + 0.1 * (i % 3));
      glowAt(x, y, W * 0.18, 0.05 + 0.02 * E.u, whiteS, 0.7);
    }
    // overhead crane
    const cxr = W * (0.5 + 0.38 * Math.sin(t * 0.07)), by = H * 0.095;
    ctx.fillStyle = "#1c2430"; ctx.fillRect(cxr - W * 0.04, by - H * 0.02, W * 0.08, H * 0.045);
    ctx.fillStyle = "#2a3544"; ctx.fillRect(cxr - W * 0.04, by - H * 0.02, W * 0.08, 2);
    const ly = by + H * 0.025 + H * 0.06 + Math.sin(t * 0.5) * H * 0.01;
    ctx.strokeStyle = "rgba(160,170,185,.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cxr - 4, by + H * 0.025); ctx.lineTo(cxr - 4, ly); ctx.moveTo(cxr + 4, by + H * 0.025); ctx.lineTo(cxr + 4, ly); ctx.stroke();
    ctx.fillStyle = "#39414d"; rr(cxr - 8, ly, 16, H * 0.02, 3); ctx.fill();
    ctx.strokeStyle = "#555e6b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cxr, ly + H * 0.032, 5, 0.3, Math.PI * 1.2); ctx.stroke();
    if (Math.sin(t * 3) > 0) glowAt(cxr + W * 0.035, by - H * 0.02, 10, 0.8, glowS);
  }

  function drawHalosAndPools() {
    // warm pools under hot steel
    const heat = 0.35 + 0.65 * clamp(E.u / 0.8, 0, 1);
    glowAt(CX.F1 * W, fY, W * 0.11, 0.35 * E.heat, glowS, 0.25);
    glowAt(CX.R1 * W, fY, W * 0.07, 0.2 * heat, glowS, 0.25);
    glowAt(CX.R2 * W, fY, W * 0.07, 0.15 * heat, glowS, 0.25);
    // risk halos
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], f = FL[a], cx = ((HIT[a][0] + HIT[a][1]) / 2) * W, rx = ((HIT[a][1] - HIT[a][0]) / 2) * W * 0.92;
      const col = f.failed ? "#ff2d55" : riskColor(P[a]);
      let al = 0.5;
      if (f.failed) al = Math.sin(t * 20) > 0 ? 1 : 0.3;
      else if (f.over || f.alert) al = 0.65 + 0.35 * Math.sin(t * 4.2);
      const y = fY + (H - fY) * 0.4, ry = (H - fY) * 0.45;
      ctx.save();
      ctx.translate(cx, y); ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.4 * al; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.85 * al; ctx.strokeStyle = col; ctx.lineWidth = 2 * rx / ry * 0.5; ctx.beginPath(); ctx.arc(0, 0, rx * 0.88, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  function drawTable() {
    const xa = (CX.F1 + 0.075) * W, xb = 0.81 * W, y = pY + 0.037 * H;
    ctx.fillStyle = "#171c24"; ctx.fillRect(xa, y, xb - xa, H * 0.012);
    ctx.fillStyle = "#11151b";
    for (let x = xa + W * 0.02; x < xb; x += W * 0.06) ctx.fillRect(x, y, W * 0.006, fY - y);
    const sp = W * 0.016, rad = H * 0.011, off = flow % sp;
    ctx.fillStyle = "#3a424d"; ctx.beginPath();
    for (let x = xa + sp / 2; x < xb; x += sp) { ctx.moveTo(x + rad, y - rad * 0.4); ctx.arc(x, y - rad * 0.4, rad, 0, TAU); }
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = xa + sp / 2; x < xb; x += sp) { const a = (off / sp) * TAU; ctx.moveTo(x, y - rad * 0.4); ctx.lineTo(x + Math.cos(a) * rad, y - rad * 0.4 + Math.sin(a) * rad); }
    ctx.stroke();
  }

  function bar(x0, x1, t0, t1, T0, T1) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, tcol(T0)); g.addColorStop(1, tcol(T1));
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.18; ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x0, pY - t0 * 1.5); ctx.lineTo(x1, pY - t1 * 1.5); ctx.lineTo(x1, pY + t1 * 1.5); ctx.lineTo(x0, pY + t0 * 1.5); ctx.fill();
    ctx.restore();
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x0, pY - t0 / 2); ctx.lineTo(x1, pY - t1 / 2); ctx.lineTo(x1, pY + t1 / 2); ctx.lineTo(x0, pY + t0 / 2); ctx.fill();
  }

  function drawStrip() {
    const xF0 = (CX.F1 - 0.075) * W, xF1 = (CX.F1 + 0.075) * W, xR1 = CX.R1 * W, xR2 = CX.R2 * W, xC0 = 0.61 * W, xC1 = 0.81 * W;
    const thS = 0.034 * H, th1 = 0.022 * H, th2 = 0.011 * H, Tx = E.tex;
    // slabs (furnace -> R1); the furnace body is drawn later with a window hole
    const pitch = 0.095 * W, len = 0.062 * W, off = flow % pitch, xa = xF0 + 0.008 * W, xb = xR1;
    for (let x = xa - pitch + off; x < xb; x += pitch) {
      const l = Math.max(x, xa), r = Math.min(x + len, xb);
      if (r <= l) continue;
      const mid = (l + r) / 2, TT = mid < xF1 ? 1215 : 1180 - ((mid - xF1) / (xR1 - xF1)) * 50;
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.18; ctx.fillStyle = tcol(TT);
      ctx.fillRect(l, pY - thS * 1.4, r - l, thS * 2.8); ctx.restore();
      ctx.fillStyle = tcol(TT); ctx.fillRect(l, pY - thS / 2, r - l, thS);
      ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.fillRect(l, pY - thS / 2, r - l, 2);
    }
    bar(xR1, xR2, th1, th1 * 0.92, 1120, 1000);
    bar(xR2, xC0, th2, th2 * 0.95, 960, 880);
    bar(xC0, xC1, th2 * 0.95, th2 * 0.9, 880, Tx);
    // scale marks drifting with the strip
    const sp = W * 0.03, o2 = flow % sp;
    ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = xR1 + sp - o2; x < xC1; x += sp) ctx.moveTo(x, pY - th2 * 0.5), ctx.lineTo(x + 3, pY + th2 * 0.5);
    ctx.stroke();
    glowAt(xR1, pY, H * 0.12, 0.35 * clamp(E.u * 2, 0, 1) + 0.1);
    glowAt(xR2, pY, H * 0.1, 0.25 * clamp(E.u * 2, 0, 1) + 0.08);
  }

  function flame(x, y, w, h, sway, a, foul) {
    const cols = foul > 0.3 ? FL_F : FL_N;
    for (let k = 0; k < 3; k++) {
      const s = FL_S[k];
      ctx.fillStyle = cols[k] + a * (k === 0 ? 0.75 : 0.95) + ")";
      ctx.beginPath(); ctx.moveTo(x - (w * s) / 2, y);
      ctx.quadraticCurveTo(x - w * s * 0.7, y - h * s * 0.55, x + sway * s, y - h * s);
      ctx.quadraticCurveTo(x + w * s * 0.7, y - h * s * 0.55, x + (w * s) / 2, y);
      ctx.fill();
    }
  }

  function drawF1() {
    const cx = CX.F1 * W, hw = 0.075 * W, x0 = cx - hw, x1 = cx + hw, top = pY - 0.2 * H, bot = fY;
    const wy0 = pY - 0.05 * H, wy1 = pY + 0.05 * H;
    const path = () => { ctx.beginPath(); ctx.rect(x0, top, hw * 2, bot - top); ctx.rect(x0 + hw * 0.12, wy0, hw * 1.88, wy1 - wy0); };
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "#2b1d19"); g.addColorStop(0.5, "#3b2822"); g.addColorStop(1, "#241815");
    ctx.fillStyle = g; path(); ctx.fill("evenodd");
    ctx.save(); path(); ctx.clip("evenodd");
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let y = top; y < bot; y += H * 0.03) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke(); ctx.restore();
    // glow in the slab window
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(255,${(90 + 90 * E.heat) | 0},30,${0.2 * E.heat})`; ctx.fillRect(x0 + hw * 0.12, wy0, hw * 1.88, wy1 - wy0);
    ctx.restore();
    glowAt(cx, pY, hw * 1.1, 0.35 * E.heat);
    // bands, roof, chimney
    ctx.fillStyle = "rgba(0,0,0,.4)";
    for (let k = 1; k < 4; k++) ctx.fillRect(x0 + (hw * 2 * k) / 4 - 2, top, 4, bot - top);
    ctx.fillStyle = "#1a1210"; ctx.fillRect(x0 - 0.005 * W, top - 0.012 * H, hw * 2 + 0.01 * W, 0.016 * H);
    ctx.fillStyle = "#2a201d"; ctx.fillRect(cx - hw * 0.55, top - 0.1 * H, 0.016 * W, 0.1 * H);
    ctx.fillStyle = "#1a1210"; ctx.fillRect(cx - hw * 0.55 - 3, top - 0.1 * H, 0.016 * W + 6, 5);
    // burners along the lower front
    const n = 5, by = bot - 0.03 * H, foul = E.foul;
    const bh = H * (0.03 + 0.07 * clamp(E.fuelI * E.heat, 0.2, 1.6));
    for (let i = 0; i < n; i++) {
      const x = x0 + hw * 0.22 + ((i + 0.5) / n) * hw * 1.7;
      ctx.fillStyle = "#14100f"; rr(x - 0.012 * W, by - 0.004 * H, 0.024 * W, 0.034 * H, 3); ctx.fill();
      let a = 1, sway = Math.sin(t * 9 + i * 1.7) * W * 0.003, hh = bh * (0.85 + 0.15 * Math.sin(t * 13 + i * 2.3));
      if (foul > 0.05) {
        a = 1 - foul * 0.6 * (0.5 + 0.5 * Math.sin(t * 23 + i * 5));
        if (Math.sin(t * 17 + i * 3.1) + Math.sin(t * 7.3 + i) < -1.9 + foul * 1.2) hh *= 0.25;
      }
      flame(x, by, 0.02 * W, hh, sway, a, foul);
      glowAt(x, by - hh * 0.5, hh * 0.9, 0.35 * a);
      if (foul > 0.1 && rnd() < foul * 0.15) spawn(1, x, by - hh, (rnd() - 0.5) * W * 0.01, -H * 0.1, 1.5, H * 0.012);
    }
  }

  function roll(cx, cy, r, a, hubGlow) {
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, "#9aa3ad"); g.addColorStop(0.5, "#5b646e"); g.addColorStop(1, "#262c34");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#0e1217"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.beginPath();
    for (let k = 0; k < 4; k++) { const an = a + (k * Math.PI) / 2; ctx.moveTo(cx + Math.cos(an) * r * 0.4, cy + Math.sin(an) * r * 0.4); ctx.lineTo(cx + Math.cos(an) * r * 0.95, cy + Math.sin(an) * r * 0.95); }
    ctx.stroke();
    ctx.fillStyle = "#1b2027"; ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, TAU); ctx.fill();
    if (hubGlow > 0.02) {
      glowAt(cx, cy, r * 1.1, hubGlow);
      ctx.fillStyle = `rgba(255,70,30,${0.9 * hubGlow})`; ctx.beginPath(); ctx.arc(cx, cy, r * 0.24, 0, TAU); ctx.fill();
    }
  }

  function stand(x, rw, rb, glow) {
    const ybT = pY - 2 * rw - rb, ybB = pY + 2 * rw + rb, fh = rb + 0.04 * H;
    const top = ybT - rb - 0.03 * H, bot = ybB + rb + 0.03 * H;
    roll(x, pY - rw, rw, rot, glow); roll(x, pY + rw, rw, -rot, glow * 0.5);
    roll(x, ybT, rb, -rot * rw / rb, glow * 0.3); roll(x, ybB, rb, rot * rw / rb, glow * 0.3);
    // housing plate (window cut-out so rolls stay visible)
    const g = ctx.createLinearGradient(x - fh, 0, x + fh, 0);
    g.addColorStop(0, "#3b434d"); g.addColorStop(0.5, "#2a3038"); g.addColorStop(1, "#1d2229");
    ctx.fillStyle = g; ctx.beginPath(); ctx.rect(x - fh, top, fh * 2, bot - top);
    ctx.rect(x - rb - 0.012 * H, ybT - rb - 0.012 * H, (rb + 0.012 * H) * 2, ybB - ybT + 2 * rb + 0.024 * H); ctx.fill("evenodd");
    ctx.fillStyle = "#171b21"; ctx.fillRect(x - fh * 1.25, bot, fh * 2.5, fY - bot);
    ctx.fillStyle = "#222830"; ctx.fillRect(x - 0.02 * W, top - 0.03 * H, 0.04 * W, 0.03 * H);
    ctx.fillStyle = "#5b646e"; ctx.fillRect(x - 0.008 * W, top - 0.05 * H, 0.016 * W, 0.02 * H);
    ctx.fillStyle = "#59626d";
    for (const [bx, by] of [[x - fh * 0.85, top + 6], [x + fh * 0.85, top + 6], [x - fh * 0.85, bot - 6], [x + fh * 0.85, bot - 6]]) { ctx.beginPath(); ctx.arc(bx, by, 2.5, 0, TAU); ctx.fill(); }
    // hubs on top of the plate (bearing chocks)
    return { ybT, ybB, rb, rw, top, bot, fh };
  }

  function drawR1() {
    const [sx, sy] = shakeOf(E.r1shake);
    ctx.save(); ctx.translate(sx, sy);
    const rw = 0.042 * H, rb = 0.066 * H, x = CX.R1 * W;
    stand(x, rw, rb, E.r1bear);
    // chock hubs glow over plate
    if (E.r1bear > 0.05) for (const cy of [pY - rw, pY + rw]) glowAt(x, cy, rw * 1.4, E.r1bear * 0.6);
    ctx.restore();
  }

  function gear(cx, cy, r, teeth, ang) {
    const s = TAU / teeth;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      const a = ang + i * s;
      ctx.lineTo(cx + Math.cos(a) * r * 1.2, cy + Math.sin(a) * r * 1.2);
      ctx.lineTo(cx + Math.cos(a + s * 0.4) * r * 1.2, cy + Math.sin(a + s * 0.4) * r * 1.2);
      ctx.lineTo(cx + Math.cos(a + s * 0.5) * r, cy + Math.sin(a + s * 0.5) * r);
      ctx.lineTo(cx + Math.cos(a + s * 0.9) * r, cy + Math.sin(a + s * 0.9) * r);
    }
    ctx.closePath(); ctx.fill();
  }

  function drawR2() {
    const [sx, sy] = shakeOf(E.r2shake);
    ctx.save(); ctx.translate(sx, sy);
    const rw = 0.036 * H, rb = 0.058 * H, x = CX.R2 * W;
    const s = stand(x, rw, rb, 0.05);
    // spindle to gearbox
    const gx0 = (CX.R2 + 0.05) * W, gx1 = (CX.R2 + 0.12) * W, gy0 = pY - 0.12 * H, gy1 = pY + 0.1 * H;
    ctx.fillStyle = "#4a525d"; ctx.fillRect(x + s.fh, pY - 0.009 * H, gx0 - x - s.fh, 0.018 * H);
    ctx.strokeStyle = "rgba(255,255,255,.3)"; ctx.beginPath();
    for (let k = 0; k < 3; k++) { const xx = x + s.fh + ((gx0 - x - s.fh) * (k + 1)) / 4 + Math.sin(rot * 2 + k) * 2; ctx.moveTo(xx, pY - 0.009 * H); ctx.lineTo(xx, pY + 0.009 * H); }
    ctx.stroke();
    // gearbox
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, "#3a3550"); g.addColorStop(1, "#1d1a2b");
    ctx.fillStyle = g; rr(gx0, gy0, gx1 - gx0, gy1 - gy0, 6); ctx.fill();
    ctx.strokeStyle = "rgba(167,139,250,.35)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#141220"; ctx.fillRect(gx0 + 6, gy1, 10, fY - gy1); ctx.fillRect(gx1 - 16, gy1, 10, fY - gy1);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    for (let k = 0; k < 4; k++) ctx.fillRect(gx0 + 8, gy0 + 8 + k * 6, (gx1 - gx0) * 0.5, 3);
    const gcx = gx0 + (gx1 - gx0) * 0.55, gcy = (gy0 + gy1) / 2 + 0.01 * H, gr = (gx1 - gx0) * 0.3;
    ctx.fillStyle = "#0b0a12"; ctx.beginPath(); ctx.arc(gcx, gcy, gr * 1.15, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgb(${(120 + 135 * E.r2oil) | 0},${(120 - 60 * E.r2oil) | 0},${(160 - 110 * E.r2oil) | 0})`;
    gear(gcx - gr * 0.4, gcy, gr * 0.5, 12, rot * 1.2); gear(gcx + gr * 0.42, gcy + gr * 0.1, gr * 0.42, 10, -rot * 1.44 + 0.3);
    if (E.r2oil > 0.05) glowAt(gcx, gcy, gr * 1.6, E.r2oil * 0.55);
    // oil gauge
    ctx.fillStyle = "#0b0a12"; ctx.fillRect(gx1 - 12, gy0 + 8, 6, 28);
    ctx.fillStyle = E.r2oil > 0.5 ? "#ef4444" : E.r2oil > 0.15 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(gx1 - 12, gy0 + 36 - 28 * clamp(0.35 + E.r2oil * 0.65, 0, 1), 6, 28 * clamp(0.35 + E.r2oil * 0.65, 0, 1));
    // heat shimmer
    if (E.r2oil > 0.1) {
      ctx.strokeStyle = `rgba(255,170,120,${0.18 * E.r2oil})`; ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        for (let i = 0; i <= 10; i++) { const xx = gx0 + ((gx1 - gx0) * i) / 10, yy = gy0 - 0.02 * H * (k + 1) + Math.sin(t * 5 + i * 0.9 + k) * 3; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawCB() {
    const x0 = 0.61 * W, x1 = 0.81 * W, my = pY - 0.22 * H, hy = pY - 0.15 * H;
    // water pit
    ctx.fillStyle = "#08161a"; ctx.fillRect(x0, pY + 0.08 * H, x1 - x0, fY - pY - 0.08 * H);
    ctx.strokeStyle = "rgba(52,211,153,.12)"; ctx.beginPath();
    for (let k = 0; k < 4; k++) { const y = pY + 0.12 * H + k * 0.03 * H; for (let i = 0; i <= 14; i++) { const xx = x0 + ((x1 - x0) * i) / 14, yy = y + Math.sin(t * 2 + i + k) * 1.5; i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); } }
    ctx.stroke();
    // end posts
    ctx.fillStyle = "#18262a"; ctx.fillRect(x0 - 6, my - 6, 8, fY - my + 6); ctx.fillRect(x1 - 2, my - 6, 8, fY - my + 6);
    // manifold
    const g = ctx.createLinearGradient(0, my, 0, my + 0.025 * H);
    g.addColorStop(0, "#3d6f68"); g.addColorStop(1, "#1d3b38");
    ctx.fillStyle = g; ctx.fillRect(x0 - 6, my, x1 - x0 + 12, 0.025 * H);
    // spray
    const dens = E.spray * (0.12 + 0.88 * clamp(E.u / 0.5, 0, 1));
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const xi = x0 + ((i + 0.5) / 6) * (x1 - x0), on = headerOn(i);
      ctx.fillStyle = "#2f5a55"; ctx.fillRect(xi - 2, my + 0.025 * H, 4, hy - my - 0.025 * H);
      ctx.fillStyle = "#3d6f68"; rr(xi - 0.016 * W, hy, 0.032 * W, 0.016 * H, 3); ctx.fill();
      ctx.fillStyle = "#1d3b38"; ctx.beginPath(); ctx.moveTo(xi - 5, hy + 0.016 * H); ctx.lineTo(xi + 5, hy + 0.016 * H); ctx.lineTo(xi, hy + 0.026 * H); ctx.fill();
      if (on && dens > 0.02) {
        const gc = ctx.createLinearGradient(0, hy, 0, pY);
        gc.addColorStop(0, `rgba(120,220,255,${0.28 * clamp(dens, 0, 1)})`); gc.addColorStop(1, "rgba(120,220,255,0.02)");
        ctx.fillStyle = gc; ctx.beginPath(); ctx.moveTo(xi - 3, hy + 0.026 * H); ctx.lineTo(xi + 3, hy + 0.026 * H); ctx.lineTo(xi + 0.016 * W, pY - 0.008 * H); ctx.lineTo(xi - 0.016 * W, pY - 0.008 * H); ctx.fill();
        ctx.save(); ctx.setLineDash([5, 9]); ctx.lineDashOffset = -t * 90; ctx.strokeStyle = `rgba(190,240,255,${0.55 * clamp(dens, 0, 1)})`;
        for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(xi + k * 2, hy + 0.026 * H); ctx.lineTo(xi + k * 0.011 * W, pY - 0.008 * H); ctx.stroke(); }
        ctx.restore();
      }
    }
    // pressure dial
    const dx = x0 + 0.02 * W, dy = my - 0.03 * H, dr = Math.max(8, H * 0.028);
    ctx.fillStyle = "#0b1517"; ctx.beginPath(); ctx.arc(dx, dy, dr, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#3d6f68"; ctx.lineWidth = 2; ctx.stroke();
    const pr = tagOf("CB", "PumpPressure"), ratio = pr?.v != null ? clamp(pr.v / (pr.exp || pr.v || 1), 0, 1.3) : 1;
    const an = Math.PI * (0.8 + 1.4 * clamp(ratio / 1.3, 0, 1));
    ctx.strokeStyle = ratio < 0.75 ? "#ef4444" : "#a7f3d0"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx + Math.cos(an) * dr * 0.8, dy + Math.sin(an) * dr * 0.8); ctx.stroke();
  }

  function drawCL() {
    const cx = CX.CL * W, cy = pY + 0.16 * H, xC1 = 0.81 * W;
    const rMin = 0.045 * H, r = rMin + 0.065 * H * coilFrac, th2 = 0.011 * H;
    const wob = E.mis, ca = rot * 1.2;
    const ex = Math.cos(ca) * wob * H * 0.014, ey = Math.sin(ca) * wob * H * 0.014;
    const [sx, sy] = [Math.sin(t * 40) * wob * H * 0.002 * shakeMul * clamp(E.u * 3, 0, 1), 0];
    ctx.save(); ctx.translate(sx, sy);
    // pedestal
    ctx.fillStyle = "#1b2027"; ctx.fillRect(cx + 0.012 * W, cy - 0.1 * H, 0.032 * W, fY - cy + 0.1 * H);
    ctx.fillStyle = "#262c34"; ctx.fillRect(cx - 0.06 * W, fY - 0.04 * H, 0.11 * W, 0.04 * H);
    // strip -> coil
    const Tx = E.tex, Px = cx + ex - r * 0.55, Py = cy + ey - r * 0.83;
    const cpy = pY + Math.sin(t * 8) * E.flutter * H * 0.03 + (Py - pY) * 0.15, cpx = (xC1 + Px) / 2 + Math.sin(t * 6.3) * E.flutter * W * 0.004;
    ctx.save(); ctx.lineCap = "butt";
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.18; ctx.strokeStyle = tcol(Tx); ctx.lineWidth = th2 * 3;
    ctx.beginPath(); ctx.moveTo(xC1, pY); ctx.quadraticCurveTo(cpx, cpy, Px, Py); ctx.stroke();
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.strokeStyle = tcol(Tx); ctx.lineWidth = th2 * 0.9;
    ctx.beginPath(); ctx.moveTo(xC1, pY); ctx.quadraticCurveTo(cpx, cpy, Px, Py); ctx.stroke();
    ctx.restore();
    // coil
    const g = ctx.createRadialGradient(cx + ex, cy + ey, rMin, cx + ex, cy + ey, r);
    g.addColorStop(0, tcol(Tx - 140)); g.addColorStop(1, tcol(Tx - 20));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx + ex, cy + ey, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.28)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let rr2 = r - 0.008 * H; rr2 > rMin; rr2 -= 0.008 * H) { const k = rr2 / r; ctx.moveTo(cx + ex * k + rr2, cy + ey * k); ctx.arc(cx + ex * k, cy + ey * k, rr2, 0, TAU); }
    ctx.stroke();
    glowAt(cx + ex, cy + ey, r * 1.5, 0.25 * clamp((Tx - 450) / 300, 0, 1));
    // mandrel hub + marker
    ctx.fillStyle = "#59626d"; ctx.beginPath(); ctx.arc(cx, cy, rMin * 0.6, 0, TAU); ctx.fill();
    ctx.strokeStyle = "#1b2027"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ca) * rMin * 0.6, cy + Math.sin(ca) * rMin * 0.6); ctx.stroke();
    ctx.restore();
  }

  function drawFailedAndGlitch() {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], f = FL[a], x0 = HIT[a][0] * W, x1 = HIT[a][1] * W;
      if (f.failed) {
        const s = Math.sin(t * 20) > 0 ? 1 : 0.3;
        ctx.fillStyle = `rgba(255,30,60,${0.05 + 0.13 * s})`; ctx.fillRect(x0, H * 0.28, x1 - x0, fY - H * 0.28 + 4);
      }
      if (f.glitch) {
        const x = x1 - 22, y = H * 0.27;
        ctx.save(); ctx.globalAlpha = rnd() > 0.25 ? 1 : 0.35;
        ctx.fillStyle = "#0e141b"; rr(x - 15, y - 11, 30, 22, 4); ctx.fill();
        ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.2; ctx.stroke();
        for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x - 9, y + 6, 4 + k * 4, -1.4, -0.2); ctx.stroke(); }
        for (let k = 0; k < 14; k++) { ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.7})`; ctx.fillRect(x - 13 + ((rnd() * 26) | 0), y - 9 + ((rnd() * 18) | 0), 2, 2); }
        ctx.restore();
      }
    }
  }

  function drawOverlays() {
    if (E.dim > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${0.38 * E.dim})`; ctx.fillRect(0, 0, W, H);
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
      g.addColorStop(0, "rgba(120,0,10,0)"); g.addColorStop(1, `rgba(200,10,30,${0.55 * E.dim * (0.8 + 0.2 * Math.sin(t * 3))})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (E.maint > 0.01 && stripePat) {
      ctx.save(); ctx.globalAlpha = 0.85 * E.maint; ctx.fillStyle = stripePat;
      ctx.fillRect(0, 0, W, H * 0.03); ctx.fillRect(0, H * 0.97, W, H * 0.03);
      ctx.globalAlpha = 0.06 * E.maint; ctx.fillStyle = "#f5b301"; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  function drawLabels() {
    const fs = clamp(H * 0.034, 10, 15), sel = store.selected;
    ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], cx = ((HIT[a][0] + HIT[a][1]) / 2) * W, y = H * 0.17 + Math.sin(t * 1.3 + i) * 2;
      const l1 = `${a} · ${SHORT[a]}`, l2 = `risk ${Math.round(P[a] * 100)}%`;
      const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 22, h = fs * 2.5, isSel = sel === a;
      ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y + h / 2); ctx.lineTo(cx, TOPY[a] * H); ctx.stroke(); ctx.setLineDash([]);
      if (isSel) glowAt(cx, y, w * 0.8, 0.25, glowS, 0.5);
      ctx.fillStyle = isSel ? "rgba(24,32,44,.96)" : (hover === a ? "rgba(18,24,34,.9)" : "rgba(10,13,18,.74)");
      rr(cx - w / 2, y - h / 2, w, h, 6); ctx.fill();
      ctx.strokeStyle = isSel ? COL[a] : "rgba(255,255,255,.14)"; ctx.lineWidth = isSel ? 2 : 1; ctx.stroke();
      ctx.fillStyle = COL[a]; ctx.fillRect(cx - w / 2 + 5, y - h / 2 + 6, 3, h - 12);
      ctx.fillStyle = isSel ? "#fff" : "#d5dde8"; ctx.fillText(l1, cx - w / 2 + 14, y - fs * 0.55);
      ctx.fillStyle = FL[a].failed ? "#ff2d55" : riskColor(P[a]); ctx.fillText(l2, cx - w / 2 + 14, y + fs * 0.6);
    }
  }

  const fmt = (v) => (v == null ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  function drawTooltip(a) {
    const asset = store.tick?.frame?.assets?.[a];
    if (!asset) return;
    const fs = clamp(H * 0.032, 10, 13), lines = [];
    for (const k in asset.tags) {
      const g = asset.tags[k];
      lines.push({ s: `${g.label || k}: ${fmt(g.v)} ${g.unit || ""}  (exp ${fmt(g.exp)})`, bad: g.glitch || g.dropout });
    }
    ctx.font = `500 ${fs}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const head = `${a} · ${asset.name || SHORT[a]}`;
    let w = ctx.measureText(head).width;
    for (const l of lines) w = Math.max(w, ctx.measureText(l.s).width);
    w += 22; const lh = fs * 1.5, h = lh * (lines.length + 1) + 14;
    const x = clamp(mouse.x + 16, 4, W - w - 4), y = clamp(mouse.y + 16, 4, H - h - 4);
    ctx.fillStyle = "rgba(10,14,20,.94)"; rr(x, y, w, h, 8); ctx.fill();
    ctx.strokeStyle = COL[a]; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = COL[a]; ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`; ctx.fillText(head, x + 11, y + 7 + lh / 2);
    ctx.font = `500 ${fs}px "Segoe UI", system-ui, sans-serif`;
    lines.forEach((l, i) => { ctx.fillStyle = l.bad ? "#fbbf24" : "#cfd8e3"; ctx.fillText(l.s, x + 11, y + 7 + lh * (i + 1.5)); });
  }

  // ---- interaction
  function hitTest(x, y) {
    if (y < H * 0.1) return null;
    const fx = x / W;
    for (let i = 0; i < ASSET_ORDER.length; i++) { const a = ASSET_ORDER[i]; if (fx >= HIT[a][0] && fx <= HIT[a][1]) return a; }
    return null;
  }
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    const h = hitTest(mouse.x, mouse.y);
    if (h !== hover) { hover = h; canvas.style.cursor = h ? "pointer" : "default"; }
  });
  canvas.addEventListener("pointerleave", () => { hover = null; canvas.style.cursor = "default"; });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    store.select(hitTest(e.clientX - r.left, e.clientY - r.top));
  });

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts; t += dt;
    try { update(dt); draw(); } catch (err) { console.error("mill", err); }
  }

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => resize()).observe(parent);
  else window.addEventListener("resize", resize);
  resize();
  raf = requestAnimationFrame(frame);

  return { resize };
}
