import * as THREE from 'three';
import {
  pointsVertex, pointsFragment, arcVertex, arcFragment, starsVertex, starsFragment,
} from './shaders.js';

const PALETTE = {
  night: new THREE.Color('#0C0C0B'),
  paper: new THREE.Color('#EFEBE2'),
  sea: new THREE.Color('#57534A'),
  accent: new THREE.Color('#E0482A'),
  rule: new THREE.Color('#8C867A'),
};

const POINT_COUNT = 64_000;
const HUB_COUNT = 16;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const easeInCubic = (t) => t * t * t;
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/* ---------------------------------------------------------------------------
 * CPU-side value noise + fBm, used once to build the land mask.
 * ------------------------------------------------------------------------- */
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, y, z) {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const xf = x - xi; const yf = y - yi; const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf); const v = yf * yf * (3 - 2 * yf); const w = zf * zf * (3 - 2 * zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x, y, z) {
  let sum = 0; let amp = 0.5; let freq = 1; let norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(x * freq + 13.1, y * freq + 7.7, z * freq + 3.3);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Spherical linear interpolation between unit vectors. */
function slerp(a, b, t, out) {
  const dot = clamp(a.dot(b), -1, 1);
  const theta = Math.acos(dot) * t;
  const rel = b.clone().sub(a.clone().multiplyScalar(dot)).normalize();
  return out.copy(a).multiplyScalar(Math.cos(theta)).add(rel.multiplyScalar(Math.sin(theta)));
}

export class GlobeScene {
  constructor(canvas, { onProgress, onPointer } = {}) {
    this.canvas = canvas;
    this.onProgress = onProgress || (() => {});
    this.onPointer = onPointer || (() => {});
    this.disposed = false;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.pointer = new THREE.Vector2(0, 0);
    this.pointerNdc = new THREE.Vector2(9, 9);
    this.pointerMoved = false;
    this.drag = { active: false, x: 0, y: 0, vx: 0, vy: 0 };
    this.rot = { y: -1.2, x: 0.32, vy: 0.08, vx: 0 };
    this.hovering = false;
    this.introStart = 0;
    this.dive = null;
    this.layout = { x: 1.0, y: 0, z: 4.6 };
    this.listeners = [];
  }

  /* ------------------------------------------------------------------ boot */
  async init() {
    const report = (p, msg) => { if (!this.disposed) this.onProgress(p, msg); };

    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(PALETTE.night, 1);
    this.renderer = renderer;
    const gl = renderer.getContext();
    report(4, `webgl${renderer.capabilities.isWebGL2 ? '2' : '1'} context · dpr ${renderer.getPixelRatio()} · max tex ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.root = new THREE.Group();
    this.globe = new THREE.Group();
    this.hud = new THREE.Group();
    this.root.add(this.globe, this.hud);
    this.scene.add(this.root);
    this.time = { value: 0 };

    this.#resize();
    await this.#buildPoints(report);
    if (this.disposed) return;
    this.#buildHubsAndArcs(report);
    await nextFrame();
    this.#buildGraticule();
    this.#buildOrbits(report);
    this.#buildHud();
    this.#buildStars();
    this.#buildHitSphere();
    await nextFrame();
    if (this.disposed) return;

    report(88, 'compiling shader programs');
    await nextFrame();
    renderer.compile(this.scene, this.camera);
    report(100, 'link established');
    this.#bindEvents();
  }

  async #buildPoints(report) {
    report(8, `allocating ${POINT_COUNT.toLocaleString()} surface nodes`);
    const positions = new Float32Array(POINT_COUNT * 3);
    const raw = new Float32Array(POINT_COUNT);
    const seeds = new Float32Array(POINT_COUNT);
    const CHUNK = 8000;

    // Fibonacci lattice: near-uniform point distribution on a sphere.
    for (let start = 0; start < POINT_COUNT; start += CHUNK) {
      const end = Math.min(POINT_COUNT, start + CHUNK);
      for (let i = start; i < end; i++) {
        const y = 1 - ((i + 0.5) / POINT_COUNT) * 2;
        const r = Math.sqrt(1 - y * y);
        const phi = i * GOLDEN_ANGLE;
        const x = Math.cos(phi) * r;
        const z = Math.sin(phi) * r;
        positions.set([x, y, z], i * 3);
        raw[i] = fbm(x * 1.6, y * 1.6, z * 1.6) + 0.06 * Math.abs(y) * -1;
        seeds[i] = hash3(i, 7, 13);
      }
      report(8 + (end / POINT_COUNT) * 40, null);
      await nextFrame();
      if (this.disposed) return;
    }

    // Threshold at the 70th percentile so exactly ~30% of nodes are land.
    const sorted = Float32Array.from(raw).sort();
    const threshold = sorted[Math.floor(sorted.length * 0.7)];
    const land = new Float32Array(POINT_COUNT);
    this.landIdx = [];
    for (let i = 0; i < POINT_COUNT; i++) {
      land[i] = raw[i] > threshold ? 1 : 0;
      if (land[i]) this.landIdx.push(i);
    }
    this.positions = positions;
    report(50, `land mask · fbm 5 octaves · ${((this.landIdx.length / POINT_COUNT) * 100).toFixed(1)}% coverage`);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aLand', new THREE.BufferAttribute(land, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.pointUniforms = {
      uTime: this.time,
      uSize: { value: 1 },
      uReveal: { value: 0 },
      uDive: { value: 0 },
      uScan: { value: 0 },
      uPointer: { value: new THREE.Vector3(0, 0, 9) },
      uPointerStrength: { value: 0 },
      uSea: { value: PALETTE.sea },
      uLand: { value: PALETTE.paper },
      uHot: { value: PALETTE.accent },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      uniforms: this.pointUniforms,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.globe.add(this.points);
    this.#sizePoints();
  }

  /**
   * Hubs are chosen by farthest-point sampling over land nodes: each new
   * hub maximises its distance to the hubs already chosen, which spreads
   * them evenly instead of clumping. O(k * m).
   */
  #buildHubsAndArcs(report) {
    const P = this.positions;
    const vec = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const stride = Math.max(1, Math.floor(this.landIdx.length / 3000));
    const cand = this.landIdx.filter((_, k) => k % stride === 0).map(vec);
    const minDist = new Float32Array(cand.length).fill(Infinity);
    const hubs = [cand[Math.floor(cand.length * 0.37)]];
    while (hubs.length < HUB_COUNT) {
      const last = hubs[hubs.length - 1];
      let best = 0;
      for (let i = 0; i < cand.length; i++) {
        minDist[i] = Math.min(minDist[i], cand[i].distanceToSquared(last));
        if (minDist[i] > minDist[best]) best = i;
      }
      hubs.push(cand[best]);
    }
    this.hubs = hubs;
    report(60, `farthest-point sampling · ${HUB_COUNT} exchange hubs`);

    // Connect each hub to two others, skipping near neighbours.
    const pairs = new Set();
    hubs.forEach((a, i) => {
      const order = hubs
        .map((b, j) => ({ j, ang: a.angleTo(b) }))
        .filter((x) => x.j !== i && x.ang > 0.45)
        .sort((x, y) => x.ang - y.ang);
      for (const { j } of [order[1], order[Math.floor(order.length / 2)]].filter(Boolean)) {
        pairs.add(i < j ? `${i}-${j}` : `${j}-${i}`);
      }
    });

    this.arcs = [];
    const tmp = new THREE.Vector3();
    for (const key of pairs) {
      const [i, j] = key.split('-').map(Number);
      const a = hubs[i]; const b = hubs[j];
      const height = 0.06 + 0.32 * (a.angleTo(b) / Math.PI);
      const pts = [];
      for (let s = 0; s <= 48; s++) {
        const t = s / 48;
        slerp(a, b, t, tmp);
        pts.push(tmp.clone().multiplyScalar(1.012 + height * Math.sin(Math.PI * t)));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = new THREE.TubeGeometry(curve, 96, 0.0032, 5, false);
      const uniforms = {
        uTime: this.time,
        uSpeed: { value: 0.12 + hash3(i, j, 1) * 0.22 },
        uPhase: { value: hash3(i, j, 2) },
        uDraw: { value: 0 },
        uDive: { value: 0 },
        uColor: { value: PALETTE.accent },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: arcVertex, fragmentShader: arcFragment, uniforms, transparent: true, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      this.globe.add(mesh);
      this.arcs.push({ mesh, uniforms, delay: this.arcs.length * 0.07 });
    }

    // Hub markers: solid dot + expanding ring.
    this.markers = hubs.map((h, k) => {
      const g = new THREE.Group();
      g.position.copy(h).multiplyScalar(1.02);
      g.lookAt(h.clone().multiplyScalar(2));
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.009, 16), new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0 }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.02, 40), new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      g.add(dot, ring);
      this.globe.add(g);
      return { g, dot, ring, phase: k / hubs.length };
    });
    report(66, `routing ${this.arcs.length} carrier arcs`);
  }

  #buildGraticule() {
    const verts = [];
    const R = 1.003;
    const seg = 120;
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.sin((lat * Math.PI) / 180); const r = Math.cos((lat * Math.PI) / 180);
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2; const a1 = ((s + 1) / seg) * Math.PI * 2;
        verts.push(Math.cos(a0) * r * R, y * R, Math.sin(a0) * r * R, Math.cos(a1) * r * R, y * R, Math.sin(a1) * r * R);
      }
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const a = (lon * Math.PI) / 180;
      for (let s = 0; s < seg; s++) {
        const t0 = (s / seg) * Math.PI * 2; const t1 = ((s + 1) / seg) * Math.PI * 2;
        verts.push(
          Math.cos(t0) * Math.cos(a) * R, Math.sin(t0) * R, Math.cos(t0) * Math.sin(a) * R,
          Math.cos(t1) * Math.cos(a) * R, Math.sin(t1) * R, Math.cos(t1) * Math.sin(a) * R,
        );
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.graticuleMat = new THREE.LineBasicMaterial({ color: PALETTE.rule, transparent: true, opacity: 0, depthWrite: false });
    this.globe.add(new THREE.LineSegments(geo, this.graticuleMat));
  }

  /** Three inclined orbital shells of instanced "pollers". */
  #buildOrbits(report) {
    const shells = [
      { r: 1.3, tilt: 0.42, spin: 0.9, n: 28, speed: 0.22 },
      { r: 1.46, tilt: -0.75, spin: 2.1, n: 36, speed: -0.15 },
      { r: 1.64, tilt: 1.15, spin: 0.3, n: 32, speed: 0.1 },
    ];
    const total = shells.reduce((s, x) => s + x.n, 0);
    const geo = new THREE.BoxGeometry(0.01, 0.01, 0.034);
    this.satMat = new THREE.MeshBasicMaterial({ color: PALETTE.paper, transparent: true, opacity: 0 });
    this.sats = new THREE.InstancedMesh(geo, this.satMat, total);
    this.sats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.satList = [];
    this.orbitLines = [];
    for (const sh of shells) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(sh.tilt, sh.spin, 0));
      for (let k = 0; k < sh.n; k++) {
        // Clustered along the ring like constellation trains.
        const base = Math.floor(k / 4) * ((Math.PI * 2) / Math.ceil(sh.n / 4)) + (k % 4) * 0.06;
        this.satList.push({ sh, q, a: base });
      }
      const pts = [];
      for (let s = 0; s <= 160; s++) {
        const a = (s / 160) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * sh.r, 0, Math.sin(a) * sh.r).applyQuaternion(q));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: PALETTE.rule, dashSize: 0.02, gapSize: 0.03, transparent: true, opacity: 0 }),
      );
      line.computeLineDistances();
      this.root.add(line);
      this.orbitLines.push(line);
    }
    this.root.add(this.sats);
    this.dummy = new THREE.Object3D();
    report(76, `orbit shells · ${shells.length} · ${total} instanced pollers`);
  }

  /** Instrument bezel: tick ring + silhouette, always facing the camera. */
  #buildHud() {
    const verts = [];
    const R = 1.2;
    for (let d = 0; d < 360; d += 2) {
      const a = (d * Math.PI) / 180;
      const len = d % 30 === 0 ? 0.06 : d % 10 === 0 ? 0.035 : 0.015;
      verts.push(Math.cos(a) * R, Math.sin(a) * R, 0, Math.cos(a) * (R + len), Math.sin(a) * (R + len), 0);
    }
    const ticks = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)),
      new THREE.LineBasicMaterial({ color: PALETTE.rule, transparent: true, opacity: 0 }),
    );
    const outline = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.004, 160),
      new THREE.MeshBasicMaterial({ color: PALETTE.rule, transparent: true, opacity: 0 }),
    );
    // Short accent arc that sweeps around the bezel.
    const sweep = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.075, R + 0.085, 64, 1, 0, Math.PI / 5),
      new THREE.MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0 }),
    );
    this.hudTicks = ticks;
    this.hudOutline = outline;
    this.hudSweep = sweep;
    this.hud.add(ticks, outline, sweep);
  }

  #buildStars() {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    const scale = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 8 + hash3(i, 1, 1) * 14;
      const th = hash3(i, 2, 2) * Math.PI * 2;
      const ph = Math.acos(2 * hash3(i, 3, 3) - 1);
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)], i * 3);
      scale[i] = 0.5 + hash3(i, 4, 4) * 1.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    this.starUniforms = { uSize: { value: 30 }, uColor: { value: PALETTE.paper }, uAlpha: { value: 0 } };
    this.stars = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: starsVertex, fragmentShader: starsFragment, uniforms: this.starUniforms, transparent: true, depthWrite: false,
    }));
    this.scene.add(this.stars);
  }

  #buildHitSphere() {
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ visible: false }));
    this.globe.add(this.hit);
    this.raycaster = new THREE.Raycaster();
  }

  /* --------------------------------------------------------------- events */
  #on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  #bindEvents() {
    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(this.canvas);

    this.#on(window, 'pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set((e.clientX / rect.width) * 2 - 1, -(e.clientY / rect.height) * 2 + 1);
      this.pointerNdc.copy(this.pointer);
      this.pointerMoved = true;
      if (this.drag.active) {
        const dx = e.clientX - this.drag.x; const dy = e.clientY - this.drag.y;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.rot.y += dx * 0.005;
        this.rot.x = clamp(this.rot.x + dy * 0.004, -0.9, 0.9);
        this.rot.vy = dx * 0.3; this.rot.vx = dy * 0.2;
      }
    });
    this.#on(this.canvas, 'pointerdown', (e) => {
      this.drag = { active: true, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.#on(window, 'pointerup', () => { this.drag.active = false; this.canvas.style.cursor = ''; });
    this.#on(document, 'pointerleave', () => this.pointerNdc.set(9, 9));
  }

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const narrow = w / h < 0.9;
    this.layout = narrow ? { x: 0, y: -1.05, z: 6.2 } : { x: w < 1100 ? 0.75 : 1.0, y: 0, z: 4.6 };
    this.camera.updateProjectionMatrix();
    this.#sizePoints();
  }

  #sizePoints() {
    if (!this.pointUniforms) return;
    const h = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.pointUniforms.uSize.value = h * 0.0042;
    if (this.starUniforms) this.starUniforms.uSize.value = h * 0.02;
  }

  /* ----------------------------------------------------------------- loop */
  start() {
    this.clock = new THREE.Clock();
    this.introStart = 0;
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  /** Camera dive + particle burst. Resolves when the transition is done. */
  diveIn() {
    return new Promise((resolve) => {
      this.dive = { t0: this.time.value, dur: this.reduced ? 0.45 : 1.45, resolve, fromZ: this.camera.position.z };
    });
  }

  #tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = (this.time.value += dt);
    const intro = clamp(t / 2.2, 0, 1);
    const introE = easeOutExpo(intro);

    // Rotation: drag with inertia, relaxing back to a slow auto-spin.
    if (!this.drag.active) {
      const auto = this.reduced ? 0.02 : 0.07;
      this.rot.vy += (auto - this.rot.vy) * (1 - Math.exp(-dt * 1.4));
      this.rot.vx *= Math.exp(-dt * 3);
      this.rot.y += this.rot.vy * dt;
      this.rot.x = clamp(this.rot.x + this.rot.vx * dt, -0.9, 0.9);
      this.rot.x += (0.32 - this.rot.x) * (1 - Math.exp(-dt * 0.6));
    }

    let diveT = 0;
    if (this.dive) {
      diveT = clamp((t - this.dive.t0) / this.dive.dur, 0, 1);
      this.rot.y += dt * 2.4 * easeInCubic(diveT);
    }

    this.globe.rotation.set(this.rot.x, this.rot.y, 0);

    // Layout + pointer parallax + dive dolly.
    const L = this.layout;
    this.root.position.x += (L.x - this.root.position.x) * 0.08;
    this.root.position.y += (L.y - this.root.position.y) * 0.08;
    const parX = this.pointer.x * 0.12; const parY = this.pointer.y * 0.08;
    const baseZ = L.z + (1 - introE) * 1.6;
    const diveE = easeInCubic(diveT);
    this.camera.position.set(
      this.camera.position.x + (parX - this.camera.position.x) * 0.05,
      this.camera.position.y + (parY - this.camera.position.y) * 0.05,
      baseZ - diveE * (baseZ - 1.5),
    );
    this.camera.fov = 35 + diveE * 30;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.root.position.x * 0.55, this.root.position.y * 0.55, 0);

    // Shader uniforms.
    const U = this.pointUniforms;
    U.uReveal.value = introE;
    U.uDive.value = diveE;
    U.uScan.value = Math.sin(t * 0.35) * 0.92;

    // Pointer → surface hit for the ripple + lat/lon readout.
    if (this.pointerMoved && !this.dive) {
      this.pointerMoved = false;
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hit = this.raycaster.intersectObject(this.hit, false)[0];
      this.hovering = !!hit;
      if (hit) {
        const local = this.globe.worldToLocal(hit.point.clone()).normalize();
        U.uPointer.value.copy(local);
        const lat = (Math.asin(local.y) * 180) / Math.PI;
        const lon = (Math.atan2(local.x, local.z) * 180) / Math.PI;
        this.onPointer({ lat, lon });
      } else {
        this.onPointer(null);
      }
    }
    const targetStrength = this.hovering && !this.dive ? 1 : 0;
    U.uPointerStrength.value += (targetStrength - U.uPointerStrength.value) * 0.06;

    // Arcs write themselves on after the sphere has formed.
    for (const arc of this.arcs) {
      const k = clamp((t - 1.4 - arc.delay) / 0.9, 0, 1);
      arc.uniforms.uDraw.value = easeOutExpo(k) * 1.001;
      arc.uniforms.uDive.value = diveE;
    }
    for (const m of this.markers) {
      const ph = (t * 0.6 + m.phase) % 1;
      const vis = clamp((t - 1.6) / 0.6, 0, 1) * (1 - diveE);
      m.ring.scale.setScalar(1 + ph * 2.2);
      m.ring.material.opacity = (1 - ph) * vis;
      m.dot.material.opacity = vis;
    }

    // Instanced pollers.
    const fadeIn = clamp((t - 1.0) / 1.2, 0, 1) * (1 - diveE);
    this.satMat.opacity = fadeIn * 0.85;
    const d = this.dummy;
    const p = new THREE.Vector3(); const ahead = new THREE.Vector3();
    this.satList.forEach((s, i) => {
      const a = s.a + t * s.sh.speed;
      const r = s.sh.r * (1 + diveE * 1.5);
      p.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(s.q);
      ahead.set(Math.cos(a + 0.01 * Math.sign(s.sh.speed)) * r, 0, Math.sin(a + 0.01 * Math.sign(s.sh.speed)) * r).applyQuaternion(s.q);
      d.position.copy(p);
      d.lookAt(ahead);
      d.updateMatrix();
      this.sats.setMatrixAt(i, d.matrix);
    });
    this.sats.instanceMatrix.needsUpdate = true;
    for (const line of this.orbitLines) line.material.opacity = fadeIn * 0.35;

    // HUD bezel faces the camera and turns slowly.
    this.hud.quaternion.copy(this.camera.quaternion);
    this.hudTicks.rotation.z += dt * 0.03;
    this.hudSweep.rotation.z -= dt * 0.5;
    const hudVis = clamp((t - 0.8) / 1, 0, 1) * (1 - diveE);
    this.hudTicks.material.opacity = hudVis * 0.55;
    this.hudOutline.material.opacity = hudVis * 0.5;
    this.hudSweep.material.opacity = hudVis;
    this.hud.scale.setScalar(1 + diveE * 0.8);
    this.graticuleMat.opacity = introE * 0.12 * (1 - diveE);

    this.stars.rotation.y = t * 0.004 + this.pointer.x * 0.03;
    this.stars.rotation.x = this.pointer.y * 0.02;
    this.starUniforms.uAlpha.value = introE * 0.45 * (1 - diveE * 0.5);

    this.renderer.render(this.scene, this.camera);

    if (this.dive && diveT >= 1) {
      const { resolve } = this.dive;
      this.dive = { ...this.dive, resolve: null };
      resolve?.();
    }
  }

  /* -------------------------------------------------------------- cleanup */
  dispose() {
    this.disposed = true;
    this.renderer?.setAnimationLoop(null);
    this.ro?.disconnect();
    this.listeners.forEach((off) => off());
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => m.dispose());
    });
    this.renderer?.dispose();
  }
}
