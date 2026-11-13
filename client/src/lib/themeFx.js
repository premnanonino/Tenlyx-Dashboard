/* Theme switch effects.
 *
 * Built on the View Transitions API: the browser snapshots the old page, we
 * commit the new theme, then animate the two snapshots. The newer effects
 * reveal the new page through a procedural clip-path (any SVG path, sampled
 * into keyframes up front so nothing is recomputed per frame) and draw
 * particles, shockwaves and cracks on a canvas above both snapshots.
 *
 * Clip functions must emit the same path commands for every t, so the
 * browser can interpolate between the sampled frames.
 *
 * Light → dark plays the selected style; dark → light always plays `sunrise`.
 * Option/Alt-click the theme toggle to move on to the next style.
 */
import { flushSync } from 'react-dom';

const STYLE_KEY = 'tlx-theme-anim';
export const THEME_ANIMATIONS = [
  'supernova', 'ink', 'shatter', 'vortex', 'glitch',
  'cube', 'door', 'fold', 'pixels', 'blinds', 'diamond', 'wipe', 'circle',
];

export function getThemeAnimation() {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return THEME_ANIMATIONS.includes(v) ? v : THEME_ANIMATIONS[0];
  } catch { return THEME_ANIMATIONS[0]; }
}
export function setThemeAnimation(v) {
  try { localStorage.setItem(STYLE_KEY, v); } catch { /* private mode: fine */ }
}

/* ---- maths ---------------------------------------------------------------- */
const TAU = Math.PI * 2;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const hash = (n) => { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); };
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutQuart = (t) => 1 - (1 - t) ** 4;
const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
const f = (n) => n.toFixed(1);
const px = (n) => `${n.toFixed(1)}px`;

/* ---- path builders (all wound clockwise so nonzero fill unions them) ------ */
function circleD(cx, cy, r) {
  r = Math.max(0.01, r);
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0Z`;
}

/** Smooth closed outline around (cx, cy); radiusAt(angle) gives its edge. */
function blobD(cx, cy, n, radiusAt) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    const r = Math.max(0, radiusAt(a));
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  const mid = (p, q) => `${f((p[0] + q[0]) / 2)} ${f((p[1] + q[1]) / 2)}`;
  let d = `M${mid(pts[n - 1], pts[0])}`;
  for (let i = 0; i < n; i += 1) d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${mid(pts[i], pts[(i + 1) % n])}`;
  return `${d}Z`;
}

/** Shake keyframes for a snapshot: decaying jitter plus extra per-frame props. */
function shakeFrames(n, amp, extra = () => ({})) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const k = i / n;
    const a = amp * (1 - k) ** 2;
    const dx = i === n ? 0 : rand(-a, a);
    const dy = i === n ? 0 : rand(-a, a);
    const { scale = 1, ...rest } = extra(k);
    return { offset: k, transform: `translate(${f(dx)}px, ${f(dy)}px) scale(${scale})`, ...rest };
  });
}

/* ---- canvas overlay --------------------------------------------------------- */
function createFx() {
  const c = document.createElement('canvas');
  c.className = 'theme-fx';
  c.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(window.innerWidth * dpr);
  c.height = Math.round(window.innerHeight * dpr);
  document.body.appendChild(c);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  return {
    g,
    clear: () => g.clearRect(0, 0, window.innerWidth, window.innerHeight),
    remove: () => c.remove(),
  };
}

/** Square sparks fired out of (x, y). Velocities are px/ms. */
function makeSparks(n, x, y, { min = 0.3, max = 1.4, size = [3, 8], life = [700, 1400] } = {}) {
  return Array.from({ length: n }, () => {
    const a = rand(0, TAU);
    const s = rand(min, max);
    return {
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      size: rand(...size), rot: rand(0, TAU), vr: rand(-0.02, 0.02),
      life: rand(...life), tone: Math.random(),
    };
  });
}
function stepSparks(g, sparks, ms, dt, colorOf, { gravity = 0.0011, drag = 0.996 } = {}) {
  for (const p of sparks) {
    if (ms > p.life) continue;
    const k = Math.pow(drag, dt);
    p.vx *= k; p.vy = p.vy * k + gravity * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const fade = 1 - ms / p.life;
    g.save();
    g.globalAlpha = fade;
    g.translate(p.x, p.y);
    g.rotate(p.rot);
    g.fillStyle = colorOf(p);
    const s = p.size * (0.4 + 0.6 * fade);
    g.fillRect(-s / 2, -s / 2, s, s);
    g.restore();
  }
}
function ring(g, x, y, r, width, color, alpha) {
  if (r <= 0 || alpha <= 0 || width <= 0) return;
  g.globalAlpha = alpha;
  g.strokeStyle = color;
  g.lineWidth = width;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.stroke();
  g.globalAlpha = 1;
}

/* ---- the next-level effects ------------------------------------------------- */
const STYLES = {
  /* Detonation at the toggle: white-hot flash, screen shake, two shockwaves,
     a spray of sparks, and the new theme bursting out as a spiky star. */
  supernova({ x, y, maxR }) {
    const sparks = makeSparks(90, x, y, { min: 0.25, max: 1.8, life: [800, 1700] });
    const phase = rand(0, TAU);
    return {
      duration: 1150,
      fxExtra: 700,
      clip: (t) => {
        const p = easeInOut(clamp01((t - 0.04) / 0.96));
        const R = p * maxR * 1.12;
        const spikes = (1 - p) * 0.55;
        return `path("${blobD(x, y, 120, (a) => R * (1
          + spikes * Math.abs(Math.sin(a * 7 + phase + t * 3)) ** 8
          + spikes * 0.6 * Math.abs(Math.sin(a * 11 - phase - t * 5)) ** 10
          + 0.04 * (1 - p) * Math.sin(a * 23 + t * 30)))}")`;
      },
      oldKf: shakeFrames(16, 14, (k) => ({
        scale: f(1 - 0.06 * easeOut(k)),
        filter: `brightness(${f(k < 0.06 ? 1 + k * 14 : Math.max(0.5, 1.84 - k * 1.6))}) blur(${f(k * 3)}px)`,
      })),
      fx(g, t, ms, dt, c) {
        // core flash
        const flash = clamp01(1 - ms / 260);
        if (flash > 0) {
          g.globalAlpha = flash;
          g.fillStyle = c.paper;
          g.beginPath(); g.arc(x, y, 30 + (1 - flash) * 120, 0, TAU); g.fill();
          g.globalAlpha = 1;
        }
        const r1 = easeOutQuart(t) * maxR * 1.3;
        ring(g, x, y, r1, 18 * (1 - t) + 1, c.accent, 1 - t);
        const t2 = clamp01((ms - 140) / 1150);
        ring(g, x, y, easeOutQuart(t2) * maxR * 1.1, 6 * (1 - t2) + 1, c.ink, (1 - t2) * 0.8);
        stepSparks(g, sparks, ms, dt, (p) => (p.tone < 0.6 ? c.accent : p.tone < 0.85 ? c.paper : c.ink));
      },
    };
  },

  /* Liquid ink: a wobbling blob pours out of the toggle and flings droplets
     ahead of itself, which the blob then swallows. */
  ink({ x, y, maxR }) {
    const drops = Array.from({ length: 14 }, () => ({
      a: rand(0, TAU), d: rand(0.3, 0.8), r: rand(8, 42), delay: rand(0, 0.25),
    }));
    const splats = makeSparks(40, x, y, { min: 0.3, max: 1.1, size: [4, 11], life: [700, 1300] });
    const phase = rand(0, TAU);
    return {
      duration: 1400,
      fxExtra: 300,
      clip: (t) => {
        const p = easeInOut(t);
        const R = p * maxR * 1.15;
        const wob = (1 - p) * 0.9;
        let d = blobD(x, y, 72, (a) => R * (1
          + wob * 0.10 * Math.sin(3 * a + phase + t * 9)
          + wob * 0.07 * Math.sin(5 * a - phase - t * 7)
          + wob * 0.05 * Math.sin(9 * a + t * 13)));
        for (const dr of drops) {
          const k = clamp01((t - dr.delay) / 0.45);
          const dist = easeOut(k) * dr.d * maxR;
          const r = dr.r * Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.5) * (1 + k * 0.8);
          d += circleD(x + Math.cos(dr.a) * dist, y + Math.sin(dr.a) * dist, r);
        }
        return `path("${d}")`;
      },
      oldKf: { transform: ['scale(1)', 'scale(0.96)'], filter: ['brightness(1)', 'brightness(0.65)'] },
      fx(g, t, ms, dt, c) {
        g.fillStyle = c.accent;
        for (const p of splats) {
          if (ms > p.life) continue;
          const k = Math.pow(0.995, dt);
          p.vx *= k; p.vy = p.vy * k + 0.0016 * dt;
          p.x += p.vx * dt; p.y += p.vy * dt;
          g.globalAlpha = 1 - ms / p.life;
          g.beginPath(); g.arc(p.x, p.y, p.size / 2, 0, TAU); g.fill();
        }
        g.globalAlpha = 1;
      },
    };
  },

  /* Glass: cracks race out of the toggle, the screen jolts, and the new theme
     flies in as spinning shards that lock into place. */
  shatter({ x, y, W, H, maxR }) {
    const cols = 9;
    const cw = W / cols;
    const rows = Math.max(3, Math.round(H / cw));
    const ch = H / rows;
    const grid = [];
    for (let r = 0; r <= rows; r += 1) {
      grid.push([]);
      for (let cI = 0; cI <= cols; cI += 1) {
        const edgeX = cI === 0 || cI === cols;
        const edgeY = r === 0 || r === rows;
        grid[r].push([cI * cw + (edgeX ? 0 : rand(-0.35, 0.35) * cw), r * ch + (edgeY ? 0 : rand(-0.35, 0.35) * ch)]);
      }
    }
    const shards = [];
    const addTri = (a, b, cP) => {
      const cx = (a[0] + b[0] + cP[0]) / 3;
      const cy = (a[1] + b[1] + cP[1]) / 3;
      const dx = cx - x; const dy = cy - y;
      const dist = Math.hypot(dx, dy) || 1;
      const fly = rand(120, 380);
      shards.push({
        v: [a, b, cP], cx, cy,
        sx: cx + (dx / dist) * fly, sy: cy + (dy / dist) * fly,
        spin: rand(-1, 1) * rand(2, 5), delay: (dist / maxR) * 0.5 + rand(0, 0.08),
      });
    };
    for (let r = 0; r < rows; r += 1) {
      for (let cI = 0; cI < cols; cI += 1) {
        const p00 = grid[r][cI]; const p10 = grid[r][cI + 1];
        const p01 = grid[r + 1][cI]; const p11 = grid[r + 1][cI + 1];
        if ((r + cI) % 2) { addTri(p00, p10, p11); addTri(p00, p11, p01); } else { addTri(p00, p10, p01); addTri(p10, p11, p01); }
      }
    }
    const cracks = Array.from({ length: 16 }, (_, i) => {
      const base = (i / 16) * TAU + rand(-0.15, 0.15);
      const pts = [[x, y]];
      let a = base; let px0 = x; let py0 = y;
      const steps = 14;
      for (let s = 0; s < steps; s += 1) {
        a += rand(-0.35, 0.35);
        const len = (maxR / steps) * rand(0.7, 1.3);
        px0 += Math.cos(a) * len; py0 += Math.sin(a) * len;
        pts.push([px0, py0]);
      }
      return pts;
    });
    const sparks = makeSparks(50, x, y, { min: 0.4, max: 1.6, size: [3, 9], life: [600, 1200] });
    return {
      duration: 1300,
      fxExtra: 300,
      clip: (t) => {
        let d = '';
        for (const s of shards) {
          const k = clamp01((t - s.delay) / 0.42);
          const p = easeOutBack(k);
          const ccx = lerp(s.sx, s.cx, p); const ccy = lerp(s.sy, s.cy, p);
          const ang = s.spin * (1 - p);
          const cos = Math.cos(ang); const sin = Math.sin(ang);
          const sc = k <= 0 ? 0 : (0.15 + 0.85 * Math.min(1, p)) * 1.015;
          d += 'M';
          d += s.v.map(([vx, vy]) => {
            const ox = (vx - s.cx) * sc; const oy = (vy - s.cy) * sc;
            return `${f(ccx + ox * cos - oy * sin)} ${f(ccy + ox * sin + oy * cos)}`;
          }).join('L');
          d += 'Z';
        }
        return `path("${d}")`;
      },
      oldKf: shakeFrames(18, 18, (k) => ({
        scale: f(1 - 0.04 * easeOut(k)),
        filter: `brightness(${f(1 - 0.5 * k)}) blur(${f(k * 2.5)}px)`,
      })),
      fx(g, t, ms, dt, c) {
        const grow = easeOut(clamp01(ms / 320));
        const fade = 1 - clamp01((ms - 250) / 600);
        if (fade > 0) {
          g.strokeStyle = c.paper;
          g.lineJoin = 'miter';
          for (const pts of cracks) {
            const n = Math.max(1, Math.floor(grow * (pts.length - 1)));
            g.globalAlpha = fade;
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i <= n; i += 1) g.lineTo(pts[i][0], pts[i][1]);
            g.stroke();
            g.strokeStyle = c.accent;
            g.lineWidth = 1.2;
            g.stroke();
            g.strokeStyle = c.paper;
          }
          g.globalAlpha = 1;
        }
        stepSparks(g, sparks, ms, dt, (p) => (p.tone < 0.5 ? c.paper : c.accent), { gravity: 0.0018 });
      },
    };
  },

  /* Black hole: the old page spirals down into the toggle while particles
     stream in around it; the new theme settles out from underneath. */
  vortex({ x, y, maxR }) {
    const motes = Array.from({ length: 160 }, () => ({
      a: rand(0, TAU), r: rand(60, maxR * 1.1), w: rand(0.8, 1.6), size: rand(2, 6), tone: Math.random(),
    }));
    const origin = `${f(x)}px ${f(y)}px`;
    return {
      duration: 1400,
      fxExtra: 250,
      oldOnTop: true,
      oldKf: [
        { transformOrigin: origin, transform: 'rotate(0deg) scale(1)', filter: 'blur(0px) brightness(1)' },
        { transformOrigin: origin, transform: 'rotate(-30deg) scale(0.92)', filter: 'blur(0px) brightness(0.9)', offset: 0.25 },
        { transformOrigin: origin, transform: 'rotate(-720deg) scale(0)', filter: 'blur(8px) brightness(0.3)' },
      ],
      oldEasing: 'cubic-bezier(0.55, 0, 0.9, 0.5)',
      newKf: [
        { transformOrigin: origin, transform: 'rotate(14deg) scale(1.25)', filter: 'brightness(0.4)' },
        { transformOrigin: origin, transform: 'rotate(0deg) scale(1)', filter: 'brightness(1)' },
      ],
      newEasing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      fx(g, t, ms, dt, c) {
        const pull = 0.15 + easeInOut(t) * 2.4;
        for (const m of motes) {
          if (m.r < 4) continue;
          m.a += (m.w * dt * 0.06 * pull) / Math.max(0.6, m.r / 120);
          m.r -= dt * 0.25 * pull * (0.4 + 220 / (m.r + 60));
          const k = clamp01(m.r / 60);
          g.globalAlpha = (1 - t * 0.6) * Math.min(1, k + 0.2);
          g.fillStyle = m.tone < 0.65 ? c.accent : c.paper;
          const s = m.size * (0.4 + 0.6 * k);
          g.fillRect(x + Math.cos(m.a) * m.r - s / 2, y + Math.sin(m.a) * m.r - s / 2, s, s);
        }
        // event horizon
        const pulse = 16 + Math.sin(ms / 60) * 4;
        ring(g, x, y, pulse * (1 + t), 3, c.accent, 1 - t);
        ring(g, x, y, pulse * 2.2 * (1 + t * 0.5), 1.5, c.paper, (1 - t) * 0.6);
        g.globalAlpha = 1;
      },
    };
  },

  /* Digital glitch: the new theme tears in as jittering horizontal bands,
     with colour-split ghosting and noise blocks that flicker out. */
  glitch({ W, H }) {
    const bands = 22;
    const tick = 45; // ms per glitch "frame"
    const n = 18;
    return {
      duration: 1000,
      clipStep: tick,
      clip: (t, ms) => {
        const done = t > 0.88;
        const seed = Math.floor(ms / tick);
        let yy = 0; let d = '';
        const weights = Array.from({ length: bands }, (_, i) => 0.3 + hash(seed * 7.1 + i * 3.3));
        const sum = weights.reduce((a, b) => a + b, 0);
        weights.forEach((w, i) => {
          const h = (w / sum) * H;
          const on = done || hash(seed * 13.7 + i * 1.9) < t * 1.25 - 0.05;
          const shift = done ? 0 : (1 - t) * (hash(seed + i * 5.5) - 0.5) * 80;
          const bh = on ? h + 0.5 : 0; // hidden bands collapse to zero height
          d += `M${f(shift)} ${f(yy)}L${f(W + shift)} ${f(yy)}L${f(W + shift)} ${f(yy + bh)}L${f(shift)} ${f(yy + bh)}Z`;
          yy += h;
        });
        return `path("${d}")`;
      },
      newKf: Array.from({ length: n + 1 }, (_, i) => {
        const k = i / n;
        const a = (1 - k) * 14;
        const dx = i === n ? 0 : rand(-a, a);
        return {
          offset: k,
          easing: 'steps(1, end)',
          transform: `translateX(${f(i === n ? 0 : rand(-a, a))}px)`,
          filter: i === n ? 'none' : `drop-shadow(${f(dx)}px 0 0 var(--accent)) drop-shadow(${f(-dx)}px 0 0 var(--ok))`,
        };
      }),
      oldKf: Array.from({ length: n + 1 }, (_, i) => {
        const k = i / n;
        const a = (1 - k * 0.5) * 18;
        return {
          offset: k,
          easing: 'steps(1, end)',
          transform: `translate(${f(rand(-a, a))}px, ${f(rand(-a / 4, a / 4))}px) skewX(${f(rand(-4, 4) * (1 - k))}deg)`,
          filter: `hue-rotate(${Math.round(rand(-60, 60))}deg) contrast(${f(rand(1, 1.6))})`,
        };
      }),
      fx(g, t, ms, dt, c) {
        const seed = Math.floor(ms / tick);
        const count = Math.round(14 * (1 - t));
        for (let i = 0; i < count; i += 1) {
          const bx = hash(seed * 3.1 + i * 9.7) * W;
          const by = hash(seed * 5.3 + i * 2.1) * H;
          const bw = 20 + hash(seed + i * 4.4) * 260;
          const bh = 2 + hash(seed * 1.7 + i) * 26;
          g.globalAlpha = 0.85;
          g.fillStyle = hash(seed + i * 8.8) < 0.5 ? c.accent : hash(i + seed) < 0.5 ? c.ink : c.paper;
          g.fillRect(bx, by, bw, bh);
        }
        g.globalAlpha = 1;
      },
    };
  },

  /* Dawn (used for dark → light): a sun climbs from below the screen, its light
     spreading upward as a widening dome while rays sweep the sky, the night
     sinks away beneath, and dust motes drift up through the new light. */
  sunrise({ W, H }) {
    const sx = W / 2;
    const startY = H + 60;
    const endY = H * 0.62;
    const far = Math.hypot(W / 2, Math.max(endY, H - endY)) * 1.08;
    const rays = 14;
    const motes = Array.from({ length: 70 }, () => ({
      x: rand(0, W), y: rand(H * 0.4, H + 40), v: rand(0.03, 0.12), s: rand(2, 5), d: rand(0, 0.35),
    }));
    const sunAt = (t) => {
      const cy = lerp(startY, endY, easeOut(clamp01(t / 0.8)));
      const R = easeInOut(clamp01((t - 0.08) / 0.92)) * far;
      return { cy, R };
    };
    return {
      duration: 1500,
      fxExtra: 250,
      clip: (t) => {
        const { cy, R } = sunAt(t);
        const shimmer = (1 - t) * 0.008;
        return `path("${blobD(sx, cy, 96, (a) => R * (1 + shimmer * Math.sin(a * 14 + t * 18)))}")`;
      },
      oldKf: { transform: ['translateY(0) scale(1)', 'translateY(7%) scale(0.97)'], filter: ['brightness(1)', 'brightness(0.45)'] },
      oldEasing: 'cubic-bezier(0.5, 0, 0.3, 1)',
      newKf: { filter: ['brightness(1.25)', 'brightness(1)'] },
      newEasing: 'cubic-bezier(0.3, 0, 0.2, 1)',
      fx(g, t, ms, dt, c) {
        const { cy, R } = sunAt(t);
        const sunY = cy - R; // the sun rides the crest of the light
        const fade = 1 - clamp01((t - 0.7) / 0.3);
        if (fade <= 0) return;
        // Light rays sweeping slowly across the sky.
        const spin = ms / 2600;
        g.fillStyle = c.accent;
        for (let i = 0; i < rays; i += 1) {
          const a = -Math.PI + (i / (rays - 1)) * Math.PI + Math.sin(spin + i) * 0.04;
          const len = Math.max(W, H) * 1.3;
          const half = 0.035;
          g.globalAlpha = 0.16 * fade;
          g.beginPath();
          g.moveTo(sx, sunY);
          g.lineTo(sx + Math.cos(a - half) * len, sunY + Math.sin(a - half) * len);
          g.lineTo(sx + Math.cos(a + half) * len, sunY + Math.sin(a + half) * len);
          g.closePath();
          g.fill();
        }
        // The sun: a disc with a crown of short spinning rays.
        const sr = 22 + 10 * easeOut(clamp01(t * 1.5));
        g.globalAlpha = fade;
        g.beginPath(); g.arc(sx, sunY, sr, 0, TAU); g.fill();
        g.save();
        g.translate(sx, sunY);
        g.rotate(ms / 900);
        for (let i = 0; i < 12; i += 1) {
          g.rotate(TAU / 12);
          g.fillRect(-2, -(sr + 16), 4, 9);
        }
        g.restore();
        ring(g, sx, sunY, sr + 30 + Math.sin(ms / 120) * 3, 2, c.accent, 0.5 * fade);
        // Dust motes rising through the light.
        for (const m of motes) {
          if (t < m.d) continue;
          m.y -= m.v * dt;
          g.globalAlpha = 0.7 * fade;
          g.fillStyle = c.accent;
          g.fillRect(m.x + Math.sin((ms + m.x) / 300) * 6, m.y, m.s, m.s);
        }
        g.globalAlpha = 1;
      },
    };
  },

  /* ---- 3D page turns ------------------------------------------------------ */
  cube({ x, W }) {
    const P = 'perspective(2200px)';
    const dir = x > W / 2 ? 1 : -1;
    const oo = dir > 0 ? 'right center' : 'left center';
    const no = dir > 0 ? 'left center' : 'right center';
    return {
      oldKf: {
        transformOrigin: [oo, oo],
        transform: [`${P} translateX(0) rotateY(0deg)`, `${P} translateX(${-dir * 100}%) rotateY(${-dir * 90}deg)`],
        filter: ['brightness(1)', 'brightness(0.35)'],
      },
      newKf: {
        transformOrigin: [no, no],
        transform: [`${P} translateX(${dir * 100}%) rotateY(${dir * 90}deg)`, `${P} translateX(0) rotateY(0deg)`],
        filter: ['brightness(0.35)', 'brightness(1)'],
      },
      easing: 'cubic-bezier(0.7, 0, 0.25, 1)', duration: 1100,
    };
  },
  door({ x, W }) {
    const P = 'perspective(2200px)';
    const hinge = x > W / 2 ? 'left' : 'right';
    const sign = hinge === 'left' ? 1 : -1;
    return {
      oldKf: {
        transformOrigin: [`${hinge} center`, `${hinge} center`],
        transform: [`${P} rotateY(0deg)`, `${P} rotateY(${sign * 92}deg)`],
        filter: ['brightness(1)', 'brightness(0.4)'],
      },
      newKf: { transform: ['scale(0.9)', 'scale(1)'], filter: ['brightness(0.5)', 'brightness(1)'] },
      easing: 'cubic-bezier(0.6, 0, 0.15, 1)', duration: 1150, oldOnTop: true,
    };
  },
  fold() {
    const P = 'perspective(2200px)';
    return {
      oldKf: [
        { transformOrigin: 'center bottom', transform: `${P} rotateX(0deg)`, filter: 'brightness(1)' },
        { transformOrigin: 'center bottom', transform: `${P} rotateX(-12deg)`, filter: 'brightness(0.95)', offset: 0.25 },
        { transformOrigin: 'center bottom', transform: `${P} rotateX(90deg)`, filter: 'brightness(0.3)' },
      ],
      newKf: { transform: ['translateY(-4%) scale(0.92)', 'translateY(0) scale(1)'], filter: ['brightness(0.5)', 'brightness(1)'] },
      easing: 'cubic-bezier(0.55, 0, 0.85, 0.35)', newEasing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', duration: 900, oldOnTop: true,
    };
  },

  /* ---- clip-path reveals -------------------------------------------------- */
  pixels({ x, y, W, H, maxR }) {
    const cols = 18;
    const size = W / cols;
    const rows = Math.ceil(H / size);
    const rects = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cx = c * size + size / 2;
        const cy = r * size + size / 2;
        const d = Math.hypot(cx - x, cy - y) / maxR;
        rects.push({ cx, cy, hw: size / 2 + 0.6, hh: size / 2 + 0.6, delay: d * 0.55 + hash(c * 12.9 + r * 78.2) * 0.08, span: 0.37 });
      }
    }
    return { frames: rectFrames(rects, 48, easeOutBack), easing: 'linear', duration: 1000 };
  },
  blinds({ x, W, H }) {
    const n = 14;
    const w = W / n;
    const from = Math.floor(x / w);
    const far = Math.max(from, n - 1 - from) || 1;
    const rects = Array.from({ length: n }, (_, i) => ({
      cx: i * w + w / 2, cy: H / 2, hw: w / 2 + 0.6, hh: H / 2 + 1,
      delay: (Math.abs(i - from) / far) * 0.45, span: 0.55,
    }));
    return { frames: rectFrames(rects, 40, easeInOut), easing: 'linear', duration: 950, depth: true };
  },
  diamond({ x, y, W, H }) {
    const r = Math.max(x + y, W - x + y, x + H - y, W - x + H - y);
    const shape = (k) => `polygon(${px(x)} ${px(y - k)}, ${px(x + k)} ${px(y)}, ${px(x)} ${px(y + k)}, ${px(x - k)} ${px(y)})`;
    return { frames: [shape(0), shape(r)], easing: 'cubic-bezier(0.7, 0, 0.1, 1)', duration: 900, depth: true };
  },
  wipe({ x, W, H }) {
    const slant = H * 0.35;
    const fromRight = x > W / 2;
    const shape = (e) => (fromRight
      ? `polygon(${px(W)} 0px, ${px(W - e)} 0px, ${px(W - e + slant)} ${px(H)}, ${px(W)} ${px(H)})`
      : `polygon(0px 0px, ${px(e)} 0px, ${px(e - slant)} ${px(H)}, 0px ${px(H)})`);
    return { frames: [shape(0), shape(W + slant)], easing: 'cubic-bezier(0.76, 0, 0.24, 1)', duration: 850, depth: true };
  },
  circle({ x, y, maxR }) {
    return {
      frames: [`circle(0px at ${px(x)} ${px(y)})`, `circle(${px(maxR)} at ${px(x)} ${px(y)})`],
      easing: 'cubic-bezier(0.65, 0, 0.15, 1)', duration: 850, depth: true,
    };
  },
};

/** Many rectangles as one interpolatable polygon (zero-area seams join them). */
function rectFrames(rects, frames, ease) {
  const out = [];
  for (let i = 0; i <= frames; i += 1) {
    const t = i / frames;
    const pts = [];
    for (const r of rects) {
      const p = ease(clamp01((t - r.delay) / r.span));
      const hw = r.hw * p;
      const hh = r.hh * p;
      const a = `${px(r.cx - hw)} ${px(r.cy - hh)}`;
      pts.push('0px 0px', a, `${px(r.cx + hw)} ${px(r.cy - hh)}`,
        `${px(r.cx + hw)} ${px(r.cy + hh)}`, `${px(r.cx - hw)} ${px(r.cy + hh)}`, a, '0px 0px');
    }
    out.push(`polygon(${pts.join(',')})`);
  }
  return out;
}

/* ---- driver ----------------------------------------------------------------- */
/** Sample a procedural clip into keyframes: smooth (~60 per second), or held
 *  steps every `clipStep` ms for effects that should look choppy. */
function clipKeyframes(spec) {
  const { duration, clipStep } = spec;
  const n = clipStep ? Math.ceil(duration / clipStep) : Math.max(24, Math.round(duration / 16));
  return Array.from({ length: n + 1 }, (_, i) => ({
    offset: i / n,
    clipPath: spec.clip(i / n, (i / n) * duration),
    ...(clipStep ? { easing: 'steps(1, end)' } : {}),
  }));
}

const DEPTH_OLD = { transform: ['scale(1)', 'scale(0.94)'], filter: ['brightness(1) blur(0px)', 'brightness(0.7) blur(2px)'] };
const DIM_OLD = { filter: ['brightness(1)', 'brightness(0.8)'] };

/**
 * Switch to `next` with the chosen effect, centred on `origin` (an event or
 * element). Falls back to a colour cross-fade (plus the canvas effect) where
 * View Transitions are missing, and is instant for prefers-reduced-motion.
 */
export function animateThemeChange(next, commitTheme, origin, chosen) {
  // Going dark uses the selected effect; going light always plays the sunrise
  // (unless a style was picked explicitly with Option-click).
  const style = chosen ?? (next === 'light' ? 'sunrise' : getThemeAnimation());
  const root = document.documentElement;
  const commit = () => flushSync(commitTheme);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { commit(); return; }

  const W = window.innerWidth;
  const H = window.innerHeight;
  let x = W - 40;
  let y = 40;
  const el = origin?.currentTarget ?? origin;
  if (el?.getBoundingClientRect) {
    const r = el.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  const maxR = Math.hypot(Math.max(x, W - x), Math.max(y, H - y));
  const spec = (STYLES[style] ?? STYLES.supernova)({ x, y, W, H, maxR });
  const duration = spec.duration;
  const fx = spec.fx ? createFx() : null;

  const loop = () => {
    const cs = getComputedStyle(root);
    const v = (name) => cs.getPropertyValue(name).trim();
    const colors = { accent: v('--accent'), ink: v('--ink'), paper: v('--paper'), ok: v('--ok') };
    const total = duration + (spec.fxExtra ?? 0);
    const t0 = performance.now();
    let last = t0;
    const tick = (now) => {
      const ms = now - t0;
      const dt = Math.min(40, now - last);
      last = now;
      const t = clamp01(ms / duration);
      if (fx) { fx.clear(); spec.fx(fx.g, t, ms, dt, colors); }
      if (ms < total) requestAnimationFrame(tick);
      else fx?.remove();
    };
    requestAnimationFrame(tick);
  };

  if (!document.startViewTransition) {
    root.classList.add('theme-fade');
    commit();
    loop();
    window.setTimeout(() => root.classList.remove('theme-fade'), 600);
    return;
  }

  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.classList.add('theme-switching');
  root.classList.toggle('vt-old-top', Boolean(spec.oldOnTop));

  const transition = document.startViewTransition(commit);
  transition.ready.then(() => {
    const easing = spec.easing ?? 'linear';
    const opts = { duration, fill: 'forwards' };
    // Every effect animates both snapshots for its full length, which is also
    // what keeps the transition alive while the per-frame clip runs.
    const newKf = spec.newKf ?? (spec.frames ? { clipPath: spec.frames } : { opacity: [1, 1] });
    const oldKf = spec.oldKf ?? (spec.depth ? DEPTH_OLD : DIM_OLD);
    const oldEasing = spec.oldEasing ?? (spec.oldKf ? easing : 'cubic-bezier(0.65, 0, 0.15, 1)');
    root.animate(newKf, { ...opts, easing: spec.newEasing ?? easing, pseudoElement: '::view-transition-new(root)' });
    root.animate(oldKf, { ...opts, easing: oldEasing, pseudoElement: '::view-transition-old(root)' });
    if (spec.clip) {
      root.animate(clipKeyframes(spec), { ...opts, easing: 'linear', pseudoElement: '::view-transition-new(root)' });
    }
    loop();
  }).catch(() => fx?.remove());
  transition.finished.finally(() => {
    root.classList.remove('theme-switching', 'vt-old-top');
  });
}
