// Small reusable SVG helpers (no deps). All return strings except gaugeUpdate.
const f = (x) => (+x).toFixed(2);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

/** sparkline(values, w, h, color) -> SVG string. Values auto-scaled; optional {min,max,fill}. */
export function sparkline(values, w = 120, h = 28, color = "var(--accent)", o = {}) {
  const v = (values || []).filter((x) => x != null && isFinite(x));
  if (v.length < 2) return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="${color}" stroke-opacity=".5" stroke-dasharray="3 3"/></svg>`;
  let lo = o.min ?? Math.min(...v), hi = o.max ?? Math.max(...v);
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const pad = 3, X = (i) => pad + (i * (w - 2 * pad)) / (v.length - 1), Y = (x) => h - pad - ((x - lo) / (hi - lo)) * (h - 2 * pad);
  const pts = v.map((x, i) => `${f(X(i))},${f(Y(x))}`);
  const last = pts[pts.length - 1].split(",");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    ${o.fill === false ? "" : `<polygon points="${pad},${h - pad} ${pts.join(" ")} ${w - pad},${h - pad}" fill="${color}" fill-opacity=".08"/>`}
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="${color}"/></svg>`;
}

// ---- semicircular gauge: frac 0..1 maps left(180deg) -> right(0deg)
const GC = { cx: 130, cy: 118, r: 92 };
const pol = (fr, r = GC.r) => { const a = Math.PI * (1 - fr); return [GC.cx + r * Math.cos(a), GC.cy - r * Math.sin(a)]; };
const arc = (a, b, r = GC.r) => { const [x0, y0] = pol(a, r), [x1, y1] = pol(b, r); return `M${f(x0)} ${f(y0)} A${r} ${r} 0 0 1 ${f(x1)} ${f(y1)}`; };

/** gaugeSVG() -> static SVG string; drive it with gaugeUpdate(svg, {p, lo, hi, thr, color}). CSS transitions ease changes. */
export function gaugeSVG() {
  return `<svg class="gauge" viewBox="0 0 260 140" role="img" aria-label="Failure risk gauge">
    <path d="${arc(0, 1)}" class="g-track" fill="none" stroke="#eef0f4" stroke-width="14" stroke-linecap="round"/>
    <path class="g-band" d="${arc(0, 0.001)}" fill="none" stroke-width="14" stroke-linecap="butt"/>
    <path d="${arc(0, 1)}" class="g-val" pathLength="100" stroke-dasharray="0 100" fill="none" stroke-width="14" stroke-linecap="round"/>
    <line class="g-thr" stroke-width="2" stroke="#8a94a6" stroke-linecap="round"/>
    <text class="g-thr-t" text-anchor="middle" font-size="9" fill="#8a94a6"></text>
    <text class="g-num" x="${GC.cx}" y="${GC.cy - 12}" text-anchor="middle" font-size="34" font-weight="600" font-family="var(--mono)" fill="#111827">0%</text>
    <text x="38" y="138" font-size="9" fill="#8a94a6" text-anchor="middle">0</text><text x="222" y="138" font-size="9" fill="#8a94a6" text-anchor="middle">100%</text>
  </svg>`;
}
export function gaugeUpdate(svg, { p = 0, lo = p, hi = p, thr = 0.5, color = "#1f8a5b" }) {
  p = clamp(p); const q = (s) => svg.querySelector(s);
  q(".g-val").setAttribute("stroke-dasharray", `${f(p * 100)} 100`);
  q(".g-val").setAttribute("stroke", color);
  const a = clamp(lo), b = Math.max(clamp(hi), a + 0.012);
  q(".g-band").setAttribute("d", arc(a, Math.min(1, b))); q(".g-band").setAttribute("stroke", color);
  q(".g-band").setAttribute("stroke-opacity", ".22");
  const [x0, y0] = pol(clamp(thr), GC.r - 11), [x1, y1] = pol(clamp(thr), GC.r + 11), [tx, ty] = pol(clamp(thr), GC.r + 21);
  const t = q(".g-thr"); t.setAttribute("x1", f(x0)); t.setAttribute("y1", f(y0)); t.setAttribute("x2", f(x1)); t.setAttribute("y2", f(y1));
  const tt = q(".g-thr-t"); tt.setAttribute("x", f(tx)); tt.setAttribute("y", f(ty + 3)); tt.textContent = `thr ${(thr * 100).toFixed(0)}%`;
  q(".g-num").textContent = `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}

/**
 * lineChart({series:[{y[],color,dash?,glow?,label?}], horizon, threshold, markers:[{x,color,label}], w, h}) -> SVG string
 * x = minutes 0..horizon, y = 0..1.
 */
export function lineChart({ series = [], horizon = 120, threshold, markers = [], w = 420, h = 190, yLabel = "risk" }) {
  const L = 34, R = 10, T = 10, B = 24, X = (m) => L + (m / horizon) * (w - L - R), Y = (v) => T + (1 - clamp(v)) * (h - T - B);
  let s = `<svg class="linechart" viewBox="0 0 ${w} ${h}" role="img" aria-label="What-if risk curves, ${yLabel} versus minutes">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) s += `<line x1="${L}" x2="${w - R}" y1="${f(Y(v))}" y2="${f(Y(v))}" stroke="#eef0f4" stroke-width="1"/><text x="${L - 5}" y="${f(Y(v) + 3)}" text-anchor="end" font-size="9" fill="#8a94a6">${v}</text>`;
  for (let m = 0; m <= horizon; m += 30) s += `<text x="${f(X(m))}" y="${h - 8}" text-anchor="middle" font-size="9" fill="#8a94a6">${m}</text>`;
  s += `<text x="${w - R}" y="${h - 8}" text-anchor="end" font-size="9" fill="#8a94a6">min</text>`;
  if (threshold != null) s += `<line x1="${L}" x2="${w - R}" y1="${f(Y(threshold))}" y2="${f(Y(threshold))}" stroke="#b7791f" stroke-width="1" stroke-dasharray="1 3" stroke-linecap="round"/><text x="${L + 3}" y="${f(Y(threshold) - 3)}" font-size="9" fill="#b7791f">threshold</text>`;
  for (const m of markers) if (m.x != null) s += `<line x1="${f(X(m.x))}" x2="${f(X(m.x))}" y1="${T}" y2="${h - B}" stroke="${m.color}" stroke-width="1" stroke-dasharray="3 3" stroke-opacity=".5"/><circle cx="${f(X(m.x))}" cy="${f(Y(1))}" r="3" fill="${m.color}"/>`;
  for (const se of series) {
    const pts = se.y.map((v, i) => `${f(X(i + 1))},${f(Y(v))}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="${se.glow ? 2 : 1.5}" ${se.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
  }
  return s + "</svg>";
}
