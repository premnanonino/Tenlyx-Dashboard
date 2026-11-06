// 3D simplex noise — Ashima Arts / Stefan Gustavson (MIT).
export const SNOISE = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/* ----------------------------------------------------------------------------
 * Globe point cloud.
 * - land points sit higher and "breathe" on a slow noise field
 * - a latitude scan band sweeps up and down
 * - the pointer leaves a radial ripple on the surface
 * - uReveal grows the sphere in from the north pole on boot
 * - uDive bursts every point outward along a noise-perturbed normal
 * ------------------------------------------------------------------------- */
export const pointsVertex = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uReveal;
uniform float uDive;
uniform float uScan;
uniform vec3  uPointer;
uniform float uPointerStrength;
attribute float aLand;
attribute float aSeed;
varying float vLand;
varying float vHot;
varying float vAlpha;
${SNOISE}
void main() {
  vec3 n = normalize(position);

  float lat01 = n.y * 0.5 + 0.5;
  float edge = 1.0 - uReveal * 1.15;
  float reveal = smoothstep(edge, edge + 0.12, lat01);

  float d = distance(n, uPointer);
  float ripple = sin(d * 34.0 - uTime * 7.0) * exp(-d * 7.0) * uPointerStrength;

  float breathe = snoise(n * 2.4 + vec3(0.0, uTime * 0.12, 0.0));
  float band = 1.0 - smoothstep(0.0, 0.028, abs(n.y - uScan));
  float lift = aLand * (0.016 + 0.012 * breathe) + ripple * 0.035 + band * 0.018 * aLand;

  vec3 jitter = vec3(
    snoise(n * 3.0 + aSeed * 11.0),
    snoise(n * 3.0 + 17.0),
    snoise(n * 3.0 + 31.0)
  );
  vec3 dir = normalize(n + jitter * 0.45);
  float burst = uDive * uDive * (0.9 + aSeed * 2.6);

  vec3 p = n * (1.0 + lift) * mix(0.55, 1.0, reveal) + dir * burst;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float facing = dot(normalize(normalMatrix * n), normalize(-mv.xyz));
  float size = mix(1.0, 2.3, aLand) + band * 1.5 * aLand + max(ripple, 0.0) * 2.6;
  gl_PointSize = size * uSize / -mv.z;

  vLand = aLand;
  vHot = clamp(band * aLand + max(ripple, 0.0) * 1.6, 0.0, 1.0);
  vAlpha = reveal * (1.0 - uDive * 0.9) * mix(0.1, 1.0, smoothstep(-0.2, 0.35, facing));
}
`;

export const pointsFragment = /* glsl */ `
uniform vec3 uSea;
uniform vec3 uLand;
uniform vec3 uHot;
varying float vLand;
varying float vHot;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  vec3 col = vLand > 0.5 ? uLand : uSea;
  col = vHot > 0.35 ? uHot : col;
  gl_FragColor = vec4(col, vAlpha * (vLand > 0.5 ? 1.0 : 0.6));
}
`;

/* ----------------------------------------------------------------------------
 * Route arcs: a faint full-length trace plus a travelling packet with a
 * fading tail. uDraw "writes" the arc on during the intro.
 * ------------------------------------------------------------------------- */
export const arcVertex = /* glsl */ `
varying float vT;
void main() {
  vT = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const arcFragment = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uPhase;
uniform float uDraw;
uniform float uDive;
uniform vec3  uColor;
varying float vT;
void main() {
  if (vT > uDraw) discard;
  float head = fract(uTime * uSpeed + uPhase);
  float d = head - vT;
  float tail = (d >= 0.0 && d < 0.26) ? pow(1.0 - d / 0.26, 2.0) : 0.0;
  float a = max(0.14, tail) * (1.0 - uDive);
  gl_FragColor = vec4(uColor, a);
}
`;

/* Background dust with depth-based size. */
export const starsVertex = /* glsl */ `
uniform float uSize;
attribute float aScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * aScale / -mv.z;
}
`;

export const starsFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(uColor, uAlpha);
}
`;
