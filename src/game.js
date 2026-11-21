// TIDEBREAK — LAN deathmatch. Three.js r160.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Water } from 'three/addons/objects/Water.js';
import { makeOperator, poseOperator, killOperator, reviveOperator, muzzleWorld, lookFor, ropeMaterial, camoTexture } from './operator.js';
import { NavGrid, Bot, rayCombatants } from './bots.js';
import { Match, MAX_HP, SPAWNS, TEAM_NAMES, RESPAWN_MS } from '../match.js';
import * as P2P from './p2p.js';

const V3 = THREE.Vector3, $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t, R = (a, b) => a + (b - a) * Math.random();
let seed = 20261109;
const sr = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const SR = (a, b) => a + (b - a) * sr();
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('tb_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tb_' + k, JSON.stringify(v)); } catch (e) { } }
};
// maxPR caps the pixel ratio, budget caps the rendered pixel count (big Retina screens), auto adapts resolution to hold 60 fps.
const QUALITY = {
  auto: { maxPR: 1.25, budget: 3.7e6, samples: 4, shadow: 4096, bloom: true, refl: 512, adaptive: true },
  ultra: { maxPR: 2, budget: 9e6, samples: 4, shadow: 4096, bloom: true, refl: 1024 },
  high: { maxPR: 1.5, budget: 4.2e6, samples: 4, shadow: 4096, bloom: true, refl: 512 },
  fast: { maxPR: 1, budget: 1.8e6, samples: 0, shadow: 2048, bloom: false, refl: 256 }
};
const settings = { name: store.get('name', ''), sens: store.get('sens', 1), quality: store.get('quality2', 'auto'), fov: clamp(+store.get('fov', 75) || 75, 60, 100), vol: clamp(+store.get('vol', 0.9), 0, 1),
  color: store.get('color', -1) | 0, camo: store.get('camo', 'std'), skin: store.get('skin', 'std'), primary: clamp(store.get('primary', 0) | 0, 0, 2) };
if (!QUALITY[settings.quality]) settings.quality = 'auto';
const PALETTE = [0xffb547, 0x5fd0ff, 0xa6e35a, 0xff6fb5, 0xf2efe6, 0xff7a45, 0xb48cff, 0x2f7fe0]; // armband colours a player can pick
const PALETTE_CSS = ['#ffb547', '#5fd0ff', '#a6e35a', '#ff6fb5', '#f2efe6', '#ff7a45', '#b48cff', '#4f97f0'];
const colorIdx = p => (Number.isInteger(p.color) && p.color >= 0 ? p.color : p.slot || 0) % PALETTE.length;
const TEAM_COLORS = [0x2f7fe0, 0xe0452f], TEAM_CSS = ['#5aa2ff', '#ff6a52'];
const MAP = { x0: -42, x1: 70, z0: -66, z1: 38 }; // play bounds: compound (x -42..42) + dock yard (x 42..70) + pier and harbour water to z -66

// ======================================================= RENDERER
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
const FOG = new THREE.Color(0x6b4f4f);
scene.fog = new THREE.FogExp2(FOG, 0.0036);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1500);
camera.rotation.order = 'YXZ';
const wScene = new THREE.Scene();
const wCam = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.01, 10);
wScene.add(wCam);

const SUN_DIR = new V3(-0.62, 0.235, -0.77).normalize(); // a little higher than before: long shadows, but not so grazing that they smear

// ======================================================= SKY + ENVIRONMENT
const skyUniforms = {
  uSun: { value: SUN_DIR.clone() }, uZen: { value: new THREE.Color(0x14244a) }, uHor: { value: new THREE.Color(0xc98577) },
  uHorSun: { value: new THREE.Color(0xff9440) }, uGround: { value: new THREE.Color(0x2b2630) }, uCloud: { value: new THREE.Color(0x291a29) }, uDisk: { value: 60 }, uTime: { value: 0 }
};
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
  uniform vec3 uSun,uZen,uHor,uHorSun,uGround,uCloud; uniform float uDisk,uTime; varying vec3 vD;
  float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.03; a*=.5; } return s; }
  void main(){
    vec3 d = normalize(vD); float h = d.y; float s = max(dot(d,uSun),0.);
    vec3 hor = mix(uHor, uHorSun, pow(s,4.0));
    vec3 c = mix(hor, uZen, pow(clamp(h,0.,1.),0.5));
    c += uHorSun * pow(s,10.0) * 0.8;
    // clouds on a plane
    if (h > 0.0) {
      vec2 cp = d.xz / (h + 0.12) * 1.6 + vec2(uTime*0.004, 0.0);
      float n = fbm(cp) ; float cov = smoothstep(0.52, 0.78, n) * smoothstep(0.0, 0.08, h);
      vec3 lit = mix(uCloud, uHorSun*1.6, pow(s,3.0)*0.9 + 0.15);
      lit += vec3(1.2,0.55,0.25) * pow(s,24.0) * 2.0;
      c = mix(c, lit, cov*0.85);
    }
    c += vec3(1.0,0.72,0.42) * pow(s,600.0) * 6.0;
    c += vec3(1.0,0.82,0.55) * smoothstep(0.99955,0.9998,s) * uDisk;
    c = mix(c, uGround, smoothstep(0.0,-0.06,h));
    gl_FragColor = vec4(c,1.0);
  }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMat);
sky.frustumCulled = false; sky.renderOrder = -1;
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
{
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat);
  envScene.add(envSky);
  skyUniforms.uDisk.value = 6;
  const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
  skyUniforms.uDisk.value = 60;
  scene.environment = rt.texture;
  wScene.environment = rt.texture;
}

const hemi = new THREE.HemisphereLight(0x8094c8, 0x4a372c, 0.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffae73, 3.4);
sun.position.copy(SUN_DIR).multiplyScalar(110).add(new V3(14, 0, -12)); sun.target.position.set(14, 0, -12);
sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -64, right: 64, top: 64, bottom: -64, near: 10, far: 260 });
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
// Fit the shadow camera to the whole playable world (compound, dock yard, pier and the ship's berth) in the sun's own frame.
// The old fixed square missed two corners of the map and wasted most of its height, which showed as missing and blocky shadows.
// Through the sniper scope only a thin slice of the island is on screen, so the same map is then spent on just that slice
// (`view`: world points the scope can see). The slice snaps to a coarse grid so the shadows hold still while the aim wanders.
let shadowView = null;
function fitShadows(view) {
  const C = new V3(14, 0, -20); sun.position.copy(SUN_DIR).multiplyScalar(170).add(C); sun.target.position.copy(C); sun.updateMatrixWorld(true); sun.target.updateMatrixWorld(true);
  const cam = sun.shadow.camera; cam.position.copy(sun.position); cam.lookAt(C); cam.updateMatrixWorld(true);
  const inv = cam.matrixWorld.clone().invert(), b = new THREE.Box3(), v = new V3();
  for (const x of [-44, 72]) for (const y of [-3, 44]) for (const z of [-82, 40]) b.expandByPoint(v.set(x, y, z).applyMatrix4(inv));
  if (view) {
    const f = new THREE.Box3(), G = 6; for (const q of view) f.expandByPoint(v.copy(q).applyMatrix4(inv));
    for (const a of ['x', 'y']) { b.min[a] = Math.max(b.min[a], Math.floor((f.min[a] - 3) / G) * G); b.max[a] = Math.min(b.max[a], Math.ceil((f.max[a] + 3) / G) * G); }
  }
  const l = b.min.x - 1, r = b.max.x + 1, bo = b.min.y - 1, t = b.max.y + 1, n = Math.max(1, -b.max.z - 30), fa = -b.min.z + 5;
  if (cam.left !== l || cam.right !== r || cam.bottom !== bo || cam.top !== t || cam.near !== n || cam.far !== fa) { cam.left = l; cam.right = r; cam.bottom = bo; cam.top = t; cam.near = n; cam.far = fa; cam.updateProjectionMatrix(); }
}
function scopeView() { // the part of the world box each corner of the scoped view passes through
  const pts = [], o = camera.position; camera.updateMatrixWorld();
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
    const d = new V3(x, y, 0.5).unproject(camera).sub(o).normalize(); let t0 = 1, t1 = 400;
    for (const [a, lo, hi] of [['x', -46, 74], ['y', -4, 46], ['z', -84, 42]]) {
      if (Math.abs(d[a]) < 1e-6) { if (o[a] < lo || o[a] > hi) t1 = -1; continue; }
      let ta = (lo - o[a]) / d[a], tb = (hi - o[a]) / d[a]; if (ta > tb) { const q = ta; ta = tb; tb = q; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t1 > t0) pts.push(o.clone().addScaledVector(d, t0), o.clone().addScaledVector(d, t1));
  }
  return pts.length >= 6 ? pts : null;
}
fitShadows();

// Viewmodel lights (driven from world sun each frame)
wScene.add(new THREE.HemisphereLight(0x8a9ad0, 0x3a2c24, 0.55));
const wSun = new THREE.DirectionalLight(0xffb07a, 2.2); wScene.add(wSun, wSun.target);
const wFlash = new THREE.PointLight(0xffb066, 0, 2.5, 2); wScene.add(wFlash);

// ======================================================= TEXTURES
function ctex(size, draw, { srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function grain(g, S, amt) {
  const im = g.getImageData(0, 0, S, S), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const n = (sr() - 0.5) * amt; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(im, 0, 0);
}
function blot(g, S, n, col, rmin, rmax) {
  for (let i = 0; i < n; i++) {
    const x = sr() * S, y = sr() * S, r = SR(rmin, rmax);
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const cx = x + ox, cy = y + oy; if (cx + r < 0 || cx - r > S || cy + r < 0 || cy - r > S) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    }
  }
}
const T = {};
T.asphalt = ctex(1024, (g, S) => {
  g.fillStyle = '#3d3c3d'; g.fillRect(0, 0, S, S);
  blot(g, S, 60, 'rgba(20,18,18,.35)', 30, 160); blot(g, S, 40, 'rgba(120,112,104,.18)', 20, 120);
  for (let i = 0; i < 9000; i++) { const v = 70 + sr() * 90 | 0; g.fillStyle = `rgba(${v},${v - 4},${v - 8},${0.35 + sr() * 0.5})`; g.fillRect(sr() * S, sr() * S, 1 + sr() * 2, 1 + sr() * 2); }
  g.strokeStyle = 'rgba(10,10,10,.55)'; g.lineWidth = 1.3;
  for (let i = 0; i < 14; i++) { let x = sr() * S, y = sr() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 30; k++) { x += SR(-14, 14); y += SR(-14, 14); g.lineTo(x, y); } g.stroke(); }
  grain(g, S, 24);
});
T.wet = ctex(512, (g, S) => {
  g.fillStyle = 'rgb(215,215,215)'; g.fillRect(0, 0, S, S);
  blot(g, S, 18, 'rgba(112,112,112,.85)', 20, 70); blot(g, S, 30, 'rgba(146,146,146,.6)', 10, 40);
  grain(g, S, 30);
}, { srgb: false });
T.concrete = ctex(512, (g, S) => {
  g.fillStyle = '#8f8a82'; g.fillRect(0, 0, S, S);
  blot(g, S, 40, 'rgba(60,55,50,.25)', 20, 110); blot(g, S, 30, 'rgba(190,185,175,.18)', 20, 90);
  for (let i = 0; i < 26; i++) { const x = sr() * S, w = 2 + sr() * 8; const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, 'rgba(40,35,30,.35)'); gr.addColorStop(1, 'rgba(40,35,30,0)'); g.fillStyle = gr; g.fillRect(x, 0, w, S * (0.3 + sr() * 0.7)); }
  g.fillStyle = 'rgba(30,28,26,.5)'; for (let y = 0; y < S; y += 128) g.fillRect(0, y, S, 2);
  for (let y = 64; y < S; y += 128) for (let x = 64; x < S; x += 128) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); }
  grain(g, S, 26);
});
function corrDraw(g, S, color) {
  for (let x = 0; x < S; x++) { const v = Math.sin(x / S * Math.PI * 2 * 16); const s = color ? 152 + 34 * v : 128 + 120 * v; /* gentle stripes in the paint; the normal map does the ridges */ g.fillStyle = `rgb(${s},${s},${s})`; g.fillRect(x, 0, 1, S); }
  if (color) { blot(g, S, 50, 'rgba(90,50,25,.35)', 8, 50); blot(g, S, 30, 'rgba(30,30,30,.3)', 20, 90); grain(g, S, 20); }
}
T.corr = ctex(512, (g, S) => corrDraw(g, S, true));
// The ridges are a normal map, not a bump map: a bump map is shaded from screen-space height differences, which
// turn into sparkling noise once the ridges get close to a pixel wide. A normal map just fades to flat with distance.
T.corrN = ctex(512, (g, S) => {
  for (let x = 0; x < S; x++) { const sl = -0.62 * Math.cos(x / S * Math.PI * 2 * 16), L = Math.hypot(sl, 1); g.fillStyle = `rgb(${Math.round(127.5 + 127.5 * sl / L)},128,${Math.round(127.5 + 127.5 / L)})`; g.fillRect(x, 0, 1, S); }
}, { srgb: false });
const CORR_NS = new THREE.Vector2(0.9, 0.9);
T.wood = ctex(256, (g, S) => {
  g.fillStyle = '#7d5f3c'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(${90 + sr() * 40},${65 + sr() * 25},${35 + sr() * 15},1)`; g.fillRect(0, i * S / 6, S, S / 6 - 3); }
  g.strokeStyle = 'rgba(40,25,10,.35)'; for (let i = 0; i < 120; i++) { const y = sr() * S; g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(S / 3, y + SR(-4, 4), 2 * S / 3, y + SR(-4, 4), S, y); g.stroke(); }
  g.strokeStyle = '#3a2814'; g.lineWidth = 14; g.strokeRect(0, 0, S, S); g.lineWidth = 10; g.beginPath(); g.moveTo(0, 0); g.lineTo(S, S); g.stroke();
  grain(g, S, 22);
});
T.burlap = ctex(256, (g, S) => {
  g.fillStyle = '#8b7a58'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < S; i += 3) { g.fillStyle = 'rgba(60,48,30,.25)'; g.fillRect(i, 0, 1, S); g.fillRect(0, i, S, 1); }
  blot(g, S, 20, 'rgba(50,40,25,.35)', 10, 50); grain(g, S, 30);
});
T.paint = ctex(512, (g, S) => {
  g.fillStyle = '#d29a1e'; g.fillRect(0, 0, S, S);
  blot(g, S, 70, 'rgba(70,40,20,.5)', 3, 22); blot(g, S, 20, 'rgba(40,30,20,.3)', 30, 100); grain(g, S, 20);
});
T.hole = ctex(64, (g, S) => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 30); gr.addColorStop(0, 'rgba(5,5,5,1)'); gr.addColorStop(0.18, 'rgba(10,10,10,.95)'); gr.addColorStop(0.3, 'rgba(40,36,32,.6)'); gr.addColorStop(1, 'rgba(60,55,50,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
});
T.flash = ctex(128, (g, S) => {
  const c = S / 2; const gr = g.createRadialGradient(c, c, 0, c, c, c); gr.addColorStop(0, 'rgba(255,250,220,1)'); gr.addColorStop(0.25, 'rgba(255,190,90,.9)'); gr.addColorStop(1, 'rgba(255,120,30,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(255,220,150,.8)';
  for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2 + sr() * 0.3; g.lineWidth = 3 + sr() * 4; g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(a) * c * 0.95, c + Math.sin(a) * c * 0.95); g.stroke(); }
});
T.glow = ctex(64, (g, S) => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
T.waterN = ctex(512, (g, S) => {
  const im = g.createImageData(S, S), d = im.data, P = Math.PI * 2 / S;
  const W = []; let sd = 7;
  const rr = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  for (let i = 0; i < 48; i++) { const f = 2 + Math.floor(Math.pow(rr(), 1.6) * 40); const a = rr() * Math.PI * 2; W.push([Math.round(Math.cos(a) * f), Math.round(Math.sin(a) * f), 1 / Math.pow(f, 1.15), rr() * 6.28]); }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let dx = 0, dy = 0; for (const [a, b, amp, ph0] of W) { const ph = (a * x + b * y) * P + ph0; const c = Math.cos(ph) * amp; dx += c * a; dy += c * b; }
    const k = 0.28; let nx = -dx * k, ny = -dy * k, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4; d[i] = (nx / l * .5 + .5) * 255; d[i + 1] = (ny / l * .5 + .5) * 255; d[i + 2] = (nz / l * .5 + .5) * 255; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
}, { srgb: false });

T.flag = (() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d');
  const blue = '#0d5eaf', H = 400 / 9;
  for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? '#ffffff' : blue; g.fillRect(0, i * H, 600, H + 0.5); }
  const k = H * 5; g.fillStyle = blue; g.fillRect(0, 0, k, k); g.fillStyle = '#fff'; g.fillRect(k * 2 / 5, 0, k / 5, k); g.fillRect(0, k * 2 / 5, k, k / 5);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; return t;
})();
T.roundel = ctex(256, (g, S) => {
  const c = S / 2; g.clearRect(0, 0, S, S);
  for (const [r, col] of [[0.48, '#0d5eaf'], [0.32, '#ffffff'], [0.16, '#0d5eaf']]) { g.fillStyle = col; g.beginPath(); g.arc(c, c, S * r, 0, 7); g.fill(); }
});
T.whitewash = ctex(512, (g, S) => {
  g.fillStyle = '#efebe2'; g.fillRect(0, 0, S, S);
  blot(g, S, 40, 'rgba(160,150,135,.18)', 20, 120); blot(g, S, 25, 'rgba(255,255,255,.25)', 20, 90);
  for (let i = 0; i < 18; i++) { const x = sr() * S, w = 2 + sr() * 6; const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, 'rgba(120,105,90,.18)'); gr.addColorStop(1, 'rgba(120,105,90,0)'); g.fillStyle = gr; g.fillRect(x, 0, w, S * (0.2 + sr() * 0.5)); }
  grain(g, S, 14);
});
T.stone = ctex(512, (g, S) => {
  g.fillStyle = '#9b8a72'; g.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 32) for (let x = -((y / 32) % 2) * 24; x < S; x += 48) { const v = 120 + sr() * 70 | 0; g.fillStyle = `rgb(${v},${v - 14},${v - 34})`; g.fillRect(x + 2, y + 2, 44, 28); }
  grain(g, S, 20);
});

// ======================================================= MATERIALS
const std = o => new THREE.MeshStandardMaterial(o);
const M = {
  asphalt: std({ map: T.asphalt, roughnessMap: T.wet, roughness: 1, metalness: 0 }),
  concrete: std({ map: T.concrete, roughness: 0.93, metalness: 0 }),
  concreteDark: std({ map: T.concrete, color: 0x8a8580, roughness: 0.95 }),
  wallMetal: std({ map: T.corr, normalMap: T.corrN, normalScale: CORR_NS, color: 0x8f9a9e, roughness: 0.6, metalness: 0.4 }),
  roof: std({ map: T.corr, normalMap: T.corrN, normalScale: CORR_NS, color: 0x6c6460, roughness: 0.66, metalness: 0.38 }),
  steel: std({ color: 0x3b3e42, roughness: 0.42, metalness: 0.85 }),
  steelLight: std({ color: 0x8b9095, roughness: 0.46, metalness: 0.85 }),
  rail: std({ color: 0xb7b2a8, roughness: 0.55, metalness: 0.6 }),
  paint: std({ map: T.paint, roughness: 0.55, metalness: 0.35 }),
  wood: std({ map: T.wood, roughness: 0.82 }),
  burlap: std({ map: T.burlap, roughness: 1 }),
  rubber: std({ color: 0x161616, roughness: 0.92 }),
  glass: std({ color: 0x0a0e12, roughness: 0.05, metalness: 0.9 }),
  canvas: std({ map: T.burlap, color: 0x6b6a4c, roughness: 0.95 }),
  olive: std({ color: 0x4a5236, roughness: 0.6, metalness: 0.3 }),
  warm: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc483, emissiveIntensity: 6 }),
  winGlow: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffb36b, emissiveIntensity: 2.6, roughness: 0.2, metalness: 0.5 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0d0, emissiveIntensity: 5.5 }),
  red: new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.2) }),
  stripe: std({ color: 0xd8c25a, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
  water: std({ color: 0x0c2630, roughness: 0.16, metalness: 0.0, normalMap: T.waterN, normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: 1.5 }),
  dirt: std({ map: T.asphalt, color: 0x9a8a6a, roughness: 1 }),
  whitewash: std({ map: T.whitewash, roughness: 0.9 }),
  aegean: std({ color: 0x1f5fa8, roughness: 0.6 }),
  stone: std({ map: T.stone, roughness: 0.95 }),
  terracotta: std({ color: 0xb4583a, roughness: 0.85 }),
  cypress: std({ color: 0x2c3a22, roughness: 0.95 }),
  oliveLeaf: std({ color: 0x6f7a55, roughness: 0.95 }),
  bark: std({ color: 0x4a3a2c, roughness: 1 }),
  flag: new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.8, side: THREE.DoubleSide, alphaTest: 0.5, transparent: false })
};
// Ground anti-tiling: each ground material samples its texture twice (normal scale, and rotated at a
// different scale) and blends between them with world-space noise, then lays a broad patchy tint on top,
// so no repeating grid shows across big open areas.
function antiTile(mat, tint = [1, 1, 1], amt = 0.5) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTint = { value: new THREE.Color(...tint) }; sh.uniforms.uAmt = { value: amt };
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `varying vec3 vWPos; uniform vec3 uTint; uniform float uAmt;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm2(vec2 p) { return vn(p) * 0.65 + vn(p * 2.7 + 5.1) * 0.35; }
` + sh.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
  float aN = fbm2(vWPos.xz * 0.07), bN = fbm2(vWPos.xz * 0.015 + 7.3), cN = fbm2(vWPos.xz * 0.035 + 3.1);
  vec4 tA = texture2D(map, vMapUv), tB = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.43 + vec2(0.31, 0.17));
  vec4 sampledDiffuseColor = mix(tA, tB, smoothstep(0.3, 0.7, aN));
  sampledDiffuseColor.rgb *= mix(1.0 - 0.25 * uAmt, 1.0 + 0.2 * uAmt, bN);
  sampledDiffuseColor.rgb *= mix(vec3(1.0), uTint, smoothstep(0.45, 0.8, cN) * uAmt);
  diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  mat.customProgramCacheKey = () => 'antitile' + tint.join(',') + amt;
  return mat;
}
antiTile(M.asphalt, [0.78, 0.74, 0.7], 0.7); antiTile(M.dirt, [0.85, 0.92, 0.62], 0.9);
const CONTAINER_COLORS = [0x8e3b2a, 0x22406a, 0x3f5f3a, 0xb0602a, 0x6a6e70, 0x7a2f3c, 0x2f5c63];
const containerMats = CONTAINER_COLORS.map(c => std({ map: T.corr, normalMap: T.corrN, normalScale: CORR_NS, color: c, roughness: 0.66, metalness: 0.36 }));
const barrelMats = [0x2d4f7c, 0x8b2c22, 0x3d4a2b, 0x9a6a20].map(c => std({ color: c, roughness: 0.5, metalness: 0.5 }));

// ======================================================= WORLD BUILDING
const colliders = [];          // {min:[x,y,z], max:[x,y,z]}
const staticMeshes = [];       // merged after build
const ammoCrates = [];
const STEP = 0.45;

function boxGeo(w, h, d, s = 2) {
  const g = new THREE.BoxGeometry(w, h, d); const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / s, uv.getY(k) * dims[f][1] / s); }
  return g;
}
// Hand-plastered box: corners and edges rounded off with smooth normals, the Cycladic look (no sharp CG edges).
const _pbCache = new Map();
function plasterGeo(w, h, d, r = 0.22, s = 3) {
  const key = [w, h, d, r, s].map(v => v.toFixed(2)).join(); if (_pbCache.has(key)) return _pbCache.get(key);
  r = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  const g = boxGeo(w, h, d, s), sub = new THREE.BoxGeometry(w, h, d, 5, 5, 5); // segmented copy for the rounding
  const uv0 = g.attributes.uv; sub.attributes.uv.array.set(sub.attributes.uv.array); // keep sub's uv, rescaled below
  const pos = sub.attributes.position, nor = sub.attributes.normal, uv = sub.attributes.uv, iw = w / 2 - r, ih = h / 2 - r, id = d / 2 - r, p = new V3(), c = new V3();
  // push the segment rows toward the edges so the rounding is tight
  for (let i = 0; i < pos.count; i++) {
    const f = (v, half) => { const t = v / half; return Math.sign(t) * Math.pow(Math.abs(t), 0.45) * half; };
    p.set(f(pos.getX(i), w / 2), f(pos.getY(i), h / 2), f(pos.getZ(i), d / 2));
    c.set(clamp(p.x, -iw, iw), clamp(p.y, -ih, ih), clamp(p.z, -id, id));
    const n = p.clone().sub(c); const L = n.length();
    if (L > 1e-5) { n.divideScalar(L); p.copy(c).addScaledVector(n, r); nor.setXYZ(i, n.x, n.y, n.z); }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  const faceDims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]], per = uv.count / 6;
  for (let fI = 0; fI < 6; fI++) for (let k = 0; k < per; k++) { const j = fI * per + k; uv.setXY(j, uv.getX(j) * faceDims[fI][0] / s, uv.getY(j) * faceDims[fI][1] / s); }
  g.dispose(); _pbCache.set(key, sub); return sub;
}
function addCollider(x0, y0, z0, x1, y1, z1, noRay = false) { colliders.push({ noRay, min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)] }); }
let noCastScope = false; // scenery outside the shadow area
function place(geo, mat, x, y, z, o = {}) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
  if (o.ry) m.rotation.y = o.ry; if (o.rx) m.rotation.x = o.rx; if (o.rz) m.rotation.z = o.rz;
  m.castShadow = o.cast !== false && !noCastScope; m.receiveShadow = o.receive !== false;
  if (o.dynamic) scene.add(m); else staticMeshes.push(m);
  return m;
}
// Box with bottom at y0
function addBox(cx, y0, cz, w, h, d, mat, o = {}) {
  const m = place(boxGeo(w, h, d, o.s || 2), mat, cx, y0 + h / 2, cz, o);
  if (o.collide !== false) {
    const top = Math.min(h, o.ch || h); addCollider(cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + top, cz + d / 2);
    if (o.ch && o.ch > h) addCollider(cx - w / 2, y0 + h, cz - d / 2, cx + w / 2, y0 + o.ch, cz + d / 2, true);
  }
  return m;
}
function cyl(r, h, seg = 16) { return new THREE.CylinderGeometry(r, r, h, seg); }

function wallRun(axis, fixed, a0, a1, h, t, gaps, mat, s = 3) {
  const seg = (s0, s1, yb, hh) => {
    if (hh <= 0.01 || s1 - s0 <= 0.01) return;
    const len = s1 - s0, mid = (s0 + s1) / 2;
    if (axis === 'x') addBox(mid, yb, fixed, len, hh, t, mat, { s }); else addBox(fixed, yb, mid, t, hh, len, mat, { s });
  };
  let cur = a0;
  for (const g of gaps.slice().sort((a, b) => a.c - b.c)) {
    const g0 = g.c - g.w / 2, g1 = g.c + g.w / 2;
    seg(cur, g0, 0, h); if (g.y0) seg(g0, g1, 0, g.y0); seg(g0, g1, g.h, h - g.h); cur = g1;
  }
  seg(cur, a1, 0, h);
}
// doors: {side:'n'|'s'|'e'|'w', off, w, h}
function building({ cx, cz, w, d, h, doors = [], wall = M.wallMetal, roof = M.roof, t = 0.3, base = true, noRoof = false }) {
  const gapsFor = (side, plinth) => doors.filter(dr => dr.side === side && !(plinth && dr.y0)).map(dr => ({ c: (side === 'n' || side === 's' ? cx : cz) + dr.off, w: dr.w, h: dr.h, y0: dr.y0 || 0 }));
  wallRun('x', cz - d / 2 + t / 2, cx - w / 2, cx + w / 2, h, t, gapsFor('n'), wall);
  wallRun('x', cz + d / 2 - t / 2, cx - w / 2, cx + w / 2, h, t, gapsFor('s'), wall);
  wallRun('z', cx - w / 2 + t / 2, cz - d / 2 + t, cz + d / 2 - t, h, t, gapsFor('w'), wall);
  wallRun('z', cx + w / 2 - t / 2, cz - d / 2 + t, cz + d / 2 - t, h, t, gapsFor('e'), wall);
  if (!noRoof) {
    addBox(cx, h, cz, w + 0.6, 0.25, d + 0.6, roof, { s: 4.8 });
    if (roof === M.roof) addBox(cx, h + 0.25, cz, w + 0.7, 0.12, d + 0.7, M.steel, { collide: false });
  }
  if (base) { // concrete plinth strip outside
    const bt = 0.08, bh = 0.7;
    for (const [side, along] of [['n', 'x'], ['s', 'x'], ['w', 'z'], ['e', 'z']]) {
      const fixed = side === 'n' ? cz - d / 2 - bt / 2 : side === 's' ? cz + d / 2 + bt / 2 : side === 'w' ? cx - w / 2 - bt / 2 : cx + w / 2 + bt / 2;
      const a0 = along === 'x' ? cx - w / 2 - bt : cz - d / 2, a1 = along === 'x' ? cx + w / 2 + bt : cz + d / 2;
      const gaps = gapsFor(side, true);
      let cur = a0; const seg = (s0, s1) => { if (s1 - s0 < 0.05) return; const mid = (s0 + s1) / 2, len = s1 - s0; if (along === 'x') addBox(mid, 0, fixed, len, bh, bt, M.concreteDark, { collide: false }); else addBox(fixed, 0, mid, bt, bh, len, M.concreteDark, { collide: false }); };
      for (const g of gaps.sort((a, b) => a.c - b.c)) { seg(cur, g.c - g.w / 2); cur = g.c + g.w / 2; } seg(cur, a1);
    }
  }
}

function container(...a) { const n = colliders.length, r = container0(...a); for (let i = n; i < colliders.length; i++) colliders[i].surf = 'metal'; return r; }
function container0(x, z, alongZ, level, color) {
  const L = 6.06, H = 2.59, W = 2.44;
  const w = alongZ ? W : L, d = alongZ ? L : W, y0 = level * H;
  addBox(x, y0, z, w, H, d, containerMats[color % containerMats.length], { s: 4.8 });
  // door end: locking bars + frame
  const endSign = (Math.floor(x + z) % 2) ? 1 : -1;
  for (let i = 0; i < 4; i++) {
    const off = (-0.9 + i * 0.6);
    const bx = alongZ ? x + off : x + endSign * (L / 2 + 0.03), bz = alongZ ? z + endSign * (L / 2 + 0.03) : z + off;
    place(cyl(0.025, H - 0.25, 6), M.steelLight, bx, y0 + H / 2, bz);
  }
  // top & bottom rails
  for (const yy of [y0 + 0.06, y0 + H - 0.06]) addBox(x, yy - 0.06, z, w + 0.04, 0.12, d + 0.04, M.steel, { collide: false });
}

function crate(x, y, z, s = 1.1, ry = 0) { addBox(x, y, z, s, s, s, M.wood, { s, ry }); }
function barrel(x, z, c = 0, y = 0) {
  place(cyl(0.29, 0.88, 18), barrelMats[c % barrelMats.length], x, y + 0.44, z);
  for (const yy of [0.3, 0.6]) place(new THREE.TorusGeometry(0.295, 0.012, 4, 18), M.steel, x, y + yy, z, { rx: Math.PI / 2, cast: false });
  addCollider(x - 0.3, y, z - 0.3, x + 0.3, y + 0.88, z + 0.3);
}
const sandbagGeo = new THREE.SphereGeometry(1, 10, 6);
function sandbags(x, z, len, alongZ, rows = 3) {
  for (let r = 0; r < rows; r++) {
    const n = Math.floor(len / 0.6);
    for (let i = 0; i < n; i++) {
      const o = -len / 2 + 0.3 + i * 0.6 + (r % 2) * 0.3; if (o > len / 2 - 0.2) continue;
      const m = place(sandbagGeo, M.burlap, alongZ ? x : x + o, 0.14 + r * 0.26, alongZ ? z + o : z, { ry: alongZ ? Math.PI / 2 : 0 });
      m.scale.set(0.31, 0.14, 0.2); m.rotation.y += SR(-0.12, 0.12);
    }
  }
  const h = rows * 0.26 + 0.05, w = alongZ ? 0.45 : len, d = alongZ ? len : 0.45;
  addCollider(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2);
}
function jersey(x, z, alongZ, len = 3) {
  const w = alongZ ? 0.6 : len, d = alongZ ? len : 0.6;
  addBox(x, 0, z, w, 0.35, d, M.concrete, { s: 2 });
  const w2 = alongZ ? 0.3 : len, d2 = alongZ ? len : 0.3;
  addBox(x, 0.35, z, w2, 0.6, d2, M.concrete, { s: 2, ch: 0.6 });
}
function floodlight(x, z, tx, tz, h = 9) {
  place(cyl(0.12, h, 10), M.steel, x, h / 2, z);
  addCollider(x - 0.15, 0, z - 0.15, x + 0.15, h, z + 0.15);
  const head = new V3(x, h, z), tgt = new V3(tx, 0, tz);
  const dir = tgt.clone().sub(head).normalize();
  const hm = place(boxGeo(0.9, 0.5, 0.35, 1), M.steel, x, h, z); hm.lookAt(tgt);
  const lens = place(new THREE.PlaneGeometry(0.75, 0.38), M.lamp, x + dir.x * 0.19, h + dir.y * 0.19, z + dir.z * 0.19, { cast: false }); lens.lookAt(tgt.clone().add(dir));
  const sp = new THREE.SpotLight(0xffe2b8, 170, 34, 0.62, 0.55, 2);
  sp.position.copy(head).addScaledVector(dir, 0.3); sp.target.position.copy(tgt);
  scene.add(sp, sp.target);
  // volumetric cone
  const len = Math.min(16, head.distanceTo(tgt));
  const cone = new THREE.Mesh(new THREE.ConeGeometry(len * Math.tan(0.5), len, 32, 1, true), coneMat);
  cone.position.copy(head).addScaledVector(dir, len / 2);
  cone.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir.clone().negate());
  scene.add(cone);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: new THREE.Color(3, 2.4, 1.8), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  halo.position.copy(head).addScaledVector(dir, 0.25); halo.scale.set(2.2, 2.2, 1); scene.add(halo);
}
const coneMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { col: { value: new THREE.Color(1.0, 0.8, 0.55) } },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 col; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float e = pow(abs(dot(vN,vV)),1.6); float a = pow(vUv.y,2.0)*0.035*e; gl_FragColor = vec4(col*a,1.); }`
});
function wallLamp(x, y, z, nx, nz) {
  addBox(x, y, z, Math.abs(nz) > 0 ? 0.5 : 0.2, 0.18, Math.abs(nx) > 0 ? 0.5 : 0.2, M.steel, { collide: false });
  place(boxGeo(Math.abs(nz) > 0 ? 0.4 : 0.05, 0.05, Math.abs(nx) > 0 ? 0.4 : 0.05), M.warm, x + nx * 0.06, y - 0.02, z + nz * 0.06, { cast: false });
}

let water = null;
function buildMap() {
  // Ground
  const gGeo = new THREE.PlaneGeometry(84, 62); gGeo.rotateX(-Math.PI / 2); gGeo.translate(0, 0, 7);
  T.asphalt.repeat.set(84 / 6, 62 / 6); T.wet.repeat.set(84 / 26, 62 / 26);
  const ground = new THREE.Mesh(gGeo, M.asphalt); ground.receiveShadow = true; scene.add(ground);
  const oGeo = new THREE.PlaneGeometry(400, 300); oGeo.rotateX(-Math.PI / 2);
  const outer = new THREE.Mesh(oGeo, M.dirt); outer.position.set(0, -0.03, 140); outer.receiveShadow = true; scene.add(outer);
  water = new Water(new THREE.PlaneGeometry(2400, 1200), {
    textureWidth: QUALITY[settings.quality].refl, textureHeight: QUALITY[settings.quality].refl, waterNormals: T.waterN, sunDirection: SUN_DIR.clone(),
    sunColor: 0xffc08a, waterColor: 0x0a4f86, distortionScale: 1.3, fog: true, alpha: 1
  });
  water.rotation.x = -Math.PI / 2; water.position.set(0, -1.9, -625);
  water.material.uniforms.size.value = 4.0;
  scene.add(water);

  // Painted lines
  const stripe = (x, z, w, d) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), M.stripe); m.position.set(x, 0.01, z); m.receiveShadow = true; scene.add(m); };
  for (let x = -26; x <= 26; x += 4) stripe(x, 0, 2, 0.14);
  stripe(0, -9, 40, 0.12); stripe(0, 9, 40, 0.12);
  for (let x = -10; x <= 4; x += 3.5) stripe(x, 15.6, 0.12, 4);

  // Seawall + railing (north)
  addBox(0, -2.6, -24.6, 84, 2.6, 1.2, M.concrete, { s: 3, collide: false });
  addBox(0, -0.02, -24.6, 84.4, 0.32, 1.25, M.concreteDark, { s: 3, collide: false });
  { const gaps = [-30, 12], runs = []; let cur = -41.8; for (const g of gaps) { runs.push([cur, g - 0.75]); cur = g + 0.75; } runs.push([cur, 42]);
    for (const [a, b] of runs) {
      for (let x = a + 0.05; x <= b; x += 2.07) place(cyl(0.04, 1.1, 8), M.rail, x, 0.85, -24.5);
      place(cyl(0.04, 1.1, 8), M.rail, b - 0.05, 0.85, -24.5);
      for (const y of [0.75, 1.32]) place(new THREE.CylinderGeometry(0.035, 0.035, b - a, 8).rotateZ(Math.PI / 2), M.rail, (a + b) / 2, y, -24.5);
      addCollider(a, 0.3, -25.2, b, 8, -24.2, true);
    }
    addCollider(-42, 0, -25.2, 42, 0.3, -24.2); }
  // bollards
  for (const x of [-36, -22, -8, 8, 22, 36]) { place(new THREE.CylinderGeometry(0.22, 0.28, 0.6, 14), M.steel, x, 0.3, -23.6); addCollider(x - 0.28, 0, -23.9, x + 0.28, 0.6, -23.3); }

  // Perimeter walls (S, W, E)
  const PW = (x, z, w, d) => { addBox(x, 0, z, w, 3.6, d, M.whitewash, { s: 3, ch: 8 }); addBox(x, 3.6, z, w + 0.2, 0.18, d + 0.2, M.aegean, { collide: false }); addBox(x, 0, z, w + 0.06, 0.35, d + 0.06, M.stone, { collide: false }); };
  PW(0, 38.3, 84.6, 0.6); PW(-42.3, 7, 0.6, 63.2); for (const [a, b] of [[-24.6, -20.5], [-15.5, 4.5], [9.5, 38.6]]) PW(42.3, (a + b) / 2, 0.6, b - a); // gates at z -18 and z 7
  for (let x = -39; x <= 39; x += 6) addBox(x, 0, 37.9, 0.5, 3.7, 0.3, M.whitewash, { collide: false });
  for (let z = -18; z <= 34; z += 6) { addBox(-41.9, 0, z, 0.3, 3.7, 0.5, M.whitewash, { collide: false }); if (z !== -18 && z !== 6) addBox(41.9, 0, z, 0.3, 3.7, 0.5, M.whitewash, { collide: false }); }
  // razor wire on walls
  for (const [x, z, len, rz] of [[0, 38.3, 84, 1], [-42.3, 7, 62, 0], [42.3, -22.55, 3.9, 0], [42.3, -5.5, 19.8, 0], [42.3, 24.05, 28.9, 0]]) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 4, 10), M.steelLight);
    const n = Math.floor(len / 0.35); const inst = new THREE.InstancedMesh(coil.geometry, M.steelLight, n); const mm = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) { const o = -len / 2 + i * 0.35; const p = rz ? new V3(x + o, 4.0, z) : new V3(x, 4.0, z + o); q.setFromEuler(new THREE.Euler(0, rz ? 0 : Math.PI / 2, SR(-.2, .2))); mm.compose(p, q, new V3(1, 1, 1)); inst.setMatrixAt(i, mm); }
    scene.add(inst);
  }

  // ---- Central warehouse (x -7..7, z -5..5)
  building({ cx: 0, cz: 0, w: 14, d: 10, h: 6, doors: [{ side: 'n', off: 0, w: 3.4, h: 3.8 }, { side: 's', off: 0, w: 3.4, h: 3.8 }, { side: 'w', off: -2, w: 1.6, h: 2.4 }, { side: 'e', off: 2, w: 1.6, h: 2.4 }] });
  for (const z of [-5.17, 5.17]) for (const x of [-4.5, 4.5]) place(boxGeo(3, 0.6, 0.04, 1), M.winGlow, x, 4.4, z, { cast: false });
  wallLamp(0, 4.2, -5.3, 0, -1); wallLamp(0, 4.2, 5.3, 0, 1);
  // interior
  for (const [x, z] of [[-4.5, -2.6], [4.5, 2.6]]) {
    place(cyl(0.01, 1.4, 4), M.steel, x, 5.2, z);
    place(new THREE.ConeGeometry(0.35, 0.3, 16, 1, true), M.steel, x, 4.45, z);
    place(new THREE.SphereGeometry(0.12, 12, 8), M.lamp, x, 4.35, z, { cast: false });
    const pl = new THREE.PointLight(0xffc890, 26, 15, 2); pl.position.set(x, 4.1, z); scene.add(pl);
  }
  crate(-5.2, 0, -3.4); crate(-5.2, 1.1, -3.4, 1.1, 0.2); crate(-4.0, 0, -3.6); crate(-5.4, 0, 3.4, 1.3);
  addBox(-1.6, 0, 1.2, 0.9, 1.05, 3.2, M.olive, { s: 1 });      // workbench
  addBox(2.2, 0, -1.4, 1.2, 1.2, 1.2, M.wood, { s: 1.2 });
  ammoCrateAt(0.9, 0, 3.6);
  // shelving on west wall
  for (let i = 0; i < 3; i++) { addBox(-6.35, 0.7 + i * 0.9, -0.1 + 1.2, 0.7, 0.06, 2.6, M.steel, { collide: i === 0 }); }
  addBox(-6.35, 0, 1.1, 0.7, 0.7, 2.6, M.steel, { collide: true, cast: true });

  // ---- North lane: containers + catwalk
  container(-19, -18.6, false, 0, 0); container(-19, -18.6, false, 1, 1);
  container(-4, -18, false, 0, 4);
  container(22, -14, true, 0, 5);
  // stairs to the catwalk container top (2.59)
  for (let i = 1; i <= 7; i++) {
    const top = 2.59 * i / 7, x1 = -7.03 - (7 - i) * 0.55, x0 = x1 - 0.55;
    addBox((x0 + x1) / 2, 0, -18, 0.55, top, 1.6, M.steel, { s: 1 });
  }
  place(cyl(0.03, 4.2, 6).rotateZ(Math.atan2(2.59, 3.85)), M.rail, -9.0, 2.2, -17.15);
  // container top kit
  sandbags(-2.2, -18, 2.2, true, 2); ammoCrateAt(-5.6, 2.59, -18.4);
  barrel(-14.6, -20.8, 0); barrel(-14, -21.4, 1); barrel(-13.3, -20.9, 2);
  jersey(4, -13, false, 3.2);

  // ---- Middle flanks
  container(-15, 10, false, 0, 2);
  sandbags(-14, 2, 3.6, false);
  crate(-21, 0, 5, 1.2);
  barrel(9.6, 6.4, 2); barrel(10.3, 6.9, 0);

  // ---- South lane: truck, barriers, fuel tanks, guard hut
  truck(-4, 15.4);
  jersey(4.5, 19.5, false, 3.2);
  sandbags(8.5, 13, 3.2, false);
  // fuel tanks
  for (const z of [16.6, 19.6]) {
    place(new THREE.CylinderGeometry(1.15, 1.15, 6, 28).rotateZ(Math.PI / 2), M.steelLight, 24, 1.55, z);
    for (const x of [21.8, 26.2]) addBox(x, 0, z, 0.4, 0.6, 1.8, M.steel, { collide: false });
    addCollider(21, 0, z - 1.15, 27, 2.7, z + 1.15);
  }
  building({ cx: -26, cz: 19, w: 4.4, d: 3.4, h: 2.9, doors: [{ side: 'e', off: 0, w: 1.2, h: 2.2 }], wall: M.whitewash, roof: M.roof, t: 0.25, base: false });
  place(boxGeo(1.2, 0.7, 0.04, 1), M.winGlow, -26, 1.6, 17.28, { cast: false });
  for (const sx of [-0.75, 0.75]) place(boxGeo(0.35, 0.8, 0.05, 1), M.aegean, -26 + sx, 1.6, 17.25, { cast: false });
  wallLamp(-23.7, 2.5, 19.9, 1, 0);
  crate(28.5, 0, 17.8, 1.2, 0.2);

  // ---- More ups and downs: warehouse roof stair, a raised loading terrace, and a lookout tower
  stairs(8.0, -4.7, 8.0, 0.9, 0, 6.25, 1.2, M.steel);
  for (const [x, z] of [[-7.15, 0], [7.15, -3]]) addBox(x, 6.25, z, 0.12, 0.5, x < 0 ? 10.4 : 4.4, M.steel, { collide: false });
  addBox(-10.2, 0, 0, 3.6, 1.3, 7.4, M.concrete, { s: 2 }); addBox(-10.2, 1.3, 0, 3.7, 0.08, 7.5, M.concreteDark, { collide: false });
  stairs(-10.2, -5.8, -10.2, -3.7, 0, 1.3, 2.4); stairs(-10.2, 5.8, -10.2, 3.7, 0, 1.3, 2.4);
  crate(-10.8, 1.3, -1.2, 1.0, 0.2);
  deck(29, 8.4, 32.2, 11.6, 4.2, true); stairs(24.6, 10, 29, 10, 0, 4.2, 1.2, M.steel);
  // ---- Floodlights
  floodlight(-40.5, -22.5, -26, -10); floodlight(40.5, -22.5, 26, -10); floodlight(-40.5, 36.5, -22, 26); floodlight(40.5, 36.5, 22, 26);
  expansion();

  dockYard();
  furnish();
  noCastScope = true; village(); noCastScope = false;
  // flags: warehouse roof, seawall, painted wall flag
  wavingFlag(0, 6.37, 0, 9, 2.6, 1.7); wavingFlag(-38, 0, -23.4, 8, 2.2, 1.45); wavingFlag(38, 0, -23.4, 8, 2.2, 1.45);
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3), new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.95, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2 })); m.position.set(-14, 2.3, 37.99); m.rotation.y = Math.PI; scene.add(m); }

  mergeStatic();
  buildPort();
}


// ======================================================= EXPANSION: west/east strips and the southern quarter
const hideSpots = []; // places bots like to patrol and hold (inside buildings, containers, behind cover)
const spot = (x, z) => hideSpots.push(new V3(x, 0, z));
const blueDoorMat = std({ color: 0x1f5fa8, roughness: 0.55 });
function shutters(x, y, z, nx, nz, w, h) { // open Aegean-blue shutters either side of a window
  for (const s of [-1, 1]) {
    const ox = nz ? s * (w / 2 + 0.22) : 0, oz = nx ? s * (w / 2 + 0.22) : 0;
    place(boxGeo(nz ? 0.42 : 0.05, h, nx ? 0.42 : 0.05, 1), M.aegean, x + ox + nx * 0.05, y, z + oz + nz * 0.05, { cast: false });
  }
  place(boxGeo(nz ? w + 0.2 : 0.12, 0.08, nx ? w + 0.2 : 0.12, 1), M.stone, x + nx * 0.06, y - h / 2 - 0.04, z + nz * 0.06, { cast: false });
}
function openContainer(x, z, alongZ, color, openEnd = 1) { // a container with its doors swung open: walk in and hide
  const L = 6.06, H = 2.59, W = 2.44, t = 0.08, mat = containerMats[color % containerMats.length];
  const w = alongZ ? W : L, d = alongZ ? L : W;
  addBox(x, 0, z, w, 0.12, d, M.steel, { s: 2 }); // floor
  addBox(x, H - 0.1, z, w, 0.1, d, mat, { s: 4.8 }); // roof
  if (alongZ) { addBox(x - W / 2 + t / 2, 0, z, t, H - 0.1, L, mat, { s: 4.8 }); addBox(x + W / 2 - t / 2, 0, z, t, H - 0.1, L, mat, { s: 4.8 }); addBox(x, 0, z - openEnd * (L / 2 - t / 2), W, H - 0.1, t, mat, { s: 4.8 }); }
  else { addBox(x, 0, z - W / 2 + t / 2, L, H - 0.1, t, mat, { s: 4.8 }); addBox(x, 0, z + W / 2 - t / 2, L, H - 0.1, t, mat, { s: 4.8 }); addBox(x - openEnd * (L / 2 - t / 2), 0, z, t, H - 0.1, W, mat, { s: 4.8 }); }
  // swung doors
  for (const s of [-1, 1]) {
    if (alongZ) { const hx = x + s * W / 2, hz = z + openEnd * L / 2; addBox(hx + s * 0.05, 0.02, hz + openEnd * W / 4, 0.05, H - 0.1, W / 2, mat, { s: 4.8, collide: true }); }
    else { const hz = z + s * W / 2, hx = x + openEnd * L / 2; addBox(hx + openEnd * W / 4, 0.02, hz + s * 0.05, W / 2, H - 0.1, 0.05, mat, { s: 4.8, collide: true }); }
  }
  for (const yy of [0.06, H - 0.06]) addBox(x, yy - 0.06, z, w + 0.04, 0.12, d + 0.04, M.steel, { collide: false });
  spot(x, z);
}
function deck(...a) { const n = colliders.length, r = deck0(...a); for (let i = n; i < colliders.length; i++) colliders[i].surf = 'metal'; return r; }
function deck0(x0, z0, x1, z1, h, tower = false, rails = ['z0', 'z1', 'x1']) { // raised steel deck on posts with a rail, walkable on top
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
  addBox(cx, h - 0.2, cz, w, 0.2, d, M.steel, { s: 1.5 });
  for (const x of [x0 + 0.15, x1 - 0.15]) for (const z of [z0 + 0.15, z1 - 0.15]) addBox(x, 0, z, 0.22, h - 0.2, 0.22, M.steelLight, { s: 1 });
  if (w > 4) for (const z of [z0 + 0.15, z1 - 0.15]) addBox(cx, 0, z, 0.22, h - 0.2, 0.22, M.steelLight, { s: 1 });
  addBox(cx, h * 0.45, z0 + 0.15, w, 0.08, 0.08, M.steelLight, { collide: false }); addBox(cx, h * 0.45, z1 - 0.15, w, 0.08, 0.08, M.steelLight, { collide: false });
  const R4 = { z0: [cx, z0 + 0.04, w, 0.06], z1: [cx, z1 - 0.04, w, 0.06], x0: [x0 + 0.04, cz, 0.06, d], x1: [x1 - 0.04, cz, 0.06, d] };
  for (const k of rails) { const [px, pz, pw, pd] = R4[k]; addBox(px, h + 1.0, pz, pw, 0.06, pd, M.rail, { collide: false }); addCollider(px - pw / 2, h, pz - pd / 2 - 0.03, px + pw / 2, h + 1.05, pz + pd / 2 + 0.03, true); }
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) addBox(x + (x === x0 ? 0.04 : -0.04), h, z + (z === z0 ? 0.04 : -0.04), 0.06, 1.0, 0.06, M.rail, { collide: false });
  if (tower) { // waist-high sandbag wall on the far side and a tin roof
    addBox(x1 - 0.3, h, cz, 0.5, 0.9, d - 0.4, M.burlap, { s: 1 });
    for (const [x, z] of [[x0 + 0.15, z0 + 0.15], [x1 - 0.15, z0 + 0.15], [x0 + 0.15, z1 - 0.15], [x1 - 0.15, z1 - 0.15]]) addBox(x, h, z, 0.1, 2.3, 0.1, M.steel, { collide: false });
    addBox(cx, h + 2.3, cz, w + 0.5, 0.1, d + 0.5, M.roof, { s: 2 });
  }
}
function stoneWall(x, z, len, alongZ, h = 1.05) { addBox(x, 0, z, alongZ ? 0.6 : len, h, alongZ ? len : 0.6, M.stone, { s: 2 }); }
function table(x, z) { addBox(x, 0.7, z, 0.9, 0.05, 0.9, M.wood, { s: 1, collide: false }); addBox(x, 0, z, 0.12, 0.7, 0.12, M.steel, { collide: false }); addCollider(x - 0.45, 0, z - 0.45, x + 0.45, 0.75, z + 0.45); }
function stairs(x0, z0, x1, z1, y0, y1, width, mat = M.concrete) { // straight run of box steps, low end at (x0,z0)
  const n = Math.ceil((y1 - y0) / 0.4), alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  for (let i = 1; i <= n; i++) {
    const a = (i - 1) / n, b = i / n, top = y0 + (y1 - y0) * i / n;
    const cx = lerp(x0, x1, (a + b) / 2), cz = lerp(z0, z1, (a + b) / 2), run = (alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0)) / n;
    addBox(cx, 0, cz, alongX ? run : width, top, alongX ? width : run, mat, { s: 1 });
  }
}
function iconTex() {
  return ctex(256, (g, S) => {
    g.fillStyle = '#3a2414'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 3; i++) {
      const x = 12 + i * 82, w = 70; g.fillStyle = '#b8892e'; g.fillRect(x, 30, w, 200);
      g.fillStyle = '#d9b25a'; g.beginPath(); g.arc(x + w / 2, 70, 28, 0, 7); g.fill();
      g.fillStyle = ['#5b1f1a', '#1d3b6b', '#3b4a24'][i]; g.fillRect(x + 12, 100, w - 24, 120);
      g.strokeStyle = '#f1d68a'; g.lineWidth = 3; g.strokeRect(x + 3, 33, w - 6, 194);
    }
    grain(g, S, 18);
  });
}
function expansion() {
  // ---- Taverna (south-west): two rooms, blue shutters, outside stairs to a roof terrace
  { const cx = -30, cz = 31, w = 10, d = 7.6, h = 3.4;
    building({ cx, cz, w, d, h, wall: M.whitewash, roof: M.whitewash, t: 0.3, base: false, doors: [
      { side: 'n', off: -2.5, w: 1.3, h: 2.3 }, { side: 's', off: 2.6, w: 1.2, h: 2.2 }, { side: 'n', off: 2.2, w: 1.4, h: 2.2, y0: 1.0 },
      { side: 'w', off: 0, w: 1.2, h: 2.2, y0: 1.0 }, { side: 's', off: -2.4, w: 1.2, h: 2.2, y0: 1.1 }] });
    wallRun('z', -31.2, cz - d / 2 + 0.3, cz + d / 2 - 0.3, h, 0.2, [{ c: cz + 1.6, w: 1.1, h: 2.2 }], M.whitewash);
    place(boxGeo(1.3, 2.3, 0.06, 1), blueDoorMat, cx - 2.5 - 0.7, 1.15, cz - d / 2 - 0.1, { ry: 1.2, cast: false });
    shutters(cx + 2.2, 1.6, cz - d / 2 - 0.02, 0, -1, 1.4, 1.2); shutters(cx - w / 2 - 0.02, 1.6, cz, -1, 0, 1.2, 1.2);
    for (const [px, pz, pw, pd] of [[cx, cz - d / 2 - 0.15, w + 0.6, 0.3], [cx - w / 2 - 0.15, cz, 0.3, d + 0.6], [cx, cz + d / 2 + 0.15, w + 0.6, 0.3]]) addBox(px, h + 0.25, pz, pw, 0.55, pd, M.whitewash, { s: 3 });
    addBox(cx + w / 2 + 0.15, h + 0.25, cz + 1.4, 0.3, 0.55, d - 2.2, M.whitewash, { s: 3 }); // east parapet (gap where the stairs arrive)
    stairs(cx + w / 2 + 0.75, cz + 3.4, cx + w / 2 + 0.75, cz - 2.6, 0, h + 0.25, 1.2, M.whitewash);
    addBox(-31, h + 0.25, cz, 2.4, 0.06, 1.6, M.canvas, { collide: false }); // awning shade on the roof
    // inside: counter, tables, wine barrels
    addBox(-27.4, 0, cz + 2.2, 2.4, 1.05, 0.6, M.wood, { s: 1 }); table(-33.5, cz - 1.5); table(-28.5, cz - 1.2); crate(-34, 0, cz + 2.4, 1.0);
    for (const z of [cz + 1.0, cz + 2.1]) { place(new THREE.CylinderGeometry(0.35, 0.35, 0.8, 16).rotateZ(Math.PI / 2), M.wood, -34.2, 0.36, z); addCollider(-34.6, 0, z - 0.36, -33.8, 0.72, z + 0.36); }
    ammoCrateAt(-26, 0, cz - 2.6);
    spot(-33.5, cz); spot(-27.5, cz); spot(-29, cz + 2.6);
    oliveTree(-22, 0, 33); addCollider(-22.25, 0, 32.75, -21.75, 2.2, 33.25);
  }
  // ---- Chapel (south centre): blue dome, benches, iconostasis
  { const cx = 0, cz = 31.5, w = 6, d = 8, h = 4.2;
    building({ cx, cz, w, d, h, wall: M.whitewash, roof: M.whitewash, t: 0.35, base: false, doors: [
      { side: 'n', off: 0, w: 1.5, h: 2.6 }, { side: 's', off: 1.2, w: 1.1, h: 2.3 },
      { side: 'e', off: -1.5, w: 0.7, h: 3.0, y0: 1.6 }, { side: 'w', off: -1.5, w: 0.7, h: 3.0, y0: 1.6 }, { side: 'e', off: 1.6, w: 0.7, h: 3.0, y0: 1.6 }, { side: 'w', off: 1.6, w: 0.7, h: 3.0, y0: 1.6 }] });
    place(cyl(1.7, 0.9, 28), M.whitewash, cx, h + 0.7, cz + 0.4);
    place(new THREE.SphereGeometry(1.8, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.aegean, cx, h + 1.15, cz + 0.4);
    place(boxGeo(0.1, 0.9, 0.1, 1), M.steelLight, cx, h + 3.3, cz + 0.4); place(boxGeo(0.55, 0.1, 0.1, 1), M.steelLight, cx, h + 3.45, cz + 0.4);
    addBox(cx, h + 0.25, cz - d / 2 + 0.4, 2.2, 1.6, 0.4, M.whitewash, { s: 3 }); // bell gable
    place(new THREE.CylinderGeometry(0.22, 0.3, 0.4, 14, 1, true), M.paint, cx, h + 1.3, cz - d / 2 + 0.4, { cast: false });
    for (let i = 0; i < 3; i++) for (const s of [-1, 1]) addBox(cx + s * 1.3, 0, cz - 1.8 + i * 1.3, 1.5, 0.5, 0.45, M.wood, { s: 1 });
    { const m = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.6), std({ map: iconTex(), roughness: 0.5, metalness: 0.3, emissive: 0x2a1a08, emissiveIntensity: 0.6 })); m.position.set(cx, 1.6, cz + d / 2 - 0.36); m.rotation.y = Math.PI; scene.add(m); }
    addBox(cx, 0, cz + 2.6, 2.2, 0.9, 0.5, M.stone, { s: 1 });
    spot(cx - 1.8, cz + 2.6); spot(cx + 1.8, cz - 2.8);
  }
  // ---- Barracks (south-east): two storeys, inside stairs, windows over the courtyard
  { const cx = 28, cz = 31, w = 12, d = 7.6, h = 6.4, t = 0.3;
    building({ cx, cz, w, d, h, wall: M.whitewash, roof: M.concreteDark, t, base: false, doors: [
      { side: 'n', off: -3.2, w: 1.3, h: 2.4 }, { side: 'w', off: -0.5, w: 1.2, h: 2.3 }, { side: 'e', off: 1.5, w: 1.2, h: 2.3 },
      { side: 'n', off: 2.4, w: 1.2, h: 2.1, y0: 1.0 }, { side: 's', off: -3.6, w: 1.2, h: 2.1, y0: 1.1 }, { side: 's', off: 3.0, w: 1.2, h: 2.1, y0: 1.1 },
      { side: 'n', off: -3.2, w: 1.2, h: 5.5, y0: 4.2 }, { side: 'n', off: 0.6, w: 1.2, h: 5.5, y0: 4.2 }, { side: 'n', off: 4.2, w: 1.2, h: 5.5, y0: 4.2 },
      { side: 'e', off: -1.5, w: 1.2, h: 5.5, y0: 4.2 }, { side: 'w', off: 1.5, w: 1.2, h: 5.5, y0: 4.2 }, { side: 's', off: 1.0, w: 1.2, h: 5.5, y0: 4.2 }] });
    addBox(cx, 0, cz, w + 0.04, 0.9, d + 0.04, M.stone, { collide: false }); // stone footing outside
    const ix0 = cx - w / 2 + t, ix1 = cx + w / 2 - t, iz0 = cz - d / 2 + t, iz1 = cz + d / 2 - t, holeZ = iz1 - 1.3, holeX = cx + 0.6;
    addBox((ix0 + ix1) / 2, 3.0, (iz0 + holeZ) / 2, ix1 - ix0, 0.2, holeZ - iz0, M.concrete, { s: 2 });
    addBox((holeX + ix1) / 2, 3.0, (holeZ + iz1) / 2, ix1 - holeX, 0.2, iz1 - holeZ, M.concrete, { s: 2 });
    stairs(ix0 + 0.5, iz1 - 0.65, holeX - 0.6, iz1 - 0.65, 0, 3.2, 1.2);
    addBox(holeX - 0.3, 0, iz1 - 0.65, 0.6, 3.2, 1.2, M.concrete, { s: 1 });
    addBox((ix0 + holeX) / 2, 3.2, holeZ + 0.03, holeX - ix0, 0.05, 0.05, M.rail, { collide: false }); addBox((ix0 + holeX) / 2, 4.15, holeZ + 0.03, holeX - ix0, 0.05, 0.05, M.rail, { collide: false });
    addCollider(ix0, 3.2, holeZ - 0.02, holeX - 0.6, 4.2, holeZ + 0.06, true);
    for (const [x, y] of [[ix0 + 1, 0], [ix0 + 2.6, 0], [ix1 - 1.2, 0]]) { addBox(x, y, iz0 + 1.1, 0.9, 0.45, 2.0, M.olive, { s: 1 }); addBox(x, y + 1.25, iz0 + 1.1, 0.9, 0.08, 2.0, M.olive, { s: 1, collide: false }); }
    for (let i = 0; i < 4; i++) addBox(ix1 - 0.3, 0, cz - 1.5 + i * 0.6, 0.5, 1.9, 0.55, M.steel, { s: 1 });
    table(cx + 2.8, cz + 0.3); crate(ix0 + 1.0, 3.2, iz0 + 1.0); crate(ix0 + 2.2, 3.2, iz0 + 0.9, 1.0, 0.4); table(cx - 1.5, cz - 0.8 + 0.0); 
    ammoCrateAt(ix1 - 1.0, 3.2, iz0 + 0.8); ammoCrateAt(cx - 3.2, 0, cz + 0.4);
    sandbags(cx - 3.2, iz0 + 0.5 + 0.0, 1.8, false, 2);
    for (const off of [-3.2, 0.6, 4.2]) shutters(cx + off, 4.8, cz - d / 2 - 0.02, 0, -1, 1.2, 1.3);
    spot(cx - 3.5, cz); spot(cx + 3.5, cz - 1);
  }
  // ---- Boathouse (east strip): big sea door, office, boat on a trailer
  { const cx = 37.5, cz = -4, w = 8, d = 17, h = 4.6;
    building({ cx, cz, w, d, h, doors: [
      { side: 'n', off: 0, w: 4.4, h: 3.6 }, { side: 'w', off: -5.2, w: 1.4, h: 2.4 }, { side: 'w', off: 6.0, w: 1.2, h: 2.3 }, { side: 's', off: 1.6, w: 1.3, h: 2.3 },
      { side: 'e', off: -4, w: 1.6, h: 2.6, y0: 1.4 }, { side: 'e', off: 3.5, w: 1.6, h: 2.6, y0: 1.4 }, { side: 'w', off: -1.5, w: 1.6, h: 2.6, y0: 1.4 }] });
    for (const z of [-4.5, 4.5]) place(boxGeo(0.04, 0.6, 3, 1), M.winGlow, cx + w / 2 + 0.16, 3.9, cz + z, { cast: false });
    const oz = cz + 4.2; // office in the south-west corner
    table(cx - 2.4, oz + 2.4); crate(cx - 3.2, 0, oz + 0.7, 0.9);
    // RHIB on a trailer
    { const bx = cx + 0.6, bz = cz - 2.5;
      addBox(bx, 0.35, bz, 2.2, 0.55, 6.2, NAVY.orange, { s: 2 }); addBox(bx, 0.9, bz, 1.8, 0.1, 5.6, M.rubber, { collide: false });
      addBox(bx, 0.95, bz + 0.6, 0.9, 0.9, 0.9, M.steel, { collide: false }); place(boxGeo(0.8, 0.4, 0.04, 1), M.glass, bx, 2.0, bz + 1.06, { rx: -0.3, cast: false });
      addBox(bx, 0, bz, 1.4, 0.35, 6.6, M.steel, { collide: false }); place(cyl(0.45, 0.4, 14).rotateZ(Math.PI / 2), M.rubber, bx, 0.45, bz - 0.8, { cast: true });
    }
    addBox(cx + w / 2 - 0.8, 0, cz + 1.5, 0.8, 0.95, 2.6, M.olive, { s: 1 });
    for (let i = 0; i < 3; i++) addBox(cx + w / 2 - 0.7, 0.7 + i * 0.9, cz - 6.8, 0.7, 0.06, 2.6, M.steel, { collide: i === 0 });
    addBox(cx + w / 2 - 0.7, 0, cz - 6.8, 0.7, 0.7, 2.6, M.steel, { s: 1 });
    barrel(35, -11.5, 1); barrel(35.7, -11.8, 0); crate(34.6, 0, -6, 1.1);
    ammoCrateAt(cx + 3.0, 0, cz + 6.6);
    spot(cx - 1.5, cz - 6); spot(cx - 2.2, oz + 2.2); spot(cx + 2.5, cz + 3);
  }
  // ---- Old stone storehouse (west strip): half its roof has fallen in
  { const cx = -37.5, cz = 8, w = 7, d = 10, h = 3.4;
    building({ cx, cz, w, d, h, wall: M.stone, t: 0.45, base: false, noRoof: true, doors: [
      { side: 'e', off: -2.2, w: 1.6, h: 2.4 }, { side: 'n', off: 0.6, w: 1.4, h: 2.2 }, { side: 'w', off: 2.4, w: 1.0, h: 2.0, y0: 1.1 }, { side: 'e', off: 2.6, w: 1.0, h: 2.0, y0: 1.1 }] });
    addBox(cx, h, cz + 2.5, w + 0.3, 0.22, d / 2 + 0.2, M.wood, { s: 2 });
    for (let i = 0; i < 4; i++) addBox(cx, h - 0.05, cz - 4 + i * 1.3, w, 0.18, 0.18, M.wood, { collide: false, s: 1, ry: i === 2 ? 0.12 : 0 });
    addBox(cx - 1.5, 0, cz - 3.2, 1.6, 0.3, 1.2, M.stone, { s: 1, ry: 0.3 }); addBox(cx + 1.0, 0, cz - 2.2, 1.0, 0.25, 0.8, M.stone, { s: 1 });
    for (const [x, z] of [[cx - 2.4, cz + 3.6], [cx - 2.4, cz + 2.2], [cx - 2.4, cz + 2.9]]) addBox(x, 0, z, 1.2, 0.8, 0.6, M.burlap, { s: 1 });
    addBox(cx - 2.4, 0.8, cz + 2.9, 1.2, 0.8, 0.6, M.burlap, { s: 1 });
    barrel(cx + 2.4, cz + 3.8, 2); crate(cx + 2.2, 0, cz - 3.8, 1.1, 0.4); ammoCrateAt(cx + 1.0, 0, cz + 4.0);
    spot(cx, cz + 2.5); spot(cx + 1.5, cz - 1);
  }
  // ---- Containers you can walk into, and more cover in the new ground
  openContainer(-37.5, -14, true, 3, -1);
  container(-37.5, -14, true, 1, 6); // stacked box on top of the west open container
  sandbags(-35, -6.5, 3.4, false); jersey(-37, 20, false, 3.2);
  crate(-40, 0, -21.8, 1.2); barrel(40, -21.5, 1); barrel(39.4, -22.1, 3); barrel(-40.2, 26, 0);
  stoneWall(-20, 31, 6, true); stoneWall(8, 27.2, 5, false); stoneWall(-9, 25.4, 3.5, false, 0.9);
  oliveTree(-7.5, 0, 29.5); addCollider(-7.75, 0, 29.25, -7.25, 2.2, 29.75); oliveTree(9, 0, 32); addCollider(8.75, 0, 31.75, 9.25, 2.2, 32.25);
  // well
  place(cyl(0.9, 0.85, 20), M.stone, -16, 0.42, 34); addCollider(-16.8, 0, 33.2, -15.2, 0.85, 34.8);
  for (const s of [-1, 1]) addBox(-16 + s * 0.75, 0.85, 34, 0.12, 1.3, 0.12, M.wood, { collide: false }); addBox(-16, 2.1, 34, 1.7, 0.12, 0.12, M.wood, { collide: false });
  // existing compound cover worth holding
  for (const [x, z] of [[0, 0], [-4.5, 2], [4.5, -2], [-26, 19], [-19, -15.5], [22, -10], [-15, 7.5], [17, 3.5], [24, 18], [-4, 13]]) spot(x, z);
}

const flags = [];
function wavingFlag(x, y, z, poleH, w, h) {
  place(cyl(0.06, poleH, 8), M.steelLight, x, y + poleH / 2, z);
  place(new THREE.SphereGeometry(0.1, 8, 6), M.steelLight, x, y + poleH + 0.05, z);
  if (y === 0) addCollider(x - 0.1, 0, z - 0.1, x + 0.1, poleH, z + 0.1);
  const geo = new THREE.PlaneGeometry(w, h, 16, 8); geo.translate(w / 2, -h / 2, 0);
  const m = new THREE.Mesh(geo, M.flag); m.position.set(x + 0.06, y + poleH - 0.05, z); m.castShadow = true; scene.add(m);
  flags.push({ m, base: geo.attributes.position.array.slice(), w, ph: Math.random() * 6 });
}
function updateFlags(t) {
  for (const f of flags) {
    const pos = f.m.geometry.attributes.position, b = f.base;
    for (let i = 0; i < pos.count; i++) {
      const x = b[i * 3], y = b[i * 3 + 1], k = x / f.w;
      pos.array[i * 3 + 2] = Math.sin(x * 1.6 - t * 5.5 + f.ph + y * 0.3) * 0.22 * k + Math.sin(x * 3.1 - t * 8.3) * 0.05 * k;
      pos.array[i * 3 + 1] = y - k * k * 0.12;
    }
    pos.needsUpdate = true; f.m.geometry.computeVertexNormals();
    f.m.rotation.y = -0.6 + Math.sin(t * 0.3 + f.ph) * 0.15; // wind from the sea
  }
}
let VILM = null;
function vmats() { // village palette, made once
  return VILM || (VILM = {
    wash: M.whitewash,
    ochre: std({ map: T.whitewash, color: 0xf0d2a4, roughness: 0.9 }),
    pink: std({ map: T.whitewash, color: 0xf2cfc0, roughness: 0.9 }),
    trim: std({ map: T.whitewash, color: 0xfbfbf8, roughness: 0.8 }),
    plinth: std({ map: T.whitewash, color: 0x9aa3a8, roughness: 0.9 }),
    blue: blueDoorMat,
    green: std({ color: 0x2f6b4a, roughness: 0.6 }),
    red: std({ color: 0x8c2a22, roughness: 0.6 }),
    recess: std({ color: 0x120e0b, roughness: 1 }),
    bougain: std({ color: 0xc2287c, roughness: 0.9 }),
    leaf: std({ color: 0x4d6a34, roughness: 0.95 }),
    solar: std({ color: 0x1a2738, roughness: 0.15, metalness: 0.7 }),
    tank: std({ color: 0xc9ccd0, roughness: 0.35, metalness: 0.8 }),
    pot: std({ color: 0xa8542f, roughness: 0.85 }),
    earth: antiTile(std({ map: T.asphalt, color: 0x9b8462, roughness: 1 }), [0.8, 0.9, 0.55], 1),
    brass: std({ color: 0xb8913c, roughness: 0.35, metalness: 0.9 })
  });
}
// window with a white surround, dark recess, sill and open or closed shutters. Front faces -z (nz = -1) or a side (nx).
function vWindow(x, y, z, nx, nz, w, h, shut, lit) {
  const V = vmats(), side = nx !== 0, o = (dx, dz) => [x + dx * (side ? 0 : 1) + nx * dz, z + nz * dz + (side ? dx : 0)];
  const bw = (a, b) => side ? [0.0001 + b, a] : [a, 0.0001 + b];
  const box = (mat, wid, hh, dep, dx, dy, out) => { const [px, pz] = o(dx, out); const [ww, dd] = bw(wid, dep); place(boxGeo(ww, hh, dd, 1), mat, px, y + dy, pz, { cast: false }); };
  box(V.trim, w + 0.24, h + 0.24, 0.06, 0, 0, 0.03);                 // surround
  box(lit ? M.winGlow : V.recess, w, h, 0.07, 0, 0, 0.045);           // glass / dark room behind
  box(V.trim, w + 0.36, 0.08, 0.2, 0, -h / 2 - 0.12, 0.1);            // sill
  box(V.trim, 0.05, h, 0.09, 0, 0, 0.05);                             // mullion
  if (shut === 'open') for (const s of [-1, 1]) box(shutMat, w / 2, h, 0.05, s * (w / 2 + 0.14 + w / 4), 0, 0.07);
  else if (shut === 'closed') { box(shutMat, w, h, 0.06, 0, 0, 0.09); for (let i = 1; i < 6; i++) box(V.recess, w * 0.9, 0.018, 0.065, 0, -h / 2 + i * h / 6, 0.1); }
}
let shutMat = null;
function greekHouse(x, y, z, w, d, h) { // a Cycladic house facing the harbour (-z), with roof clutter and plants
  const V = vmats();
  const wall = sr() < 0.8 ? V.wash : sr() < 0.5 ? V.ochre : V.pink;
  const door = [V.blue, V.blue, V.blue, V.green, V.red][Math.floor(sr() * 5)];
  shutMat = sr() < 0.75 ? V.blue : door;
  const floors = h > 4.6 ? 2 : 1, fz = z - d / 2;
  place(plasterGeo(w, h + 0.3, d, 0.25), wall, x, y + (h + 0.3) / 2 - 0.15, z);
  place(plasterGeo(w + 0.06, 0.42, d + 0.06, 0.12, 2), V.plinth, x, y + 0.2, z, { cast: false });
  place(plasterGeo(w + 0.12, 0.5, d + 0.12, 0.2), wall, x, y + h + 0.2, z);        // parapet
  place(plasterGeo(w + 0.18, 0.12, d + 0.18, 0.05, 2), V.trim, x, y + h + 0.47, z, { cast: false }); // rounded-off cap
  // door: surround, recessed leaf, step, handle, little fanlight
  const dx = x + SR(-w * 0.28, w * 0.05);
  place(boxGeo(1.3, 2.45, 0.08, 1), V.trim, dx, y + 1.22, fz - 0.04, { cast: false });
  place(boxGeo(0.98, 2.12, 0.05, 1), door, dx, y + 1.06, fz - 0.05, { cast: false });
  for (const yy of [0.55, 1.55]) place(boxGeo(0.8, 0.04, 0.02, 1), V.recess, dx, y + yy, fz - 0.085, { cast: false });
  place(new THREE.SphereGeometry(0.04, 6, 4), V.brass, dx + 0.36, y + 1.05, fz - 0.1, { cast: false });
  place(boxGeo(0.9, 0.22, 0.04, 1), sr() < 0.5 ? M.winGlow : V.recess, dx, y + 2.28, fz - 0.06, { cast: false });
  addBox(dx, y, fz - 0.32, 1.5, 0.16, 0.6, V.trim, { collide: false, s: 1 });
  // windows: ground floor beside the door, a row upstairs
  for (let f = 0; f < floors; f++) {
    const wy = y + (f === 0 ? 1.5 : 1.5 + 2.9), n = Math.max(1, Math.floor((w - 0.6) / 2.1));
    for (let i = 0; i < n; i++) {
      const wx = x - w / 2 + (i + 0.5) * w / n;
      if (f === 0 && Math.abs(wx - dx) < 1.5) continue;
      vWindow(wx, wy, fz, 0, -1, SR(0.75, 0.95), SR(0.95, 1.15), sr() < 0.55 ? 'open' : sr() < 0.6 ? 'closed' : 'none', sr() < 0.25);
    }
  }
  for (const s of [-1, 1]) if (sr() < 0.6) vWindow(x + s * w / 2, y + 1.5 + (floors - 1) * 2.9 * (sr() < 0.5 ? 1 : 0), z + SR(-d * 0.2, d * 0.2), s, 0, 0.7, 0.9, sr() < 0.6 ? 'open' : 'none', sr() < 0.2);
  // balcony upstairs
  if (floors === 2 && sr() < 0.5) {
    const bx = x + SR(-w * 0.2, w * 0.2), bw = Math.min(2.6, w * 0.5);
    addBox(bx, y + 2.85, fz - 0.55, bw, 0.14, 1.1, V.trim, { collide: false, s: 1 });
    addBox(bx, y + 3.85, fz - 1.07, bw, 0.05, 0.05, shutMat, { collide: false });
    for (let k = 0; k <= 6; k++) addBox(bx - bw / 2 + k * bw / 6, y + 2.99, fz - 1.07, 0.03, 0.86, 0.03, shutMat, { collide: false });
  }
  // upper cube set back, leaving a roof terrace with a blue rail
  const top = y + h + 0.4;
  if (floors === 1 && sr() < 0.5) {
    const uw = w * SR(0.45, 0.6), ud = d * SR(0.45, 0.6), ux = x + (sr() < 0.5 ? -1 : 1) * (w - uw) / 2, uz = z + (d - ud) / 2, uh = SR(2.4, 2.8);
    place(plasterGeo(uw, uh + 0.2, ud, 0.22), wall, ux, y + h + uh / 2 + 0.1, uz);
    place(plasterGeo(uw + 0.1, 0.4, ud + 0.1, 0.16), wall, ux, y + h + uh + 0.17, uz);
    place(plasterGeo(uw + 0.16, 0.1, ud + 0.16, 0.04, 2), V.trim, ux, y + h + uh + 0.4, uz, { cast: false });
    place(boxGeo(0.85, 1.9, 0.06, 1), door, ux + SR(-uw * 0.2, uw * 0.2), y + h + 0.95, uz - ud / 2 - 0.03, { cast: false });
    for (let k = 0; k <= 10; k++) addBox(x - w / 2 + 0.15 + k * (w - 0.3) / 10, top, fz + 0.15, 0.04, 0.8, 0.04, V.blue, { collide: false });
    addBox(x, top + 0.8, fz + 0.15, w - 0.3, 0.06, 0.06, V.blue, { collide: false });
    if (sr() < 0.5) { for (const [px, pz] of [[x + w * 0.3, fz + 0.5], [x + w * 0.3, fz + 1.8]]) addBox(px, top, pz, 0.08, 2.0, 0.08, M.wood, { collide: false }); addBox(x + w * 0.3, top + 2.0, fz + 1.1, 1.8, 0.08, 1.8, M.wood, { collide: false }); for (let k = 0; k < 3; k++) place(new THREE.IcosahedronGeometry(SR(0.35, 0.6), 0), V.leaf, x + w * 0.3 + SR(-0.8, 0.8), top + 2.1, fz + 1.1 + SR(-0.8, 0.8), { cast: false }); }
  }
  // roof clutter: solar water heater, chimney, TV aerial, sometimes a small blue dome
  const rx = x + SR(-w * 0.25, w * 0.25), rz = z + SR(0, d * 0.25);
  if (sr() < 0.5) {
    place(boxGeo(1.0, 0.05, 1.7, 1), V.solar, rx, top + 0.75, rz + 0.3, { rx: 0.65, cast: false });
    place(new THREE.CylinderGeometry(0.28, 0.28, 1.4, 12).rotateZ(Math.PI / 2), V.tank, rx, top + 1.35, rz + 0.85, { cast: false });
    for (const s of [-1, 1]) addBox(rx + s * 0.45, top, rz + 0.6, 0.04, 1.2, 0.04, M.steel, { collide: false });
  }
  if (sr() < 0.45) { const cx = x + (sr() < 0.5 ? -1 : 1) * (w / 2 - 0.5), cz = z + d * 0.3; addBox(cx, top, cz, 0.55, 1.1, 0.55, wall, { collide: false, s: 2 }); addBox(cx, top + 1.1, cz, 0.75, 0.1, 0.75, V.trim, { collide: false }); addBox(cx, top + 1.2, cz, 0.3, 0.25, 0.3, wall, { collide: false }); }
  if (sr() < 0.3) { const ax = x + SR(-w * 0.3, w * 0.3); place(cyl(0.025, 2.4, 5), M.steelLight, ax, top + 1.2, z + d * 0.2, { cast: false }); for (let k = 0; k < 3; k++) place(boxGeo(0.9 - k * 0.2, 0.025, 0.025, 1), M.steelLight, ax, top + 1.7 + k * 0.25, z + d * 0.2, { cast: false }); }
  if (sr() < 0.06) { place(cyl(1.0, 0.6, 20), wall, x, top + 0.3, z, { cast: false }); place(new THREE.SphereGeometry(1.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), V.blue, x, top + 0.58, z, { cast: false }); }
  // bougainvillea over the door, pots by the step
  if (sr() < 0.45) { const bx = dx + (sr() < 0.5 ? -1 : 1) * 0.9; for (let k = 0; k < 14; k++) place(new THREE.IcosahedronGeometry(SR(0.14, 0.28), 1), k % 3 ? V.bougain : V.leaf, bx + SR(-0.6, 0.6) * (1 - k / 20), y + SR(1.5, 3.1), fz - SR(0.05, 0.3), { cast: false }); place(cyl(0.05, 2.0, 5), M.bark, bx, y + 1.0, fz - 0.1, { cast: false }); }
  if (sr() < 0.5) for (const s of [-1, 1]) { place(new THREE.CylinderGeometry(0.2, 0.14, 0.36, 10), V.pot, dx + s * 0.95, y + 0.18, fz - 0.35, { cast: false }); place(new THREE.IcosahedronGeometry(0.26, 0), V.leaf, dx + s * 0.95, y + 0.5, fz - 0.35, { cast: false }); }
  // outside stair up the side wall to the roof
  if (sr() < 0.25) { const sx = x + w / 2 + 0.5, n = Math.round(h / 0.3); for (let k = 0; k < n; k++) addBox(sx, y, fz + 0.3 + k * (d - 0.6) / n, 1.0, (k + 1) * h / n, (d - 0.6) / n + 0.01, wall, { collide: false, s: 2 }); }
}
// Trees: a bark trunk and branches, with the crown built from crossed leaf cards (canvas-painted leaves with
// alpha cut-outs). Card normals point out from the crown centre so the canopy shades like a soft round mass.
// A few variants of each are generated once and reused.
let TREE = null;
function leafTex(kind) {
  return ctex(256, (g, S) => {
    g.clearRect(0, 0, S, S);
    const pal = kind === 'olive' ? ['#5f6b45', '#76805a', '#8a9370', '#4e5a3a', '#9aa287', '#66704c'] : ['#1f2d1a', '#2a3b22', '#34492a', '#18241a', '#3d5530'];
    g.strokeStyle = kind === 'olive' ? '#4a3a2a' : '#2a2418'; g.lineWidth = 2;
    for (let i = 0; i < 9; i++) { const a = Math.random() * 6.28; g.beginPath(); g.moveTo(S / 2, S / 2); g.lineTo(S / 2 + Math.cos(a) * S * 0.42, S / 2 + Math.sin(a) * S * 0.42); g.stroke(); }
    const n = kind === 'olive' ? 520 : 900;
    for (let i = 0; i < n; i++) {
      const r = Math.pow(Math.random(), 0.7) * S * 0.46, a = Math.random() * 6.28;
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
      g.save(); g.translate(x, y); g.rotate(a + (Math.random() - 0.5) * 1.2);
      g.fillStyle = pal[(Math.random() * pal.length) | 0];
      g.beginPath();
      if (kind === 'olive') g.ellipse(0, 0, 9 + Math.random() * 7, 2.2 + Math.random() * 1.4, 0, 0, 6.28);
      else g.ellipse(0, 0, 4 + Math.random() * 4, 1.6 + Math.random(), 0, 0, 6.28);
      g.fill(); g.restore();
    }
  });
}
function treeMats() {
  if (TREE) return TREE;
  const leaf = kind => new THREE.MeshStandardMaterial({ map: leafTex(kind), alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 }); // coverage softens the leaf edges so they do not crawl
  TREE = { olive: leaf('olive'), cypress: leaf('cypress'), bark: M.bark, olives: [], cypresses: [] };
  for (let v = 0; v < 3; v++) { TREE.olives.push(makeTreeGeo('olive', v)); TREE.cypresses.push(makeTreeGeo('cypress', v)); }
  return TREE;
}
function makeTreeGeo(kind, v) {
  const rnd = (() => { let s = 1234 + v * 77 + (kind === 'olive' ? 0 : 999); return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const RR = (a, b) => a + (b - a) * rnd();
  const wood = [], cards = [];
  const limbTo = (a, b, r0, r1) => { const d = b.clone().sub(a), L = d.length(); const g = new THREE.CylinderGeometry(r1, r0, L, 7, 3); const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); pos.setX(i, pos.getX(i) * (1 + Math.sin(y * 5 + i) * 0.08)); } g.computeVertexNormals();
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize()), new V3(1, 1, 1)); g.applyMatrix4(m); wood.push(g); };
  const card = (c, size, center) => { // three crossed quads, normals pushed out from the crown centre
    for (let k = 0; k < 3; k++) {
      const g = new THREE.PlaneGeometry(size, size);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(RR(-0.6, 0.6) + (k === 2 ? Math.PI / 2 : 0), k * Math.PI / 3 + RR(0, 1), RR(0, 3)));
      g.applyMatrix4(new THREE.Matrix4().compose(c, q, new V3(1, 1, 1)));
      const pos = g.attributes.position, nor = g.attributes.normal;
      for (let i = 0; i < pos.count; i++) { const n = new V3(pos.getX(i) - center.x, (pos.getY(i) - center.y) * 0.8 + 0.6, pos.getZ(i) - center.z).normalize(); nor.setXYZ(i, n.x, n.y, n.z); }
      cards.push(g);
    }
  };
  if (kind === 'olive') { // short gnarled split trunk, wide silvery crown
    const h = RR(1.3, 1.8), top = new V3(RR(-0.3, 0.3), h, RR(-0.3, 0.3));
    limbTo(new V3(0, 0, 0), top, 0.32, 0.2); limbTo(new V3(0.1, 0, -0.08), top.clone().add(new V3(0.25, -0.2, 0.1)), 0.22, 0.15);
    const crown = new V3(top.x, h + 1.5, top.z);
    const nb = 5 + (rnd() * 2 | 0);
    for (let i = 0; i < nb; i++) {
      const a = i / nb * 6.28 + RR(-0.3, 0.3), end = new V3(top.x + Math.cos(a) * RR(1.0, 1.8), h + RR(1.0, 2.0), top.z + Math.sin(a) * RR(1.0, 1.8));
      limbTo(top, end, 0.14, 0.05);
      for (let j = 0; j < 4; j++) card(end.clone().add(new V3(RR(-0.7, 0.7), RR(-0.3, 0.6), RR(-0.7, 0.7))), RR(1.2, 1.7), crown);
    }
    for (let j = 0; j < 8; j++) { const a = rnd() * 6.28, r = RR(0, 1.0); card(crown.clone().add(new V3(Math.cos(a) * r, RR(0, 1.0), Math.sin(a) * r)), RR(1.3, 1.8), crown); }
  } else { // Mediterranean cypress: thin trunk, tall narrow flame of dense foliage
    const H = RR(8.5, 11.5); limbTo(new V3(0, 0, 0), new V3(0, H * 0.85, 0), 0.16, 0.05);
    const center = new V3(0, H * 0.45, 0);
    const n = 46;
    for (let i = 0; i < n; i++) {
      const t = i / n, y = 0.9 + t * (H - 0.9), prof = Math.sin(Math.min(1, t * 1.15 + 0.12) * Math.PI) * (1 - t * 0.55);
      const R0 = 1.05 * prof + 0.12, a = rnd() * 6.28;
      card(new V3(Math.cos(a) * R0 * 0.5, y, Math.sin(a) * R0 * 0.5), R0 * RR(1.5, 2.0) + 0.2, new V3(0, y, 0));
    }
  }
  const W = mergeGeometries(wood.map(g => g.toNonIndexed()), false), C = mergeGeometries(cards.map(g => g.toNonIndexed()), false);
  return { wood: W, leaves: C };
}
function plantTree(kind, x, y, z) {
  const T2 = treeMats(), list = kind === 'olive' ? T2.olives : T2.cypresses, v = list[(sr() * list.length) | 0];
  const ry = sr() * 6.28, sc = kind === 'olive' ? SR(0.85, 1.25) : SR(0.8, 1.15);
  const w = place(v.wood, T2.bark, x, y, z, { ry }); w.scale.setScalar(sc);
  const l = place(v.leaves, kind === 'olive' ? T2.olive : T2.cypress, x, y, z, { ry }); l.scale.setScalar(sc);
}
function cypress(x, y, z) { plantTree('cypress', x, y, z); }
function oliveTree(x, y, z) { plantTree('olive', x, y, z); }
function village() {
  const V = vmats();
  // terraced hillside rising to the south: stone retaining walls, earth on top, whitewashed lanes and steps
  for (let row = 0; row < 6; row++) {
    const z = 46 + row * 9, y = row * 3.2;
    addBox(0, -0.2, z + 4.5, 190, y + 0.2, 9, V.earth, { collide: false, s: 6 });
    if (row) { addBox(0, y - 3.2, z + 0.3, 190, 3.2, 0.6, M.stone, { collide: false, s: 3 }); addBox(0, y, z + 0.3, 190, 0.18, 0.75, V.trim, { collide: false, s: 2 }); }
    addBox(0, y, z + 1.0, 190, 0.04, 1.6, M.concrete, { collide: false, s: 3 }); // lane along the terrace
    for (const sx of [-52, -18, 14, 46]) if (row) { // steps up between rows
      const sx2 = sx + row * 3; for (let k = 0; k < 10; k++) addBox(sx2, y - 3.2, z + 0.3 - (10 - k) * 0.3 + 0.15, 1.6, (k + 1) * 0.32, 0.3, M.concrete, { collide: false, s: 1 });
      for (const s of [-1, 1]) addBox(sx2 + s * 0.88, y - 3.2, z - 1.2, 0.16, 3.4, 3.0, V.trim, { collide: false, s: 1 });
    }
    const stepXs = row < 5 ? [-52, -18, 14, 46].map(v => v + (row + 1) * 3) : [];
    for (let x = -88; x < 88;) {
      const w = SR(4.2, 6.8);
      if (stepXs.some(v => Math.abs(x + w / 2 - v) < w / 2 + 1.3)) { x += 1.5; continue; }
      if (sr() < 0.14) { sr() < 0.5 ? cypress(x, y, z + SR(2, 6), SR(7, 11)) : oliveTree(x, y, z + SR(2, 6)); x += SR(3, 5); continue; }
      greekHouse(x + w / 2, y, z + SR(2.2, 3.4) + 2.5, w, SR(4.2, 5.6), sr() < 0.35 ? SR(5.2, 6.0) : SR(3.0, 4.2));
      x += w + SR(0.3, 2.6);
    }
    for (let x = -80; x < 80; x += SR(14, 22)) { place(cyl(0.05, 3.2, 6), M.steel, x, y + 1.6, z + 1.8, { cast: false }); place(new THREE.SphereGeometry(0.16, 8, 6), M.lamp, x, y + 3.25, z + 1.8, { cast: false }); }
  }
  // chapel with blue dome on the hill
  const cx = 22, cy = 6 * 3.2, cz = 96;
  addBox(cx, cy, cz, 7, 5, 9, M.whitewash, { collide: false, s: 3 });
  place(cyl(2.4, 1.2, 24), M.whitewash, cx, cy + 5.6, cz);
  place(new THREE.SphereGeometry(2.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.aegean, cx, cy + 6.2, cz);
  addBox(cx - 2.6, cy, cz - 5, 1.8, 8, 1.8, M.whitewash, { collide: false, s: 3 });
  place(new THREE.SphereGeometry(0.95, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.aegean, cx - 2.6, cy + 8, cz - 5);
  for (const s of [-1, 1]) place(boxGeo(0.5, 1.2, 0.08, 1), V.recess, cx - 2.6 + s * 0.0, cy + 6.4, cz - 5.92 + (s > 0 ? 0 : 0), { cast: false });
  place(boxGeo(0.12, 1.1, 0.12, 1), M.steelLight, cx, cy + 9.2, cz); place(boxGeo(0.7, 0.12, 0.12, 1), M.steelLight, cx, cy + 9.4, cz);
  place(boxGeo(1.4, 2.4, 0.06, 1), V.blue, cx, cy + 1.2, cz - 4.53, { cast: false });
  // trees outside the walls (east side moved out past the new dock yard)
  for (let z = -15; z <= 36; z += 7) { cypress(-48 - sr() * 6, 0, z, SR(8, 12)); cypress(76 + sr() * 4, 0, z + 3, SR(8, 12)); }
  for (let i = 0; i < 7; i++) oliveTree(SR(-72, -54), 0, SR(-10, 40));
  // a few houses west
  for (let z = -10; z < 42; z += 9) greekHouse(-63, 0, z, 6, 6, SR(3.5, 6));
}

// Army 6x6 cargo truck, long axis along x, cab at +x: lathe tyres with tread, hubs, sloped bonnet, framed windscreen,
// mirrors, dropside bed with a canvas tilt over hoops, fuel tank, spare wheel, jerry cans, Greek army plate.
let TRUCK_MAT = null;
function truckMats() {
  return TRUCK_MAT || (TRUCK_MAT = {
    paint: std({ map: T.concrete, color: 0x6d7450, roughness: 0.72, metalness: 0.25 }),
    dark: std({ color: 0x24261f, roughness: 0.8, metalness: 0.3 }),
    tyre: std({ color: 0x1a1a19, roughness: 0.95 }),
    canvas: std({ map: T.burlap, color: 0x7d7a58, roughness: 1 }),
    lens: std({ color: 0xe8e4d0, emissive: 0xfff2c8, emissiveIntensity: 0.4, roughness: 0.1, metalness: 0.2 }),
    amber: std({ color: 0xd07a1a, emissive: 0x6a2a00, emissiveIntensity: 0.5, roughness: 0.2 }),
    plate: std({ map: ctex(256, (g, S) => { g.fillStyle = '#f2f0e6'; g.fillRect(0, 0, S, S); g.fillStyle = '#111'; g.font = '700 74px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('ΕΣ 4217', S / 2, S / 2); g.strokeStyle = '#111'; g.lineWidth = 8; g.strokeRect(6, 70, S - 12, S - 140); }), roughness: 0.5 })
  });
}
const TYRE_GEO = (() => {
  const pts = [[0.3, -0.2], [0.47, -0.21], [0.53, -0.18], [0.56, -0.1], [0.56, 0.1], [0.53, 0.18], [0.47, 0.21], [0.3, 0.2]].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 28).rotateX(Math.PI / 2);
})();
function truckWheel(x, y, z, side) {
  const TM = truckMats();
  place(TYRE_GEO, TM.tyre, x, y, z);
  for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2; place(boxGeo(0.1, 0.05, 0.38, 1), TM.tyre, x + Math.cos(a) * 0.565, y + Math.sin(a) * 0.565, z, { rz: a + Math.PI / 2, cast: false }); }
  place(new THREE.CylinderGeometry(0.31, 0.31, 0.3, 20).rotateX(Math.PI / 2), TM.paint, x, y, z);
  place(new THREE.CylinderGeometry(0.12, 0.15, 0.1, 12).rotateX(Math.PI / 2), TM.dark, x, y, z + side * 0.18, { cast: false });
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; place(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 6).rotateX(Math.PI / 2), M.steelLight, x + Math.cos(a) * 0.21, y + Math.sin(a) * 0.21, z + side * 0.16, { cast: false }); }
}
function truck(x, z) { // long axis along x, cab at +x
  const TM = truckMats(), P = TM.paint;
  const box = (cx, y0, cz, w, h, d, mat, o = {}) => addBox(x + cx, y0, z + cz, w, h, d, mat, Object.assign({ collide: false, s: 1.5 }, o));
  // chassis, axles, wheels
  for (const s of [-1, 1]) box(-0.2, 0.62, s * 0.45, 7.6, 0.26, 0.16, TM.dark);
  for (const ax of [2.45, -1.0, -2.5]) { box(ax, 0.48, 0, 0.18, 0.14, 1.9, TM.dark); for (const s of [-1, 1]) truckWheel(x + ax, 0.56, z + s * 1.06, s); }
  // wheel arches / mudguards
  for (const s of [-1, 1]) { box(2.45, 1.16, s * 1.06, 1.45, 0.07, 0.46, P); box(1.72, 0.75, s * 1.06, 0.06, 0.45, 0.46, P); box(-1.75, 1.16, s * 1.06, 2.9, 0.07, 0.46, P); box(-3.25, 0.62, s * 1.06, 0.04, 0.5, 0.46, TM.tyre); }
  // cab: body, bonnet sloping to the grille, roof, doors, windows
  box(2.55, 0.85, 0, 1.6, 1.15, 2.28, P);                                   // engine bay / lower cab front
  place(boxGeo(1.25, 0.12, 2.24, 1.5), P, x + 3.05, 2.02, z, { rz: -0.18 }); // bonnet top
  box(1.35, 0.85, 0, 1.0, 2.05, 2.32, P);                                   // cab box
  box(1.32, 2.9, 0, 1.12, 0.08, 2.4, P);                                    // roof
  place(new THREE.TorusGeometry(0.32, 0.05, 6, 18).rotateX(Math.PI / 2), TM.dark, x + 1.3, 2.99, z + 0.5);
  box(3.38, 0.75, 0, 0.12, 1.15, 2.0, TM.dark);                             // grille frame
  for (let i = 0; i < 9; i++) box(3.45, 0.85, -0.8 + i * 0.2, 0.05, 0.95, 0.05, M.steel);
  box(3.62, 0.5, 0, 0.22, 0.32, 2.5, M.steel);                              // bumper
  for (const s of [-1, 1]) { place(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 16).rotateZ(Math.PI / 2), TM.lens, x + 3.46, 1.45, z + s * 0.85, { cast: false }); box(3.4, 1.3, s * 0.85, 0.1, 0.3, 0.32, TM.dark); place(boxGeo(0.06, 0.1, 0.16, 1), TM.amber, x + 3.47, 1.05, z + s * 1.0, { cast: false }); }
  place(boxGeo(0.04, 0.18, 0.5, 1), TM.plate, x + 3.75, 0.66, z, { cast: false });
  // windscreen: two panes in a frame
  for (const s of [-1, 1]) place(boxGeo(0.05, 0.78, 0.98, 1), M.glass, x + 1.86, 2.4, z + s * 0.54, { rz: 0.08, cast: false });
  box(1.87, 1.98, 0, 0.08, 0.06, 2.3, TM.dark); box(1.84, 2.84, 0, 0.08, 0.06, 2.3, TM.dark); box(1.86, 1.98, 0, 0.08, 0.9, 0.08, TM.dark);
  // doors with windows, handles, steps; mirrors on arms
  for (const s of [-1, 1]) {
    place(boxGeo(0.72, 0.62, 0.04, 1), M.glass, x + 1.38, 2.42, z + s * 1.17, { cast: false });
    box(1.38, 1.0, s * 1.165, 0.9, 0.03, 0.03, TM.dark); box(0.9, 1.0, s * 1.165, 0.03, 1.85, 0.03, TM.dark);
    box(1.7, 1.75, s * 1.18, 0.14, 0.04, 0.04, M.steelLight);
    box(1.4, 0.7, s * 1.23, 0.6, 0.06, 0.25, M.steel);
    box(1.9, 2.3, s * 1.42, 0.05, 0.04, 0.45, M.steel); place(boxGeo(0.08, 0.42, 0.22, 1), TM.dark, x + 1.92, 2.3, z + s * 1.67);
  }
  // exhaust stack, air filter, fuel tank, battery box
  place(cyl(0.07, 1.9, 10), TM.dark, x + 0.78, 2.15, z + 1.0); place(cyl(0.09, 0.16, 10), M.steel, x + 0.78, 3.15, z + 1.0);
  place(new THREE.CylinderGeometry(0.28, 0.28, 1.1, 16).rotateZ(Math.PI / 2), P, x + 0.2, 0.98, z - 1.0);
  box(0.2, 0.7, 1.0, 0.8, 0.45, 0.4, TM.dark);
  // spare wheel behind the cab
  place(TYRE_GEO, TM.tyre, x + 0.62, 2.0, z, { ry: Math.PI / 2 });
  // cargo bed with dropsides
  box(-1.3, 0.75, 0, 5.4, 0.16, 2.4, P);
  for (const s of [-1, 1]) { box(-1.3, 0.91, s * 1.19, 5.4, 0.6, 0.05, P); for (let i = 0; i < 6; i++) box(-3.9 + i * 1.04, 0.91, s * 1.22, 0.06, 0.6, 0.04, TM.dark); }
  box(-4.0, 0.75, 0, 0.06, 0.76, 2.4, P);
  // canvas tilt: walls, rounded roof over hoops, straps, tailgate flap rolled up
  for (const s of [-1, 1]) box(-1.3, 1.5, s * 1.17, 5.3, 1.05, 0.04, TM.canvas);
  box(0.0 + 1.33, 1.5, 0, 0.04, 1.05, 2.34, TM.canvas);
  { const roofG = new THREE.CylinderGeometry(1.17, 1.17, 5.3, 20, 1, true, 0, Math.PI).rotateZ(Math.PI / 2); roofG.scale(1, 0.42, 1); place(roofG, TM.canvas, x - 1.3, 2.55, z); }
  for (let i = 0; i < 5; i++) { const g = new THREE.CylinderGeometry(1.19, 1.19, 0.07, 20, 1, true, 0, Math.PI).rotateZ(Math.PI / 2); g.scale(1, 0.42, 1); place(g, TM.dark, x - 3.8 + i * 1.25, 2.55, z, { cast: false }); }
  for (let i = 0; i < 7; i++) for (const s of [-1, 1]) box(-3.85 + i * 0.85, 1.55, s * 1.2, 0.04, 0.9, 0.02, TM.dark);
  place(new THREE.CylinderGeometry(0.14, 0.14, 2.3, 10).rotateX(Math.PI / 2), TM.canvas, x - 3.98, 2.45, z);
  place(boxGeo(0.02, 0.95, 2.2, 1), V_TRUCK_DARK(), x - 3.99, 1.95, z, { cast: false });
  // jerry cans on the side, tail lights
  for (let i = 0; i < 2; i++) place(boxGeo(0.34, 0.47, 0.16, 1), TM.paint, x - 0.3 - i * 0.38, 1.18, z - 1.32);
  for (const s of [-1, 1]) place(boxGeo(0.05, 0.12, 0.22, 1), M.red, x - 4.04, 0.95, z + s * 0.95, { cast: false });
  // collision: cab, bed, under-chassis
  addCollider(x + 0.8, 0.55, z - 1.2, x + 3.7, 3.0, z + 1.2);
  addCollider(x - 4.0, 0.75, z - 1.25, x + 0.8, 3.0, z + 1.25);
  addCollider(x - 4.0, 0, z - 1.25, x + 3.7, 0.75, z + 1.25);
}
function V_TRUCK_DARK() { return vmats().recess; }

function ammoCrateAt(x, y, z) {
  addBox(x, y, z, 0.9, 0.45, 0.5, M.olive, { s: 1 });
  place(boxGeo(0.7, 0.03, 0.06, 1), M.stripe, x, y + 0.46, z, { cast: false });
  ammoCrates.push({ pos: new V3(x, y, z), cool: 0 });
}

function mergeStatic() {
  const groups = new Map();
  for (const m of staticMeshes) {
    m.updateMatrixWorld(true);
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    const key = m.material.uuid + (m.castShadow ? 'c' : 'n');
    if (!groups.has(key)) groups.set(key, { mat: m.material, cast: m.castShadow, geos: [] });
    groups.get(key).geos.push(g);
  }
  for (const { mat, cast, geos } of groups.values()) {
    const merged = mergeGeometries(geos, false);
    const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = cast; mesh.receiveShadow = true; scene.add(mesh);
  }
  staticMeshes.length = 0;
}

// ======================================================= INTERIORS
// Every building is fitted out for what it is: offices with desks and live screens, supply stores with racking,
// cargo sheds with pallets and a forklift, a workshop in the boathouse. Furniture stays low or against the walls.
let INTM = null;
function intMats() {
  if (INTM) return INTM;
  const scr = draw => { const t = ctex(256, draw); return new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 1.1, roughness: 0.25 }); };
  const txt = (g, s, x, y, size = 11, col = '#9fe8b0') => { g.fillStyle = col; g.font = `${size}px Menlo, monospace`; g.fillText(s, x, y); };
  const chart = ctex(1024, (g, S) => { // nautical chart of the island: soundings, contours, compass rose, Greek names
    g.fillStyle = '#e9e2c9'; g.fillRect(0, 0, S, S); grain(g, S, 10);
    g.fillStyle = '#cfe0e6'; g.fillRect(0, 0, S, S * 0.62);
    g.strokeStyle = 'rgba(70,110,140,.5)'; g.lineWidth = 1.5; for (let k = 0; k < 7; k++) { g.beginPath(); for (let x = 0; x <= S; x += 16) { const y = S * 0.56 - k * 62 + Math.sin(x * 0.012 + k) * 22 + Math.sin(x * 0.03 + k * 2) * 9; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
    g.fillStyle = '#e7d9a6'; g.beginPath(); g.moveTo(0, S * 0.6); for (let x = 0; x <= S; x += 20) g.lineTo(x, S * 0.6 + Math.sin(x * 0.011) * 26 + Math.sin(x * 0.041) * 10); g.lineTo(S, S); g.lineTo(0, S); g.fill();
    g.strokeStyle = '#6b5a3a'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#b9ae86'; g.fillRect(S * 0.32, S * 0.6, S * 0.36, S * 0.2); g.fillRect(S * 0.6, S * 0.36, S * 0.07, S * 0.26);
    g.fillStyle = 'rgba(40,60,80,.75)'; g.font = '13px Georgia, serif'; for (let i = 0; i < 90; i++) g.fillText(String(4 + (sr() * 38 | 0)), sr() * S, sr() * S * 0.54);
    g.strokeStyle = 'rgba(150,40,40,.8)'; g.lineWidth = 2; g.beginPath(); g.arc(S * 0.2, S * 0.24, 80, 0, 7); g.stroke(); for (let a = 0; a < 16; a++) { g.beginPath(); g.moveTo(S * 0.2 + Math.cos(a * 0.3927) * (a % 4 ? 62 : 30), S * 0.24 + Math.sin(a * 0.3927) * (a % 4 ? 62 : 30)); g.lineTo(S * 0.2 + Math.cos(a * 0.3927) * 80, S * 0.24 + Math.sin(a * 0.3927) * 80); g.stroke(); }
    g.fillStyle = '#3a2f1c'; g.font = 'italic 34px Georgia, serif'; g.fillText('ΛΙΜΑΝΙ ΚΕΣΣΑ', S * 0.36, S * 0.72); g.font = 'italic 24px Georgia, serif'; g.fillText('ΑΙΓΑΙΟ ΠΕΛΑΓΟΣ', S * 0.52, S * 0.16); g.fillText('Προβλήτα', S * 0.69, S * 0.47); g.fillText('Χωριό', S * 0.12, S * 0.9);
    g.strokeStyle = '#3a2f1c'; g.lineWidth = 8; g.strokeRect(10, 10, S - 20, S - 20);
  });
  INTM = {
    laminate: std({ color: 0xb9a688, roughness: 0.5 }), dark: std({ color: 0x232527, roughness: 0.55, metalness: 0.3 }), fabric: std({ color: 0x1e2f4a, roughness: 0.95 }),
    cab: std({ color: 0x8d949a, roughness: 0.45, metalness: 0.6 }), locker: std({ color: 0x44533f, roughness: 0.55, metalness: 0.4 }), yellow: std({ color: 0xe0a91e, roughness: 0.5, metalness: 0.25 }),
    card: std({ map: ctex(256, (g, S) => { g.fillStyle = '#b08a5a'; g.fillRect(0, 0, S, S); grain(g, S, 14); g.fillStyle = 'rgba(226,205,160,.9)'; g.fillRect(0, S * 0.44, S, S * 0.12); g.fillStyle = '#f1efe6'; g.fillRect(S * 0.56, S * 0.62, S * 0.34, S * 0.24); g.fillStyle = '#222'; for (let i = 0; i < 5; i++) g.fillRect(S * 0.59, S * 0.66 + i * 9, S * (0.12 + sr() * 0.16), 3); g.strokeStyle = 'rgba(60,40,20,.6)'; g.lineWidth = 3; g.strokeRect(2, 2, S - 4, S - 4); g.fillStyle = 'rgba(50,30,15,.8)'; g.font = '700 26px Arial'; g.fillText('ΕΥΘΡΑΥΣΤΟ', S * 0.08, S * 0.3); }), roughness: 0.9 }),
    wrap: std({ color: 0xd9e2e6, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.55 }),
    terra: std({ color: 0xb5623c, roughness: 0.85 }), tin: std({ color: 0x3f7a3a, roughness: 0.35, metalness: 0.7 }), tin2: std({ color: 0xc9a227, roughness: 0.35, metalness: 0.7 }), glassG: std({ color: 0x1f4a2a, roughness: 0.15, metalness: 0.2 }),
    jerry: std({ color: 0xa3261c, roughness: 0.5, metalness: 0.3 }), ring: std({ color: 0xe2571c, roughness: 0.7 }), white: std({ color: 0xeeeeea, roughness: 0.6 }),
    chart: std({ map: chart, roughness: 0.85 }),
    board: std({ map: ctex(512, (g, S) => { g.fillStyle = '#f3f3ef'; g.fillRect(0, 0, S, S); g.strokeStyle = '#1d4fa0'; g.lineWidth = 3; for (let i = 0; i < 7; i++) { g.beginPath(); let x = 30, y = 60 + i * 58; g.moveTo(x, y); for (let k = 0; k < 9; k++) { x += 20 + sr() * 30; g.lineTo(x, y + (sr() - 0.5) * 16); } g.stroke(); } g.strokeStyle = '#b02a20'; g.strokeRect(S * 0.6, S * 0.1, S * 0.32, S * 0.3); g.beginPath(); g.moveTo(S * 0.62, S * 0.36); g.lineTo(S * 0.72, S * 0.2); g.lineTo(S * 0.8, S * 0.28); g.lineTo(S * 0.9, S * 0.13); g.stroke(); g.fillStyle = '#222'; g.font = '700 30px Arial'; g.fillText('ΒΑΡΔΙΕΣ', 30, 36); }), roughness: 0.4 }),
    peg: std({ map: ctex(512, (g, S) => { g.fillStyle = '#8a6a44'; g.fillRect(0, 0, S, S); for (let y = 12; y < S; y += 24) for (let x = 12; x < S; x += 24) { g.fillStyle = 'rgba(30,20,10,.6)'; g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill(); } g.lineCap = 'round'; const tool = (x, y, l, w, col, a) => { g.save(); g.translate(x, y); g.rotate(a); g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, l); g.stroke(); g.restore(); }; for (let i = 0; i < 9; i++) { tool(40 + i * 52, 60, 110, 9, '#9aa0a6', 0); tool(40 + i * 52, 150, 40, 16, i % 2 ? '#b02a20' : '#e0a91e', 0); } for (let i = 0; i < 6; i++) { tool(60 + i * 78, 280, 150, 7, '#c9ced2', 0.2); g.strokeStyle = '#c9ced2'; g.lineWidth = 7; g.beginPath(); g.arc(60 + i * 78, 272, 14, 0.5, 5.6); g.stroke(); } }), roughness: 0.85 }),
    screens: [
      scr((g, S) => { g.fillStyle = '#04120a'; g.fillRect(0, 0, S, S); g.strokeStyle = '#1f7a44'; g.lineWidth = 1.5; for (const r of [30, 60, 90, 118]) { g.beginPath(); g.arc(S / 2, S / 2, r, 0, 7); g.stroke(); } g.beginPath(); g.moveTo(S / 2, 8); g.lineTo(S / 2, S - 8); g.moveTo(8, S / 2); g.lineTo(S - 8, S / 2); g.stroke(); const gr = g.createConicGradient ? g.createConicGradient(1.0, S / 2, S / 2) : null; if (gr) { gr.addColorStop(0, 'rgba(80,255,150,.55)'); gr.addColorStop(0.12, 'rgba(80,255,150,0)'); gr.addColorStop(1, 'rgba(80,255,150,0)'); g.fillStyle = gr; g.beginPath(); g.arc(S / 2, S / 2, 118, 0, 7); g.fill(); } g.fillStyle = '#9dffbf'; for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(S / 2 + (sr() - 0.5) * 190, S / 2 + (sr() - 0.5) * 190, 3, 0, 7); g.fill(); } txt(g, 'RADAR ΛΙΜΕΝΑΡΧΕΙΟ', 8, 16); }),
      scr((g, S) => { g.fillStyle = '#0a0c10'; g.fillRect(0, 0, S, S); for (let i = 0; i < 4; i++) { const x = (i % 2) * S / 2 + 4, y = (i >> 1) * S / 2 + 4, w = S / 2 - 8; const gr = g.createLinearGradient(x, y, x, y + w); gr.addColorStop(0, ['#39485a', '#4a4032', '#2f4a3c', '#44384c'][i]); gr.addColorStop(1, '#12161c'); g.fillStyle = gr; g.fillRect(x, y, w, w); g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x + w * 0.2, y + w * 0.5, w * 0.3, w * 0.4); g.fillRect(x + w * 0.6, y + w * 0.35, w * 0.25, w * 0.55); txt(g, 'CAM 0' + (i + 1), x + 5, y + 14, 10, '#e8e8e8'); g.fillStyle = '#e03a2a'; g.beginPath(); g.arc(x + w - 10, y + 10, 3.5, 0, 7); g.fill(); } }),
      scr((g, S) => { g.fillStyle = '#0b1622'; g.fillRect(0, 0, S, S); g.fillStyle = '#17324e'; g.fillRect(0, 0, S, 22); txt(g, 'ΔΗΛΩΤΙΚΟ ΦΟΡΤΙΟΥ  ·  AEGEAN STAR', 6, 15, 10, '#dfe9f2'); for (let i = 0; i < 14; i++) { txt(g, 'HLNU ' + (204000 + (sr() * 9999 | 0)) + '   ' + ['SKG', 'KLX', 'MES', 'ANA'][i % 4] + '   ' + (12 + (sr() * 18 | 0)) + ' t', 8, 42 + i * 15, 10, i === 5 ? '#ffd27a' : '#8fc4e8'); } g.fillStyle = '#2f9e5a'; g.fillRect(8, S - 26, S * 0.6, 10); }),
      scr((g, S) => { g.fillStyle = '#101418'; g.fillRect(0, 0, S, S); g.fillStyle = '#cfe0e6'; g.fillRect(6, 6, S - 12, S - 12); g.fillStyle = '#e7d9a6'; g.beginPath(); g.moveTo(6, S * 0.6); g.bezierCurveTo(S * 0.3, S * 0.45, S * 0.6, S * 0.75, S - 6, S * 0.55); g.lineTo(S - 6, S - 6); g.lineTo(6, S - 6); g.fill(); g.strokeStyle = '#b02a20'; g.lineWidth = 2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(S * 0.9, S * 0.1); g.lineTo(S * 0.55, S * 0.3); g.lineTo(S * 0.5, S * 0.55); g.stroke(); g.setLineDash([]); g.fillStyle = '#b02a20'; g.beginPath(); g.arc(S * 0.5, S * 0.55, 5, 0, 7); g.fill(); txt(g, 'ECDIS', 12, 20, 11, '#17324e'); })
    ],
    leds: new THREE.MeshStandardMaterial({ map: ctex(128, (g, S) => { g.fillStyle = '#0c0d0f'; g.fillRect(0, 0, S, S); for (let y = 8; y < S; y += 10) { g.fillStyle = '#17191c'; g.fillRect(4, y, S - 8, 7); for (let x = 10; x < S - 8; x += 9) if (sr() < 0.45) { g.fillStyle = sr() < 0.75 ? '#35e06a' : '#ffb02a'; g.fillRect(x, y + 2, 3, 3); } } }), emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 })
  };
  INTM.leds.emissiveMap = INTM.leds.map;
  return INTM;
}
// place a box in a piece of furniture's own frame: dir 0..3 turns it in quarter turns (local +z -> world +z, +x, -z, -x)
function fbox(x, y, z, dir, lx, ly, lz, w, h, d, mat, o = {}) {
  const c = [1, 0, -1, 0][dir], sn = [0, 1, 0, -1][dir], odd = dir & 1;
  return addBox(x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c, odd ? d : w, h, odd ? w : d, mat, { collide: false, s: 1, ...o });
}
function fcol(x, y, z, dir, lx, lz, w, d, h) { const c = [1, 0, -1, 0][dir], sn = [0, 1, 0, -1][dir], odd = dir & 1, cx = x + lx * c + lz * sn, cz = z - lx * sn + lz * c, ww = odd ? d : w, dd = odd ? w : d; addCollider(cx - ww / 2, y, cz - dd / 2, cx + ww / 2, y + h, cz + dd / 2); }
function fplane(x, y, z, dir, lx, ly, lz, w, h, mat) { // upright plane facing local +z
  const c = [1, 0, -1, 0][dir], sn = [0, 1, 0, -1][dir];
  return place(new THREE.PlaneGeometry(w, h), mat, x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c, { ry: dir * Math.PI / 2, cast: false });
}
function desk(x, z, dir, screen = 0, y = 0) { // you sit on the local +z side, facing -z
  const I = intMats();
  fbox(x, y, z, dir, 0, 0.72, 0, 1.5, 0.04, 0.72, I.laminate); fbox(x, y, z, dir, -0.72, 0, 0, 0.04, 0.72, 0.68, I.cab); fbox(x, y, z, dir, 0.5, 0.12, 0, 0.42, 0.6, 0.62, I.cab);
  for (const yy of [0.3, 0.5, 0.66]) fbox(x, y, z, dir, 0.5, yy, 0.32, 0.2, 0.02, 0.02, I.dark);
  fbox(x, y, z, dir, -0.15, 0.76, -0.2, 0.22, 0.02, 0.16, I.dark); fbox(x, y, z, dir, -0.15, 0.78, -0.22, 0.04, 0.12, 0.03, I.dark); fbox(x, y, z, dir, -0.15, 0.88, -0.2, 0.62, 0.38, 0.035, I.dark);
  fplane(x, y, z, dir, -0.15, 1.07, -0.18, 0.57, 0.33, I.screens[screen % I.screens.length]);
  fbox(x, y, z, dir, -0.15, 0.76, 0.12, 0.42, 0.018, 0.14, I.dark); fbox(x, y, z, dir, 0.2, 0.76, 0.14, 0.06, 0.025, 0.1, I.dark);
  fbox(x, y, z, dir, 0.5, 0.76, -0.1, 0.24, 0.05, 0.32, I.white); fbox(x, y, z, dir, -0.58, 0.76, 0.05, 0.09, 0.11, 0.09, I.jerry);
  fcol(x, y, z, dir, 0, 0, 1.5, 0.72, 0.78);
  // swivel chair
  fbox(x, y, z, dir, -0.1, 0.42, 0.75, 0.46, 0.08, 0.46, I.fabric); fbox(x, y, z, dir, -0.1, 0.5, 0.96, 0.44, 0.52, 0.06, I.fabric); fbox(x, y, z, dir, -0.1, 0.06, 0.75, 0.06, 0.36, 0.06, I.dark); fbox(x, y, z, dir, -0.1, 0.02, 0.75, 0.5, 0.04, 0.08, I.dark); fbox(x, y, z, dir, -0.1, 0.02, 0.75, 0.08, 0.04, 0.5, I.dark);
  fcol(x, y, z, dir, -0.1, 0.8, 0.46, 0.5, 0.5);
}
function cabinet(x, z, dir, y = 0, h = 1.32) { const I = intMats(); fbox(x, y, z, dir, 0, 0, 0, 0.48, h, 0.6, I.cab); for (let k = 0; k < Math.round(h / 0.33); k++) { fbox(x, y, z, dir, 0, 0.05 + k * 0.33, 0.3, 0.44, 0.28, 0.012, I.laminate.clone ? I.cab : I.cab); fbox(x, y, z, dir, 0, 0.2 + k * 0.33, 0.31, 0.16, 0.025, 0.02, I.dark); } fcol(x, y, z, dir, 0, 0, 0.48, 0.6, h); }
function lockers(x, z, dir, n = 3, y = 0) { const I = intMats(); for (let i = 0; i < n; i++) { const lx = (i - (n - 1) / 2) * 0.46; fbox(x, y, z, dir, lx, 0, 0, 0.44, 1.85, 0.5, I.locker); for (const yy of [1.5, 1.58, 1.66]) fbox(x, y, z, dir, lx, yy, 0.25, 0.26, 0.02, 0.012, I.dark); fbox(x, y, z, dir, lx + 0.14, 0.95, 0.255, 0.03, 0.1, 0.02, M.steelLight); } fcol(x, y, z, dir, 0, 0, n * 0.46, 0.5, 1.85); }
function radioRack(x, z, dir, y = 0) { const I = intMats(); fbox(x, y, z, dir, 0, 0, 0, 0.6, 1.7, 0.6, I.dark); fplane(x, y, z, dir, 0, 0.95, 0.305, 0.54, 1.4, I.leds); fbox(x, y, z, dir, 0.2, 1.7, 0, 0.02, 0.9, 0.02, I.dark); fcol(x, y, z, dir, 0, 0, 0.6, 0.6, 1.7); }
function wallArt(x, y, z, dir, w, h, mat) { fbox(x, 0, z, dir, 0, y - h / 2 - 0.03, -0.012, w + 0.08, h + 0.06, 0.02, intMats().dark); fplane(x, 0, z, dir, 0, y, 0.004, w, h, mat); }
// pallet racking: steel uprights and beams, boxes (or tins) on every level. Stands against a wall; long axis is local x.
function rack(x, z, dir, len, levels = 3, depth = 0.9, stock = 'card', y = 0) {
  const I = intMats(), H = levels * 0.95 + 0.25;
  for (const sx of [-len / 2 + 0.04, len / 2 - 0.04]) for (const sz of [-depth / 2 + 0.04, depth / 2 - 0.04]) fbox(x, y, z, dir, sx, 0, sz, 0.07, H, 0.07, I.yellow === undefined ? M.steel : dockMats().crane);
  for (let l = 0; l < levels; l++) {
    const ly = 0.2 + l * 0.95;
    for (const sz of [-depth / 2 + 0.04, depth / 2 - 0.04]) fbox(x, y, z, dir, 0, ly - 0.08, sz, len - 0.08, 0.08, 0.05, I.yellow);
    fbox(x, y, z, dir, 0, ly, 0, len - 0.1, 0.03, depth - 0.06, M.wood);
    for (let lx = -len / 2 + 0.35; lx < len / 2 - 0.3;) {
      const w = SR(0.36, 0.7), h = SR(0.28, 0.7), skip = sr() < 0.14;
      if (!skip) { if (stock === 'tins') { const m = sr() < 0.5 ? I.tin : I.tin2; for (const dz of [-0.16, 0.16]) fbox(x, y, z, dir, lx + w / 2, ly + 0.03, dz, 0.24, 0.34, 0.2, m); } else fbox(x, y, z, dir, lx + w / 2, ly + 0.03, SR(-0.06, 0.06), w - 0.04, h, depth * SR(0.55, 0.8), I.card, { s: Math.max(w, h) }); }
      lx += w + 0.05;
    }
  }
  fcol(x, y, z, dir, 0, 0, len, depth, H);
}
function wrappedPallet(x, z, h = 1.2, y = 0) { const I = intMats(); addBox(x, y, z, 1.2, 0.14, 1.0, M.wood, { collide: false, s: 1 }); for (let k = 0; k < 2; k++) for (const dx of [-0.29, 0.29]) addBox(x + dx, y + 0.14 + k * h / 2, z, 0.56, h / 2 - 0.02, 0.92, I.card, { collide: false, s: 0.6 }); addBox(x, y + 0.13, z, 1.18, h + 0.03, 0.98, I.wrap, { collide: false, cast: false }); addCollider(x - 0.6, y, z - 0.5, x + 0.6, y + h + 0.16, z + 0.5); }
function forklift(x, z, dir) { // forks point along local +z
  const I = intMats(), w = cyl(0.26, 0.2, 16);
  fbox(x, 0, z, dir, 0, 0.3, -0.25, 1.1, 0.7, 1.7, I.yellow); fbox(x, 0, z, dir, 0, 0.3, -1.2, 1.1, 0.95, 0.4, I.dark); fbox(x, 0, z, dir, 0, 1.0, -0.5, 0.5, 0.1, 0.5, I.dark); fbox(x, 0, z, dir, 0, 1.1, -0.78, 0.5, 0.5, 0.08, I.dark);
  for (const sx of [-0.5, 0.5]) { fbox(x, 0, z, dir, sx, 1.0, -1.0, 0.06, 1.1, 0.06, I.dark); fbox(x, 0, z, dir, sx, 1.0, 0.25, 0.06, 1.1, 0.06, I.dark); fbox(x, 0, z, dir, sx * 0.7, 0.15, 0.72, 0.1, 2.5, 0.12, I.dark); fbox(x, 0, z, dir, sx * 0.5, 0.12, 1.3, 0.12, 0.05, 1.1, M.steelLight); fbox(x, 0, z, dir, sx * 0.5, 0.12, 0.8, 0.12, 0.6, 0.05, M.steelLight); }
  fbox(x, 0, z, dir, 0, 2.1, -0.38, 1.12, 0.06, 1.36, I.dark); fbox(x, 0, z, dir, 0, 1.5, 0.72, 0.9, 0.08, 0.1, I.dark); fbox(x, 0, z, dir, 0, 0.75, 0.2, 0.05, 0.5, 0.05, I.dark); fbox(x, 0, z, dir, 0, 1.23, 0.14, 0.3, 0.04, 0.3, I.dark);
  const c = [1, 0, -1, 0][dir], sn = [0, 1, 0, -1][dir];
  for (const [lx, lz] of [[-0.56, 0.35], [0.56, 0.35], [-0.5, -0.95], [0.5, -0.95]]) place(w, AIRM.rubber, x + lx * c + lz * sn, 0.26, z - lx * sn + lz * c, dir & 1 ? { rx: Math.PI / 2 } : { rz: Math.PI / 2 });
  fcol(x, 0, z, dir, 0, -0.1, 1.2, 2.5, 2.16);
}
let AMPH = null;
function amphora(x, z, y = 0, sc = 1) { AMPH = AMPH || new THREE.LatheGeometry([[0.06, 0], [0.14, 0.05], [0.26, 0.3], [0.29, 0.5], [0.24, 0.72], [0.12, 0.86], [0.1, 0.98], [0.14, 1.02]].map(p => new THREE.Vector2(p[0], p[1])), 16); const m = place(AMPH, intMats().terra, x, y, z); m.scale.setScalar(sc); addCollider(x - 0.26 * sc, y, z - 0.26 * sc, x + 0.26 * sc, y + sc, z + 0.26 * sc); }
function tube(x, y, z, alongZ, len = 1.4) { addBox(x, y, z, alongZ ? 0.14 : len, 0.05, alongZ ? len : 0.14, M.steel, { collide: false, cast: false }); place(boxGeo(alongZ ? 0.09 : len - 0.1, 0.03, alongZ ? len - 0.1 : 0.09, 1), M.lamp, x, y - 0.015, z, { cast: false }); }
function roomLight(x, y, z, power = 14, dist = 11, col = 0xffe2bd) { if (settings.quality === 'fast') return; const l = new THREE.PointLight(col, power, dist, 2); l.position.set(x, y, z); scene.add(l); }
function furnish() {
  const I = intMats();
  // ---- central warehouse: CARGO. Pallet racking, shrink-wrapped pallets, a forklift
  rack(6.25, -2.6, 3, 3.4, 4); wrappedPallet(3.4, -4.0, 1.3); wrappedPallet(4.75, -4.0, 0.9); forklift(4.6, 3.3, 3);
  for (const x of [-3, 3]) tube(x, 5.9, 0, false, 2.2);
  wallArt(-3.6, 2.2, -4.69, 0, 1.8, 1.2, I.board);
  // ---- guard hut: SECURITY OFFICE with a camera wall
  desk(-27.38, 19, 1, 1); cabinet(-27.7, 20.12, 1); wallArt(-25.4, 1.6, 20.44, 2, 1.5, 1.1, I.chart); tube(-26, 2.82, 19, true, 1.2); roomLight(-26, 2.4, 19, 6, 6);
  // ---- gate office: DISPATCH. Desk with the cargo manifest, lockers, radio
  desk(44.62, 33.5, 1, 2); cabinet(44.3, 35.15, 1); radioRack(47.45, 35.1, 2); wallArt(46, 1.7, 35.29, 2, 1.6, 1.1, I.board); tube(46, 2.72, 33.5, true, 1.2); roomLight(46, 2.3, 33.5, 6, 6);
  // ---- harbour master's hut on the pier: radar, chart of the harbour
  desk(49.3, -27.5, 2, 0); wallArt(47.95, 1.55, -28.5, 1, 1.5, 1.1, I.chart); tube(49.5, 2.52, -28.5, false, 1.2);
  // ---- taverna: bottles behind the counter, stools, amphorae
  for (let l = 0; l < 3; l++) { addBox(-27.4, 1.25 + l * 0.42, 34.36, 2.3, 0.04, 0.26, M.wood, { collide: false, s: 1 }); for (let b = 0; b < 9; b++) { const bx = -28.4 + b * 0.25 + SR(-0.03, 0.03); place(cyl(0.04, 0.22, 8), sr() < 0.6 ? I.glassG : I.terra, bx, 1.4 + l * 0.42, 34.36, { cast: false }); place(cyl(0.015, 0.1, 6), I.glassG, bx, 1.55 + l * 0.42, 34.36, { cast: false }); } }
  for (const [tx, tz] of [[-33.5, 29.5], [-28.5, 29.8]]) for (const [dx, dz] of [[0.85, 0], [-0.85, 0], [0, 0.85]]) { place(cyl(0.17, 0.04, 12), M.wood, tx + dx, 0.46, tz + dz); for (const a of [0, 2.1, 4.2]) place(cyl(0.018, 0.46, 6), M.wood, tx + dx + Math.cos(a) * 0.11, 0.23, tz + dz + Math.sin(a) * 0.11, { cast: false }); }
  amphora(-34.3, 28.0, 0, 1.05); amphora(-33.7, 27.9, 0, 0.85); wallArt(-29, 1.9, 27.81, 0, 1.2, 0.8, I.board); roomLight(-28.5, 2.7, 31, 9, 9, 0xffc98a);
  // ---- barracks, upstairs: OPERATIONS ROOM. Two desks, a chart table, radio rack, wall chart
  desk(27.0, 28.0, 0, 3, 3.2); desk(30.4, 28.0, 0, 2, 3.2); radioRack(33.35, 32.3, 3, 3.2); cabinet(33.4, 31.3, 3, 3.2);
  addBox(27.6, 3.2, 31.2, 1.9, 0.8, 1.2, M.olive, { s: 1 }); { const m = place(new THREE.PlaneGeometry(1.8, 1.1).rotateX(-Math.PI / 2), I.chart, 27.6, 4.012, 31.2, { cast: false }); m.receiveShadow = true; }
  place(new THREE.PlaneGeometry(2.2, 1.5), I.chart, 22.62, 4.9, 29.7, { ry: Math.PI / 2, cast: false }); for (const x of [26, 30]) tube(x, 6.34, 30, false, 1.6); roomLight(28, 5.7, 30.5, 12, 10); roomLight(27, 2.5, 30.5, 8, 9, 0xffd0a0);
  lockers(23.6, 32.1, 0, 3, 3.2);
  // ---- boathouse: WORKSHOP. Tool wall, outboard on a stand, fuel cans, life rings
  place(new THREE.PlaneGeometry(2.4, 1.2), I.peg, 41.17, 1.75, -2.5, { ry: -Math.PI / 2, cast: false });
  addBox(40.6, 0, 0.3, 0.5, 0.9, 0.5, M.steel, { s: 1 }); addBox(40.6, 0.9, 0.3, 0.42, 0.5, 0.34, I.dark, { collide: false }); addBox(40.6, 0.25, 0.02, 0.1, 0.7, 0.1, M.steelLight, { collide: false }); place(cyl(0.14, 0.03, 10), M.steelLight, 40.6, 0.25, -0.05, { rx: Math.PI / 2, cast: false });
  for (const [jx, jz] of [[34.25, -3.4], [34.25, -3.95], [34.7, -3.6]]) { addBox(jx, 0, jz, 0.34, 0.46, 0.18, I.jerry, { s: 1, collide: false }); addBox(jx + 0.1, 0.46, jz, 0.07, 0.05, 0.07, I.dark, { collide: false }); } addCollider(34.05, 0, -4.1, 34.9, 0.5, -3.25);
  for (const z of [-5.6, -1.2]) { place(new THREE.TorusGeometry(0.34, 0.085, 10, 22), I.ring, 33.9, 1.9, z, { ry: Math.PI / 2, cast: false }); for (const a of [0, 1.57, 3.14, 4.71]) place(new THREE.TorusGeometry(0.34, 0.09, 6, 4, 0.5), I.white, 33.9, 1.9, z, { ry: Math.PI / 2, rx: a, cast: false }); }
  cabinet(34.2, 3.8, 1); wallArt(36.4, 1.7, 4.19, 2, 1.5, 1.1, I.chart); for (const z of [-8, -1]) tube(37.5, 4.5, z, true, 2.0); roomLight(37.5, 4.0, -4, 16, 13);
  // ---- old stone storehouse: SUPPLIES. Amphorae, a rack of olive-oil tins
  amphora(-40.0, 9.2, 0, 1.1); amphora(-40.05, 8.45, 0, 0.9); amphora(-39.5, 8.8, 0, 0.75); rack(-34.95, 9.4, 3, 2.4, 2, 0.7, 'tins'); roomLight(-37.5, 2.8, 10, 8, 8, 0xffc98a);
  // ---- transit shed on the dock: CARGO HALL with racking and a forklift, and a shipping office in the back corner
  rack(57.2, 34.4, 2, 4.4, 4, 1.0); forklift(63.2, 29.6, 2); wrappedPallet(55.4, 31.2, 1.4); wrappedPallet(63.6, 21.2, 1.1);
  desk(65.9, 34.3, 2, 2); cabinet(68.3, 34.5, 2); cabinet(67.75, 34.5, 2); wallArt(66.2, 2.0, 34.94, 2, 2.2, 1.4, I.chart);
  for (const x of [58, 65]) for (const z of [24, 31]) tube(x, 7.1, z, true, 2.4); roomLight(61.5, 6.3, 27.5, 22, 17);
}

// ======================================================= PHYSICS
function collideCircle(pos, r, feetY, headY) {
  for (const c of colliders) {
    if (c.off || c.max[1] <= feetY + STEP || c.min[1] >= headY) continue;
    const cx = clamp(pos.x, c.min[0], c.max[0]), cz = clamp(pos.z, c.min[2], c.max[2]);
    const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-10) { const d = Math.sqrt(d2), k = (r - d) / d; pos.x += dx * k; pos.z += dz * k; }
    else {
      const l = pos.x - c.min[0], rr = c.max[0] - pos.x, b = pos.z - c.min[2], f = c.max[2] - pos.z, m = Math.min(l, rr, b, f);
      if (m === l) pos.x = c.min[0] - r; else if (m === rr) pos.x = c.max[0] + r; else if (m === b) pos.z = c.min[2] - r; else pos.z = c.max[2] + r;
    }
  }
}
function groundAt(x, z, r, feetY) {
  let g = -12; const rr = r * 0.75; // land is a collider; off it you drop into the sea
  for (const c of colliders) {
    const top = c.max[1];
    if (c.off || top > feetY + STEP || top <= g) continue;
    if (x + rr > c.min[0] && x - rr < c.max[0] && z + rr > c.min[2] && z - rr < c.max[2]) g = top;
  }
  return g;
}
function ceilingAt(x, z, r, headY) {
  let cl = 1e9; const rr = r * 0.75;
  for (const c of colliders) { const b = c.min[1]; if (c.off || b < headY - 0.6 || b >= cl) continue; if (x + rr > c.min[0] && x - rr < c.max[0] && z + rr > c.min[2] && z - rr < c.max[2]) cl = b; }
  return cl;
}
// Ray vs world. Returns {t, n:[nx,ny,nz], water}
function rayWorld(o, d, maxT) {
  let best = maxT, bn = null, water = false;
  if (d.y < 0) { const t = -o.y / d.y; if (t < best && t > 0 && isLand(o.x + d.x * t, o.z + d.z * t)) { best = t; bn = [0, 1, 0]; } const tw = (-1.9 - o.y) / d.y; if (tw < best && tw > 0 && !isLand(o.x + d.x * tw, o.z + d.z * tw)) { best = tw; bn = [0, 1, 0]; water = true; } }
  const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
  for (const c of colliders) {
    if (c.noRay || c.off) continue;
    let tmin = 0, tmax = best, ax = -1, sg = 0, miss = false;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(D[a]) < 1e-9) { if (O[a] < c.min[a] || O[a] > c.max[a]) { miss = true; break; } continue; }
      let t1 = (c.min[a] - O[a]) / D[a], t2 = (c.max[a] - O[a]) / D[a], s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; ax = a; sg = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { miss = true; break; }
    }
    if (!miss && ax >= 0 && tmin < best) { best = tmin; bn = [0, 0, 0]; bn[ax] = sg; water = false; }
  }
  return bn ? { t: best, n: bn, water } : null;
}
const losBlocked = (a, b) => { const d = b.clone().sub(a); const L = d.length(); d.divideScalar(L); const h = rayWorld(a, d, L - 0.05); return !!h; };

// ======================================================= EFFECTS
class Particles {
  constructor(max, geo, mat) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max); this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color(); for (let i = 0; i < max; i++) this.mesh.setColorAt(i, c);
    this.p = []; this.max = max; scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new V3(); this._z = new V3(0, 0, 1); this._v = new V3();
  }
  spawn(pos, vel, life, size, color, grav = 9.8, stretch = false, drag = 0) {
    if (this.p.length >= this.max) this.p.shift();
    this.p.push({ pos: pos.clone(), vel: vel.clone(), life, max: life, size, color: color.clone ? color.clone() : new THREE.Color(color), grav, stretch, drag });
  }
  update(dt) {
    let n = 0;
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i]; q.life -= dt; if (q.life <= 0) { this.p.splice(i, 1); continue; }
      q.vel.y -= q.grav * dt; if (q.drag) q.vel.multiplyScalar(1 - q.drag * dt); q.pos.addScaledVector(q.vel, dt);
      if (q.pos.y < 0.01 && isLand(q.pos.x, q.pos.z)) { q.pos.y = 0.01; q.vel.y *= -0.3; q.vel.x *= 0.6; q.vel.z *= 0.6; }
    }
    for (const q of this.p) {
      const k = q.life / q.max;
      if (q.stretch) { this._v.copy(q.vel).normalize(); this._q.setFromUnitVectors(this._z, this._v); this._s.set(q.size, q.size, q.size * 6 * (0.3 + k)); }
      else { this._q.identity(); const s = q.size * (q.grow ? (1.6 - k) : (0.3 + 0.7 * k)); this._s.set(s, s, s); }
      this._m.compose(q.pos, this._q, this._s); this.mesh.setMatrixAt(n, this._m); this.mesh.setColorAt(n, q.color); n++;
    }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
const sparks = new Particles(300, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
const debris = new Particles(400, new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 1 }));
const smoke = new Particles(280, new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, opacity: 0.22, depthWrite: false }));

// tracers
const tracers = [];
const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5, 2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
for (let i = 0; i < 40; i++) { const m = new THREE.Mesh(tracerGeo, tracerMat); m.visible = false; m.frustumCulled = false; scene.add(m); tracers.push({ m, a: new V3(), b: new V3(), t: 0, len: 0 }); }
let tracerIdx = 0;
function tracer(a, b, w = 0.022) {
  const tr = tracers[tracerIdx++ % tracers.length]; tr.a.copy(a); tr.b.copy(b); tr.len = a.distanceTo(b); tr.t = 0; tr.m.visible = true; tr.w = w;
}
function updateTracers(dt) {
  for (const tr of tracers) {
    if (!tr.m.visible) continue; tr.t += dt * 420;
    const head = Math.min(tr.t, tr.len), tail = Math.max(0, tr.t - 5); if (tail >= tr.len) { tr.m.visible = false; continue; }
    const d = tr.b.clone().sub(tr.a).normalize();
    const p0 = tr.a.clone().addScaledVector(d, tail), p1 = tr.a.clone().addScaledVector(d, head);
    tr.m.position.copy(p0).add(p1).multiplyScalar(0.5); tr.m.lookAt(p1); tr.m.scale.set(tr.w, tr.w, Math.max(0.01, head - tail));
  }
}
// bullet holes
const HOLES = 150;
const holeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 0.13), new THREE.MeshStandardMaterial({ map: T.hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 }), HOLES);
{ const z = new THREE.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < HOLES; i++) holeMesh.setMatrixAt(i, z); }
holeMesh.frustumCulled = false; scene.add(holeMesh);
let holeIdx = 0; const _hm = new THREE.Object3D();
function addHole(p, n) {
  _hm.position.copy(p).addScaledVector(n, 0.012); _hm.lookAt(p.clone().add(n)); _hm.rotateZ(Math.random() * 6); const s = R(0.8, 1.3); _hm.scale.set(s, s, s); _hm.updateMatrix();
  holeMesh.setMatrixAt(holeIdx++ % HOLES, _hm.matrix); holeMesh.instanceMatrix.needsUpdate = true;
}
// world flash light pool (fixed count avoids shader recompiles)
const flashLights = [];
for (let i = 0; i < 2; i++) { const l = new THREE.PointLight(0xffa860, 0, 14, 2); scene.add(l); flashLights.push({ l, t: 0 }); }
let flashIdx = 0;
function worldFlash(p, power = 60) { const f = flashLights[flashIdx++ % flashLights.length]; f.l.position.copy(p); f.l.intensity = power; f.t = 0.05; }
function impact(p, n, water, strong = 1) {
  const N = new V3(...n);
  if (water) {
    const sp = p.clone(); sp.y = SEA_Y + 0.02;
    for (let i = 0; i < 18; i++) debris.spawn(sp, new V3(R(-0.8, 0.8), R(2.5, 5.5), R(-0.8, 0.8)), R(0.35, 0.7), R(0.02, 0.05), new THREE.Color(0xdcecf2), 12);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; debris.spawn(sp, new V3(Math.cos(a) * 1.6, R(0.8, 1.6), Math.sin(a) * 1.6), R(0.25, 0.4), R(0.03, 0.05), new THREE.Color(0xeaf4f8), 9.8); }
    return;
  }
  for (let i = 0; i < 7 * strong; i++) sparks.spawn(p, N.clone().multiplyScalar(R(2, 6)).add(new V3(R(-3, 3), R(-1, 4), R(-3, 3))), R(0.08, 0.25), 0.012, new THREE.Color(R(6, 9), R(3, 5), 1), 9.8, true);
  for (let i = 0; i < 6; i++) debris.spawn(p, N.clone().multiplyScalar(R(1, 3)).add(new V3(R(-1.5, 1.5), R(0, 3), R(-1.5, 1.5))), R(0.4, 1.0), R(0.01, 0.025), new THREE.Color(0x4a4640), 9.8);
  for (let i = 0; i < 3; i++) { smoke.spawn(p.clone().addScaledVector(N, 0.1), N.clone().multiplyScalar(R(0.3, 0.9)).add(new V3(R(-.3, .3), R(.1, .5), R(-.3, .3))), R(0.3, 0.55), R(0.07, 0.14), new THREE.Color(0x9a8f86), -0.2, false, 2.5); smoke.p[smoke.p.length - 1].grow = true; }
  addHole(p, N);
}
function bloodPuff(p, dir) {
  for (let i = 0; i < 10; i++) debris.spawn(p, dir.clone().multiplyScalar(R(1, 3)).add(new V3(R(-1, 1), R(-0.5, 1.5), R(-1, 1))), R(0.3, 0.6), R(0.015, 0.035), new THREE.Color(0x5a0a08), 9.8);
  for (let i = 0; i < 3; i++) { smoke.spawn(p, dir.clone().multiplyScalar(R(0.4, 1)), R(0.25, 0.45), R(0.1, 0.16), new THREE.Color(0x6a1410), 0, false, 2); smoke.p[smoke.p.length - 1].grow = true; }
}

// ======================================================= AUDIO
let AC = null, master = null, masterGain = null, noiseBuf = null;
function initAudio() {
  if (AC) { AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createDynamicsCompressor(); master.threshold.value = -12; master.ratio.value = 6;
    const g = masterGain = AC.createGain(); g.gain.value = settings.vol; master.connect(g); g.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    ambient();
  } catch (e) { AC = null; }
}
function out(pan = 0, gain = 1) {
  const g = AC.createGain(); g.gain.value = gain;
  if (AC.createStereoPanner) { const p = AC.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); p.connect(master); } else g.connect(master);
  return g;
}
function noiseHit(dest, { t0 = 0, dur = 0.2, type = 'lowpass', f = 2000, q = 0.7, g = 1, decay = 0.08 }) {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = R(0.9, 1.1);
  const fl = AC.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  const e = AC.createGain(); const t = AC.currentTime + t0;
  e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  s.connect(fl); fl.connect(e); e.connect(dest); s.start(t, Math.random()); s.stop(t + dur + 0.05);
}
function tone(dest, { t0 = 0, f0 = 120, f1 = 40, dur = 0.15, g = 1, type = 'sine' }) {
  const o = AC.createOscillator(); o.type = type; const e = AC.createGain(); const t = AC.currentTime + t0;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(e); e.connect(dest); o.start(t); o.stop(t + dur + 0.05);
}
function spatial(pos) {
  if (!pos) return { pan: 0, gain: 1, dist: 0 };
  const rel = pos.clone().sub(camera.position); const dist = rel.length();
  const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y));
  const pan = dist > 0.1 ? rel.normalize().dot(right) * 0.85 : 0;
  return { pan, gain: 1 / (1 + dist / 9), dist };
}
// Every shot is synthesized fresh with random pitch, tone and layer balance. Far shots arrive late
// (speed of sound) and duller; indoors gets a short slap-back room, outdoors a long tail with echoes off the hills.
const SFX = {
  shot(w, pos, o = {}) {
    if (!AC) return; const s = spatial(pos); const supp = !!o.supp;
    const delay = pos ? Math.min(0.5, s.dist / 343) : 0, farK = clamp(s.dist / 120, 0, 1);
    const out1 = out(s.pan, s.gain * (pos ? 1.25 : 1) * (supp ? 0.45 : 1));
    const p = (w === 0 ? 0.74 : w === 1 ? 0.62 : w === 2 ? 0.7 : 1.02) * R(0.94, 1.06), air = 1 - farK * 0.7, big = w === 1 || w === 2;
    if (!supp) noiseHit(out1, { t0: delay, dur: R(0.07, 0.11), type: 'bandpass', f: 2600 * p * air * R(0.88, 1.12), q: R(0.5, 0.8), g: R(0.85, 1.1) });
    noiseHit(out1, { t0: delay, dur: 0.32 * (big ? 1.7 : w === 0 ? 1.25 : 1) * R(0.85, 1.15), type: 'lowpass', f: (supp ? 700 : 1300) * p * air * R(0.85, 1.15), g: R(0.75, 1.0) });
    tone(out1, { t0: delay, f0: 150 * p * R(0.9, 1.1), f1: R(38, 52), dur: 0.16 * (big ? 1.6 : w === 0 ? 1.3 : 1) * R(0.85, 1.15), g: R(0.75, 1.0) });
    if (w < 3 && !supp) tone(out1, { t0: delay, f0: R(70, 85) * (big ? 0.85 : 1), f1: 30, dur: big ? 0.3 : 0.2, g: (big ? 0.9 : 0.7) * (1 - farK * 0.5) }); // chest thump
    if (w === 0 && !supp) { // belt-fed weight: a deep kick, the bolt slamming home, and a metallic ring off the receiver
      tone(out1, { t0: delay, f0: R(58, 66), f1: 26, dur: 0.26, g: 1.0 * (1 - farK * 0.5) });
      noiseHit(out1, { t0: delay + R(0.024, 0.034), dur: 0.05, type: 'bandpass', f: R(950, 1350), q: 4, g: 0.55 * air });
      tone(out1, { t0: delay + 0.01, f0: R(2100, 2500), f1: R(1700, 1900), dur: 0.09, g: 0.07 * air, type: 'triangle' });
    }
    if (w === 3) { // heavy pistol: a hard crack over a fat low punch
      tone(out1, { t0: delay, f0: R(105, 125), f1: 36, dur: 0.2, g: 1.0 * (1 - farK * 0.5) });
      noiseHit(out1, { t0: delay, dur: 0.045, type: 'highpass', f: R(3800, 4800), g: 0.6 * air });
      noiseHit(out1, { t0: delay + 0.012, dur: 0.14, type: 'bandpass', f: R(700, 950), q: 1.2, g: 0.6 });
    }
    if (!pos) { // close-up mechanics: bolt carrier and a little high-end snap
      noiseHit(out1, { t0: R(0.008, 0.02), dur: 0.035, type: 'bandpass', f: R(2600, 3800), q: 3, g: R(0.18, 0.3) });
      noiseHit(out1, { dur: 0.03, type: 'highpass', f: 5000, g: R(0.18, 0.3) });
    }
    if (o.indoor) { // room: short dense reflections, boomy
      for (let i = 0; i < 3; i++) noiseHit(out1, { t0: delay + R(0.012, 0.05) * (i + 1), dur: R(0.12, 0.22), type: 'lowpass', f: R(900, 1600), g: R(0.18, 0.3) });
    } else { // outdoors: rolling tail plus a couple of echoes off the village and hills
      noiseHit(out1, { t0: delay + 0.04, dur: R(0.8, 1.3) + s.dist / 40, type: 'lowpass', f: R(450, 700), g: (0.16 + s.dist / 120) * R(0.8, 1.2) });
      const n = 1 + (Math.random() < 0.6 ? 1 : 0) + (Math.random() < 0.3 ? 1 : 0);
      for (let i = 0; i < n; i++) noiseHit(out(s.pan * -0.5, s.gain * 0.5), { t0: delay + R(0.12, 0.5), dur: R(0.18, 0.35), type: 'lowpass', f: R(350, 650), g: R(0.08, 0.16) });
      if (!supp) for (const wl of echoWalls()) { // the crack slaps back off the nearest walls, later and duller the further they are
        const eo = out(wl.pan * 0.85, (pos ? s.gain * 1.25 : 1) * 0.6 / (1 + wl.d / 16)), t0 = delay + 2 * wl.d / 343;
        noiseHit(eo, { t0, dur: R(0.09, 0.16), type: 'bandpass', f: R(900, 1500) * p, q: 0.8, g: R(0.5, 0.8) }); noiseHit(eo, { t0: t0 + 0.01, dur: R(0.2, 0.3), type: 'lowpass', f: R(500, 800), g: R(0.25, 0.4) });
      }
    }
  },
  hitmarker(head) { if (!AC) return; const o = out(0, 0.5); tone(o, { f0: head ? 2400 : 1500, f1: head ? 2200 : 1300, dur: 0.07, g: 0.5, type: 'triangle' }); },
  boom(pos, big = 1) { if (!AC) return; const s = spatial(pos); const delay = pos ? Math.min(1.5, s.dist / 343) : 0; const o = out(s.pan, Math.min(2.2, s.gain * 3 * big + 0.15));
    noiseHit(o, { t0: delay, dur: 1.6 * big, type: 'lowpass', f: R(380, 520), g: 1.2 }); tone(o, { t0: delay, f0: 90, f1: 24, dur: 0.9, g: 1.1 }); noiseHit(o, { t0: delay, dur: 0.12, type: 'bandpass', f: 1600, q: 0.7, g: 0.8 });
    for (let i = 0; i < 3; i++) noiseHit(o, { t0: delay + R(0.25, 0.9) * (i + 1), dur: R(0.4, 0.8), type: 'lowpass', f: R(250, 400), g: R(0.15, 0.3) }); },
  alarm() { if (!AC) return; const o = out(0, 0.35); for (let i = 0; i < 4; i++) { tone(o, { t0: i * 0.42, f0: 880, f1: 880, dur: 0.18, g: 0.5, type: 'square' }); tone(o, { t0: i * 0.42 + 0.2, f0: 660, f1: 660, dur: 0.18, g: 0.5, type: 'square' }); } },
  kill() { if (!AC) return; const o = out(0, 0.5); tone(o, { f0: 900, f1: 880, dur: 0.12, g: 0.5, type: 'square' }); tone(o, { t0: 0.09, f0: 1350, f1: 1320, dur: 0.18, g: 0.4, type: 'square' }); },
  thud(k = 1) { if (!AC) return; const o = out(0, 0.9); tone(o, { f0: 70, f1: 32, dur: 0.28, g: 0.9 * Math.min(1.4, k) }); noiseHit(o, { dur: 0.09, type: 'lowpass', f: 380, g: 0.9 }); noiseHit(o, { t0: 0.01, dur: 0.05, type: 'bandpass', f: 1800, q: 1.2, g: 0.35 }); },
  hurt() { if (!AC) return; const o = out(0, 0.8); tone(o, { f0: R(80, 100), f1: 40, dur: 0.18, g: 1 }); noiseHit(o, { dur: 0.12, f: R(700, 1100), g: 0.5 }); },
  ir(on) { if (!AC) return; const o = out(0, 0.35); tone(o, { f0: on ? 700 : 1500, f1: on ? 1900 : 500, dur: 0.11, g: 0.4, type: 'square' }); noiseHit(o, { t0: 0.02, dur: on ? 0.25 : 0.08, type: 'highpass', f: 6000, g: 0.12 }); },
  lock(k) { if (!AC) return; const o = out(0, 0.3 + 0.25 * k); tone(o, { f0: 1500 + 900 * k, f1: 1500 + 900 * k, dur: 0.055, g: 0.5, type: 'square' }); },
  cannon(pos) { if (!AC) return; const s = spatial(pos), d = Math.min(0.5, s.dist / 343), o = out(s.pan, Math.min(2.2, s.gain * 3.2 + 0.2)); tone(o, { t0: d, f0: R(95, 120), f1: 28, dur: 0.22, g: 1.1 }); noiseHit(o, { t0: d, dur: 0.2, type: 'lowpass', f: R(800, 1100), g: 1.0 }); noiseHit(o, { t0: d, dur: 0.05, type: 'bandpass', f: 2400, q: 0.8, g: 0.7 }); noiseHit(o, { t0: d + 0.06, dur: 0.5, type: 'lowpass', f: 420, g: 0.35 }); },
  whistle(dur) { if (!AC) return; const o = out(R(-0.4, 0.4), 0.5), t = AC.currentTime, os = AC.createOscillator(), e = AC.createGain(); os.type = 'sine'; os.frequency.setValueAtTime(2700, t); os.frequency.exponentialRampToValueAtTime(620, t + dur); e.gain.setValueAtTime(0.0008, t); e.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.92); e.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.05); os.connect(e); e.connect(o); os.start(t); os.stop(t + dur + 0.1); noiseHit(o, { t0: dur * 0.35, dur: dur * 0.65, type: 'bandpass', f: 1800, q: 2, g: 0.25 }); },
  brrt(pos, dur = 0.7) { if (!AC) return; const s = spatial(pos), d = Math.min(0.6, s.dist / 343), o = out(s.pan, Math.min(2, s.gain * 4 + 0.25)), t = AC.currentTime + d, os = AC.createOscillator(), e = AC.createGain(); os.type = 'sawtooth'; os.frequency.setValueAtTime(R(64, 72), t); e.gain.setValueAtTime(0.9, t); e.gain.setValueAtTime(0.9, t + dur); e.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.25); os.connect(e); e.connect(o); os.start(t); os.stop(t + dur + 0.3); noiseHit(o, { t0: d, dur: dur + 0.5, type: 'lowpass', f: 1500, g: 0.8 }); noiseHit(o, { t0: d + dur, dur: 1.4, type: 'lowpass', f: 380, g: 0.3 }); },
  klaxon(pos) { if (!AC) return; const s = spatial(pos), o = out(s.pan, Math.min(1.2, s.gain * 5 + 0.3)); for (let i = 0; i < 3; i++) { tone(o, { t0: i * 0.75, f0: 233, f1: 228, dur: 0.55, g: 0.5, type: 'sawtooth' }); tone(o, { t0: i * 0.75, f0: 311, f1: 305, dur: 0.55, g: 0.35, type: 'square' }); } },
  thump() { if (!AC) return; const o = out(0, 1.0); tone(o, { f0: 170, f1: 45, dur: 0.2, g: 1.1 }); noiseHit(o, { dur: 0.16, type: 'lowpass', f: 700, g: 0.9 }); noiseHit(o, { t0: 0.02, dur: 0.05, type: 'bandpass', f: 1900, q: 2, g: 0.4 }); },
  bang(pos) { if (!AC) return; const s = spatial(pos), d = Math.min(0.4, s.dist / 343), o = out(s.pan, Math.min(2.4, s.gain * 4 + 0.2)); noiseHit(o, { t0: d, dur: 0.09, type: 'highpass', f: 2500, g: 1.4 }); noiseHit(o, { t0: d, dur: 0.5, type: 'lowpass', f: 1500, g: 1.0 }); tone(o, { t0: d, f0: 220, f1: 50, dur: 0.25, g: 0.9 }); },
  ring(dur, g) { if (!AC) return; const os = AC.createOscillator(), e = AC.createGain(), t = AC.currentTime; os.frequency.value = R(3600, 4100); e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.0008, t + dur); os.connect(e); e.connect(AC.destination); os.start(t); os.stop(t + dur + 0.05); },
  slide() { if (!AC) return; const o = out(0, 0.5); noiseHit(o, { dur: 0.55, type: 'bandpass', f: R(600, 900), q: 0.7, g: 0.8 }); noiseHit(o, { dur: 0.3, type: 'highpass', f: 3500, g: 0.15 }); },
  blip() { if (!AC) return; const o = out(0, 0.25); tone(o, { f0: 1250, f1: 1700, dur: 0.06, g: 0.4, type: 'triangle' }); },
  crack(pos) { if (!AC) return; const s = spatial(pos); const o = out(s.pan, 0.5); noiseHit(o, { dur: R(0.04, 0.06), type: 'highpass', f: R(2600, 3600), g: 0.6 }); },
  click() { if (!AC) return; const o = out(0, 0.4); noiseHit(o, { dur: 0.025, type: 'highpass', f: R(3000, 4000), g: 0.6 }); },
  tinkle() { if (!AC) return; const o = out(R(-0.3, 0.3), 0.22); const n = 2 + (Math.random() * 2 | 0); for (let i = 0; i < n; i++) { const t0 = i * R(0.05, 0.12); tone(o, { t0, f0: R(3800, 6500), f1: R(3500, 6000), dur: R(0.03, 0.07), g: R(0.2, 0.45) / (i + 1), type: 'triangle' }); } },
  mech(kind, pos) { // reload and handling sounds, never quite the same twice
    if (!AC) return; const s = spatial(pos); const o = out(pos ? s.pan : R(0.05, 0.3), (pos ? s.gain * 1.2 : 0.55) * R(0.85, 1.15));
    const nh = (t0, dur, f, q, g, type = 'bandpass') => noiseHit(o, { t0, dur, type, f: f * R(0.88, 1.12), q, g });
    if (kind === 'magout') { nh(0, 0.05, 2200, 3, 0.6); nh(R(0.03, 0.05), 0.09, 900, 1.5, 0.4); }
    else if (kind === 'drop') { nh(0, 0.07, 700, 1.2, 0.7); nh(R(0.08, 0.14), 0.05, 1500, 2, 0.35); }
    else if (kind === 'pouch') { nh(0, R(0.12, 0.2), 1800, 0.6, 0.25, 'highpass'); nh(R(0.05, 0.1), 0.08, 600, 0.8, 0.3); }
    else if (kind === 'magin') { nh(0, 0.04, 1600, 2.5, 0.6); nh(R(0.04, 0.07), 0.05, 3200, 4, 0.7); tone(o, { t0: 0.05, f0: R(600, 800), f1: 300, dur: 0.04, g: 0.2, type: 'square' }); }
    else if (kind === 'slap') { nh(0, 0.05, 1200, 1.5, 0.9); nh(0.01, 0.04, 3400, 4, 0.5); }
    else if (kind === 'charge') { nh(0, 0.05, 2500, 3, 0.7); nh(R(0.12, 0.18), 0.06, 2900, 3.5, 0.9); tone(o, { t0: 0.14, f0: R(700, 900), f1: 350, dur: 0.05, g: 0.25, type: 'square' }); }
    else if (kind === 'boltup') { nh(0, 0.04, 2000, 3, 0.6); tone(o, { t0: 0.01, f0: R(500, 650), f1: 300, dur: 0.04, g: 0.18, type: 'square' }); }
    else if (kind === 'boltback') { nh(0, 0.08, 3000, 2.5, 0.8); nh(0.05, 0.05, 1200, 2, 0.4); }
    else if (kind === 'boltfwd') { nh(0, 0.06, 2600, 3, 0.8); tone(o, { t0: 0.04, f0: R(800, 950), f1: 380, dur: 0.05, g: 0.28, type: 'square' }); }
    else if (kind === 'pumpback') { nh(0, 0.07, 1500, 2, 0.9); nh(0.03, 0.06, 3200, 3, 0.5); }
    else if (kind === 'pumpfwd') { nh(0, 0.06, 1800, 2.5, 1.0); tone(o, { t0: 0.03, f0: R(500, 600), f1: 240, dur: 0.05, g: 0.3, type: 'square' }); }
    else if (kind === 'shell') { nh(0, 0.05, 1300, 2, 0.6); nh(R(0.03, 0.05), 0.04, 2600, 3, 0.45); }
    else if (kind === 'slide') { nh(0, 0.06, 2800, 3, 0.9); tone(o, { t0: 0.01, f0: R(800, 1000), f1: 400, dur: 0.05, g: 0.25, type: 'square' }); }
  },
  reload(step) { this.mech(step ? 'magin' : 'magout'); },
  step(pos, loud = 1, surf = 'dirt') { // boots on steel ring, on boards they knock, on stone they click, on dirt they crunch
    if (!AC) return; const s = spatial(pos); const o = out(s.pan, s.gain * loud * (pos ? 1.6 : 0.5) * R(0.8, 1.15));
    if (surf === 'metal') { noiseHit(o, { dur: R(0.05, 0.08), type: 'bandpass', f: R(1700, 2500), q: 3, g: 0.75 }); tone(o, { f0: R(480, 600), f1: R(430, 470), dur: R(0.1, 0.16), g: 0.2, type: 'triangle' }); tone(o, { f0: 120, f1: 60, dur: 0.07, g: 0.35 }); }
    else if (surf === 'wood') { noiseHit(o, { dur: R(0.06, 0.09), type: 'lowpass', f: R(480, 700), g: 0.9 }); tone(o, { f0: R(150, 190), f1: R(95, 115), dur: 0.09, g: 0.5 }); if (Math.random() < 0.15) tone(o, { t0: 0.02, f0: R(500, 800), f1: R(420, 480), dur: 0.12, g: 0.05, type: 'sawtooth' }); }
    else if (surf === 'stone') { noiseHit(o, { dur: R(0.04, 0.06), type: 'bandpass', f: R(1000, 1500), q: 1.6, g: 0.8 }); noiseHit(o, { t0: 0.005, dur: 0.03, type: 'highpass', f: 3600, g: 0.2 }); tone(o, { f0: R(90, 110), f1: 55, dur: 0.05, g: 0.3 }); }
    else { noiseHit(o, { dur: R(0.07, 0.11), type: 'bandpass', f: R(450, 850), q: R(0.9, 1.5), g: 0.8 }); tone(o, { f0: R(80, 100), f1: 50, dur: 0.06, g: 0.3 }); if (Math.random() < 0.3) noiseHit(o, { t0: 0.03, dur: 0.05, type: 'highpass', f: 3000, g: 0.12 }); }
  },
  land() { if (!AC) return; const o = out(0, 0.5); noiseHit(o, { dur: 0.15, f: 500, g: 0.9 }); },
  ammo() { if (!AC) return; const o = out(0, 0.5); for (let i = 0; i < 3; i++) noiseHit(o, { t0: i * R(0.05, 0.09), dur: 0.05, type: 'bandpass', f: R(2600, 3400), q: 3, g: 0.6 }); }
};
function ambient() {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
  const g = AC.createGain(); g.gain.value = 0.06;
  const lfo = AC.createOscillator(); lfo.frequency.value = 0.09; const lg = AC.createGain(); lg.gain.value = 0.045; lfo.connect(lg); lg.connect(g.gain); lfo.start();
  const sea = AMB.sea = AC.createGain(); sea.gain.value = 1; sea.connect(master);
  s.connect(f); f.connect(g); g.connect(sea); s.start();
  const s2 = AC.createBufferSource(); s2.buffer = noiseBuf; s2.loop = true; const f2 = AC.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1800; f2.Q.value = 0.3; const g2 = AC.createGain(); g2.gain.value = 0.008; s2.connect(f2); f2.connect(g2); g2.connect(sea); s2.start();
}

// ======================================================= WEAPONS
// Recoil, cadence and reloads vary shot to shot: kick strength, drift, muzzle flip, flash, sound and reload timing all jitter.
// Camera recoil and the viewmodel run on damped springs, so kicks rise and settle smoothly instead of snapping.
const WEAPONS = [
  { name: 'Machine gun', mag: 120, reserve: 360, rpm: 640, auto: true, dmg: 28, head: 2.0, hip: 0.045, ads: 0.0055, kickV: 0.0135, kickH: 0.006, drift: 0.6, first: 1.3, reload: 3.4, reloadEmpty: 4.0, fov: 50, wfov: 40, range: 220, bot: 0.016, heavy: 0.9, shake: 1.0, punch: 0.55, vk: { z: 1.9, rx: 2.9, rz: 1.9, x: 0.5 } },
  { name: 'Sniper rifle', mag: 5, reserve: 25, rpm: 50, auto: false, dmg: 110, head: 2.5, hip: 0.09, ads: 0.0, kickV: 0.05, kickH: 0.01, drift: 0.2, first: 1.0, reload: 2.8, reloadEmpty: 3.3, fov: 6.67, fov2: 16.4, wfov: 30, range: 600, scope: true, bolt: 0.85, botK: 0.5, bot: 0.006, heavy: 0.95, vk: { z: 2.2, rx: 3.4, rz: 1.2, x: 0.3 } },
  { name: 'Shotgun', mag: 7, reserve: 35, rpm: 80, auto: false, dmg: 17, pellets: 9, head: 1.5, hip: 0.06, ads: 0.045, kickV: 0.045, kickH: 0.012, drift: 0.3, first: 1.0, reload: 0.55, reloadEmpty: 0.55, fov: 62, wfov: 44, range: 55, pump: 0.62, botK: 1, bot: 0.03, shake: 1.6, vk: { z: 2.6, rx: 4.2, rz: 1.6, x: 0.4 } },
  { name: 'Sidearm', mag: 14, reserve: 56, rpm: 420, auto: false, dmg: 34, head: 2.0, hip: 0.022, ads: 0.006, kickV: 0.023, kickH: 0.009, drift: 0.3, first: 1.15, reload: 1.5, reloadEmpty: 1.9, fov: 62, wfov: 46, range: 120, bot: 0.02, shake: 0.55, punch: 0.8, vk: { z: 1.4, rx: 5.4, rz: 1.9, x: 0.28 } },
  // the supply-drop power weapon: six 40 mm rounds, no reloads, gone when it is empty or you die
  { name: 'Grenade launcher', mag: 6, reserve: 0, rpm: 72, auto: false, dmg: 0, head: 1, hip: 0.012, ads: 0.004, kickV: 0.05, kickH: 0.012, drift: 0.3, first: 1, reload: 9, reloadEmpty: 9, fov: 58, wfov: 44, range: 120, launch: true, shake: 1.5, punch: 1.6, vk: { z: 3.0, rx: 4.6, rz: 1.5, x: 0.4 } }
];
const LAUNCHER = 4;
const PISTOL = 3;
class Spring { // damped spring; v is kicked by impulses
  constructor(k, zeta) { this.k = k; this.c = 2 * zeta * Math.sqrt(k); this.x = 0; this.v = 0; }
  step(dt) { const n = dt > 0.02 ? 2 : 1, h = dt / n; for (let i = 0; i < n; i++) { this.v += (-this.k * this.x - this.c * this.v) * h; this.x += this.v * h; } return this.x; }
}
const VMS = { z: new Spring(240, 0.72), rx: new Spring(190, 0.66), rz: new Spring(150, 0.55), x: new Spring(210, 0.8), y: new Spring(230, 0.8) };
const smoothK = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function along(k, keys) { // piecewise smooth path: keys = [[k, V3], ...]
  if (k <= keys[0][0]) return keys[0][1].clone();
  for (let i = 0; i < keys.length - 1; i++) { const [k0, a] = keys[i], [k1, b] = keys[i + 1]; if (k <= k1) return a.clone().lerp(b, smoothK((k - k0) / Math.max(1e-4, k1 - k0))); }
  return keys[keys.length - 1][1].clone();
}
const VM = {
  polymer: std({ color: 0x1b1c1e, roughness: 0.62, metalness: 0.15 }),
  metal: std({ color: 0x2a2c2f, roughness: 0.33, metalness: 0.85 }),
  fde: std({ color: 0x8b7556, roughness: 0.7, metalness: 0.05 }),
  glove: std({ color: 0x2c2a25, roughness: 0.92 }),
  sleeve: std({ color: 0x4b4d3a, roughness: 0.95 }),
  lens: std({ color: 0x112a33, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.35 }),
  dot: new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 0.6, 0.4) }),
  brass: std({ color: 0xc8963c, roughness: 0.3, metalness: 1 }),
  copper: std({ color: 0xb5673a, roughness: 0.35, metalness: 1 }),
  bronze: std({ color: 0x9a6a34, roughness: 0.28, metalness: 1 }),
  link: std({ color: 0x17181a, roughness: 0.5, metalness: 0.8 }),
  hot: new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.38, metalness: 0.85, emissive: 0xff4a10, emissiveIntensity: 0 }), // the MG barrel glows as it heats
  fibre: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 6, 0.6) }),
  laser: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 5, 0.5), blending: THREE.AdditiveBlending, transparent: true, opacity: 0.22, depthWrite: false }),
  lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 2.6) }),
  sticker: new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.7 }),
  shell40: std({ color: 0x3f4a2c, roughness: 0.6, metalness: 0.2 })
};
function vbox(parent, w, h, d, mat, x, y, z, rx = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.x = rx; parent.add(m); return m; }
function vcyl(parent, r, len, mat, x, y, z, seg = 16) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2), mat); m.position.set(x, y, z); parent.add(m); return m; }
function limb(parent, a, b, r, mat) { const d = b.clone().sub(a), L = d.length(); const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, L, 12), mat); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize()); parent.add(m); return m; }
function sleeveTo(m, a, b) { const d = b.clone().sub(a), L = d.length(); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize()); m.scale.set(1, L, 1); }
function supportHand(r, at, anchor, gloveDims) { // left hand as its own group so reloads can move it
  const lh = new THREE.Group(); lh.position.copy(at); r.add(lh);
  vbox(lh, ...gloveDims, VM.glove, 0, 0, 0);
  const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.034, 1, 12), VM.sleeve); r.add(sl);
  return { lh, lhBase: at.clone(), sleeve: sl, anchor };
}
function buildViewmodels() {
  const vms = [];
  { // Machine gun: belt-fed. Feed cover that opens on reloads, ammo box with a live belt, heavy barrel that glows when hot,
    // heat shield, three-prong flash hider, folded bipod, carry handle, skeleton stock, holographic sight on the cover.
    const r = new THREE.Group();
    vbox(r, 0.074, 0.092, 0.36, VM.metal, 0, 0, -0.02);
    vbox(r, 0.078, 0.034, 0.1, VM.polymer, 0, -0.03, 0.1);
    for (let i = 0; i < 5; i++) vbox(r, 0.077, 0.004, 0.11, VM.polymer, 0, -0.034 + i * 0.014, -0.13);
    vbox(r, 0.02, 0.012, 0.05, VM.metal, 0.045, 0.05, 0.0); // ejection port lip
    vbox(r, 0.03, 0.014, 0.07, VM.metal, -0.045, 0.032, -0.07); // feed tray lip on the left
    const cover = new THREE.Group(); cover.position.set(0, 0.048, 0.075); r.add(cover);
    vbox(cover, 0.076, 0.024, 0.21, VM.polymer, 0, 0.01, -0.105); vbox(cover, 0.03, 0.014, 0.03, VM.metal, 0, 0.012, 0.012);
    vbox(cover, 0.024, 0.012, 0.2, VM.metal, 0, 0.027, -0.1); for (let i = 0; i < 7; i++) vbox(cover, 0.026, 0.004, 0.012, VM.polymer, 0, 0.034, -0.19 + i * 0.03);
    vbox(cover, 0.004, 0.042, 0.06, VM.polymer, 0.021, 0.052, -0.055); vbox(cover, 0.004, 0.042, 0.06, VM.polymer, -0.021, 0.052, -0.055); vbox(cover, 0.046, 0.005, 0.06, VM.polymer, 0, 0.074, -0.055); vbox(cover, 0.046, 0.008, 0.07, VM.metal, 0, 0.034, -0.055);
    { const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.038, 0.04), VM.lens); gl.position.set(0, 0.052, -0.075); cover.add(gl);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 8, 6), VM.dot); dot.position.set(0, 0.052, -0.085); cover.add(dot); }
    // ammo box under the left of the receiver; the belt climbs out of it into the feed tray and jumps a link with every shot
    const mag = new THREE.Group(); mag.position.set(-0.01, -0.09, -0.07); r.add(mag);
    vbox(mag, 0.088, 0.12, 0.135, VM.fde, -0.05, -0.05, 0); vbox(mag, 0.09, 0.016, 0.137, VM.polymer, -0.05, 0.004, 0); vbox(mag, 0.09, 0.012, 0.137, VM.polymer, -0.05, -0.108, 0);
    for (let i = 0; i < 2; i++) vbox(mag, 0.091, 0.005, 0.139, VM.polymer, -0.05, -0.035 - i * 0.035, 0);
    { const st = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.034), VM.sticker); st.position.set(-0.052, -0.05, 0.0685); mag.add(st); }
    const belt = [], beltAt = u => new V3(-0.05 + 0.02 * u - 0.03 * Math.sin(Math.PI * u), 0.014 + 0.116 * u, 0);
    for (let i = 0; i < 8; i++) { const g = new THREE.Group(); vcyl(g, 0.0052, 0.036, VM.brass, 0, 0, 0.008, 8); vcyl(g, 0.0042, 0.02, VM.copper, 0, 0, -0.02, 8); vbox(g, 0.013, 0.006, 0.014, VM.link, 0, 0, 0.004); mag.add(g); belt.push(g); }
    vbox(r, 0.038, 0.10, 0.048, VM.polymer, 0, -0.09, 0.09, -0.35); vbox(r, 0.01, 0.006, 0.07, VM.metal, 0, -0.062, 0.02); vbox(r, 0.006, 0.022, 0.008, VM.metal, 0, -0.052, 0.04, 0.3);
    for (const sx of [-1, 1]) vcyl(r, 0.009, 0.24, VM.metal, sx * 0.022, 0.012, 0.27, 10); vcyl(r, 0.009, 0.2, VM.metal, 0, -0.045, 0.25, 10);
    vbox(r, 0.056, 0.125, 0.028, VM.polymer, 0, -0.018, 0.395); vbox(r, 0.05, 0.03, 0.06, VM.polymer, 0, 0.022, 0.31);
    vbox(r, 0.06, 0.042, 0.27, VM.polymer, 0, -0.03, -0.36); for (let i = 0; i < 5; i++) for (const sx of [-1, 1]) vbox(r, 0.004, 0.014, 0.03, VM.metal, sx * 0.031, -0.03, -0.26 - i * 0.05);
    vbox(r, 0.05, 0.012, 0.27, VM.polymer, 0, 0.03, -0.36); for (let i = 0; i < 7; i++) vbox(r, 0.03, 0.004, 0.018, VM.link, 0, 0.0365, -0.25 - i * 0.036);
    const barrel = vcyl(r, 0.019, 0.5, VM.hot, 0, 0, -0.5, 14);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; vbox(r, 0.004, 0.004, 0.2, VM.link, Math.cos(a) * 0.019, Math.sin(a) * 0.019, -0.61); }
    vcyl(r, 0.009, 0.3, VM.metal, 0, -0.032, -0.6, 8); vbox(r, 0.03, 0.03, 0.03, VM.metal, 0, -0.016, -0.7);
    vcyl(r, 0.023, 0.035, VM.metal, 0, 0, -0.765, 12);
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 + Math.PI / 2; vbox(r, 0.009, 0.009, 0.08, VM.metal, Math.cos(a) * 0.015, Math.sin(a) * 0.015, -0.815); }
    vbox(r, 0.005, 0.034, 0.006, VM.metal, 0, 0.036, -0.72); for (const sx of [-1, 1]) vbox(r, 0.003, 0.03, 0.012, VM.metal, sx * 0.012, 0.03, -0.72);
    for (const sx of [-1, 1]) { vcyl(r, 0.006, 0.27, VM.metal, sx * 0.02, -0.058, -0.57, 8); vbox(r, 0.014, 0.008, 0.03, VM.polymer, sx * 0.02, -0.062, -0.44); } vbox(r, 0.05, 0.02, 0.026, VM.metal, 0, -0.05, -0.7);
    for (const z of [-0.24, -0.36]) vbox(r, 0.008, 0.035, 0.008, VM.metal, 0.03, 0.052, z); vcyl(r, 0.008, 0.15, VM.polymer, 0.03, 0.07, -0.3, 8);
    const ch = new THREE.Group(); ch.position.set(0.045, 0.01, -0.02); r.add(ch); vbox(ch, 0.03, 0.016, 0.03, VM.metal, 0, 0, 0);
    vbox(r, 0.055, 0.08, 0.095, VM.glove, 0.008, -0.11, 0.085, -0.3); limb(r, new V3(0.02, -0.14, 0.12), new V3(0.17, -0.33, 0.35), 0.04, VM.sleeve);
    const sh = supportHand(r, new V3(-0.01, -0.075, -0.33), new V3(-0.22, -0.35, -0.02), [0.075, 0.055, 0.12]);
    vms.push({ root: r, mag, ch, ...sh, magBase: mag.position.clone(), chPull: 0.09, muzzle: new V3(0, 0, -0.87), hip: new V3(0.16, -0.21, -0.42), ads: new V3(0, -0.1, -0.24), eject: new V3(0.04, 0.0, -0.02),
      cover, belt, beltAt, beltK: 0, barrel, mg: true, flashS: 0.2, jets: [[-0.62, 0.12, 0.6], [0.62, 0.12, 0.6], [0, 0.66, 0.6], [0, -0.5, 0.45]] });
  }
  { // Sniper rifle: bolt action, fluted heavy barrel, big scope with turrets, adjustable cheek rest
    const r = new THREE.Group();
    vbox(r, 0.05, 0.06, 0.3, VM.metal, 0, 0.005, -0.02);
    vbox(r, 0.062, 0.07, 0.5, VM.fde, 0, -0.03, -0.12);
    const mag = new THREE.Group(); mag.position.set(0, -0.07, -0.06); r.add(mag); vbox(mag, 0.032, 0.05, 0.08, VM.polymer, 0, -0.02, 0);
    vbox(r, 0.036, 0.10, 0.045, VM.fde, 0, -0.095, 0.1, -0.3);
    vbox(r, 0.05, 0.09, 0.3, VM.fde, 0, -0.04, 0.28); vbox(r, 0.04, 0.03, 0.14, VM.polymer, 0, 0.03, 0.26); vbox(r, 0.055, 0.12, 0.03, VM.polymer, 0, -0.04, 0.43);
    vcyl(r, 0.016, 0.6, VM.metal, 0, 0.005, -0.66, 14);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; vbox(r, 0.003, 0.003, 0.4, VM.polymer, Math.cos(a) * 0.016, 0.005 + Math.sin(a) * 0.016, -0.62); }
    vcyl(r, 0.026, 0.1, VM.metal, 0, 0.005, -1.0, 8); for (let i = 0; i < 3; i++) vbox(r, 0.055, 0.006, 0.014, VM.polymer, 0, 0.005, -0.97 - i * 0.025);
    vcyl(r, 0.024, 0.38, VM.polymer, 0, 0.09, -0.06, 20); vcyl(r, 0.038, 0.09, VM.polymer, 0, 0.09, -0.29, 20); vcyl(r, 0.031, 0.07, VM.polymer, 0, 0.09, 0.15, 20);
    vcyl(r, 0.034, 0.002, VM.lens, 0, 0.09, -0.336, 20);
    vcyl(r, 0.014, 0.03, VM.metal, 0, 0.125, -0.06).rotation.set(0, 0, 0); { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 14), VM.metal); t.position.set(0, 0.125, -0.06); r.add(t); const t2 = t.clone(); t2.rotation.z = Math.PI / 2; t2.position.set(0.035, 0.09, -0.06); r.add(t2); }
    for (const z of [-0.16, 0.04]) vbox(r, 0.034, 0.05, 0.025, VM.metal, 0, 0.055, z);
    const ch = new THREE.Group(); ch.position.set(0.026, 0.02, 0.06); r.add(ch);
    { const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.06, 8), VM.metal); arm.rotation.z = Math.PI / 2; arm.position.x = 0.03; ch.add(arm); const knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 10), VM.polymer); knob.position.set(0.06, -0.008, 0); ch.add(knob); vcyl(ch, 0.012, 0.06, VM.metal, 0, 0, 0.0); }
    vbox(r, 0.05, 0.075, 0.09, VM.glove, 0.008, -0.11, 0.095, -0.3); limb(r, new V3(0.02, -0.14, 0.13), new V3(0.17, -0.33, 0.36), 0.038, VM.sleeve);
    const sh = supportHand(r, new V3(-0.008, -0.08, -0.36), new V3(-0.22, -0.35, -0.04), [0.07, 0.05, 0.11]);
    vms.push({ root: r, mag, ch, ...sh, magBase: mag.position.clone(), chPull: 0.07, bolt: true, muzzle: new V3(0, 0, -1.06), hip: new V3(0.15, -0.2, -0.4), ads: new V3(0, -0.09, -0.16), eject: new V3(0.03, 0.02, 0.04) });
  }
  { // Shotgun: pump action, tube magazine, ghost-ring sights
    const r = new THREE.Group();
    vbox(r, 0.052, 0.075, 0.24, VM.metal, 0, 0.0, -0.02); vbox(r, 0.006, 0.03, 0.08, VM.polymer, 0.027, 0.0, -0.02);
    vcyl(r, 0.014, 0.56, VM.metal, 0, 0.018, -0.42); vcyl(r, 0.012, 0.44, VM.metal, 0, -0.016, -0.36);
    vbox(r, 0.03, 0.03, 0.02, VM.metal, 0, 0.0, -0.6); vbox(r, 0.004, 0.012, 0.004, VM.dot, 0, 0.038, -0.68);
    vbox(r, 0.03, 0.022, 0.012, VM.metal, 0, 0.05, 0.08); vbox(r, 0.006, 0.02, 0.006, VM.metal, 0.009, 0.064, 0.08); vbox(r, 0.006, 0.02, 0.006, VM.metal, -0.009, 0.064, 0.08);
    vbox(r, 0.036, 0.10, 0.045, VM.polymer, 0, -0.085, 0.1, -0.35);
    vbox(r, 0.046, 0.08, 0.26, VM.polymer, 0, -0.03, 0.24); vbox(r, 0.052, 0.12, 0.03, VM.polymer, 0, -0.04, 0.37);
    for (let i = 0; i < 4; i++) { const sh = vcyl(r, 0.009, 0.03, new THREE.MeshStandardMaterial({ color: 0xa8201a, roughness: 0.6 }), -0.03, -0.01 - i * 0.0, 0.14 + i * 0.045, 10); sh.rotation.set(Math.PI / 2, 0, 0); }
    const pump = new THREE.Group(); pump.position.set(0, -0.016, -0.38); r.add(pump);
    vcyl(pump, 0.024, 0.17, VM.polymer, 0, 0, 0, 16); for (let i = 0; i < 6; i++) vcyl(pump, 0.026, 0.006, VM.polymer, 0, 0, -0.06 + i * 0.024, 16);
    const mag = new THREE.Group(); mag.position.set(0, -0.05, -0.05); r.add(mag);
    { const sh = vcyl(mag, 0.009, 0.06, new THREE.MeshStandardMaterial({ color: 0xa8201a, roughness: 0.6 }), 0, 0, 0, 10); vcyl(mag, 0.0095, 0.015, VM.brass, 0, 0, 0.035, 10); }
    vbox(r, 0.05, 0.075, 0.09, VM.glove, 0.008, -0.1, 0.085, -0.3); limb(r, new V3(0.02, -0.13, 0.12), new V3(0.17, -0.32, 0.35), 0.038, VM.sleeve);
    const sh = supportHand(r, new V3(-0.01, -0.05, -0.38), new V3(-0.22, -0.34, -0.05), [0.07, 0.05, 0.12]);
    vms.push({ root: r, mag, pump, ...sh, magBase: mag.position.clone(), pumpBase: pump.position.clone(), shells: true, muzzle: new V3(0, 0.018, -0.71), hip: new V3(0.15, -0.19, -0.38), ads: new V3(0, -0.07, -0.26), eject: new V3(0.04, 0.0, -0.03) });
  }
  { // Sidearm: long-slide heavy pistol. Compensator with top ports, lightening cuts over a bronze barrel, fibre-optic sights,
    // a light and green laser under the dust cover, extended magazine, tan grip panels.
    const r = new THREE.Group();
    const slide = new THREE.Group(); r.add(slide); vbox(slide, 0.031, 0.036, 0.215, VM.metal, 0, 0.02, -0.09);
    for (let i = 0; i < 6; i++) for (const sx of [-1, 1]) { vbox(slide, 0.002, 0.026, 0.004, VM.link, sx * 0.0162, 0.02, 0.008 - i * 0.008); if (i < 4) vbox(slide, 0.002, 0.026, 0.004, VM.link, sx * 0.0162, 0.02, -0.15 - i * 0.008); }
    for (let i = 0; i < 3; i++) vbox(slide, 0.014, 0.004, 0.024, VM.bronze, 0, 0.0368, -0.062 - i * 0.034);
    vbox(slide, 0.007, 0.0125, 0.008, VM.link, 0.0085, 0.0422, 0.008); vbox(slide, 0.007, 0.0125, 0.008, VM.link, -0.0085, 0.0422, 0.008);
    for (const sx of [-1, 1]) vbox(slide, 0.0022, 0.0022, 0.0085, VM.fibre, sx * 0.0085, 0.0455, 0.008);
    vbox(slide, 0.0035, 0.0125, 0.014, VM.link, 0, 0.0422, -0.186); vbox(slide, 0.0022, 0.0022, 0.0145, VM.fibre, 0, 0.0455, -0.186);
    vcyl(r, 0.0085, 0.25, VM.bronze, 0, 0.02, -0.105, 12);
    vbox(r, 0.032, 0.038, 0.046, VM.metal, 0, 0.02, -0.223); for (const z of [-0.212, -0.232]) vbox(r, 0.02, 0.003, 0.009, VM.link, 0, 0.0395, z); for (const sx of [-1, 1]) vbox(r, 0.002, 0.012, 0.012, VM.link, sx * 0.0165, 0.022, -0.222);
    vbox(r, 0.029, 0.026, 0.17, VM.polymer, 0, -0.006, -0.075); for (let i = 0; i < 4; i++) vbox(r, 0.031, 0.004, 0.008, VM.link, 0, -0.019, -0.09 - i * 0.016);
    vbox(r, 0.031, 0.105, 0.052, VM.polymer, 0, -0.062, 0.0, -0.25); vbox(r, 0.035, 0.07, 0.036, VM.fde, 0, -0.06, 0.002, -0.25);
    vbox(r, 0.022, 0.012, 0.034, VM.polymer, 0, -0.002, 0.034); vbox(r, 0.008, 0.018, 0.01, VM.metal, 0, 0.026, 0.026, -0.5);
    vbox(r, 0.008, 0.005, 0.05, VM.polymer, 0, -0.045, -0.045); vbox(r, 0.008, 0.03, 0.005, VM.polymer, 0, -0.032, -0.07); vbox(r, 0.005, 0.02, 0.006, VM.metal, 0, -0.03, -0.04, 0.25);
    vbox(r, 0.026, 0.027, 0.062, VM.polymer, 0, -0.033, -0.122); vcyl(r, 0.0105, 0.004, VM.lamp, 0, -0.031, -0.154, 14); vcyl(r, 0.003, 0.004, VM.fibre, 0.009, -0.042, -0.154, 8);
    const beam = vbox(r, 0.0012, 0.0012, 1.6, VM.laser, 0.009, -0.042, -0.96);
    const mag = new THREE.Group(); mag.position.set(0, -0.1, 0.01); r.add(mag); vbox(mag, 0.026, 0.05, 0.045, VM.metal, 0, -0.02, 0.002, -0.25); vbox(mag, 0.034, 0.014, 0.058, VM.fde, 0, -0.05, 0.01, -0.25);
    vbox(r, 0.05, 0.07, 0.07, VM.glove, 0.006, -0.065, 0.02);
    limb(r, new V3(0.01, -0.09, 0.05), new V3(0.15, -0.3, 0.32), 0.036, VM.sleeve);
    const sh = supportHand(r, new V3(-0.03, -0.075, 0.015), new V3(-0.2, -0.3, 0.3), [0.04, 0.065, 0.075]);
    vms.push({ root: r, mag, slide, ...sh, magBase: mag.position.clone(), muzzle: new V3(0, 0.02, -0.25), hip: new V3(0.09, -0.12, -0.34), ads: new V3(0, -0.0466, -0.3), eject: new V3(0.02, 0.03, -0.06), pistol: true,
      beam, flashS: 0.14, jets: [[-0.3, 0.62, 0.7], [0.3, 0.62, 0.7], [0, 0.8, 0.55]] });
  }
  { // Supply-drop grenade launcher: six-shot revolving 40 mm, the drum turns a chamber with every shot
    const r = new THREE.Group();
    vbox(r, 0.05, 0.062, 0.2, VM.metal, 0, 0.0, 0.07);
    const drum = new THREE.Group(); drum.position.set(0, -0.005, -0.07); r.add(drum);
    vcyl(drum, 0.07, 0.15, VM.shell40, 0, 0, 0, 18);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + Math.PI / 2; vcyl(drum, 0.022, 0.152, VM.link, Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0, 12); vcyl(drum, 0.019, 0.004, VM.brass, Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0.0765, 12); vbox(drum, 0.006, 0.006, 0.13, VM.link, Math.cos(a + 0.52) * 0.07, Math.sin(a + 0.52) * 0.07, 0); }
    vcyl(drum, 0.012, 0.17, VM.metal, 0, 0, 0, 8);
    vcyl(r, 0.027, 0.3, VM.metal, 0, 0.04, -0.3, 16); vcyl(r, 0.032, 0.03, VM.link, 0, 0.04, -0.44, 16); vcyl(r, 0.031, 0.02, VM.link, 0, 0.04, -0.17, 16);
    vbox(r, 0.04, 0.03, 0.24, VM.polymer, 0, -0.005, -0.29); vbox(r, 0.032, 0.085, 0.036, VM.polymer, 0, -0.06, -0.33, 0.12);
    vbox(r, 0.024, 0.012, 0.26, VM.metal, 0, 0.076, -0.03); for (let i = 0; i < 8; i++) vbox(r, 0.026, 0.004, 0.012, VM.polymer, 0, 0.083, -0.14 + i * 0.03);
    vbox(r, 0.004, 0.04, 0.05, VM.polymer, 0.02, 0.104, 0.0); vbox(r, 0.004, 0.04, 0.05, VM.polymer, -0.02, 0.104, 0.0); vbox(r, 0.044, 0.005, 0.05, VM.polymer, 0, 0.126, 0.0);
    { const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.038), VM.lens); gl.position.set(0, 0.104, -0.01); r.add(gl); const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 8, 6), VM.dot); dot.position.set(0, 0.106, -0.02); r.add(dot); }
    vbox(r, 0.036, 0.1, 0.046, VM.polymer, 0, -0.085, 0.1, -0.3);
    for (const sx of [-1, 1]) vcyl(r, 0.008, 0.2, VM.metal, sx * 0.018, 0.01, 0.27, 8); vbox(r, 0.052, 0.11, 0.026, VM.polymer, 0, -0.01, 0.375);
    const mag = new THREE.Group(); mag.position.set(0, -0.2, 0.0); r.add(mag);
    vbox(r, 0.05, 0.075, 0.09, VM.glove, 0.008, -0.105, 0.09, -0.3); limb(r, new V3(0.02, -0.13, 0.12), new V3(0.17, -0.32, 0.35), 0.038, VM.sleeve);
    const sh = supportHand(r, new V3(-0.005, -0.1, -0.33), new V3(-0.22, -0.34, -0.05), [0.07, 0.06, 0.1]);
    vms.push({ root: r, mag, drum, drumA: 0, ...sh, magBase: mag.position.clone(), muzzle: new V3(0, 0.04, -0.46), hip: new V3(0.15, -0.2, -0.36), ads: new V3(0, -0.106, -0.22), eject: new V3(0.04, 0, 0), launcher: true, flashS: 0.24 });
  }
  for (const vm of vms) {
    vm.root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    vm.root.visible = false; wCam.add(vm.root);
    const fmat = new THREE.MeshBasicMaterial({ map: T.flash, color: new THREE.Color(4, 3, 2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fmat);
    fl.position.copy(vm.muzzle); fl.visible = false; vm.root.add(fl); vm.flash = fl;
    const fl2 = new THREE.Mesh(fl.geometry, fmat); fl2.rotation.y = Math.PI / 2; fl.add(fl2);
    for (const [x, y, sc] of vm.jets || []) { const j = new THREE.Mesh(fl.geometry, fmat); j.position.set(x, y, 0.05); j.scale.setScalar(sc); j.rotation.z = Math.atan2(-x, y); fl.add(j); } // gas jets out of the flash hider or compensator ports
    // a spare magazine that falls away on empty reloads
    vm.dropMag = vm.mag.clone(); vm.dropMag.visible = false; wCam.add(vm.dropMag); vm.dropV = new V3(); vm.dropT = 0;
  }
  return vms;
}
const viewmodels = buildViewmodels();
// shell casings
const casings = [];
const casingGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.022, 8).rotateZ(Math.PI / 2);
for (let i = 0; i < 22; i++) { const m = new THREE.Mesh(casingGeo, VM.brass); m.visible = false; m.frustumCulled = false; wCam.add(m); casings.push({ m, v: new V3(), t: 0, spin: new V3() }); }
let casingIdx = 0;

// ======================================================= PLAYER
const P = {
  pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, onGround: true, crouch: 0, crouching: false, alive: true, hp: 200, flinch: 0,
  weapon: 0, prevWeapon: 1, ammo: WEAPONS.map(w => ({ mag: w.launch ? 0 : w.mag, reserve: w.reserve })), fireCD: 0, reloadT: 0, switchT: 0, rl: null,
  ads: 0, adsHeld: false, kick: 0, bobPhase: 0, bobAmt: 0, sprint: 0, swayX: 0, swayY: 0, fallV: 0, stepAcc: 0, lastShot: 0,
  recP: new Spring(140, 0.85), recY: new Spring(120, 0.9), climb: 0, drift: 0, driftBias: 0, tracerN: 2, slideKick: 0,
  ssP: 0, ssY: 0, breath: 0, breathOut: 0, zoom2: false, cycle: null,
  shots: 0, hits: 0, deadT: 0, killer: null, rope: null, team: -1, minVy: 0,
  heat: 0, fovKick: 0, hasLauncher: false, slide: null, vault: null, frags: 2, flashes: 1, throwCD: 0, blind: 0, deaf: 0, aboardT: 0, killerId: 0, killInfo: ''
};
const keys = {};
let mouseDown = false, locked = false, wantLock = false, gameState = 'menu'; // menu | play
const eye = () => new V3(P.pos.x, P.pos.y + 1.62 - 0.55 * P.crouch - (P.slide ? 0.22 : 0), P.pos.z);
const aimPitch = () => P.pitch + P.recP.x + P.ssP, aimYaw = () => P.yaw + P.recY.x + P.ssY;

function respawnLocal(s) {
  const sp = SPAWNS[s] || SPAWNS[0];
  P.pos.set(sp[0], 0, sp[1]); P.vel.set(0, 0, 0);
  P.yaw = Math.atan2(sp[0], sp[1] - 7); // face toward map centre
  P.pitch = 0; P.alive = true; P.hp = MAX_HP; P.crouching = false; P.crouch = 0; P.reloadT = 0; P.switchT = 0; P.rope = null; P.climb = 0; P.swim = false; P.ladder = null;
  P.recP.x = P.recP.v = P.recY.x = P.recY.v = 0;
  P.ammo = WEAPONS.map(w => ({ mag: w.launch ? 0 : w.mag, reserve: w.reserve }));
  P.hasLauncher = false; P.slide = null; P.vault = null; P.frags = 2; P.flashes = 1; P.heat = 0; P.blind = 0; P.deaf = 0; P.killerId = 0; P.aboardT = 0;
  $('killcam').hidden = true; P.kcOn = false; P.shipWarn = 0; updateNadesHUD();
  setWeapon(settings.primary, true); hideBanner();
}

function setWeapon(i, instant = false) {
  if (i === LAUNCHER && !P.hasLauncher) return;
  if (i === P.weapon && !instant) return;
  if (i !== P.weapon && P.weapon !== LAUNCHER) P.prevWeapon = P.weapon;
  P.cycle = null;
  P.weapon = i; P.reloadT = 0; P.rl = null; P.switchT = instant ? 0 : 0.35;
  viewmodels.forEach((v, k) => { v.root.visible = k === i; v.mag.visible = true; v.mag.position.copy(v.magBase); });
  if (!instant) SFX.mech('pouch');
  updateSlotsHUD();
}

function startReload() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  if (P.reloadT > 0 || a.mag >= w.mag || a.reserve <= 0 || P.switchT > 0) return;
  const empty = a.mag === 0, j = () => R(-0.025, 0.025);
  if (viewmodels[P.weapon].shells) { // one shell at a time into the tube; firing interrupts it
    const n = Math.min(w.mag - a.mag, a.reserve), dur = 0.35 + n * w.reload * R(0.95, 1.05);
    P.rl = { dur, shells: n, loaded: 0, lead: 0.3 / dur, empty, done: {}, k: {} }; P.reloadT = dur; return;
  }
  const dur = (empty ? w.reloadEmpty : w.reload) * R(0.93, 1.07);
  P.rl = { dur, empty, bolt: Math.random() < 0.5, k: { out: 0.2 + j(), pouch: 0.36 + j(), back: 0.52 + j(), seat: 0.63 + j(), slap: 0.68 + j(), ch: 0.76 + j(), chEnd: 0.84 + j() },
    done: {}, tilt: R(0.42, 0.64), dip: R(0.03, 0.06), roll: R(-0.12, 0.12), lift: R(-0.02, 0.02) };
  if (!empty) { P.rl.k.slap = Math.min(0.8, P.rl.k.slap + 0.04); }
  P.reloadT = dur; P.driftBias = R(-0.35, 0.35);
}
function finishReload() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  if (P.rl && P.rl.shells != null) { const left = Math.min(P.rl.shells - P.rl.loaded, a.reserve); a.mag += left; a.reserve -= left; const e = P.rl.empty; P.rl = null; if (e) P.cycle = { t: 0.25, dur: w.pump, ej: true }; return; }
  const need = w.mag - a.mag, take = Math.min(need, a.reserve); a.mag += take; a.reserve -= take; P.rl = null;
}

const raycaster = new THREE.Raycaster();
function fire() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  if (w.launch) return fireLauncher();
  if (a.mag <= 0) { SFX.click(); P.fireCD = 0.25; startReload(); return; }
  const now = performance.now(), first = now - P.lastShot > 280;
  a.mag--; P.shots++; P.fireCD = (P.fireCD < -0.04 ? 0 : P.fireCD) + 60 / w.rpm * R(0.97, 1.035); P.lastShot = now;
  const speed = Math.hypot(P.vel.x, P.vel.z);
  let spread = lerp(w.hip, w.ads, P.ads) * (1 + speed * 0.25) * (P.onGround ? 1 : P.rope ? 1.6 : 3) * (P.crouch > 0.5 ? 0.75 : 1);
  if (w.scope && P.ads < 0.9) spread = w.hip * (1 + speed * 0.25);
  spread += P.kick * 0.02;
  const o = eye();
  const dir = new V3(0, 0, -1).applyEuler(new THREE.Euler(aimPitch(), aimYaw(), 0, 'YXZ'));
  const aim = dir.clone(), right = new V3(Math.cos(P.yaw), 0, -Math.sin(P.yaw)), up = new V3().crossVectors(right, aim);
  const n = w.pellets || 1, dmgBy = new Map(); let endP = null, hitP = null, headAny = false, impacts = 0;
  const cands = [];
  for (const rp of remotes.values()) if (rp.alive) cands.push(...rp.op.hit);
  for (const t of targets) if (t.up && t.pivot.visible) cands.push(...t.hit);
  for (let pi = 0; pi < n; pi++) {
    const rr = (n > 1 ? Math.sqrt(Math.random()) * 0.8 + 0.2 * Math.random() : Math.sqrt(Math.random())) * spread, ra = Math.random() * Math.PI * 2;
    const d = aim.clone().addScaledVector(right, Math.cos(ra) * rr).addScaledVector(up, Math.sin(ra) * rr).normalize();
    const hw = rayWorld(o, d, w.range);
    raycaster.set(o, d); raycaster.far = hw ? hw.t : w.range;
    const hits = raycaster.intersectObjects(cands, false);
    let e;
    if (hits.length) {
      const h = hits[0]; e = h.point.clone(); if (!hitP) hitP = h.point;
      const part = h.object.userData.part, head = part === 'head';
      const fall = w.pellets ? clamp(1 - (h.distance - 7) / 32, 0.2, 1) : 1;
      let owner = h.object.userData.owner;
      if (!owner) { let p = h.object; while (p && !p.userData.owner) p = p.parent; owner = p && p.userData.owner; }
      if (owner && owner.kind === 'target') { if (pi < 3) bloodPuff(h.point, d.clone().negate()); hitTarget(owner, head); headAny = headAny || head; }
      else if (owner && !isFriend(owner.id)) { if (pi < 3) bloodPuff(h.point, d.clone().negate()); const c = dmgBy.get(owner) || { dmg: 0, head: false }; c.dmg += w.scope ? sniperDmg(part, h.distance) : w.dmg * partK(w, part) * fall * R(0.95, 1.05); c.head = c.head || head; dmgBy.set(owner, c); headAny = headAny || head; }
      else if (owner && owner.kind === 'vehicle') { owner.onHit(); }
    } else if (hw) { e = o.clone().addScaledVector(d, hw.t); if (impacts++ < 5) impact(e, hw.n, hw.water); }
    else e = o.clone().addScaledVector(d, w.range);
    if (!hits.length) shotAtVehicles(o, d, hw ? hw.t : 900);
    if (pi === 0) { endP = e; dir.copy(d); P._hw = hits.length ? null : hw; }
    if (pi > 0 && pi < 4) P._extraEnds = (P._extraEnds || []).concat([e]);
  }
  let anyHit = false;
  for (const [owner, c] of dmgBy) { netSend({ t: 'hit', target: owner.id, dmg: Math.round(c.dmg), head: c.head, w: P.weapon }); P.hits++; anyHit = true; }
  if (anyHit || hitP) showHit(headAny ? 'head' : 'hit');
  const hw = P._hw;

  // visuals: every shot a little different
  const vm = viewmodels[P.weapon];
  vm.flash.visible = true; vm.flash.rotation.z = Math.random() * 6; const fs = (vm.flashS || (P.weapon === 2 ? 0.2 : 0.14)) * R(0.75, 1.3); vm.flash.scale.set(fs, fs * R(0.85, 1.15), fs); vm._flashT = R(0.03, 0.055);
  wFlash.position.copy(vm.muzzle).applyMatrix4(vm.root.matrix); wFlash.intensity = R(2.2, 3.8);
  worldFlash(o.clone().addScaledVector(dir, 0.8), R(30, 50));
  const muzzleWorld = o.clone().addScaledVector(dir, 0.7).addScaledVector(right, P.ads > 0.5 ? 0 : 0.12).add(new V3(0, -0.08, 0));
  if (--P.tracerN <= 0 || P.weapon === 1) { tracer(muzzleWorld, endP, vm.mg ? 0.036 : P.weapon === PISTOL ? 0.028 : 0.022); P.tracerN = vm.mg ? 1 + (Math.random() < 0.3 ? 1 : 0) : 2 + (Math.random() < 0.4 ? 1 : 0); }
  if (P._extraEnds) { for (const e of P._extraEnds) tracer(muzzleWorld, e); P._extraEnds = null; }
  if (Math.random() < 0.8) { smoke.spawn(muzzleWorld, dir.clone().multiplyScalar(R(0.3, 0.9)).add(new V3(R(-0.1, 0.1), R(0.15, 0.4), 0)), R(0.45, 0.8), R(0.04, 0.08), new THREE.Color(0x8a8580), -0.3, false, 2); smoke.p[smoke.p.length - 1].grow = true; }
  if (w.bolt || w.pump) { P.cycle = { t: 0, dur: w.bolt || w.pump, ej: false, s1: false, s2: false, s3: false }; }
  else { ejectCasing(vm); if (vm.mg) { ejectCasing(vm, true); vm.beltK = 1; P.heat = Math.min(1.3, P.heat + 0.034); } }
  P.fovKick = Math.min(2.6, P.fovKick + (w.punch || 0.3));
  // recoil: random strength, drifting side kick, bigger first shot, smaller crouched/aimed
  const stance = (P.ads > 0.5 ? 0.68 : 1) * (P.crouch > 0.5 ? 0.8 : 1);
  const kv = w.kickV * R(0.78, 1.22) * (first ? w.first : 1) * stance;
  P.drift = clamp(P.drift * 0.85 + R(-0.55, 0.55) + P.driftBias * 0.3, -1.2, 1.2);
  const kh = w.kickH * (P.drift * w.drift + R(-1, 1) * (1 - w.drift)) * stance;
  P.recP.v += kv * 34; P.recY.v += kh * 34; P.climb += kv * 0.3;
  P.kick = Math.min(1.5, P.kick + 1);
  const vk = w.vk, vs = P.ads > 0.5 ? 0.55 : 1;
  VMS.z.v += vk.z * R(0.85, 1.2) * vs; VMS.rx.v += vk.rx * R(0.8, 1.2) * vs; VMS.rz.v += vk.rz * R(-1, 1) * vs; VMS.x.v += vk.x * R(-1, 1) * vs; VMS.y.v += 0.25 * R(0.5, 1.2) * vs;
  if (vm.pistol) P.slideKick = 1;
  if (w.shake) { HITS.r.v += R(-1, 1) * w.shake; HITS.p.v += R(0.2, 0.6) * w.shake * 0.6; }
  SFX.shot(P.weapon, null, { indoor: indoorAt(P.pos) });
  netSend({ t: 'shot', o: [muzzleWorld.x, muzzleWorld.y, muzzleWorld.z], e: [endP.x, endP.y, endP.z], w: P.weapon, n: hw && !hitP ? hw.n : null, wt: !!(hw && hw.water && !hitP) });
  noiseForBots(P.pos, myId);
}
function ejectCasing(vm, link) { // link: the belt's steel link drops out under the gun as each case flies off to the right
  const c = casings[casingIdx++ % casings.length]; c.m.visible = true; c.m.material = link ? VM.link : VM.brass; c.m.scale.setScalar(link ? 0.7 : vm.pistol ? 1.25 : 1);
  c.m.position.copy(vm.eject).applyMatrix4(vm.root.matrix); c.t = 0.7; c.spin.set(R(8, 34), R(8, 34), R(-5, 5));
  if (link) { c.m.position.y -= 0.05; c.v.set(R(-0.2, 0.3), R(-0.4, 0.1), R(-0.2, 0.2)); return; }
  c.v.set(R(0.7, 1.6), R(0.7, 1.5), R(-0.25, 0.3)); if (vm.pistol) c.v.multiplyScalar(1.25);
  if (Math.random() < 0.75) setTimeout(() => SFX.tinkle(), R(420, 820));
}
const indoorAt = p => ceilingAt(p.x, p.z, 0.1, p.y + 1.9) < 50;

function weaponTick(dt, sprinting) { // aiming, firing, reloading and recoil: on foot and while hanging from the rope
  const w = WEAPONS[P.weapon];
  // aim
  P.ads = lerp(P.ads, P.adsHeld && !sprinting && P.reloadT <= 0 && P.switchT <= 0 ? 1 : 0, Math.min(1, dt * (w.scope ? 9 : 12)));
  // timers
  P.fireCD -= dt;
  if (P.switchT > 0) P.switchT -= dt;
  if (P.reloadT > 0) { P.reloadT -= dt; reloadEvents(); if (P.reloadT <= 0) finishReload(); }
  if (mouseDown && w.shells && P.reloadT > 0 && P.ammo[P.weapon].mag > 0) { P.reloadT = 0; P.rl = null; }
  if (mouseDown && P.fireCD <= 0 && P.reloadT <= 0 && P.switchT <= 0 && P.sprint < 0.4 && !P.cycle) {
    fire(); if (!w.auto) mouseDown = false;
  }
  if (P.ammo[P.weapon].mag === 0 && P.reloadT <= 0 && P.fireCD <= -0.1 && !mouseDown) startReload();
  // recoil: springs settle, part of the climb stays (pull down to compensate)
  P.recP.step(dt); P.recY.step(dt);
  const cl = P.climb * Math.min(1, dt * 16); P.pitch += cl; P.climb -= cl;
  P.kick = Math.max(0, P.kick - dt * 6);
  P.pitch = clamp(P.pitch, -1.5, 1.5);
  P.heat = Math.max(0, P.heat - dt * 0.2); P.throwCD -= dt;
}
function updatePlayer(dt) {
  if (!P.alive) return;
  const w = WEAPONS[P.weapon];
  if (P.rope) { updateRopeRider(dt); return; }
  if (P.ladder) { updateLadder(dt); return; }
  if (P.swim) { updateSwim(dt); return; }
  if (P.vault) { updateVault(dt); weaponTick(dt, false); return; }
  // input direction
  let fx = 0, fz = 0;
  if (keys.KeyW) fz -= 1; if (keys.KeyS) fz += 1; if (keys.KeyA) fx -= 1; if (keys.KeyD) fx += 1;
  const len = Math.hypot(fx, fz); if (len) { fx /= len; fz /= len; }
  const sprinting = keys.ShiftLeft && fz < 0 && !P.crouching && P.ads < 0.3 && P.reloadT <= 0;
  P.sprint = lerp(P.sprint, sprinting ? 1 : 0, Math.min(1, dt * 8));
  P.flinch = Math.max(0, P.flinch - dt);
  const speed = (P.crouching ? 2.3 : sprinting ? 6.8 : 4.4) * (P.adsHeld ? 0.6 : 1) * (1 - P.flinch * 0.6) * (w.heavy || 1);
  const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  const wx = (fx * cy + fz * sy) * speed, wz = (-fx * sy + fz * cy) * speed;
  const acc = P.onGround ? 11 : 2.5;
  if (P.slide) { // a sprint slide: fast and low, bleeding speed, ending in a crouch
    const sl = P.slide; sl.t += dt; const sp = lerp(9.4, 4.0, sl.t / 0.75); P.vel.x = sl.dx * sp; P.vel.z = sl.dz * sp;
    if (sl.t >= 0.75 || !P.onGround || !P.crouching) P.slide = null;
  } else { P.vel.x = lerp(P.vel.x, wx, Math.min(1, acc * dt)); P.vel.z = lerp(P.vel.z, wz, Math.min(1, acc * dt)); }
  if (keys.Space && P.onGround && tryVault()) { keys.Space = false; return; }
  if (keys.Space && P.onGround) { P.vel.y = 7.0; P.onGround = false; keys.Space = false; if (P.crouching) P.crouching = false; }
  P.vel.y -= 22 * dt;
  const headH = 1.8 - 0.55 * P.crouch;
  const steps = Math.ceil(Math.hypot(P.vel.x, P.vel.z) * dt / 0.12) || 1;
  for (let i = 0; i < steps; i++) {
    P.pos.x += P.vel.x * dt / steps; P.pos.z += P.vel.z * dt / steps;
    collideCircle(P.pos, 0.36, P.pos.y, P.pos.y + headH);
  }
  P.pos.y += P.vel.y * dt;
  const ceil = ceilingAt(P.pos.x, P.pos.z, 0.36, P.pos.y + headH);
  if (P.pos.y + headH > ceil && P.vel.y > 0) { P.pos.y = ceil - headH; P.vel.y = 0; }
  const g = groundAt(P.pos.x, P.pos.z, 0.36, P.pos.y);
  const wasAir = !P.onGround;
  if (!P.onGround) P.minVy = Math.min(P.minVy, P.vel.y);
  if (P.pos.y <= g) {
    if (wasAir && P.minVy < -6) SFX.land();
    if (wasAir && P.minVy < -11.5) { const dmg = Math.round((-P.minVy - 11.5) * 9); if (dmg > 0) netSend({ t: 'fall', dmg }); }
    P.pos.y = g; P.vel.y = 0; P.onGround = true; P.minVy = 0;
  }
  else if (P.pos.y - g > 0.05 && P.vel.y <= 0 && P.onGround && P.pos.y - g < STEP) { P.pos.y = g; }
  else if (P.pos.y > g + 0.02) P.onGround = false;
  if (P.pos.y < SWIM_Y && g < SWIM_Y) { startSwim(P.minVy); return; }
  if (P.pos.y < -0.4 && isLand(P.pos.x, P.pos.z, -0.5)) { P.pos.y = Math.max(0, groundAt(P.pos.x, P.pos.z, 0.36, 0.5)); P.vel.y = 0; P.onGround = true; } // safety: never under the ground
  if (!aboard(P.pos)) { P.pos.x = clamp(P.pos.x, MAP.x0 + 0.4, MAP.x1 - 0.4); P.pos.z = clamp(P.pos.z, MAP.z0 + 0.2, MAP.z1 - 0.4); }

  // crouch (stand only if room)
  let target = P.crouching ? 1 : 0;
  if (!P.crouching && P.crouch > 0.01 && ceilingAt(P.pos.x, P.pos.z, 0.36, P.pos.y + 1.25) < P.pos.y + 1.85) target = 1;
  P.crouch = lerp(P.crouch, target, Math.min(1, dt * 10));

  // bob + footsteps
  const hs = Math.hypot(P.vel.x, P.vel.z);
  P.bobAmt = lerp(P.bobAmt, P.onGround ? Math.min(1, hs / 4.4) : 0, Math.min(1, dt * 8));
  P.bobPhase += hs * dt * 1.9;
  P.stepAcc += hs * dt; if (P.onGround && P.stepAcc > (sprinting ? 2.1 : 1.6) * R(0.92, 1.08)) { P.stepAcc = 0; if (!P.crouching && !P.slide) SFX.step(null, sprinting ? 1.2 : 0.8, surfaceAt(P.pos)); }

  weaponTick(dt, sprinting);

  // ammo crates
  for (const c of ammoCrates) {
    c.cool -= dt;
    if (c.cool <= 0 && Math.abs(P.pos.y - c.pos.y) < 1.5 && Math.hypot(P.pos.x - c.pos.x, P.pos.z - c.pos.z) < 1.6) {
      const needs = P.ammo.some((a, i) => a.reserve < WEAPONS[i].reserve) || P.frags < 2 || P.flashes < 1;
      if (needs) { P.ammo.forEach((a, i) => a.reserve = WEAPONS[i].reserve); P.frags = 2; P.flashes = 1; updateNadesHUD(); c.cool = 15; SFX.ammo(); showPrompt('Ammo and grenades restocked'); }
    }
  }
  ropeGrabCheck();
}
function reloadEvents() { // sounds and the falling magazine, at jittered moments of the reload
  const rl = P.rl; if (!rl || rl.shells != null) return;
  const k = 1 - P.reloadT / rl.dur, K = rl.k, vm = viewmodels[P.weapon], once = (n, f) => { if (!rl.done[n] && k >= K[n]) { rl.done[n] = 1; f(); } };
  once('out', () => {
    SFX.mech('magout');
    if (rl.empty) { vm.dropMag.visible = true; vm.dropMag.position.copy(vm.mag.position).applyMatrix4(vm.root.matrix); vm.dropMag.quaternion.copy(vm.root.quaternion); vm.dropV.set(R(-0.1, 0.1), R(-0.6, -0.2), R(-0.1, 0.1)); vm.dropT = 0.7; setTimeout(() => SFX.mech('drop'), R(380, 560)); }
  });
  once('pouch', () => SFX.mech('pouch'));
  once('seat', () => SFX.mech('magin'));
  once('slap', () => { SFX.mech(vm.pistol && rl.empty ? 'slide' : 'slap'); VMS.y.v += R(0.5, 0.8); VMS.rx.v += R(-1.2, -0.6); if (vm.pistol) rl.slideFree = true; });
  if (rl.empty && !vm.pistol) once(rl.bolt ? 'slap' : 'ch', () => { setTimeout(() => SFX.mech('charge'), rl.bolt ? 90 : 0); VMS.z.v += 0.5; });
}
function shellPose(vm, k, out) { // tilt the port toward you, hand fetches a shell, thumbs it in, repeat
  const rl = P.rl, env = smoothK(k / 0.12) * (1 - smoothK((k - 0.95) / 0.05));
  out.rz += 0.45 * env; out.rx -= 0.12 * env; out.y -= 0.03 * env;
  const ph = Math.max(0, (k - rl.lead) / (1 - rl.lead)) * rl.shells, i = Math.min(rl.shells - 1, Math.floor(ph)), f = ph - i;
  const pouch = new V3(-0.12, -0.36, 0.04), port = vm.magBase.clone().add(new V3(-0.005, -0.01, 0.02));
  const hand = k < rl.lead ? along(k / rl.lead, [[0, vm.lhBase], [1, pouch]]) : along(f, [[0, pouch], [0.45, port.clone().add(new V3(0, -0.04, 0.03))], [0.7, port], [0.8, port], [1, pouch]]);
  vm.lh.position.copy(hand);
  vm.mag.visible = k >= rl.lead && f > 0.05 && f < 0.75; vm.mag.position.copy(hand).add(new V3(0.0, 0.03, -0.02));
  if (k >= rl.lead && i >= rl.loaded && f >= 0.72) { const a = P.ammo[P.weapon]; if (a.reserve > 0 && a.mag < WEAPONS[P.weapon].mag) { a.mag++; a.reserve--; } rl.loaded++; SFX.mech('shell'); VMS.y.v += 0.3; }
  if (rl.loaded >= rl.shells && k > rl.lead) vm.lh.position.lerp(vm.lhBase, smoothK((k - 0.9) / 0.1));
}
function reloadPose(vm, k, out) { // gun tilt, support hand path, mag and charging-handle positions
  if (P.rl.shells != null) return shellPose(vm, k, out);
  const rl = P.rl, K = rl.k, e = rl.empty, rifleCharge = e && !vm.pistol && !rl.bolt;
  const endK = rifleCharge ? K.chEnd + 0.06 : K.slap + 0.12;
  const tilt = smoothK(k / 0.14) * (1 - smoothK((k - endK) / 0.12));
  if (vm.pistol) { out.rz -= rl.tilt * 0.6 * tilt; out.ry += 0.35 * tilt; out.rx += 0.25 * tilt; }
  else { out.rz += rl.tilt * tilt; out.rx -= (0.32 + rl.roll) * tilt; }
  out.y -= rl.dip * tilt; out.x += rl.lift * tilt;
  const Mw = vm.magBase.clone().add(new V3(0, vm.pistol ? -0.03 : -0.08, 0)), pouch = new V3(-0.14, -0.45, vm.pistol ? 0.15 : 0.02), low = Mw.clone().add(new V3(-0.02, -0.12, 0.02));
  const path = [[0, vm.lhBase], [K.out - 0.05, Mw], [K.out, Mw], [K.pouch, pouch], [K.back, low], [K.seat, Mw], [K.slap - 0.015, Mw], [K.slap + 0.02, Mw.clone().add(new V3(0, -0.03, 0))]];
  if (rifleCharge) { const C = vm.ch.position.clone().add(new V3(0, 0.03, 0.02)); path.push([K.ch - 0.02, C], [K.chEnd, C.clone().add(new V3(0, 0, vm.chPull))], [K.chEnd + 0.03, C], [endK + 0.1, vm.lhBase]); }
  else path.push([endK + 0.08, vm.lhBase]);
  const hand = along(k, path); vm.lh.position.copy(hand);
  // magazine: in the well, in the hand, or gone (dropped)
  const held = k >= K.out && k < K.seat;
  vm.mag.visible = !(e && k >= K.out && k < K.pouch);
  if (held) vm.mag.position.copy(hand).add(vm.magBase.clone().sub(Mw)); else vm.mag.position.copy(vm.magBase);
  if (vm.ch) vm.ch.position.z = vm.chBase + (rifleCharge && k > K.ch && k < K.chEnd + 0.03 ? vm.chPull * smoothK((k - K.ch) / (K.chEnd - K.ch)) * (k > K.chEnd ? 0 : 1) : 0);
}

function updateCamera(dt, t) {
  const w = WEAPONS[P.weapon]; shadowView = null;
  if (!P.alive) {
    P.deadT = P.deadAt ? Math.max(P.deadT + dt, (performance.now() - P.deadAt) / 1000) : P.deadT + dt; const k = Math.min(1, P.deadT / 1.2); // wall clock, so the kill cam still starts on time on a slow frame rate
    const kr = P.killerId ? remotes.get(P.killerId) : null;
    if (kr && kr.alive && P.deadT > 1.0) { killCam(kr, dt); return; }
    const base = eye(); base.y = lerp(P.pos.y + 1.6, P.pos.y + 4.5, k);
    camera.position.copy(base);
    if (P.killer) { const kp = P.killer.clone(); kp.y += 1.2; const d = kp.sub(base); const ty = Math.atan2(-d.x, -d.z), tp = Math.atan2(d.y, Math.hypot(d.x, d.z)); P.yaw += angDiff(P.yaw, ty) * Math.min(1, dt * 3); P.pitch = lerp(P.pitch, tp, Math.min(1, dt * 3)); }
    camera.rotation.set(P.pitch, P.yaw, 0.15 * k);
    camera.fov = lerp(camera.fov, 70, dt * 4); camera.near = 0.1; camera.updateProjectionMatrix();
    return;
  }
  const e = eye();
  const bob = P.bobAmt * (1 - P.ads * 0.8);
  e.y += Math.abs(Math.sin(P.bobPhase)) * 0.045 * bob - 0.02 * bob;
  e.x += Math.cos(P.bobPhase) * 0.02 * bob * Math.cos(P.yaw); e.z -= Math.cos(P.bobPhase) * 0.02 * bob * Math.sin(P.yaw);
  camera.position.copy(e);
  for (const s of Object.values(VMS)) s.step(dt);
  HITS.p.step(dt); HITS.y.step(dt); HITS.r.step(dt);
  camera.position.x += HITS.y.x * 0.03; camera.position.y -= Math.abs(HITS.p.x) * 0.02;
  camera.rotation.set(aimPitch() + HITS.p.x * 0.035, aimYaw() + HITS.y.x * 0.035, Math.cos(P.bobPhase) * 0.004 * bob + VMS.rz.x * 0.04 + HITS.r.x * 0.05 + (P.rope ? Math.sin(t * 1.3) * 0.03 : 0) + (P.lean = lerp(P.lean || 0, P.slide ? 0.07 : 0, Math.min(1, dt * 10))));
  { // scoped sway: a slow wandering drift; hold Shift to hold your breath and steady it for a few seconds
    const scoped = w.scope && P.ads > 0.6, holding = scoped && keys.ShiftLeft && P.breathOut <= 0 && P.breath < 4.5;
    if (holding) P.breath += dt; else { P.breath = Math.max(0, P.breath - dt * 1.5); }
    if (scoped && keys.ShiftLeft && P.breath >= 4.5 && P.breathOut <= 0) { P.breathOut = 2.5; P.breath = 4.5; }
    P.breathOut = Math.max(0, P.breathOut - dt);
    const mv = Math.min(1, Math.hypot(P.vel.x, P.vel.z) / 3), amp = (scoped ? 1 : 0) * (holding ? 0.12 : P.breathOut > 0 ? 2.2 : 1) * (P.crouch > 0.5 ? 0.6 : 1) * (0.0028 + mv * 0.006);
    const tP = (Math.sin(t * 0.73) + Math.sin(t * 1.31 + 1.7) * 0.6) * amp, tY = (Math.sin(t * 0.52 + 0.4) + Math.sin(t * 1.07 + 2.3) * 0.5) * amp * 1.3;
    P.ssP = lerp(P.ssP, tP, Math.min(1, dt * 4)); P.ssY = lerp(P.ssY, tY, Math.min(1, dt * 4));
    P.holdingBreath = holding;
  }
  P.fovKick *= Math.exp(-dt * 13);
  const fovT = lerp(lerp(settings.fov, settings.fov + 7, Math.max(P.sprint, P.slide ? 1 : 0)), w.scope && P.zoom2 ? w.fov2 : w.fov, P.ads) + P.fovKick * (1 - P.ads * 0.55);
  // near plane: pushed out while scoped (nothing is close then) so far-off walls, shutters and decals get the depth precision and stop flickering
  const scoped = w.scope && P.ads > 0.82, nearT = scoped ? 0.7 : 0.1;
  if (Math.abs(camera.fov - fovT) > 0.01 || camera.near !== nearT) { camera.fov = fovT; camera.near = nearT; camera.updateProjectionMatrix(); }
  if (scoped) shadowView = scopeView();

  // viewmodel
  const vm = viewmodels[P.weapon];
  const pos = vm.hip.clone().lerp(vm.ads, P.ads);
  const bobV = P.bobAmt * (1 - P.ads * 0.9);
  pos.x += Math.cos(P.bobPhase) * 0.012 * bobV; pos.y += -Math.abs(Math.sin(P.bobPhase)) * 0.012 * bobV;
  // idle breathing sway, a slow figure-eight that is stronger when scoped in
  const br = (1 - P.ads) * 0.0015 + P.ads * (w.scope ? 0.0009 : 0.0004);
  pos.y += Math.sin(t * 1.6) * br; pos.x += Math.sin(t * 0.8) * br * 0.8;
  P.swayX = lerp(P.swayX, 0, Math.min(1, dt * 7)); P.swayY = lerp(P.swayY, 0, Math.min(1, dt * 7));
  pos.x += P.swayX * (1 - P.ads * 0.8) + VMS.x.x * 0.03; pos.y += P.swayY * (1 - P.ads * 0.8) + VMS.y.x * 0.03;
  pos.z += VMS.z.x * 0.03;
  pos.x -= 0.06 * P.sprint; pos.y -= 0.04 * P.sprint;
  const o = { x: 0, y: 0, rx: VMS.rx.x * 0.03 * (1 - P.ads * 0.4), ry: 0.55 * P.sprint, rz: 0.35 * P.sprint + VMS.rz.x * 0.03 };
  if (P.reloadT > 0 && P.rl) reloadPose(vm, 1 - P.reloadT / P.rl.dur, o);
  else { vm.lh.position.copy(vm.lhBase); vm.mag.visible = !vm.shells; vm.mag.position.copy(vm.magBase); if (vm.ch) { vm.ch.position.z = vm.chBase; vm.ch.rotation.z = 0; } }
  if (vm.pump) vm.pump.position.copy(vm.pumpBase);
  if (P.cycle) { // bolt or pump cycle after each shot
    const c = P.cycle; c.t += dt; const k = c.t / c.dur, env = smoothK((k - 0.08) / 0.15) * (1 - smoothK((k - 0.8) / 0.15));
    const once = (n, at, fn) => { if (!c[n] && k >= at) { c[n] = 1; fn(); } };
    if (vm.bolt) {
      const up = smoothK((k - 0.15) / 0.13) * (1 - smoothK((k - 0.72) / 0.12)), back = smoothK((k - 0.3) / 0.17) * (1 - smoothK((k - 0.5) / 0.17));
      vm.ch.rotation.z = 1.15 * up; vm.ch.position.z = vm.chBase + vm.chPull * back;
      o.rz -= 0.14 * env; o.rx += 0.05 * env; o.y = (o.y || 0) - 0.012 * env;
      once('s1', 0.15, () => SFX.mech('boltup')); once('s2', 0.3, () => SFX.mech('boltback')); once('ej', 0.42, () => ejectCasing(vm)); once('s3', 0.52, () => SFX.mech('boltfwd'));
    } else if (vm.pump) {
      const back = smoothK((k - 0.12) / 0.25) * (1 - smoothK((k - 0.45) / 0.25));
      vm.pump.position.z = vm.pumpBase.z + 0.1 * back; vm.lh.position.z = vm.lhBase.z + 0.1 * back;
      o.rx += 0.07 * env; o.rz += 0.05 * env;
      once('s1', 0.12, () => SFX.mech('pumpback')); once('ej', 0.32, () => ejectCasing(vm)); once('s2', 0.47, () => { SFX.mech('pumpfwd'); VMS.z.v -= 0.5; });
    }
    if (k >= 1) P.cycle = null;
  }
  pos.x += o.x; pos.y += o.y;
  if (P.switchT > 0) pos.y -= (P.switchT / 0.35) * 0.3;
  vm.root.position.copy(pos); vm.root.rotation.set(o.rx, o.ry, o.rz);
  sleeveTo(vm.sleeve, vm.lh.position, vm.anchor);
  if (vm.slide) { P.slideKick = Math.max(0, P.slideKick - dt * 28); const locked = P.ammo[PISTOL].mag === 0 && !(P.rl && P.rl.slideFree); vm.slide.position.z = locked ? 0.042 : 0.045 * Math.sin(Math.min(1, P.slideKick) * Math.PI * 0.5); }
  if (vm.mg) { // belt jumps a link per shot, the cover lifts on reloads, the barrel glows and smokes when it has been run hard
    vm.beltK = Math.max(0, vm.beltK - dt * 18); const left = P.ammo[0].mag;
    vm.belt.forEach((b, i) => { b.position.copy(vm.beltAt(clamp((i + 1 - vm.beltK) / 8, 0, 1))); b.rotation.z = -0.5 * Math.sin(Math.PI * (i + 1 - vm.beltK) / 8); b.visible = 8 - i <= left; });
    const rk = P.reloadT > 0 && P.rl ? 1 - P.reloadT / P.rl.dur : -1;
    vm.cover.rotation.x = rk < 0 ? 0 : 1.0 * smoothK((rk - 0.12) / 0.1) * (1 - smoothK((rk - 0.66) / 0.08));
    VM.hot.emissiveIntensity = Math.max(0, P.heat - 0.3) * 2.6;
    if (P.heat > 0.45 && Math.random() < dt * 22 * P.heat) { const mz = eye().add(new V3(0, 0, -1).applyEuler(new THREE.Euler(aimPitch(), aimYaw(), 0, 'YXZ')).multiplyScalar(0.85)); mz.y -= 0.1; smoke.spawn(mz, new V3(R(-0.1, 0.1), R(0.3, 0.7), R(-0.1, 0.1)), R(0.5, 1.0), R(0.03, 0.06), new THREE.Color(0xa8a49c), -0.3, false, 1.5); smoke.p[smoke.p.length - 1].grow = true; }
  }
  if (vm.drum) { vm.drumA = lerp(vm.drumA, 0, Math.min(1, dt * 9)); vm.drum.rotation.z = (6 - P.ammo[LAUNCHER].mag) * Math.PI / 3 - vm.drumA; }
  updateLaser(vm);
  vm.root.visible = !(w.scope && P.ads > 0.82) && !P.swim && !P.ladder;
  wCam.fov = lerp(52, w.wfov, P.ads); wCam.updateProjectionMatrix();
  if (vm._flashT > 0) { vm._flashT -= dt; if (vm._flashT <= 0) vm.flash.visible = false; }
  if (vm.dropT > 0) { vm.dropT -= dt; vm.dropV.y -= 6 * dt; vm.dropMag.position.addScaledVector(vm.dropV, dt); vm.dropMag.rotation.x += dt * 3; if (vm.dropT <= 0) vm.dropMag.visible = false; }
  wFlash.intensity = Math.max(0, wFlash.intensity - dt * 60);
  // sun direction into camera space
  const inv = camera.quaternion.clone().invert();
  wSun.position.copy(SUN_DIR).applyQuaternion(inv).multiplyScalar(5); wSun.target.position.set(0, 0, 0);
  // indoor dimming of viewmodel
  const indoor = indoorAt(P.pos);
  wSun.intensity = lerp(wSun.intensity, indoor ? 0.35 : 2.2, Math.min(1, dt * 4));
  // casings
  for (const c of casings) { if (c.t <= 0) continue; c.t -= dt; c.v.y -= 9.8 * dt; c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; if (c.t <= 0) c.m.visible = false; }
}
viewmodels.forEach(v => { if (v.ch) v.chBase = v.ch.position.z; });

// ======================================================= OTHER COMBATANTS (players and bots)
const remotes = new Map();
const playerInfo = new Map(); // id -> {id,name,slot,kills,deaths,hp,alive,bot,team,look}
function bandColorFor(info) { return info.team >= 0 ? TEAM_COLORS[info.team] : info.bot ? 0x6b6a5c : PALETTE[colorIdx(info)]; }
class Remote {
  constructor(info) {
    this.id = info.id; this.kind = 'player'; this.bot = !!info.bot; this.look = info.look; this.team = info.team;
    this.camo = info.camo; this.op = makeOperator(info.look, bandColorFor(info), info.camo); this.op.g.userData.owner = this; this.op.hit.forEach(m => m.userData.owner = this);
    scene.add(this.op.g); this.snaps = []; this.alive = !!info.alive; this.op.g.visible = this.alive;
    this.pos = new V3(); this.vel = new V3(); this.yaw = 0; this.pitch = 0; this.crouch = 0; this.w = 0; this.flags = 0; this.stepAcc = 0; this.lastPos = new V3();
    this.aimS = 1; this.reloadStart = -1; this.direct = null; this.tag = null; this.deadT = 0;
  }
  setInfo(info) {
    this.team = info.team; this.op.band.color.setHex(bandColorFor(info)); this.op.band.emissive.setHex(bandColorFor(info));
    const friend = info.team >= 0 && info.team === P.team && info.id !== myId;
    if (friend && !this.tag) { this.tag = nameTag(info.name, TEAM_CSS[info.team]); scene.add(this.tag); }
    if (!friend && this.tag) { scene.remove(this.tag); this.tag = null; }
  }
  push(m) {
    const now = performance.now();
    this.snaps.push({ t: now, p: new V3(m.p[0], m.p[1], m.p[2]), y: m.y, pi: m.pi, c: m.c, w: m.w, f: m.f | 0 });
    if (this.snaps.length > 30) this.snaps.shift();
  }
  update(dt) {
    const op = this.op;
    if (!this.alive) {
      this.deadT += dt; poseOperator(op, { vf: 0, vs: 0, crouch: 0, pitch: 0, aim: 0, reload: -1, rope: 0, w: this.w, dt });
      op.g.position.copy(this.pos);
      if (this.deadT > 4) op.g.visible = false;
      if (this.tag) this.tag.visible = false;
      return;
    }
    this.lastPos.copy(this.pos);
    if (this.direct) { const b = this.direct; this.pos.copy(b.pos); this.yaw = b.yaw; this.pitch = b.pitch; this.crouch = b.crouch; this.w = b.w; this.flags = b.flags; }
    else {
      const rt = performance.now() - 110;
      const s = this.snaps; if (!s.length) { op.g.visible = false; return; }
      let a = s[0], b = s[s.length - 1];
      for (let i = s.length - 1; i > 0; i--) if (s[i - 1].t <= rt) { a = s[i - 1]; b = s[i]; break; }
      const k = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1.2) : 1;
      this.pos.copy(a.p).lerp(b.p, k);
      this.yaw = a.y + angDiff(a.y, b.y) * k; this.pitch = lerp(a.pi, b.pi, k); this.crouch = lerp(a.c, b.c, k); this.w = b.w | 0; this.flags = b.f;
    }
    if (dt > 0) { this.vel.lerp(new V3((this.pos.x - this.lastPos.x) / dt, 0, (this.pos.z - this.lastPos.z) / dt), Math.min(1, dt * 10)); this.vy = lerp(this.vy || 0, clamp((this.pos.y - this.lastPos.y) / dt, -15, 15), Math.min(1, dt * 8)); }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const vf = -(this.vel.x * sy + this.vel.z * cy), vs = this.vel.x * cy - this.vel.z * sy;
    const reloading = this.flags & 1, rope = this.flags & 16 ? 2 : this.flags & 2, sprint = this.flags & 4, aimed = this.flags & 8;
    const wantAim = sprint ? 0 : this.bot ? (aimed ? 1 : 0.35) : 1;
    this.aimS = lerp(this.aimS, wantAim, Math.min(1, dt * 6));
    if (reloading && this.reloadStart < 0) this.reloadStart = performance.now();
    if (!reloading) this.reloadStart = -1;
    const rk = this.reloadStart >= 0 ? clamp((performance.now() - this.reloadStart) / 1000 / (WEAPONS[this.w] || WEAPONS[0]).reload, 0, 1) : -1;
    op.g.visible = true; op.g.position.copy(this.pos); op.g.rotation.set(0, this.yaw + Math.PI, 0);
    poseOperator(op, { vf, vs, crouch: this.crouch, pitch: this.pitch, aim: this.aimS, reload: rk, rope, w: this.w, dt, yaw: this.yaw, air: Math.abs(this.vy || 0) > 3.4 && !rope });
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.stepAcc += sp * dt; if (this.stepAcc > 1.7 && this.crouch < 0.5 && sp > 2.5 && !rope) { this.stepAcc = 0; SFX.step(this.pos, sp > 5.5 ? 1.4 : 1, surfaceAt(this.pos)); }
    if (this.tag) { this.tag.visible = true; this.tag.position.set(this.pos.x, this.pos.y + 2.25 - 0.5 * this.crouch, this.pos.z); const d = this.tag.position.distanceTo(camera.position); const sc = clamp(d * 0.035, 0.35, 1.6); this.tag.scale.set(sc * 2.4, sc * 0.6, 1); }
  }
  muzzle() { return muzzleWorld(this.op, new V3()); }
  die(killerPos) {
    this.alive = false; this.deadT = 0;
    const toK = killerPos ? killerPos.clone().sub(this.pos) : new V3(0, 0, 1);
    const fwd = new V3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    killOperator(this.op, fwd.dot(toK) > 0 ? -1 : 1);
  }
  hide() { this.alive = false; this.op.g.visible = false; if (this.tag) this.tag.visible = false; }
  respawn(s) {
    const sp = SPAWNS[s]; this.alive = true; reviveOperator(this.op); this.snaps = [];
    const yaw = Math.atan2(sp[0], sp[1] - 7); this.pos.set(sp[0], 0, sp[1]); this.lastPos.copy(this.pos); this.vel.set(0, 0, 0); this.push({ p: [sp[0], 0, sp[1]], y: yaw, pi: 0, c: 0, w: 0 });
  }
  dispose() { scene.remove(this.op.g); if (this.tag) scene.remove(this.tag); }
}
function nameTag(name, css) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d');
  g.font = '600 30px "IBM Plex Mono", Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText(name, 129, 25); g.fillStyle = css; g.fillText(name, 128, 24);
  g.beginPath(); g.moveTo(116, 46); g.lineTo(140, 46); g.lineTo(128, 60); g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true })); s.renderOrder = 10; return s;
}
function isFriend(id) { const i = playerInfo.get(id); return !!(i && cfg.mode === 'team' && i.team >= 0 && i.team === P.team); }

// ======================================================= PRACTICE TARGETS
const targets = [];
const steelMat = std({ color: 0xc9c2b4, roughness: 0.5, metalness: 0.6 });
function buildTargets() {
  for (const [x, z, ry] of [[-10, -21, 0], [0, -2.5, 0], [10, 4, -0.5], [-18, 12, 0.6], [20, -8, -1.2], [4, 20.5, 3.14], [-4, -18, 0.3], [26, 13, -1.7]]) {
    const pivot = new THREE.Group(); pivot.position.set(x, x === -4 ? 2.59 : 0, z); pivot.rotation.y = ry; scene.add(pivot);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.4), M.steel); base.position.y = 0.06; base.castShadow = true; pivot.add(base);
    const arm = new THREE.Group(); pivot.add(arm);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), M.steel); post.position.y = 0.45; arm.add(post);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.03), steelMat); body.position.y = 1.2; arm.add(body);
    const head = new THREE.Mesh(new THREE.CircleGeometry(0.15, 20), steelMat); head.position.set(0, 1.75, 0.0); arm.add(head);
    const headB = new THREE.Mesh(new THREE.CircleGeometry(0.15, 20), steelMat); headB.position.set(0, 1.75, -0.001); headB.rotation.y = Math.PI; arm.add(headB);
    [post, body, head, headB].forEach(m => m.castShadow = true);
    const t = { kind: 'target', pivot, arm, up: true, t: 0, hit: [body, head, headB] };
    body.userData = { part: 'body', owner: t }; head.userData = { part: 'head', owner: t }; headB.userData = { part: 'head', owner: t };
    pivot.visible = false; targets.push(t);
  }
}
let practiceHits = 0;
function hitTarget(t, head) { t.up = false; t.t = 3; practiceHits += head ? 2 : 1; SFX.kill(); renderScore(); }
function updateTargets(dt) {
  for (const t of targets) {
    if (!t.pivot.visible) continue;
    if (!t.up) { t.t -= dt; t.arm.rotation.x = lerp(t.arm.rotation.x, -Math.PI / 2, Math.min(1, dt * 12)); if (t.t <= 0) t.up = true; }
    else t.arm.rotation.x = lerp(t.arm.rotation.x, 0, Math.min(1, dt * 8));
  }
}

// ======================================================= NETWORK
const viaTunnel = /\.trycloudflare\.com$/i.test(location.hostname);
const viaTunnelHost = () => viaTunnel;
// 'ws': a Tidebreak server (host Mac, same Wi-Fi or join code). 'local': offline practice with the same match rules and bots.
let webMode = false;
let ws = null, online = false, netMode = '', myId = 0, killTarget = 10, matchOver = false, pingMs = 0, sendAcc = 0, bsendAcc = 0;
let isHost = false, botOwner = 0, teamKills = [0, 0], cfg = { mode: 'ffa', bots: 0, skill: 1 };
const hostCfg = Object.assign({ mode: 'ffa', bots: 3, skill: 1 }, store.get('hostcfg', {}));
let localMatch = null, localMe = null;
const clone = m => JSON.parse(JSON.stringify(m));
function netSend(m) {
  if (netMode === 'ws') { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  else if (netMode === 'local' && localMatch) localMatch.msg(localMe, clone(m));
}
// Host settings: the host (or anyone before joining on the host Mac / offline) picks mode, bots, skill.
const SKILL_NAMES = ['Recruit', 'Regular', 'Veteran'];
const cfgSegs = { mode: $('cfgmode'), bots: $('cfgbots'), skill: $('cfgskill') };
function canEditCfg() {
  if (netMode) return isHost;
  if (webMode) { const st = P2P.status(); return !st || st.kind === 'host'; }
  return location.protocol === 'file:' || /^(localhost|127\.)/.test(location.hostname) || !location.host;
}
function updateHostUI() {
  const edit = canEditCfg(), c = netMode ? cfg : hostCfg;
  for (const k in cfgSegs) for (const b of cfgSegs[k].children) {
    b.setAttribute('aria-pressed', String(b.dataset.v) === String(c[k]));
    b.disabled = !edit;
  }
  $('matchcfg').hidden = !edit && !netMode;
  const info = $('cfginfo');
  if (!edit && netMode) {
    info.hidden = false;
    info.innerHTML = `The host set this match: <b>${c.mode === 'team' ? 'Teams' : 'Free for all'}</b>, <b>${c.bots ? c.bots + ' bot' + (c.bots > 1 ? 's' : '') + ' (' + SKILL_NAMES[c.skill] + ')' : 'no bots'}</b>.`;
  } else if (edit && netMode && !matchOver) { info.hidden = false; info.textContent = 'Changing a setting restarts the match for everyone.'; }
  else info.hidden = true;
  const t = $('tgt'); if (t) t.textContent = netMode ? killTarget : (c.mode === 'team' ? 20 : 10);
}
for (const k in cfgSegs) cfgSegs[k].addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  hostCfg[k] = k === 'mode' ? b.dataset.v : +b.dataset.v;
  store.set('hostcfg', hostCfg);
  if (netMode && isHost) netSend({ t: 'cfg', cfg: hostCfg });
  updateHostUI();
});
function startLocal() {
  localMatch = new Match({ killTarget: 10, maxHumans: 1 });
  netMode = 'local'; online = true;
  localMe = localMatch.join(roleName(true), m => { const c = clone(m); setTimeout(() => onNet(c), 0); }, true, hostCfg, myProfile());
}
function connect(lobby) {
  return new Promise(resolve => {
    const p2p = P2P.status();
    if (location.protocol === 'file:' && !p2p) return resolve(false);
    if (webMode && !p2p) return resolve(false);
    let done = false;
    try { ws = p2p ? P2P.openSocket() : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { return resolve(false); }
    const giveUp = () => { if (!done) { done = true; try { ws.close(); } catch (e) { } ws = null; resolve(false); } };
    let to = setTimeout(giveUp, /^(localhost|127\.)/.test(location.hostname) ? 5000 : 12000);
    ws.onopen = () => { clearTimeout(to); to = setTimeout(giveUp, 20000); ws.send(JSON.stringify({ t: 'hello', ...myProfile(), name: roleName(p2p ? p2p.kind === 'host' : /^(localhost|127\.)/.test(location.hostname)), cfg: hostCfg, lobby: !!lobby })); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome' && !done) { done = true; clearTimeout(to); online = true; netMode = 'ws'; resolve(true); }
      if (m.t === 'full' && !done) { done = true; clearTimeout(to); resolve('full'); }
      onNet(m);
    };
    ws.onclose = () => { if (!done) { done = true; clearTimeout(to); resolve(false); } else if (online) { online = false; showBanner('Connection lost', P2P.status() ? (P2P.status().kind === 'host' ? 'The link to the other players dropped. Reload to host a new match.' : 'The host closed their game or the connection dropped. Reload and join again with the host\'s new code.') : /trycloudflare\.com$/.test(location.hostname) ? 'The host closed Tidebreak or the internet link dropped. Reload to rejoin, or ask the host for the new join code.' : 'The host stopped the server or the Wi-Fi dropped. Reload the page to rejoin.'); } };
    ws.onerror = () => { };
  });
}
function nameOf(id) { if (id === myId) return settings.name || 'You'; const p = playerInfo.get(id); return p ? p.name : 'Operator'; }
function colorOf(id) { const p = playerInfo.get(id); return p ? (p.team >= 0 ? TEAM_CSS[p.team] : p.bot ? '#d8d2c4' : PALETTE_CSS[colorIdx(p)]) : '#fff'; }
function applyScores(list) { for (const s of list) { const p = playerInfo.get(s.id); if (p) Object.assign(p, s); else playerInfo.set(s.id, { ...s }); } renderScore(); }

// ---- bots: simulated by one browser (the host's when connected), seen by everyone else like players
const bots = new Map();
const botCtx = {
  weapons: WEAPONS, nav: null, bots: [], now: () => performance.now() / 1000,
  los: (a, b) => !losBlocked(a, b), collide: collideCircle, groundAt: (x, z, r, f) => Math.max(SWIM_Y, groundAt(x, z, r, f)),
  clampPos: p => { p.x = clamp(p.x, MAP.x0 + 0.5, MAP.x1 - 0.5); p.z = clamp(p.z, MAP.z0 + 0.4, MAP.z1 - 0.5); },
  pickGoal: () => hideSpots.length && Math.random() < 0.75 ? hideSpots[Math.floor(Math.random() * hideSpots.length)].clone().add(new V3(R(-0.8, 0.8), 0, R(-0.8, 0.8))) : botCtx.nav.randomOpen()
};
function combatants() {
  const list = [];
  if (online && P.alive) list.push({ id: myId, pos: P.pos, crouch: P.crouch, alive: true, team: P.team, vel: P.vel });
  for (const r of remotes.values()) if (r.alive) list.push({ id: r.id, pos: r.pos, crouch: r.crouch, alive: true, team: r.team, vel: r.vel });
  return list;
}
function noiseForBots(pos, fromId) {
  const from = playerInfo.get(fromId);
  for (const b of bots.values()) if (b.id !== fromId && !(cfg.mode === 'team' && from && from.team === b.team)) b.hear(pos, fromId);
}
function nearMiss(a, e) {
  const myE = eye(); const seg = e.clone().sub(a); const L = seg.length(); if (L < 0.01) return; seg.divideScalar(L);
  const proj = clamp(myE.clone().sub(a).dot(seg), 0, L); const close = a.clone().addScaledVector(seg, proj).distanceTo(myE);
  if (close < 1.5 && P.alive && proj > 1) SFX.crack(a.clone().addScaledVector(seg, proj));
}
function botShot(b, ev, r, list) {
  const W = WEAPONS[ev.w];
  const hw = rayWorld(ev.o, ev.dir, W.range), far = hw ? hw.t : W.range;
  const hc = rayCombatants(ev.o, ev.dir, far, list, b.id);
  let endP;
  if (hc) {
    endP = ev.o.clone().addScaledVector(ev.dir, hc.t);
    if (!(cfg.mode === 'team' && hc.c.team === b.team)) {
      const dmg = Math.round(W.dmg * (W.botK || 1) * partK(W, hc.part) * R(0.92, 1.05));
      netSend({ t: 'hit', as: b.id, target: hc.c.id, dmg, head: hc.part === 'head', w: ev.w });
      if (hc.c.id !== myId) bloodPuff(endP, ev.dir.clone().negate());
    }
  } else if (hw) { endP = ev.o.clone().addScaledVector(ev.dir, hw.t); impact(endP, hw.n, hw.water); }
  else endP = ev.o.clone().addScaledVector(ev.dir, W.range);
  const mz = r ? r.muzzle() : ev.o;
  if (r) r.op.recoil = 1;
  if (Math.random() < 0.45 || ev.w === 1) tracer(mz, endP);
  worldFlash(mz, 40); SFX.shot(ev.w, mz, { supp: !!(r && lookFor(r.look).gun.supp && ev.w === 0), indoor: indoorAt(b.pos) });
  netSend({ t: 'shot', as: b.id, o: [mz.x, mz.y, mz.z], e: [endP.x, endP.y, endP.z], w: ev.w, n: hw && !hc ? hw.n : null, wt: !!(hw && hw.water && !hc) });
  noiseForBots(b.pos, b.id); nearMiss(mz, endP);
}
function updateBots(dt) {
  if (botOwner !== myId || !bots.size) return;
  botCtx.bots = [...bots.values()];
  const list = combatants();
  for (const b of botCtx.bots) {
    const ev = b.update(dt, list, cfg.skill);
    if (ev && ev.type === 'shot') botShot(b, ev, remotes.get(b.id), list);
  }
  bsendAcc += dt;
  if (bsendAcc >= 0.066) { bsendAcc = 0; const live = botCtx.bots.filter(b => b.alive); if (live.length) netSend({ t: 'bstate', b: live.map(b => [b.id, +b.pos.x.toFixed(2), +b.pos.y.toFixed(2), +b.pos.z.toFixed(2), +b.yaw.toFixed(3), +b.pitch.toFixed(3), +b.crouch.toFixed(2), b.w, b.flags]) }); }
}
function applyRoster(m) {
  if (m.cfg) cfg = m.cfg; if (m.target) killTarget = m.target; botOwner = m.owner || 0; if (m.teams) teamKills = m.teams;
  const ids = new Set(m.players.map(p => p.id));
  for (const id of [...playerInfo.keys()]) if (!ids.has(id)) { playerInfo.delete(id); const r = remotes.get(id); if (r) { r.dispose(); remotes.delete(id); } bots.delete(id); }
  const me = m.players.find(p => p.id === myId); if (me) P.team = me.team;
  for (const p of m.players) {
    playerInfo.set(p.id, { ...p });
    if (p.id === myId) continue;
    let r = remotes.get(p.id);
    if (r && (r.look !== p.look || r.camo !== p.camo)) { r.dispose(); remotes.delete(p.id); r = null; }
    if (!r) { r = new Remote(p); remotes.set(p.id, r); }
  }
  for (const [id, r] of remotes) r.setInfo(playerInfo.get(id));
  if (botOwner === myId) {
    for (const p of m.players) if (p.bot) {
      let b = bots.get(p.id); const r = remotes.get(p.id);
      if (!b) { b = new Bot(p.id, p.look, botCtx); bots.set(p.id, b); if (r && r.alive && p.alive && r.snaps.length) { b.pos.copy(r.pos); b.yaw = r.yaw; b.alive = true; b.mag = WEAPONS[b.w].mag; } }
      b.team = p.team; if (r) r.direct = b;
    }
  } else {
    for (const id of bots.keys()) { const r = remotes.get(id); if (r) { r.direct = null; r.snaps = []; r.push({ p: [r.pos.x, r.pos.y, r.pos.z], y: r.yaw, pi: r.pitch, c: r.crouch, w: r.w }); } }
    bots.clear();
  }
  targets.forEach(t => t.pivot.visible = netMode === 'local' && cfg.bots === 0);
  renderScore(); updateHostUI(); renderLobby();
}
function onNet(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.you; isHost = !!m.host; matchOver = m.over;
      applyRoster(m); if (m.rope) startRopeHeli(m.rope); if (m.drop) startDrop(m.drop);
      break;
    case 'roster': applyRoster(m); if (m.joined) { const p = playerInfo.get(m.joined); if (p) feed(`<b style="color:${colorOf(p.id)}">${esc(p.name)}</b> joined`); } break;
    case 'leave': { const r = remotes.get(m.id); feed(`${esc(nameOf(m.id))} left`); if (r) r.dispose(); remotes.delete(m.id); playerInfo.delete(m.id); bots.delete(m.id); renderScore(); break; }
    case 'gone':
      if (m.id === myId) { P.alive = false; P.deadT = 0; P.deadAt = 0; P.killer = null; P.rope = null; viewmodels.forEach(v => v.root.visible = false); showBanner('Switching teams', 'Respawning', 1500); }
      else { const r = remotes.get(m.id); if (r) r.hide(); const b = bots.get(m.id); if (b) b.alive = false; }
      break;
    case 'spawn': {
      if (m.id === myId) respawnLocal(m.s); else { const r = remotes.get(m.id); if (r) r.respawn(m.s); }
      const b = bots.get(m.id); if (b) b.spawn(SPAWNS[m.s][0], SPAWNS[m.s][1]);
      const p = playerInfo.get(m.id); if (p) { p.alive = true; p.hp = MAX_HP; } break;
    }
    case 'state': { const r = remotes.get(m.id); if (r && !r.direct) r.push(m); break; }
    case 'bstate': for (const e of m.b) { const r = remotes.get(e[0]); if (r && !r.direct) r.push({ p: [e[1], e[2], e[3]], y: e[4], pi: e[5], c: e[6], w: e[7], f: e[8] }); } break;
    case 'shot': {
      const r = remotes.get(m.id); const o = new V3(...m.o), e = new V3(...m.e);
      const mz = r && r.alive ? r.muzzle() : o;
      if (r) r.op.recoil = 1;
      if (Math.random() < 0.55 || m.w === 1) tracer(mz, e);
      worldFlash(mz, 50); SFX.shot(m.w, mz, { supp: !!(r && lookFor(r.look).gun.supp && m.w !== 2), indoor: indoorAt(mz) });
      if (m.n) impact(e, m.n, m.wt);
      nearMiss(mz, e); noiseForBots(mz, m.id);
      break;
    }
    case 'hp': {
      const p = playerInfo.get(m.id); if (p) p.hp = m.hp;
      const from = m.from ? (m.from === myId ? P.pos : (remotes.get(m.from) || {}).pos) : null;
      if (m.id === myId) {
        if (m.hp < P.hp) hurt(from || null, P.hp - m.hp);
        P.hp = m.hp;
      } else if (m.dmg) {
        const r = remotes.get(m.id); if (r) { r.op.flinch = 1; r.op.flinchDir = Math.random() < 0.5 ? 1 : -1; }
        const b = bots.get(m.id); if (b) b.hurtBy(from);
      }
      break;
    }
    case 'kill': {
      applyScores(m.scores); if (m.teams) teamKills = m.teams; renderScore();
      const kn = nameOf(m.killer), vn = nameOf(m.victim);
      const wn = m.w === 6 ? 'frag grenade' : WEAPONS[m.w] ? WEAPONS[m.w].name.toLowerCase() : '';
      if (m.killer) feed(`<b style="color:${colorOf(m.killer)}">${esc(kn)}</b> <span>${wn}${m.head ? ' · headshot' : ''}${m.d > 60 ? ' · ' + m.d + ' m' : ''}</span> <b style="color:${colorOf(m.victim)}">${esc(vn)}</b>`);
      else feed(`<b style="color:${colorOf(m.victim)}">${esc(vn)}</b> <span>${m.cause && CAUSE[m.cause] ? 'taken out by ' + CAUSE[m.cause] : 'fell'}</span>`);
      const b = bots.get(m.victim); if (b) b.alive = false;
      if (m.victim === myId) { const r = remotes.get(m.killer); dieLocal(r ? r.pos.clone() : null, m.killer ? kn : m.cause && CAUSE[m.cause] ? CAUSE[m.cause] : 'a fall', m.head, r ? m.killer : 0, m.d, wn); }
      else { const r = remotes.get(m.victim); if (r) r.die(m.killer === myId ? P.pos : (remotes.get(m.killer) || {}).pos); }
      if (m.killer === myId) { SFX.kill(); showHit('kill'); showBanner(m.head ? 'Headshot' : 'Eliminated', vn + (m.d > 60 ? ' · ' + m.d + ' m' : ''), 1600); bumpProg('kills'); if (m.head) bumpProg('heads'); }
      break;
    }
    case 'end': {
      applyScores(m.scores); if (m.teams) teamKills = m.teams; matchOver = true; lastAwards = m.awards || null;
      const team = m.team >= 0;
      const win = team ? m.team === P.team : m.winner === myId;
      if (win && deployed) bumpProg('wins');
      showBanner(win ? 'Victory' : team ? `Team ${TEAM_NAMES[m.team]} wins` : `${nameOf(m.winner)} wins`, 'New match starts in 10 seconds', 10000);
      showBoard(true); break;
    }
    case 'start': if (m.cfg) cfg = m.cfg; if (m.target) killTarget = m.target; teamKills = m.teams || [0, 0]; applyScores(m.scores); matchOver = false; lastAwards = null; $('board').hidden = true;
      showBanner('New match', cfg.mode === 'team' ? `Teams · first team to ${killTarget} kills` : `First to ${killTarget} kills`, 2500); break;
    case 'rope': startRopeHeli(m); break;
    case 'chat': chatAdd(`<b style="color:${colorOf(m.id)}">${esc(m.id === myId ? (settings.name || 'You') : m.name)}</b> ${esc(m.text)}`); if (m.id !== myId) SFX.blip(); break;
    case 'nade': { const r = remotes.get(m.id); addNade(m.k, new V3(...m.o), new V3(...m.v), m.f, false, m.id, m.n); if (m.k === 'l') SFX.boom(new V3(...m.o), 0.3); else if (r) SFX.mech('pouch', r.pos); break; }
    case 'boom': remoteBoom(m); break;
    case 'drop': startDrop(m); break;
    case 'taken': if (drop && drop.n === m.n) endDrop(); if (m.id) feed(`<b style="color:${colorOf(m.id)}">${esc(nameOf(m.id))}</b> <span>took the supply crate · grenade launcher</span>`); if (m.id === myId) giveLauncher(); break;
    case 'evict': startEviction(m.id); break;
    case 'pong': pingMs = Math.round(performance.now() - m.ts); break;
  }
}
function dieLocal(killerPos, killerName, head, killerId, dist, wn) {
  P.alive = false; P.deadT = 0; P.deadAt = performance.now(); P.killer = killerPos; P.adsHeld = false; mouseDown = false; P.rope = null; P.swim = false; P.ladder = null; P.slide = null; P.vault = null;
  P.killerId = killerId || 0; P.kcOn = false; P.killInfo = `Killed by <b>${esc(killerName)}</b>${wn ? ' · ' + wn : ''}${head ? ' · headshot' : ''}${dist ? ' · ' + dist + ' m' : ''}`;
  if (P.hasLauncher) { P.hasLauncher = false; updateSlotsHUD(); }
  laserDot.visible = false; closeChat(false);
  viewmodels.forEach(v => v.root.visible = false);
  showBanner('Killed', `by ${killerName}${head ? ' · headshot' : ''} · respawning`, RESPAWN_MS - 400);
}
function sendState(dt) {
  sendAcc += dt; if (sendAcc < 0.05) return; sendAcc = 0;
  if (!P.alive) return;
  const f = (P.reloadT > 0 ? 1 : 0) | (P.swim || P.ladder ? 2 : 0) | (P.rope ? 16 : 0) | (P.sprint > 0.5 ? 4 : 0) | (P.ads > 0.5 ? 8 : 0);
  netSend({ t: 'state', p: [+P.pos.x.toFixed(3), +P.pos.y.toFixed(3), +P.pos.z.toFixed(3)], y: +P.yaw.toFixed(3), pi: +P.pitch.toFixed(3), c: +P.crouch.toFixed(2), w: P.weapon > 3 ? 2 : P.weapon, f });
}
setInterval(() => { if (online) netSend({ t: 'ping', ts: performance.now() }); }, 2000);

// ======================================================= HUD
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let bannerTimer = 0;
function showBanner(t, s, ms = 0) { $('bannerT').textContent = t; $('bannerS').textContent = s || ''; $('banner').hidden = false; clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(hideBanner, ms); }
function hideBanner() { $('banner').hidden = true; }
let promptTimer = 0;
function showPrompt(t) { const p = $('prompt'); p.textContent = t; p.hidden = false; clearTimeout(promptTimer); promptTimer = setTimeout(() => p.hidden = true, 1600); }
function feed(html) { const d = document.createElement('div'); d.innerHTML = html; $('feed').prepend(d); while ($('feed').children.length > 5) $('feed').lastChild.remove(); setTimeout(() => d.remove(), 5200); }
let hitT = 0;
function showHit(kind) { const h = $('hit'); h.classList.toggle('kill', kind === 'kill' || kind === 'head'); h.style.opacity = 1; hitT = kind === 'kill' ? 0.35 : 0.15; SFX.hitmarker(kind === 'head'); }
let dmgFlash = 0;
// where you are hit matters: head is deadly, arms and legs soak up less
// Sniper rifle: a headshot always kills. A body shot hits hard and harder with range: 120 up close, rising to a
// killing 200 from 140 m out. Arms and legs take less.
function sniperDmg(part, dist) {
  if (part === 'head') return 260;
  const far = clamp((dist - 15) / 125, 0, 1);
  return (120 + 80 * far) * (part === 'leg' ? 0.7 : part === 'arm' ? 0.65 : 1);
}
function partK(w, part) { return part === 'head' ? w.head : part === 'leg' ? 0.7 : part === 'arm' ? 0.65 : 1; }
// host is Leon, whoever joins is Apollo (unless they typed some other callsign)
function roleName(host) {
  let n = (settings.name || '').trim();
  if (!n || /^Operator/.test(n) || (host && n === 'Apollo') || (!host && n === 'Leon')) n = host ? 'Leon' : 'Apollo';
  settings.name = n; $('name').value = n; store.set('name', n); return n;
}
const HITS = { p: new Spring(170, 0.32), y: new Spring(170, 0.32), r: new Spring(120, 0.3) };
function hurt(fromPos, dmg) {
  const heavy = dmg >= 100; // a sniper round: a much bigger jolt and a longer stagger
  const k = clamp(dmg / 30, 0.35, heavy ? 3.3 : 2.2);
  dmgFlash = Math.min(1, dmgFlash + dmg / 45); SFX.hurt(); SFX.thud(k);
  // the view snaps away from the hit, the gun jerks, you stagger for a moment
  let side = Math.random() < 0.5 ? -1 : 1;
  if (fromPos) { const d = fromPos.clone().sub(P.pos); side = Math.sign(angDiff(P.yaw, Math.atan2(-d.x, -d.z))) || side; }
  HITS.p.v += R(0.9, 1.5) * k; HITS.y.v -= side * R(0.8, 1.4) * k; HITS.r.v += side * R(0.8, 1.4) * k;
  P.pitch += R(0.006, 0.014) * k; P.yaw += side * R(0.004, 0.01) * k; // aim punch
  VMS.rx.v -= 6 * k; VMS.z.v += 2.5 * k; VMS.x.v += side * 1.5 * k;
  P.flinch = Math.min(heavy ? 1 : 0.6, P.flinch + (heavy ? 0.34 : 0.25) * k);
  if (fromPos) {
    const d = fromPos.clone().sub(P.pos); const ang = Math.atan2(-d.x, -d.z) - P.yaw;
    const i = document.createElement('i'); i.style.transform = `rotate(${-ang}rad)`; $('dmg').append(i); setTimeout(() => i.remove(), 1250);
  }
  const fl = $('hitflash'); fl.style.transition = 'none'; fl.style.opacity = Math.min(0.85, 0.3 + dmg / 60); requestAnimationFrame(() => { fl.style.transition = 'opacity .45s'; fl.style.opacity = 0; });
}
function renderScore() {
  const el = $('score');
  if (!online) { el.innerHTML = `<div class="p"><span>Practice</span><b>${practiceHits}</b></div><div class="to">Steel targets<br>head = 2</div>`; return; }
  if (cfg.mode === 'team') {
    el.innerHTML = [0, 1].map(t => `<div class="p" style="color:${TEAM_CSS[t]}"><span>${TEAM_NAMES[t]}${t === P.team ? ' (you)' : ''}</span><b>${teamKills[t] || 0}</b></div>`).join('') + `<div class="to">First<br>to ${killTarget}</div>`;
    return;
  }
  const list = [...playerInfo.values()].sort((a, b) => b.kills - a.kills);
  let shown = list.slice(0, 4);
  const meP = playerInfo.get(myId); if (meP && !shown.includes(meP)) shown = list.slice(0, 3).concat(meP);
  el.innerHTML = shown.map(p => `<div class="p" style="color:${colorOf(p.id)}"><span>${esc(p.id === myId ? (settings.name || 'You') : p.name)}</span><b>${p.kills}</b></div>`).join('') + `<div class="to">First<br>to ${killTarget}</div>`;
  if (list.length < 2) el.innerHTML += `<div class="to" style="color:var(--amber)">Waiting for<br>opponent</div>`;
}
let lastAwards = null;
function showBoard(final = false) {
  const b = $('board');
  if (!online) { b.innerHTML = `<h2>Practice range</h2><p>Hits: ${practiceHits}.</p>`; b.hidden = false; return; }
  const acc = p => p.sh ? Math.min(100, Math.round(p.hi / p.sh * 100)) + '%' : '·';
  const row = p => `<tr><td><i style="background:${colorOf(p.id)}"></i>${esc(p.id === myId ? (settings.name || 'You') + ' (you)' : p.name)}${p.bot ? ' <span style="color:var(--dim);font-size:11px">BOT</span>' : ''}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${(p.kills / Math.max(1, p.deaths)).toFixed(2)}</td><td>${acc(p)}</td><td>${p.hs || 0}</td><td>${p.lg ? p.lg + ' m' : '·'}</td></tr>`;
  const sort = l => l.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const head = `<thead><tr><th>Operator</th><th>Kills</th><th>Deaths</th><th>K/D</th><th>Accuracy</th><th>Headshots</th><th>Longest</th></tr></thead>`;
  let body;
  if (cfg.mode === 'team') body = [0, 1].map(t => `<tr><td colspan="7" style="color:${TEAM_CSS[t]};font:800 18px var(--display);text-transform:uppercase;padding-top:12px">${TEAM_NAMES[t]} · ${teamKills[t] || 0}</td></tr>` + sort([...playerInfo.values()].filter(p => p.team === t)).map(row).join('')).join('');
  else body = sort([...playerInfo.values()]).map(row).join('');
  let aw = '';
  if (final && lastAwards) {
    const card = (k, title, fmt) => { const a = lastAwards[k]; return a && a.v > 0 || (a && k === 'mvp') ? `<div><span>${title}</span><b style="color:${colorOf(a.id)}">${esc(nameOf(a.id))}</b><em>${fmt(a.v)}</em></div>` : ''; };
    aw = `<div id="awards">${card('mvp', 'Most valuable', () => 'best all-round match')}${card('acc', 'Sharpest shooter', v => v + '% accuracy')}${card('snipe', 'Longest sniper shot', v => v + ' m')}${card('heads', 'Headhunter', v => v + ' headshot' + (v === 1 ? '' : 's'))}${card('long', 'Longest kill', v => v + ' m')}</div>`;
  }
  b.innerHTML = `<h2>${final ? 'Match over' : 'Scoreboard'}</h2>${aw}<table>${head}<tbody>${body}</tbody></table><p>${cfg.mode === 'team' ? 'Teams' : 'Free for all'} · first to ${killTarget} kills · ${netMode === 'local' ? 'offline practice' : 'ping ' + pingMs + ' ms'}</p>`;
  b.hidden = false;
}
function hideBoard() { if (!matchOver) $('board').hidden = true; }
function updateSlotsHUD() { $('slots').innerHTML = WEAPONS.map((w, i) => w.launch && !P.hasLauncher ? '' : `<span class="${i === P.weapon ? 'on' : ''}">${i + 1} ${w.launch ? 'Launcher' : w.name.split(' ')[0]}</span>`).join(''); }
let lastHud = '';
function updateHUD(dt) {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  const s = `${a.mag}|${a.reserve}|${P.hp}|${P.weapon}|${P.reloadT > 0}`;
  if (s !== lastHud) {
    lastHud = s;
    $('ammo').innerHTML = `${a.mag}<small> / ${a.reserve}</small>`;
    $('wname').textContent = P.reloadT > 0 ? 'Reloading…' : w.name;
    $('hpnum').textContent = Math.max(0, Math.round(P.hp));
    $('hpbar').firstElementChild.style.width = clamp(P.hp / MAX_HP * 100, 0, 100) + '%';
    $('hpbar').classList.toggle('low', P.hp < 50);
  }
  // crosshair spread
  const speed = Math.hypot(P.vel.x, P.vel.z);
  const gap = 5 + (lerp(w.hip, w.ads, P.ads) * (1 + speed * 0.25) * (P.onGround ? 1 : P.rope ? 1.6 : 3) + P.kick * 0.02) * 260;
  const cr = $('cross').children; cr[0].style.left = (-gap - 9) + 'px'; cr[1].style.left = gap + 'px'; cr[2].style.top = (-gap - 9) + 'px'; cr[3].style.top = gap + 'px';
  $('cross').style.opacity = P.alive && !P.swim && !P.ladder ? (w.scope ? 1 - P.ads : 1 - P.ads * 0.9) * (1 - P.sprint) : 0;
  $('scope').style.opacity = w.scope && P.alive ? clamp((P.ads - 0.75) * 5, 0, 1) : 0;
  if (w.scope && P.ads > 0.75) { // scope shadow shifts with recoil and sway, like looking through a real tube
    const sx = clamp(VMS.x.x * 0.25 + P.recY.x * 6 + P.swayX * 40, -5, 5), sy = clamp(VMS.y.x * 0.25 - P.recP.x * 6 + VMS.z.x * 0.2 + P.swayY * 40, -5, 5);
    document.querySelector('#scope .ring').style.transform = `translate(${sx.toFixed(2)}vmin,${sy.toFixed(2)}vmin)`;
    $('scopeZoom').textContent = P.zoom2 ? '5.4×' : '13.5×';
    $('scopeBreath').innerHTML = P.breathOut > 0 ? '<b>OUT OF BREATH</b>' : P.holdingBreath ? '<b>HOLDING BREATH</b>' : 'HOLD SHIFT TO STEADY · SCROLL TO ZOOM';
  }
  if (hitT > 0) { hitT -= dt; if (hitT <= 0) $('hit').style.opacity = 0; }
  dmgFlash = Math.max(0, dmgFlash - dt * 0.9);
  grade.uniforms.dmg.value = Math.max(dmgFlash, P.alive ? clamp((60 - P.hp) / 60, 0, 1) * 0.6 : 0.8);
  { const key = `${perf.fps}|${online}|${pingMs}`; if (perf.shown !== key) { perf.shown = key; $('net').textContent = (netMode === 'local' ? 'Offline practice' : online ? `${viaTunnelHost() ? 'Online' : 'Wi-Fi'} · ${pingMs} ms` : 'Practice range') + (perf.fps ? ` · ${perf.fps} fps` : ''); } }
}


// ======================================================= INFRARED SENSOR
// A helmet sensor every player carries (F). It shows warm bodies through walls for a few seconds, then has to rest and recharge.
const IR = { on: false, bat: 1, cool: 0, rest: 9, k: 0, shown: '', RANGE: 70, LIFE: 5, CHARGE: 18 };
const heatMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false, depthWrite: false, transparent: true, fog: false });
function setHeat(r, hot) {
  if (!!r.hot === hot) return; r.hot = hot;
  r.op.g.traverse(o => {
    if (!o.isMesh) return;
    if (hot) { if (!o.userData.mat0) o.userData.mat0 = o.material; o.material = heatMat; o.renderOrder = 60; }
    else if (o.userData.mat0) { o.material = o.userData.mat0; o.renderOrder = 0; }
  });
}
function toggleIR() {
  if (!P.alive) return;
  if (IR.on) { IR.on = false; IR.rest = 0; SFX.ir(false); return; }
  if (IR.cool > 0 || IR.bat < 0.2) { SFX.click(); showPrompt(IR.cool > 0 ? 'Infrared sensor cooling down' : 'Infrared battery still charging'); return; }
  IR.on = true; SFX.ir(true);
}
function updateIR(dt) {
  if (IR.on && !P.alive) IR.on = false;
  if (IR.on) { IR.bat -= dt / IR.LIFE; if (IR.bat <= 0) { IR.bat = 0; IR.on = false; IR.cool = 4; IR.rest = 0; SFX.ir(false); showPrompt('Infrared battery drained'); } }
  else { IR.cool = Math.max(0, IR.cool - dt); IR.rest += dt; if (IR.rest > 1.5) IR.bat = Math.min(1, IR.bat + dt / IR.CHARGE); }
  IR.k = lerp(IR.k, IR.on ? 1 : 0, Math.min(1, dt * 10)); grade.uniforms.ir.value = IR.k < 0.01 ? 0 : IR.k;
  for (const r of remotes.values()) setHeat(r, IR.on && r.alive && !isFriend(r.id) && r.pos.distanceToSquared(P.pos) < IR.RANGE * IR.RANGE);
  const key = (IR.on ? 'on' : IR.cool > 0 ? 'cool' : IR.bat < 0.2 ? 'low' : IR.bat < 1 ? 'chg' : 'ok') + Math.round(IR.bat * 50);
  if (key !== IR.shown) {
    IR.shown = key; const bar = $('irbar'); bar.firstElementChild.style.width = (IR.bat * 100).toFixed(0) + '%';
    bar.className = IR.on ? 'on' : IR.cool > 0 || IR.bat < 0.2 ? 'low' : '';
    $('irlabel').textContent = IR.on ? 'Infrared on' : IR.cool > 0 ? 'Infrared cooling down' : IR.bat < 1 ? 'F · Infrared charging' : 'F · Infrared ready';
  }
}

// ======================================================= TEXT CHAT + LOBBY
let chatOpen = false, inLobby = false, deployed = false, profT = 0;
function chatAdd(html, sys) {
  for (const [id, max] of [['chatlog', 7], ['lobbylog', 60]]) {
    const d = document.createElement('div'); d.innerHTML = html; if (sys) d.className = 'sys';
    const el = $(id); el.append(d); while (el.children.length > max) el.firstChild.remove();
    if (id === 'chatlog') { setTimeout(() => d.classList.add('old'), 9000); setTimeout(() => d.remove(), 90000); } else el.scrollTop = el.scrollHeight;
  }
}
function chatSend(text) {
  text = String(text || '').trim().slice(0, 140); if (!text) return;
  if (!online) { chatAdd('Chat works once you are in a match.', true); return; }
  netSend({ t: 'chat', text });
}
function openChat() {
  if (chatOpen || gameState !== 'play') return;
  chatOpen = true; const i = $('chatinput'); i.hidden = false; i.value = ''; $('chatlog').classList.add('typing');
  for (const k in keys) keys[k] = false; mouseDown = false; P.adsHeld = false; setTimeout(() => i.focus(), 0);
}
function closeChat(send) {
  if (!chatOpen) return; const i = $('chatinput'); chatOpen = false; if (send) chatSend(i.value);
  i.hidden = true; i.blur(); $('chatlog').classList.remove('typing');
}
$('chatinput').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') closeChat(true); else if (e.key === 'Escape') closeChat(false); });
$('chatinput').addEventListener('keyup', e => e.stopPropagation());
$('chatinput').addEventListener('blur', () => closeChat(false));
const myProfile = () => ({ name: settings.name, color: settings.color, camo: settings.camo });
function sendProfile() { clearTimeout(profT); profT = setTimeout(() => { if (online) netSend({ t: 'profile', ...myProfile() }); renderLobby(); }, 350); }
function renderLobby() {
  if (!inLobby) return;
  const list = [...playerInfo.values()].filter(p => !p.bot).sort((a, b) => a.slot - b.slot);
  $('lobbylist').innerHTML = list.map(p => `<div><i style="background:${colorOf(p.id)}"></i><b>${esc(p.id === myId ? (settings.name || 'You') : p.name)}</b>${p.host ? '<em>host</em>' : ''}${p.id === myId ? '<em>you</em>' : ''}<span>${p.ready ? 'in the fight' : 'in the lobby'}</span></div>`).join('')
    + (list.length < 4 ? `<div class="open">${4 - list.length} open slot${list.length === 3 ? '' : 's'} · share the match code</div>` : '');
}
// Website matches open a lobby first: everyone who has the code sees who is there, can chat and set up, then deploys.
async function enterLobby(code) {
  if (inLobby || joined) return;
  inLobby = true; $('lobby').hidden = false; $('lobbycode').textContent = code;
  const ok = await connect(true);
  if (ok !== true) { inLobby = false; $('lobby').hidden = true; if (ok === 'full') setStatus('That match is full (4 players).', 'warn'); return ok; }
  joined = true; renderScore(); renderLobby(); deployBtn.textContent = 'Deploy';
  chatAdd('You are in the lobby. Set your name, colour and loadout, say hello, then press Deploy.', true);
}
{ const say = () => { const i = $('lobbyinput'); chatSend(i.value); i.value = ''; };
  $('lobbysend').addEventListener('click', say);
  $('lobbyinput').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') say(); }); }

// ======================================================= LOADOUT + UNLOCKS
// Progress is kept in this browser: kills, headshots and wins unlock uniforms and weapon finishes.
const prog = Object.assign({ kills: 0, heads: 0, wins: 0 }, store.get('prog', {}));
const UNIFORMS = [['std', 'Issued'], ['lizard', 'Lizard'], ['woodland', 'Woodland'], ['arid', 'Desert'], ['black', 'Night', 'kills', 3], ['aegean', 'Aegean blue and white', 'kills', 5]];
const FINISHES = [['std', 'Standard', 0, 0, [0x1b1c1e, 0x8b7556, 0x2a2c2f]], ['tan', 'Desert tan', 0, 0, [0x7d6a4c, 0x9a8463, 0x3a3a38]], ['aegean', 'Aegean', 'kills', 8, [0x1f5fa8, 0xe8ecef, 0x2d3034]],
  ['bronze', 'Hoplite bronze', 'heads', 4, [0x3a2a1c, 0x8a5a2b, 0xa87238]], ['gold', 'Olympian gold', 'wins', 2, [0x18181a, 0x18181a, 0xd4a83a]]];
const PRIMARIES = ['Machine gun', 'Sniper rifle', 'Shotgun'], NEED = { kills: 'kills', heads: 'headshots', wins: 'wins' };
const unlocked = it => !it[2] || prog[it[2]] >= it[3];
function applyFinish() {
  const f = FINISHES.find(f => f[0] === settings.skin && unlocked(f)) || FINISHES[0]; settings.skin = f[0];
  VM.polymer.color.setHex(f[4][0]); VM.fde.color.setHex(f[4][1]); VM.metal.color.setHex(f[4][2]); VM.metal.roughness = f[0] === 'gold' || f[0] === 'bronze' ? 0.24 : 0.33;
}
function applyUniform() {
  const u = UNIFORMS.find(u => u[0] === settings.camo && unlocked(u)) || UNIFORMS[0]; settings.camo = u[0];
  const t = u[0] === 'std' ? null : camoTexture(u[0]); VM.sleeve.map = t; VM.sleeve.color.setHex(t ? 0xffffff : 0x4b4d3a); VM.sleeve.needsUpdate = true;
}
function renderLoadout() {
  $('prog').textContent = `${prog.kills} kills · ${prog.heads} headshots · ${prog.wins} wins`;
  $('lprimary').innerHTML = PRIMARIES.map((n, i) => `<button type="button" data-v="${i}" aria-pressed="${settings.primary === i}">${n}</button>`).join('');
  $('lcolor').innerHTML = PALETTE_CSS.map((c, i) => `<button type="button" data-v="${i}" style="background:${c}" aria-pressed="${settings.color === i}" aria-label="Armband colour ${i + 1}"></button>`).join('');
  const seg = (list, cur) => list.map(it => unlocked(it) ? `<button type="button" data-v="${it[0]}" aria-pressed="${cur === it[0]}">${it[1]}</button>` : `<button type="button" disabled>${it[1]} · ${it[3]} ${NEED[it[2]]}</button>`).join('');
  $('lcamo').innerHTML = seg(UNIFORMS, settings.camo); $('lskin').innerHTML = seg(FINISHES, settings.skin);
}
{ const pick = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; fn(b.dataset.v); renderLoadout(); });
  pick('lprimary', v => { settings.primary = +v; store.set('primary', +v); });
  pick('lcolor', v => { settings.color = +v; store.set('color', +v); sendProfile(); });
  pick('lcamo', v => { settings.camo = v; store.set('camo', v); applyUniform(); sendProfile(); });
  pick('lskin', v => { settings.skin = v; store.set('skin', v); applyFinish(); }); }
function bumpProg(k) {
  const all = UNIFORMS.concat(FINISHES), was = all.filter(unlocked); prog[k]++; store.set('prog', prog);
  for (const it of all) if (unlocked(it) && !was.includes(it)) { feed(`<b style="color:var(--amber)">Unlocked</b> <span>${it[1]} ${UNIFORMS.includes(it) ? 'uniform' : 'weapon finish'} · pick it in the menu</span>`); SFX.blip(); }
  renderLoadout();
}
applyFinish(); applyUniform(); renderLoadout();

// ======================================================= THREAT WARNING + SEARCHLIGHT
// When the navy or air force is hunting you the screen says so: what it is, where it is, and how close it is to firing.
const threat = { pos: new V3(), level: 0, live: 0, beep: 0, label: '', shown: '' };
function setThreat(label, pos, level) {
  if (threat.live > 0 && level < threat.level && threat.label !== label) return;
  threat.label = label; threat.pos.copy(pos); threat.level = clamp(level, 0, 1); threat.live = 0.3;
}
function updateThreat(dt) {
  threat.live -= dt; const el = $('threat'), on = threat.live > 0 && P.alive;
  if (el.hidden === on) el.hidden = !on;
  if (!on) { if (threat.shown) { threat.shown = ''; $('threatedge').style.opacity = 0; } threat.level = 0; return; }
  const d = threat.pos.clone().sub(P.pos), L = threat.level;
  const txt = `${threat.label} · ${L > 0.85 ? 'INCOMING' : L > 0.45 ? 'LOCKED ON' : 'TARGETING YOU'} · ${Math.round(d.length())} m`;
  if (txt !== threat.shown) { threat.shown = txt; $('threattext').textContent = txt; el.classList.toggle('hot', L > 0.85); }
  $('threatarrow').style.transform = `rotate(${(P.yaw - Math.atan2(-d.x, -d.z)).toFixed(2)}rad)`;
  threat.beep -= dt; if (threat.beep <= 0) { threat.beep = lerp(0.8, 0.11, L); SFX.lock(L); }
  $('threatedge').style.opacity = (L * (0.5 + 0.4 * Math.sin(elapsed * lerp(6, 22, L)))).toFixed(2);
}
const SL = { cone: null, pool: null, at: new V3(), live: 0 };
function searchlight(from, dt) { // a beam from the hunter that sweeps across the ground, finds you and stays on you
  if (!SL.cone) {
    SL.cone = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 0.3, 1, 24, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.96, 0.82), blending: THREE.AdditiveBlending, transparent: true, opacity: 0.075, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,250,225,1)'); gr.addColorStop(0.7, 'rgba(255,245,210,.75)'); gr.addColorStop(1, 'rgba(255,240,200,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    SL.pool = new THREE.Mesh(new THREE.CircleGeometry(3.9, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, transparent: true, opacity: 0.5, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    SL.cone.frustumCulled = SL.pool.frustumCulled = false; SL.cone.renderOrder = SL.pool.renderOrder = 5; scene.add(SL.cone, SL.pool);
  }
  SL.live = 0.25; SL.at.lerp(P.pos, Math.min(1, dt * 1.7));
  const gy = Math.max(groundAt(SL.at.x, SL.at.z, 0.2, P.pos.y + 0.6), isLand(SL.at.x, SL.at.z) ? 0 : SEA_Y);
  SL.pool.position.set(SL.at.x, gy + 0.07, SL.at.z);
  SL.cone.position.copy(from); SL.cone.lookAt(SL.pool.position); SL.cone.scale.set(1, 1, from.distanceTo(SL.pool.position));
}
function updateSearchlight(dt) { SL.live -= dt; if (SL.cone) SL.cone.visible = SL.pool.visible = SL.live > 0; }

// ======================================================= EXPLOSIONS THAT LINGER
const fireballs = [], fires = [];
for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.2, 1.2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false })); m.visible = false; m.frustumCulled = false; scene.add(m); fireballs.push({ m, t: 0, dur: 1, s: 1 }); }
let fireballIdx = 0;
function fireball(p, big) { const f = fireballs[fireballIdx++ % fireballs.length]; f.m.position.copy(p); f.t = 0; f.dur = 0.32 + big * 0.14; f.s = 1.6 * big; f.m.visible = true; }
function updateFire(dt) {
  for (const f of fireballs) { if (!f.m.visible) continue; f.t += dt; const k = f.t / f.dur; if (k >= 1) { f.m.visible = false; continue; } f.m.scale.setScalar(f.s * (0.35 + 1.5 * Math.sqrt(k))); f.m.material.opacity = (1 - k) * (1 - k); }
  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i]; f.t -= dt; if (f.t <= 0) { fires.splice(i, 1); continue; }
    f.a += dt * 34 * Math.min(1, f.t / 2);
    while (f.a > 1) {
      f.a--; const q = f.p.clone().add(new V3(R(-0.8, 0.8), R(0, 0.3), R(-0.8, 0.8)));
      sparks.spawn(q, new V3(R(-0.5, 0.5), R(1.2, 3.4), R(-0.5, 0.5)), R(0.3, 0.7), R(0.05, 0.11), new THREE.Color(R(7, 10), R(2.6, 4.2), 0.8), -1.5);
      if (Math.random() < 0.3) { smoke.spawn(q.add(new V3(0, 0.6, 0)), new V3(R(-0.4, 0.4), R(1.5, 3), R(-0.4, 0.4)), R(1.6, 3), R(0.4, 0.9), new THREE.Color(0x2a2623), -0.5, false, 0.8); smoke.p[smoke.p.length - 1].grow = true; }
    }
  }
}
function cannonHit(e, k = 1) { // a 20 mm round landing: dirt fountain, dust, and it shakes you if it is close
  impact(e, [0, 1, 0], false, 2);
  for (let i = 0; i < 6 * k; i++) debris.spawn(e, new V3(R(-1.6, 1.6), R(4, 9.5), R(-1.6, 1.6)), R(0.5, 1.1), R(0.03, 0.08), new THREE.Color(0x5a4d3e), 14);
  smoke.spawn(e.clone().add(new V3(0, 0.3, 0)), new V3(R(-0.6, 0.6), R(1.5, 3), R(-0.6, 0.6)), R(0.8, 1.5), R(0.35, 0.7), new THREE.Color(0xa59682), -0.2, false, 1.6); smoke.p[smoke.p.length - 1].grow = true;
  const d = e.distanceTo(P.pos); if (d < 7) { const s = (1 - d / 7) * k; HITS.p.v += R(0.8, 1.8) * s; HITS.r.v += R(-1.6, 1.6) * s; HITS.y.v += R(-1, 1) * s; }
}

// ======================================================= GRENADES, FLASHBANGS AND THE LAUNCHER
// Two frags (G) and one flashbang (X) per life, more at any ammo crate. The thrower's game decides who a blast hurts.
const NADE = { f: { fuse: 2.5, R: 7.5, dmg: 215, w: 6, speed: 17, say: 'Frag out' }, s: { fuse: 1.7, speed: 17, say: 'Flashbang out' }, l: { fuse: 4, R: 6, dmg: 175, w: 4, speed: 40, impact: true } };
const nades = []; let nadeN = 0;
const nadeGeo = new THREE.SphereGeometry(0.055, 10, 8), nadeMats = { f: std({ color: 0x3f4a2c, roughness: 0.7 }), s: std({ color: 0xb9bdc0, roughness: 0.4, metalness: 0.6 }), l: std({ color: 0xc8963c, roughness: 0.35, metalness: 0.9 }) };
const aimDir = () => new V3(0, 0, -1).applyEuler(new THREE.Euler(aimPitch(), aimYaw(), 0, 'YXZ'));
function addNade(k, o, v, fuse, mine, id, n) {
  if (!NADE[k]) return;
  const m = new THREE.Mesh(nadeGeo, nadeMats[k]); m.castShadow = true; if (k === 's') m.scale.set(0.8, 1.5, 0.8); m.position.copy(o); scene.add(m);
  nades.push({ k, p: o.clone(), v: v.clone(), t: fuse, mine, id, n, m, rest: false, age: 0 });
}
function launchNade(k, o, v) {
  const n = ++nadeN, f = NADE[k].fuse; addNade(k, o, v, f, true, myId, n);
  netSend({ t: 'nade', k, o: o.toArray().map(x => +x.toFixed(2)), v: v.toArray().map(x => +x.toFixed(2)), f, n });
}
function throwNade(k) {
  if (!P.alive || P.throwCD > 0 || P.swim || P.ladder || P.vault || gameState !== 'play') return;
  if (k === 'f' ? P.frags <= 0 : P.flashes <= 0) { SFX.click(); showPrompt(k === 'f' ? 'No frag grenades left · restock at an ammo crate' : 'No flashbangs left · restock at an ammo crate'); return; }
  if (k === 'f') P.frags--; else P.flashes--;
  P.throwCD = 0.9; P.switchT = Math.max(P.switchT, 0.32); P.reloadT = 0; P.rl = null;
  const dir = aimDir(), e = eye(), o = rayWorld(e, dir, 0.7) ? e : e.clone().addScaledVector(dir, 0.45).add(new V3(0, -0.1, 0));
  launchNade(k, o, dir.multiplyScalar(NADE[k].speed).add(new V3(P.vel.x * 0.6, 3.6, P.vel.z * 0.6)));
  SFX.mech('pouch'); setTimeout(() => SFX.mech('slap'), 90); VMS.rx.v -= 3; showPrompt(NADE[k].say); updateNadesHUD();
}
function fireLauncher() {
  const w = WEAPONS[LAUNCHER], a = P.ammo[LAUNCHER], vm = viewmodels[LAUNCHER];
  if (a.mag <= 0) { SFX.click(); P.fireCD = 0.3; return; }
  a.mag--; P.shots++; P.fireCD = 60 / w.rpm; P.lastShot = performance.now();
  const dir = aimDir(), e = eye(), o = rayWorld(e, dir, 0.9) ? e : e.clone().addScaledVector(dir, 0.7).add(new V3(0, -0.06, 0));
  launchNade('l', o, dir.clone().multiplyScalar(NADE.l.speed).add(new V3(0, 1.2, 0)));
  vm.flash.visible = true; vm.flash.rotation.z = Math.random() * 6; const fs = vm.flashS * R(0.8, 1.2); vm.flash.scale.set(fs, fs, fs); vm._flashT = 0.05; vm.drumA = Math.PI / 3;
  wFlash.position.copy(vm.muzzle).applyMatrix4(vm.root.matrix); wFlash.intensity = 3.5; worldFlash(o, 40);
  for (let i = 0; i < 4; i++) { smoke.spawn(o, dir.clone().multiplyScalar(R(1, 3)).add(new V3(R(-0.3, 0.3), R(0.1, 0.5), R(-0.3, 0.3))), R(0.5, 0.9), R(0.07, 0.13), new THREE.Color(0xb0aba2), -0.2, false, 2); smoke.p[smoke.p.length - 1].grow = true; }
  P.recP.v += w.kickV * 34; P.climb += w.kickV * 0.3; P.fovKick = Math.min(2.6, P.fovKick + w.punch);
  VMS.z.v += w.vk.z; VMS.rx.v += w.vk.rx; VMS.rz.v += w.vk.rz * R(-1, 1); HITS.r.v += R(-1, 1) * w.shake; HITS.p.v += 0.5 * w.shake;
  SFX.thump(); noiseForBots(P.pos, myId);
  if (a.mag === 0) setTimeout(() => { if (P.hasLauncher && P.ammo[LAUNCHER].mag === 0) { P.hasLauncher = false; if (P.weapon === LAUNCHER) setWeapon(P.prevWeapon === LAUNCHER ? 0 : P.prevWeapon); else updateSlotsHUD(); showPrompt('Launcher empty · dropped'); } }, 750);
}
function updateNades(dt) {
  for (let i = nades.length - 1; i >= 0; i--) {
    const g = nades[i]; g.t -= dt; g.age += dt;
    if (!g.rest) {
      g.v.y -= 15 * dt; let left = dt, guard = 0;
      while (left > 1e-4 && guard++ < 3) {
        const sp = g.v.length(); if (sp < 1e-3) break;
        const d = g.v.clone().divideScalar(sp), hw = rayWorld(g.p, d, sp * left + 0.07);
        if (!hw) { g.p.addScaledVector(g.v, left); break; }
        const adv = Math.max(0, hw.t - 0.07); g.p.addScaledVector(d, adv); left -= adv / sp;
        if (NADE[g.k].impact) { if (g.mine) g.t = 0; g.rest = true; break; }
        if (hw.water) { impact(g.p, hw.n, true); g.v.set(0, 0, 0); g.rest = true; break; }
        const N = new V3(...hw.n), vn = g.v.dot(N); g.v.addScaledVector(N, -1.4 * vn).multiplyScalar(0.66);
        if (sp > 3) SFX.mech('shell', g.p);
        if (N.y > 0.6 && g.v.length() < 1.7) { g.v.set(0, 0, 0); g.rest = true; break; }
      }
      g.m.rotation.x += dt * 11; g.m.rotation.z += dt * 7;
    }
    g.m.position.copy(g.p);
    if (g.k !== 'l' && Math.random() < dt * 14) { smoke.spawn(g.p, new V3(0, 0.4, 0), 0.5, 0.03, new THREE.Color(0xc8c4bc), -0.2, false, 1); }
    if (g.mine ? g.t <= 0 : g.t < -1.5) {
      scene.remove(g.m); nades.splice(i, 1);
      if (g.mine) { netSend({ t: 'boom', k: g.k, p: g.p.toArray().map(x => +x.toFixed(2)), n: g.n }); explode(g.k, g.p, true, myId); }
    }
  }
}
function remoteBoom(m) { // the thrower's game says where and when its grenade went off
  const i = nades.findIndex(g => !g.mine && g.id === m.id && g.n === m.n); if (i >= 0) { scene.remove(nades[i].m); nades.splice(i, 1); }
  explode(m.k, new V3(...m.p), false, m.id);
}
function explode(k, p, mine, by) {
  if (!NADE[k]) return;
  if (k === 's') { flashBang(p); noiseForBots(p, by); return; }
  const N = NADE[k], c = p.clone().add(new V3(0, 0.35, 0));
  boom(c, k === 'l' ? 1.15 : 1.25); noiseForBots(p, by);
  if (!mine) return;
  const hurt = tp => { const d = tp.distanceTo(c); return d > N.R || (d > 1.3 && losBlocked(c, tp)) ? 0 : Math.round(N.dmg * Math.pow(1 - d / N.R, 1.15)); };
  let any = false;
  for (const r of remotes.values()) { if (!r.alive || isFriend(r.id)) continue; const dmg = hurt(r.pos.clone().add(new V3(0, 1, 0))); if (dmg > 0) { netSend({ t: 'hit', target: r.id, dmg, head: false, w: N.w }); P.hits++; any = true; } }
  for (const t of targets) if (t.up && t.pivot.visible && t.pivot.position.distanceTo(p) < 4.5) { hitTarget(t, false); any = true; }
  if (any) showHit('hit');
  if (P.alive) { const dmg = Math.round(hurt(P.pos.clone().add(new V3(0, 1, 0))) * 0.8); if (dmg > 0) netSend({ t: 'fall', dmg, cause: 'blast' }); }
}
function flashBang(p) {
  const c = p.clone().add(new V3(0, 0.3, 0)); worldFlash(c, 1400);
  for (let i = 0; i < 26; i++) sparks.spawn(c, new V3(R(-1, 1), R(-0.2, 1), R(-1, 1)).multiplyScalar(R(5, 14)), R(0.15, 0.4), 0.04, new THREE.Color(12, 12, 11), 4, true);
  for (let i = 0; i < 6; i++) { smoke.spawn(c, new V3(R(-1, 1), R(0.5, 2), R(-1, 1)), R(1, 2), R(0.3, 0.6), new THREE.Color(0xd8d8d4), -0.3, false, 1.5); smoke.p[smoke.p.length - 1].grow = true; }
  SFX.bang(c);
  if (!P.alive) return; const e = eye(), d = e.distanceTo(c); if (d > 26) return;
  const facing = aimDir().dot(c.clone().sub(e).normalize()), k = (1 - d / 26) * (losBlocked(c, e) ? 0.1 : facing > 0.2 ? 1 : facing > -0.3 ? 0.6 : 0.32);
  if (k < 0.07) return;
  P.blind = Math.max(P.blind, 1.2 + 3.2 * k); P.deaf = Math.max(P.deaf, 1 + 3.6 * k); SFX.ring(1 + 3.4 * k, 0.1 + 0.2 * k);
}
function updateBlind(dt) {
  if (P.blind > 0 || P.deaf > 0 || P._white) {
    P.blind = Math.max(0, P.blind - dt); P.deaf = Math.max(0, P.deaf - dt);
    const o = clamp(P.blind / 1.2, 0, 1); P._white = o > 0; $('white').style.opacity = o.toFixed(3);
  }
  if (masterGain) masterGain.gain.setTargetAtTime(settings.vol * lerp(1, 0.12, clamp(P.deaf / 1.4, 0, 1)), AC.currentTime, 0.08);
}
function updateNadesHUD() {
  $('nades').innerHTML = `G Frag <b>${'●'.repeat(P.frags)}${'○'.repeat(Math.max(0, 2 - P.frags))}</b> · X Flash <b>${'●'.repeat(P.flashes)}${'○'.repeat(Math.max(0, 1 - P.flashes))}</b>`;
}
// the sidearm's green laser: a faint beam off the frame and a dot where the muzzle points
const laserDot = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 7, 0.9), fog: false })); laserDot.visible = false; scene.add(laserDot);
function updateLaser(vm) {
  const on = !!vm.pistol && P.alive && P.reloadT <= 0 && P.sprint < 0.3 && P.switchT <= 0 && vm.root.visible;
  for (const v of viewmodels) if (v.beam) v.beam.visible = on;
  laserDot.visible = false; if (!on) return;
  const o = eye(), d = aimDir(), hw = rayWorld(o, d, 90); if (!hw) return;
  laserDot.position.copy(o).addScaledVector(d, Math.max(0.1, hw.t - 0.03)); laserDot.scale.setScalar(0.005 + hw.t * 0.0021); laserDot.visible = true;
}

// ======================================================= SUPPLY DROP
// Now and then a crate comes down under a blue and white parachute. First player to reach it gets the grenade launcher.
let drop = null; const DROP_FALL = 14;
let CHUTE_M = null, CRATE_M = null;
function startDrop(m) {
  endDrop();
  if (!CHUTE_M) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 32; const g = c.getContext('2d');
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f2f3f0' : '#1f5fa8'; g.fillRect(i * 32, 0, 32, 32); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    CHUTE_M = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, side: THREE.DoubleSide });
    CRATE_M = std({ color: 0x4a5136, roughness: 0.8, metalness: 0.1 });
  }
  const age = (m.age || 0) / 1000, gy = Math.max(0, groundAt(m.x, m.z, 0.6, 3)), g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.8, 0.85), CRATE_M); box.position.y = 0.4; box.castShadow = true; g.add(box);
  for (const x of [-0.36, 0.36]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.83, 0.88), VM.link); s.position.set(x, 0.4, 0); g.add(s); }
  for (const sz of [-1, 1]) { const f = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.28), VM.sticker); f.position.set(0, 0.45, sz * 0.43); if (sz < 0) f.rotation.y = Math.PI; g.add(f); }
  const chute = new THREE.Group(); chute.position.y = 0.8; g.add(chute);
  const can = new THREE.Mesh(new THREE.SphereGeometry(2.7, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), CHUTE_M); can.scale.y = 0.62; can.position.y = 4.4; can.castShadow = true; chute.add(can);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; limb(chute, new V3(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.3), new V3(Math.cos(a) * 2.65, 4.45, Math.sin(a) * 2.65), 0.012, VM.link); }
  scene.add(g);
  drop = { n: m.n, x: m.x, z: m.z, gy, g, chute, t: age, landed: false, grabT: 0, a: 0 };
  if (age < 3) { spawnFlyby('jet'); feed('<b style="color:#b7f0a0">Supply drop</b> <span>a crate is coming down · first one there gets the grenade launcher</span>'); SFX.blip(); }
}
function endDrop() { if (drop) { scene.remove(drop.g); drop = null; } $('dropmark').hidden = true; }
const _dv = new V3();
function updateDrop(dt) {
  if (!drop) return; const d = drop; d.t += dt;
  if (!d.landed) {
    const y = d.gy + Math.max(0, DROP_FALL - d.t) * 5; d.g.position.set(d.x + Math.sin(d.t * 0.9) * 0.6 * Math.min(1, (y - d.gy) / 8), y, d.z); d.g.rotation.set(Math.sin(d.t * 1.3) * 0.07, d.t * 0.2, Math.cos(d.t * 1.1) * 0.07);
    if (d.t >= DROP_FALL) { d.landed = true; d.g.rotation.set(0, d.g.rotation.y, 0); d.g.position.set(d.x, d.gy, d.z); SFX.boom(d.g.position, 0.25); for (let i = 0; i < 10; i++) { smoke.spawn(d.g.position, new V3(R(-2.5, 2.5), R(0.2, 1), R(-2.5, 2.5)), R(0.8, 1.4), R(0.25, 0.5), new THREE.Color(0xc9bba4), -0.2, false, 1.6); smoke.p[smoke.p.length - 1].grow = true; } }
  } else {
    const k = Math.min(1, (d.t - DROP_FALL) / 1.6); d.chute.scale.set(1 + 0.3 * k, Math.max(0.03, 1 - k), 1 + 0.3 * k); d.chute.visible = k < 1;
    d.a += dt * 9; while (d.a > 1) { d.a--; smoke.spawn(d.g.position.clone().add(new V3(R(-0.2, 0.2), 0.9, R(-0.2, 0.2))), new V3(R(-0.3, 0.3), R(1.6, 2.6), R(-0.3, 0.3)), R(2, 3.2), R(0.25, 0.5), new THREE.Color(0x4fbf4a), -0.3, false, 0.5); smoke.p[smoke.p.length - 1].grow = true; }
    if (P.alive && Math.abs(P.pos.y - d.gy) < 2 && Math.hypot(P.pos.x - d.x, P.pos.z - d.z) < 1.9 && d.t - d.grabT > 0.5) { d.grabT = d.t; netSend({ t: 'grab', n: d.n }); }
  }
  const mk = $('dropmark'); _dv.copy(d.g.position); _dv.y += 2.4; const dist = Math.round(_dv.distanceTo(camera.position)); _dv.project(camera);
  const show = gameState === 'play' && _dv.z < 1 && Math.abs(_dv.x) < 1 && Math.abs(_dv.y) < 1;
  if (mk.hidden === show) mk.hidden = !show;
  if (show) { mk.style.left = ((_dv.x + 1) / 2 * innerWidth).toFixed(0) + 'px'; mk.style.top = ((1 - _dv.y) / 2 * innerHeight).toFixed(0) + 'px'; const s = `SUPPLY DROP · ${dist} m`; if (mk.textContent !== s) mk.textContent = s; }
}
function giveLauncher() {
  P.hasLauncher = true; P.ammo[LAUNCHER].mag = WEAPONS[LAUNCHER].mag; setWeapon(LAUNCHER); SFX.ammo();
  showBanner('Grenade launcher', 'Six rounds that burst on impact · 5 brings it back up', 2800);
}

// ======================================================= SLIDE + VAULT
function trySlide() {
  if (P.slide || !P.onGround || P.sprint < 0.6 || P.rope || P.swim || P.ladder) return false;
  const hs = Math.hypot(P.vel.x, P.vel.z); if (hs < 5) return false;
  P.slide = { t: 0, dx: P.vel.x / hs, dz: P.vel.z / hs }; P.crouching = true; SFX.slide(); return true;
}
function tryVault() { // Space while pushing into something waist to head high with room on top: climb onto or over it
  if (P.vault || !P.onGround || !keys.KeyW || P.slide) return false;
  const f = new V3(-Math.sin(P.yaw), 0, -Math.cos(P.yaw)), o = P.pos.clone(); o.y += 0.4;
  const hw = rayWorld(o, f, 1.0); if (!hw || hw.water || Math.abs(hw.n[1]) > 0.5) return false;
  const tx = P.pos.x + f.x * (hw.t + 0.5), tz = P.pos.z + f.z * (hw.t + 0.5), top = groundAt(tx, tz, 0.3, P.pos.y + 1.6 - STEP), h = top - P.pos.y;
  if (h < 0.5 || h > 1.6) return false;
  if (ceilingAt(tx, tz, 0.36, top + 0.2) < top + 1.3 || ceilingAt(P.pos.x, P.pos.z, 0.36, P.pos.y + 1.7) < top + 1.3) return false;
  const to = new V3(tx, top, tz), chk = to.clone(); collideCircle(chk, 0.36, top + 0.05, top + 1.25); if (chk.distanceTo(to) > 0.2) return false;
  P.vault = { t: 0, dur: 0.3 + h * 0.14, from: P.pos.clone(), to, f }; P.onGround = false; P.vel.set(0, 0, 0); P.crouching = false; P.switchT = Math.max(P.switchT, 0.3); SFX.mech('pouch'); return true;
}
function updateVault(dt) {
  const v = P.vault; v.t += dt; const k = Math.min(1, v.t / v.dur), kk = smoothK(k);
  P.pos.x = lerp(v.from.x, v.to.x, kk); P.pos.z = lerp(v.from.z, v.to.z, kk); P.pos.y = lerp(v.from.y, v.to.y, smoothK(Math.min(1, k * 1.5))) + Math.sin(Math.PI * k) * 0.1;
  P.bobAmt = 0; P.sprint = lerp(P.sprint, 0, Math.min(1, dt * 8));
  if (k >= 1) { P.vault = null; P.onGround = true; P.vel.set(v.f.x * 3.5, 0, v.f.z * 3.5); P.minVy = 0; if (ceilingAt(P.pos.x, P.pos.z, 0.36, P.pos.y + 1.25) < P.pos.y + 1.85) P.crouching = true; SFX.step(null, 1, surfaceAt(P.pos)); }
}

// ======================================================= KILL CAM
function killCam(r, dt) { // over the shoulder of whoever got you, until you respawn
  const fwd = new V3(-Math.sin(r.yaw), 0, -Math.cos(r.yaw)), right = new V3(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
  const head = r.pos.clone(); head.y += 1.6 - 0.5 * r.crouch;
  const want = head.clone().addScaledVector(fwd, -2.7).addScaledVector(right, 0.7); want.y += 0.5;
  const d = want.clone().sub(head), L = d.length(), hw = rayWorld(head, d.clone().divideScalar(L), L + 0.3);
  if (hw) want.copy(head).addScaledVector(d, clamp((hw.t - 0.3) / L, 0.08, 1));
  if (!P.kcOn) { P.kcOn = true; camera.position.copy(want); $('killcam').hidden = false; $('killcamtext').innerHTML = P.killInfo; hideBanner(); }
  camera.position.lerp(want, Math.min(1, dt * 8));
  camera.lookAt(head.clone().addScaledVector(fwd, 9).add(new V3(0, Math.tan(clamp(r.pitch, -1.2, 1.2)) * 9 - 0.3, 0)));
  if (Math.abs(camera.fov - 62) > 0.1 || camera.near !== 0.1) { camera.fov = 62; camera.near = 0.1; camera.updateProjectionMatrix(); }
}

// ======================================================= DAY TO SUNSET
// The island runs on a slow clock everyone shares: bright afternoon, golden hour, the red sunset the game started with, and back.
const DAY = { k: -1, env: -9, PERIOD: 1200 };
const C2 = (a, b) => [new THREE.Color(a), new THREE.Color(b)];
const DAYC = { sun: C2(0xfff1dc, 0xffae73), hemiS: C2(0xa9c8f0, 0x8094c8), hemiG: C2(0x7d6f5c, 0x4a372c), zen: C2(0x2a66bd, 0x14244a), hor: C2(0xa9cbe8, 0xc98577), horSun: C2(0xfff2d6, 0xff9440),
  ground: C2(0x56616b, 0x2b2630), cloud: C2(0xd6dce4, 0x291a29), fog: C2(0xa4bbcf, 0x6b4f4f), wsun: C2(0xfff6e6, 0xffc08a) };
const SUN_AZ = Math.atan2(-0.62, -0.77), SUN_EL = [0.72, 0.28]; // 41 degrees in the afternoon down to 16 at sunset
let envRT = null, envScene = null;
function bakeEnv() {
  if (!envScene) { envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat)); }
  skyUniforms.uDisk.value = 6; const rt = pmrem.fromScene(envScene, 0, 0.1, 1000); skyUniforms.uDisk.value = 60;
  scene.environment = rt.texture; wScene.environment = rt.texture; if (envRT) envRT.dispose(); envRT = rt;
}
function dayK() { if (window.__dayK != null) return window.__dayK; const ph = (Date.now() / 1000 % DAY.PERIOD) / DAY.PERIOD; return 0.5 - 0.5 * Math.cos(ph * Math.PI * 2); }
function updateDay(dt) {
  const k = dayK(); DAY.k = k;
  const mix = (c, pair) => c.copy(pair[0]).lerp(pair[1], k), el = lerp(SUN_EL[0], SUN_EL[1], k);
  SUN_DIR.set(Math.sin(SUN_AZ) * Math.cos(el), Math.sin(el), Math.cos(SUN_AZ) * Math.cos(el));
  skyUniforms.uSun.value.copy(SUN_DIR); mix(skyUniforms.uZen.value, DAYC.zen); mix(skyUniforms.uHor.value, DAYC.hor); mix(skyUniforms.uHorSun.value, DAYC.horSun); mix(skyUniforms.uGround.value, DAYC.ground); mix(skyUniforms.uCloud.value, DAYC.cloud);
  mix(sun.color, DAYC.sun); sun.intensity = lerp(3.1, 3.4, k); mix(hemi.color, DAYC.hemiS); mix(hemi.groundColor, DAYC.hemiG); hemi.intensity = lerp(0.8, 0.5, k);
  mix(FOG, DAYC.fog); scene.fog.color.copy(FOG); scene.fog.density = lerp(0.0022, 0.0036, k);
  renderer.toneMappingExposure = lerp(1.02, 1.2, k);
  if (water) { water.material.uniforms.sunDirection.value.copy(SUN_DIR); mix(water.material.uniforms.sunColor.value, DAYC.wsun); }
  M.lamp.emissiveIntensity = lerp(0.6, 5.5, smoothK((k - 0.4) / 0.4));
  wSun.color.copy(sun.color);
  fitShadows(window.__scopeTest ? scopeView() : shadowView);
  if (Math.abs(k - DAY.env) > 0.03) { DAY.env = k; bakeEnv(); } // small steps, so reflections never visibly jump
}

// ======================================================= SURFACES + AMBIENCE
function surfaceAt(p) { // what is underfoot: decides how a footstep sounds
  if (port.active && aboard(p)) return 'metal';
  let best = null, by = 0.05;
  for (const c of colliders) { if (c.off || p.x < c.min[0] - 0.3 || p.x > c.max[0] + 0.3 || p.z < c.min[2] - 0.3 || p.z > c.max[2] + 0.3) continue; const top = c.max[1]; if (top <= p.y + 0.12 && top > by) { by = top; best = c; } }
  if (best && by > p.y - 0.15) return best.surf || 'stone';
  if (p.x > 42) return 'stone';
  return indoorAt(p) ? 'wood' : 'dirt';
}
const ECHO = { t: -9999, walls: [] };
function echoWalls() { // nearby walls the listener would hear a gunshot slap back from
  const now = performance.now(); if (now - ECHO.t < 600) return ECHO.walls; ECHO.t = now; ECHO.walls = [];
  const o = camera.position.clone(); o.y = Math.max(o.y, 1.2); const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y));
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2 + 0.2, d = new V3(Math.cos(a), 0.03, Math.sin(a)).normalize(), hw = rayWorld(o, d, 70); if (hw && !hw.water && hw.t > 5) ECHO.walls.push({ d: hw.t, pan: clamp(d.dot(right), -1, 1) }); }
  ECHO.walls.sort((a, b) => a.d - b.d); ECHO.walls.length = Math.min(3, ECHO.walls.length); return ECHO.walls;
}
const AMB = { sea: null, gull: 5, wave: 2 };
function gullCry(k) {
  const o = out(R(-0.9, 0.9), R(0.05, 0.13) * k), n = 2 + (Math.random() * 4 | 0), base = R(0.85, 1.2); let t0 = 0;
  for (let i = 0; i < n; i++) {
    const os = AC.createOscillator(), f = AC.createBiquadFilter(), e = AC.createGain(), t = AC.currentTime + t0, dur = R(0.16, 0.3);
    os.type = 'sawtooth'; os.frequency.setValueAtTime(1700 * base, t); os.frequency.linearRampToValueAtTime(2500 * base, t + dur * 0.3); os.frequency.linearRampToValueAtTime(1500 * base, t + dur);
    f.type = 'bandpass'; f.frequency.value = 2300 * base; f.Q.value = 4;
    e.gain.setValueAtTime(0.0008, t); e.gain.exponentialRampToValueAtTime(0.6, t + dur * 0.25); e.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    os.connect(f); f.connect(e); e.connect(o); os.start(t); os.stop(t + dur + 0.05); t0 += dur + R(0.05, 0.16);
  }
}
function waveSwell(k) {
  const s = AC.createBufferSource(), f = AC.createBiquadFilter(), e = AC.createGain(), t = AC.currentTime, dur = R(2.6, 4.2);
  s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.setValueAtTime(240, t); f.frequency.linearRampToValueAtTime(R(900, 1400), t + dur * 0.45); f.frequency.linearRampToValueAtTime(260, t + dur);
  e.gain.setValueAtTime(0.0008, t); e.gain.exponentialRampToValueAtTime(0.1 * k, t + dur * 0.45); e.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  s.connect(f); f.connect(e); e.connect(out(R(-0.5, 0.5), 1)); s.start(t, Math.random()); s.stop(t + dur + 0.1);
}
function updateAmbience(dt) {
  if (!AC || !AMB.sea) return;
  const p = camera.position, indoor = gameState === 'play' && indoorAt(P.pos), shore = p.x > 42 ? 1 : clamp(1 - (p.z + 24) / 60, 0.25, 1), k = (indoor ? 0.3 : 1);
  AMB.sea.gain.setTargetAtTime(k * (0.5 + 0.9 * shore), AC.currentTime, 0.3);
  AMB.gull -= dt; if (AMB.gull <= 0) { AMB.gull = R(6, 20); gullCry(k); }
  AMB.wave -= dt; if (AMB.wave <= 0) { AMB.wave = R(3, 6.5); waveSwell(k * shore); }
}

// ======================================================= AIRCRAFT FLYBYS (scenery)
// Smooth lofted bodies + per-aircraft painted textures (panel lines, rivets, weathering, Greek markings).
function catmull(p0, p1, p2, p3, t) { const t2 = t * t, t3 = t2 * t; return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); }
function sampleKeys(keys, z) {
  let i = 0; while (i < keys.length - 2 && z > keys[i + 1].z) i++;
  const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(keys.length - 1, i + 2)];
  const t = clamp((z - b.z) / (c.z - b.z || 1), 0, 1), o = {};
  for (const f of ['w', 'ht', 'hb', 'y', 'n', 'nb']) { const g = k => f === 'nb' ? (k.nb ?? k.n ?? 2.5) : (k[f] ?? (f === 'n' ? 2.5 : 0)); o[f] = catmull(g(a), g(b), g(c), g(d), t); }
  o.w = Math.max(0, o.w); o.ht = Math.max(0, o.ht); o.hb = Math.max(0, o.hb); o.n = Math.max(1.1, o.n); o.nb = Math.max(1.1, o.nb);
  return o;
}
// keys sorted by z ascending (tail -> nose). u: 0 bottom, .25 +x side, .5 top, .75 -x side. v: 0 tail, 1 nose.
function loft(keys, segs = 48, samples = 90) {
  const z0 = keys[0].z, z1 = keys[keys.length - 1].z, pos = [], uv = [], idx = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, z = z0 + (z1 - z0) * t, k = sampleKeys(keys, z), e = 2 / k.n, eb = 2 / k.nb;
    for (let j = 0; j <= segs; j++) {
      const th = -Math.PI / 2 + j / segs * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const x = k.w / 2 * Math.sign(c) * Math.pow(Math.abs(c), e);
      const y = s >= 0 ? k.ht * Math.pow(s, e) : -k.hb * Math.pow(-s, eb);
      const xs = s >= 0 ? x : k.w / 2 * Math.sign(c) * Math.pow(Math.abs(c), eb);
      pos.push(xs, k.y + y, z); uv.push(j / segs, t);
    }
  }
  for (let i = 0; i < samples; i++) for (let j = 0; j < segs; j++) {
    const a = i * (segs + 1) + j, b = a + segs + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// airfoil-section slab (wings, fins, blades) lying in the XZ plane, thickness along Y
function wingGeo(pts, thick = 0.14, bevel = 0.05) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -thick / 2); g.rotateX(Math.PI / 2); // shape (x, y) -> (x, z), thickness -> y
  return g;
}
// painted skin: color + bump canvases sharing the same panel layout
function skinTextures(W, H, base, paint) {
  const cc = document.createElement('canvas'); cc.width = W; cc.height = H; const g = cc.getContext('2d');
  const bc = document.createElement('canvas'); bc.width = W; bc.height = H; const b = bc.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, W, H); b.fillStyle = 'rgb(128,128,128)'; b.fillRect(0, 0, W, H);
  if (paint) paint.camo && paint.camo(g, W, H);
  if (paint && paint.marks) { g.save(); g.globalAlpha = 0.93; paint.marks(g, W, H, b); g.restore(); }
  // weathering
  for (let i = 0; i < 160; i++) { const x = sr() * W, y = sr() * H, r = SR(10, 60); const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${sr() < .5 ? '0,0,0' : '255,255,255'},${SR(.03, .07)})`); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
  // panel lines: frames (constant v) and stringers (constant u)
  const line = (x0, y0, x1, y1) => {
    g.strokeStyle = 'rgba(10,12,12,.42)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    b.strokeStyle = 'rgb(70,70,70)'; b.lineWidth = 2.2; b.beginPath(); b.moveTo(x0, y0); b.lineTo(x1, y1); b.stroke();
  };
  const rivets = (x0, y0, x1, y1, step = 9) => {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(L / step);
    for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x - 0.8, y - 0.8, 1.6, 1.6); b.fillStyle = 'rgb(175,175,175)'; b.fillRect(x - 1, y - 1, 2, 2); }
  };
  let y = SR(20, 60);
  while (y < H) { const x0 = sr() < .5 ? 0 : SR(0, W * .5), x1 = sr() < .5 ? W : SR(x0 + W * .2, W); line(x0, y, x1, y); if (sr() < .5) rivets(x0, y + 5, x1, y + 5); y += SR(40, 110); }
  for (let i = 0; i < 26; i++) { const x = sr() * W, y0 = sr() * H, y1 = y0 + SR(60, 300); line(x, y0, x, y1); if (sr() < .4) rivets(x + 5, y0, x + 5, y1); }
  for (let i = 0; i < 30; i++) { // access hatches
    const w = SR(14, 50), h = SR(14, 60), x = sr() * (W - w), yy = sr() * (H - h);
    line(x, yy, x + w, yy); line(x + w, yy, x + w, yy + h); line(x + w, yy + h, x, yy + h); line(x, yy + h, x, yy);
    if (sr() < .5) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x + 3, yy + 3, 3, 3); }
  }
  const tc = new THREE.CanvasTexture(cc); tc.colorSpace = THREE.SRGBColorSpace; tc.anisotropy = maxAniso;
  const tb = new THREE.CanvasTexture(bc); tb.anisotropy = maxAniso;
  return { map: tc, bump: tb };
}
// draw an image/flag on a loft skin side. side: +1 = +x side (u=.25), -1 = -x side (u=.75). v: 0..1 (tail->nose), size in px (along length)
function paintSide(g, W, H, side, v, len, draw) {
  const u = side > 0 ? 0.25 : 0.75, cx = u * W, cy = (1 - v) * H;
  g.save(); g.translate(cx, cy);
  // canvas +y = toward tail. On +x side canvas +x = up; on -x side canvas +x = down.
  g.transform(0, 1, side > 0 ? -1 : 1, 0, 0, 0); // local x -> aft (canvas +y), local y -> down
  g.__side = side; draw(g, len); g.__side = 0; g.restore();
}
function drawFlag(g, w) { // flag with top-left at (-w/2,-h/2), canton toward the nose
  const h = w * 2 / 3, blue = '#0d5eaf', s = h / 9; g.translate(-w / 2, -h / 2);
  for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? '#f4f4f0' : blue; g.fillRect(0, i * s, w, s + 0.5); }
  const k = s * 5; g.fillStyle = blue; g.fillRect(0, 0, k, k); g.fillStyle = '#f4f4f0'; g.fillRect(k * 2 / 5, 0, k / 5, k); g.fillRect(0, k * 2 / 5, k, k / 5);
}
function drawRoundel(g, d) { for (const [r, c] of [[.5, '#0d5eaf'], [.34, '#f4f4f0'], [.17, '#0d5eaf']]) { g.fillStyle = c; g.beginPath(); g.arc(0, 0, d * r, 0, 7); g.fill(); } }
function drawText(g, txt, size, color = 'rgba(20,20,20,.8)') { g.fillStyle = color; g.font = `600 ${size}px "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.save(); if (g.__side < 0) g.scale(-1, 1); g.fillText(txt, 0, 0); g.restore(); } // lettering reads forwards on both sides (flags keep their canton to the nose)

const AIRM = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1418, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.2 }),
  goldGlass: new THREE.MeshPhysicalMaterial({ color: 0x6b5a2c, roughness: 0.05, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.4 }),
  gunmetal: std({ color: 0x2b2d2e, roughness: 0.4, metalness: 0.8 }),
  black: std({ color: 0x141515, roughness: 0.6, metalness: 0.3 }),
  rubber: std({ color: 0x151515, roughness: 0.9 }),
  exhaust: std({ color: 0x1a1612, roughness: 0.8, metalness: 0.4 }),
  nozzleIn: new THREE.MeshStandardMaterial({ color: 0x0b0b0b, emissive: 0xff7a2a, emissiveIntensity: 0.6, roughness: 0.6, side: THREE.DoubleSide }),
  navR: new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.12) }),
  navG: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 6, 0.4) }),
  strobe: new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 7, 7) }),
  burner: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.4, 1.0), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
};
const ROTOR_BLUR = ctex(256, (g, S) => { const c = S / 2; const gr = g.createRadialGradient(c, c, S * 0.08, c, c, c); gr.addColorStop(0, 'rgba(20,20,20,.0)'); gr.addColorStop(0.15, 'rgba(25,25,25,.55)'); gr.addColorStop(0.9, 'rgba(25,25,25,.4)'); gr.addColorStop(0.96, 'rgba(120,115,70,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, S, S); });
function am(parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }
const cylZ = (r0, r1, len, seg = 20, open = false) => new THREE.CylinderGeometry(r1, r0, len, seg, 1, open).rotateX(Math.PI / 2); // r0 at -z, r1 at +z

let HELI_SKIN = null, HELI_MAT = null, JET_SKIN = null, JET_MAT = null, JET_WING_MAT = null, HELI_PART = null;
function heliMaterials() {
  if (HELI_MAT) return;
  HELI_SKIN = skinTextures(1024, 2048, '#4a5038', {
    camo(g, W, H) { for (let i = 0; i < 40; i++) { const x = sr() * W, y = sr() * H, r = SR(40, 140); const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(60,66,44,.35)'); gr.addColorStop(1, 'rgba(60,66,44,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); } },
    marks(g, W, H) {
      for (const side of [1, -1]) {
        paintSide(g, W, H, side, 0.30, 0, gg => { gg.translate(0, -8); drawFlag(gg, 150); });                 // flag on tail boom
        paintSide(g, W, H, side, 0.565, 0, gg => { gg.translate(0, -18); drawRoundel(gg, 120); });           // roundel aft of cockpit
        paintSide(g, W, H, side, 0.44, 0, gg => { gg.translate(0, -4); drawText(gg, 'ΣΤΡΑΤΟΣ ΞΗΡΑΣ', 34, 'rgba(15,15,12,.75)'); });
        paintSide(g, W, H, side, 0.22, 0, gg => { gg.translate(0, 22); drawText(gg, 'ES1021', 30, 'rgba(15,15,12,.7)'); });
        paintSide(g, W, H, side, 0.72, 0, gg => { gg.translate(0, 40); g.globalAlpha = 1; gg.fillStyle = 'rgba(12,12,10,.6)'; gg.fillRect(-60, -6, 120, 12); }); // anti-glare stripe
      }
      // exhaust soot on the upper rear
      const gr = g.createLinearGradient(0, H * 0.4, 0, H * 0.6); gr.addColorStop(0, 'rgba(15,12,10,0)'); gr.addColorStop(0.5, 'rgba(15,12,10,.35)'); gr.addColorStop(1, 'rgba(15,12,10,0)');
      g.fillStyle = gr; g.fillRect(W * 0.38, H * 0.4, W * 0.24, H * 0.2);
    }
  });
  HELI_MAT = std({ map: HELI_SKIN.map, bumpMap: HELI_SKIN.bump, bumpScale: 1.4, roughness: 0.62, metalness: 0.25 });
  const part = skinTextures(512, 512, '#4a5038', {}); part.map.repeat.set(0.35, 0.35); part.bump.repeat.set(0.35, 0.35);
  HELI_PART = std({ map: part.map, bumpMap: part.bump, bumpScale: 1.2, roughness: 0.62, metalness: 0.25 });
}
function jetMaterials() {
  if (JET_MAT) return;
  const camo = (g, W, H) => { for (let i = 0; i < 26; i++) { const x = sr() * W, y = sr() * H, r = SR(80, 220); const gr = g.createRadialGradient(x, y, r * 0.55, x, y, r); gr.addColorStop(0, 'rgba(98,114,130,.9)'); gr.addColorStop(1, 'rgba(98,114,130,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); } };
  JET_SKIN = skinTextures(1024, 2048, '#8c99a4', {
    camo, marks(g, W, H) {
      for (const side of [1, -1]) {
        paintSide(g, W, H, side, 0.6, 0, gg => { gg.translate(0, -30); drawRoundel(gg, 110); });
        paintSide(g, W, H, side, 0.45, 0, gg => { gg.translate(0, -20); drawText(gg, 'ΠΟΛΕΜΙΚΗ ΑΕΡΟΠΟΡΙΑ', 30, 'rgba(30,36,44,.75)'); });
        paintSide(g, W, H, side, 0.82, 0, gg => { gg.translate(0, -30); drawText(gg, '711', 40, 'rgba(30,36,44,.75)'); });
      }
      // walkway / refuel door on top
      g.strokeStyle = 'rgba(30,30,30,.5)'; g.lineWidth = 2; g.strokeRect(W * 0.47, H * 0.42, W * 0.06, H * 0.05);
    }
  });
  JET_MAT = std({ map: JET_SKIN.map, bumpMap: JET_SKIN.bump, bumpScale: 1.2, roughness: 0.48, metalness: 0.35 });
  const w = skinTextures(1024, 1024, '#8c99a4', { camo });
  w.map.repeat.set(0.16, 0.16); w.bump.repeat.set(0.16, 0.16);
  JET_WING_MAT = std({ map: w.map, bumpMap: w.bump, bumpScale: 1.2, roughness: 0.48, metalness: 0.35 });
}
function flatDecal(parent, draw, w, h, x, y, z, rx, ry, rz = 0) {
  const c = document.createElement('canvas'); c.width = 256; c.height = Math.round(256 * h / w); const g = c.getContext('2d');
  g.save(); g.translate(c.width / 2, c.height / 2); g.globalAlpha = 0.9; draw(g, c.width); g.restore();
  g.globalCompositeOperation = 'source-atop'; for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${sr() < .5 ? '0,0,0' : '255,255,255'},${SR(.03, .1)})`; g.fillRect(sr() * c.width, sr() * c.height, SR(2, 10), SR(1, 4)); } g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }));
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
}

function makeHeli() { // attack helicopter, forward = +z, ~17 m long
  heliMaterials();
  const g = new THREE.Group(); const M1 = HELI_MAT, MP = HELI_PART;
  // fuselage + tail boom in one smooth loft
  am(g, loft([
    { z: -9.75, w: 0.0, ht: 0.0, hb: 0.0, y: 0.5 },
    { z: -9.55, w: 0.3, ht: 0.22, hb: 0.16, y: 0.5, n: 2.4 },
    { z: -9.0, w: 0.38, ht: 0.3, hb: 0.22, y: 0.45, n: 2.4 },
    { z: -7.2, w: 0.42, ht: 0.32, hb: 0.25, y: 0.36, n: 2.5 },
    { z: -4.6, w: 0.56, ht: 0.4, hb: 0.32, y: 0.26, n: 2.6 },
    { z: -2.7, w: 0.86, ht: 0.6, hb: 0.52, y: 0.14, n: 3.0 },
    { z: -1.0, w: 1.12, ht: 0.86, hb: 0.72, y: 0.05, n: 3.6 },
    { z: 1.0, w: 1.2, ht: 0.9, hb: 0.76, y: 0.04, n: 3.8 },
    { z: 3.0, w: 1.12, ht: 0.74, hb: 0.76, y: 0.0, n: 3.8 },
    { z: 5.2, w: 1.0, ht: 0.58, hb: 0.7, y: -0.05, n: 3.6 },
    { z: 6.6, w: 0.92, ht: 0.5, hb: 0.6, y: -0.1, n: 3.0 },
    { z: 7.35, w: 0.55, ht: 0.32, hb: 0.42, y: -0.15, n: 2.6 },
    { z: 7.6, w: 0.0, ht: 0.0, hb: 0.0, y: -0.15 }
  ], 56, 120), M1);
  // stepped tandem canopy (glass) with frames
  const can = am(g, loft([
    { z: 1.3, w: 0.0, ht: 0.0, hb: 0.05, y: 0.62 },
    { z: 1.6, w: 0.62, ht: 0.42, hb: 0.05, y: 0.62, n: 3.2 },
    { z: 2.4, w: 0.92, ht: 0.78, hb: 0.05, y: 0.6, n: 3.6 },
    { z: 3.5, w: 0.92, ht: 0.74, hb: 0.05, y: 0.56, n: 3.6 },
    { z: 3.9, w: 0.9, ht: 0.56, hb: 0.05, y: 0.52, n: 3.4 },
    { z: 5.0, w: 0.86, ht: 0.52, hb: 0.05, y: 0.45, n: 3.2 },
    { z: 6.15, w: 0.6, ht: 0.18, hb: 0.05, y: 0.4, n: 2.6 },
    { z: 6.35, w: 0.0, ht: 0.0, hb: 0.05, y: 0.4 }
  ], 40, 60), AIRM.glass);
  // canopy frame bows
  for (const [z, w, h, y] of [[2.0, 0.94, 0.78, 0.6], [3.62, 0.94, 0.72, 0.55], [4.1, 0.9, 0.56, 0.52], [5.6, 0.82, 0.42, 0.43]]) {
    const ring = new THREE.TorusGeometry(1, 0.035, 6, 32, Math.PI); ring.scale(w / 2, h, 1);
    am(g, ring, AIRM.black, 0, y, z);
  }
  am(g, new THREE.BoxGeometry(0.05, 0.06, 4.3), AIRM.black, 0, 1.27, 3.6, 0.09);           // canopy spine
  // engine nacelles + exhaust suppressors
  for (const s of [-1, 1]) {
    am(g, loft([
      { z: -2.3, w: 0.0, ht: 0.0, hb: 0.0, y: 0 }, { z: -2.1, w: 0.5, ht: 0.3, hb: 0.3, y: 0, n: 2.4 }, { z: -1.2, w: 0.72, ht: 0.38, hb: 0.38, n: 2.6 },
      { z: 0.8, w: 0.74, ht: 0.4, hb: 0.38, n: 2.6 }, { z: 1.45, w: 0.62, ht: 0.34, hb: 0.32, n: 2.4 }, { z: 1.55, w: 0.0, ht: 0, hb: 0 }
    ], 28, 40), MP, s * 0.92, 0.82, -0.3);
    am(g, new THREE.CircleGeometry(0.26, 20), AIRM.black, s * 0.92, 0.82, 1.24);              // intake face
    am(g, new THREE.TorusGeometry(0.27, 0.03, 8, 24), AIRM.gunmetal, s * 0.92, 0.82, 1.22);
    am(g, cylZ(0.24, 0.2, 0.8, 16), AIRM.exhaust, s * 1.05, 0.88, -2.6, 0, s * 0.35, 0);      // angled exhaust
    am(g, new THREE.BoxGeometry(0.16, 0.28, 1.2), MP, s * 0.55, 0.72, -0.4);                 // pylon to fuselage
  }
  // rotor mast fairing + IR jammer
  am(g, loft([{ z: -1.8, w: 0, ht: 0, hb: 0, y: 0.9 }, { z: -1.5, w: 0.7, ht: 0.25, hb: 0.05, y: 0.9, n: 3 }, { z: 0.8, w: 0.9, ht: 0.42, hb: 0.05, y: 0.9, n: 3 }, { z: 1.4, w: 0.0, ht: 0, hb: 0.05, y: 0.9 }], 28, 30), MP);
  am(g, cylZ(0.14, 0.14, 0.4, 12), AIRM.black, 0, 1.45, -1.5); am(g, new THREE.SphereGeometry(0.16, 12, 8), AIRM.glass, 0, 1.62, -1.5);
  // stub wings with stores
  for (const s of [-1, 1]) {
    const wg = wingGeo([[0, 0.45], [1.75, 0.3], [1.75, -0.35], [0, -0.45]], 0.1, 0.04); if (s < 0) wg.scale(-1, 1, 1);
    am(g, wg, MP, s * 0.55, 0.05, 0.7, 0, 0, -s * 0.06);
    for (const [px, kind] of [[1.0, 'pod'], [1.62, 'msl']]) {
      const x = s * (0.55 + px);
      am(g, new THREE.BoxGeometry(0.08, 0.22, 0.7), AIRM.gunmetal, x, -0.12, 0.7);            // pylon
      if (kind === 'pod') {
        am(g, cylZ(0.2, 0.2, 1.55, 20), MP, x, -0.43, 0.75); am(g, cylZ(0.2, 0.06, 0.25, 20), MP, x, -0.43, 1.65);
        am(g, cylZ(0.2, 0.12, 0.2, 20), MP, x, -0.43, -0.12);
        am(g, new THREE.CircleGeometry(0.17, 18), AIRM.black, x, -0.43, 1.53);
      } else {
        am(g, new THREE.BoxGeometry(0.42, 0.06, 1.3), AIRM.gunmetal, x, -0.3, 0.7);            // launcher rail
        for (const [dx, dy] of [[-0.12, -0.43], [0.12, -0.43], [-0.12, -0.7], [0.12, -0.7]]) {
          am(g, cylZ(0.085, 0.085, 1.2, 12), std({ color: 0x5a5f4c, roughness: 0.6 }), x + dx, dy, 0.75);
          am(g, new THREE.SphereGeometry(0.085, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), AIRM.gunmetal, x + dx, dy, 1.35);
          for (let f = 0; f < 4; f++) am(g, new THREE.BoxGeometry(0.01, 0.2, 0.16), AIRM.gunmetal, x + dx, dy, 0.2, 0, 0, f * Math.PI / 2 + Math.PI / 4);
        }
      }
    }
    // main landing gear
    am(g, new THREE.CylinderGeometry(0.05, 0.05, 1.0, 8), AIRM.gunmetal, s * 0.75, -0.95, 3.9, 0, 0, s * 0.3);
    am(g, new THREE.BoxGeometry(0.5, 0.06, 0.08), AIRM.gunmetal, s * 0.6, -0.7, 3.9);
    am(g, new THREE.CylinderGeometry(0.31, 0.31, 0.2, 22).rotateZ(Math.PI / 2), AIRM.rubber, s * 0.95, -1.42, 3.9);
    am(g, new THREE.CylinderGeometry(0.15, 0.15, 0.22, 14).rotateZ(Math.PI / 2), AIRM.gunmetal, s * 0.95, -1.42, 3.9);
  }
  // chin cannon turret + nose sensor ball
  am(g, new THREE.SphereGeometry(0.24, 16, 12), AIRM.gunmetal, 0, -0.82, 5.0);
  am(g, cylZ(0.045, 0.04, 1.7, 10), AIRM.gunmetal, 0, -0.88, 5.85, 0.06);
  am(g, cylZ(0.07, 0.07, 0.3, 10), AIRM.gunmetal, 0, -0.84, 5.15);
  const sens = am(g, new THREE.SphereGeometry(0.36, 20, 14), MP, 0, -0.32, 7.55); sens.scale.set(1, 0.95, 0.9);
  for (const s of [-1, 1]) am(g, new THREE.CircleGeometry(0.11, 16), AIRM.glass, s * 0.15, -0.32, 7.87);
  am(g, new THREE.CircleGeometry(0.15, 16), AIRM.goldGlass, 0, -0.18, 7.86);
  // tail: swept fin, stabilator, tail wheel
  const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.25, 0); fin.lineTo(0.75, 2.15); fin.lineTo(0.05, 2.1); fin.closePath();
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 }); fg.translate(0, 0, -0.06); fg.rotateY(Math.PI / 2);
  am(g, fg, MP, 0, 0.55, -8.0);
  for (const s of [-1, 1]) { const sg = wingGeo([[0, 0.3], [1.7, 0.1], [1.7, -0.3], [0, -0.45]], 0.07, 0.03); if (s < 0) sg.scale(-1, 1, 1); am(g, sg, MP, s * 0.18, 0.42, -8.6); }
  am(g, new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), AIRM.gunmetal, 0, 0.0, -8.6, 0.3);
  am(g, new THREE.CylinderGeometry(0.15, 0.15, 0.1, 14).rotateZ(Math.PI / 2), AIRM.rubber, 0, -0.32, -8.7);
  // tail rotor (scissor, 4 blades)
  const tail = new THREE.Group(); tail.position.set(0.28, 2.15, -8.55); g.add(tail);
  am(tail, new THREE.CylinderGeometry(0.1, 0.1, 0.16, 12).rotateZ(Math.PI / 2), AIRM.gunmetal);
  for (const a of [0, Math.PI, 0.96, 0.96 + Math.PI]) { const b = am(tail, new THREE.BoxGeometry(0.03, 1.4, 0.2).translate(0, 0.7, 0), AIRM.black, 0.05, 0, 0); b.rotation.x = a; }
  // main rotor: hub + 4 blades + blur disc
  am(g, new THREE.CylinderGeometry(0.12, 0.16, 0.9, 14), AIRM.gunmetal, 0, 1.75, 0.2);
  const rotor = new THREE.Group(); rotor.position.set(0, 2.2, 0.2); g.add(rotor);
  am(rotor, new THREE.CylinderGeometry(0.34, 0.3, 0.26, 18), AIRM.gunmetal);
  am(rotor, new THREE.SphereGeometry(0.22, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), AIRM.gunmetal, 0, 0.12, 0);
  const airfoil = [[0, 0.28], [7.0, 0.27], [7.3, 0.12], [7.32, -0.2], [0, -0.26]];
  const blades = [];
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group(); arm.rotation.y = i * Math.PI / 2; rotor.add(arm);
    am(arm, new THREE.BoxGeometry(0.2, 0.12, 0.7), AIRM.gunmetal, 0, 0, 0.55);
    const bg = wingGeo(airfoil.map(([a, b]) => [b, a]), 0.05, 0.02); // span along +z
    const bl = am(arm, bg, AIRM.black, 0, 0, 0.6, 0, 0, 0.06); blades.push(bl);
    am(arm, new THREE.BoxGeometry(0.5, 0.075, 0.25), std({ color: 0xc9b23a, roughness: 0.6 }), 0, 0, 7.8);
  }
  const disk = new THREE.Mesh(new THREE.CircleGeometry(8.0, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ROTOR_BLUR, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.85 }));
  disk.position.y = 0.02; rotor.add(disk);
  // antennas, lights
  am(g, new THREE.BoxGeometry(0.02, 0.4, 0.15), AIRM.black, 0, -0.95, 1.0, 0.4);
  am(g, new THREE.BoxGeometry(0.02, 0.3, 0.12), AIRM.black, 0, 0.75, -5.5, -0.4);
  const nr = am(g, new THREE.SphereGeometry(0.06, 8, 6), AIRM.navR, -2.32, 0.05, 0.6); const ng = am(g, new THREE.SphereGeometry(0.06, 8, 6), AIRM.navG, 2.32, 0.05, 0.6);
  const strobe = am(g, new THREE.SphereGeometry(0.07, 8, 6), AIRM.strobe, 0, 2.75, -8.55);
  g.traverse(o => { if (o.isMesh && o.material.transparent) o.castShadow = false; });
  return { g, rotor, tail, strobe, blink: [nr, ng], blades, disk };
}

function makeJet() { // single-seat stealth fighter, forward = +z, ~15.7 m long
  jetMaterials();
  const g = new THREE.Group(); const MJ = JET_MAT, MW = JET_WING_MAT;
  am(g, loft([
    { z: -7.75, w: 1.2, ht: 0.5, hb: 0.46, y: 0.02, n: 2.2 },
    { z: -7.0, w: 1.55, ht: 0.55, hb: 0.5, y: 0.02, n: 2.2 },
    { z: -5.5, w: 2.15, ht: 0.58, hb: 0.52, y: 0.02, n: 2.0 },
    { z: -3.0, w: 2.75, ht: 0.64, hb: 0.6, y: 0.02, n: 1.9 },
    { z: 0.0, w: 2.95, ht: 0.72, hb: 0.64, y: 0.0, n: 1.75 },
    { z: 2.2, w: 2.5, ht: 0.72, hb: 0.6, y: 0.0, n: 1.6 },
    { z: 4.0, w: 1.55, ht: 0.62, hb: 0.5, y: -0.02, n: 1.5 },
    { z: 5.6, w: 1.1, ht: 0.46, hb: 0.38, y: -0.06, n: 1.45 },
    { z: 7.0, w: 0.58, ht: 0.26, hb: 0.22, y: -0.1, n: 1.45 },
    { z: 7.85, w: 0.06, ht: 0.04, hb: 0.04, y: -0.12, n: 1.4 },
    { z: 7.95, w: 0.0, ht: 0.0, hb: 0.0, y: -0.12 }
  ], 56, 120), MJ);
  // canopy (gold-tint, frameless with one bow)
  am(g, loft([
    { z: 1.9, w: 0.0, ht: 0.0, hb: 0.04, y: 0.6 }, { z: 2.3, w: 0.5, ht: 0.22, hb: 0.04, y: 0.6, n: 2.6 }, { z: 3.3, w: 0.82, ht: 0.48, hb: 0.04, y: 0.56, n: 2.8 },
    { z: 4.4, w: 0.8, ht: 0.44, hb: 0.04, y: 0.5, n: 2.8 }, { z: 5.4, w: 0.56, ht: 0.22, hb: 0.04, y: 0.42, n: 2.4 }, { z: 5.9, w: 0.0, ht: 0.0, hb: 0.04, y: 0.36 }
  ], 36, 50), AIRM.goldGlass);
  { const ring = new THREE.TorusGeometry(1, 0.025, 6, 30, Math.PI); ring.scale(0.42, 0.47, 1); am(g, ring, AIRM.gunmetal, 0, 0.56, 4.15); }
  // caret intakes
  for (const s of [-1, 1]) {
    am(g, loft([
      { z: -0.5, w: 0.0, ht: 0.0, hb: 0.0, y: 0 }, { z: 0.0, w: 0.75, ht: 0.38, hb: 0.36, n: 1.4 }, { z: 2.4, w: 0.85, ht: 0.44, hb: 0.42, n: 1.35 },
      { z: 3.55, w: 0.8, ht: 0.42, hb: 0.4, n: 1.3 }, { z: 3.6, w: 0.0, ht: 0, hb: 0 }
    ], 24, 40), MJ, s * 1.12, -0.05, 0.6);
    am(g, new THREE.PlaneGeometry(0.62, 0.62), AIRM.black, s * 1.12, -0.05, 4.13, 0, 0, Math.PI / 4).scale.set(0.95, 0.95, 1);
  }
  // wings (top roundels painted on as flat decals)
  for (const s of [-1, 1]) {
    const wg = wingGeo([[0, 1.1], [4.5, -2.55], [4.5, -3.5], [0, -3.7]], 0.12, 0.06); if (s < 0) wg.scale(-1, 1, 1);
    am(g, wg, MW, s * 1.25, -0.08, -0.6);
    flatDecal(g, gg => drawRoundel(gg, 240), 1.2, 1.2, s * 4.2, 0.03, -3.4, -Math.PI / 2, 0);
    flatDecal(g, gg => drawRoundel(gg, 240), 1.2, 1.2, s * 4.2, -0.19, -3.4, Math.PI / 2, 0);
    // horizontal tails
    const hg = wingGeo([[0, 0.2], [2.1, -1.1], [2.1, -1.95], [0, -2.4]], 0.08, 0.04); if (s < 0) hg.scale(-1, 1, 1);
    am(g, hg, MW, s * 1.0, -0.02, -5.15);
    // canted vertical tails
    const vt = new THREE.Shape(); vt.moveTo(0, 0); vt.lineTo(2.6, 0); vt.lineTo(2.1, 2.05); vt.lineTo(1.05, 2.05); vt.closePath();
    const vg = new THREE.ExtrudeGeometry(vt, { depth: 0.09, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 }); vg.translate(0, 0, -0.045); vg.rotateY(Math.PI / 2); vg.translate(0, 0, -3.5);
    const tail = new THREE.Group(); tail.position.set(s * 1.05, 0.5, 0); tail.rotation.z = -s * 0.44; g.add(tail);
    am(tail, vg, MW);
    flatDecal(tail, gg => drawFlag(gg, 256), 0.9, 0.6, 0.07, 1.2, -5.0, 0, Math.PI / 2);
    flatDecal(tail, gg => drawFlag(gg, 256), 0.9, 0.6, -0.07, 1.2, -5.0, 0, -Math.PI / 2);
    am(g, new THREE.BoxGeometry(0.05, 0.05, 0.25), s > 0 ? AIRM.navG : AIRM.navR, s * 5.75, -0.06, -4.1);
  }
  // engine nozzle + afterburner glow
  am(g, cylZ(0.6, 0.58, 0.9, 32, true), AIRM.gunmetal, 0, 0.02, -8.15);
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; am(g, new THREE.BoxGeometry(0.2, 0.025, 0.4), AIRM.gunmetal, Math.cos(a) * 0.56, 0.02 + Math.sin(a) * 0.56, -8.7, 0, 0, a + Math.PI / 2); }
  am(g, new THREE.CircleGeometry(0.55, 32), AIRM.nozzleIn, 0, 0.02, -7.95, 0, Math.PI);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.48, 3.0, 20, 1, true).rotateX(-Math.PI / 2), AIRM.burner); flame.position.set(0, 0.02, -10.2); g.add(flame);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: new THREE.Color(4, 2, 0.9), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.position.set(0, 0.02, -8.9); glow.scale.set(3, 3, 1); g.add(glow);
  // details: pitot-free nose, EOTS window, antenna blades
  am(g, new THREE.SphereGeometry(0.13, 12, 8), AIRM.goldGlass, 0, -0.5, 5.0).scale.set(1, 0.6, 1.6);
  am(g, new THREE.BoxGeometry(0.02, 0.22, 0.3), AIRM.gunmetal, 0, 0.74, -1.5, -0.4);
  am(g, new THREE.BoxGeometry(0.02, 0.18, 0.25), AIRM.gunmetal, 0, -0.66, 1.2, 0.4);
  const nr = am(g, new THREE.SphereGeometry(0.05, 8, 6), AIRM.navR, -5.75, -0.06, -4.0); const ng = am(g, new THREE.SphereGeometry(0.05, 8, 6), AIRM.navG, 5.75, -0.06, -4.0);
  g.traverse(o => { if (o.isMesh && o.material.transparent) o.castShadow = false; });
  return { g, flame, blink: [nr, ng] };
}


// ======================================================= NAVAL TRAFFIC (scenery)
const SEA_Y = -1.9;
const NAVY = {
  deck: std({ color: 0x5d6468, roughness: 0.8, metalness: 0.2 }),
  grey: std({ color: 0x8b949b, roughness: 0.6, metalness: 0.3 }),
  dark: std({ color: 0x2d3236, roughness: 0.55, metalness: 0.5 }),
  white: std({ color: 0xe8e8e2, roughness: 0.5, metalness: 0.1 }),
  window: new THREE.MeshPhysicalMaterial({ color: 0x0b1216, roughness: 0.05, metalness: 0.6, clearcoat: 1, envMapIntensity: 2 }),
  orange: std({ color: 0xd8641e, roughness: 0.6 })
};
function hullMaterial(map, bump) {
  const m = std({ map, bumpMap: bump, bumpScale: 1, roughness: 0.62, metalness: 0.3 });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vHY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHY = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHY;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nif (vHY < 0.45) diffuseColor.rgb = vHY < -0.15 ? vec3(0.22,0.05,0.04) : vec3(0.025);');
  };
  return m;
}
// hull: deck at y=F, keel at F-D, waterline at y=0
function hullKeys(L, B, F, D) {
  return [
    { z: -L / 2, w: B * 0.86, ht: 0.12, hb: D * 0.62, y: F, n: 6, nb: 3.2 },
    { z: -L * 0.3, w: B, ht: 0.14, hb: D * 0.92, y: F, n: 6, nb: 2.6 },
    { z: L * 0.08, w: B, ht: 0.14, hb: D, y: F, n: 6, nb: 2.1 },
    { z: L * 0.3, w: B * 0.78, ht: 0.14, hb: D, y: F + 0.15, n: 5, nb: 1.7 },
    { z: L * 0.43, w: B * 0.42, ht: 0.14, hb: D * 0.95, y: F + 0.45, n: 4, nb: 1.35 },
    { z: L * 0.495, w: 0.12, ht: 0.1, hb: D * 0.85, y: F + 0.7, n: 3, nb: 1.2 },
    { z: L * 0.5, w: 0.0, ht: 0.0, hb: D * 0.8, y: F + 0.7 }
  ];
}
const NAVY_SKINS = {};
function navySkin(num) {
  return NAVY_SKINS[num] || (NAVY_SKINS[num] = skinTextures(1024, 2048, '#8b949b', {
    marks(g, W, H) {
      for (const side of [1, -1]) {
        const u = side > 0 ? 0.205 : 0.795;
        g.save(); g.translate(u * W, (1 - 0.82) * H); g.transform(0, side, -side, 0, 0, 0);
        g.fillStyle = 'rgba(245,245,240,.92)'; g.strokeStyle = 'rgba(20,20,20,.9)'; g.lineWidth = 4;
        g.font = '700 120px "Arial Narrow", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.strokeText(num, 0, 0); g.fillText(num, 0, 0); g.restore();
        // rust streaks below scuppers
        for (let i = 0; i < 14; i++) { const y = sr() * H; const gr = g.createLinearGradient(0, 0, 60, 0); g.save(); g.translate((side > 0 ? 0.24 : 0.76) * W, y); gr.addColorStop(0, 'rgba(110,60,30,.35)'); gr.addColorStop(1, 'rgba(110,60,30,0)'); g.fillStyle = gr; g.fillRect(side > 0 ? -60 : 0, 0, 60, 3); g.restore(); }
      }
    }
  }));
}
function block(parent, mat, x, y, z, w, h, len, taper = 0.85) { // faceted superstructure block, bottom at y
  return am(parent, loft([
    { z: -len / 2, w: w * 0.96, ht: h, hb: 0.01, y, n: 7 }, { z: -len / 2 + 0.05, w, ht: h, hb: 0.01, y, n: 7 },
    { z: len / 2 - 0.05, w: w * taper, ht: h * 0.97, hb: 0.01, y, n: 7 }, { z: len / 2, w: w * taper * 0.96, ht: h * 0.95, hb: 0.01, y, n: 7 }
  ], 24, 6), mat, x, 0, z);
}
const boatFlags = [];
function boatFlag(parent, x, y, z, w = 1.8) {
  const h = w * 2 / 3, geo = new THREE.PlaneGeometry(w, h, 12, 6); geo.translate(-w / 2, -h / 2, 0);
  const m = new THREE.Mesh(geo, M.flag); m.position.set(x, y, z); m.rotation.y = Math.PI / 2; parent.add(m);
  boatFlags.push({ m, base: geo.attributes.position.array.slice(), w, ph: Math.random() * 6 });
}
function updateBoatFlags(t) {
  for (const f of boatFlags) {
    if (!f.m.parent || !f.m.parent.parent) continue;
    const pos = f.m.geometry.attributes.position, b = f.base;
    for (let i = 0; i < pos.count; i++) { const x = b[i * 3], k = -x / f.w; pos.array[i * 3 + 2] = Math.sin(-x * 2.2 - t * 9 + f.ph) * 0.12 * k; }
    pos.needsUpdate = true; f.m.geometry.computeVertexNormals();
  }
}
function gunTurret(parent, x, y, z, scale = 1) {
  const t = new THREE.Group(); t.position.set(x, y, z); t.scale.setScalar(scale); parent.add(t);
  am(t, loft([{ z: -1.6, w: 2.4, ht: 1.3, hb: 0.01, y: 0, n: 1.6 }, { z: 0.4, w: 2.6, ht: 1.4, hb: 0.01, y: 0, n: 1.6 }, { z: 1.7, w: 1.6, ht: 0.8, hb: 0.01, y: 0, n: 1.5 }, { z: 1.9, w: 0, ht: 0, hb: 0.01, y: 0 }], 20, 12), NAVY.grey);
  am(t, cylZ(0.14, 0.11, 4.4, 14), NAVY.dark, 0, 0.7, 3.6, -0.05);
  am(t, cylZ(0.17, 0.17, 0.5, 14), NAVY.dark, 0, 0.72, 5.6, -0.05);
  am(t, new THREE.CylinderGeometry(1.5, 1.6, 0.4, 24), NAVY.grey, 0, 0.05, 0);
  return t;
}
function missileBox(parent, x, y, z, ry) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = ry; parent.add(g);
  for (const dx of [-0.45, 0.45]) { const c = am(g, new THREE.BoxGeometry(0.75, 0.75, 5.2), NAVY.grey, dx, 0.8, 0); c.rotation.x = -0.25; am(g, new THREE.BoxGeometry(0.6, 0.6, 0.06), NAVY.dark, dx, 1.45, 2.55).rotation.x = -0.25; }
  am(g, new THREE.BoxGeometry(1.9, 0.5, 3.8), NAVY.dark, 0, 0.25, -0.6);
}
function mast(parent, x, y, z, h) {
  am(parent, loft([{ z: -1.2, w: 2.6, ht: 0.01, hb: 0.01, y: 0, n: 1.3 }, { z: 1.2, w: 2.6, ht: 0.01, hb: 0.01, y: 0, n: 1.3 }], 4, 2), NAVY.grey, x, y, z); // base plate
  const m = am(parent, new THREE.CylinderGeometry(0.35, 1.2, h, 4), NAVY.grey, x, y + h / 2, z); m.rotation.y = Math.PI / 4;
  am(parent, new THREE.BoxGeometry(5.0, 0.15, 0.15), NAVY.dark, x, y + h * 0.78, z);                       // yardarm
  am(parent, new THREE.SphereGeometry(0.9, 20, 14), NAVY.white, x, y + h + 0.6, z);                        // radome
  const radar = new THREE.Group(); radar.position.set(x, y + h * 0.62, z + 0.0); parent.add(radar);
  am(radar, new THREE.BoxGeometry(3.6, 0.5, 0.25), NAVY.dark, 0, 0, 0.9); am(radar, new THREE.CylinderGeometry(0.15, 0.15, 0.6, 8), NAVY.dark, 0, -0.3, 0.6);
  for (const s of [-1, 1]) am(parent, new THREE.CylinderGeometry(0.03, 0.03, 3.0, 6), NAVY.dark, x + s * 2.2, y + h * 0.78 + 1.5, z);
  am(parent, new THREE.CylinderGeometry(0.04, 0.04, 3.5, 6), NAVY.dark, x, y + h + 2.8, z);
  am(parent, new THREE.SphereGeometry(0.12, 8, 6), AIRM.navR, x, y + h + 4.6, z);
  boatFlag(parent, x - 2.4, y + h * 0.78 - 0.1, z, 1.6);
  return radar;
}
function makeFAC() { // fast attack missile craft, ~56 m
  const L = 56, B = 8, F = 2.4, D = 4.6;
  const skin = navySkin('P 69');
  const g = new THREE.Group();
  am(g, loft(hullKeys(L, B, F, D), 48, 100), hullMaterial(skin.map, skin.bump));
  am(g, new THREE.BoxGeometry(B * 0.9, 0.06, L * 0.62), NAVY.deck, 0, F + 0.08, -L * 0.06);
  const turret = gunTurret(g, 0, F + 0.1, L * 0.3, 0.85);
  block(g, NAVY.grey, 0, F, L * 0.06, 6.2, 3.2, 14, 0.8);                                   // deckhouse
  block(g, NAVY.grey, 0, F + 3.2, L * 0.09, 4.8, 2.4, 7.5, 0.75);                           // bridge
  am(g, new THREE.BoxGeometry(4.0, 0.7, 0.12), NAVY.window, 0, F + 4.6, L * 0.09 + 3.68).rotation.x = -0.35;
  for (const s of [-1, 1]) am(g, new THREE.BoxGeometry(0.12, 0.6, 3.5), NAVY.window, s * 2.38, F + 4.5, L * 0.09);
  const radar = mast(g, 0, F + 5.6, L * 0.06, 8);
  for (const s of [-1, 1]) missileBox(g, s * 2.1, F, -L * 0.17, s * 0.12);
  am(g, new THREE.CylinderGeometry(0.9, 1.0, 1.6, 18), NAVY.grey, 0, F + 0.8, -L * 0.36); am(g, new THREE.SphereGeometry(0.85, 16, 10, 0, 6.3, 0, 1.6), NAVY.white, 0, F + 1.6, -L * 0.36); // CIWS
  am(g, cylZ(0.05, 0.05, 1.6, 8), NAVY.dark, 0, F + 1.5, -L * 0.36 + 1.2);
  // RHIB on the stern
  am(g, loft([{ z: -2.6, w: 1.7, ht: 0.35, hb: 0.3, y: 0, n: 2.5 }, { z: 2.2, w: 1.7, ht: 0.38, hb: 0.3, n: 2.5 }, { z: 2.9, w: 0, ht: 0.2, hb: 0.1 }], 20, 16), NAVY.orange, 2.4, F + 0.5, -L * 0.42);
  // railings
  for (const s of [-1, 1]) { am(g, new THREE.BoxGeometry(0.05, 0.05, L * 0.62), NAVY.dark, s * B * 0.47, F + 1.0, -L * 0.06); for (let z = -L * 0.36; z < L * 0.24; z += 2) am(g, new THREE.BoxGeometry(0.04, 1.0, 0.04), NAVY.dark, s * B * 0.47, F + 0.5, z); }
  boatFlag(g, 0, F + 3.6, -L / 2 + 0.3, 2.2); am(g, new THREE.CylinderGeometry(0.04, 0.04, 3.6, 6), NAVY.dark, 0, F + 1.8, -L / 2 + 0.4);
  return { g, radar, turret, F, L, B, speed: R(15, 20), bowSpray: true, sound: 'fac' };
}
function makeCorvette() { // ~84 m missile corvette
  const L = 84, B = 11.5, F = 3.4, D = 6.6;
  const skin = navySkin('P 75');
  const g = new THREE.Group();
  am(g, loft(hullKeys(L, B, F, D), 56, 120), hullMaterial(skin.map, skin.bump));
  am(g, new THREE.BoxGeometry(B * 0.9, 0.06, L * 0.66), NAVY.deck, 0, F + 0.1, -L * 0.05);
  const turret = gunTurret(g, 0, F + 0.15, L * 0.31, 1.05);
  block(g, NAVY.grey, 0, F, L * 0.04, 9.5, 4.0, 26, 0.82);
  block(g, NAVY.grey, 0, F + 4.0, L * 0.12, 7.4, 2.8, 10, 0.78);
  am(g, new THREE.BoxGeometry(5.6, 0.8, 0.12), NAVY.window, 0, F + 5.6, L * 0.12 + 4.85).rotation.x = -0.35;
  for (const s of [-1, 1]) am(g, new THREE.BoxGeometry(0.12, 0.7, 5), NAVY.window, s * 3.65, F + 5.5, L * 0.12);
  const radar = mast(g, 0, F + 6.8, L * 0.08, 11);
  block(g, NAVY.grey, 0, F + 4.0, -L * 0.05, 4.2, 3.6, 6, 0.85);                             // funnel
  am(g, new THREE.BoxGeometry(3.2, 0.3, 3.6), NAVY.dark, 0, F + 7.65, -L * 0.05);
  for (const s of [-1, 1]) { missileBox(g, s * 2.6, F + 4.0, -L * 0.15, s * 0.1); missileBox(g, s * 2.6, F, L * 0.2, -s * 0.06); }
  // helicopter deck + hangar
  block(g, NAVY.grey, 0, F, -L * 0.2, 9.5, 5.2, 12, 1.0);
  am(g, new THREE.BoxGeometry(B * 0.92, 0.08, L * 0.18), NAVY.deck, 0, F + 0.14, -L * 0.38);
  { const c = document.createElement('canvas'); c.width = c.height = 256; const q = c.getContext('2d'); q.strokeStyle = '#e8e4c8'; q.lineWidth = 6; q.beginPath(); q.arc(128, 128, 100, 0, 7); q.stroke(); q.font = '700 120px Arial'; q.fillStyle = '#e8e4c8'; q.textAlign = 'center'; q.textBaseline = 'middle'; q.fillText('H', 128, 132); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshStandardMaterial({ map: t, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.8 })); pad.rotation.x = -Math.PI / 2; pad.position.set(0, F + 0.2, -L * 0.38); g.add(pad); }
  am(g, new THREE.CylinderGeometry(1.0, 1.1, 1.8, 18), NAVY.grey, 0, F + 6.1, -L * 0.25); am(g, new THREE.SphereGeometry(0.95, 16, 10, 0, 6.3, 0, 1.6), NAVY.white, 0, F + 7.0, -L * 0.25);
  for (const s of [-1, 1]) { am(g, new THREE.BoxGeometry(0.05, 0.05, L * 0.66), NAVY.dark, s * B * 0.47, F + 1.1, -L * 0.05); for (let z = -L * 0.38; z < L * 0.28; z += 2.2) am(g, new THREE.BoxGeometry(0.04, 1.1, 0.04), NAVY.dark, s * B * 0.47, F + 0.55, z); }
  for (const s of [-1, 1]) am(g, loft([{ z: -3, w: 2, ht: 0.4, hb: 0.35, y: 0, n: 2.5 }, { z: 2.6, w: 2, ht: 0.45, hb: 0.35, n: 2.5 }, { z: 3.4, w: 0, ht: 0.2, hb: 0.1 }], 20, 16), NAVY.orange, s * 5.3, F + 4.5, -L * 0.1);
  boatFlag(g, 0, F + 4.4, -L / 2 + 0.3, 2.6); am(g, new THREE.CylinderGeometry(0.05, 0.05, 4.4, 6), NAVY.dark, 0, F + 2.2, -L / 2 + 0.4);
  return { g, radar, turret, F, L, B, speed: R(8, 11), bowSpray: false, sound: 'corvette' };
}
const WAKE_TEX = ctex(512, (g, S) => {
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) { // turbulent centre band, widening and fading aft (canvas y down = aft)
    const y = sr() * S, t = y / S, spread = 0.06 + t * 0.22, x = S / 2 + (sr() - 0.5) * 2 * spread * S;
    const a = (1 - t) * 0.5 * sr(), r = 2 + sr() * 7;
    g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath(); g.ellipse(x, y, r, r * 0.6, 0, 0, 7); g.fill();
  }
  for (const s of [-1, 1]) for (let i = 0; i < 900; i++) { // kelvin arms
    const t = sr(), y = t * S, x = S / 2 + s * (0.05 + t * 0.45) * S + (sr() - 0.5) * 10;
    g.fillStyle = `rgba(255,255,255,${(1 - t) * 0.45 * sr()})`; g.fillRect(x, y, 2 + sr() * 3, 1 + sr() * 2);
  }
});
WAKE_TEX.wrapS = WAKE_TEX.wrapT = THREE.ClampToEdgeWrapping;
const wakeMat = new THREE.MeshBasicMaterial({ map: WAKE_TEX, transparent: true, depthWrite: false, opacity: 0.85, color: new THREE.Color(1.1, 1.15, 1.15), polygonOffset: true, polygonOffsetFactor: -6 });
// Built models are pooled and reused so a spawn never builds geometry or compiles shaders mid-game.
const MAKERS = { heli: () => makeHeli(), jet: () => makeJet(), fac: () => makeFAC(), corvette: () => makeCorvette(), utility: () => makeUtilityHeli() };
const POOL = { heli: [], jet: [], fac: [], corvette: [], utility: [] };
const takeModel = kind => POOL[kind].pop() || MAKERS[kind]();
const giveModel = (kind, m) => { scene.remove(m.g); if (m.wake) scene.remove(m.wake); m.snd = null; POOL[kind].push(m); };
function prewarm() {
  const add = [];
  for (const [kind, n] of [['heli', 1], ['jet', 2], ['fac', 1], ['corvette', 1], ['utility', 2]])
    while (POOL[kind].length < n) POOL[kind].push(MAKERS[kind]());
  for (const list of Object.values(POOL)) for (const m of list) { m.g.position.set(0, -500, 0); scene.add(m.g); add.push(m.g); }
  try {
    renderer.compile(scene, camera);
    scene.traverse(o => { if (o.isMesh) for (const mat of [].concat(o.material)) for (const k of ['map', 'bumpMap', 'normalMap', 'roughnessMap', 'emissiveMap', 'alphaMap']) if (mat[k] && mat[k].isTexture) renderer.initTexture(mat[k]); });
  } catch (e) { console.warn(e); }
  add.forEach(g => scene.remove(g));
}
const boats = [];
let nextBoat = 6;
function spawnBoat(kind, startK = 0) {
  const b = takeModel(kind); b.kind = kind;
  const dirSign = Math.random() < 0.5 ? 1 : -1;
  const lane = kind === 'corvette' ? R(-340, -300) : R(-270, -240);
  b.from = new V3(-dirSign * 650, SEA_Y, lane); b.to = new V3(dirSign * 650, SEA_Y, lane + R(-30, 30));
  b.dur = b.from.distanceTo(b.to) / b.speed; b.t = startK * b.dur;
  b.g.traverse(o => { if (o.isMesh) { o.castShadow = false; } });
  scene.add(b.g);
  const wl = b.L * (b.bowSpray ? 4 : 3), ww = b.B * (b.bowSpray ? 6 : 4.5);
  if (!b.wake) b.wake = new THREE.Mesh(new THREE.PlaneGeometry(ww, wl).rotateX(-Math.PI / 2), wakeMat);
  scene.add(b.wake); b.wakeLen = wl;
  if (AC) b.snd = boatSound(b.sound);
  boats.push(b); return b;
}
function boatSound(kind) {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = kind === 'fac' ? 420 : 160;
  const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = kind === 'fac' ? 62 : 38; const og = AC.createGain(); og.gain.value = 0.25;
  const g = AC.createGain(); g.gain.value = 0; const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  s.connect(f); o.connect(og); og.connect(f); f.connect(g); if (pan) { g.connect(pan); pan.connect(master); } else g.connect(master);
  s.start(); o.start(); return { s, o, g, pan };
}
function updateBoats(dt, t) {
  nextBoat -= dt;
  if (nextBoat <= 0) { spawnBoat(Math.random() < 0.55 ? 'fac' : 'corvette'); nextBoat = R(25, 55); }
  for (let i = boats.length - 1; i >= 0; i--) {
    const b = boats[i]; b.sk = lerp(b.sk == null ? 1 : b.sk, b.hostile ? 0 : 1, Math.min(1, dt * 0.5)); b.t += dt * b.sk; const k = b.t / b.dur;
    if (b.hostile) updateHostileBoat(b, dt);
    if (k >= 1) { if (b.snd) { try { b.snd.s.stop(); b.snd.o.stop(); } catch (e) { } } giveModel(b.kind, b); boats.splice(i, 1); continue; }
    const p = b.from.clone().lerp(b.to, k); const dir = b.to.clone().sub(b.from).normalize();
    b.g.position.copy(p); b.g.position.y = SEA_Y + Math.sin(t * 0.9 + i) * 0.12;
    b.g.rotation.set(0, Math.atan2(dir.x, dir.z), 0); b.g.rotateX((b.bowSpray ? -0.035 : 0) + Math.sin(t * 0.7 + i) * 0.008); b.g.rotateZ(Math.sin(t * 0.55 + i * 2) * 0.012);
    b.radar.rotation.y += dt * 2.5;
    b.wake.position.copy(p).addScaledVector(dir, -b.wakeLen / 2 + b.L * 0.45); b.wake.position.y = SEA_Y + 0.05; b.wake.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI;
    if (b.bowSpray && Math.random() < 0.6) {
      const bow = p.clone().addScaledVector(dir, b.L * 0.38); bow.y = SEA_Y + 0.4;
      const side = new V3(dir.z, 0, -dir.x).multiplyScalar(Math.random() < .5 ? 1 : -1);
      debris.spawn(bow.add(side.clone().multiplyScalar(b.B * 0.4)), side.multiplyScalar(R(3, 6)).add(new V3(0, R(2, 4), 0)).addScaledVector(dir, b.speed * 0.6), R(0.5, 0.9), R(0.08, 0.16), new THREE.Color(0xeef4f6), 9.8);
    }
    if (b.snd) {
      const rel = p.clone().sub(camera.position), d = rel.length();
      b.snd.g.gain.setTargetAtTime(clamp((b.sound === 'fac' ? 90 : 120) / (d + 40), 0, 0.9), AC.currentTime, 0.2);
      if (b.snd.pan) { const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y)); b.snd.pan.pan.setTargetAtTime(clamp(rel.normalize().dot(right), -1, 1) * 0.8, AC.currentTime, 0.2); }
    } else if (AC) b.snd = boatSound(b.sound);
  }
}

const flybys = [];
let nextFlyby = 12 + Math.random() * 10;
function spawnFlyby(kind) {
  const isJet = kind === 'jet';
  const m = takeModel(kind);
  const ang = Math.random() * Math.PI * 2, dir = new V3(Math.cos(ang), 0, Math.sin(ang));
  const lat = new V3(-dir.z, 0, dir.x).multiplyScalar(R(-25, 25));
  const alt = isJet ? R(55, 85) : R(24, 34), half = isJet ? 700 : 380;
  const a = dir.clone().multiplyScalar(-half).add(lat).setY(alt), b = dir.clone().multiplyScalar(half).add(lat).setY(alt + (isJet ? R(-10, 30) : 0));
  const f = { m, a, b, t: 0, dur: a.distanceTo(b) / (isJet ? 165 : 42), isJet, prev: a.clone(), snd: null, pair: isJet && Math.random() < 0.5 };
  m.g.position.copy(a); m.g.lookAt(b); scene.add(m.g);
  if (AC) f.snd = airSound(isJet);
  flybys.push(f);
  if (f.pair) { // wingman
    const w = takeModel('jet'); w.g.position.copy(a); scene.add(w.g); f.wing = w;
  }
}
function airSound(isJet) {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const fl = AC.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = isJet ? 1200 : 380; fl.Q.value = isJet ? 0.5 : 2;
  const am = AC.createGain(); am.gain.value = isJet ? 1 : 0.55;
  if (!isJet) { const lfo = AC.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 17; const lg = AC.createGain(); lg.gain.value = 0.45; lfo.connect(lg); lg.connect(am.gain); lfo.start(); s._lfo = lfo; }
  const g = AC.createGain(); g.gain.value = 0;
  const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  s.connect(fl); fl.connect(am); am.connect(g); if (pan) { g.connect(pan); pan.connect(master); } else g.connect(master);
  s.start();
  return { s, fl, g, pan };
}
function updateFlybys(dt) {
  nextFlyby -= dt;
  if (nextFlyby <= 0 && gameState === 'play') { spawnFlyby(Math.random() < 0.5 ? 'jet' : 'heli'); nextFlyby = R(30, 60); }
  for (let i = flybys.length - 1; i >= 0; i--) {
    const f = flybys[i];
    if (f.hostile && !f.hostile.gone) { updateHostileAir(f, dt); f.prev.copy(f.m.g.position); continue; }
    f.t += dt; const k = f.t / f.dur;
    if (k >= 1) { giveModel(f.isJet ? 'jet' : 'heli', f.m); if (f.wing) giveModel('jet', f.wing); if (f.snd) { try { f.snd.s.stop(); f.snd.s._lfo && f.snd.s._lfo.stop(); } catch (e) { } } flybys.splice(i, 1); continue; }
    const p = f.a.clone().lerp(f.b, k);
    if (!f.isJet) p.y += Math.sin(f.t * 0.8) * 1.2;
    f.m.g.position.copy(p); f.m.g.lookAt(f.b.x, p.y, f.b.z);
    if (f.isJet) { f.m.g.rotateZ(Math.sin(k * Math.PI) * 0.35); f.m.flame.scale.set(1, 1, 0.8 + Math.random() * 0.4); }
    else { f.m.g.rotateX(0.1); f.m.rotor.rotation.y += dt * 30; f.m.tail.rotation.x += dt * 60; f.m.strobe.visible = (f.t % 1.2) < 0.08; }
    f.m.blink.forEach(b => b.visible = (f.t % 1.0) < 0.6);
    if (f.wing) { f.wing.g.position.copy(p).add(new V3(-12, -3, 0).applyQuaternion(f.m.g.quaternion)); f.wing.g.quaternion.copy(f.m.g.quaternion); }
    if (f.snd) {
      const rel = p.clone().sub(camera.position), d = rel.length();
      const vel = p.clone().sub(f.prev).divideScalar(Math.max(dt, 1e-3)); const closing = -vel.dot(rel) / Math.max(d, 1); // + approaching
      const gain = f.isJet ? clamp(220 / (d + 40), 0, 2.2) : clamp(70 / (d + 20), 0, 1.6);
      const delayK = f.isJet ? clamp(1 - (closing > 0 ? 0 : 0.25), 0.6, 1) : 1;
      f.snd.g.gain.setTargetAtTime(gain * delayK, AC.currentTime, 0.08);
      if (f.isJet) f.snd.fl.frequency.setTargetAtTime(clamp(900 + closing * 9, 300, 3200), AC.currentTime, 0.1);
      if (f.snd.pan) { const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y)); f.snd.pan.pan.setTargetAtTime(clamp(rel.normalize().dot(right), -1, 1) * 0.8, AC.currentTime, 0.1); }
    }
    f.prev.copy(p);
  }
}


// ======================================================= RETALIATION
// Flybys and passing warships are peaceful and exist only in each player's own world. Shoot one, even by
// accident, and it turns on you and only you: the attack helicopter breaks off and strafes you with its chin
// cannon, a jet comes round for a missile run, a warship swings its gun and walks shells onto you.
const _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _box = new THREE.Box3(), _hp = new V3();
function rayHitsObj(o, d, obj, box, maxT) {
  obj.updateMatrixWorld(); _inv.copy(obj.matrixWorld).invert();
  _ray.set(o, d).applyMatrix4(_inv); _box.copy(box);
  if (!_ray.intersectBox(_box, _hp)) return false;
  return _hp.applyMatrix4(obj.matrixWorld).distanceTo(o) <= maxT;
}
const HELI_BOX = new THREE.Box3(new V3(-2.6, -1.6, -9), new V3(2.6, 2.6, 8.2)), JET_BOX = new THREE.Box3(new V3(-6, -1.4, -8), new V3(6, 2.6, 8));
const CAUSE = { heli: 'the Navy attack helicopter', jet: 'an Air Force jet', ship: 'a Navy warship', blast: 'their own grenade' };
function shotAtVehicles(o, d, maxT) {
  if (!P.alive) return false;
  for (const f of flybys) {
    if (f.hostile) continue;
    if (rayHitsObj(o, d, f.m.g, f.isJet ? JET_BOX : HELI_BOX, maxT) || (f.wing && rayHitsObj(o, d, f.wing.g, JET_BOX, maxT))) { provoke(f, f.isJet ? 'jet' : 'heli'); return true; }
  }
  for (const b of boats) {
    if (b.hostile) continue;
    if (!b._box) b._box = new THREE.Box3(new V3(-b.B / 2, -1, -b.L / 2), new V3(b.B / 2, b.F + 9, b.L / 2));
    if (rayHitsObj(o, d, b.g, b._box, maxT)) { provoke(b, 'ship'); return true; }
  }
  return false;
}
function provoke(v, kind) {
  v.hostile = { kind, t: 0, phase: kind === 'jet' ? 'extend' : 'come', shots: 0, cd: 0, done: false, gone: false, run: 0, rk: 0, bwait: -1, burst: 0, bcd: 0 };
  if (kind !== 'ship') { const fwd = new V3(0, 0, 1).applyQuaternion(v.m.g.quaternion); v.hostile.vel = fwd.multiplyScalar(v.isJet ? 160 : 40); }
  else SFX.klaxon(v.g.position);
  SL.at.copy(P.pos).add(new V3(R(-16, 16), 0, R(-16, 16)));
  showHit('hit'); SFX.alarm();
  showBanner('You fired on the ' + (kind === 'heli' ? 'Navy helicopter' : kind === 'jet' ? 'Air Force' : 'Navy'), kind === 'heli' ? 'It is turning to hunt you down' : kind === 'jet' ? 'The jet is coming round for you' : 'The warship is turning its guns on you', 3200);
}
function retaliationKill(kind, at) {
  if (!P.alive) return;
  const p = at || P.pos.clone().add(new V3(0, 0.5, 0));
  boom(p, 2.1); for (let i = 0; i < 3; i++) setTimeout(() => boom(p.clone().add(new V3(R(-3.5, 3.5), R(0, 1.5), R(-3.5, 3.5))), 1.2), 110 + i * 150);
  P.blind = Math.max(P.blind, 1.7);
  netSend({ t: 'fall', dmg: 999, cause: kind });
}
function boom(p, big = 1) {
  worldFlash(p, 200 * big);
  if (big >= 1.1) fireball(p, big);
  if (big >= 1.3) fires.push({ p: p.clone(), t: 2.5 + big * 2.2, a: 0 });
  for (let i = 0; i < 24 * big; i++) sparks.spawn(p, new V3(R(-1, 1), R(0.2, 1.4), R(-1, 1)).multiplyScalar(R(6, 16)), R(0.3, 0.8), 0.05, new THREE.Color(R(8, 12), R(4, 6), 1.2), 9.8, true);
  for (let i = 0; i < 22 * big; i++) debris.spawn(p, new V3(R(-1, 1), R(0.4, 1.5), R(-1, 1)).multiplyScalar(R(3, 10)), R(0.8, 1.8), R(0.05, 0.18), new THREE.Color(0x3a332c), 9.8);
  for (let i = 0; i < 14 * big; i++) { smoke.spawn(p.clone().add(new V3(R(-1, 1), R(0, 1.5), R(-1, 1))), new V3(R(-1.5, 1.5), R(1, 3.5), R(-1.5, 1.5)), R(1.8, 3.5), R(0.6, 1.4) * big, new THREE.Color(i < 4 ? 0x4a3a2e : 0x6e6860), -0.4, false, 1.5); smoke.p[smoke.p.length - 1].grow = true; }
  SFX.boom(p, big);
  const d = p.distanceTo(P.pos); if (d < 40) { const k = (1 - d / 40) * big; HITS.p.v += R(2, 4) * k; HITS.r.v += R(-3, 3) * k; HITS.y.v += R(-2, 2) * k; }
}
function aimNear(miss) { // a point on the ground around the player
  const a = Math.random() * Math.PI * 2; const p = P.pos.clone().add(new V3(Math.cos(a) * miss, 0, Math.sin(a) * miss));
  p.y = Math.max(groundAt(p.x, p.z, 0.1, P.pos.y + 2), P.pos.y - 3); return p;
}
const missiles = [];
const missileMat = std({ color: 0xd8dcdc, roughness: 0.4, metalness: 0.5 }), plumeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6, 3), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
function launchMissile(from, kind, to) { // with a `to` it is an unguided rocket for that spot (a near miss); without, it homes on the player
  const g = new THREE.Group(); const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 2.8, 10).rotateX(Math.PI / 2), missileMat); g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 10).rotateX(Math.PI / 2), missileMat); nose.position.z = 1.65; g.add(nose);
  for (let i = 0; i < 4; i++) { const fin = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.4), missileMat); fin.rotation.z = i * Math.PI / 2; fin.position.z = -1.2; fin.translateY(0.22); g.add(fin); }
  const pl = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), plumeMat); pl.scale.set(1, 1, 4); pl.position.z = -2.4; g.add(pl);
  g.position.copy(from); scene.add(g);
  missiles.push({ g, pl, kind, v: to ? (kind === 'jet' ? 265 : 120) : 230, t: 0, to: to || null });
  SFX.boom(from, 0.4); if (AC) SFX.whistle(Math.min(3, from.distanceTo(to || P.pos) / (to ? 200 : 230)));
}
function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i]; m.t += dt;
    const tgt = m.to || P.pos.clone().add(new V3(0, 0.9, 0)); const to = tgt.clone().sub(m.g.position), d = to.length();
    m.g.lookAt(tgt); m.g.position.addScaledVector(to.normalize(), Math.min(d, m.v * dt));
    m.pl.scale.set(1, 1, R(3.4, 5.5));
    for (let k = 0; k < 2; k++) { smoke.spawn(m.g.position.clone().addScaledVector(to, -k * m.v * dt * 0.5), new V3(R(-0.3, 0.3), R(0, 0.4), R(-0.3, 0.3)), R(1.6, 2.8), R(0.4, 0.7), new THREE.Color(0xd8d4ce), -0.1, false, 0.9); smoke.p[smoke.p.length - 1].grow = true; }
    if (!m.to && P.alive) setThreat('MISSILE', m.g.position, 1);
    if (d < 2 || m.t > 8 || (!m.to && !P.alive)) { scene.remove(m.g); missiles.splice(i, 1); if (!m.to && P.alive && d < 2) retaliationKill(m.kind, tgt); else boom(m.to ? tgt : m.g.position.clone(), m.to ? 1.6 : 1); }
  }
}
const shells = [];
function updateShells(dt) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i]; s.t += dt; const k = Math.min(1, s.t / s.dur);
    const p = s.a.clone().lerp(s.b, k); p.y += Math.sin(k * Math.PI) * s.arc; s.m.position.copy(p);
    smoke.spawn(p, new V3(R(-0.2, 0.2), R(0, 0.3), R(-0.2, 0.2)), R(0.8, 1.4), R(0.25, 0.45), new THREE.Color(0xb9b4ac), -0.1, false, 1); smoke.p[smoke.p.length - 1].grow = true;
    if (P.alive) setThreat('NAVY WARSHIP', s.a, s.kill ? 1 : 0.9);
    if (k >= 1) { scene.remove(s.m); shells.splice(i, 1); if (s.kill && P.alive) retaliationKill('ship', s.b.clone()); else boom(s.b.clone(), s.kill ? 1.3 : 1.5); }
  }
}
const shellMesh = () => new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), plumeMat);
function updateHostileAir(f, dt) {
  const h = f.hostile, g = f.m.g, pos = g.position; h.t += dt;
  const tgt = P.pos.clone(), flat = tgt.clone().sub(pos).setY(0), dist = flat.length();
  if (!P.alive && h.phase !== 'leave') { h.phase = 'leave'; h.t = 0; }
  if (!f.isJet) { // attack helicopter: its light finds you, a cannon run walks up short of you, rockets land either side, the second run does not stop
    f.m.rotor.rotation.y += dt * 30; f.m.tail.rotation.x += dt * 60; f.m.strobe.visible = (h.t % 1.2) < 0.08; f.m.blink.forEach(b => b.visible = (h.t % 1.0) < 0.6);
    const mz = new V3(0, -0.88, 6.7).applyMatrix4(g.matrixWorld);
    if (h.phase === 'come') {
      const want = flat.clone().normalize().multiplyScalar(Math.min(48, Math.max(0, dist - 55)));
      h.vel.lerp(want.setY(((P.pos.y + 24) - pos.y) * 0.8), Math.min(1, dt * 0.9));
      setThreat('NAVY HELICOPTER', pos, 0.2); if (dist < 160) searchlight(mz, dt);
      if (dist < 70 && h.t > 2) { h.phase = 'attack'; h.t = 0; }
    } else if (h.phase === 'attack') {
      h.vel.lerp(new V3(0, ((P.pos.y + 20) - pos.y) * 0.6, 0).add(flat.clone().normalize().multiplyScalar((dist - 55) * 0.4)), Math.min(1, dt * 1.5));
      searchlight(mz, dt);
      const T = h.t, run = T > 1.4 && T < 3.4 ? 1 : T > 5.6 ? 2 : 0;
      setThreat('NAVY HELICOPTER', pos, run === 2 ? 1 : T > 3.4 ? 0.8 : run ? 0.65 : 0.35);
      if (run) {
        if (h.run !== run) { h.run = run; h.ang = Math.atan2(pos.x - P.pos.x, pos.z - P.pos.z) + R(-0.6, 0.6); h.cd = 0; }
        h.cd -= dt;
        if (h.cd <= 0) {
          h.cd = 0.075; const u = (T - (run === 1 ? 1.4 : 5.6)) / 2, far = run === 1 ? lerp(20, 3.2, u) : lerp(17, 0, Math.min(1, u * 1.05));
          const e = P.pos.clone().add(new V3(Math.sin(h.ang) * far + R(-0.5, 0.5), 0, Math.cos(h.ang) * far + R(-0.5, 0.5))); e.y = Math.max(groundAt(e.x, e.z, 0.1, P.pos.y + 2), P.pos.y - 3);
          tracer(mz, e, 0.075); worldFlash(mz, 90); cannonHit(e); if ((h.shots++ & 1) === 0) SFX.cannon(mz); nearMiss(mz, e);
          if (run === 1 && u > 0.93 && !h.nick) { h.nick = true; netSend({ t: 'fall', dmg: 30, cause: 'heli' }); }
          if (run === 2 && far <= 0.05) { retaliationKill('heli', e); h.phase = 'leave'; h.t = 0; }
        }
      } else if (T > 3.8 + h.rk * 0.7 && h.rk < 2) { h.rk++; launchMissile(new V3(h.rk === 1 ? 1.6 : -1.6, -0.9, 2).applyMatrix4(g.matrixWorld), 'heli', aimNear(R(5, 8))); }
    } else { h.vel.lerp(new V3(pos.x, 0, pos.z).normalize().multiplyScalar(55).setY(10), Math.min(1, dt * 0.6)); if (h.t > 12) h.gone = true; }
    pos.addScaledVector(h.vel, dt);
    const look = h.phase === 'leave' ? pos.clone().add(h.vel.clone().setY(0)) : new V3(tgt.x, pos.y, tgt.z);
    g.lookAt(look); g.rotateX(h.phase === 'attack' ? 0.12 : clamp(h.vel.length() / 48, 0, 1) * 0.22);
  } else { // jet: extend, turn back, dive in, a ranging missile that just misses, then the one that does not, pull out
    if (f.m.flame) f.m.flame.scale.set(1, 1, 0.9 + Math.random() * 0.4);
    const sp = h.phase === 'run' ? 150 : 170, hold = (75 - pos.y) * 0.012; let want;
    const toP = flat.clone().normalize(), curH = h.vel.clone().setY(0).normalize();
    if (h.phase === 'extend') { want = curH.clone().setY(hold); if (dist > 650 && h.t > 2) { h.phase = 'turn'; h.t = 0; } }
    else if (h.phase === 'turn') { want = toP.clone().setY(hold); setThreat('AIR FORCE JET', pos, 0.3); if (curH.dot(toP) > 0.97) { h.phase = 'run'; h.t = 0; } }
    else if (h.phase === 'run') {
      want = tgt.clone().add(new V3(0, 6, 0)).sub(pos).normalize();
      setThreat('AIR FORCE JET', pos, h.fired ? 1 : h.warn ? 0.9 : clamp(1.25 - dist / 800, 0.5, 0.85));
      if (dist < 700 && !h.warn) { h.warn = true; launchMissile(new V3(2.5, -1.2, 2).applyMatrix4(g.matrixWorld), 'jet', aimNear(R(6, 10))); }
      if (dist < 430 && !h.fired) { h.fired = true; launchMissile(new V3(-2.5, -1.2, 2).applyMatrix4(g.matrixWorld), 'jet'); }
      if ((h.fired && dist < 300) || curH.dot(toP) < 0) { h.phase = h.fired ? 'leave' : 'extend'; h.warn = h.fired; h.t = 0; }
    } else { want = curH.clone().setY(0.45); if (h.t > 9) h.gone = true; }
    want.normalize();
    const cur = h.vel.clone().normalize(), rate = (h.phase === 'turn' ? 0.75 : 0.9) * dt, ang = cur.angleTo(want);
    let axis = cur.clone().cross(want); if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0); axis.normalize();
    const nd = cur.clone().applyAxisAngle(axis, Math.min(ang, rate)).normalize();
    const bank = clamp(cur.clone().cross(nd).y / Math.max(dt, 1e-3) * 1.2, -1.2, 1.2);
    h.vel.copy(nd).multiplyScalar(sp); pos.addScaledVector(h.vel, dt); if (pos.y < 25) pos.y = 25;
    g.lookAt(pos.clone().add(h.vel)); h.bank = lerp(h.bank || 0, bank, Math.min(1, dt * 3)); g.rotateZ(-h.bank);
    if (f.wing) { f.wing.g.position.copy(pos).add(new V3(-12, -3, 0).applyQuaternion(g.quaternion)); f.wing.g.quaternion.copy(g.quaternion); }
  }
  if (h.gone) f.t = f.dur + 1;
  if (f.snd && AC) { const d = pos.distanceTo(camera.position); f.snd.g.gain.setTargetAtTime(f.isJet ? clamp(260 / (d + 40), 0, 2.4) : clamp(90 / (d + 20), 0, 1.8), AC.currentTime, 0.08); }
}
function updateHostileBoat(b, dt) { // warship: klaxon, searchlight, four shells that walk in, and its close-in gun raking around you between them
  const h = b.hostile; h.t += dt;
  if (!P.alive && h.phase !== 'leave') { h.phase = 'leave'; h.t = 0; }
  b.g.updateMatrixWorld();
  const tl = b.g.worldToLocal(P.pos.clone()); const yawT = Math.atan2(tl.x, tl.z);
  b.turret.rotation.y += clamp(angDiff(b.turret.rotation.y, h.phase === 'leave' ? 0 : yawT), -dt * 0.8, dt * 0.8);
  const mast = b.g.localToWorld(new V3(0, b.F + 7, 0)), ciws = b.g.localToWorld(new V3(0, b.F + 3.6, -b.L * 0.22));
  if (h.phase !== 'leave') { searchlight(mast, dt); setThreat('NAVY WARSHIP', b.g.position, h.phase === 'come' ? 0.3 : 0.45 + 0.12 * h.shots); }
  if (h.phase === 'come' && h.t > 3) { h.phase = 'attack'; h.t = 0; h.cd = 0.5; }
  if (h.phase === 'attack') {
    h.cd -= dt;
    if (h.bwait > 0) { h.bwait -= dt; if (h.bwait <= 0) { h.burst = 0.8; h.bcd = 0; SFX.brrt(ciws, 0.8); } }
    if (h.burst > 0) {
      h.burst -= dt; h.bcd -= dt;
      while (h.bcd <= 0) { h.bcd += 0.035; const e = aimNear(R(3.2, 9)); tracer(ciws, e, 0.05); if (Math.random() < 0.45) cannonHit(e, 0.6); else impact(e, [0, 1, 0], false, 1); nearMiss(ciws, e); worldFlash(ciws, 60); }
    }
    if (h.cd <= 0 && Math.abs(angDiff(b.turret.rotation.y, yawT)) < 0.1) {
      h.cd = 2.7; h.shots++;
      const mz = new V3(0, 0.75, 6.1).applyMatrix4(b.turret.matrixWorld);
      const kill = h.shots >= 4, e = kill ? P.pos.clone().add(new V3(0, 0.6, 0)) : aimNear([26, 14, 7][h.shots - 1]);
      worldFlash(mz, 220); SFX.boom(mz, 0.9); fireball(mz, 0.9);
      for (let i = 0; i < 12; i++) { smoke.spawn(mz.clone(), new V3(R(-2, 2), R(0.5, 2), R(-2, 2)), R(1.5, 3), R(1, 2), new THREE.Color(0x8a8580), -0.2, false, 1.2); smoke.p[smoke.p.length - 1].grow = true; }
      const m = shellMesh(); m.position.copy(mz); scene.add(m);
      const dur = Math.max(1.1, mz.distanceTo(e) / 260);
      shells.push({ m, a: mz, b: e, t: 0, dur, arc: mz.distanceTo(e) * 0.06, kill }); SFX.whistle(dur);
      if (kill) { h.phase = 'leave'; h.t = 0; } else h.bwait = 1.0;
    }
  }
  if (h.phase === 'leave' && h.t > 6) b.hostile = null;
}

// ======================================================= ROPE HELICOPTER
// A Hellenic Navy utility helicopter comes in low now and then, hovers with a rope down, carries anyone
// holding on to another part of the compound, drops them off and leaves. Everyone sees the same visit.
let UTIL_MAT = null, UTIL_PART = null;
function utilMaterials() {
  if (UTIL_MAT) return;
  const skin = skinTextures(1024, 2048, '#6f7a83', {
    marks(g, W, H) {
      for (const side of [1, -1]) {
        paintSide(g, W, H, side, 0.16, 0, gg => { gg.translate(0, -2); drawFlag(gg, 120); });
        paintSide(g, W, H, side, 0.28, 0, gg => { gg.translate(0, 4); drawText(gg, 'ΠΟΛΕΜΙΚΟ ΝΑΥΤΙΚΟ', 26, 'rgba(18,22,26,.8)'); });
        paintSide(g, W, H, side, side > 0 ? 0.42 : 0.6, 0, gg => { gg.translate(0, -30); drawRoundel(gg, 130); });
        paintSide(g, W, H, side, 0.86, 0, gg => { gg.translate(0, 20); drawText(gg, 'PN 52', 46, 'rgba(18,22,26,.8)'); });
        paintSide(g, W, H, side, 0.78, 0, gg => { gg.translate(0, -60); gg.fillStyle = 'rgba(14,16,18,.55)'; gg.fillRect(-70, -8, 140, 16); });
      }
      g.fillStyle = 'rgba(200,40,30,.7)'; g.fillRect(W * 0.46, H * 0.06, W * 0.08, H * 0.02); // tail warning band
      const gr = g.createLinearGradient(0, H * 0.35, 0, H * 0.55); gr.addColorStop(0, 'rgba(15,12,10,0)'); gr.addColorStop(0.5, 'rgba(15,12,10,.3)'); gr.addColorStop(1, 'rgba(15,12,10,0)');
      g.fillStyle = gr; g.fillRect(W * 0.4, H * 0.35, W * 0.2, H * 0.2);
    }
  });
  UTIL_MAT = std({ map: skin.map, bumpMap: skin.bump, bumpScale: 1.3, roughness: 0.58, metalness: 0.3 });
  const part = skinTextures(512, 512, '#6f7a83', {}); part.map.repeat.set(0.35, 0.35); part.bump.repeat.set(0.35, 0.35);
  UTIL_PART = std({ map: part.map, bumpMap: part.bump, bumpScale: 1.1, roughness: 0.58, metalness: 0.3 });
}
function makeUtilityHeli() { // twin-engine naval utility helicopter, forward = +z, ~16 m fuselage
  utilMaterials();
  const g = new THREE.Group(), M1 = UTIL_MAT, MP = UTIL_PART;
  am(g, loft([
    { z: -9.2, w: 0, ht: 0, hb: 0, y: 1.0 }, { z: -9.0, w: 0.34, ht: 0.3, hb: 0.24, y: 1.0, n: 2.4 }, { z: -6.0, w: 0.5, ht: 0.38, hb: 0.3, y: 0.9, n: 2.5 },
    { z: -3.6, w: 0.95, ht: 0.62, hb: 0.48, y: 0.68, n: 3 }, { z: -2.5, w: 2.0, ht: 1.05, hb: 0.95, y: 0.25, n: 4.5 }, { z: 0, w: 2.3, ht: 1.15, hb: 1.05, y: 0.2, n: 5 },
    { z: 3.0, w: 2.25, ht: 1.1, hb: 1.05, y: 0.15, n: 5 }, { z: 4.6, w: 2.0, ht: 0.78, hb: 0.98, y: 0.05, n: 4 }, { z: 5.8, w: 1.55, ht: 0.42, hb: 0.72, y: -0.05, n: 3 },
    { z: 6.5, w: 0.7, ht: 0.18, hb: 0.38, y: -0.12, n: 2.5 }, { z: 6.75, w: 0, ht: 0, hb: 0, y: -0.12 }
  ], 56, 120), M1);
  am(g, loft([ // windscreen
    { z: 3.9, w: 0, ht: 0, hb: 0.05, y: 0.95 }, { z: 4.1, w: 1.9, ht: 0.3, hb: 0.05, y: 0.9, n: 3.6 }, { z: 5.1, w: 1.8, ht: 0.42, hb: 0.05, y: 0.55, n: 3.4 },
    { z: 6.1, w: 1.3, ht: 0.3, hb: 0.05, y: 0.12, n: 3 }, { z: 6.45, w: 0, ht: 0, hb: 0.05, y: 0.0 }
  ], 36, 40), AIRM.glass);
  for (const s of [-1, 1]) am(g, new THREE.BoxGeometry(0.03, 0.55, 0.8), AIRM.glass, s * 1.1, 0.55, 3.6);
  // open sliding door on the right (+x) with the dark cabin behind it, door slid back
  am(g, new THREE.BoxGeometry(0.04, 1.45, 2.4), AIRM.black, 1.12, 0.0, 0.6);
  am(g, new THREE.BoxGeometry(0.07, 1.5, 2.45), MP, 1.2, 0.02, -1.9);
  for (const z of [-0.4, 1.6]) am(g, new THREE.BoxGeometry(0.05, 1.5, 0.06), AIRM.gunmetal, 1.14, 0.0, z);
  am(g, new THREE.BoxGeometry(0.04, 0.9, 1.4), AIRM.glass, -1.12, 0.3, 0.6); // closed left door window
  // hoist beam over the door: the rope hangs from here
  am(g, new THREE.BoxGeometry(0.9, 0.12, 0.14), AIRM.gunmetal, 1.5, 0.95, 0.6); am(g, new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12).rotateX(Math.PI / 2), AIRM.black, 1.9, 0.88, 0.6);
  // engines, exhausts, mast
  am(g, loft([{ z: -3.0, w: 0, ht: 0, hb: 0, y: 1.3 }, { z: -2.7, w: 1.2, ht: 0.35, hb: 0.05, y: 1.3, n: 3 }, { z: 1.6, w: 1.45, ht: 0.55, hb: 0.05, y: 1.3, n: 3.4 }, { z: 2.4, w: 0, ht: 0, hb: 0.05, y: 1.3 }], 28, 30), MP);
  for (const s of [-1, 1]) { am(g, cylZ(0.2, 0.17, 0.6, 14), AIRM.exhaust, s * 0.55, 1.55, -2.9, 0, s * 0.4, 0); am(g, new THREE.CircleGeometry(0.2, 16), AIRM.black, s * 0.5, 1.55, 1.95); }
  am(g, new THREE.CylinderGeometry(0.12, 0.16, 0.7, 14), AIRM.gunmetal, 0, 2.05, 0.1);
  // sponsons with main wheels, nose wheel
  for (const s of [-1, 1]) {
    am(g, loft([{ z: -1.4, w: 0, ht: 0, hb: 0, y: 0 }, { z: -1.0, w: 0.6, ht: 0.28, hb: 0.25, n: 2.6 }, { z: 1.2, w: 0.7, ht: 0.3, hb: 0.28, n: 2.8 }, { z: 1.7, w: 0, ht: 0, hb: 0 }], 20, 20), MP, s * 1.3, -0.75, -0.8);
    am(g, new THREE.CylinderGeometry(0.32, 0.32, 0.2, 20).rotateZ(Math.PI / 2), AIRM.rubber, s * 1.45, -1.25, -0.6);
  }
  am(g, new THREE.CylinderGeometry(0.22, 0.22, 0.16, 18).rotateZ(Math.PI / 2), AIRM.rubber, 0, -1.25, 5.0); am(g, new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), AIRM.gunmetal, 0, -1.0, 5.0);
  // tail fin, stabiliser, tail rotor on the left
  const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.3, 0); fin.lineTo(0.9, 2.0); fin.lineTo(0.1, 2.0); fin.closePath();
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 }); fg.translate(0, 0, -0.07); fg.rotateY(Math.PI / 2);
  am(g, fg, MP, 0, 1.15, -7.9);
  for (const s of [-1, 1]) { const sg = wingGeo([[0, 0.32], [1.5, 0.15], [1.5, -0.25], [0, -0.4]], 0.07, 0.03); if (s < 0) sg.scale(-1, 1, 1); am(g, sg, MP, s * 0.2, 0.9, -6.6); }
  const tail = new THREE.Group(); tail.position.set(-0.22, 2.55, -8.65); g.add(tail);
  am(tail, new THREE.CylinderGeometry(0.1, 0.1, 0.16, 12).rotateZ(Math.PI / 2), AIRM.gunmetal);
  for (let i = 0; i < 4; i++) { const b = am(tail, new THREE.BoxGeometry(0.03, 1.3, 0.18).translate(0, 0.65, 0), AIRM.black, -0.05, 0, 0); b.rotation.x = i * Math.PI / 2; }
  // main rotor
  const rotor = new THREE.Group(); rotor.position.set(0, 2.45, 0.1); g.add(rotor);
  am(rotor, new THREE.CylinderGeometry(0.36, 0.3, 0.28, 18), AIRM.gunmetal);
  const airfoil = [[0, 0.27], [7.3, 0.26], [7.6, 0.1], [7.62, -0.2], [0, -0.25]];
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group(); arm.rotation.y = i * Math.PI / 2 + 0.4; rotor.add(arm);
    am(arm, new THREE.BoxGeometry(0.2, 0.12, 0.7), AIRM.gunmetal, 0, 0, 0.55);
    am(arm, wingGeo(airfoil.map(([a, b]) => [b, a]), 0.05, 0.02), AIRM.black, 0, 0, 0.6, 0, 0, 0.05);
    am(arm, new THREE.BoxGeometry(0.5, 0.075, 0.25), std({ color: 0xc9b23a, roughness: 0.6 }), 0, 0, 8.1);
  }
  const disk = new THREE.Mesh(new THREE.CircleGeometry(8.3, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ROTOR_BLUR, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.8 }));
  disk.position.y = 0.02; rotor.add(disk);
  const nr = am(g, new THREE.SphereGeometry(0.06, 8, 6), AIRM.navR, -1.45, -0.5, -0.6), ng = am(g, new THREE.SphereGeometry(0.06, 8, 6), AIRM.navG, 1.45, -0.5, -0.6);
  const strobe = am(g, new THREE.SphereGeometry(0.07, 8, 6), AIRM.strobe, 0, 3.2, -8.0);
  // crew chief kneeling in the door, watching the rope
  const crew = makeOperator(9, 0x6b6a5c); crew.g.position.set(0.55, -0.95, 0.6); crew.g.rotation.y = Math.PI / 2; crew.g.scale.setScalar(0.98); g.add(crew.g);
  g.traverse(o => { if (o.isMesh && o.material.transparent) o.castShadow = false; });
  return { g, rotor, tail, strobe, blink: [nr, ng], crew, anchor: new V3(1.9, 0.82, 0.6) };
}

const ROPE_N = 17, ROPE_SEG = 0.65, HOVER_Y = 9.85;
// Two rope helicopters can be out at once: the match's regular visit, and the extraction flight that
// collects anyone still aboard the cargo ship when it sails (see the dock section).
function newRopeHeli(kind) { return { kind, active: false, m: null, t: 0, n: 0, pts: [], prev: [], mesh: null, snd: null, yaw: 0, vel: new V3(), lastPos: new V3(), phase: '', canGrab: false, path: null, clock: null }; }
const ropeHeli = newRopeHeli('visit'), exHeli = newRopeHeli('extract');
const ROPE_HELIS = [ropeHeli, exHeli];
function ropeMesh() {
  const m = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 8), ropeMaterial(), ROPE_N - 1);
  m.castShadow = true; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); return m;
}
function ropeTimeline(r) {
  const A = new V3(r.a[0], HOVER_Y, r.a[1]), B = new V3(r.b[0], HOVER_Y, r.b[1]);
  const E = new V3(A.x + r.from * 170, 48, -270), X = new V3(B.x - r.from * 220, 75, 280);
  const dAB = Math.hypot(B.x - A.x, B.z - A.z), tT = Math.max(9, dAB / 7.5) + 2;
  return { A, B, E, X, T: [22, 14, tT, 8, 26] };
}
const bez = (a, b, c, d, u) => { const v = 1 - u; return a.clone().multiplyScalar(v * v * v).addScaledVector(b, 3 * v * v * u).addScaledVector(c, 3 * v * u * u).addScaledVector(d, u * u * u); };
function ropeHeliPos(tl, t) {
  const [t0, t1, t2, t3, t4] = tl.T, { A, B, E, X } = tl;
  if (t < t0) { const u = 1 - Math.pow(1 - t / t0, 2); return { p: bez(E, new V3(lerp(E.x, A.x, 0.6), 40, A.z - 70), new V3(A.x, HOVER_Y + 6, A.z - 25), A, u), ph: 'in' }; }
  t -= t0;
  if (t < t1) return { p: A.clone().add(new V3(Math.sin(t * 0.7) * 0.25, Math.sin(t * 0.9) * 0.18, Math.cos(t * 0.6) * 0.25)), ph: 'hoverA' };
  t -= t1;
  if (t < t2) { const u = smoothK(t / t2); const p = A.clone().lerp(B, u); p.y = HOVER_Y + 9 * Math.sin(Math.PI * u); return { p, ph: 'transit' }; }
  t -= t2;
  if (t < t3) return { p: B.clone().add(new V3(Math.sin(t * 0.8) * 0.2, -0.15 + Math.sin(t) * 0.12, Math.cos(t * 0.7) * 0.2)), ph: 'hoverB' };
  t -= t3;
  if (t < t4) { const u = Math.pow(t / t4, 1.6); return { p: bez(B, new V3(B.x, HOVER_Y + 10, B.z + 25), new V3(lerp(B.x, X.x, 0.5), 50, lerp(B.z, X.z, 0.6)), X, u), ph: 'out' }; }
  return null;
}
function launchRopeHeli(H, path, t, yaw) {
  if (!H.m) { H.m = takeModel('utility'); H.mesh = ropeMesh(); }
  H.path = path; H.t = t;
  const s = path(t); if (!s) { H.active = false; return false; }
  H.active = true; H.phase = s.ph; H.vel.set(0, 0, 0); H.canGrab = false;
  H.m.g.position.copy(s.p); H.lastPos.copy(s.p); H.yaw = yaw; H.m.g.rotation.set(0, yaw, 0);
  scene.add(H.m.g, H.mesh);
  const an = ropeAnchor(H);
  H.pts = []; H.prev = [];
  for (let i = 0; i < ROPE_N; i++) { const p = an.clone().add(new V3(0, -i * ROPE_SEG, 0)); H.pts.push(p); H.prev.push(p.clone()); }
  if (AC) H.snd = rotorSound();
  return true;
}
function startRopeHeli(r) {
  if (ropeHeli.active && ropeHeli.n === r.n) return;
  stopRopeHeli(ropeHeli);
  const tl = ropeTimeline(r); ropeHeli.n = r.n; ropeHeli.tl = tl; ropeHeli.clock = null;
  if (launchRopeHeli(ropeHeli, t => ropeHeliPos(tl, t), (r.age || 0) / 1000, Math.atan2(tl.A.x - tl.E.x, tl.A.z - tl.E.z)) && ropeHeli.phase === 'in')
    showPrompt('Helicopter inbound · grab its rope (E) to fly across · you can shoot while you hang');
}
function stopRopeHeli(H = ropeHeli) {
  if (!H.active) return;
  H.active = false; if (P.rope && P.rope.h === H) releaseRope();
  scene.remove(H.m.g, H.mesh);
  if (H.snd) { try { H.snd.s.stop(); H.snd.o.stop(); H.snd.lfo.stop(); } catch (e) { } H.snd = null; }
}
function ropeAnchor(H) { const m = H.m; m.g.updateMatrixWorld(true); return m.anchor.clone().applyMatrix4(m.g.matrixWorld); }
function rotorSound() {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; f.Q.value = 1.6;
  const am1 = AC.createGain(); am1.gain.value = 0.5;
  const lfo = AC.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 19.5; const lg = AC.createGain(); lg.gain.value = 0.48; lfo.connect(lg); lg.connect(am1.gain); lfo.start();
  const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 1150; const of = AC.createBiquadFilter(); of.type = 'bandpass'; of.frequency.value = 1150; of.Q.value = 6; const og = AC.createGain(); og.gain.value = 0.05;
  const g = AC.createGain(); g.gain.value = 0; const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  s.connect(f); f.connect(am1); am1.connect(g); o.connect(of); of.connect(og); og.connect(g);
  if (pan) { g.connect(pan); pan.connect(master); } else g.connect(master);
  s.start(); o.start(); return { s, o, lfo, g, pan };
}
function updateRopeHeli(H, dt) {
  if (!H.active) return;
  const tWas = H.t; if (H.clock) H.t = H.clock(); else H.t += dt;
  const s = H.path(H.t);
  if (!s) { stopRopeHeli(H); return; }
  const m = H.m, prevPh = H.phase; H.phase = s.ph;
  const v = s.p.clone().sub(H.lastPos).divideScalar(Math.max(dt, 1e-3)); H.lastPos.copy(s.p);
  if (v.lengthSq() > 250000) v.set(0, 0, 0); // a clock jump, not real speed
  const acc = v.clone().sub(H.vel).divideScalar(Math.max(dt, 1e-3)); H.vel.lerp(v, Math.min(1, dt * 4));
  const hs = Math.hypot(H.vel.x, H.vel.z);
  let wantYaw = H.yaw;
  if (hs > 2.5) wantYaw = Math.atan2(H.vel.x, H.vel.z);
  const dy = clamp(angDiff(H.yaw, wantYaw), -dt * 0.6, dt * 0.6); H.yaw += dy;
  const fwd = new V3(Math.sin(H.yaw), 0, Math.cos(H.yaw));
  const pitch = clamp(H.vel.dot(fwd) * 0.012 + clamp(acc.dot(fwd), -3, 3) * 0.02, -0.18, 0.25), roll = clamp(-dy / Math.max(dt, 1e-3) * 0.5, -0.3, 0.3);
  m.g.position.copy(s.p); m.g.rotation.set(0, 0, 0); m.g.rotation.order = 'YXZ'; m.g.rotation.set(pitch, H.yaw, roll);
  m.rotor.rotation.y += dt * 28; m.tail.rotation.x += dt * 70; m.strobe.visible = (H.t % 1.1) < 0.08; m.blink.forEach(b => b.visible = (H.t % 1.0) < 0.6);
  poseOperator(m.crew, { vf: 0, vs: 0, crouch: 1, pitch: -0.6, aim: 0.15, reload: -1, rope: 0, w: 0, dt });
  // rope: verlet chain pinned at the hoist, pulled by riders; it lies on the ground or the ship's deck, never through it
  const pts = H.pts, prev = H.prev, an = ropeAnchor(H), an0 = pts[0].clone();
  { // a wall-clock flight can jump when a frame hitches: carry the rope along with the jump instead of whipping it
    const real = H.t - tWas, jump = an.clone().sub(an0);
    const f = real > dt * 1.5 ? 1 - dt / real : jump.length() > 45 * dt ? 1 - 45 * dt / jump.length() : 0;
    if (f > 0) { jump.multiplyScalar(f); for (let i = 0; i < ROPE_N; i++) { pts[i].add(jump); prev[i].add(jump); } an0.add(jump); }
  }
  const riders = [];
  for (const r of remotes.values()) if (r.alive && (r.flags & 18)) riders.push(r.pos.clone().add(new V3(0, 2.05, 0)));
  const sub = Math.min(4, Math.ceil(dt / (1 / 120))), h = dt / sub;
  for (let k = 0; k < sub; k++) {
    for (let i = 1; i < ROPE_N; i++) {
      const p = pts[i], q = prev[i], vx = (p.x - q.x) * 0.99, vy = (p.y - q.y) * 0.99, vz = (p.z - q.z) * 0.99;
      q.copy(p); p.x += vx + (Math.random() - 0.5) * 0.0008 * (s.p.y < 20 ? 1 : 0); p.y += vy - 9.8 * h * h; p.z += vz;
      const fl = ropeFloor(p.x, p.z) + 0.03; if (p.y < fl) p.y = fl;
    }
    const ak = (k + 1) / sub; pts[0].copy(an0).lerp(an, ak);
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < ROPE_N - 1; i++) {
        const a = pts[i], b = pts[i + 1], d = b.clone().sub(a), L = d.length() || 1e-6, diff = (L - ROPE_SEG) / L;
        const wa = i === 0 ? 0 : 0.5, wb = i === 0 ? 1 : 0.5;
        a.addScaledVector(d, diff * wa); b.addScaledVector(d, -diff * wb);
      }
      pts[0].copy(an0).lerp(an, ak);
    }
  }
  for (const rp of riders) { let bi = 1, bd = 1e9; for (let i = 1; i < ROPE_N; i++) { const d = pts[i].distanceToSquared(rp); if (d < bd) { bd = d; bi = i; } } if (bd < 9) pts[bi].lerp(rp, 0.5); }
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  for (let i = 0; i < ROPE_N - 1; i++) { const a = pts[i], b = pts[i + 1], d = b.clone().sub(a), L = d.length(); q.setFromUnitVectors(up, d.divideScalar(L || 1)); mm.compose(a.clone().add(b).multiplyScalar(0.5), q, new V3(1, L, 1)); H.mesh.setMatrixAt(i, mm); }
  H.mesh.instanceMatrix.needsUpdate = true;
  // downwash dust over land, spray over the sea
  if (s.p.y < 22 && Math.random() < 0.55) {
    const a = Math.random() * Math.PI * 2, rr = R(1.5, 7), gx = s.p.x + Math.cos(a) * rr, gz = s.p.z + Math.sin(a) * rr, land = isLand(gx, gz), fl = ropeFloor(gx, gz);
    const gp = new V3(gx, land || fl > 0 ? fl + 0.15 : SEA_Y + 0.1, gz);
    if (s.p.y - gp.y < 19) { smoke.spawn(gp, new V3(Math.cos(a) * R(4, 8), R(0.3, 1.2), Math.sin(a) * R(4, 8)), R(0.7, 1.2), R(0.14, 0.3), new THREE.Color(land ? 0xc9bba4 : 0xdfe8ea), -0.4, false, 1.6); smoke.p[smoke.p.length - 1].grow = true; }
  }
  if (H.snd) {
    const rel = s.p.clone().sub(camera.position), d = rel.length();
    H.snd.g.gain.setTargetAtTime(clamp(95 / (d + 12), 0, 2.4), AC.currentTime, 0.1);
    if (H.snd.pan) { const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y)); H.snd.pan.pan.setTargetAtTime(clamp(rel.normalize().dot(right), -1, 1) * 0.8, AC.currentTime, 0.1); }
  } else if (AC) H.snd = rotorSound();
  if (P.rope && P.rope.h === H && prevPh === 'hoverB' && s.ph === 'out') releaseRope('Dropped off');
}
let ropeHintT = 0;
function ropeGrabCheck() {
  if (P.rope || !P.alive) return;
  for (const H of ROPE_HELIS) {
    H.canGrab = false; if (!H.active) continue;
    const pts = H.pts; let best = -1, bd = 0.95;
    for (let i = 2; i < ROPE_N; i++) { const p = pts[i]; if (p.y < P.pos.y + 0.3 || p.y > P.pos.y + 2.5) continue; const d = Math.hypot(p.x - P.pos.x, p.z - P.pos.z); if (d < bd) { bd = d; best = i; } }
    H.canGrab = best >= 0;
    if (best >= 0 && performance.now() - ropeHintT > 700) { ropeHintT = performance.now(); showPrompt('Press E to grab the rope'); }
  }
}
function grabRope(H, forced) {
  if (P.rope) return;
  if (!H) H = ROPE_HELIS.find(h => h.active && h.canGrab);
  if (!H || !H.active) return;
  const pts = H.pts; let bi = ROPE_N - 2, bd = 1e9;
  if (!forced) for (let i = 2; i < ROPE_N; i++) { const d = Math.abs(pts[i].y - (P.pos.y + 2.05)) + Math.hypot(pts[i].x - P.pos.x, pts[i].z - P.pos.z); if (d < bd) { bd = d; bi = i; } }
  P.rope = { h: H, i: bi, blend: forced ? 0 : 1, from: P.pos.clone(), dur: forced ? clamp(P.pos.distanceTo(pts[bi]) / 11, 1.3, 4.5) : 1.3 }; P.crouching = false; P.swim = false; P.ladder = null;
  SFX.mech('pouch'); showPrompt(forced ? 'The crew hooks you onto the rope · hold on' : 'On the rope · you can shoot and reload · E to let go');
}
function releaseRope(msg) {
  if (!P.rope) return; P.rope = null; P.onGround = false;
  P.vel.x = clamp(P.vel.x, -8, 8); P.vel.z = clamp(P.vel.z, -8, 8); P.vel.y = clamp(P.vel.y, -6, 4); P.minVy = Math.min(0, P.vel.y); // the rope's own whip never counts as a fall
  // never let go inside the ground, a roof or a wall
  const g = groundAt(P.pos.x, P.pos.z, 0.36, P.pos.y + 0.8); if (P.pos.y < g) { P.pos.y = g; P.vel.y = Math.max(0, P.vel.y); }
  collideCircle(P.pos, 0.36, P.pos.y, P.pos.y + 1.8);
  if (msg) showPrompt(msg);
}
function updateRopeRider(dt) {
  const H = P.rope.h;
  if (!H.active) { releaseRope(); return; }
  const pt = H.pts[P.rope.i], target = pt.clone(); target.y -= 2.05;
  // the rope's tail lies on the ground while the helicopter hovers: stand on whatever is under your hands instead of sinking into it
  const g = groundAt(target.x, target.z, 0.3, pt.y - 0.3); let standing = false;
  if (target.y < g) { target.y = g; standing = true; }
  if (target.y < SWIM_Y) target.y = SWIM_Y;
  if (P.rope.blend < 1) { P.rope.blend = Math.min(1, P.rope.blend + dt / P.rope.dur); target.copy(P.rope.from.clone().lerp(target, smoothK(P.rope.blend))); }
  P.vel.copy(target).sub(P.pos).divideScalar(Math.max(dt, 1e-3)); P.pos.copy(target);
  P.onGround = false; P.sprint = 0; P.bobAmt = 0; P.crouch = lerp(P.crouch, 0, dt * 8); P.flinch = Math.max(0, P.flinch - dt);
  weaponTick(dt, false);
  if (H.phase === 'hoverB' && (standing || P.pos.y - groundAt(P.pos.x, P.pos.z, 0.3, P.pos.y + 0.5) < 0.45)) releaseRope('Dropped off');
}

// ======================================================= DOCK: east yard, pier, swimming, ladders, quay crane and the cargo ship
// Land is two rectangles at y=0 (the compound + east yard, and the pier). Everything else inside MAP is sea: you fall in and swim,
// and climb out on a ladder. A container ship comes in on a fixed wall-clock schedule (so every player sees the same thing),
// berths along the pier, the crane loads four containers onto it, and it backs out, turns and leaves.
const LAND = [{ x0: -42.6, x1: 70.6, z0: -25.2, z1: 38.6 }, { x0: 46, x1: 62, z0: -64, z1: -25.2 }];
function isLand(x, z, m = 0) { for (const r of LAND) if (x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m) return true; return false; }
const SWIM_Y = -1.9 - 1.42; // feet height while swimming: eyes just above the surface
const LADDERS = [ // x, z at the quay face, n = direction from the water onto land
  { x: -30, z: -25.2, nx: 0, nz: 1 }, { x: 12, z: -25.2, nx: 0, nz: 1 }, { x: 44, z: -25.2, nx: 0, nz: 1 }, { x: 66, z: -25.2, nx: 0, nz: 1 },
  { x: 46, z: -37, nx: 1, nz: 0 }, { x: 46, z: -55, nx: 1, nz: 0 }, { x: 62, z: -35, nx: -1, nz: 0 }, { x: 62, z: -53, nx: -1, nz: 0 },
  { x: 54, z: -64, nx: 0, nz: 1 }
];
const WATER_BLOCKS = [ // sea inside MAP, for the bots' nav grid (they never go swimming)
  { min: [-43, 0, -67], max: [46, 2, -25.2] }, { min: [62, 0, -67], max: [71, 2, -25.2] }, { min: [46, 0, -67], max: [62, 2, -64] }
];
let DM = null;
function dockMats() {
  return DM || (DM = {
    quay: antiTile(std({ map: T.concrete, color: 0xb9b4aa, roughness: 0.92 }), [0.8, 0.76, 0.7], 0.7),
    quayDark: std({ map: T.concrete, color: 0x7d7a74, roughness: 0.95 }),
    yellow: std({ color: 0xe0b82a, roughness: 0.55, metalness: 0.2 }),
    black: std({ color: 0x1b1b1a, roughness: 0.7 }),
    crane: std({ color: 0x1f5596, roughness: 0.5, metalness: 0.45 }),
    craneWhite: std({ color: 0xe9ecee, roughness: 0.45, metalness: 0.3 }),
    rust: std({ map: T.paint, color: 0x9a6a4a, roughness: 0.8, metalness: 0.4 }),
    fender: std({ color: 0x151515, roughness: 0.95 }),
    ladder: std({ color: 0xd9a81e, roughness: 0.5, metalness: 0.6 }),
    reel: std({ map: T.wood, color: 0x9a7a52, roughness: 0.85 }),
    pipe: std({ color: 0x5a5f63, roughness: 0.45, metalness: 0.8 }),
    tank: std({ color: 0xdedcd6, roughness: 0.5, metalness: 0.4 })
  });
}
function hazardCurb(x0, z0, x1, z1, gaps = []) { // 0.2 m yellow/black steel kerb along a quay edge (step over it to fall in)
  const D = dockMats(), along = Math.abs(x1 - x0) > Math.abs(z1 - z0), a0 = along ? x0 : z0, a1 = along ? x1 : z1;
  const seg = (s0, s1) => {
    if (s1 - s0 < 0.2) return;
    for (let s = s0; s < s1 - 0.01; s += 1.0) {
      const e = Math.min(s1, s + 1.0), m = (s + e) / 2, l = e - s, mat = Math.round(s) % 2 ? D.yellow : D.black;
      if (along) addBox(m, 0, z0, l, 0.2, 0.3, mat, { collide: false, s: 1 }); else addBox(x0, 0, m, 0.3, 0.2, l, mat, { collide: false, s: 1 });
    }
    if (along) addCollider(s0, 0, z0 - 0.15, s1, 0.2, z0 + 0.15); else addCollider(x0 - 0.15, 0, s0, x0 + 0.15, 0.2, s1);
  };
  let cur = a0; for (const g of gaps.slice().sort((a, b) => a - b)) { seg(cur, g - 0.7); cur = g + 0.7; } seg(cur, a1);
}
function ladderAt(L) {
  const D = dockMats(), side = L.nx !== 0, px = L.x - L.nx * 0.12, pz = L.z - L.nz * 0.12;
  for (const s of [-0.24, 0.24]) {
    const sx = px + (side ? 0 : s), sz = pz + (side ? s : 0);
    place(boxGeo(0.06, 3.3, 0.06, 1), D.ladder, sx, -1.65 - 0.05, sz, { cast: false });
    // grab handle arching up over the edge
    place(boxGeo(0.06, 1.05, 0.06, 1), D.ladder, sx + L.nx * 0.3, 0.52, sz + L.nz * 0.3);
    place(boxGeo(side ? 0.4 : 0.06, 0.06, side ? 0.06 : 0.4, 1), D.ladder, sx + L.nx * 0.12, 1.04, sz + L.nz * 0.12);
  }
  for (let y = -3.1; y < -0.05; y += 0.3) place(boxGeo(side ? 0.05 : 0.48, 0.04, side ? 0.48 : 0.05, 1), D.ladder, px, y, pz, { cast: false });
  place(boxGeo(side ? 0.02 : 1.1, 3.4, side ? 1.1 : 0.02, 1), D.yellow, L.x - L.nx * 0.015, -1.7, L.z - L.nz * 0.015, { cast: false }); // painted panel so ladders stand out from the water
}
function bollard(x, z) { const D = dockMats(); place(new THREE.CylinderGeometry(0.2, 0.26, 0.55, 14), D.black, x, 0.28, z); place(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 14), D.black, x, 0.58, z); addCollider(x - 0.27, 0, z - 0.27, x + 0.27, 0.6, z + 0.27); }
function cableReel(x, z, r = 0.8) { const D = dockMats(); place(new THREE.CylinderGeometry(r, r, 0.12, 20).rotateX(Math.PI / 2), D.reel, x, r, z - 0.45); place(new THREE.CylinderGeometry(r, r, 0.12, 20).rotateX(Math.PI / 2), D.reel, x, r, z + 0.45); place(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.8, 16).rotateX(Math.PI / 2), D.black, x, r, z); addCollider(x - r, 0, z - 0.52, x + r, r * 2, z + 0.52); }
function pipeStack(x, z, len, n = 3) { const D = dockMats(); let k = 0; for (let row = 0; row < n; row++) for (let i = 0; i < n - row; i++) { place(new THREE.CylinderGeometry(0.32, 0.32, len, 14, 1, true).rotateZ(Math.PI / 2), D.pipe, x, 0.32 + row * 0.56, z - (n - row - 1) * 0.32 + i * 0.64); k++; } addCollider(x - len / 2, 0, z - n * 0.33, x + len / 2, n * 0.56, z + n * 0.33); }
function pallet(x, z, h = 0.9) { addBox(x, 0, z, 1.2, 0.15, 1.0, M.wood, { collide: false, s: 1 }); addBox(x, 0.15, z, 1.1, h, 0.95, sr() < 0.5 ? M.burlap : M.canvas, { s: 1 }); }
function lightTower(x, z, h = 22) {
  const D = dockMats();
  place(new THREE.CylinderGeometry(0.22, 0.4, h, 10), D.craneWhite, x, h / 2, z); addCollider(x - 0.4, 0, z - 0.4, x + 0.4, h, z + 0.4);
  addBox(x, h, z, 2.4, 0.12, 0.8, M.steel, { collide: false });
  for (let i = 0; i < 4; i++) { place(boxGeo(0.5, 0.35, 0.2, 1), M.steel, x - 0.9 + i * 0.6, h + 0.32, z - 0.3, { rx: 0.5 }); place(boxGeo(0.42, 0.26, 0.04, 1), M.lamp, x - 0.9 + i * 0.6, h + 0.27, z - 0.42, { rx: 0.5, cast: false }); }
}

function dockYard() {
  const D = dockMats();
  // ---- ground: yard slab and the pier, with quay faces down into the sea (solid walls a swimmer runs into)
  addBox(56.6, -0.03, 6.7, 28, 0.03, 63.8, D.quay, { collide: false, s: 5, receive: true });
  addBox(54, -0.7, -44.6, 16, 0.7, 38.8, D.quay, { collide: false, s: 5 });
  addBox(54, -4.5, -44.6, 16.1, 3.8, 38.9, D.quayDark, { collide: false, s: 4, cast: false });
  addBox(56.3, -4.5, -24.7, 28.6, 4.5, 1.0, D.quayDark, { collide: false, s: 4, cast: false });
  for (const r of LAND) addCollider(r.x0, -9, r.z0, r.x1, 0, r.z1, true);
  // lane markings on the pier and in the yard
  const line = (x, z, w, d, mat = M.stripe) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat); m.position.set(x, 0.012, z); m.receiveShadow = true; scene.add(m); };
  for (const x of [47.9, 60.1]) { line(x, -44.6, 0.35, 38.6, D.black); addBox(x, 0, -44.6, 0.12, 0.06, 38.6, M.steelLight, { collide: false }); } // crane rails
  line(54, -44.6, 0.14, 38); for (let z = -60; z < -27; z += 6.5) line(55.5, z, 2.6, 0.1);
  for (let z = -18; z < 34; z += 4) line(56.5, z, 0.14, 2);
  // ---- kerbs, bollards, fenders, ladders
  hazardCurb(42.6, -25.05, 46, -25.05, [44]); hazardCurb(62, -25.05, 70.6, -25.05, [66]);
  hazardCurb(46.15, -64, 46.15, -25.2, [-37, -55]); hazardCurb(61.85, -64, 61.85, -25.2, [-35, -53]); hazardCurb(46, -63.85, 62, -63.85, [54]);
  for (const z of [-29, -41, -47, -61]) { bollard(46.7, z); bollard(61.3, z); }
  bollard(50, -63.2); bollard(58, -63.2); bollard(68.5, -24.5);
  for (let z = -61; z <= -28; z += 5) { place(new THREE.CylinderGeometry(0.32, 0.32, 1.6, 12), D.fender, 45.72, -1.0, z, { cast: false }); }
  addBox(45.85, -0.55, -44.6, 0.25, 0.3, 38.4, M.wood, { collide: false, s: 2, cast: false });
  for (const L of LADDERS) ladderAt(L);
  // ---- east wall + south wall of the yard (concrete with a mesh fence on top), gate posts in the old east wall
  const CW = (x, z, w, d) => { addBox(x, 0, z, w, 2.6, d, D.quayDark, { s: 3, ch: 8 }); addBox(x, 2.6, z, w + 0.1, 0.12, d + 0.1, D.quay, { collide: false }); };
  CW(70.3, 6.7, 0.6, 63.8); CW(56.6, 38.3, 28, 0.6);
  for (let z = -24; z <= 37; z += 3) place(cyl(0.04, 1.4, 6), M.steel, 70.3, 3.4, z, { cast: false });
  for (let x = 43.5; x <= 69.5; x += 3) place(cyl(0.04, 1.4, 6), M.steel, x, 3.4, 38.3, { cast: false });
  for (const [x, z, w, d] of [[70.3, 6.7, 0.02, 63.6], [56.6, 38.3, 27.8, 0.02]]) place(boxGeo(w || 0.02, 1.3, d || 0.02, 2), chainMat(), x, 3.4, z, { cast: false });
  for (const [z0, z1] of [[-20.5, -15.5], [4.5, 9.5]]) for (const z of [z0, z1]) { addBox(42.3, 0, z, 0.9, 4.2, 0.9, D.quay, { s: 2 }); place(new THREE.SphereGeometry(0.16, 8, 6), M.lamp, 42.3, 4.35, z, { cast: false }); }
  for (const [z0, z1] of [[-20.5, -15.5], [4.5, 9.5]]) { addBox(43.1, 0, z1 + 2.6, 0.12, 2.2, 5.2, M.steel, { collide: false }); for (let k = 0; k < 9; k++) addBox(43.1, 0.1, z1 + 0.2 + k * 0.6, 0.06, 2.0, 0.05, M.steelLight, { collide: false }); addCollider(42.95, 0, z1 + 0.05, 43.25, 2.2, z1 + 5.2); }
  // ---- yard: container stacks in blocks with lanes between, a transit shed, cable reels, pipes, light towers
  const C = (x, z, alongZ, lvl, col) => container(x, z, alongZ, lvl, col);
  // north block by the quay (cover looking out at the pier)
  C(50, -16, false, 0, 1); C(50, -16, false, 1, 4);
  // middle rows
  C(48.5, -3, true, 0, 5); C(48.5, -3, true, 1, 2);
  C(64.5, 0, true, 0, 6); C(64.5, 0, true, 1, 1);
  // loading gantry: a steel deck at container height in the middle of the yard, stairs at both ends
  deck(54, -2.5, 60, 3.5, 2.6, false, ['x0', 'x1']); stairs(57, 7.6, 57, 3.5, 0, 2.6, 1.4, M.steel); stairs(55.2, -6.4, 55.2, -2.5, 0, 2.6, 1.2, M.steel);
  // transit shed in the south-east corner: open front, offices at the back
  building({ cx: 61.5, cz: 27.5, w: 15, d: 15.5, h: 7.2, doors: [{ side: 'w', off: -1.5, w: 9, h: 5.5 }, { side: 'n', off: -2.5, w: 5, h: 5 }, { side: 'n', off: 4.5, w: 1.3, h: 2.3 }] });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) pallet(57 + i * 1.6, 24 + j * 3.2, sr() < 0.5 ? 0.9 : 1.3);
  crate(66.5, 0, 22, 1.2); crate(66.5, 1.2, 22, 1.0, 0.3); crate(65.2, 0, 22.2, 1.1);
  addBox(65.8, 0, 32, 2.5, 1.0, 1.0, M.olive, { s: 1 }); ammoCrateAt(60, 0, 33.6); ammoCrateAt(51, 0, -10.8);
  for (let i = 0; i < 3; i++) addBox(68.4, 0.8 + i * 1.0, 28, 1.0, 0.06, 5, M.steel, { collide: i === 0 }); addBox(68.4, 0, 28, 1.0, 0.8, 5, M.steel, { s: 1 });
  cableReel(56, -8.5); cableReel(58.2, -8.2, 0.65); pipeStack(56, 18, 6); pipeStack(56.5, 33.5, 5, 2);
  jersey(44.8, 0, true, 3.2); barrel(45, 30, 1); barrel(45.6, 30.6, 2); barrel(44.6, 31.1, 0);
  lightTower(44.5, -22.5); lightTower(68.5, 12);
  // gate office
  building({ cx: 46, cz: 33.5, w: 4.4, d: 4.4, h: 2.8, wall: M.whitewash, roof: M.concreteDark, t: 0.2, base: false, doors: [{ side: 'e', off: 0, w: 1.1, h: 2.2 }, { side: 'n', off: 0, w: 1.6, h: 1.0, y0: 1.1 }] });
  // pier: container stacks to hide behind, a small hut, cable reel
  C(58, -30, true, 0, 4); C(58, -30, true, 1, 0); C(50.5, -45, true, 0, 5);
  building({ cx: 49.5, cz: -28.5, w: 3.6, d: 3.2, h: 2.6, wall: M.wallMetal, roof: M.roof, t: 0.12, base: false, doors: [{ side: 'e', off: 0, w: 1.0, h: 2.1 }, { side: 'n', off: 0, w: 1.4, h: 0.9, y0: 1.2 }] });
  cableReel(51.5, -38.5); pallet(57.8, -38); pallet(57.8, -36.8, 1.2);
  // the compound seawall's railing is rebuilt with gaps at its two ladders (see buildMap); hide spots for bots
  for (const [x, z] of [[50, -11.5], [63, -11], [61.5, 27], [58, -34], [50.5, -51], [49.5, 2], [46, 33.5], [65, -3]]) spot(x, z);
  // ---- industrial port beyond the east wall: tank farm and sheds (scenery)
  noCastScope = true;
  for (const [x, z, r, h] of [[84, -12, 6, 9], [84, 4, 6, 9], [98, -6, 7.5, 11], [97, 14, 5, 8]]) { place(new THREE.CylinderGeometry(r, r, h, 32), D.tank, x, h / 2, z); place(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.3, 32), D.rust, x, h, z); for (let a = 0; a < 6; a++) place(boxGeo(0.06, h, 0.06, 1), M.steel, x + Math.cos(a) * (r + 0.05), h / 2, z + Math.sin(a) * (r + 0.05)); }
  for (const [x, z, w, d, h] of [[90, 30, 22, 14, 9], [115, 8, 18, 30, 12], [86, -30, 14, 10, 7]]) { addBox(x, 0, z, w, h, d, M.wallMetal, { collide: false, s: 4 }); addBox(x, h, z, w + 0.6, 0.4, d + 0.6, M.roof, { collide: false, s: 4 }); }
  addBox(95, -0.2, 5, 60, 0.2, 90, D.quay, { collide: false, s: 6 });
  noCastScope = false;
  // ---- the quay crane and the moving parts are built by buildPort() at boot
}
let CHAIN = null;
function chainMat() {
  return CHAIN || (CHAIN = std({ map: ctex(128, (g, S) => { g.clearRect(0, 0, S, S); g.strokeStyle = 'rgba(160,165,170,1)'; g.lineWidth = 2; for (let i = -S; i < S * 2; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke(); g.beginPath(); g.moveTo(i + S, 0); g.lineTo(i, S); g.stroke(); } }), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.7 }));
}

// ---------------------------------------------------------------- ship + crane (moving)
const SHIP = { L: 90, B: 15, F: 5.4, D: 7, x: 37.5, zb: -27.6 - 45 }; // berthed: centre x, centre z (bow 0.6 m short of the seawall)
const SHIP_CYCLE = 540; // s: arrive 0-110, berth 110-260 (gangway down, you can board), back out 260-330, turn 330-390, leave 390-470, gone 470-540
const PIER_C = 55.5; // x of the containers waiting on the pier
const SHIP_BAYS = [-24.5, -18, -11.5, -5, 1.5, 8, 14.5, 21, 27.5], SHIP_ROWS = [-3.75, -1.25, 1.25, 3.75];
const PAD_BAYS = [-5, 1.5], PAD_Z = -1.75;                     // two bays stay clear: the winching pad for the helicopter
const DECK_Y = SHIP.F + 0.12, HATCH_Y = SHIP.F + 0.475;        // ship-local heights (world y = SEA_Y + local)
const GANG = { z0: 31.3, z1: 33.1, z2: 41.1, x0: 8.6, x1: 9.8 }; // gangway: landing z0..z1 at deck height, steps down to the pier at z2
const LOAD = [ // ship-local bay (z), row (x), tier the box lands on; pier z and pier level
  { bay: 27.5, row: -3.75, tier: 2 }, { bay: 21, row: -1.25, tier: 2 }, { bay: 21, row: 3.75, tier: 2 }, { bay: 14.5, row: 1.25, tier: 2 }
];
LOAD.forEach((s, i) => { s.pz = SHIP.zb + s.bay; s.lvl = i === 2 ? 1 : 0; s.pzz = s.pz; }); // boxes 1 and 2 wait stacked on the pier
const MOVE_T = [30, 132, 168, 204]; // start of each container move (move 0 picks early and hangs until the ship berths)
const port = { ship: null, crane: null, boxes: [], legs: [], cols: [], snd: null, hornAt: -1, shipVis: false, offset: 0, active: false, ox: 0, oz: 0, t: 0, stacks: [], warned: -1 };
function shipKeys(L, B, F, D) {
  return [
    { z: -L / 2, w: B * 0.9, ht: 0.1, hb: D * 0.55, y: F, n: 7, nb: 5 },
    { z: -L * 0.44, w: B * 0.98, ht: 0.1, hb: D * 0.85, y: F, n: 8, nb: 5 },
    { z: -L * 0.3, w: B, ht: 0.1, hb: D, y: F, n: 9, nb: 7 },
    { z: L * 0.22, w: B, ht: 0.1, hb: D, y: F, n: 9, nb: 7 },
    { z: L * 0.36, w: B * 0.92, ht: 0.1, hb: D, y: F + 0.3, n: 7, nb: 4 },
    { z: L * 0.45, w: B * 0.6, ht: 0.1, hb: D * 0.96, y: F + 0.9, n: 5, nb: 2.4 },
    { z: L * 0.495, w: B * 0.16, ht: 0.1, hb: D * 0.8, y: F + 1.2, n: 3, nb: 1.6 },
    { z: L * 0.5, w: 0.0, ht: 0.0, hb: D * 0.7, y: F + 1.3 }
  ];
}
const SHIP_GR = { key: 'gr', name: 'Aegean Star', hull: '#1c3350', title: 'AEGEAN STAR', sub: 'ΑΙΓΑΙΟ ΑΣΤΕΡΙ', reg: 'ΚΑΛΑΜΑΤΑ', line: 'HELLAS  LINES' };
const SHIP_US = [{ key: 'bos', us: true, from: 'Boston', name: 'Boston Trader', hull: '#5a211d', title: 'BOSTON TRADER', sub: 'ATLANTIC CARGO', reg: 'BOSTON', line: 'ATLANTIC  LINES' },
  { key: 'ny', us: true, from: 'New York', name: 'Hudson Liberty', hull: '#23292e', title: 'HUDSON LIBERTY', sub: 'TRANSATLANTIC', reg: 'NEW YORK', line: 'HUDSON  LINES' }];
const GREEK_PORTS = ['Thessaloniki', 'Kalamata', 'Analipsi', 'Messini'];
function shipVariant(n) { // every third arrival is international, Boston and New York taking turns; the rest come from the Greek ports
  const m = (n % 3 + 3) % 3, q = Math.floor(n / 3);
  return m === 2 ? SHIP_US[(q % 2 + 2) % 2] : Object.assign({}, SHIP_GR, { from: GREEK_PORTS[((q * 2 + m) % 4 + 4) % 4] });
}
const SHIP_SKINS = {};
function shipSkin(v = SHIP_GR) {
  if (SHIP_SKINS[v.key]) return SHIP_SKINS[v.key];
  const s0 = seed; seed = 77123 + v.key.length * 17; const sk = SHIP_SKINS[v.key] = shipSkin0(v); seed = s0; return sk; // its own random stream, so the rest of the world is built the same as ever
}
function shipSkin0(v) {
  return skinTextures(1024, 2048, v.hull, {
    marks(g, W, H) {
      // hull plating: strakes along the length, butt welds across
      g.strokeStyle = 'rgba(8,14,22,.35)'; g.lineWidth = 1.2;
      for (const u of [0.1, 0.14, 0.18, 0.215, 0.785, 0.82, 0.86, 0.9]) { g.beginPath(); g.moveTo(u * W, 0); g.lineTo(u * W, H); g.stroke(); }
      for (let y = 0; y < H; y += 46) { g.beginPath(); g.moveTo(0.08 * W, y); g.lineTo(0.24 * W, y); g.moveTo(0.76 * W, y); g.lineTo(0.92 * W, y); g.stroke(); }
      for (const side of [1, -1]) {
        const u = side > 0 ? 0.21 : 0.79;
        const txt = (s, v, size, du = 0, sx = 1) => { g.save(); g.translate((u + du * side) * W, (1 - v) * H); g.transform(0, side, -side, 0, 0, 0); g.fillStyle = 'rgba(240,240,236,.95)'; g.font = `700 ${size}px "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.scale(sx, 1); g.fillText(s, 0, 0); g.restore(); };
        txt(v.title, 0.86, 60); txt(v.sub, 0.1, 44); txt(v.reg, 0.1, 26, -0.02);
        txt(v.line, 0.5, 38, 0.0085, 1.9); // company name along the side, wide letters kept clear of the waterline
        g.fillStyle = 'rgba(230,230,226,.9)'; for (let k = 0; k < 6; k++) g.fillRect((side > 0 ? 0.12 : 0.86) * W, (1 - 0.985) * H + k * 8, 26, 3); // draught marks near the bow
        g.fillStyle = 'rgba(225,225,220,.9)'; g.fillRect((side > 0 ? 0.233 : 0.757) * W, 0, 7, H); // sheer line
        // rust weeping down from scuppers and from the anchor pocket, scuffs where fenders rub
        for (let i = 0; i < 46; i++) {
          const y = sr() * H, len = SR(40, 150), x0 = (side > 0 ? 0.236 : 0.764) * W;
          const gr = g.createLinearGradient(x0, 0, x0 - side * len, 0); gr.addColorStop(0, `rgba(128,66,30,${SR(0.25, 0.55)})`); gr.addColorStop(1, 'rgba(128,66,30,0)');
          g.fillStyle = gr; g.fillRect(side > 0 ? x0 - len : x0, y, len, SR(2, 7));
        }
        for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(190,196,200,${SR(0.05, 0.14)})`; g.fillRect((side > 0 ? SR(0.14, 0.2) : SR(0.8, 0.86)) * W, sr() * H, SR(8, 30), SR(20, 120)); }
        { const y = (1 - 0.955) * H, x0 = (side > 0 ? 0.225 : 0.775) * W, gr = g.createLinearGradient(x0, 0, x0 - side * 190, 0); gr.addColorStop(0, 'rgba(110,55,25,.7)'); gr.addColorStop(1, 'rgba(110,55,25,0)'); g.fillStyle = gr; g.fillRect(side > 0 ? x0 - 190 : x0, y - 14, 190, 28); }
      }
    }
  });
}
function containerBox(color) { const m = new THREE.Mesh(CBOX, containerMats[color % containerMats.length]); m.castShadow = true; m.receiveShadow = true; return m; }
const CBOX = boxGeo(2.44, 2.59, 6.06, 4.8);
let SHIPM = null;
function shipMats() {
  if (SHIPM) return SHIPM;
  const plate = (base, rust, k = 1) => ctex(512, (g, S) => {
    g.fillStyle = base; g.fillRect(0, 0, S, S); grain(g, S, 16);
    blot(g, S, 26, `rgba(0,0,0,${0.16 * k})`, 20, 110); blot(g, S, 18, `rgba(${rust},${0.22 * k})`, 10, 70); blot(g, S, 14, 'rgba(255,255,255,.06)', 20, 90);
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1.5; for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * S / 4); g.lineTo(S, i * S / 4); g.moveTo(i * S / 4, 0); g.lineTo(i * S / 4, S); g.stroke(); }
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(${rust},${SR(0.15, 0.4) * k})`; g.fillRect(sr() * S, sr() * S, SR(1, 3), SR(6, 40)); }
  });
  const tex = (t, r) => { t.repeat.set(r, r); return t; };
  const decal = (draw, w = 512, h = 512) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; return t; };
  const dm = map => new THREE.MeshStandardMaterial({ map, transparent: true, alphaTest: 0.35, roughness: 0.7, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -3 });
  const logo = (txt, sub, col = '#f2f2ee') => dm(decal((g, W, H) => {
    g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${txt.length > 10 ? 76 : txt.length > 7 ? 92 : 120}px "Arial Narrow", Arial, sans-serif`; g.fillText(txt, W / 2, H * 0.4, W * 0.94);
    g.font = '600 34px Arial, sans-serif'; g.fillText(sub, W / 2, H * 0.68, W * 0.94);
    g.fillRect(W * 0.1, H * 0.8, W * 0.8, 6);
  }, 512, 256));
  SHIPM = {
    deck: std({ map: tex(plate('#6e2f25', '70,28,14'), 1), roughness: 0.88, metalness: 0.15 }),
    hatch: std({ map: tex(plate('#55606a', '110,60,30'), 1), roughness: 0.75, metalness: 0.3 }),
    white: std({ map: tex(plate('#e9e9e3', '150,90,50', 0.3), 1), roughness: 0.55, metalness: 0.1 }),
    grey: NAVY.grey, dark: NAVY.dark, win: NAVY.window, orange: NAVY.orange,
    rail: std({ color: 0xe4e4dc, roughness: 0.5, metalness: 0.4 }),
    yellow: std({ color: 0xe0b82a, roughness: 0.55, metalness: 0.2 }),
    red: std({ color: 0xb02a20, roughness: 0.6 }),
    alu: std({ color: 0xb9bdc0, roughness: 0.4, metalness: 0.8 }),
    rope: std({ color: 0xcdbb8a, roughness: 0.95 }),
    lampOn: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffdca8, emissiveIntensity: 3.2 }),
    door: dm(decal((g, W, H) => { // container door end: two leaves, four locking bars with handles, placards
      g.strokeStyle = 'rgba(15,15,15,.75)'; g.lineWidth = 7; g.strokeRect(10, 10, W - 20, H - 20); g.beginPath(); g.moveTo(W / 2, 10); g.lineTo(W / 2, H - 10); g.stroke();
      for (const x of [0.16, 0.38, 0.62, 0.84]) { g.fillStyle = 'rgba(205,208,210,.95)'; g.fillRect(x * W - 5, 16, 10, H - 32); g.fillStyle = 'rgba(40,40,40,.9)'; g.fillRect(x * W - 9, H * 0.52, 18, 46); g.fillRect(x * W - 9, 30, 18, 14); g.fillRect(x * W - 9, H - 44, 18, 14); }
      g.fillStyle = 'rgba(240,240,236,.92)'; g.font = '700 30px Arial, sans-serif'; g.fillText('HLNU 204' + (3 + (sr() * 6 | 0)) + ' 7', W * 0.55, 96); g.font = '600 20px Arial, sans-serif'; g.fillText('MAX GROSS 30 480 KG', W * 0.55, 128); g.fillText('TARE  2 250 KG', W * 0.55, 154);
    })),
    logos: [logo('HELLAS', 'L I N E S'), logo('THESSALONIKI', 'ΘΕΣΣΑΛΟΝΙΚΗ · PORT AUTHORITY'), logo('KALAMATA', 'ΚΑΛΑΜΑΤΑ · SHIPPING CO.'), logo('ANALIPSI', 'ΑΝΑΛΗΨΗ · FREIGHT', '#ffe9b0'), logo('MESSINI', 'ΜΕΣΣΗΝΗ · CARGO LINES'), logo('AEGEAN', 'CONTAINER SERVICE'), logo('MEDCARGO', 'ΕΛΛΑΣ')],
    logosUS: [logo('BOSTON', 'ATLANTIC CARGO CO.'), logo('NEW YORK', 'HUDSON SHIPPING LINES'), logo('ATLANTIC', 'BOSTON · NEW YORK · PIRAEUS'), logo('U.S.A.', 'TRANSATLANTIC FREIGHT', '#ffe9b0')],
    flagUS: new THREE.MeshStandardMaterial({ map: decal((g, W, H) => { // stars and stripes for the stern of a visiting American ship
      for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#f1f1ec' : '#b22234'; g.fillRect(0, i * H / 13, W, H / 13 + 1); }
      g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, W * 0.4, H * 7 / 13); g.fillStyle = '#f1f1ec';
      for (let r = 0; r < 9; r++) for (let c = 0; c < (r % 2 ? 5 : 6); c++) { g.beginPath(); g.arc(W * 0.4 * ((c + (r % 2 ? 1 : 0.5)) / 6), H * 7 / 13 * ((r + 0.7) / 9.4), H * 0.013, 0, 7); g.fill(); }
    }, 512, 340), roughness: 0.8, side: THREE.DoubleSide, alphaTest: 0.5 }),
    funnelUS: std({ map: decal((g, W, H) => { // funnel of the visiting line: dark blue, red and white bands, a white star
      g.fillStyle = '#18294a'; g.fillRect(0, 0, W, H); g.fillStyle = '#f1f1ec'; g.fillRect(0, H * 0.62, W, H * 0.07); g.fillStyle = '#b22234'; g.fillRect(0, H * 0.72, W, H * 0.1); g.fillStyle = '#111'; g.fillRect(0, 0, W, H * 0.12);
      g.fillStyle = '#f1f1ec'; for (let k = 0; k < 4; k++) { const cx = (k + 0.5) * W / 4, cy = H * 0.38; g.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, rr = i % 2 ? 16 : 40; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.closePath(); g.fill(); }
    }, 512, 256), roughness: 0.5, metalness: 0.2 }),
    pad: new THREE.MeshStandardMaterial({ map: decal((g, W, H) => {
      g.strokeStyle = '#e8c330'; g.lineWidth = 16; g.beginPath(); g.arc(W / 2, H / 2, W * 0.42, 0, 7); g.stroke();
      g.strokeStyle = '#f0f0ea'; g.lineWidth = 6; g.setLineDash([26, 18]); g.beginPath(); g.arc(W / 2, H / 2, W * 0.3, 0, 7); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#f0f0ea'; g.font = '800 250px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', W / 2, H / 2 + 12);
      g.font = '700 30px Arial, sans-serif'; g.fillStyle = '#e8c330'; g.fillText('WINCH ONLY', W / 2, H * 0.83);
    }), transparent: true, alphaTest: 0.3, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }),
    funnel: std({ map: decal((g, W, H) => { // funnel: Aegean blue with the white cross
      g.fillStyle = '#1b56a0'; g.fillRect(0, 0, W, H); g.fillStyle = '#f1f1ec'; for (let k = 0; k < 4; k++) { const cx = (k + 0.5) * W / 4; g.fillRect(cx - 12, H * 0.25, 24, H * 0.42); g.fillRect(cx - 44, H * 0.4, 88, H * 0.12); }
      g.fillStyle = '#f1f1ec'; g.fillRect(0, H * 0.78, W, H * 0.07); g.fillStyle = '#111'; g.fillRect(0, 0, W, H * 0.12);
    }, 512, 256), roughness: 0.5, metalness: 0.2 })
  };
  return SHIPM;
}
// bake every plain mesh under src into dst as one mesh per material (the ship has hundreds of small parts)
function mergeInto(dst, src) {
  src.updateMatrixWorld(true); const groups = new Map();
  src.traverse(m => {
    if (!m.isMesh) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone(); g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups(); if (!groups.has(m.material)) groups.set(m.material, []); groups.get(m.material).push(g);
  });
  for (const [mat, geos] of groups) { const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat); mesh.castShadow = !mat.transparent; mesh.receiveShadow = true; dst.add(mesh); }
}
function makeShip() {
  const { L, B, F } = SHIP, g = new THREE.Group(), skin = shipSkin(), S = shipMats(), st = new THREE.Group();
  const hull = am(g, loft(shipKeys(L, B, F, SHIP.D), 64, 140), hullMaterial(skin.map, skin.bump));
  const bx = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => am(st, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  const cy = (r, h, mat, x, y, z, rx = 0, ry = 0, rz = 0, seg = 12, r2 = r) => am(st, new THREE.CylinderGeometry(r2, r, h, seg), mat, x, y, z, rx, ry, rz);
  const uvBox = (w, h, d, k = 0.25) => boxGeo(w, h, d, 1 / k);
  // ---- weather deck (red oxide non-slip), yellow walkway lines, hatch covers with coamings
  am(st, uvBox(B * 0.95, 0.12, L * 0.875), S.deck, 0, F + 0.06, -1.6);
  for (const s of [-1, 1]) bx(0.1, 0.01, 66, S.yellow, s * 5.35, DECK_Y + 0.006, 1.5);
  for (const z of SHIP_BAYS) {
    am(st, uvBox(B * 0.86, 0.35, 6.2), S.hatch, 0, F + 0.3, z);
    for (const dz of [-2.05, 0, 2.05]) bx(B * 0.86, 0.03, 0.1, S.dark, 0, HATCH_Y + 0.01, z + dz);
    for (const s of [-1, 1]) for (const dz of [-2.4, 2.4]) bx(0.18, 0.2, 0.3, S.yellow, s * 6.5, F + 0.3, z + dz); // hatch cleats
  }
  { const pad = new THREE.Mesh(new THREE.PlaneGeometry(11.5, 11.5).rotateX(-Math.PI / 2), S.pad); pad.position.set(0, HATCH_Y + 0.035, PAD_Z); pad.receiveShadow = true; g.add(pad); }
  // ---- deck cargo: 4 rows x 9 bays, 0-3 high, instanced per colour. The pad bays stay empty and so do a few slots, to leave lanes.
  const per = containerMats.map(() => []), hN = new Map(), key = (x, z) => x + ':' + z;
  for (const z of SHIP_BAYS) for (const x of SHIP_ROWS) {
    const slot = LOAD.find(q => q.bay === z && q.row === x);
    const n = PAD_BAYS.includes(z) ? 0 : slot ? slot.tier : sr() < 0.2 ? 0 : 1 + Math.floor(sr() * 3);
    hN.set(key(x, z), n); if (n) port.stacks.push({ x, z, n });
    for (let t = 0; t < n; t++) per[Math.floor(sr() * per.length)].push([x, HATCH_Y + 1.295 + t * 2.59, z]);
  }
  const mm = new THREE.Matrix4(), q4 = new THREE.Quaternion(), one = new V3(1, 1, 1);
  per.forEach((list, ci) => { if (!list.length) return; const im = new THREE.InstancedMesh(CBOX, containerMats[ci], list.length); list.forEach((p, i) => { mm.makeTranslation(p[0], p[1], p[2]); im.setMatrixAt(i, mm); }); im.castShadow = true; im.receiveShadow = true; g.add(im); });
  // door ends and company logos on every face you can see
  const doors = [], logos = S.logos.map(() => []);
  for (const { x, z, n } of port.stacks) for (let t = 0; t < n; t++) {
    const y = HATCH_Y + 1.295 + t * 2.59;
    for (const s of [-1, 1]) {
      if ((hN.get(key(x, z + s * 6.5)) || 0) <= t && (s > 0) === ((Math.round(x * 4 + z + t) & 1) === 0)) doors.push([x, y, z + s * 3.045, s > 0 ? 0 : Math.PI]);
      if ((hN.get(key(x + s * 2.5, z)) || 0) <= t) logos[Math.floor(sr() * logos.length)].push([x + s * 1.235, y + 0.25, z, s * Math.PI / 2]);
    }
  }
  const planes = (list, geo, mat) => { if (!list.length) return; const im = new THREE.InstancedMesh(geo, mat, list.length); list.forEach((p, i) => { q4.setFromEuler(new THREE.Euler(0, p[3], 0)); mm.compose(new V3(p[0], p[1], p[2]), q4, one); im.setMatrixAt(i, mm); }); im.receiveShadow = true; g.add(im); };
  planes(doors, new THREE.PlaneGeometry(2.36, 2.5), S.door); logos.forEach((l, i) => planes(l, new THREE.PlaneGeometry(4.6, 1.7), S.logos[i]));
  // ---- lashing bridges between the bays: posts, top beam, cross brace, a work light
  for (const z of SHIP_BAYS.concat(30.75)) {
    const zz = z - 3.25, low = PAD_BAYS.includes(z) || PAD_BAYS.includes(z - 6.5);
    for (const s of [-1, 1]) { bx(0.16, low ? 1.1 : 5.6, 0.16, S.grey, s * 5.3, HATCH_Y + (low ? 0.55 : 2.8), zz); if (!low) bx(0.08, 3.1, 0.08, S.grey, s * 6.1, DECK_Y + 1.5, zz, 0, 0, s * 0.55); }
    if (!low) { bx(10.8, 0.14, 0.5, S.grey, 0, HATCH_Y + 5.65, zz); bx(10.8, 0.05, 0.05, S.rail, 0, HATCH_Y + 6.7, zz - 0.22); bx(10.8, 0.05, 0.05, S.rail, 0, HATCH_Y + 6.7, zz + 0.22); for (const s of [-1, 1]) bx(0.3, 0.16, 0.2, S.lampOn, s * 4.4, HATCH_Y + 5.5, zz); }
  }
  // ---- rails: stanchions and three courses, with a gate where the gangway lands (starboard = +x faces the pier)
  for (const s of [-1, 1]) {
    for (let z = -41; z <= 36.3; z += 1.85) { if (s > 0 && z > GANG.z0 - 0.1 && z < GANG.z1 + 0.1) continue; bx(0.05, 1.08, 0.05, S.rail, s * 7.05, DECK_Y + 0.54, z); }
    const runs = s > 0 ? [[-41, GANG.z0], [GANG.z1, 36.3]] : [[-41, 36.3]];
    for (const [z0, z1] of runs) for (const h of [0.4, 0.74, 1.08]) bx(0.045, 0.045, z1 - z0, S.rail, s * 7.05, DECK_Y + h, (z0 + z1) / 2);
    for (const h of [0.4, 0.74, 1.08]) { bx(2.4, 0.045, 0.045, S.rail, s * 5.9, DECK_Y + h, 36.3); bx(0.045, 0.045, 0.045, S.rail, s * 7.05, DECK_Y + h, 36.3); }
    for (let z = -36; z <= 32; z += 11.3) { for (const dz of [-0.35, 0.35]) cy(0.16, 0.5, S.dark, s * 6.55, DECK_Y + 0.25, z + dz, 0, 0, 0, 10, 0.2); cy(0.2, 0.5, S.white, s * 6.6, DECK_Y + 0.25, z + 2.2); am(st, new THREE.SphereGeometry(0.3, 10, 6, 0, 7, 0, 1.6), S.white, s * 6.6, DECK_Y + 0.5, z + 2.2); } // bitts and mushroom vents
    for (let z = -20; z <= 30; z += 12.5) { bx(0.3, 0.7, 0.5, S.red, s * 6.75, DECK_Y + 0.75, z + 4.6); cy(0.05, 0.9, S.red, s * 6.75, DECK_Y + 0.45, z + 5.1); } // fire stations
  }
  for (const h of [0.4, 0.74, 1.08]) bx(14.1, 0.045, 0.045, S.rail, 0, DECK_Y + h, -41);
  for (let x = -7; x <= 7; x += 1.75) bx(0.05, 1.08, 0.05, S.rail, x, DECK_Y + 0.54, -41);
  // ---- forecastle: raised deck, windlasses with chain, foremast, anchors in their pockets
  block(st, S.white, 0, F, 39.6, 9.3, 1.55, 6.6, 0.42);
  for (const s of [-1, 1]) {
    cy(0.55, 1.3, S.dark, s * 1.9, F + 2.15, 38.6, 0, 0, Math.PI / 2, 16); cy(0.75, 0.12, S.dark, s * 2.6, F + 2.15, 38.6, 0, 0, Math.PI / 2, 16); bx(0.9, 0.5, 1.2, S.grey, s * 1.9, F + 1.8, 38.6);
    bx(0.14, 0.1, 2.6, S.dark, s * 1.5, F + 1.62, 40.4, 0, s * 0.18, 0); cy(0.2, 0.3, S.dark, s * 1.15, F + 1.65, 41.7);
    bx(0.25, 1.5, 1.7, S.dark, s * B * 0.262, F - 0.7, L * 0.47); bx(0.2, 0.3, 1.1, S.dark, s * B * 0.268, F - 1.45, L * 0.47);
    cy(0.45, 1.0, S.dark, s * 3, F + 0.62, -43.3, 0, 0, Math.PI / 2, 14); bx(1.2, 0.3, 1.0, S.grey, s * 3, F + 0.28, -43.3);
  }
  cy(0.12, 6.5, S.white, 0, F + 4.8, 40.8, 0, 0, 0, 10, 0.07); bx(2.2, 0.08, 0.08, S.white, 0, F + 6.6, 40.8); am(st, new THREE.SphereGeometry(0.14, 8, 6), S.lampOn, 0, F + 8.1, 40.8);
  // ---- accommodation block aft: five decks with real windows, walkways and rails on each deck, lifeboats in davits, stairs
  const az = -34.2, W = 12.3, Ln = 9, dh = 2.6;
  am(st, uvBox(W, dh * 4, Ln), S.white, 0, DECK_Y + dh * 2, az);
  for (let k = 1; k <= 4; k++) {
    const y = DECK_Y + k * dh, top = k === 4;
    bx(W + (top ? 2.6 : 1.5), 0.12, Ln + 1.4, S.grey, 0, y, az);
    for (const s of [-1, 1]) { for (const h of [0.5, 1.0]) bx(0.04, 0.04, Ln + 1.3, S.rail, s * (W / 2 + (top ? 1.25 : 0.7)), y + h, az); for (let z = -5; z <= 5; z += 1.67) bx(0.04, 1.0, 0.04, S.rail, s * (W / 2 + (top ? 1.25 : 0.7)), y + 0.5, az + z); }
    for (const h of [0.5, 1.0]) bx(W + (top ? 2.5 : 1.4), 0.04, 0.04, S.rail, 0, y + h, az + Ln / 2 + 0.65);
  }
  for (let k = 0; k < 4; k++) {
    const y = DECK_Y + k * dh + 1.55;
    for (let i = 0; i < 6; i++) { const x = -4.6 + i * 1.84; if (k === 0 && (i === 1 || i === 4)) { bx(0.85, 2.0, 0.07, S.red, x, DECK_Y + 1.0, az + Ln / 2 + 0.02); bx(0.3, 0.3, 0.09, S.win, x, DECK_Y + 1.5, az + Ln / 2 + 0.02); continue; } bx(1.05, 0.85, 0.06, i % 3 === 1 && k < 3 ? S.lampOn : S.win, x, y, az + Ln / 2 + 0.01); bx(1.17, 0.06, 0.1, S.grey, x, y - 0.46, az + Ln / 2 + 0.01); }
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) bx(0.06, 0.75, 0.95, (i + k) % 4 === 0 ? S.lampOn : S.win, s * (W / 2 + 0.01), y, az - 3 + i * 2.0);
    for (let i = 0; i < 5; i++) bx(0.95, 0.75, 0.06, S.win, -3.9 + i * 1.95, y, az - Ln / 2 - 0.01);
  }
  // outside stairs zig-zag up the port side, deck to deck
  for (let k = 0; k < 4; k++) { const dir = k % 2 ? -1 : 1; bx(0.75, 0.08, 4.3, S.grey, -(W / 2 + 0.38), DECK_Y + (k + 0.5) * dh, az, dir * Math.atan2(dh, 3.4), 0, 0); for (const h of [0.9]) bx(0.04, 0.04, 4.3, S.rail, -(W / 2 + 0.72), DECK_Y + (k + 0.5) * dh + h, az, dir * Math.atan2(dh, 3.4), 0, 0); }
  // wheelhouse with a wrap-around window band, bridge wings, monkey island
  const by = DECK_Y + 4 * dh;
  am(st, uvBox(9.6, 2.7, 5.2), S.white, 0, by + 1.41, az + 1.6);
  bx(9.3, 1.05, 0.07, S.win, 0, by + 1.75, az + 4.2, -0.12); for (let i = -4; i <= 4; i++) bx(0.07, 1.1, 0.09, S.white, i * 1.03, by + 1.75, az + 4.21, -0.12);
  for (const s of [-1, 1]) { bx(0.07, 1.0, 3.9, S.win, s * 4.81, by + 1.75, az + 2.0); bx(2.6, 1.15, 0.1, S.white, s * 6.1, by + 0.62, az + 4.15); bx(0.1, 1.15, 2.4, S.white, s * 7.38, by + 0.62, az + 3.0); bx(0.5, 1.3, 0.5, S.grey, s * 6.9, by + 0.7, az + 3.3); am(st, new THREE.SphereGeometry(0.2, 8, 6), s < 0 ? AIRM.navR : AIRM.navG, s * 7.45, by + 1.5, az + 3.6); }
  bx(10.2, 0.14, 5.8, S.dark, 0, by + 2.83, az + 1.6);
  for (const h of [0.5, 1.0]) { bx(10, 0.04, 0.04, S.rail, 0, by + 2.9 + h, az + 4.4); for (const s of [-1, 1]) bx(0.04, 0.04, 5.6, S.rail, s * 5, by + 2.9 + h, az + 1.6); }
  for (const [x, r] of [[-3.4, 0.75], [3.4, 0.55]]) { cy(r * 0.5, 0.9, S.white, x, by + 3.35, az + 0.4); am(st, new THREE.SphereGeometry(r, 16, 12), S.white, x, by + 3.9 + r * 0.6, az + 0.4); }
  for (const x of [-4.4, -2.2, 2.0, 4.5]) cy(0.025, 4.2, S.dark, x, by + 5.0, az + 3.6, 0, 0, 0, 5);
  bx(1.6, 0.25, 0.5, S.white, 0, by + 3.1, az + 4.1); for (const s of [-1, 1]) am(st, new THREE.SphereGeometry(0.16, 8, 6), S.lampOn, s * 0.5, by + 3.1, az + 4.38);
  const radar = mast(g, 0, by + 2.9, az + 2.0, 6.5);
  // funnel behind the wheelhouse: blue with the white cross, black top, exhaust pipes
  am(st, new THREE.CylinderGeometry(1.75, 2.15, 7.2, 4, 1), S.funnel, 0, by + 3.6, az - 3.0, 0, Math.PI / 4, 0);
  am(st, new THREE.CylinderGeometry(1.55, 1.55, 0.35, 4, 1), S.dark, 0, by + 7.3, az - 3.0, 0, Math.PI / 4, 0);
  for (const [x, z, h] of [[-0.45, -0.3, 1.4], [0.45, -0.3, 1.1], [0, 0.45, 0.8]]) cy(0.22, h, AIRM.exhaust, x, by + 7.4 + h / 2, az - 3.0 + z, 0, 0, 0, 10);
  // free-fall orange lifeboats in davits on both sides, life-raft canisters, a provisions crane
  for (const s of [-1, 1]) {
    const lb = am(st, new THREE.SphereGeometry(1, 18, 12), S.orange, s * 7.75, DECK_Y + 2 * dh + 1.35, az - 0.4); lb.scale.set(1.15, 1.05, 3.3);
    bx(1.5, 0.7, 3.2, S.orange, s * 7.75, DECK_Y + 2 * dh + 2.2, az - 0.2); bx(1.52, 0.3, 1.2, S.win, s * 7.75, DECK_Y + 2 * dh + 2.3, az + 1.3);
    for (const dz of [-2.4, 1.8]) { bx(0.22, 3.4, 0.22, S.white, s * 6.95, DECK_Y + 2 * dh + 1.8, az - 0.4 + dz, 0, 0, -s * 0.22); bx(1.7, 0.2, 0.2, S.white, s * 7.6, DECK_Y + 2 * dh + 3.45, az - 0.4 + dz); cy(0.02, 1.1, S.dark, s * 7.75, DECK_Y + 2 * dh + 2.9, az - 0.4 + dz, 0, 0, 0, 5); }
    for (let i = 0; i < 3; i++) cy(0.32, 1.15, S.white, s * (W / 2 + 0.25), DECK_Y + 3 * dh + 0.5, az - 3.2 + i * 0.85, Math.PI / 2, 0, 0, 12);
    cy(0.5, 0.7, S.orange, s * (W / 2 + 0.3), DECK_Y + dh + 0.45, az + 3.6, 0, 0, 0, 14); // lifebuoy locker
  }
  cy(0.3, 4.2, S.yellow, 4.4, DECK_Y + 2.1, -40.0); bx(0.3, 0.3, 5.2, S.yellow, 4.4, DECK_Y + 4.6, -42.2, 0.5); cy(0.015, 2.2, S.dark, 4.4, DECK_Y + 4.5, -44.4, 0, 0, 0, 5);
  am(st, new THREE.CylinderGeometry(0.06, 0.06, 5, 6), NAVY.dark, 0, F + 2.5, -L / 2 + 0.7);
  mergeInto(g, st);
  boatFlag(g, 0, F + 5.2, -L / 2 + 0.6, 2.8);
  const flag = g.children[g.children.length - 1], funnel = g.children.find(m => m.material === S.funnel), logoMeshes = g.children.filter(m => S.logos.includes(m.material)); logoMeshes.forEach(m => m.userData.li = S.logos.indexOf(m.material));
  // ---- gangway (down only while alongside): landing at the rail gate, a stepped aluminium ramp to the pier, handrails
  const gang = new THREE.Group(), gs = new THREE.Group(), GY = 1.9, rise = DECK_Y - GY, run = GANG.z2 - GANG.z1, ang = Math.atan2(rise, run), len = Math.hypot(rise, run), gx = (GANG.x0 + GANG.x1) / 2, gz = (GANG.z1 + GANG.z2) / 2, gy = (DECK_Y + GY) / 2;
  const gb = (w, h, d, mat, x, y, z, rx = 0) => am(gs, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx);
  gb(GANG.x1 - 7.05, 0.1, GANG.z1 - GANG.z0, S.alu, (GANG.x1 + 7.05) / 2, DECK_Y - 0.05, (GANG.z0 + GANG.z1) / 2);
  for (const sx of [GANG.x0 + 0.04, GANG.x1 - 0.04]) { gb(0.1, 0.34, len, S.alu, sx, gy - 0.1, gz, ang); for (const h of [0.55, 1.05]) gb(0.045, 0.045, len, S.rail, sx, gy + h, gz, ang); }
  const nSteps = 13;
  for (let i = 0; i < nSteps; i++) { const k = (i + 0.5) / nSteps, z = GANG.z1 + run * k, y = DECK_Y - rise * (i + 1) / nSteps; gb(GANG.x1 - GANG.x0 - 0.1, 0.05, run / nSteps + 0.02, S.alu, gx, y + 0.005, z); if (i % 3 === 1) for (const sx of [GANG.x0 + 0.04, GANG.x1 - 0.04]) gb(0.045, 1.05, 0.045, S.rail, sx, y + 0.53, z); }
  for (const h of [0.55, 1.05]) { gb(GANG.x1 - 7.1, 0.045, 0.045, S.rail, (GANG.x1 + 7.1) / 2, DECK_Y + h, GANG.z0 + 0.03); gb(0.045, 0.045, GANG.z1 - GANG.z0, S.rail, GANG.x1 - 0.04, DECK_Y + h, (GANG.z0 + GANG.z1) / 2); gb(GANG.x0 - 7.1, 0.045, 0.045, S.rail, (GANG.x0 + 7.1) / 2, DECK_Y + h, GANG.z1 - 0.03); }
  for (const [x, z] of [[GANG.x1 - 0.04, GANG.z0 + 0.03], [GANG.x1 - 0.04, GANG.z1], [GANG.x0, GANG.z1 - 0.03]]) gb(0.05, 1.05, 0.05, S.rail, x, DECK_Y + 0.53, z);
  gb(0.12, 0.12, 2.6, S.alu, 8.0, DECK_Y - 1.0, (GANG.z0 + GANG.z1) / 2); gb(0.1, 2.0, 0.1, S.alu, 8.9, DECK_Y - 1.05, (GANG.z0 + GANG.z1) / 2, 0).rotation.z = -0.9;
  for (const sx of [GANG.x0 + 0.1, GANG.x1 - 0.1]) am(gs, new THREE.CylinderGeometry(0.13, 0.13, 0.12, 10), AIRM.rubber, sx, GY + 0.13, GANG.z2 - 0.15, 0, 0, Math.PI / 2);
  // mooring lines to the pier bollards (bow, spring, stern), also only while alongside
  const line = (x0, y0, z0, x1, y1, z1) => { const a = new V3(x0, y0, z0), b2 = new V3(x1, y1, z1), d = b2.clone().sub(a), Lg = d.length(); const m = am(gs, new THREE.CylinderGeometry(0.035, 0.035, Lg, 6), S.rope, 0, 0, 0); m.position.copy(a).add(b2).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize()); };
  const wl = (wx, wy, wz) => [wx - SHIP.x, wy - SEA_Y, wz - SHIP.zb]; // world point (berthed) to ship-local
  line(4.2, F + 1.5, 42.2, ...wl(46.7, 0.5, -29)); line(7.0, DECK_Y + 0.2, 20, ...wl(46.7, 0.5, -41)); line(7.0, DECK_Y + 0.2, 6, ...wl(46.7, 0.5, -61)); line(7.0, DECK_Y + 0.2, 24, ...wl(46.7, 0.5, -47));
  mergeInto(gang, gs); g.add(gang);
  g.traverse(o => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
  return { g, radar, gang, hull, flag, funnel, logos: logoMeshes };
}
// Solid parts of the ship in ship-local coordinates: [x0, y0, z0, x1, y1, z1, bullets pass (rails), gangway only]
function shipSolids() {
  const out = [], R = DECK_Y + 1.1, GY = 1.9, add = (...a) => out.push(a);
  add(-7.5, -7, -45, 7.5, DECK_Y, 38.2); add(-4.8, -7, 38.2, 4.8, DECK_Y, 44.2);
  add(-4.65, DECK_Y, 36.4, 4.65, SHIP.F + 1.55, 43);                                  // forecastle
  for (const z of SHIP_BAYS) add(-6.45, DECK_Y, z - 3.1, 6.45, HATCH_Y, z + 3.1);      // hatch covers (a low step up)
  for (const s of port.stacks) add(s.x - 1.22, HATCH_Y, s.z - 3.03, s.x + 1.22, HATCH_Y + s.n * 2.59, s.z + 3.03);
  add(-6.15, DECK_Y, -38.7, 6.15, DECK_Y + 13.3, -29.7);                               // accommodation
  add(-7.3, DECK_Y, -41, -7.12, R, 36.4, 1); add(7.12, DECK_Y, -41, 7.3, R, GANG.z0, 1); add(7.12, DECK_Y, GANG.z1, 7.3, R, 36.4, 1);
  add(-7.3, DECK_Y, -41.15, 7.3, R, -41, 1); add(4.65, DECK_Y, 36.3, 7.3, R, 36.45, 1); add(-7.3, DECK_Y, 36.3, -4.65, R, 36.45, 1);
  add(7.12, DECK_Y, GANG.z0, 7.3, R, GANG.z1, 1, -1);                                  // the rail gate shuts when the gangway is up
  add(7.1, DECK_Y - 0.3, GANG.z0, GANG.x1, DECK_Y, GANG.z1, 0, 1);                     // landing
  const n = 13, rise = DECK_Y - GY, run = GANG.z2 - GANG.z1;
  for (let i = 0; i < n - 1; i++) add(GANG.x0, GY - 0.4, GANG.z1 + run * i / n, GANG.x1, DECK_Y - rise * (i + 1) / n, GANG.z1 + run * (i + 1) / n, 0, 1);
  add(7.1, DECK_Y, GANG.z0 - 0.1, GANG.x1 + 0.1, R, GANG.z0, 1, 1); add(GANG.x1, GY, GANG.z0, GANG.x1 + 0.1, R, GANG.z2 - 0.9, 1, 1);
  add(7.3, DECK_Y, GANG.z1, GANG.x0, R, GANG.z1 + 0.1, 1, 1); add(GANG.x0 - 0.1, GY, GANG.z1, GANG.x0, R, GANG.z2 - 0.9, 1, 1);
  return out;
}
const shipLocal = (x, z, o) => { o.x = x - SHIP.x - port.ox; o.z = z - SHIP.zb - port.oz; return o; };
const _sl = { x: 0, z: 0 };
// on the ship (deck, hatch covers, container tops or the gangway landing) while it is alongside or backing out
function aboard(p) { if (!port.active || p.y < SEA_Y + DECK_Y - 0.7) return false; shipLocal(p.x, p.z, _sl); return _sl.x > -7.6 && _sl.x < 10 && _sl.z > -45.5 && _sl.z < 44.5 && (_sl.x < 7.6 || p.y > SEA_Y + DECK_Y - 0.4); }
function ropeFloor(x, z) {
  if (port.active) { shipLocal(x, z, _sl); if (Math.abs(_sl.x) < 7.4 && _sl.z > -45 && _sl.z < 43) return SEA_Y + (Math.abs(_sl.x) < 6.45 && _sl.z > -27.6 && _sl.z < 30.6 ? HATCH_Y : DECK_Y); }
  return 0;
}
function anyAboard() { if (P.alive && aboard(P.pos)) return true; for (const r of remotes.values()) if (r.alive && aboard(r.pos)) return true; return false; }
// ---- extraction: when the ship sails with people on it, a Navy helicopter follows it out, hovers over the winching pad,
// takes everyone off on the rope and sets them down in the compound. Timed off the ship's clock so every player sees the same flight.
const EX0 = 262, EX_HOVER = 16, EX_GO = 54, EX_FORCE = 312, EX_DROP = [8, -10];
const _ex = new V3();
const padAt = ts => { shipAt(ts, _ex); return new V3(_ex.x, SEA_Y + HATCH_Y + HOVER_Y, _ex.z + PAD_Z); };
function extractPath(u) {
  u = Math.max(0, u);
  const E = new V3(190, 70, -60);
  if (u < EX_HOVER) { const A = padAt(EX0 + u), k = 1 - Math.pow(1 - u / EX_HOVER, 2); return { p: bez(E, new V3(120, 45, A.z + 20), new V3(A.x + 28, A.y + 7, A.z + 4), A, k), ph: 'in' }; }
  if (u < EX_GO) { const A = padAt(EX0 + u), t = u - EX_HOVER; return { p: A.add(new V3(Math.sin(t * 0.7) * 0.25, Math.sin(t * 0.9) * 0.15, Math.cos(t * 0.6) * 0.25)), ph: 'hoverA' }; }
  const A1 = padAt(EX0 + EX_GO), B = new V3(EX_DROP[0], HOVER_Y, EX_DROP[1]), tT = Math.hypot(B.x - A1.x, B.z - A1.z) / 12 + 3;
  let t = u - EX_GO;
  if (t < tT) { const k = smoothK(t / tT), p = A1.lerp(B, k); p.y += 11 * Math.sin(Math.PI * k); return { p, ph: 'transit' }; }
  t -= tT;
  if (t < 9) return { p: B.add(new V3(Math.sin(t * 0.8) * 0.2, -0.15 + Math.sin(t) * 0.12, Math.cos(t * 0.7) * 0.2)), ph: 'hoverB' };
  t -= 9;
  if (t < 26) { const k = Math.pow(t / 26, 1.6); return { p: bez(B, new V3(B.x, HOVER_Y + 10, B.z + 25), new V3(B.x - 110, 50, B.z + 170), new V3(B.x - 220, 75, 280), k), ph: 'out' }; }
  return null;
}
function updateExtraction(t) {
  const mine = P.alive && !P.rope && aboard(P.pos);
  if (mine && port.warned !== 1 && t >= 110 && t < 236) { port.warned = 1; showPrompt(`Aboard the ${port.v ? port.v.name : 'ship'} · she sails in ${Math.round(260 - t)} s`); }
  if (mine && port.warned !== 2 && t >= 236 && t < 258) { port.warned = 2; showBanner('The ship is about to sail', 'Get ashore now, or stay aboard and a helicopter will lift you off', 5000); }
  if (t < 100) port.warned = -1;
  if (!exHeli.active && t >= 256 && t < EX_FORCE + 6 && anyAboard()) {
    exHeli.clock = () => ((Date.now() / 1000 + port.offset) % SHIP_CYCLE + SHIP_CYCLE) % SHIP_CYCLE - EX0;
    launchRopeHeli(exHeli, extractPath, exHeli.clock(), -Math.PI / 2);
    if (mine) showBanner('Extraction helicopter inbound', 'Meet it on the winching pad (H) and grab the rope · E', 6000);
  }
  if (exHeli.active && mine && t >= EX_FORCE && t < 330 && (exHeli.phase === 'hoverA' || exHeli.phase === 'in')) grabRope(exHeli, true);
  if (mine && t >= 328.5 && t < 330) { P.pos.set(52, 0.1, -30); P.vel.set(0, 0, 0); showPrompt('A harbour launch brings you back to the pier'); } // last resort, should not happen
}
// ---- sixty seconds aboard, then the Navy lifts you off: the ship is the best perch on the map and nobody should hold it all match
const EV_IN = 12, EV_HOLD = 16, evHelis = new Map();
function evictPath(u) {
  u = Math.max(0, u); const A = padAt(200), E = new V3(190, 70, -60);
  if (u < EV_IN) { const k = 1 - Math.pow(1 - u / EV_IN, 2); return { p: bez(E, new V3(120, 45, A.z + 20), new V3(A.x + 28, A.y + 7, A.z + 4), A, k), ph: 'in' }; }
  let t = u - EV_IN;
  if (t < EV_HOLD) return { p: A.add(new V3(Math.sin(t * 0.7) * 0.25, Math.sin(t * 0.9) * 0.15, Math.cos(t * 0.6) * 0.25)), ph: 'hoverA' };
  t -= EV_HOLD; const B = new V3(EX_DROP[0], HOVER_Y, EX_DROP[1]), tT = Math.hypot(B.x - A.x, B.z - A.z) / 12 + 3;
  if (t < tT) { const k = smoothK(t / tT), p = A.lerp(B, k); p.y += 11 * Math.sin(Math.PI * k); return { p, ph: 'transit' }; }
  t -= tT; if (t < 9) return { p: B.add(new V3(Math.sin(t * 0.8) * 0.2, -0.15 + Math.sin(t) * 0.12, Math.cos(t * 0.7) * 0.2)), ph: 'hoverB' };
  t -= 9; if (t < 26) { const k = Math.pow(t / 26, 1.6); return { p: bez(B, new V3(B.x, HOVER_Y + 10, B.z + 25), new V3(B.x - 110, 50, B.z + 170), new V3(B.x - 220, 75, 280), k), ph: 'out' }; }
  return null;
}
function startEviction(id) { // each player being lifted off gets a helicopter of their own, and everyone sees it
  let H = evHelis.get(id); if (!H) { H = newRopeHeli('evict'); evHelis.set(id, H); ROPE_HELIS.push(H); }
  if (H.active || !port.ship) return H;
  const t0 = Date.now() / 1000; H.clock = () => Date.now() / 1000 - t0;
  launchRopeHeli(H, evictPath, 0, -Math.PI / 2); return H;
}
function updateShipLimit(dt, t) {
  const on = P.alive && gameState === 'play' && port.active && t < 256 && aboard(P.pos);
  if (P.rope && P.rope.h.kind === 'evict') { P.aboardT = 0; P.shipWarn = 0; return; }
  if (on && !P.rope) P.aboardT += dt; else if (!on) P.aboardT = Math.max(0, P.aboardT - dt * 0.5);
  const T = P.aboardT, H = evHelis.get(myId), flying = !!(H && H.active);
  if (T < 20) P.shipWarn = 0;
  if (on && T >= 30 && !P.shipWarn) { P.shipWarn = 1; showPrompt('30 seconds left aboard · then the Navy lifts you off'); }
  if (on && !P.rope && T >= 60 - EV_IN && !flying && t < 256 - EV_IN - EV_HOLD) {
    P.shipWarn = 2; startEviction(myId); netSend({ t: 'evict' }); SFX.alarm();
    showBanner('Your time aboard is up', 'A Navy helicopter is coming to take you off the ship', 4500);
  }
  if (flying && on && !P.rope && H.phase === 'hoverA' && T >= 60) grabRope(H, true);
}
function applyShipOrigin(n) { // repaint the ship while it is away: hull, funnel, stern flag and the company names on its containers
  const v = shipVariant(n), sh = port.ship, S = shipMats(), sk = shipSkin(v); port.cycleN = n; port.v = v;
  sh.hull.material.map = sk.map; sh.hull.material.bumpMap = sk.bump;
  sh.flag.material = v.us ? S.flagUS : M.flag; sh.funnel.material = v.us ? S.funnelUS : S.funnel;
  sh.logos.forEach((m, i) => { m.material = v.us && i < 5 ? S.logosUS[i % S.logosUS.length] : S.logos[m.userData.li]; });
}
let BLUE_M = null; function BLUE_MAT() { return BLUE_M || (BLUE_M = std({ color: 0x1f5fa8, roughness: 0.5, metalness: 0.2 })); }
function makeCrane() {
  const D = dockMats(), g = new THREE.Group(), dyn = [];
  const bx = (w, h, d, mat, x, y, z, rot) => { const m = am(g, new THREE.BoxGeometry(w, h, d), mat, x, y, z); if (rot) m.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0); return m; };
  // portal: 4 legs on the rails, sill beams, two portal beams, bogies with wheels
  for (const lx of [-6, 6]) for (const lz of [-6.5, 6.5]) { bx(1.1, 26, 1.1, D.crane, lx, 13, lz); bx(1.4, 1.0, 3.2, D.craneWhite, lx, 0.9, lz); for (const wz of [-1.1, 0, 1.1]) am(g, new THREE.CylinderGeometry(0.38, 0.38, 0.3, 14).rotateZ(Math.PI / 2), M.steel, lx, 0.38, lz + wz); }
  for (const lx of [-6, 6]) { bx(1.0, 1.4, 13, D.crane, lx, 13, 0); bx(0.8, 0.8, 12, D.crane, lx, 7, 0); const L = Math.hypot(13, 12); for (const s of [-1, 1]) bx(0.35, L, 0.35, D.crane, lx, 13 + 6, 0, [Math.atan2(13, 12) * s, 0, 0]); }
  for (const lz of [-6.5, 6.5]) { bx(13, 1.6, 1.2, D.crane, 0, 25.6, lz); bx(13, 1.2, 1.0, D.crane, 0, 13, lz); }
  // boom: two box girders from land side (+x) out over the ship (-x), ties, walkway, apex and stays
  for (const s of [-1, 1]) { bx(46, 1.7, 0.8, D.craneWhite, -8, 27.4, s * 1.6); bx(46, 0.15, 0.6, M.steel, -8, 26.5, s * 1.0); }
  for (let x = -30; x <= 14; x += 4) bx(0.4, 0.4, 3.6, D.craneWhite, x, 28.2, 0);
  for (const s of [-1, 1]) { bx(0.9, 13, 0.9, D.crane, 0, 34.5, s * 1.6, [0, 0, 0]); }
  bx(1.2, 1.2, 4.2, D.crane, 0, 41, 0);
  const stay = (x0, y0, x1, y1) => { const L = Math.hypot(x1 - x0, y1 - y0); for (const s of [-1, 1]) { const m = am(g, new THREE.CylinderGeometry(0.09, 0.09, L, 6), M.steel, (x0 + x1) / 2, (y0 + y1) / 2, s * 1.6); m.rotation.z = Math.atan2(x0 - x1, y1 - y0); } };
  stay(0, 41, -30, 28.2); stay(0, 41, -18, 28.2); stay(0, 41, 14, 28.2);
  for (const [x, c] of [[-30.6, D.yellow], [-29.6, D.black]]) bx(1.0, 1.75, 4.0, c, x, 27.4, 0);
  // machinery house on the back of the boom, with Greek flag-blue stripe
  bx(6, 3.2, 4.8, D.craneWhite, 10, 29.9, 0); bx(6.1, 0.5, 4.85, BLUE_MAT(), 10, 30.9, 0);
  // trolley + cab, hoist ropes, spreader (moving parts)
  const trolley = new THREE.Group(); g.add(trolley);
  am(trolley, new THREE.BoxGeometry(3.2, 1.2, 3.6), D.crane, 0, 26.0, 0);
  am(trolley, new THREE.BoxGeometry(2.2, 2.0, 2.0), D.craneWhite, 0.8, 24.4, 1.6);
  am(trolley, new THREE.BoxGeometry(2.0, 1.2, 0.06), NAVY.window, 0.8, 24.6, 2.62); am(trolley, new THREE.BoxGeometry(1.4, 0.06, 1.8), NAVY.window, 0.8, 23.38, 1.6);
  const spreader = new THREE.Group(); g.add(spreader);
  am(spreader, new THREE.BoxGeometry(2.44, 0.35, 6.06), D.yellow, 0, 0.18, 0);
  am(spreader, new THREE.BoxGeometry(1.6, 0.6, 2.2), D.yellow, 0, 0.65, 0);
  for (const sx of [-1.1, 1.1]) for (const sz of [-2.9, 2.9]) am(spreader, new THREE.BoxGeometry(0.2, 0.3, 0.2), D.black, sx, 0.0, sz);
  const ropes = []; for (const s of [[-0.6, -0.9], [0.6, -0.9], [-0.6, 0.9], [0.6, 0.9]]) { const r = am(g, new THREE.CylinderGeometry(0.035, 0.035, 1, 5), M.steel, 0, 0, 0); r.userData.o = s; ropes.push(r); }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, trolley, spreader, ropes };
}
const CRANE_X = 54, CRANE_PARK_Z = -42;
const ease = t => t * t * (3 - 2 * t);
function seg(t, a, b) { return clamp((t - a) / (b - a), 0, 1); }
// crane pose at schedule time t: gantry z, trolley world x, spreader bottom y, carried box index
function moveU(i, t) { const t0 = MOVE_T[i]; if (i) return t - t0; if (t < t0 + 14) return t - t0; if (t < 110) return 14; return 14 + (t - 110); }
function craneAt(t) {
  let z = CRANE_PARK_Z, tx = CRANE_X + 3, hy = 15, carry = -1;
  if (t >= 470) return { z, tx, hy, carry };
  for (let i = 0; i < LOAD.length; i++) {
    const u = moveU(i, t); if (u < 0) break;
    const s = LOAD[i], pickTop = (s.lvl + 1) * 2.59, dropTop = SEA_Y + SHIP.F + 0.48 + (s.tier + 1) * 2.59, dropX = SHIP.x + s.row;
    const hang = i === 0 ? 9 : 22; // the first box only goes up to 9 m and hangs there until the ship is alongside
    const prevZ = i ? LOAD[i - 1].pz : CRANE_PARK_Z, e = (a, b) => ease(seg(u, a, b));
    z = prevZ + (s.pz - prevZ) * e(0, 4); tx = CRANE_X + 3; hy = 15; carry = -1;
    if (u < 4) tx = lerp(CRANE_X + 3, PIER_C, e(0, 4));
    else if (u < 8) { tx = PIER_C; hy = lerp(15, pickTop, e(4, 8)); }
    else if (u < 9) { tx = PIER_C; hy = pickTop; }
    else if (u < 14) { tx = PIER_C; hy = lerp(pickTop, hang, e(9, 14)); carry = i; }
    else if (u < 21) { tx = lerp(PIER_C, dropX, e(14, 21)); hy = lerp(hang, 22, e(14, 17)); carry = i; }
    else if (u < 26) { tx = dropX; hy = lerp(22, dropTop, e(21, 26)); carry = i; }
    else if (u < 27) { tx = dropX; hy = dropTop; carry = i; }
    else if (u < 30) { tx = dropX; hy = lerp(dropTop, 20, e(27, 30)); }
    else if (u < 34) { tx = lerp(dropX, CRANE_X + 3, e(30, 34)); hy = lerp(20, 15, e(30, 34)); }
    if (i === LOAD.length - 1 && u > 34) z = s.pz + (CRANE_PARK_Z - s.pz) * e(34, 44);
  }
  return { z, tx, hy, carry };
}
// box state: 'pier' | 'crane' | 'ship'
function boxState(i, t) {
  if (t >= 470) return 'pier';
  const t0 = MOVE_T[i], latch = t0 + 9, rel = i === 0 ? 110 + 13 : t0 + 27;
  if (t < latch) return 'pier'; if (t < rel) return 'crane'; return 'ship';
}
// ship pose at schedule time t
function shipAt(t, out) {
  const { x, zb } = SHIP;
  if (t < 110) { const k = t / 110, e = 1 - Math.pow(1 - k, 2.2); out.set(x + 60 * (1 - e), 0, -640 + (zb + 640) * e); return { yaw: Math.atan2(-60 * (1 - k) * 0.02, 1), vis: true, speed: (1 - k) * 10 }; }
  if (t < 260) { out.set(x, 0, zb); return { yaw: 0, vis: true, speed: 0 }; }
  if (t < 330) { const e = ease(seg(t, 260, 330)); out.set(x, 0, zb + (-175 - zb) * e); return { yaw: 0, vis: true, speed: 1.5 }; }
  if (t < 390) { const e = ease(seg(t, 330, 390)); out.set(x + 10 * e, 0, -175); return { yaw: Math.PI * e, vis: true, speed: 0.5 }; }
  if (t < 470) { const k = seg(t, 390, 470); out.set(x + 10, 0, -175 - 640 * k * k); return { yaw: Math.PI, vis: true, speed: 16 * k }; }
  return { yaw: Math.PI, vis: false, speed: 0 };
}
function buildPort() {
  port.ship = makeShip(); scene.add(port.ship.g);
  { const S = shipMats(); for (const v of SHIP_US) { const sk = shipSkin(v); for (const t of [sk.map, sk.bump, S.flagUS.map, S.funnelUS.map, ...S.logosUS.map(m => m.map)]) renderer.initTexture(t); } }
  port.crane = makeCrane(); port.crane.g.position.set(CRANE_X, 0, CRANE_PARK_Z); scene.add(port.crane.g);
  for (let i = 0; i < LOAD.length; i++) {
    const m = containerBox([3, 1, 6, 0][i]); scene.add(m);
    const s = LOAD[i]; addCollider(PIER_C - 1.22, s.lvl * 2.59, s.pzz - 3.03, PIER_C + 1.22, (s.lvl + 1) * 2.59, s.pzz + 3.03);
    port.boxes.push({ m, col: colliders[colliders.length - 1] });
  }
  for (let k = 0; k < 4; k++) { addCollider(0, 0, 0, 0, 0, 0); port.legs.push(colliders[colliders.length - 1]); }
  for (const d of shipSolids()) { addCollider(0, 0, 0, 0, 0, 0, !!d[6]); const c = colliders[colliders.length - 1]; c.ship = true; c.off = true; port.cols.push({ c, d }); }
  updatePort(0);
}
const _sp = new V3();
function updatePort(dt) {
  if (!port.ship) return;
  const t = ((Date.now() / 1000 + port.offset) % SHIP_CYCLE + SHIP_CYCLE) % SHIP_CYCLE, cyc = Math.floor((Date.now() / 1000 + port.offset) / SHIP_CYCLE);
  if (cyc !== port.cycleN) applyShipOrigin(cyc);
  if (t > 72 && t < 110 && port.said !== cyc) { // called out as she comes in
    port.said = cyc; const v = port.v;
    if (deployed && gameState === 'play') { if (v.us) showBanner('International cargo arriving', `The ${v.name} from ${v.from} is coming into the harbour`, 5200); feed(`<span>Harbour control ·</span> <b>${v.name}</b> <span>arriving from ${v.from}</span>`); }
  }
  // ship
  const sh = shipAt(t, _sp), g = port.ship.g;
  g.visible = sh.vis;
  g.position.set(_sp.x, SEA_Y + Math.sin(elapsed * 0.5) * 0.05, _sp.z); g.rotation.set(Math.sin(elapsed * 0.4) * 0.003, sh.yaw, Math.sin(elapsed * 0.33) * 0.004);
  port.ship.radar.rotation.y += dt * 1.4;
  { // the ship is solid while it lies alongside and while it backs straight out; whoever stands on it is carried along
    const active = t >= 110 && t < 330, gangOn = active && t < 258, ox = active ? _sp.x - SHIP.x : 0, oz = active ? _sp.z - SHIP.zb : 0;
    for (const { c, d } of port.cols) {
      c.off = !active || (d[7] === 1 && !gangOn) || (d[7] === -1 && gangOn); if (c.off) continue;
      c.min[0] = SHIP.x + ox + d[0]; c.min[1] = SEA_Y + d[1]; c.min[2] = SHIP.zb + oz + d[2]; c.max[0] = SHIP.x + ox + d[3]; c.max[1] = SEA_Y + d[4]; c.max[2] = SHIP.zb + oz + d[5];
    }
    if (active && port.active && P.alive && !P.rope && aboard(P.pos)) { P.pos.x += ox - port.ox; P.pos.z += oz - port.oz; }
    port.active = active; port.ox = ox; port.oz = oz; port.t = t;
    port.ship.gang.visible = t >= 106 && t < 258;
    updateExtraction(t); updateShipLimit(dt, t);
  }
  // crane
  const c = craneAt(t), cr = port.crane;
  cr.g.position.z = c.z;
  cr.trolley.position.x = c.tx - CRANE_X;
  cr.spreader.position.set(c.tx - CRANE_X, c.hy, 0);
  for (const r of cr.ropes) { const top = 25.4, bot = c.hy + 0.9, L = Math.max(0.2, top - bot); r.position.set(c.tx - CRANE_X + r.userData.o[0], (top + bot) / 2, r.userData.o[1]); r.scale.set(1, L, 1); }
  for (const [k, lx, lz] of [[0, -6, -6.5], [1, -6, 6.5], [2, 6, -6.5], [3, 6, 6.5]]) { const L = port.legs[k], x = CRANE_X + lx, z = c.z + lz; L.min[0] = x - 0.7; L.max[0] = x + 0.7; L.min[2] = z - 1.7; L.max[2] = z + 1.7; L.min[1] = 0; L.max[1] = 26; }
  // containers
  for (let i = 0; i < port.boxes.length; i++) {
    const b = port.boxes[i], s = LOAD[i], st = boxState(i, t);
    b.col.off = st !== 'pier';
    if (st === 'pier') { if (b.m.parent !== scene) scene.add(b.m); b.m.position.set(PIER_C, s.lvl * 2.59 + 1.295, s.pzz); b.m.rotation.set(0, 0, 0); }
    else if (st === 'crane') { if (b.m.parent !== scene) scene.add(b.m); b.m.position.set(c.tx, c.hy - 1.295, c.z); b.m.rotation.set(0, Math.sin(elapsed * 0.9 + i) * 0.01, 0); }
    else { if (b.m.parent !== port.ship.g) port.ship.g.add(b.m); b.m.position.set(s.row, SHIP.F + 0.48 + 1.295 + s.tier * 2.59, s.bay); b.m.rotation.set(0, 0, 0); }
  }
  // sounds: horn on arrival and departure, clank on latch and release
  if (AC) {
    const horn = (t > 96 && t < 97.5) || (t > 262 && t < 263.5) || (t > 391 && t < 392.5);
    if (horn && port.hornAt < 0) { port.hornAt = 1; shipHorn(g.position); } else if (!horn) port.hornAt = -1;
    for (let i = 0; i < LOAD.length; i++) for (const ev of [i === 0 ? MOVE_T[0] + 9 : MOVE_T[i] + 9, i === 0 ? 123 : MOVE_T[i] + 27]) if (port.lastT !== undefined && port.lastT < ev && t >= ev) clank(new V3(c.tx, c.hy, c.z));
  }
  port.lastT = t;
}
function shipHorn(pos) {
  const s = spatial(pos), o = out(s.pan, Math.min(1.2, 0.35 + s.gain * 4));
  for (const f of [92, 138]) { const osc = AC.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = f; const fl = AC.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 600; const e = AC.createGain(); const t = AC.currentTime + Math.min(1, s.dist / 343); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.22, t + 0.25); e.gain.setValueAtTime(0.22, t + 2.6); e.gain.exponentialRampToValueAtTime(0.001, t + 3.6); osc.connect(fl); fl.connect(e); e.connect(o); osc.start(t); osc.stop(t + 3.7); }
}
function clank(pos) { const s = spatial(pos); const o = out(s.pan, s.gain * 3); noiseHit(o, { dur: 0.25, type: 'bandpass', f: 900, q: 2, g: 0.9 }); tone(o, { f0: 220, f1: 160, dur: 0.3, g: 0.4, type: 'triangle' }); noiseHit(o, { t0: 0.12, dur: 0.15, type: 'bandpass', f: 1500, q: 3, g: 0.4 }); }

// ---------------------------------------------------------------- swimming + ladders
function startSwim(vy) {
  P.swim = true; P.pos.y = SWIM_Y; P.vel.y = 0; P.minVy = 0; P.onGround = false; P.ads = 0; P.adsHeld = false; P.crouching = false;
  viewmodels.forEach(v => v.root.visible = false);
  splash(P.pos.x, P.pos.z, Math.min(2, Math.abs(vy) / 6 + 0.5));
  if (AC) { const o = out(0, 0.9); noiseHit(o, { dur: 0.6, type: 'lowpass', f: 1400, g: 1 }); noiseHit(o, { t0: 0.05, dur: 1.0, type: 'bandpass', f: 500, q: 0.7, g: 0.6 }); }
  showPrompt('You fell in! Swim to a yellow ladder to climb out');
}
function splash(x, z, k = 1) {
  const p = new V3(x, SEA_Y + 0.05, z);
  for (let i = 0; i < 22 * k; i++) debris.spawn(p, new V3(R(-1.2, 1.2), R(2.5, 6) * k, R(-1.2, 1.2)), R(0.4, 0.8), R(0.03, 0.07), new THREE.Color(0xdcecf2), 12);
}
let strokeT = 0, ladderHintT = 0;
function updateSwim(dt) {
  let fx = 0, fz = 0;
  if (keys.KeyW) fz -= 1; if (keys.KeyS) fz += 1; if (keys.KeyA) fx -= 1; if (keys.KeyD) fx += 1;
  const len = Math.hypot(fx, fz); if (len) { fx /= len; fz /= len; }
  const speed = keys.ShiftLeft ? 3.2 : 2.2, sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  P.vel.x = lerp(P.vel.x, (fx * cy + fz * sy) * speed, Math.min(1, dt * 2.5)); P.vel.z = lerp(P.vel.z, (-fx * sy + fz * cy) * speed, Math.min(1, dt * 2.5));
  P.pos.x += P.vel.x * dt; P.pos.z += P.vel.z * dt;
  collideCircle(P.pos, 0.4, P.pos.y, P.pos.y + 1.8);
  if (!aboard(P.pos)) { P.pos.x = clamp(P.pos.x, MAP.x0 + 0.4, MAP.x1 - 0.4); P.pos.z = clamp(P.pos.z, MAP.z0 + 0.2, MAP.z1 - 0.4); }
  P.pos.y = SWIM_Y + Math.sin(elapsed * 1.7) * 0.06; P.vel.y = 0; P.onGround = false; P.crouch = lerp(P.crouch, 0, dt * 6);
  const hs = Math.hypot(P.vel.x, P.vel.z);
  P.bobAmt = lerp(P.bobAmt, 0, dt * 6); P.sprint = 0; P.ads = 0; P.fireCD -= dt; P.recP.step(dt); P.recY.step(dt); P.kick = Math.max(0, P.kick - dt * 6);
  strokeT -= dt * (0.6 + hs * 0.5);
  if (hs > 0.6 && strokeT <= 0) { strokeT = 1; if (AC) { const o = out(R(-0.2, 0.2), 0.35); noiseHit(o, { dur: R(0.3, 0.45), type: 'lowpass', f: R(700, 1100), g: 0.8 }); } const p = P.pos.clone().addScaledVector(new V3(-sy, 0, -cy), 0.6); for (let i = 0; i < 6; i++) debris.spawn(new V3(p.x, SEA_Y + 0.05, p.z), new V3(R(-0.6, 0.6), R(0.8, 1.8), R(-0.6, 0.6)), R(0.3, 0.5), R(0.02, 0.04), new THREE.Color(0xe6f0f4), 9.8); }
  // ladders
  let near = null;
  for (const L of LADDERS) { const lx = L.x - L.nx * 0.5, lz = L.z - L.nz * 0.5; if (Math.hypot(P.pos.x - lx, P.pos.z - lz) < 1.3) near = L; }
  if (near) {
    const fwd = new V3(-sy, 0, -cy), into = fwd.x * near.nx + fwd.z * near.nz;
    if (keys.KeyE || (keys.KeyW && into > 0.4)) { P.swim = false; P.ladder = { L: near, t: 0, x0: P.pos.x, z0: P.pos.z }; keys.KeyE = false; SFX.mech('pouch'); }
    else if (ladderHintT <= 0) { showPrompt('Ladder: swim into it or press E to climb out'); ladderHintT = 2; }
  }
  ladderHintT -= dt;
}
function updateLadder(dt) {
  const A = P.ladder, L = A.L; A.t += dt;
  const fx = L.x - L.nx * 0.45, fz = L.z - L.nz * 0.45, k = clamp(A.t / 1.7, 0, 1);
  if (k < 0.85) { const u = k / 0.85; P.pos.x = lerp(A.x0, fx, Math.min(1, u * 3)); P.pos.z = lerp(A.z0, fz, Math.min(1, u * 3)); P.pos.y = lerp(SWIM_Y, 0.05, ease(u)); if (Math.floor(A.t * 3) !== Math.floor((A.t - dt) * 3)) SFX.step(null, 0.6); }
  else { const u = (k - 0.85) / 0.15; P.pos.x = fx + L.nx * 1.2 * u; P.pos.z = fz + L.nz * 1.2 * u; P.pos.y = 0.05; }
  P.vel.set(0, 0, 0);
  if (A.t >= 1.7) { P.ladder = null; P.pos.y = 0; P.onGround = true; P.minVy = 0; viewmodels.forEach((v, k2) => v.root.visible = k2 === P.weapon); setWeapon(P.weapon, true); }
}

// ======================================================= POST
let composer, bloom, grade, renderPass, wPass;
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, dmg: { value: 0 }, aspect: { value: 1 }, ir: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time,dmg,aspect,ir; varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
  void main(){ vec2 uv=vUv; vec2 q=uv-.5; q.x*=aspect; float r=length(q);
    vec3 c; float ca = 0.0012 + dmg*0.004; c.r = texture2D(tDiffuse, uv + q*ca).r; c.g = texture2D(tDiffuse, uv).g; c.b = texture2D(tDiffuse, uv - q*ca).b;
    c = mix(c, c*vec3(1.04,1.0,0.95), 0.6);
    if (ir > 0.0) { // infrared: the world goes cold blue, warm bodies (drawn magenta, through walls) glow orange-white
      vec3 s0 = texture2D(tDiffuse, uv).rgb; float lum = dot(s0, vec3(0.3,0.59,0.11));
      float hot = smoothstep(0.16, 0.42, min(s0.r, s0.b) - s0.g);
      vec3 cold = mix(vec3(0.015,0.045,0.11), vec3(0.42,0.62,0.8), smoothstep(0.0, 0.9, lum));
      vec3 warm = mix(vec3(1.0,0.42,0.04), vec3(1.0,0.97,0.82), smoothstep(0.35, 0.9, s0.r));
      vec3 v = mix(cold, warm, hot); v *= 0.9 + 0.1*sin(gl_FragCoord.y*1.6); v += (hash(uv*vec2(911.,577.)+fract(time*3.1))-.5)*0.05;
      c = mix(c, v, ir);
    }
    c *= 1.0 - smoothstep(0.45, 1.15, r)*(0.6 + 0.25*ir);
    c += (hash(uv*vec2(1733.,977.)+fract(time*7.3))-.5)*0.011;
    float e = dmg*smoothstep(0.15,0.85,r); c = mix(c, vec3(0.45,0.02,0.02)+c*0.3, e*0.8);
    gl_FragColor = vec4(c,1.); }`
};
let dynScale = 1, curPR = 1;
function targetPR() {
  const Q = QUALITY[settings.quality];
  const base = Math.min(devicePixelRatio || 1, Q.maxPR, Math.sqrt(Q.budget / Math.max(1, innerWidth * innerHeight)));
  return Math.max(0.5, base * (Q.adaptive ? dynScale : 1));
}
function applyPR() { // cheap resolution change: no new composer or shaders
  const pr = targetPR(); if (Math.abs(pr - curPR) < 0.01) return; curPR = pr;
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
}
function setupPost() {
  const Q = QUALITY[settings.quality];
  if (!Q.adaptive) dynScale = 1;
  const pr = curPR = targetPR();
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false);
  if (water && water.renderTarget && water.renderTarget.width !== Q.refl) water.renderTarget.setSize(Q.refl, Q.refl);
  if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
  const rt = new THREE.WebGLRenderTarget(innerWidth * pr, innerHeight * pr, { type: THREE.HalfFloatType, samples: Q.samples });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
  wPass = new RenderPass(wScene, wCam); wPass.clear = false; wPass.clearDepth = true; composer.addPass(wPass);
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.55, 2.2); bloom.enabled = Q.bloom; composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grade = new ShaderPass(GradeShader); grade.uniforms.aspect.value = innerWidth / innerHeight; composer.addPass(grade);
  if (sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.mapSize.set(Q.shadow, Q.shadow); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
}
addEventListener('resize', () => {
  camera.aspect = wCam.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); wCam.updateProjectionMatrix();
  curPR = 0; applyPR(); bloom.setSize(innerWidth, innerHeight);
  grade.uniforms.aspect.value = innerWidth / innerHeight;
});

// ======================================================= INPUT
function sens() { const w = WEAPONS[P.weapon]; return 0.0021 * settings.sens * (P.ads > 0.5 ? (w.scope ? (P.zoom2 ? 0.26 : 0.21) : 0.65) : 1); }
addEventListener('mousemove', e => {
  if (gameState !== 'play' || !P.alive) return;
  if (!locked && !(e.buttons & 1)) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return; // ignore pointer-lock jumps
  P.yaw -= dx * sens(); P.pitch = clamp(P.pitch - dy * sens(), -1.5, 1.5);
  P.swayX = clamp(P.swayX - dx * 0.00012, -0.03, 0.03); P.swayY = clamp(P.swayY + dy * 0.00012, -0.03, 0.03);
});
addEventListener('mousedown', e => {
  if (gameState !== 'play' || chatOpen) return;
  if (!locked && wantLock) requestLock();
  if (e.button === 0) mouseDown = true;
  if (e.button === 2) P.adsHeld = true;
});
addEventListener('wheel', e => { if (gameState !== 'play') return; const w = WEAPONS[P.weapon]; if (w.scope && P.ads > 0.5) { P.zoom2 = e.deltaY > 0; SFX.mech('boltup'); } }, { passive: true });
addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; if (e.button === 2) P.adsHeld = false; });
addEventListener('contextmenu', e => { if (gameState === 'play') e.preventDefault(); });
addEventListener('keydown', e => {
  if (gameState !== 'play' || chatOpen) return;
  if (e.code === 'Tab') { e.preventDefault(); showBoard(); return; }
  if (e.repeat) return;
  if (e.code === 'Enter' || e.code === 'KeyT') { e.preventDefault(); openChat(); return; }
  keys[e.code] = true;
  if (!P.alive) return;
  if (e.code === 'KeyF') toggleIR();
  if (e.code === 'KeyG') throwNade('f');
  if (e.code === 'KeyX') throwNade('s');
  if (e.code === 'Digit5') setWeapon(LAUNCHER);
  if (e.code === 'KeyE') { if (P.rope) releaseRope(); else grabRope(); }
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyC' && !P.rope && !P.vault && !trySlide()) P.crouching = !P.crouching;
  if (e.code === 'Digit1') setWeapon(0); if (e.code === 'Digit2') setWeapon(1); if (e.code === 'Digit3') setWeapon(2); if (e.code === 'Digit4') setWeapon(3);
  if (e.code === 'KeyQ') setWeapon(P.prevWeapon);
});
addEventListener('keyup', e => { if (chatOpen) return; keys[e.code] = false; if (e.code === 'Tab') hideBoard(); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = false; P.adsHeld = false; });
function requestLock() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => { }); } catch (e) { } }
document.addEventListener('pointerlockchange', () => {
  const was = locked; locked = document.pointerLockElement === canvas;
  if (was && !locked && gameState === 'play') openMenu(true);
});

// ======================================================= MENU
const menu = $('menu'), deployBtn = $('deploy'), statusEl = $('status');
function setStatus(text, cls = '') { statusEl.className = 'status ' + cls; statusEl.lastElementChild.textContent = text; }
$('name').value = settings.name;
$('name').addEventListener('input', e => { settings.name = e.target.value.trim().slice(0, 16); store.set('name', settings.name); sendProfile(); });
$('fov').value = settings.fov; $('fovv').textContent = settings.fov;
$('fov').addEventListener('input', e => { settings.fov = +e.target.value; $('fovv').textContent = settings.fov; store.set('fov', settings.fov); });
$('vol').value = settings.vol;
$('vol').addEventListener('input', e => { settings.vol = +e.target.value; store.set('vol', settings.vol); if (masterGain) masterGain.gain.value = settings.vol; });
$('sens').value = settings.sens;
$('sens').addEventListener('input', e => { settings.sens = +e.target.value; store.set('sens', settings.sens); });
const qButtons = [...document.querySelectorAll('#quality button')];
const syncQ = () => qButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.q === settings.quality));
qButtons.forEach(b => b.addEventListener('click', () => { settings.quality = b.dataset.q; store.set('quality2', settings.quality); dynScale = 1; syncQ(); setupPost(); }));
syncQ();
let joined = false;
deployBtn.addEventListener('click', async () => {
  initAudio();
  if (!joined) {
    deployBtn.disabled = true; deployBtn.textContent = 'Connecting…';
    const ok = await connect();
    joined = true;
    if (ok === 'full') { setStatus('The match is full (4 players).', 'warn'); deployBtn.disabled = false; deployBtn.textContent = 'Deploy'; joined = false; return; }
    if (!ok) { startLocal(); setStatus(hostCfg.bots ? `Offline practice against ${hostCfg.bots} bot${hostCfg.bots > 1 ? 's' : ''}.` : 'Offline practice range.', 'warn'); }
    else setStatus(isHost ? 'Hosting the match.' : 'Connected to the host.', 'ok');
    renderScore(); deployBtn.disabled = false; deployed = true;
  } else if (!deployed) { deployed = true; if (inLobby) netSend({ t: 'ready' }); }
  closeMenu();
});
function closeMenu() {
  gameState = 'play'; menu.hidden = true; $('hud').hidden = false; wantLock = true; requestLock();
  viewmodels.forEach((v, k) => v.root.visible = P.alive && k === P.weapon);
  deployBtn.textContent = 'Resume';
}
function openMenu() { closeChat(false); gameState = 'menu'; menu.hidden = false; mouseDown = false; P.adsHeld = false; for (const k in keys) keys[k] = false; }

// ======================================================= LOOP
const clock = new THREE.Clock();
let elapsed = 0;
const perf = { n: 0, t: 0, fps: 0, lastChange: 0, shown: '' };
function trackPerf(raw) { // measure real fps once a second; in Auto, trade resolution for a steady 60
  if (document.hidden || raw > 0.5) { perf.n = 0; perf.t = 0; return; }
  perf.n++; perf.t += raw; if (perf.t < 1) return;
  const fps = perf.n / perf.t; perf.fps = Math.round(fps); perf.n = 0; perf.t = 0;
  if (!QUALITY[settings.quality].adaptive || gameState !== 'play' || (WEAPONS[P.weapon].scope && P.ads > 0.5)) return;
  const now = performance.now();
  // Every change of resolution is a visible shimmer, so make them rare: if stepping up only made it drop again,
  // wait twice as long before the next try (6 s, 12 s ... up to 4 minutes).
  if (fps < 50 && dynScale > 0.62 && now - perf.lastChange > 1500) {
    if (perf.wentUp && now - perf.wentUp < 9000) perf.upWait = Math.min(240000, (perf.upWait || 6000) * 2);
    perf.wentUp = 0; dynScale = Math.max(0.62, dynScale * (fps < 36 ? 0.86 : 0.93)); perf.lastChange = now; applyPR();
  } else if (fps >= 58.5 && dynScale < 1 && now - perf.lastChange > (perf.upWait || 6000)) { dynScale = Math.min(1, dynScale * 1.05); perf.lastChange = now; perf.wentUp = now; applyPR(); }
}
function frame() {
  const raw = clock.getDelta(); trackPerf(raw);
  const dt = Math.min(0.05, raw); elapsed += dt;
  skyUniforms.uTime.value = elapsed;
  if (water) water.material.uniforms.time.value = elapsed * 0.27;
  updateDay(dt);
  if (gameState === 'play' || deployed) {
    if (gameState === 'play') updatePlayer(dt);
    if (gameState === 'play' && !window.__freeCam) updateCamera(dt, elapsed);
    if (online && deployed) sendState(dt);
  }
  if (!deployed) { // menu flyover
    const a = elapsed * 0.06;
    camera.position.set(Math.cos(a) * 40, 15 + Math.sin(a * 0.7) * 2.5, Math.sin(a) * 30 + 8);
    camera.lookAt(0, 1.5, 6);
  }
  updateBots(dt);
  for (const r of remotes.values()) r.update(dt);
  for (const H of ROPE_HELIS) updateRopeHeli(H, dt);
  updateTargets(dt);
  updateNades(dt); updateDrop(dt); updateFire(dt); updateBlind(dt); updateAmbience(dt);
  updateFlybys(dt); updateMissiles(dt); updateShells(dt); updateThreat(dt); updateSearchlight(dt); updateFlags(elapsed); updateBoats(dt, elapsed); updateBoatFlags(elapsed); updatePort(dt);
  sparks.update(dt); debris.update(dt); smoke.update(dt); updateTracers(dt);
  for (const f of flashLights) if (f.t > 0) { f.t -= dt; if (f.t <= 0) f.l.intensity = 0; }
  sky.position.copy(camera.position);
  if (gameState === 'play') updateHUD(dt);
  updateIR(dt);
  grade.uniforms.time.value = elapsed;
  if (!window.__noRender) composer.render(dt);
  requestAnimationFrame(frame);
}

// ======================================================= BOOT
buildMap();
botCtx.nav = new NavGrid(colliders.filter(c => !c.ship).concat(WATER_BLOCKS), MAP);
buildTargets();
setupPost();
prewarm();
spawnBoat('corvette', 0.35); spawnBoat('fac', 0.62);
updateSlotsHUD();
respawnLocal(0);
viewmodels.forEach(v => v.root.visible = false);
window.__booted = true; clearTimeout(window.__bootTimer);
deployBtn.disabled = false; deployBtn.textContent = 'Deploy';
// ---- join codes (internet play through the host's Cloudflare quick tunnel)
const isLocalHost = /^(localhost|127\.)/.test(location.hostname);
function normCode(v) {
  return String(v || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\.trycloudflare\.com.*$/, '').replace(/\/.*$/, '').replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function showJoinBox() {
  $('joinbox').hidden = false;
  const inp = $('joincode'), btn = $('joinbtn'), msg = $('joinmsg');
  const fromHash = normCode((location.hash || '').replace(/^#(join=)?/, ''));
  if (fromHash) inp.value = fromHash;
  const go = async () => {
    const code = normCode(inp.value);
    if (!/^[a-z0-9]+(-[a-z0-9]+){1,}$/.test(code)) { msg.className = 'err'; msg.textContent = 'That doesn\'t look like a join code. It is a few words joined by dashes, like sunny-lake-river-boat.'; return; }
    const url = `https://${code}.trycloudflare.com/`;
    btn.disabled = true; msg.className = ''; msg.textContent = 'Looking for the match…';
    const ok = await new Promise(res => {
      const img = new Image(); const tm = setTimeout(() => { img.src = ''; res(false); }, 12000);
      img.onload = () => { clearTimeout(tm); res(true); };
      img.onerror = () => { clearTimeout(tm); res(false); };
      img.src = url + 'probe.gif?' + Date.now();
    });
    if (ok) { msg.textContent = 'Found it. Connecting…'; location.href = url; return; }
    btn.disabled = false; msg.className = 'err';
    msg.innerHTML = `No match found for <b>${esc(code)}</b>. Check the spelling with the host, and make sure their Tidebreak window is still open. <a href="${url}" style="color:var(--amber)">Try opening it anyway</a>`;
  };
  btn.onclick = go;
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
}
function hostNote(info) {
  const lan = info.lan && info.lan.length ? `<br>Same Wi-Fi: the other Mac can also open <b style="color:var(--amber);user-select:all">http://${info.lan[0]}:${info.port}</b>` : '';
  const o = info.online || {};
  if (o.state === 'ready') return `<b style="color:var(--ink)">You are hosting.</b> Send the other players (up to 3) this <b>join code</b>:<br><span class="code">${esc(o.code)}</span> <button class="btn2" type="button" id="copyinv" style="padding:6px 10px;font-size:12px;vertical-align:middle">Copy invite</button><br>They open <b style="user-select:all">${esc(o.url)}</b> in Chrome or Safari (or type the code into the Join box of their Tidebreak).${lan}`;
  if (o.state === 'starting' || o.state === 'linking' || o.state === 'download') return `<b style="color:var(--ink)">You are hosting.</b> ${esc(o.msg || 'Getting a join code…')}${lan}`;
  if (o.state === 'failed') return `<b style="color:var(--ink)">You are hosting.</b> <span style="color:#ff8a7a">${esc(o.msg || 'Internet play is not available.')}</span>${lan}`;
  return `<b style="color:var(--ink)">You are hosting.</b>${lan || ' Internet play is off.'}`;
}
if (location.protocol === 'file:') {
  setStatus('Practice range (opened as a file). Enter a join code to play online.', 'warn');
  $('hostnote').innerHTML = 'Deploy here gives the <b style="color:var(--amber)">solo practice range</b>. To play someone, type their <b>join code</b> above, or host a match yourself by double-clicking <b>Start Tidebreak.command</b>.';
  showJoinBox();
} else {
  setStatus(viaTunnel ? 'Connected to the host over the internet. Deploy to join the match.' : 'Ready. Deploy joins the match on this server.', 'ok');
  let polls = 0, lastNote = '';
  const poll = () => fetch('/info', { cache: 'no-store' }).then(r => r.json()).then(info => {
    if (isLocalHost) {
      const h = hostNote(info);
      if (h !== lastNote) {
        lastNote = h; $('hostnote').innerHTML = h;
        const cb = $('copyinv');
        if (cb) cb.onclick = () => {
          const o = info.online, txt = `Tidebreak! Open ${o.url} in Chrome or Safari (join code: ${o.code})`;
          (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { cb.textContent = 'Copied'; }, () => { cb.textContent = 'Select the code to copy'; });
        };
      }
      const st = info.online && info.online.state;
      // keep refreshing while the code is being set up, then slowly in case the link restarts
      if (polls++ < 2000) setTimeout(poll, st === 'ready' || st === 'off' ? 5000 : 1500);
    } else if (viaTunnel) {
      $('hostnote').innerHTML = 'You joined over the internet. If the game feels laggy, use the <b>Fast</b> graphics setting and close other apps that use the internet (video calls, downloads).';
    }
  }).catch(() => {
    if (polls > 0) { setTimeout(poll, 5000); return; }
    if (/^https?:$/.test(location.protocol)) { showWebLobby(); updateHostUI(); return; }
    setStatus('Solo practice range. Enter a join code to play online.', 'warn');
    $('hostnote').innerHTML = 'This page is the <b style="color:var(--amber)">solo practice range</b> with steel targets. To play someone, type their join code above, or host by double-clicking <b>Start Tidebreak.command</b>.';
    showJoinBox();
  });
  poll();
}
updateHostUI();
// ---- website version: one browser hosts, the other joins with a short code
function showWebLobby() {
  webMode = true;
  $('webbox').hidden = false;
  setStatus('Host a match or join one with a code. Deploy alone opens the practice range.', 'ok');
  $('hostnote').innerHTML = '<b style="color:var(--ink)">Up to 4 players, one code.</b> Everyone opens this website from anywhere. One player clicks <b>Host a match</b> and shares the code; the other three type that same code and click <b>Join</b>. Keep the host\'s window open while you play.';
  const hb = $('hostbtn'), jb = $('webjoinbtn'), inp = $('webcode'), msg = $('webmsg');
  const lock = on => { hb.disabled = on; jb.disabled = on; inp.disabled = on; };
  const fromHash = P2P.normCode((location.hash || '').replace(/^#(join=)?/, ''));
  if (fromHash) inp.value = fromHash;
  const why = e => e && e.type === 'peer-unavailable' ? 'No match found with that code. Check it with the host, and make sure their game is open and showing the code.'
    : e && e.type === 'timeout' ? 'Could not reach the host. If you are in different houses, one of the networks may block direct connections; try again, or both join the same Wi-Fi.'
    : e && (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') ? 'Could not reach the matchmaking service. Check the internet connection and try again.'
    : e && e.type === 'browser-incompatible' ? 'This browser does not support direct connections. Use Chrome or Safari.'
    : 'Something went wrong (' + esc((e && (e.type || e.message)) || 'unknown') + '). Try again.';
  hb.onclick = async () => {
    lock(true); msg.className = ''; msg.textContent = 'Getting a match code…';
    try {
      const code = await P2P.host(() => { msg.innerHTML = codeHtml(code) + '<br><b style="color:var(--ink)">A player joined.</b> The same code works for up to 4 players. Click Deploy if you have not yet.'; });
      const link = location.origin + location.pathname + location.search + '#' + code;
      const codeHtml = c => `Your match code: <span class="code">${esc(c)}</span> <button class="btn2" type="button" id="copyweb" style="padding:6px 10px;font-size:12px;vertical-align:middle">Copy invite</button><br>Up to 3 more players open <b style="user-select:all">${esc(link)}</b> or type this code and click Join.`;
      msg.innerHTML = codeHtml(code) + '<br>The lobby below shows who has joined. Click <b>Deploy</b> to drop in while you wait.'; enterLobby(code);
      document.addEventListener('click', e => { if (e.target && e.target.id === 'copyweb') { const b = e.target; const txt = `Tidebreak! Open ${link} (match code ${code})`; (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Select the code to copy'; }); } });
      setStatus('You are hosting match ' + code + '. Pick the mode and bots, then Deploy.', 'ok'); updateHostUI();
    } catch (e) { lock(false); msg.className = 'err'; msg.textContent = why(e); }
  };
  const go = async () => {
    const code = P2P.normCode(inp.value);
    if (code.length < 4) { msg.className = 'err'; msg.textContent = 'Type the 5-letter code shown on the host\'s screen.'; return; }
    lock(true); msg.className = ''; msg.textContent = 'Looking for match ' + code + '…';
    try {
      await P2P.join(code);
      msg.innerHTML = '<b style="color:var(--ink)">Connected to match ' + esc(code) + '.</b> You are in the lobby. Click Deploy to drop in.'; updateHostUI();
      setStatus('Connected to the host. Deploy to join the match.', 'ok');
      if (await enterLobby(code) === 'full') { lock(false); msg.className = 'err'; msg.textContent = 'That match is full (4 players). Ask the host who is in, or try again later.'; setStatus('That match is full (4 players).', 'warn'); }
    } catch (e) { lock(false); msg.className = 'err'; msg.textContent = why(e); }
  };
  jb.onclick = go;
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
}
requestAnimationFrame(frame);
window.__tb = { rayWorld, makeOperator, poseOperator, provoke, shotAtVehicles, missiles, shells, port, isLand, get swim() { return P.swim; }, composer, viewmodels, bots, get ropeHeli() { return ropeHeli; }, exHeli, aboard, grabRope, startRopeHeli, get localMatch() { return localMatch; }, get cfg() { return cfg; }, get netMode() { return netMode; }, perf, get dynScale() { return dynScale; }, get pr() { return curPR; }, spawnFlyby, flybys, boats, P, remotes, playerInfo, colliders, renderer, scene, camera, keys, get online() { return online; }, fire: () => fire(), setWeapon, onNet, sun, scopeView, fitShadows, IR, toggleIR, throwNade, nades, giveLauncher, startDrop, get drop() { return drop; }, DAY, settings, prog, threat, get deployed() { return deployed; }, get inLobby() { return inLobby; }, chatSend, tryVault, trySlide, surfaceAt, ROPE_HELIS };
