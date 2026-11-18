// Sahayak hot-strip mill: photoreal 2.5D canvas view, F1 -> R1 -> R2 -> CB -> CL. No assets, no libs.
// One-point perspective (camera on the operator pulpit). The hall and all static equipment are pre-lit into cached
// layers on resize, so a frame only draws what moves: blackbody steel, rolls, flames, water, particles, a ¼-res
// emissive buffer for bloom / light spill, heat shimmer (row-slice displacement) and grading.
import { store, riskColor, ASSET_ORDER, ASSET_COLOR } from "./store.js";

const SHORT = { F1: "Furnace", R1: "Roughing", R2: "Finishing", CB: "Cooling", CL: "Coiler" };
const HIT = { F1: [0.01, 0.205], R1: [0.235, 0.365], R2: [0.385, 0.59], CB: [0.595, 0.825], CL: [0.835, 0.995] };
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;
const rnd = Math.random;

// incandescent steel: [°C, r, g, b, relative visible radiance]
const BB = [[450, 40, 6, 3, 0], [550, 92, 14, 6, 0.025], [650, 150, 32, 10, 0.09], [750, 196, 62, 18, 0.22], [850, 232, 102, 32, 0.42],
  [950, 248, 140, 54, 0.62], [1050, 255, 174, 86, 0.8], [1150, 255, 204, 128, 0.93], [1250, 255, 226, 172, 1]];
const bbo = [0, 0, 0, 0];
function bb(T) {
  let i = 0;
  while (i < BB.length - 2 && T > BB[i + 1][0]) i++;
  const A = BB[i], B = BB[i + 1], k = clamp((T - A[0]) / (B[0] - A[0]), 0, 1);
  for (let j = 0; j < 4; j++) bbo[j] = lerp(A[j + 1], B[j + 1], k);
  return bbo;
}
// steel surface at T: dark scaled steel lit by `lit`, plus its own (slightly muted) incandescence
function steel(T, lit, a = 1) {
  const e = bb(T), i = e[3] * 0.82, b = 46 * lit * (1 - i * 0.85);
  return `rgba(${clamp(b + e[0] * i, 0, 255) | 0},${clamp(b * 1.02 + e[1] * i, 0, 255) | 0},${clamp(b * 1.06 + e[2] * i, 0, 255) | 0},${a})`;
}
const glowCol = (T, a) => { const e = bb(T); return `rgba(${e[0] | 0},${e[1] | 0},${e[2] | 0},${clamp(a * e[3], 0, 1)})`; };
const rgb = (c, m = 1, a = 1) => `rgba(${clamp(c[0] * m, 0, 255) | 0},${clamp(c[1] * m, 0, 255) | 0},${clamp(c[2] * m, 0, 255) | 0},${a})`;

// muted industrial materials
const M = {
  paint: [76, 82, 90], dark: [46, 50, 56], chock: [60, 64, 70], shell: [74, 69, 65], refr: [122, 98, 80], gear: [66, 76, 70],
  frame: [62, 76, 80], metal: [124, 130, 136], conc: [64, 64, 62], gas: [138, 112, 50], duct: [100, 104, 108],
};

// ---- one-time procedural textures (shared by every mill instance)
function fbm(size, cells, seed, ax = 1, ay = 1, oct = 5) {
  const out = new Float32Array(size * size);
  let s = seed, amp = 1, tot = 0;
  const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let o = 0; o < oct; o++, amp *= 0.5) {
    const gx = Math.max(1, Math.round(cells * ax * 2 ** o)), gy = Math.max(1, Math.round(cells * ay * 2 ** o));
    const lat = new Float32Array(gx * gy);
    for (let i = 0; i < lat.length; i++) lat[i] = R();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * gy, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty), r0 = (iy % gy) * gx, r1 = ((iy + 1) % gy) * gx;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * gx, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx), c0 = ix % gx, c1 = (ix + 1) % gx;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx, b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * size + x] += amp * (a + (b - a) * sy);
      }
    }
    tot += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
function tex(size, fn) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d"), im = g.createImageData(size, size), d = im.data, p = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    fn(i, x, y, p);
    d[i * 4] = p[0]; d[i * 4 + 1] = p[1]; d[i * 4 + 2] = p[2]; d[i * 4 + 3] = p[3];
  }
  g.putImageData(im, 0, 0);
  return c;
}
const st = (n, k, o = 0.5) => clamp((n - 0.5) * k + o, 0, 1);
let TXC = null;
function textures() {
  if (TXC) return TXC;
  const n1 = fbm(256, 8, 7), n2 = fbm(256, 24, 11, 1, 1, 3), ns = fbm(256, 3, 23, 7, 0.35), nc = fbm(256, 10, 5), nk = fbm(256, 6, 31, 0.45, 1.6);
  const grime = tex(256, (i, x, y, p) => { p[0] = 20; p[1] = 17; p[2] = 15; p[3] = 115 * st(n1[i] + (n2[i] - 0.5) * 0.7, 3, 0.3); });
  const streak = tex(256, (i, x, y, p) => { p[0] = 34; p[1] = 24; p[2] = 17; p[3] = 130 * st(ns[i], 3.4, 0.25); });
  const conc = tex(256, (i, x, y, p) => {
    const v = st(nc[i] + (n2[i] - 0.5) * 0.6, 1.8) - 0.5, s = rnd() < 0.015 ? 0.25 : 0;
    p[0] = p[1] = p[2] = v > 0 ? 235 : 0; p[3] = Math.min(255, Math.abs(v) * 2 * 80 + s * 255);
  });
  const scale = tex(256, (i, x, y, p) => { p[0] = 22; p[1] = 15; p[2] = 12; p[3] = 190 * st(nk[i] + (n2[i] - 0.5) * 0.5, 3.4, 0.35); });
  const grain = tex(128, (i, x, y, p) => { const v = rnd(); p[0] = p[1] = p[2] = v > 0.5 ? 255 : 0; p[3] = Math.abs(v - 0.5) * 34; });
  const puff = (seed, col) => {
    const n = fbm(96, 3, seed, 1, 1, 4);
    return tex(96, (i, x, y, p) => {
      const d = Math.hypot(x - 47.5, y - 47.5) / 48, f = Math.max(0, 1 - d) ** 1.5;
      p[0] = col[0]; p[1] = col[1]; p[2] = col[2]; p[3] = 255 * clamp(f * 1.7 * (0.25 + st(n[i], 2.2) * 1.1) - 0.08, 0, 1);
    });
  };
  const steam = [puff(3, [226, 230, 233]), puff(9, [214, 220, 224])], smoke = [puff(5, [86, 80, 76]), puff(13, [70, 66, 64])];
  const soot = [puff(17, [30, 26, 25]), puff(19, [24, 21, 20])];
  // machined roll-end face: brushed (anisotropic) metal reads rotation without cartoon spokes
  const disc = document.createElement("canvas");
  disc.width = disc.height = 192;
  {
    const g = disc.getContext("2d"), r = 96;
    g.translate(r, r);
    let gr = g.createRadialGradient(0, 0, r * 0.78, 0, 0, r);
    gr.addColorStop(0, "#5c6269"); gr.addColorStop(0.45, "#a3aab1"); gr.addColorStop(0.8, "#3d4248"); gr.addColorStop(1, "#1b1e22");
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
    if (g.createConicGradient) {
      gr = g.createConicGradient(0.5, 0, 0);
      [["#6a7077", 0], ["#aab0b6", 0.1], ["#5c6268", 0.24], ["#8d939a", 0.38], ["#5f656c", 0.5], ["#b3b9bf", 0.6], ["#596066", 0.74], ["#899097", 0.88], ["#6a7077", 1]]
        .forEach(([c, o]) => gr.addColorStop(o, c));
    } else {
      gr = g.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
      gr.addColorStop(0, "#aab0b6"); gr.addColorStop(1, "#4d5359");
    }
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * 0.82, 0, TAU); g.fill();
    g.lineWidth = 1;
    for (let rr = r * 0.34; rr < r * 0.8; rr += 3) { g.strokeStyle = rr % 6 < 3 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)"; g.beginPath(); g.arc(0, 0, rr, 0, TAU); g.stroke(); }
    gr = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.32);
    gr.addColorStop(0, "#121417"); gr.addColorStop(0.75, "#2a2e33"); gr.addColorStop(1, "#4a5056");
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * 0.32, 0, TAU); g.fill();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU, bx = Math.cos(a) * r * 0.54, by = Math.sin(a) * r * 0.54;
      gr = g.createRadialGradient(bx - 2, by - 2, 0, bx, by, r * 0.07);
      gr.addColorStop(0, "#c4c9ce"); gr.addColorStop(1, "#2b2f33");
      g.fillStyle = gr; g.beginPath(); g.arc(bx, by, r * 0.065, 0, TAU); g.fill();
    }
    g.fillStyle = "#15171a"; g.fillRect(-r * 0.05, -r * 0.82, r * 0.1, r * 0.3);
    g.globalCompositeOperation = "source-atop"; g.globalAlpha = 0.55; g.drawImage(grime, -r, -r, 2 * r, 2 * r);
  }
  // muted hazard stripes for maintenance
  const haz = document.createElement("canvas");
  haz.width = haz.height = 28;
  {
    const o = haz.getContext("2d");
    o.fillStyle = "#a8812e"; o.fillRect(0, 0, 28, 28);
    o.fillStyle = "#1c1a16"; o.beginPath(); o.moveTo(0, 14); o.lineTo(14, 0); o.lineTo(28, 0); o.lineTo(0, 28); o.fill();
    o.beginPath(); o.moveTo(14, 28); o.lineTo(28, 14); o.lineTo(28, 28); o.fill();
  }
  return (TXC = { grime, streak, conc, scale, grain, steam, smoke, soot, disc, haz });
}

export function createMill(canvas) {
  const ctx = canvas.getContext("2d");
  const parent = canvas.parentElement || canvas;
  const RM = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const shakeMul = RM ? 0.25 : 1;
  const TX = textures();
  const mk = () => document.createElement("canvas");
  const emi = mk(), ex = emi.getContext("2d"), bl1 = mk(), b1 = bl1.getContext("2d"), bl2 = mk(), b2 = bl2.getContext("2d");
  const scr = mk(), sc = scr.getContext("2d");
  const FILTER = typeof b1.filter === "string";
  const grainPat = ctx.createPattern(TX.grain, "repeat"), scalePat = ctx.createPattern(TX.scale, "repeat"), hazPat = ctx.createPattern(TX.haz, "repeat");
  const canMat = typeof DOMMatrix !== "undefined" && !!scalePat?.setTransform;
  const pat = (g, name) => g["__" + name] || (g["__" + name] = g.createPattern(TX[name], "repeat"));

  let W = 800, H = 300, dpr = 1, U = 300, D = 20, es = 0.25;
  let pY = 0, fY = 0, VX = 0, VY = 0, FD = 1, Z0 = 0, Z1 = 0, ZW = 0, thS = 0, th1 = 0, th2 = 0;
  let t = 0, last = 0, hover = null, rot = 0, flow = 0;
  const mouse = { x: 0, y: 0 };
  const kz = (z) => FD / (FD + z);
  const X = (x, z) => VX + (x - VX) * kz(z);
  const Y = (y, z) => VY + (y - VY) * kz(z);
  let F, R1, R2, GB, CB, CL, ANCH = {}, L = {};

  // ---- eased scene state
  const KEYS = ["u", "heat", "fuelI", "foul", "r1shake", "r1bear", "r2shake", "r2oil", "spray", "sputter", "tex", "mis", "flutter", "dim", "maint", "ft", "sx"];
  const E = { u: 0.18, heat: 0.8, fuelI: 1, foul: 0, r1shake: 0, r1bear: 0, r2shake: 0, r2oil: 0, spray: 0.6, sputter: 0, tex: 620, mis: 0, flutter: 0, dim: 0, maint: 0, ft: 1250, sx: 1180 };
  const T = Object.assign({}, E);
  const RISK = { F1: 0, R1: 0, R2: 0, CB: 0, CL: 0 };
  const FL = {};
  ASSET_ORDER.forEach((a) => (FL[a] = { alert: false, over: false, failed: false, glitch: false }));
  let coilFrac = 0.3, hasTick = false;

  // ---- particles (struct of arrays). types: 0 spark, 1 soot, 2 steam, 3 water, 4 smoke
  const N = RM ? 180 : 520;
  const px = new Float32Array(N), py = new Float32Array(N), pvx = new Float32Array(N), pvy = new Float32Array(N);
  const plf = new Float32Array(N), pmx = new Float32Array(N), psz = new Float32Array(N), pty = new Uint8Array(N), pvr = new Uint8Array(N);
  let cur = 0;
  function spawn(type, x, y, vx, vy, life, size) {
    for (let k = 0; k < N; k++) {
      const i = (cur + k) % N;
      if (plf[i] <= 0) {
        px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy; plf[i] = life; pmx[i] = life; psz[i] = size; pty[i] = type; pvr[i] = (rnd() * 2) | 0; cur = i + 1;
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
      if (ty === 0) { pvy[i] += U * 2.2 * dt; if (py[i] > fY && pvy[i] > 0) { pvy[i] *= -0.25; pvx[i] *= 0.5; } }
      else if (ty === 3) pvy[i] += U * 1.6 * dt;
      else { psz[i] += dt * U * (ty === 2 ? 0.05 : 0.035); pvx[i] += (rnd() - 0.5) * U * 0.06 * dt + U * 0.004 * dt; pvy[i] *= 1 - 0.25 * dt; }
      px[i] += pvx[i] * dt; py[i] += pvy[i] * dt;
    }
  }
  function drawParticles() {
    ctx.save();
    for (let ty = 1; ty <= 4; ty++) {
      if (ty === 3) continue;
      const spr = ty === 1 ? TX.soot : ty === 2 ? TX.steam : TX.smoke, ba = ty === 2 ? 0.3 : ty === 1 ? 0.6 : 0.42;
      for (let i = 0; i < N; i++) {
        if (plf[i] <= 0 || pty[i] !== ty) continue;
        const a = plf[i] / pmx[i], s = psz[i];
        ctx.globalAlpha = ba * a * Math.min(1, (1 - a) * 5 + 0.15);
        ctx.drawImage(spr[pvr[i]], px[i] - s, py[i] - s, s * 2, s * 2);
      }
    }
    ctx.globalAlpha = 0.55; ctx.strokeStyle = "rgba(200,220,232,.9)"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      if (plf[i] <= 0 || pty[i] !== 3) continue;
      ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - pvx[i] * 0.02, py[i] - pvy[i] * 0.02);
    }
    ctx.stroke();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "lighter"; ctx.lineWidth = 1.2; ctx.strokeStyle = "rgba(255,206,130,.95)";
    ctx.beginPath(); ex.beginPath();
    for (let i = 0; i < N; i++) {
      if (plf[i] <= 0 || pty[i] !== 0) continue;
      ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - pvx[i] * 0.03, py[i] - pvy[i] * 0.03);
      ex.moveTo(px[i], py[i]); ex.lineTo(px[i] - pvx[i] * 0.03, py[i] - pvy[i] * 0.03);
    }
    ctx.stroke();
    ex.lineWidth = 3; ex.strokeStyle = "rgba(255,170,80,.9)"; ex.stroke();
    ctx.restore();
  }

  // ---- geometry helpers (add sub-paths to the current path of g)
  function front(g, x0, y0, x1, y1, z) { const a = X(x0, z), b = Y(y0, z); g.rect(a, b, X(x1, z) - a, Y(y1, z) - b); }
  function top(g, x0, x1, y, z0, z1) { g.moveTo(X(x0, z0), Y(y, z0)); g.lineTo(X(x1, z0), Y(y, z0)); g.lineTo(X(x1, z1), Y(y, z1)); g.lineTo(X(x0, z1), Y(y, z1)); g.closePath(); }
  function side(g, x, y0, y1, z0, z1) { g.moveTo(X(x, z0), Y(y0, z0)); g.lineTo(X(x, z1), Y(y0, z1)); g.lineTo(X(x, z1), Y(y1, z1)); g.lineTo(X(x, z0), Y(y1, z0)); g.closePath(); }
  function grime(g, a, rule = "nonzero", streak = 0.6) {
    if (a <= 0) return;
    g.save(); g.globalAlpha = a; g.fillStyle = pat(g, "grime"); g.fill(rule);
    if (streak) { g.globalAlpha = a * streak; g.fillStyle = pat(g, "streak"); g.fill(rule); }
    g.restore();
  }
  function metal(gr, c, k = 1) {
    gr.addColorStop(0, rgb(c, 0.5 * k)); gr.addColorStop(0.16, rgb(c, 1.05 * k)); gr.addColorStop(0.3, rgb(c, 1.45 * k));
    gr.addColorStop(0.46, rgb(c, 0.98 * k)); gr.addColorStop(0.8, rgb(c, 0.55 * k)); gr.addColorStop(1, rgb(c, 0.32 * k));
    return gr;
  }
  // lit box: side face toward the vanishing point, top face, front face (optionally with a window `hole`)
  function box(g, x0, x1, y0, y1, z0, z1, c, o = {}) {
    const gm = o.grime ?? 0.55;
    if (o.hole && o.holeFill !== false) {
      const [hx0, hy0, hx1, hy1] = o.hole;
      g.beginPath(); front(g, hx0, hy0, hx1, hy1, z1); g.fillStyle = rgb(o.holeFill || M.dark, 0.45); g.fill();
      const sx = hx0 < VX ? hx0 : hx1 > VX ? hx1 : null;
      if (sx !== null) { g.beginPath(); side(g, sx, hy0, hy1, z0, z1); g.fillStyle = rgb(c, 0.42); g.fill(); }
      g.beginPath(); top(g, hx0, hx1, hy1, z0, z1); g.fillStyle = rgb(c, 0.95); g.fill();
    }
    const sx = x1 < VX ? x1 : x0 > VX ? x0 : null;
    if (sx !== null) {
      g.beginPath(); side(g, sx, y0, y1, z0, z1);
      const lg = g.createLinearGradient(0, Y(y0, z0), 0, Y(y1, z0));
      lg.addColorStop(0, rgb(c, 0.74)); lg.addColorStop(1, rgb(c, 0.36));
      g.fillStyle = lg; g.fill(); grime(g, gm * 0.8);
    }
    g.beginPath(); top(g, x0, x1, y0, z0, z1);
    g.fillStyle = rgb(c, o.lt ?? 1.3); g.fill(); grime(g, gm * 0.6, "nonzero", 0);
    g.beginPath(); front(g, x0, y0, x1, y1, z0);
    if (o.hole) front(g, o.hole[0], o.hole[1], o.hole[2], o.hole[3], z0);
    const fx0 = X(x0, z0), fx1 = X(x1, z0), fy0 = Y(y0, z0), fy1 = Y(y1, z0);
    let lg = g.createLinearGradient(0, fy0, 0, fy1);
    lg.addColorStop(0, rgb(c, 1.08)); lg.addColorStop(0.3, rgb(c, 0.94)); lg.addColorStop(1, rgb(c, 0.6));
    g.fillStyle = lg; g.fill("evenodd");
    lg = g.createLinearGradient(fx0, 0, fx1, 0);
    lg.addColorStop(0, "rgba(255,240,220,0)"); lg.addColorStop(0.28, "rgba(255,240,220,0.07)"); lg.addColorStop(0.55, "rgba(255,240,220,0)"); lg.addColorStop(1, "rgba(0,0,0,0.14)");
    g.fillStyle = lg; g.fill("evenodd");
    grime(g, gm, "evenodd");
    g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.moveTo(fx0 + 1, fy0 + 0.5); g.lineTo(fx1 - 1, fy0 + 0.5);
    g.strokeStyle = "rgba(255,244,228,0.18)"; g.stroke();
  }
  // cylinder along depth (rolls, headers, coil body): shaded hull + end cap
  function cylZ(g, x, y, r, z0, z1, c, cap = true, k = 1) {
    const ax = X(x, z0), ay = Y(y, z0), ar = r * kz(z0), bx = X(x, z1), by = Y(y, z1), br = r * kz(z1);
    let nx = -(by - ay), ny = bx - ax;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    if (ny > 0) { nx = -nx; ny = -ny; }
    g.beginPath();
    g.moveTo(ax + nx * ar, ay + ny * ar); g.lineTo(bx + nx * br, by + ny * br); g.lineTo(bx - nx * br, by - ny * br); g.lineTo(ax - nx * ar, ay - ny * ar); g.closePath();
    g.moveTo(bx + br, by); g.arc(bx, by, br, 0, TAU);
    g.fillStyle = metal(g.createLinearGradient(ax + nx * ar, ay + ny * ar, ax - nx * ar, ay - ny * ar), c, k); g.fill();
    if (cap) {
      g.beginPath(); g.arc(ax, ay, ar, 0, TAU);
      const gr = g.createRadialGradient(ax - ar * 0.3, ay - ar * 0.3, 0, ax, ay, ar);
      gr.addColorStop(0, rgb(c, 1.05 * k)); gr.addColorStop(1, rgb(c, 0.45 * k));
      g.fillStyle = gr; g.fill(); g.strokeStyle = "rgba(0,0,0,.45)"; g.lineWidth = 1; g.stroke();
    }
  }
  function pipeX(g, x0, x1, y, z, r, c, k = 1) {
    const ya = Y(y - r, z), yb = Y(y + r, z), xa = X(x0, z), xb = X(x1, z);
    g.fillStyle = metal(g.createLinearGradient(0, ya, 0, yb), c, k); g.fillRect(xa, ya, xb - xa, yb - ya);
  }
  function pipeY(g, x, y0, y1, z, r, c, k = 1) {
    const xa = X(x - r, z), xb = X(x + r, z), ya = Y(y0, z), yb = Y(y1, z);
    g.fillStyle = metal(g.createLinearGradient(xa, 0, xb, 0), c, k); g.fillRect(xa, ya, xb - xa, yb - ya);
    const c0 = Y(y0, z - r), c1 = Y(y0, z + r);
    g.beginPath(); g.ellipse((xa + xb) / 2, (c0 + c1) / 2, (xb - xa) / 2, Math.max(0.5, (c0 - c1) / 2), 0, 0, TAU);
    g.fillStyle = rgb(c, 1.15 * k); g.fill(); g.strokeStyle = "rgba(0,0,0,.4)"; g.lineWidth = 1; g.stroke();
  }
  function bolt(g, x, y, r) {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
    gr.addColorStop(0, "#b9bfc5"); gr.addColorStop(1, "#24272b");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  function sprite(x0, y0, x1, y1, paint) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    const c = mk(), w = Math.max(1, Math.ceil((x1 - x0) * dpr)), h = Math.max(1, Math.ceil((y1 - y0) * dpr));
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
    paint(g);
    return { c, x: x0, y: y0, w: w / dpr, h: h / dpr };
  }
  const blit = (s, dx = 0, dy = 0) => ctx.drawImage(s.c, s.x + dx, s.y + dy, s.w, s.h);

  // ---- layout
  function layout() {
    U = Math.min(H, W * 0.3);
    pY = H * 0.575; fY = H * 0.9;
    VX = W * 0.5; VY = -H * 0.32; FD = W * 1.5;
    Z0 = W * 0.022; D = clamp(U * 0.15, 6, W * 0.04); Z1 = Z0 + D; ZW = W * 0.6;
    thS = U * 0.034; th1 = U * 0.019; th2 = U * 0.009;
    const stand = (cx, rw, rb, pw, th) => {
      const wh = rb + U * 0.012, wy0 = pY - th / 2 - 2 * rw - 2 * rb - U * 0.014, wy1 = pY + th / 2 + 2 * rw + 2 * rb + U * 0.014;
      return { cx, rw, rb, pw, th, wh, wy0, wy1, ox0: cx - wh - pw, ox1: cx + wh + pw, top: wy0 - U * 0.06,
        hf0: Z0 - 0.55 * D, hf1: Z0 - 0.15 * D, hb0: Z1 + 0.15 * D, hb1: Z1 + 0.55 * D };
    };
    R1 = stand(W * 0.3, U * 0.036, U * 0.062, U * 0.07, th1);
    R2 = stand(W * 0.445, U * 0.03, U * 0.052, U * 0.06, th2);
    F = { x0: W * 0.018, x1: W * 0.19, yT: pY - U * 0.25, yB: fY - U * 0.02, z0: Z0 - 0.9 * D, z1: Z1 + 1.4 * D };
    F.dz0 = Z0 - 0.2 * D; F.dz1 = Z1 + 0.2 * D; F.dy0 = pY - thS / 2 - U * 0.045; F.dy1 = pY + thS / 2 + U * 0.02;
    F.ports = [];
    {
      const n = 6, step = (F.x1 - F.x0 - W * 0.02) / (n - 1);
      F.bs = []; for (let i = 0; i < n; i++) F.bs.push(F.x0 + W * 0.01 + i * step);
      for (const ry of [pY - U * 0.155, pY + U * 0.115]) for (let i = 0; i < n - 1; i++) F.ports.push({ x: F.bs[i] + step / 2, y: ry, z: F.z0 - U * 0.012 });
      F.sx = F.x0 + W * 0.028; F.sz = (F.z0 + F.z1) / 2; F.sr = U * 0.034;
    }
    GB = { x0: W * 0.5, x1: W * 0.578, y0: pY - U * 0.12, z0: Z1 + 1.2 * D, z1: Z1 + 3.4 * D };
    GB.ym = GB.y0 + (fY - GB.y0) * 0.36;
    CB = { xa: W * 0.6, xb: W * 0.815, hy: pY - U * 0.17, hr: U * 0.012, my: pY - U * 0.245, mr: U * 0.022, n: 8 };
    CB.hx = []; for (let i = 0; i < CB.n; i++) CB.hx.push(CB.xa + W * 0.012 + ((CB.xb - CB.xa - W * 0.024) * i) / (CB.n - 1));
    CL = { px: W * 0.852, pr: U * 0.024, cx: W * 0.918, cy: pY + U * 0.16, rMin: U * 0.042, rMax: U * 0.11 };
    CL.pwh = CL.pr * 1.25; CL.ptop = pY - th2 / 2 - 2 * CL.pr - U * 0.05;
    ANCH = { F1: Y(F.yT, F.z0) - U * 0.02, R1: Y(R1.top, R1.hf0) - U * 0.06, R2: Y(R2.top, R2.hf0) - U * 0.06, CB: Y(CB.my - CB.mr, Z1) - U * 0.03, CL: Y(CL.ptop, Z0) - U * 0.02 };
  }

  // ---- static painters (run on resize)
  function paintHall(g) {
    const yJ = Y(fY, ZW);
    let lg = g.createLinearGradient(0, 0, 0, yJ);
    lg.addColorStop(0, "#13171b"); lg.addColorStop(0.6, "#1b1f23"); lg.addColorStop(1, "#24272a");
    g.fillStyle = lg; g.fillRect(0, 0, W, yJ + 1);
    const rib = Math.max(4, W * 0.006);
    g.fillStyle = "rgba(255,255,255,0.022)"; for (let x = 0; x < W; x += rib) g.fillRect(x, 0, rib * 0.4, yJ);
    g.fillStyle = "rgba(0,0,0,0.14)"; for (let x = rib * 0.6; x < W; x += rib) g.fillRect(x, 0, rib * 0.18, yJ);
    g.beginPath(); g.rect(0, 0, W, yJ); grime(g, 0.3, "nonzero", 1.2);
    // clerestory windows (dim daylight through dirty glass)
    const bay = W * 0.165, wy0 = H * 0.03, wy1 = H * 0.125;
    for (let i = -1; i < 7; i++) {
      const bx = bay * (i + 0.5) + bay * 0.14, bw = bay * 0.72;
      lg = g.createLinearGradient(0, wy0, 0, wy1);
      lg.addColorStop(0, "#56616b"); lg.addColorStop(1, "#38414a");
      g.fillStyle = lg; g.fillRect(bx, wy0, bw, wy1 - wy0);
      g.beginPath(); g.rect(bx, wy0, bw, wy1 - wy0); grime(g, 0.9, "nonzero", 0.8);
      g.strokeStyle = "#181b1f"; g.lineWidth = Math.max(1, W * 0.0016); g.beginPath();
      for (let k = 0; k <= 6; k++) { const x = bx + (bw * k) / 6; g.moveTo(x, wy0); g.lineTo(x, wy1); }
      g.moveTo(bx, (wy0 + wy1) / 2); g.lineTo(bx + bw, (wy0 + wy1) / 2); g.rect(bx, wy0, bw, wy1 - wy0); g.stroke();
    }
    // roof girder / crane runway
    const gy0 = H * 0.15, gy1 = H * 0.185;
    lg = g.createLinearGradient(0, gy0, 0, gy1);
    lg.addColorStop(0, "#30363c"); lg.addColorStop(0.2, "#262b30"); lg.addColorStop(1, "#15181b");
    g.fillStyle = lg; g.fillRect(0, gy0, W, gy1 - gy0);
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, gy1, W, H * 0.008);
    for (let x = W * 0.01; x < W; x += W * 0.022) bolt(g, x, gy0 + (gy1 - gy0) * 0.3, Math.max(1, H * 0.0035));
    // building columns (I-sections)
    for (let i = 0; i < 7; i++) {
      const x = bay * (i + 0.5), cw = W * 0.014;
      lg = g.createLinearGradient(x - cw / 2, 0, x + cw / 2, 0);
      lg.addColorStop(0, "#1a1d21"); lg.addColorStop(0.14, "#3b4147"); lg.addColorStop(0.24, "#22262a"); lg.addColorStop(0.76, "#1f2327"); lg.addColorStop(0.86, "#32373d"); lg.addColorStop(1, "#141619");
      g.fillStyle = lg; g.fillRect(x - cw / 2, 0, cw, yJ);
    }
    // wall services: insulated pipes + cable tray
    const band = (y, r, c) => { g.fillStyle = metal(g.createLinearGradient(0, y - r, 0, y + r), c, 0.8); g.fillRect(0, y - r, W, 2 * r); };
    band(H * 0.265, H * 0.009, [92, 96, 100]); band(H * 0.29, H * 0.006, [80, 74, 60]);
    g.fillStyle = "#1a1d20"; g.fillRect(0, H * 0.31, W, H * 0.006);
    // floor: concrete in perspective
    lg = g.createLinearGradient(0, yJ, 0, H);
    lg.addColorStop(0, "#25272a"); lg.addColorStop(0.45, "#2c2d2f"); lg.addColorStop(1, "#1b1c1e");
    g.fillStyle = lg; g.fillRect(0, yJ, W, H - yJ);
    g.save(); g.globalAlpha = 0.32; g.fillStyle = pat(g, "conc"); g.fillRect(0, yJ, W, H - yJ); g.restore();
    g.strokeStyle = "rgba(0,0,0,.28)"; g.lineWidth = 1; g.beginPath();
    for (let x = -W; x < W * 2; x += W * 0.085) { g.moveTo(X(x, -W * 0.2), Y(fY, -W * 0.2)); g.lineTo(X(x, ZW), Y(fY, ZW)); }
    for (let z = -W * 0.1; z < ZW; z += W * 0.07) { const y = Y(fY, z); g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    // trench under the line + painted walkway lines
    g.beginPath(); top(g, -W, W * 2, fY, Z0 - 0.6 * D, Z1 + 0.6 * D); g.fillStyle = "rgba(6,7,8,.42)"; g.fill();
    for (const z of [Z0 - 3.4 * D, Z1 + 5 * D]) {
      g.beginPath(); top(g, -W, W * 2, fY, z, z + D * 0.12); g.fillStyle = "rgba(150,118,44,.45)"; g.fill();
    }
    // oil stains under the stands, wet sheen under the cooling bank
    for (const x of [R1.cx, R2.cx, GB.x0 + W * 0.03]) {
      const cx = X(x, Z0 - 1.5 * D), cy = Y(fY, Z0 - 1.5 * D);
      g.save(); g.translate(cx, cy); g.scale(1, 0.18);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, U * 0.16); gr.addColorStop(0, "rgba(0,0,0,.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, U * 0.16, 0, TAU); g.fill(); g.restore();
    }
    {
      const cx = X((CB.xa + CB.xb) / 2, Z0 - 2 * D), cy = Y(fY, Z0 - 2 * D);
      g.save(); g.translate(cx, cy); g.scale(1, 0.12);
      const rr = (CB.xb - CB.xa) * 0.6, gr = g.createRadialGradient(0, 0, 0, 0, 0, rr);
      gr.addColorStop(0, "rgba(140,160,172,.10)"); gr.addColorStop(1, "rgba(140,160,172,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rr, 0, TAU); g.fill(); g.restore();
    }
  }

  function paintTable(g) {
    const rr = U * 0.011, za = Z0 - 0.35 * D, zb = Z1 + 0.35 * D;
    const segs = [[F.x1 + W * 0.004, R1.ox0, thS], [R1.ox1, R2.ox0, th1], [R2.ox1, CL.px - CL.pwh - U * 0.03, th2]];
    for (const [a, b, th] of segs) {
      const yc = pY + th / 2 + rr, by = yc + rr * 0.5;
      box(g, a, b, by, by + U * 0.028, zb + 0.05 * D, zb + 0.25 * D, M.dark, { grime: 0.7 });
      const pitch = Math.max(rr * 3, W * 0.013);
      for (let x = a + pitch / 2; x < b; x += pitch) cylZ(g, x, yc, rr, za, zb, M.metal, true, 0.85);
      for (let x = a + W * 0.012; x < b; x += W * 0.07) box(g, x, x + U * 0.012, by + U * 0.028, fY, za - 0.25 * D, za - 0.05 * D, M.dark, { grime: 0.8 });
      box(g, a, b, by, by + U * 0.028, za - 0.25 * D, za - 0.05 * D, M.dark, { grime: 0.7 });
    }
  }

  function paintF1(g) {
    const { x0, x1, yT, yB, z0, z1 } = F;
    box(g, x0 - W * 0.005, x1 + W * 0.005, yB, fY, z0 - 0.4 * D, z1 + 0.2 * D, M.conc, { grime: 0.6, lt: 1.15 });
    // stack (behind the roof line)
    pipeY(g, F.sx, H * 0.2, yT, F.sz, F.sr, [84, 78, 72], 0.9);
    g.save(); g.beginPath(); g.rect(X(F.sx - F.sr, F.sz), Y(H * 0.2, F.sz), 2 * F.sr * kz(F.sz), Y(yT, F.sz) - Y(H * 0.2, F.sz));
    const sg = g.createLinearGradient(0, Y(H * 0.2, F.sz), 0, Y(yT, F.sz));
    sg.addColorStop(0, "rgba(14,12,11,.85)"); sg.addColorStop(0.35, "rgba(14,12,11,.25)"); sg.addColorStop(1, "rgba(14,12,11,0)");
    g.fillStyle = sg; g.fill(); grime(g, 0.8); g.restore();
    for (const y of [H * 0.24, H * 0.3]) pipeX(g, F.sx - F.sr * 1.12, F.sx + F.sr * 1.12, y, F.sz, U * 0.004, [70, 66, 62]);
    // shell
    box(g, x0, x1, yT, yB, z0, z1, M.shell, { grime: 0.8 });
    g.save(); g.beginPath(); front(g, x0, yT, x1, yB, z0); g.clip();
    g.strokeStyle = "rgba(0,0,0,.32)"; g.lineWidth = 1; g.beginPath();
    for (let y = yT + U * 0.05; y < yB; y += U * 0.05) { g.moveTo(X(x0, z0), Y(y, z0)); g.lineTo(X(x1, z0), Y(y, z0)); }
    g.stroke(); g.strokeStyle = "rgba(255,240,220,.06)"; g.beginPath();
    for (let y = yT + U * 0.05 + 1; y < yB; y += U * 0.05) { g.moveTo(X(x0, z0), Y(y, z0)); g.lineTo(X(x1, z0), Y(y, z0)); }
    g.stroke(); g.restore();
    // heat-tinted side (discharge end) + refractory door frame + raised door
    g.save(); g.beginPath(); side(g, x1, yT, yB, z0, z1); g.clip();
    let gr = g.createRadialGradient(X(x1, (F.dz0 + F.dz1) / 2), Y(pY, F.dz0), 0, X(x1, (F.dz0 + F.dz1) / 2), Y(pY, F.dz0), U * 0.2);
    gr.addColorStop(0, "rgba(120,70,40,.35)"); gr.addColorStop(1, "rgba(120,70,40,0)");
    g.fillStyle = gr; g.fillRect(X(x1, z0) - 2, 0, X(x1, z1) - X(x1, z0) + 4, H); g.restore();
    g.beginPath(); side(g, x1 + 0.01, F.dy0 - U * 0.012, F.dy1 + U * 0.01, F.dz0 - 0.15 * D, F.dz1 + 0.15 * D); g.fillStyle = rgb(M.refr, 0.7); g.fill(); grime(g, 0.7);
    g.beginPath(); side(g, x1 + 0.02, F.dy0, F.dy1, F.dz0, F.dz1); g.fillStyle = "#120a06"; g.fill();
    g.beginPath(); side(g, x1 + 0.03, F.dy0 - U * 0.085, F.dy0 - U * 0.016, F.dz0 - 0.2 * D, F.dz1 + 0.2 * D); g.fillStyle = rgb(M.dark, 0.9); g.fill(); grime(g, 0.9);
    g.strokeStyle = "rgba(20,20,20,.8)"; g.lineWidth = 1; g.beginPath();
    for (const z of [F.dz0, F.dz1]) { g.moveTo(X(x1, z), Y(F.dy0 - U * 0.085, z)); g.lineTo(X(x1, z), Y(yT, z)); }
    g.stroke();
    // roof beams + combustion-air duct
    for (let x = x0 + W * 0.008; x < x1 - W * 0.004; x += W * 0.024) box(g, x, x + U * 0.012, yT - U * 0.016, yT, z0 + 0.1 * D, z1 - 0.1 * D, M.dark, { grime: 0.6 });
    pipeX(g, x0 + W * 0.004, x1 - W * 0.004, yT + U * 0.028, z0 - U * 0.02, U * 0.018, M.duct, 0.85);
    // buckstays
    for (const x of F.bs) box(g, x - U * 0.007, x + U * 0.007, yT, yB, z0 - U * 0.01, z0, M.dark, { grime: 0.7 });
    // burner blocks, gas manifolds (painted yellow) and peep ports
    const rows = [...new Set(F.ports.map((p) => p.y))];
    for (const y of rows) {
      pipeX(g, x0 + W * 0.004, x1 - W * 0.004, y - U * 0.045, z0 - U * 0.022, U * 0.007, M.gas, 0.85);
      for (const p of F.ports) if (p.y === y) {
        pipeY(g, p.x + U * 0.008, y - U * 0.045, y - U * 0.02, z0 - U * 0.022, U * 0.003, M.gas, 0.8);
        box(g, p.x - U * 0.017, p.x + U * 0.017, y - U * 0.022, y + U * 0.022, p.z, z0, M.dark, { grime: 0.8 });
        g.beginPath(); g.arc(X(p.x, p.z), Y(p.y, p.z), U * 0.0115 * kz(p.z), 0, TAU); g.fillStyle = "#3a3d41"; g.fill();
        g.beginPath(); g.arc(X(p.x, p.z), Y(p.y, p.z), U * 0.0085 * kz(p.z), 0, TAU); g.fillStyle = "#0d0907"; g.fill();
      }
    }
  }

  function paintGB(g) {
    const b = GB, zm = b.z0 + (b.z1 - b.z0) * 0.35;
    // spindles R2 -> gearbox (drive side)
    for (const yy of [pY - R2.rw * 1.25, pY + R2.rw * 1.25]) {
      pipeX(g, R2.ox1 - U * 0.02, b.x0, yy, zm, U * 0.011, M.metal, 0.75);
      for (const x of [R2.ox1 + U * 0.01, b.x0 - U * 0.016]) pipeX(g, x - U * 0.01, x + U * 0.01, yy, zm, U * 0.019, M.dark, 1.3);
    }
    box(g, b.x0 - U * 0.01, b.x1 + U * 0.01, fY - U * 0.018, fY, b.z0 - 0.2 * D, b.z1 + 0.2 * D, M.conc, { grime: 0.6, lt: 1.1 });
    box(g, b.x0, b.x1, b.y0, fY - U * 0.018, b.z0, b.z1, M.gear, { grime: 0.65 });
    box(g, b.x0 + U * 0.03, b.x1 - U * 0.05, b.y0 - U * 0.01, b.y0, b.z0 + 0.3 * D, b.z1 - 0.4 * D, M.gear, { grime: 0.5, lt: 1.4 });
    pipeY(g, b.x1 - U * 0.03, b.y0 - U * 0.04, b.y0, b.z0 + 0.6 * D, U * 0.007, M.metal, 0.8);
    box(g, b.x0 - U * 0.004, b.x1 + U * 0.004, b.ym - U * 0.008, b.ym + U * 0.008, b.z0 - U * 0.006, b.z1, M.gear, { grime: 0.5, lt: 1.4 });
    for (let x = b.x0 + U * 0.012; x < b.x1; x += U * 0.03) bolt(g, X(x, b.z0 - U * 0.006), Y(b.ym, b.z0 - U * 0.006), Math.max(1, U * 0.0045));
    for (let x = b.x0 + U * 0.02; x < b.x1 - U * 0.01; x += U * 0.022) box(g, x, x + U * 0.006, b.ym + U * 0.008, fY - U * 0.03, b.z0 - U * 0.008, b.z0, M.gear, { grime: 0.4 });
    // oil sight glass + lube line
    const sx = X(b.x0 + U * 0.03, b.z0), sy = Y(b.y0 + U * 0.045, b.z0), sr = U * 0.016;
    g.beginPath(); g.arc(sx, sy, sr * 1.35, 0, TAU); g.fillStyle = metal(g.createLinearGradient(sx, sy - sr, sx, sy + sr), M.metal); g.fill();
    pipeY(g, b.x1 - U * 0.012, b.ym + U * 0.01, fY, b.z0 - U * 0.01, U * 0.004, [70, 66, 50], 0.9);
  }

  function paintCBBack(g) {
    const { xa, xb, hy, hr, my, mr } = CB, zb = Z1 + 0.9 * D;
    // water return channel under the bank
    g.beginPath(); top(g, xa, xb, fY - 0.5, Z0 - 0.5 * D, Z1 + 0.5 * D); g.fillStyle = "#0b1214"; g.fill();
    g.strokeStyle = "rgba(160,190,200,.08)"; g.stroke();
    for (const x of [xa - U * 0.02, xb]) box(g, x, x + U * 0.02, my - U * 0.04, fY, zb, zb + 0.3 * D, M.frame, { grime: 0.7 });
    box(g, xa - U * 0.02, xb + U * 0.02, my - U * 0.045, my - U * 0.025, zb - 0.1 * D, zb + 0.4 * D, M.frame, { grime: 0.6 });
    pipeX(g, xa, xb, my, zb, mr, [70, 84, 88], 0.95);
    for (const x of CB.hx) {
      pipeY(g, x, my, hy, zb - 0.1 * D, U * 0.007, [70, 84, 88], 0.9);
      cylZ(g, x, hy, hr, Z0 - 0.4 * D, zb, [72, 86, 90], true, 0.95);
      g.strokeStyle = "rgba(20,26,28,.9)"; g.lineWidth = Math.max(1, U * 0.004); g.beginPath();
      for (let j = 0; j < 7; j++) { const z = Z0 + (D * (j + 0.5)) / 7; g.moveTo(X(x, z), Y(hy + hr * 0.6, z)); g.lineTo(X(x, z), Y(hy + hr + U * 0.012, z)); }
      g.stroke();
    }
  }
  function paintCBFront(g) {
    const { xa, xb, my } = CB, zf = Z0 - 1.1 * D;
    for (const x of [xa - U * 0.02, xb]) box(g, x, x + U * 0.02, my - U * 0.04, fY, zf, zf + 0.3 * D, M.frame, { grime: 0.7 });
    box(g, xa - U * 0.02, xb + U * 0.02, my - U * 0.045, my - U * 0.025, zf - 0.1 * D, zf + 0.4 * D, M.frame, { grime: 0.6 });
    const dx = X(xa - U * 0.01, zf), dy = Y(pY - U * 0.19, zf), dr = Math.max(6, U * 0.024);
    g.beginPath(); g.arc(dx, dy, dr * 1.15, 0, TAU); g.fillStyle = metal(g.createLinearGradient(dx, dy - dr, dx, dy + dr), M.metal); g.fill();
    g.beginPath(); g.arc(dx, dy, dr, 0, TAU); g.fillStyle = "#d9dcd6"; g.fill();
    g.strokeStyle = "#3a3d40"; g.lineWidth = 1; g.beginPath();
    for (let k = 0; k <= 10; k++) { const a = Math.PI * (0.8 + 1.4 * (k / 10)); g.moveTo(dx + Math.cos(a) * dr * 0.72, dy + Math.sin(a) * dr * 0.72); g.lineTo(dx + Math.cos(a) * dr * 0.9, dy + Math.sin(a) * dr * 0.9); }
    g.stroke();
    g.strokeStyle = "rgba(160,50,40,.8)"; g.lineWidth = 2; g.beginPath(); g.arc(dx, dy, dr * 0.82, Math.PI * 0.8, Math.PI * 1.15); g.stroke();
    CB.dial = { x: dx, y: dy, r: dr };
  }

  function standBack(g, s) {
    box(g, s.ox0 - U * 0.02, s.ox1 + U * 0.02, fY - U * 0.02, fY, s.hf0 - 0.3 * D, s.hb1 + 0.3 * D, M.conc, { grime: 0.6, lt: 1.1 });
    pipeY(g, s.cx, s.top - U * 0.055, s.top, (s.hb0 + s.hb1) / 2, s.wh * 0.55, M.metal, 0.85);
    box(g, s.ox0, s.ox1, s.top, fY - U * 0.02, s.hb0, s.hb1, M.paint, { hole: [s.cx - s.wh, s.wy0, s.cx + s.wh, s.wy1], grime: 0.6 });
    box(g, s.ox0 + s.pw * 0.25, s.ox1 - s.pw * 0.25, s.top, s.top + U * 0.03, s.hf1, s.hb0, M.dark, { grime: 0.6 });
    const yl = pY + s.th / 2;
    cylZ(g, s.cx, yl + 2 * s.rw + s.rb, s.rb, s.hf1, s.hb0, M.metal, false, 0.8);
    cylZ(g, s.cx, yl + s.rw, s.rw, s.hf1, s.hb0, M.metal, false, 0.9);
  }
  function standFront(g, s) {
    const yu = pY - s.th / 2, yl = pY + s.th / 2, zc = s.hf0 - 0.12 * D;
    cylZ(g, s.cx, yu - 2 * s.rw - s.rb, s.rb, s.hf1, s.hb0, M.metal, false, 0.8);
    cylZ(g, s.cx, yu - s.rw, s.rw, s.hf1, s.hb0, M.metal, false, 0.95);
    const cw = s.wh - U * 0.004;
    box(g, s.cx - cw, s.cx + cw, s.wy0 + U * 0.002, yu - 2 * s.rw - U * 0.002, zc, s.hf1, M.chock, { grime: 0.5 });
    box(g, s.cx - cw * 0.8, s.cx + cw * 0.8, yu - 2 * s.rw + U * 0.001, yu - s.rw * 0.06, zc, s.hf1, M.chock, { grime: 0.5 });
    box(g, s.cx - cw * 0.8, s.cx + cw * 0.8, yl + s.rw * 0.06, yl + 2 * s.rw - U * 0.001, zc, s.hf1, M.chock, { grime: 0.5 });
    box(g, s.cx - cw, s.cx + cw, yl + 2 * s.rw + U * 0.002, s.wy1 - U * 0.002, zc, s.hf1, M.chock, { grime: 0.5 });
    pipeY(g, s.cx, s.top - U * 0.055, s.top, (s.hf0 + s.hf1) / 2, s.wh * 0.55, M.metal, 0.9);
    box(g, s.cx - s.wh * 0.75, s.cx + s.wh * 0.75, s.top - U * 0.012, s.top, s.hf0 - 0.05 * D, s.hf1, M.dark, { grime: 0.5, lt: 1.5 });
    box(g, s.ox0, s.ox1, s.top, fY - U * 0.02, s.hf0, s.hf1, M.paint, { hole: [s.cx - s.wh, s.wy0, s.cx + s.wh, s.wy1], holeFill: false, grime: 0.6 });
    const br = Math.max(1.2, U * 0.006);
    for (const x of [s.ox0 + s.pw * 0.3, s.ox1 - s.pw * 0.3]) for (const y of [s.top + U * 0.02, (s.wy0 + s.wy1) / 2, fY - U * 0.05]) bolt(g, X(x, s.hf0), Y(y, s.hf0), br);
    // hydraulic hoses to the AGC cylinder
    g.strokeStyle = "#141619"; g.lineWidth = Math.max(1.5, U * 0.007); g.beginPath();
    const hx = X(s.cx + s.wh * 0.55, s.hf0), hy = Y(s.top - U * 0.04, s.hf0);
    g.moveTo(hx, hy); g.bezierCurveTo(hx + U * 0.05, hy - U * 0.02, X(s.ox1, s.hf0) + U * 0.02, Y(s.top, s.hf0), X(s.ox1, s.hf0) + U * 0.01, Y(s.top + U * 0.12, s.hf0));
    g.stroke();
  }

  function paintCLBack(g) {
    const c = CL;
    g.beginPath(); top(g, c.cx - c.rMax * 1.3, c.cx + c.rMax * 1.45, fY - 0.5, Z0 - 1.6 * D, Z1 + 1.2 * D); g.fillStyle = "#0c0d0f"; g.fill();
    box(g, c.cx - U * 0.08, c.cx + U * 0.08, c.cy - U * 0.085, fY, Z1 + 0.5 * D, Z1 + 2.6 * D, M.paint, { grime: 0.65 });
    pipeX(g, c.cx + U * 0.08, c.cx + U * 0.15, c.cy, Z1 + 1.6 * D, U * 0.05, [62, 72, 82], 0.9);
    cylZ(g, c.cx, c.cy, c.rMin * 0.55, Z1, Z1 + 0.5 * D, M.metal, false, 0.9);
    box(g, c.px - c.pwh - U * 0.025, c.px + c.pwh + U * 0.025, c.ptop, fY, Z1 + 0.15 * D, Z1 + 0.45 * D, M.paint,
      { hole: [c.px - c.pwh, c.ptop + U * 0.03, c.px + c.pwh, pY + th2 / 2 + 2 * c.pr + U * 0.015], grime: 0.6 });
    cylZ(g, c.px, pY + th2 / 2 + c.pr, c.pr, Z0 - 0.15 * D, Z1 + 0.15 * D, M.metal, false, 0.9);
  }
  function paintCLFront(g) {
    const c = CL, zf0 = Z0 - 0.45 * D, zf1 = Z0 - 0.15 * D;
    cylZ(g, c.px, pY - th2 / 2 - c.pr, c.pr, zf1, Z1 + 0.15 * D, M.metal, false, 0.95);
    box(g, c.px - c.pwh - U * 0.025, c.px + c.pwh + U * 0.025, c.ptop, fY, zf0, zf1, M.paint,
      { hole: [c.px - c.pwh, c.ptop + U * 0.03, c.px + c.pwh, pY + th2 / 2 + 2 * c.pr + U * 0.015], grime: 0.6 });
    // guard rail in front of the coiler pit (muted safety yellow)
    const zr = Z0 - 1.8 * D, x0 = c.cx - c.rMax * 1.25, x1 = Math.min(W * 0.995, c.cx + c.rMax * 1.4);
    for (const x of [x0, (x0 + x1) / 2, x1]) pipeY(g, x, fY - U * 0.075, fY, zr, U * 0.004, M.gas, 0.8);
    for (const y of [fY - U * 0.075, fY - U * 0.04]) pipeX(g, x0, x1, y, zr, U * 0.0035, M.gas, 0.8);
  }

  // atmosphere: lamp cones, window shafts, depth haze, vignette (drawn over the scene)
  function paintAtmo(g) {
    const bay = W * 0.165, wy1 = H * 0.125;
    g.globalCompositeOperation = "lighter";
    for (let i = -1; i < 7; i++) {
      const bx = bay * (i + 0.5) + bay * 0.14, bw = bay * 0.72;
      const lg = g.createLinearGradient(0, wy1, 0, fY);
      lg.addColorStop(0, "rgba(140,160,180,0.028)"); lg.addColorStop(1, "rgba(140,160,180,0)");
      g.fillStyle = lg; g.beginPath(); g.moveTo(bx, wy1); g.lineTo(bx + bw, wy1); g.lineTo(bx + bw + W * 0.1, fY); g.lineTo(bx + W * 0.07, fY); g.fill();
    }
    for (const lx of [0.22, 0.52, 0.8]) {
      const x = W * lx, y = H * 0.2;
      const lg = g.createLinearGradient(0, y, 0, fY);
      lg.addColorStop(0, "rgba(255,214,168,0.055)"); lg.addColorStop(1, "rgba(255,214,168,0.0)");
      g.fillStyle = lg; g.beginPath(); g.moveTo(x - W * 0.012, y); g.lineTo(x + W * 0.012, y); g.lineTo(x + W * 0.13, fY); g.lineTo(x - W * 0.13, fY); g.fill();
      g.save(); g.translate(x, Y(fY, Z0 - 2 * D)); g.scale(1, 0.14);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.14); gr.addColorStop(0, "rgba(255,214,168,.07)"); gr.addColorStop(1, "rgba(255,214,168,0)");
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, W * 0.14, 0, TAU); g.fill(); g.restore();
    }
    g.globalCompositeOperation = "source-over";
    for (const lx of [0.22, 0.52, 0.8]) {
      const x = W * lx, y = H * 0.2;
      g.strokeStyle = "rgba(10,10,10,.8)"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, H * 0.185); g.lineTo(x, y - H * 0.012); g.stroke();
      g.fillStyle = "#1d2023"; g.beginPath(); g.moveTo(x - W * 0.012, y); g.lineTo(x - W * 0.006, y - H * 0.014); g.lineTo(x + W * 0.006, y - H * 0.014); g.lineTo(x + W * 0.012, y); g.fill();
      g.fillStyle = "rgba(255,226,186,.85)"; g.fillRect(x - W * 0.011, y - 1, W * 0.022, 2);
    }
    const yJ = Y(fY, ZW);
    let lg = g.createLinearGradient(0, yJ - H * 0.2, 0, yJ + H * 0.12);
    lg.addColorStop(0, "rgba(118,112,104,0)"); lg.addColorStop(0.6, "rgba(118,112,104,0.07)"); lg.addColorStop(1, "rgba(118,112,104,0)");
    g.fillStyle = lg; g.fillRect(0, yJ - H * 0.2, W, H * 0.32);
    lg = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.25, W / 2, H * 0.55, Math.hypot(W, H) * 0.62);
    lg.addColorStop(0, "rgba(4,5,7,0)"); lg.addColorStop(1, "rgba(4,5,7,0.55)");
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
  }

  // ---- layout / static layers
  function resize() {
    const r = parent.getBoundingClientRect();
    let w = Math.floor(r.width || canvas.clientWidth || 800);
    let h = Math.floor(r.height || canvas.clientHeight || 0);
    if (h < 60) h = Math.floor(w / 3);
    const nd = Math.min(window.devicePixelRatio || 1, 2), nw = Math.max(w, 200), nh = Math.max(h, 80);
    if (L.bg && nw === W && nh === H && nd === dpr) return;
    dpr = nd; W = nw; H = nh;
    canvas.style.width = W + "px"; canvas.style.height = H + "px"; canvas.style.display = "block";
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    layout();
    const full = (paint) => sprite(0, 0, W, H, paint);
    L.bg = full((g) => { paintHall(g); paintCLBack(g); paintCBBack(g); paintGB(g); paintTable(g); paintF1(g); });
    L.atmo = full(paintAtmo);
    const sb = (s) => [s.ox0 - U * 0.06, Y(s.top - U * 0.06, s.hb1) - U * 0.02, s.ox1 + W * 0.05, fY + 4];
    L.r1b = sprite(...sb(R1), (g) => standBack(g, R1)); L.r1f = sprite(...sb(R1), (g) => standFront(g, R1));
    L.r2b = sprite(...sb(R2), (g) => standBack(g, R2)); L.r2f = sprite(...sb(R2), (g) => standFront(g, R2));
    L.cbf = sprite(CB.xa - U * 0.1, CB.my - U * 0.12, CB.xb + U * 0.1, fY + 4, paintCBFront);
    L.clf = sprite(CL.px - U * 0.12, CL.ptop - U * 0.1, W, fY + 4, paintCLFront);
    es = 0.25;
    emi.width = Math.ceil(W * es); emi.height = Math.ceil(H * es);
    bl1.width = emi.width; bl1.height = emi.height;
    bl2.width = Math.ceil(emi.width / 2); bl2.height = Math.ceil(emi.height / 2);
  }

  // ---- update: targets -> eased state
  const tagOf = (a, n) => store.tick?.frame?.assets?.[a]?.tags?.[n];
  function update(dt) {
    const tk = store.tick, fr = tk?.frame, A = fr?.assets;
    hasTick = !!tk;
    const state = fr?.state ?? "IDLE", running = state === "RUNNING";
    T.u = hasTick ? (running ? clamp(fr.u ?? 0, 0, 1.5) : 0) : 0.18;
    T.dim = state === "TRIPPED" || state === "E-STOP" ? 1 : 0;
    T.maint = state === "MAINTENANCE" ? 1 : 0;
    const ft = tagOf("F1", "FurnaceTemp"), fu = tagOf("F1", "FuelFlow"), sx = tagOf("F1", "SlabExitTemp");
    T.heat = ft?.v != null ? clamp(ft.v / 1250, 0.5, 1.15) : 0.8;
    T.ft = ft?.v != null ? clamp(ft.v, 900, 1350) : 1250;
    T.sx = sx?.v != null ? clamp(sx.v, 900, 1300) : 1180;
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
      RISK[a] += ((rk?.p ?? 0) - RISK[a]) * k;
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
    const a = amt * U * 0.007 * shakeMul * clamp(E.u * 3, 0, 1);
    return [Math.sin(t * 61) * a + Math.sin(t * 97) * a * 0.5, Math.sin(t * 73) * a * 0.6];
  }
  function headerOn(i) {
    if (E.sputter < 0.03) return 1;
    return (Math.sin(t * 7 + i * 2.1) * 0.5 + 0.5) > E.sputter * (i % 2 ? 0.9 : 0.55) ? 1 : 0;
  }
  const sprayDens = () => E.spray * (0.12 + 0.88 * clamp(E.u / 0.5, 0, 1));

  function spawnAmbient(dt) {
    const zr = () => Z0 + rnd() * D;
    // furnace stack: heat haze normally, black soot plumes when fouled; soot puffs from fouled ports
    const sxp = X(F.sx, F.sz), syp = Y(H * 0.2, F.sz);
    const sr = 1.5 + E.foul * 30;
    for (let n = cnt(sr, dt); n > 0; n--) spawn(E.foul > 0.15 ? 1 : 4, sxp + (rnd() - 0.5) * F.sr, syp, U * (0.04 + rnd() * 0.05), -U * (0.08 + rnd() * 0.06), 2.5 + rnd() * 1.5, U * (0.02 + E.foul * 0.02));
    if (E.foul > 0.1) for (const p of F.ports) if (rnd() < E.foul * dt * 1.4) spawn(1, X(p.x, p.z), Y(p.y, p.z), U * (rnd() - 0.3) * 0.04, -U * 0.07, 1.6 + rnd(), U * 0.022);
    // R1: sparks from the roll bite when the bearing runs hot / risk is high
    const hot1 = Math.max(RISK.R1 >= 0.6 ? RISK.R1 : 0, E.r1bear > 0.55 ? E.r1bear : 0);
    if (hot1 > 0 && E.u > 0.05) for (let n = cnt(hot1 * 45, dt); n > 0; n--) {
      const z = zr();
      spawn(0, X(R1.cx + R1.wh, z), Y(pY - th1 / 2, z), U * (0.15 + rnd() * 0.45), -U * (0.25 + rnd() * 0.55), 0.5 + rnd() * 0.6, 1);
    }
    // R2 gearbox: oil smoke from the breather + seams
    if (E.r2oil > 0.1) for (let n = cnt(E.r2oil * 22, dt); n > 0; n--) {
      const rx = rnd() < 0.5 ? GB.x1 - U * 0.03 : lerp(GB.x0, GB.x1, rnd());
      spawn(4, X(rx, GB.z0 + 0.6 * D), Y(GB.y0 - U * 0.04, GB.z0), U * (rnd() - 0.4) * 0.05, -U * (0.1 + rnd() * 0.08), 2.4 + rnd(), U * 0.026);
    }
    // CB: steam where laminar water meets hot strip, plus splash droplets
    const dens = sprayDens(), hotK = clamp((E.tex - 450) / 300, 0.15, 1.2);
    for (let i = 0; i < CB.n; i++) {
      if (!headerOn(i)) continue;
      const x = CB.hx[i];
      for (let n = cnt(dens * hotK * 7, dt); n > 0; n--) {
        const z = zr();
        spawn(2, X(x + (rnd() - 0.5) * U * 0.03, z), Y(pY - th2, z), U * (rnd() - 0.3) * 0.08, -U * (0.08 + rnd() * 0.1), 1.6 + rnd() * 1.4, U * 0.02);
      }
      for (let n = cnt(dens * 10, dt); n > 0; n--) {
        const z = zr();
        spawn(3, X(x, z), Y(pY - th2, z), U * (rnd() - 0.5) * 0.5, -U * (0.1 + rnd() * 0.25), 0.18 + rnd() * 0.15, 1);
      }
    }
    // failed assets smoulder
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i];
      if (FL[a].failed) for (let n = cnt(26, dt); n > 0; n--) spawn(4, lerp(HIT[a][0], HIT[a][1], rnd()) * W, pY - U * 0.1, U * (rnd() - 0.5) * 0.05, -U * (0.1 + rnd() * 0.1), 2 + rnd(), U * 0.025);
    }
    // slow dust drifting through the light shafts
    if (rnd() < dt * 0.6) spawn(2, rnd() * W, H * (0.3 + rnd() * 0.35), U * 0.02, -U * 0.005, 8 + rnd() * 4, U * 0.12);
  }

  // ---- dynamic drawing
  function steelBar(xa, xb, th, Ta, Tb, off) {
    if (xb - xa < 0.5) return;
    const yt = pY - th / 2, yb = pY + th / 2, gxa = X(xa, Z0), gxb = X(xb, Z0);
    ctx.beginPath(); top(ctx, xa, xb, yt, Z0, Z1);
    let gr = ctx.createLinearGradient(gxa, 0, gxb, 0);
    gr.addColorStop(0, steel(Ta, 1.55)); gr.addColorStop(1, steel(Tb, 1.55));
    ctx.fillStyle = gr; ctx.fill();
    if (scalePat) {
      if (canMat) scalePat.setTransform(new DOMMatrix([1, 0, 0, 1, off % 256, 0]));
      ctx.globalAlpha = 0.5; ctx.fillStyle = scalePat; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.beginPath(); front(ctx, xa, yt, xb, yb, Z0);
    gr = ctx.createLinearGradient(gxa, 0, gxb, 0);
    gr.addColorStop(0, steel(Ta, 0.8)); gr.addColorStop(1, steel(Tb, 0.8));
    ctx.fillStyle = gr; ctx.fill();
    // emissive: surface, light thrown up onto the housings and bounced off the floor
    gr = ex.createLinearGradient(gxa, 0, gxb, 0);
    gr.addColorStop(0, glowCol(Ta, 1)); gr.addColorStop(1, glowCol(Tb, 1));
    ex.fillStyle = gr;
    ex.beginPath(); top(ex, xa, xb, yt, Z0, Z1); front(ex, xa, yt, xb, yb, Z0); ex.fill();
    ex.globalAlpha = 0.16; ex.fillRect(gxa, Y(pY - U * 0.09, Z1), gxb - gxa, U * 0.09);
    ex.globalAlpha = 0.22; ex.fillRect(gxa, Y(fY, Z1 + D), gxb - gxa, Y(fY, Z0 - 2.5 * D) - Y(fY, Z1 + D));
    ex.globalAlpha = 1;
  }

  function drawStrip() {
    const T0 = E.sx, Tr1 = T0 - 70, Tr2 = T0 - 230, Tc0 = Tr2 - 60, Tc1 = E.tex;
    // slabs: discrete, slow (mass flow: thicker moves slower)
    const pitch = W * 0.1, len = W * 0.062, off = (flow * th2 / thS) % pitch, xa = F.x1, xb = R1.cx;
    for (let x = xa - pitch + off; x < xb; x += pitch) {
      const l = Math.max(x, xa), r = Math.min(x + len, xb);
      if (r <= l) continue;
      const Tl = lerp(T0, T0 - 40, (l - xa) / (xb - xa)), Tr = lerp(T0, T0 - 40, (r - xa) / (xb - xa));
      steelBar(l, r, thS, Tl, Tr, flow * th2 / thS);
    }
    steelBar(R1.cx, R2.cx, th1, Tr1, Tr2 + 120, flow * th2 / th1);
    steelBar(R2.cx, CB.xa, th2, Tr2, Tc0, flow);
    steelBar(CB.xa, CB.xb, th2, Tc0, Tc1, flow);
    steelBar(CB.xb, CL.px, th2, Tc1, Tc1 - 10, flow);
  }

  function drawF1() {
    const { x1, dz0, dz1, dy0, dy1 } = F, foul = E.foul, Tf = E.ft;
    // discharge door: radiant chamber
    ctx.beginPath(); side(ctx, x1 + 0.02, dy0, dy1, dz0, dz1);
    let gr = ctx.createLinearGradient(0, Y(dy0, dz0), 0, Y(dy1, dz0));
    gr.addColorStop(0, steel(Tf * (0.82 + 0.06 * E.heat), 1)); gr.addColorStop(1, steel(Tf * 0.72, 0.6));
    ctx.fillStyle = gr; ctx.fill();
    ex.beginPath(); side(ex, x1, dy0, dy1, dz0, dz1); ex.fillStyle = glowCol(Tf * 0.9, 0.7); ex.fill();
    const dcx = X(x1, (dz0 + dz1) / 2), dcy = Y(pY, dz0);
    gr = ex.createRadialGradient(dcx, dcy, 0, dcx, dcy, U * 0.22);
    gr.addColorStop(0, glowCol(Tf, 0.45 * E.heat)); gr.addColorStop(1, glowCol(Tf, 0));
    ex.fillStyle = gr; ex.fillRect(dcx - U * 0.22, dcy - U * 0.22, U * 0.44, U * 0.44);
    // burner peep ports: flame flicker; fouled = dull, smoky, dropping out
    for (let i = 0; i < F.ports.length; i++) {
      const p = F.ports[i], k = kz(p.z), cx = X(p.x, p.z), cy = Y(p.y, p.z), r = U * 0.0085 * k;
      let a = clamp(E.fuelI * E.heat, 0.2, 1.3) * (0.85 + 0.15 * Math.sin(t * (RM ? 3 : 13) + i * 2.3));
      if (foul > 0.05) {
        a *= 1 - foul * 0.55 * (0.5 + 0.5 * Math.sin(t * 23 + i * 5));
        if (Math.sin(t * 17 + i * 3.1) + Math.sin(t * 7.3 + i) < -1.9 + foul * 1.4) a *= 0.2;
      }
      const Tp = lerp(1300, 980, foul) * (0.9 + 0.1 * a);
      gr = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r);
      gr.addColorStop(0, steel(Tp, 1, 1)); gr.addColorStop(0.6, steel(Tp - 150, 1, 1)); gr.addColorStop(1, "rgba(30,14,8,1)");
      ctx.globalAlpha = clamp(0.35 + a * 0.65, 0, 1); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      gr = ex.createRadialGradient(cx, cy, 0, cx, cy, r * 5);
      gr.addColorStop(0, glowCol(Tp, 0.9 * a)); gr.addColorStop(1, glowCol(Tp, 0));
      ex.fillStyle = gr; ex.fillRect(cx - r * 5, cy - r * 5, r * 10, r * 10);
      // soot staining above fouled burners
      if (foul > 0.04) {
        ctx.globalAlpha = clamp(foul * 1.1, 0, 0.9);
        ctx.drawImage(TX.soot[i & 1], cx - U * 0.034, cy - U * 0.11, U * 0.068, U * 0.13);
        ctx.globalAlpha = 1;
      }
    }
  }

  // stand front: housing sprite, rotating roll-neck end faces, hot-bearing glow, incandescent bite
  function drawStandFront(s, spr, [sx, sy], glow, hub) {
    ctx.save(); ctx.translate(sx, sy); ex.save(); ex.translate(sx, sy);
    {
      blit(spr);
      const z = s.hf0 - 0.12 * D, k = kz(z), yu = pY - s.th / 2, yl = pY + s.th / 2;
      const rolls = [[yu - 2 * s.rw - s.rb, s.rb, -s.rw / s.rb], [yu - s.rw, s.rw, 1], [yl + s.rw, s.rw, -1], [yl + 2 * s.rw + s.rb, s.rb, s.rw / s.rb]];
      for (let i = 0; i < 4; i++) {
        const [y, r, dir] = rolls[i], cx = X(s.cx, z), cy = Y(y, z), rr = r * 0.6 * k;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot * dir); ctx.drawImage(TX.disc, -rr, -rr, rr * 2, rr * 2); ctx.restore();
        if (hub > 0.03 && (i === 1 || i === 2)) {
          // overheated bearing: chock tint + dull red glow, in thermal-camera spirit but muted
          const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.2 * k);
          gr.addColorStop(0, `rgba(200,80,40,${0.55 * hub})`); gr.addColorStop(1, "rgba(200,80,40,0)");
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r * 1.2 * k, 0, TAU); ctx.fill();
          ex.fillStyle = `rgba(255,110,50,${0.6 * hub})`; ex.beginPath(); ex.arc(cx, cy, r * 0.9 * k, 0, TAU); ex.fill();
        }
      }
      // incandescent bite between the work rolls
      const bx = X(s.cx, Z0), by = Y(pY, Z0), T = s === R1 ? E.sx - 60 : E.sx - 220;
      const gr = ex.createRadialGradient(bx, by, 0, bx, by, U * 0.06);
      gr.addColorStop(0, glowCol(T, glow)); gr.addColorStop(1, glowCol(T, 0));
      ex.fillStyle = gr; ex.fillRect(bx - U * 0.06, by - U * 0.06, U * 0.12, U * 0.12);
    }
    ctx.restore(); ex.restore();
  }

  function drawGB() {
    const b = GB, oil = E.r2oil;
    const sx = X(b.x0 + U * 0.03, b.z0), sy = Y(b.y0 + U * 0.045, b.z0), sr = U * 0.016;
    const lvl = clamp(0.62 - oil * 0.22, 0.3, 0.7);
    ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.clip();
    ctx.fillStyle = "#15181a"; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.fillStyle = `rgb(${(150 + 60 * oil) | 0},${(104 - 50 * oil) | 0},${(34 - 10 * oil) | 0})`;
    ctx.fillRect(sx - sr, sy + sr - sr * 2 * lvl + Math.sin(t * 9) * oil, sr * 2, sr * 2);
    ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(sx - sr * 0.6, sy - sr * 0.7, sr * 0.25, sr * 1.2);
    ctx.restore();
    if (oil > 0.04) {
      // casing heat: warm cast over the sump and a soft emissive halo
      ctx.save(); ctx.beginPath(); front(ctx, b.x0, b.y0, b.x1, fY - U * 0.018, b.z0); ctx.clip();
      const gr = ctx.createLinearGradient(0, Y(b.y0, b.z0), 0, Y(fY, b.z0));
      gr.addColorStop(0, `rgba(170,80,40,${0.05 * oil})`); gr.addColorStop(0.6, `rgba(190,85,40,${0.32 * oil})`); gr.addColorStop(1, `rgba(170,70,35,${0.12 * oil})`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); ctx.restore();
      ex.fillStyle = `rgba(220,90,40,${0.22 * oil})`; ex.beginPath(); front(ex, b.x0, b.ym, b.x1, fY - U * 0.03, b.z0); ex.fill();
    }
  }

  function drawCB() {
    const dens = sprayDens(), a = clamp(dens, 0, 1.1);
    // channel ripples
    ctx.strokeStyle = "rgba(150,180,190,.10)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const z = Z0 + (D * (k + 0.5)) / 3;
      for (let i = 0; i <= 16; i++) {
        const x = lerp(CB.xa, CB.xb, i / 16), xx = X(x, z), yy = Y(fY, z) - 1 + Math.sin(t * 2.5 + i * 0.9 + k * 2) * 0.8;
        i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
    }
    ctx.stroke();
    if (a < 0.02) return;
    const lw = Math.max(1, U * 0.0045);
    for (let i = 0; i < CB.n; i++) {
      const on = headerOn(i);
      if (!on) continue;
      const x = CB.hx[i], y0 = CB.hy + CB.hr + U * 0.012, y1 = pY - th2 / 2;
      const ncol = Math.max(2, Math.round(7 * clamp(dens, 0.3, 1)));
      // translucent sheet
      ctx.beginPath(); ctx.moveTo(X(x, Z0), Y(y0, Z0)); ctx.lineTo(X(x, Z1), Y(y0, Z1)); ctx.lineTo(X(x, Z1), Y(y1, Z1)); ctx.lineTo(X(x, Z0), Y(y1, Z0)); ctx.closePath();
      ctx.fillStyle = `rgba(150,180,196,${0.045 * a})`; ctx.fill();
      // laminar columns (glassy rods); with pressure loss they break into droplets
      const broken = E.sputter > 0.08;
      if (broken) { ctx.setLineDash([U * 0.012, U * 0.01 * (1 + E.sputter * 2)]); ctx.lineDashOffset = -t * U * 1.2 - i * 7; }
      ctx.beginPath();
      for (let j = 0; j < ncol; j++) { const z = Z0 + (D * (j + 0.5)) / ncol; ctx.moveTo(X(x, z), Y(y0, z)); ctx.lineTo(X(x, z), Y(y1, z)); }
      ctx.lineWidth = lw; ctx.strokeStyle = `rgba(150,178,194,${0.42 * a})`; ctx.stroke();
      ctx.lineWidth = Math.max(0.6, lw * 0.35); ctx.strokeStyle = `rgba(232,242,248,${0.3 * a})`; ctx.stroke();
      if (broken) ctx.setLineDash([]);
      // impact mist on the strip
      const mx = X(x, (Z0 + Z1) / 2), my = Y(y1, (Z0 + Z1) / 2);
      ctx.save(); ctx.translate(mx, my); ctx.scale(1, 0.45);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, U * 0.045);
      gr.addColorStop(0, `rgba(225,232,236,${0.32 * a})`); gr.addColorStop(1, "rgba(225,232,236,0)");
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, U * 0.045, 0, TAU); ctx.fill(); ctx.restore();
    }
  }
  function drawGauge() {
    const d = CB.dial;
    if (!d) return;
    const pr = tagOf("CB", "PumpPressure"), ratio = pr?.v != null ? clamp(pr.v / (pr.exp || pr.v || 1), 0, 1.3) : 1;
    const an = Math.PI * (0.8 + 1.4 * clamp(ratio / 1.3, 0, 1)) + (E.sputter > 0.05 && !RM ? Math.sin(t * 19) * 0.06 * E.sputter : 0);
    ctx.strokeStyle = "#1b1d1f"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + Math.cos(an) * d.r * 0.8, d.y + Math.sin(an) * d.r * 0.8); ctx.stroke();
    ctx.fillStyle = "#1b1d1f"; ctx.beginPath(); ctx.arc(d.x, d.y, 1.6, 0, TAU); ctx.fill();
  }

  const rib = new Float32Array(64);
  function drawCL() {
    const c = CL, r = c.rMin + (c.rMax - c.rMin) * coilFrac, wob = E.mis, ca = rot * 1.25;
    const cx = c.cx + Math.cos(ca) * wob * U * 0.012, cy = c.cy + Math.sin(ca) * wob * U * 0.012, Tc = E.tex - 25;
    // strip from pinch rolls down onto the coil; flutters with tension error
    const fl = E.flutter * (RM ? 0.3 : 1), x0 = c.px + c.pr * 0.6, x2 = cx - r * 0.12, y2 = cy - r;
    const qx = lerp(x0, x2, 0.6) + Math.sin(t * 6.3) * fl * U * 0.012, qy = pY + (y2 - pY) * 0.08 + Math.sin(t * 8.1) * fl * U * 0.05;
    const n = 15;
    for (let i = 0; i <= n; i++) {
      const s = i / n, a = (1 - s) * (1 - s), b = 2 * (1 - s) * s, d = s * s;
      rib[i * 2] = a * x0 + b * qx + d * x2; rib[i * 2 + 1] = a * pY + b * qy + d * y2;
    }
    const ribbon = (g) => {
      g.beginPath();
      for (let i = 0; i <= n; i++) { const x = rib[i * 2], y = rib[i * 2 + 1] - th2 / 2; i ? g.lineTo(X(x, Z0), Y(y, Z0)) : g.moveTo(X(x, Z0), Y(y, Z0)); }
      for (let i = n; i >= 0; i--) { const x = rib[i * 2], y = rib[i * 2 + 1] - th2 / 2; g.lineTo(X(x, Z1), Y(y, Z1)); }
      g.closePath();
    };
    ribbon(ctx); ctx.fillStyle = steel(Tc + 15, 1.45); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = X(rib[i * 2], Z0), y = Y(rib[i * 2 + 1], Z0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.lineWidth = Math.max(1, th2 * kz(Z0)); ctx.strokeStyle = steel(Tc, 0.8); ctx.stroke();
    ribbon(ex); ex.fillStyle = glowCol(Tc + 15, 1); ex.fill();
    // coil body + wound end face
    cylZ(ctx, cx, cy, r, Z0, Z1, [74, 76, 80], false, 1);
    const k0 = kz(Z0), fx = X(cx, Z0), fy = Y(cy, Z0), R = r * k0, Rm = c.rMin * k0;
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = glowCol(Tc, 0.55);
    ctx.beginPath(); ctx.arc(X(cx, Z1), Y(cy, Z1), r * kz(Z1), 0, TAU); ctx.fill(); ctx.restore();
    let gr = ctx.createRadialGradient(fx - R * 0.25, fy - R * 0.25, Rm, fx, fy, R);
    gr.addColorStop(0, steel(Tc + 40, 1.05)); gr.addColorStop(1, steel(Tc - 10, 1.3));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(fx, fy, R, 0, TAU); ctx.fill();
    const step = Math.max(1.6, U * 0.0055);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.26)"; ctx.beginPath();
    for (let rr = R - step * 0.5; rr > Rm; rr -= step) { ctx.moveTo(fx + rr, fy); ctx.arc(fx, fy, rr, 0, TAU); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,240,225,.05)"; ctx.beginPath();
    for (let rr = R - step; rr > Rm; rr -= step) { ctx.moveTo(fx + rr, fy); ctx.arc(fx, fy, rr, 0, TAU); }
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.beginPath(); ctx.arc(fx, fy, R, 0, TAU); ctx.stroke();
    ex.fillStyle = glowCol(Tc, 0.9); ex.beginPath(); ex.arc(fx, fy, R, 0, TAU); ex.fill();
    ctx.save(); ctx.translate(fx, fy); ctx.rotate(ca); ctx.drawImage(TX.disc, -Rm * 0.9, -Rm * 0.9, Rm * 1.8, Rm * 1.8); ctx.restore();
  }
  function drawPinch() {
    const c = CL, z = Z0 - 0.5 * D, k = kz(z), r = c.pr * 0.62 * k;
    for (const [y, d] of [[pY - th2 / 2 - c.pr, 1], [pY + th2 / 2 + c.pr, -1]]) {
      ctx.save(); ctx.translate(X(c.px, z), Y(y, z)); ctx.rotate(rot * 2.4 * d); ctx.drawImage(TX.disc, -r, -r, r * 2, r * 2); ctx.restore();
    }
  }

  function drawHalos() {
    const sel = store.selected;
    ctx.save();
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], f = FL[a];
      const cx = ((HIT[a][0] + HIT[a][1]) / 2) * W, cy = fY + (H - fY) * 0.42;
      const rx = ((HIT[a][1] - HIT[a][0]) / 2) * W * 0.86, ry = (H - fY) * 0.36;
      const col = f.failed ? "#b42318" : riskColor(RISK[a]);
      let al = sel === a ? 0.85 : 0.5;
      if (f.failed) al = RM ? 1 : Math.sin(t * 12) > 0 ? 1 : 0.35;
      else if (f.over || f.alert) al = 0.7 + 0.3 * Math.sin(t * (RM ? 1.5 : 4.2));
      ctx.setTransform(dpr, 0, 0, dpr * ry / rx, cx * dpr, cy * dpr);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = 0.32 * al; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 0.8 * al; ctx.strokeStyle = col; ctx.lineWidth = (sel === a ? 2 : 1.3) * rx / ry;
      ctx.beginPath(); ctx.arc(0, 0, rx * 0.9, 0, TAU); ctx.stroke();
    }
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function bloom() {
    if (FILTER) {
      b1.globalCompositeOperation = "copy"; b1.filter = "blur(2px)"; b1.drawImage(emi, 0, 0);
      b2.globalCompositeOperation = "copy"; b2.filter = "blur(4px)"; b2.drawImage(emi, 0, 0, bl2.width, bl2.height);
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.45; ctx.drawImage(bl1, 0, 0, W, H);
      ctx.globalAlpha = 0.42; ctx.drawImage(bl2, 0, 0, W, H);
      ctx.restore();
    } else {
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.6; ctx.drawImage(emi, 0, 0, W, H); ctx.restore();
    }
  }

  // heat shimmer: re-draw thin rows of the region with a travelling sine offset (stronger near the hot source)
  function shimmer(x0, y0, x1, y1, amp) {
    if (amp < 0.12 || RM) return;
    const d = dpr, sx = Math.max(0, Math.floor(x0 * d)), sy = Math.max(0, Math.floor(y0 * d));
    const sw = Math.min(canvas.width, Math.ceil(x1 * d)) - sx, sh = Math.min(canvas.height, Math.ceil(y1 * d)) - sy;
    if (sw < 4 || sh < 4) return;
    if (scr.width < sw || scr.height < sh) { scr.width = Math.max(scr.width, sw); scr.height = Math.max(scr.height, sh); }
    sc.globalCompositeOperation = "copy"; sc.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const step = Math.max(2, Math.round(2 * d));
    for (let y = 0; y < sh; y += step) {
      const f = y / sh, a = amp * d * (0.25 + 0.75 * f * f);
      const o = a * (Math.sin(y * 0.11 / d + t * 7 + x0) * 0.65 + Math.sin(y * 0.31 / d - t * 11) * 0.35);
      ctx.drawImage(scr, 0, y, sw, step, sx + o, sy + y, sw, step);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawStates() {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i];
      if (!FL[a].failed) continue;
      const s = RM ? 0.6 : Math.sin(t * 8) * 0.5 + 0.5, x0 = HIT[a][0] * W, x1 = HIT[a][1] * W;
      const g = ctx.createLinearGradient(0, H * 0.2, 0, fY);
      g.addColorStop(0, "rgba(180,35,24,0)"); g.addColorStop(1, `rgba(180,35,24,${0.08 + 0.14 * s})`);
      ctx.fillStyle = g; ctx.fillRect(x0, H * 0.2, x1 - x0, fY - H * 0.2 + 6);
    }
    if (E.dim > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = "saturation"; ctx.fillStyle = `rgba(128,128,128,${0.4 * E.dim})`; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = `rgba(5,6,8,${0.32 * E.dim})`; ctx.fillRect(0, 0, W, H);
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.62);
      g.addColorStop(0, "rgba(180,35,24,0)"); g.addColorStop(1, `rgba(180,35,24,${0.42 * E.dim * (RM ? 0.9 : 0.75 + 0.25 * Math.sin(t * 3))})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (E.maint > 0.01) {
      ctx.save(); ctx.globalAlpha = 0.07 * E.maint; ctx.fillStyle = "#b7791f"; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 0.9 * E.maint; ctx.fillStyle = hazPat; ctx.fillRect(0, 0, W, H * 0.025); ctx.fillRect(0, H * 0.975, W, H * 0.025);
      ctx.restore();
    }
  }

  function drawGlitch() {
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i];
      if (!FL[a].glitch) continue;
      const x = ((HIT[a][0] + HIT[a][1]) / 2) * W + U * 0.07, y = ANCH[a] + U * 0.005, w = 34, h = 20;
      ctx.save(); ctx.globalAlpha = RM || rnd() > 0.2 ? 1 : 0.4;
      ctx.fillStyle = "rgba(255,255,255,.95)"; rr(x - w / 2, y - h / 2, w, h, 6); ctx.fill();
      ctx.strokeStyle = "#b7791f"; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k <= 22; k++) {
        const xx = x - 12 + k, yy = y + Math.sin(k * 0.9 + t * 9) * 3 + (rnd() < 0.15 ? (rnd() - 0.5) * 9 : 0);
        k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  const rr = (x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); };
  const FONT = '"Inter", system-ui, "Segoe UI", sans-serif';
  function drawLabels() {
    const fs = clamp(U * 0.03, 10, 13), sel = store.selected;
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let i = 0; i < ASSET_ORDER.length; i++) {
      const a = ASSET_ORDER[i], cx = ((HIT[a][0] + HIT[a][1]) / 2) * W, y = H * 0.115 + (RM ? 0 : Math.sin(t * 1.1 + i) * 1.2);
      const l2 = FL[a].failed ? "FAILED" : `${Math.round(RISK[a] * 100)}%`, isSel = sel === a;
      ctx.font = `600 ${fs}px ${FONT}`;
      let l1 = `${a} · ${SHORT[a]}`, w = Math.max(ctx.measureText(l1).width, ctx.measureText("risk " + l2).width) + 24;
      if (w > (HIT[a][1] - HIT[a][0]) * W - 4) { l1 = a; w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 24; } // narrow: compact card
      const h = fs * 2.6, l2s = l1 === a || FL[a].failed ? l2 : "risk " + l2;
      ctx.strokeStyle = "rgba(230,236,242,.28)"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y + h / 2); ctx.lineTo(cx, Math.max(y + h / 2, ANCH[a])); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "rgba(230,236,242,.5)"; ctx.beginPath(); ctx.arc(cx, Math.max(y + h / 2, ANCH[a]), 2, 0, TAU); ctx.fill();
      ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2;
      ctx.fillStyle = isSel ? "#ffffff" : hover === a ? "rgba(255,255,255,.97)" : "rgba(255,255,255,.9)";
      rr(cx - w / 2, y - h / 2, w, h, 7); ctx.fill(); ctx.restore();
      ctx.strokeStyle = isSel ? ASSET_COLOR[a] : "#e3e6eb"; ctx.lineWidth = isSel ? 1.5 : 1; ctx.stroke();
      ctx.fillStyle = ASSET_COLOR[a]; ctx.fillRect(cx - w / 2 + 6, y - h / 2 + 6, 3, h - 12);
      ctx.fillStyle = "#111827"; ctx.fillText(l1, cx - w / 2 + 15, y - fs * 0.58);
      ctx.font = `500 ${fs}px ${FONT}`;
      ctx.fillStyle = FL[a].failed ? "#b42318" : riskColor(RISK[a]); ctx.fillText(l2s, cx - w / 2 + 15, y + fs * 0.62);
    }
  }

  const fmt = (v) => (v == null ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  function drawTooltip(a) {
    const asset = store.tick?.frame?.assets?.[a];
    if (!asset) return;
    const fs = clamp(U * 0.03, 10, 12.5), lines = [];
    for (const k in asset.tags) {
      const g = asset.tags[k];
      lines.push({ s: `${g.label || k}: ${fmt(g.v)} ${g.unit || ""}  (exp ${fmt(g.exp)})`, bad: g.glitch || g.dropout });
    }
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const head = `${a} · ${asset.name || SHORT[a]}`;
    ctx.font = `600 ${fs}px ${FONT}`;
    let w = ctx.measureText(head).width;
    ctx.font = `500 ${fs}px ${FONT}`;
    for (const l of lines) w = Math.max(w, ctx.measureText(l.s).width);
    w += 26; const lh = fs * 1.55, h = lh * (lines.length + 1) + 14;
    const x = clamp(mouse.x + 16, 4, W - w - 4), y = clamp(mouse.y + 16, 4, H - h - 4);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#ffffff"; rr(x, y, w, h, 9); ctx.fill(); ctx.restore();
    ctx.strokeStyle = "#e3e6eb"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = ASSET_COLOR[a]; ctx.fillRect(x + 8, y + 9, 3, lh - 4);
    ctx.fillStyle = "#111827"; ctx.font = `600 ${fs}px ${FONT}`; ctx.fillText(head, x + 17, y + 7 + lh / 2);
    ctx.font = `500 ${fs}px ${FONT}`;
    lines.forEach((l, i) => { ctx.fillStyle = l.bad ? "#b7791f" : "#4b5563"; ctx.fillText(l.s, x + 13, y + 7 + lh * (i + 1.5)); });
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ex.setTransform(1, 0, 0, 1, 0, 0); ex.clearRect(0, 0, emi.width, emi.height); ex.setTransform(es, 0, 0, es, 0, 0);
    ex.globalCompositeOperation = "lighter";
    blit(L.bg);
    drawHalos();
    drawF1();
    const sh1 = shakeOf(E.r1shake), sh2 = shakeOf(E.r2shake), bite = clamp(E.u * 2, 0.3, 1);
    blit(L.r1b, sh1[0], sh1[1]);
    blit(L.r2b, sh2[0], sh2[1]);
    drawGB();
    drawStrip();
    drawStandFront(R1, L.r1f, sh1, 0.55 * bite, E.r1bear);
    drawStandFront(R2, L.r2f, sh2, 0.4 * bite, 0);
    drawCB();
    blit(L.cbf);
    drawGauge();
    const wob = E.mis * U * 0.002 * shakeMul * clamp(E.u * 3, 0, 1) * Math.sin(t * 40);
    ctx.save(); ctx.translate(wob, 0); drawCL(); blit(L.clf); drawPinch(); ctx.restore();
    drawParticles();
    bloom();
    blit(L.atmo);
    // heat shimmer over the hot line, the furnace roof and a hot gearbox
    const hotA = 1.3 * clamp((E.sx - 900) / 300, 0, 1) * (0.5 + 0.5 * clamp(E.u * 2, 0, 1));
    shimmer(F.x1, Y(pY, Z1) - U * 0.13, CB.xa, Y(pY - th1, Z1), hotA);
    shimmer(X(F.x0, F.z1), Y(F.yT, F.z1) - U * 0.12, X(F.x1, F.z1), Y(F.yT - U * 0.016, F.z1), 1.1 * E.heat);
    if (E.r2oil > 0.08) shimmer(X(GB.x0, GB.z1), Y(GB.y0, GB.z1) - U * 0.13, X(GB.x1, GB.z1) + U * 0.02, Y(GB.y0 - U * 0.012, GB.z1), 2.2 * E.r2oil);
    drawStates();
    ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = grainPat;
    const gx = RM ? 0 : (rnd() * 128) | 0, gy = RM ? 0 : (rnd() * 128) | 0;
    ctx.translate(-gx, -gy); ctx.fillRect(gx, gy, W, H); ctx.restore();
    drawGlitch();
    drawLabels();
    if (!hasTick) {
      ctx.fillStyle = "rgba(220,226,232,.6)"; ctx.font = `500 ${clamp(H * 0.032, 10, 13)}px ${FONT}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("Awaiting twin telemetry…", W / 2, H * 0.955);
    }
    if (hover && hasTick) drawTooltip(hover);
  }

  // ---- interaction
  function hitTest(x, y) {
    if (y < H * 0.02) return null;
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
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts; t += dt;
    try { update(dt); draw(); } catch (err) { console.error("mill", err); }
  }

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => resize()).observe(parent);
  else window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  return { resize };
}
