// TIDEBREAK — LAN deathmatch. Three.js r160.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Water } from 'three/addons/objects/Water.js';
import { makeOperator, poseOperator, killOperator, reviveOperator, muzzleWorld, lookFor, ropeMaterial } from './operator.js';
import { NavGrid, Bot, rayCombatants } from './bots.js';
import { Match, SPAWNS, TEAM_NAMES } from '../match.js';
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
  auto: { maxPR: 1.25, budget: 3.7e6, samples: 4, shadow: 2048, bloom: true, refl: 512, adaptive: true },
  ultra: { maxPR: 2, budget: 9e6, samples: 4, shadow: 4096, bloom: true, refl: 1024 },
  high: { maxPR: 1.5, budget: 4.2e6, samples: 4, shadow: 2048, bloom: true, refl: 512 },
  fast: { maxPR: 1, budget: 1.8e6, samples: 0, shadow: 1024, bloom: false, refl: 256 }
};
const settings = { name: store.get('name', ''), sens: store.get('sens', 1), quality: store.get('quality2', 'auto') };
if (!QUALITY[settings.quality]) settings.quality = 'auto';
const SLOT_COLORS = [0xffb547, 0x5fd0ff, 0xa6e35a, 0xff6fb5];
const SLOT_CSS = ['#ffb547', '#5fd0ff', '#a6e35a', '#ff6fb5'];
const TEAM_COLORS = [0x2f7fe0, 0xe0452f], TEAM_CSS = ['#5aa2ff', '#ff6a52'];
const MAP = { x0: -42, x1: 42, z0: -24, z1: 38 }; // compound bounds (84 x 62 m)

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
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 1500);
camera.rotation.order = 'YXZ';
const wScene = new THREE.Scene();
const wCam = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.01, 10);
wScene.add(wCam);

const SUN_DIR = new V3(-0.62, 0.17, -0.77).normalize();

// ======================================================= SKY + ENVIRONMENT
const skyUniforms = {
  uSun: { value: SUN_DIR.clone() }, uZen: { value: new THREE.Color(0x14244a) }, uHor: { value: new THREE.Color(0xc98577) },
  uHorSun: { value: new THREE.Color(0xff9440) }, uGround: { value: new THREE.Color(0x2b2630) }, uDisk: { value: 60 }, uTime: { value: 0 }
};
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
  uniform vec3 uSun,uZen,uHor,uHorSun,uGround; uniform float uDisk,uTime; varying vec3 vD;
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
      vec3 lit = mix(vec3(0.16,0.10,0.16), uHorSun*1.6, pow(s,3.0)*0.9 + 0.15);
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
sun.position.copy(SUN_DIR).multiplyScalar(95).add(new V3(0, 0, 7)); sun.target.position.set(0, 0, 7);
sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 230 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);

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
  blot(g, S, 18, 'rgba(25,25,25,1)', 20, 70); blot(g, S, 30, 'rgba(90,90,90,.7)', 10, 40);
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
  for (let x = 0; x < S; x++) { const v = Math.sin(x / S * Math.PI * 2 * 16); const s = color ? 150 + 70 * v : 128 + 120 * v; g.fillStyle = `rgb(${s},${s},${s})`; g.fillRect(x, 0, 1, S); }
  if (color) { blot(g, S, 50, 'rgba(90,50,25,.35)', 8, 50); blot(g, S, 30, 'rgba(30,30,30,.3)', 20, 90); grain(g, S, 20); }
}
T.corr = ctex(512, (g, S) => corrDraw(g, S, true));
T.corrBump = ctex(256, (g, S) => corrDraw(g, S, false), { srgb: false });
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
  wallMetal: std({ map: T.corr, bumpMap: T.corrBump, bumpScale: 2, color: 0x8f9a9e, roughness: 0.5, metalness: 0.55 }),
  roof: std({ map: T.corr, bumpMap: T.corrBump, bumpScale: 2, color: 0x6c6460, roughness: 0.6, metalness: 0.5 }),
  steel: std({ color: 0x3b3e42, roughness: 0.42, metalness: 0.85 }),
  steelLight: std({ color: 0x8b9095, roughness: 0.35, metalness: 0.9 }),
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
  lamp: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0d0, emissiveIntensity: 10 }),
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
const CONTAINER_COLORS = [0x8e3b2a, 0x22406a, 0x3f5f3a, 0xb0602a, 0x6a6e70, 0x7a2f3c, 0x2f5c63];
const containerMats = CONTAINER_COLORS.map(c => std({ map: T.corr, bumpMap: T.corrBump, bumpScale: 2.5, color: c, roughness: 0.62, metalness: 0.45 }));
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

function container(x, z, alongZ, level, color) {
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
  for (let x = -41.4; x <= 41.4; x += 2.07) place(cyl(0.04, 1.1, 8), M.rail, x, 0.85, -24.5);
  for (const y of [0.75, 1.32]) place(new THREE.CylinderGeometry(0.035, 0.035, 83.5, 8).rotateZ(Math.PI / 2), M.rail, 0, y, -24.5);
  addCollider(-42, -3, -25.2, 42, 0.3, -24.2); addCollider(-42, 0.3, -25.2, 42, 8, -24.2, true);
  // bollards
  for (const x of [-36, -22, -8, 8, 22, 36]) { place(new THREE.CylinderGeometry(0.22, 0.28, 0.6, 14), M.steel, x, 0.3, -23.6); addCollider(x - 0.28, 0, -23.9, x + 0.28, 0.6, -23.3); }

  // Perimeter walls (S, W, E)
  const PW = (x, z, w, d) => { addBox(x, 0, z, w, 3.6, d, M.whitewash, { s: 3, ch: 8 }); addBox(x, 3.6, z, w + 0.2, 0.18, d + 0.2, M.aegean, { collide: false }); addBox(x, 0, z, w + 0.06, 0.35, d + 0.06, M.stone, { collide: false }); };
  PW(0, 38.3, 84.6, 0.6); PW(-42.3, 7, 0.6, 63.2); PW(42.3, 7, 0.6, 63.2);
  for (let x = -39; x <= 39; x += 6) addBox(x, 0, 37.9, 0.5, 3.7, 0.3, M.whitewash, { collide: false });
  for (let z = -18; z <= 34; z += 6) { addBox(-41.9, 0, z, 0.3, 3.7, 0.5, M.whitewash, { collide: false }); addBox(41.9, 0, z, 0.3, 3.7, 0.5, M.whitewash, { collide: false }); }
  // razor wire on walls
  for (const [x, z, len, rz] of [[0, 38.3, 84, 1], [-42.3, 7, 62, 0], [42.3, 7, 62, 0]]) {
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
  crate(-5.2, 0, -3.4); crate(-5.2, 1.1, -3.4, 1.1, 0.2); crate(-4.0, 0, -3.6); crate(-5.4, 0, 3.4, 1.3); crate(5.3, 0, -3.5, 1.3); crate(5.4, 1.3, -3.5, 1.0, -0.3);
  addBox(-1.6, 0, 1.2, 0.9, 1.05, 3.2, M.olive, { s: 1 });      // workbench
  addBox(2.2, 0, -1.4, 1.2, 1.2, 1.2, M.wood, { s: 1.2 });
  ammoCrateAt(0.9, 0, 3.6);
  // shelving on west wall
  for (let i = 0; i < 3; i++) { addBox(-6.35, 0.7 + i * 0.9, -0.1 + 1.2, 0.7, 0.06, 2.6, M.steel, { collide: i === 0 }); }
  addBox(-6.35, 0, 1.1, 0.7, 0.7, 2.6, M.steel, { collide: true, cast: true });

  // ---- North lane: containers + catwalk
  container(-19, -18.6, false, 0, 0); container(-19, -18.6, false, 1, 1);
  container(-4, -18, false, 0, 4);
  container(11, -18.6, false, 0, 2);
  container(22, -14, true, 0, 5);
  container(-24, -6, true, 0, 3);
  // stairs to the catwalk container top (2.59)
  for (let i = 1; i <= 7; i++) {
    const top = 2.59 * i / 7, x1 = -7.03 - (7 - i) * 0.55, x0 = x1 - 0.55;
    addBox((x0 + x1) / 2, 0, -18, 0.55, top, 1.6, M.steel, { s: 1 });
  }
  place(cyl(0.03, 4.2, 6).rotateZ(Math.atan2(2.59, 3.85)), M.rail, -9.0, 2.2, -17.15);
  // container top kit
  sandbags(-2.2, -18, 2.2, true, 2); ammoCrateAt(-5.6, 2.59, -18.4);
  crate(13, 0, -16.6, 1.0); crate(14.1, 0, -16.6, 1.0, 0.4); crate(13.5, 1.0, -16.6, 0.9, 0.2);
  barrel(-14.6, -20.8, 0); barrel(-14, -21.4, 1); barrel(-13.3, -20.9, 2);
  jersey(4, -13, false, 3.2); jersey(-12, -11.5, true, 3.2);

  // ---- Middle flanks
  container(17, 8, true, 0, 6);
  container(-15, 10, false, 0, 2); container(-15, 10, false, 1, 0);
  sandbags(-14, 2, 3.6, false); sandbags(13.5, -3, 3.6, true);
  crate(-21, 0, 5, 1.2); crate(-21.2, 0, 6.3, 1.0, 0.3); barrel(-20.6, 3.6, 3);
  crate(21, 0, -3, 1.2, 0.1); barrel(22.4, -2.4, 0); barrel(22.6, -1.6, 1);
  barrel(9.6, 6.4, 2); barrel(10.3, 6.9, 0); crate(25, 0, 5, 1.1);

  // ---- South lane: truck, barriers, fuel tanks, guard hut
  truck(-4, 15.4);
  jersey(4.5, 19.5, false, 3.2); jersey(-17, 14, true, 3.2); jersey(24.5, 2.5, true, 3.2);
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
  crate(-18, 0, 21.8, 1.1); crate(-16.9, 0, 22, 1.0, .5); barrel(13, 22.6, 3); barrel(13.7, 22.9, 2);
  crate(28.5, 0, 17.8, 1.2, 0.2);

  // ---- Floodlights
  floodlight(-40.5, -22.5, -26, -10); floodlight(40.5, -22.5, 26, -10); floodlight(-40.5, 36.5, -22, 26); floodlight(40.5, 36.5, 22, 26);
  expansion();

  // ---- Harbour crane (outside east, scenery)
  const cx = 58, cz = -30;
  for (const [dx, dz] of [[-4, -5], [4, -5], [-4, 5], [4, 5]]) addBox(cx + dx, -2, cz + dz, 0.9, 24, 0.9, M.paint, { s: 4, collide: false });
  addBox(cx, 20, cz, 10, 1.4, 12, M.paint, { s: 4, collide: false });
  addBox(cx - 18, 22, cz, 52, 1.2, 1.6, M.paint, { s: 4, collide: false });
  addBox(cx + 2, 21.4, cz, 4, 3, 4, M.paint, { s: 4, collide: false });
  place(cyl(0.03, 14, 4), M.steel, cx - 26, 15, cz);
  addBox(cx - 26, 6.5, cz, 2.4, 1.2, 6, containerMats[1], { s: 4.8, collide: false });
  noCastScope = true; village(); noCastScope = false;
  // flags: warehouse roof, seawall, painted wall flag
  wavingFlag(0, 6.37, 0, 9, 2.6, 1.7); wavingFlag(-38, 0, -23.4, 8, 2.2, 1.45); wavingFlag(38, 0, -23.4, 8, 2.2, 1.45);
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3), new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.95, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2 })); m.position.set(-14, 2.3, 37.99); m.rotation.y = Math.PI; scene.add(m); }

  mergeStatic();
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
    wallRun('x', oz, cx - w / 2 + 0.3, cx - 0.2, 3.0, 0.15, [{ c: cx - 1.4, w: 1.1, h: 2.2 }], M.wallMetal);
    wallRun('z', cx - 0.2, oz, cz + d / 2 - 0.3, 3.0, 0.15, [{ c: oz + 2.2, w: 1.4, h: 2.3, y0: 1.0 }], M.wallMetal);
    addBox(cx - 2.2, 3.0, (oz + cz + d / 2 - 0.3) / 2, w / 2 - 0.1, 0.1, cz + d / 2 - 0.3 - oz, M.steel, { collide: true });
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
  openContainer(-37.5, -14, true, 3, -1); openContainer(37.5, 15.5, true, 1, 1); openContainer(-14, 26.5, false, 5, 1); openContainer(17.5, 35.3, false, 0, -1);
  container(-37.5, -14, true, 1, 6); // stacked box on top of the west open container
  container(38, 24.5, false, 0, 2);
  sandbags(-35, -6.5, 3.4, false); sandbags(35, 8.5, 3.2, false); jersey(-37, 20, false, 3.2); jersey(31, -18, true, 3.2);
  crate(-40, 0, -21.8, 1.2); crate(-38.8, 0, -22, 1.0, 0.4); barrel(40, -21.5, 1); barrel(39.4, -22.1, 3); barrel(-40.2, 26, 0);
  stoneWall(-20, 31, 6, true); stoneWall(8, 27.2, 5, false); stoneWall(-6, 35.6, 4, false); stoneWall(-9, 25.4, 3.5, false, 0.9);
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
function greekHouse(x, y, z, w, d, h, ry = 0) {
  addBox(x, y, z, w, h, d, M.whitewash, { collide: false, s: 3 });
  addBox(x, y + h, z, w + 0.15, 0.15, d + 0.15, M.whitewash, { collide: false, s: 3 });
  const fz = z - d / 2 - 0.03; // north-facing front toward harbour
  place(boxGeo(0.9, 2.0, 0.06, 1), M.aegean, x - w * 0.2, y + 1.0, fz, { cast: false });
  place(boxGeo(0.8, 0.9, 0.06, 1), sr() < 0.5 ? M.aegean : M.winGlow, x + w * 0.22, y + h * 0.6, fz, { cast: false });
  if (sr() < 0.35) addBox(x + w * 0.3, y + h + 0.15, z + d * 0.2, 0.9, 0.9, 0.9, M.whitewash, { collide: false, s: 3 });
  if (sr() < 0.3) place(boxGeo(w * 0.5, 0.1, 1.2, 2), M.terracotta, x, y + h * 0.75, fz - 0.6, { cast: true });
}
function cypress(x, y, z, h = 9) {
  place(cyl(0.12, 1.2, 6), M.bark, x, y + 0.6, z);
  const c = place(new THREE.ConeGeometry(0.9, h, 10), M.cypress, x, y + h / 2 + 0.8, z); c.scale.set(1, 1, 1);
  place(new THREE.SphereGeometry(0.9, 10, 8), M.cypress, x, y + 1.9, z);
}
function oliveTree(x, y, z) {
  place(new THREE.CylinderGeometry(0.15, 0.3, 2.2, 7), M.bark, x, y + 1.1, z, { rz: SR(-0.25, 0.25) });
  for (let i = 0; i < 5; i++) place(new THREE.IcosahedronGeometry(SR(0.9, 1.4), 1), M.oliveLeaf, x + SR(-1.2, 1.2), y + 2.4 + SR(0, 0.9), z + SR(-1.2, 1.2));
}
function village() {
  // terraced hillside rising to the south, beyond the compound wall
  for (let row = 0; row < 6; row++) {
    const z = 46 + row * 9, y = row * 3.2;
    addBox(0, -0.2, z + 4.5, 180, y + 0.2, 9, M.stone, { collide: false, s: 4 });
    for (let x = -80; x < 80; x += SR(7, 12)) {
      if (sr() < 0.2) { sr() < 0.5 ? cypress(x, y, z + SR(0, 4), SR(7, 11)) : oliveTree(x, y, z + SR(0, 4)); continue; }
      greekHouse(x, y, z + SR(1.5, 3), SR(4, 7), SR(4, 6), SR(3, 5.5));
    }
  }
  // chapel with blue dome on the hill
  const cx = 22, cy = 6 * 3.2, cz = 96;
  addBox(cx, cy, cz, 7, 5, 9, M.whitewash, { collide: false, s: 3 });
  place(cyl(2.4, 1.2, 24), M.whitewash, cx, cy + 5.6, cz);
  place(new THREE.SphereGeometry(2.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.aegean, cx, cy + 6.2, cz);
  addBox(cx - 2.6, cy, cz - 5, 1.8, 8, 1.8, M.whitewash, { collide: false, s: 3 });
  place(new THREE.SphereGeometry(0.95, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.aegean, cx - 2.6, cy + 8, cz - 5);
  place(boxGeo(0.12, 1.1, 0.12, 1), M.steelLight, cx, cy + 9.2, cz); place(boxGeo(0.7, 0.12, 0.12, 1), M.steelLight, cx, cy + 9.4, cz);
  // trees along the west & east outside the walls
  for (let z = -15; z <= 36; z += 7) { cypress(-48 - sr() * 6, 0, z, SR(8, 12)); cypress(48 + sr() * 4, 0, z + 3, SR(8, 12)); }
  for (let i = 0; i < 7; i++) oliveTree(SR(-72, -54), 0, SR(-10, 40));
  // a few houses west
  for (let z = -10; z < 42; z += 9) greekHouse(-63, 0, z, 6, 6, SR(3.5, 6));
}

function truck(x, z) { // long axis along x, cab at +x
  addBox(x + 2.6, 0.55, z, 2.0, 1.9, 2.4, M.olive, { s: 2 });              // cab
  addBox(x + 3.65, 0.55, z, 0.1, 0.9, 2.2, M.steel, { collide: false });     // grille
  place(boxGeo(0.06, 0.7, 2.1, 1), M.glass, x + 3.58, 2.0, z, { rz: 0.15 });
  for (const s of [-0.85, 0.85]) place(boxGeo(0.06, 0.18, 0.3, 1), M.lamp, x + 3.71, 1.0, z + s, { cast: false });
  addBox(x - 1.2, 0.55, z, 5.4, 0.7, 2.4, M.olive, { s: 2 });               // bed
  addBox(x - 1.2, 1.25, z, 5.2, 1.6, 2.3, M.canvas, { s: 2 });              // tarp
  addBox(x, 0.25, z, 7.2, 0.3, 1.2, M.steel, { collide: false });           // chassis
  for (const wx of [x + 2.5, x - 0.6, x - 2.1]) for (const s of [-1, 1]) place(new THREE.CylinderGeometry(0.5, 0.5, 0.36, 22).rotateX(Math.PI / 2), M.rubber, wx, 0.5, z + s * 1.08);
  addCollider(x - 3.9, 0, z - 1.25, x + 3.7, 0.55, z + 1.25);
}

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

// ======================================================= PHYSICS
function collideCircle(pos, r, feetY, headY) {
  for (const c of colliders) {
    if (c.max[1] <= feetY + STEP || c.min[1] >= headY) continue;
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
  let g = 0; const rr = r * 0.75;
  for (const c of colliders) {
    const top = c.max[1];
    if (top > feetY + STEP || top <= g) continue;
    if (x + rr > c.min[0] && x - rr < c.max[0] && z + rr > c.min[2] && z - rr < c.max[2]) g = top;
  }
  return g;
}
function ceilingAt(x, z, r, headY) {
  let cl = 1e9; const rr = r * 0.75;
  for (const c of colliders) { const b = c.min[1]; if (b < headY - 0.6 || b >= cl) continue; if (x + rr > c.min[0] && x - rr < c.max[0] && z + rr > c.min[2] && z - rr < c.max[2]) cl = b; }
  return cl;
}
// Ray vs world. Returns {t, n:[nx,ny,nz], water}
function rayWorld(o, d, maxT) {
  let best = maxT, bn = null, water = false;
  if (d.y < 0) { const t = -o.y / d.y; if (t < best && t > 0) { const z = o.z + d.z * t; if (z > -24.2) { best = t; bn = [0, 1, 0]; } } const tw = (-1.9 - o.y) / d.y; if (tw < best && tw > 0 && o.z + d.z * tw < -25) { best = tw; bn = [0, 1, 0]; water = true; } }
  const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z];
  for (const c of colliders) {
    if (c.noRay) continue;
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
      if (q.pos.y < 0.01 && q.pos.z > -24) { q.pos.y = 0.01; q.vel.y *= -0.3; q.vel.x *= 0.6; q.vel.z *= 0.6; }
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
for (let i = 0; i < 24; i++) { const m = new THREE.Mesh(tracerGeo, tracerMat); m.visible = false; m.frustumCulled = false; scene.add(m); tracers.push({ m, a: new V3(), b: new V3(), t: 0, len: 0 }); }
let tracerIdx = 0;
function tracer(a, b) {
  const tr = tracers[tracerIdx++ % tracers.length]; tr.a.copy(a); tr.b.copy(b); tr.len = a.distanceTo(b); tr.t = 0; tr.m.visible = true;
}
function updateTracers(dt) {
  for (const tr of tracers) {
    if (!tr.m.visible) continue; tr.t += dt * 420;
    const head = Math.min(tr.t, tr.len), tail = Math.max(0, tr.t - 5); if (tail >= tr.len) { tr.m.visible = false; continue; }
    const d = tr.b.clone().sub(tr.a).normalize();
    const p0 = tr.a.clone().addScaledVector(d, tail), p1 = tr.a.clone().addScaledVector(d, head);
    tr.m.position.copy(p0).add(p1).multiplyScalar(0.5); tr.m.lookAt(p1); tr.m.scale.set(0.022, 0.022, Math.max(0.01, head - tail));
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
let AC = null, master = null, noiseBuf = null;
function initAudio() {
  if (AC) { AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createDynamicsCompressor(); master.threshold.value = -12; master.ratio.value = 6;
    const g = AC.createGain(); g.gain.value = 0.9; master.connect(g); g.connect(AC.destination);
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
    const p = (w === 1 ? 0.7 : w === 2 ? 1.25 : 1) * R(0.94, 1.06), air = 1 - farK * 0.7;
    if (!supp) noiseHit(out1, { t0: delay, dur: R(0.07, 0.11), type: 'bandpass', f: 2600 * p * air * R(0.88, 1.12), q: R(0.5, 0.8), g: R(0.85, 1.1) });
    noiseHit(out1, { t0: delay, dur: 0.32 * (w === 1 ? 1.6 : 1) * R(0.85, 1.15), type: 'lowpass', f: (supp ? 700 : 1300) * p * air * R(0.85, 1.15), g: R(0.75, 1.0) });
    tone(out1, { t0: delay, f0: 150 * p * R(0.9, 1.1), f1: R(38, 52), dur: 0.16 * (w === 1 ? 1.5 : 1) * R(0.85, 1.15), g: R(0.75, 1.0) });
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
    }
  },
  hitmarker(head) { if (!AC) return; const o = out(0, 0.5); tone(o, { f0: head ? 2400 : 1500, f1: head ? 2200 : 1300, dur: 0.07, g: 0.5, type: 'triangle' }); },
  kill() { if (!AC) return; const o = out(0, 0.5); tone(o, { f0: 900, f1: 880, dur: 0.12, g: 0.5, type: 'square' }); tone(o, { t0: 0.09, f0: 1350, f1: 1320, dur: 0.18, g: 0.4, type: 'square' }); },
  hurt() { if (!AC) return; const o = out(0, 0.8); tone(o, { f0: R(80, 100), f1: 40, dur: 0.18, g: 1 }); noiseHit(o, { dur: 0.12, f: R(700, 1100), g: 0.5 }); },
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
    else if (kind === 'slide') { nh(0, 0.06, 2800, 3, 0.9); tone(o, { t0: 0.01, f0: R(800, 1000), f1: 400, dur: 0.05, g: 0.25, type: 'square' }); }
  },
  reload(step) { this.mech(step ? 'magin' : 'magout'); },
  step(pos, loud = 1) { if (!AC) return; const s = spatial(pos); const o = out(s.pan, s.gain * loud * (pos ? 1.6 : 0.5) * R(0.8, 1.15)); noiseHit(o, { dur: R(0.07, 0.11), type: 'bandpass', f: R(450, 850), q: R(0.9, 1.5), g: 0.8 }); tone(o, { f0: R(80, 100), f1: 50, dur: 0.06, g: 0.3 }); if (Math.random() < 0.3) noiseHit(o, { t0: 0.03, dur: 0.05, type: 'highpass', f: 3000, g: 0.12 }); },
  land() { if (!AC) return; const o = out(0, 0.5); noiseHit(o, { dur: 0.15, f: 500, g: 0.9 }); },
  ammo() { if (!AC) return; const o = out(0, 0.5); for (let i = 0; i < 3; i++) noiseHit(o, { t0: i * R(0.05, 0.09), dur: 0.05, type: 'bandpass', f: R(2600, 3400), q: 3, g: 0.6 }); }
};
function ambient() {
  const s = AC.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
  const g = AC.createGain(); g.gain.value = 0.06;
  const lfo = AC.createOscillator(); lfo.frequency.value = 0.09; const lg = AC.createGain(); lg.gain.value = 0.045; lfo.connect(lg); lg.connect(g.gain); lfo.start();
  s.connect(f); f.connect(g); g.connect(master); s.start();
  const s2 = AC.createBufferSource(); s2.buffer = noiseBuf; s2.loop = true; const f2 = AC.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1800; f2.Q.value = 0.3; const g2 = AC.createGain(); g2.gain.value = 0.008; s2.connect(f2); f2.connect(g2); g2.connect(master); s2.start();
}

// ======================================================= WEAPONS
// Recoil, cadence and reloads vary shot to shot: kick strength, drift, muzzle flip, flash, sound and reload timing all jitter.
// Camera recoil and the viewmodel run on damped springs, so kicks rise and settle smoothly instead of snapping.
const WEAPONS = [
  { name: 'Carbine', mag: 30, reserve: 120, rpm: 720, auto: true, dmg: 26, head: 2.2, hip: 0.032, ads: 0.0035, kickV: 0.0108, kickH: 0.0042, drift: 0.55, first: 1.45, reload: 2.1, reloadEmpty: 2.7, fov: 52, wfov: 40, range: 200, bot: 0.014, vk: { z: 1.0, rx: 2.0, rz: 0.9, x: 0.25 } },
  { name: 'Marksman rifle', mag: 8, reserve: 32, rpm: 150, auto: false, dmg: 55, head: 2.5, hip: 0.07, ads: 0.0, kickV: 0.033, kickH: 0.008, drift: 0.2, first: 1.0, reload: 2.5, reloadEmpty: 3.05, fov: 20, wfov: 30, range: 400, scope: true, bot: 0.006, vk: { z: 1.6, rx: 3.0, rz: 1.2, x: 0.3 } },
  { name: 'Sidearm', mag: 12, reserve: 48, rpm: 420, auto: false, dmg: 30, head: 2.0, hip: 0.022, ads: 0.006, kickV: 0.02, kickH: 0.009, drift: 0.3, first: 1.15, reload: 1.5, reloadEmpty: 1.9, fov: 62, wfov: 46, range: 120, bot: 0.02, vk: { z: 0.8, rx: 3.6, rz: 1.4, x: 0.2 } }
];
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
  brass: std({ color: 0xc8963c, roughness: 0.3, metalness: 1 })
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
  { // Carbine
    const r = new THREE.Group();
    vbox(r, 0.055, 0.075, 0.30, VM.polymer, 0, 0, -0.02);
    vbox(r, 0.05, 0.05, 0.14, VM.polymer, 0, -0.055, -0.06);
    const mag = new THREE.Group(); mag.position.set(0, -0.08, -0.08); r.add(mag); vbox(mag, 0.032, 0.15, 0.075, VM.polymer, 0, -0.07, 0, 0.18);
    vbox(r, 0.035, 0.10, 0.045, VM.polymer, 0, -0.085, 0.08, -0.35);
    vbox(r, 0.05, 0.07, 0.20, VM.fde, 0, -0.015, 0.24); vbox(r, 0.055, 0.10, 0.03, VM.polymer, 0, -0.02, 0.345);
    vbox(r, 0.062, 0.066, 0.30, VM.fde, 0, 0.002, -0.32);
    vbox(r, 0.024, 0.012, 0.58, VM.metal, 0, 0.044, -0.16);
    for (let i = 0; i < 9; i++) vbox(r, 0.028, 0.006, 0.012, VM.metal, 0, 0.052, -0.42 + i * 0.03);
    vcyl(r, 0.012, 0.16, VM.metal, 0, 0, -0.54); vcyl(r, 0.018, 0.055, VM.metal, 0, 0, -0.64, 8);
    vbox(r, 0.026, 0.03, 0.07, VM.polymer, 0.042, -0.005, -0.38); vcyl(r, 0.012, 0.02, VM.lens, 0.042, -0.005, -0.42);
    vbox(r, 0.04, 0.018, 0.07, VM.metal, 0, 0.06, -0.04);
    vbox(r, 0.004, 0.042, 0.06, VM.polymer, 0.021, 0.09, -0.04); vbox(r, 0.004, 0.042, 0.06, VM.polymer, -0.021, 0.09, -0.04); vbox(r, 0.046, 0.005, 0.06, VM.polymer, 0, 0.112, -0.04);
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.038, 0.04), VM.lens); gl.position.set(0, 0.09, -0.06); r.add(gl);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 8, 6), VM.dot); dot.position.set(0, 0.09, -0.07); r.add(dot);
    const ch = new THREE.Group(); ch.position.set(0, 0.04, 0.12); r.add(ch); vbox(ch, 0.05, 0.012, 0.025, VM.metal, 0, 0, 0);
    vbox(r, 0.05, 0.075, 0.09, VM.glove, 0.008, -0.10, 0.075, -0.3); limb(r, new V3(0.02, -0.13, 0.11), new V3(0.17, -0.32, 0.34), 0.038, VM.sleeve);
    const sh = supportHand(r, new V3(-0.008, -0.048, -0.36), new V3(-0.22, -0.34, -0.04), [0.07, 0.05, 0.11]);
    vms.push({ root: r, mag, ch, ...sh, magBase: mag.position.clone(), chPull: 0.075, muzzle: new V3(0, 0, -0.67), hip: new V3(0.15, -0.19, -0.40), ads: new V3(0, -0.09, -0.27), eject: new V3(0.03, 0.01, -0.03) });
  }
  { // Marksman
    const r = new THREE.Group();
    vbox(r, 0.056, 0.078, 0.34, VM.metal, 0, 0, -0.02);
    const mag = new THREE.Group(); mag.position.set(0, -0.06, -0.08); r.add(mag); vbox(mag, 0.034, 0.09, 0.08, VM.polymer, 0, -0.04, 0, 0.1);
    vbox(r, 0.035, 0.10, 0.045, VM.polymer, 0, -0.085, 0.09, -0.35);
    vbox(r, 0.05, 0.085, 0.24, VM.polymer, 0, -0.02, 0.26); vbox(r, 0.04, 0.03, 0.12, VM.polymer, 0, 0.04, 0.24);
    vbox(r, 0.064, 0.066, 0.42, VM.polymer, 0, 0.0, -0.38);
    vcyl(r, 0.013, 0.26, VM.metal, 0, 0, -0.71); vcyl(r, 0.02, 0.07, VM.metal, 0, 0, -0.86, 8);
    vcyl(r, 0.02, 0.28, VM.metal, 0, 0.085, -0.06); vcyl(r, 0.029, 0.07, VM.metal, 0, 0.085, -0.22); vcyl(r, 0.025, 0.06, VM.metal, 0, 0.085, 0.1);
    vcyl(r, 0.026, 0.002, VM.lens, 0, 0.085, -0.256); vbox(r, 0.012, 0.03, 0.03, VM.metal, 0, 0.115, -0.05);
    for (const z of [-0.12, 0.02]) vbox(r, 0.03, 0.04, 0.025, VM.metal, 0, 0.055, z);
    const ch = new THREE.Group(); ch.position.set(0.034, 0.015, 0.0); r.add(ch); vbox(ch, 0.02, 0.014, 0.03, VM.metal, 0, 0, 0);
    vbox(r, 0.05, 0.075, 0.09, VM.glove, 0.008, -0.10, 0.085, -0.3); limb(r, new V3(0.02, -0.13, 0.12), new V3(0.17, -0.32, 0.35), 0.038, VM.sleeve);
    const sh = supportHand(r, new V3(-0.008, -0.05, -0.42), new V3(-0.22, -0.34, -0.06), [0.07, 0.05, 0.11]);
    vms.push({ root: r, mag, ch, ...sh, magBase: mag.position.clone(), chPull: 0.06, muzzle: new V3(0, 0, -0.9), hip: new V3(0.15, -0.19, -0.38), ads: new V3(0, -0.085, -0.2), eject: new V3(0.03, 0.01, -0.02) });
  }
  { // Sidearm
    const r = new THREE.Group();
    const slide = new THREE.Group(); r.add(slide); vbox(slide, 0.03, 0.035, 0.19, VM.metal, 0, 0.02, -0.08);
    vbox(slide, 0.006, 0.01, 0.008, VM.polymer, 0.008, 0.042, 0.005); vbox(slide, 0.006, 0.01, 0.008, VM.polymer, -0.008, 0.042, 0.005); vbox(slide, 0.004, 0.01, 0.004, VM.polymer, 0, 0.042, -0.165);
    vbox(r, 0.028, 0.025, 0.16, VM.polymer, 0, -0.005, -0.07);
    vbox(r, 0.03, 0.10, 0.05, VM.polymer, 0, -0.06, 0.0, -0.25);
    const mag = new THREE.Group(); mag.position.set(0, -0.1, 0.01); r.add(mag); vbox(mag, 0.032, 0.02, 0.055, VM.polymer, 0, -0.01, 0);
    vbox(r, 0.05, 0.07, 0.07, VM.glove, 0.006, -0.065, 0.02);
    limb(r, new V3(0.01, -0.09, 0.05), new V3(0.15, -0.3, 0.32), 0.036, VM.sleeve);
    const sh = supportHand(r, new V3(-0.03, -0.075, 0.015), new V3(-0.2, -0.3, 0.3), [0.04, 0.065, 0.075]);
    vms.push({ root: r, mag, slide, ...sh, magBase: mag.position.clone(), muzzle: new V3(0, 0.02, -0.18), hip: new V3(0.09, -0.12, -0.34), ads: new V3(0, -0.047, -0.3), eject: new V3(0.02, 0.03, -0.06), pistol: true });
  }
  for (const vm of vms) {
    vm.root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    vm.root.visible = false; wCam.add(vm.root);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.flash, color: new THREE.Color(4, 3, 2), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    fl.position.copy(vm.muzzle); fl.visible = false; vm.root.add(fl); vm.flash = fl;
    const fl2 = fl.clone(); fl2.rotation.y = Math.PI / 2; fl.add(fl2);
    // a spare magazine that falls away on empty reloads
    vm.dropMag = vm.mag.clone(); vm.dropMag.visible = false; wCam.add(vm.dropMag); vm.dropV = new V3(); vm.dropT = 0;
  }
  return vms;
}
const viewmodels = buildViewmodels();
// shell casings
const casings = [];
const casingGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.022, 8).rotateZ(Math.PI / 2);
for (let i = 0; i < 12; i++) { const m = new THREE.Mesh(casingGeo, VM.brass); m.visible = false; m.frustumCulled = false; wCam.add(m); casings.push({ m, v: new V3(), t: 0, spin: new V3() }); }
let casingIdx = 0;

// ======================================================= PLAYER
const P = {
  pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, onGround: true, crouch: 0, crouching: false, alive: true, hp: 100,
  weapon: 0, prevWeapon: 1, ammo: WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserve })), fireCD: 0, reloadT: 0, switchT: 0, rl: null,
  ads: 0, adsHeld: false, kick: 0, bobPhase: 0, bobAmt: 0, sprint: 0, swayX: 0, swayY: 0, fallV: 0, stepAcc: 0, lastShot: 0,
  recP: new Spring(140, 0.85), recY: new Spring(120, 0.9), climb: 0, drift: 0, driftBias: 0, tracerN: 2, slideKick: 0,
  shots: 0, hits: 0, deadT: 0, killer: null, rope: null, team: -1, minVy: 0
};
const keys = {};
let mouseDown = false, locked = false, wantLock = false, gameState = 'menu'; // menu | play
const eye = () => new V3(P.pos.x, P.pos.y + 1.62 - 0.55 * P.crouch, P.pos.z);
const aimPitch = () => P.pitch + P.recP.x, aimYaw = () => P.yaw + P.recY.x;

function respawnLocal(s) {
  const sp = SPAWNS[s] || SPAWNS[0];
  P.pos.set(sp[0], 0, sp[1]); P.vel.set(0, 0, 0);
  P.yaw = Math.atan2(sp[0], sp[1] - 7); // face toward map centre
  P.pitch = 0; P.alive = true; P.hp = 100; P.crouching = false; P.crouch = 0; P.reloadT = 0; P.switchT = 0; P.rope = null; P.climb = 0;
  P.recP.x = P.recP.v = P.recY.x = P.recY.v = 0;
  P.ammo = WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserve }));
  setWeapon(0, true); hideBanner();
}

function setWeapon(i, instant = false) {
  if (i === P.weapon && !instant) return;
  if (i !== P.weapon) P.prevWeapon = P.weapon;
  P.weapon = i; P.reloadT = 0; P.rl = null; P.switchT = instant ? 0 : 0.35;
  viewmodels.forEach((v, k) => { v.root.visible = k === i && !P.rope; v.mag.visible = true; v.mag.position.copy(v.magBase); });
  if (!instant) SFX.mech('pouch');
  updateSlotsHUD();
}

function startReload() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  if (P.reloadT > 0 || a.mag >= w.mag || a.reserve <= 0 || P.switchT > 0 || P.rope) return;
  const empty = a.mag === 0, j = () => R(-0.025, 0.025);
  const dur = (empty ? w.reloadEmpty : w.reload) * R(0.93, 1.07);
  P.rl = { dur, empty, bolt: Math.random() < 0.5, k: { out: 0.2 + j(), pouch: 0.36 + j(), back: 0.52 + j(), seat: 0.63 + j(), slap: 0.68 + j(), ch: 0.76 + j(), chEnd: 0.84 + j() },
    done: {}, tilt: R(0.42, 0.64), dip: R(0.03, 0.06), roll: R(-0.12, 0.12), lift: R(-0.02, 0.02) };
  if (!empty) { P.rl.k.slap = Math.min(0.8, P.rl.k.slap + 0.04); }
  P.reloadT = dur; P.driftBias = R(-0.35, 0.35);
}
function finishReload() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  const need = w.mag - a.mag, take = Math.min(need, a.reserve); a.mag += take; a.reserve -= take; P.rl = null;
}

const raycaster = new THREE.Raycaster();
function fire() {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  if (a.mag <= 0) { SFX.click(); P.fireCD = 0.25; startReload(); return; }
  const now = performance.now(), first = now - P.lastShot > 280;
  a.mag--; P.shots++; P.fireCD = (P.fireCD < -0.04 ? 0 : P.fireCD) + 60 / w.rpm * R(0.97, 1.035); P.lastShot = now;
  const speed = Math.hypot(P.vel.x, P.vel.z);
  let spread = lerp(w.hip, w.ads, P.ads) * (1 + speed * 0.25) * (P.onGround ? 1 : 3) * (P.crouch > 0.5 ? 0.75 : 1);
  if (w.scope && P.ads < 0.9) spread = w.hip * (1 + speed * 0.25);
  spread += P.kick * 0.02;
  const o = eye();
  const dir = new V3(0, 0, -1).applyEuler(new THREE.Euler(aimPitch(), aimYaw(), 0, 'YXZ'));
  const rr = Math.sqrt(Math.random()) * spread, ra = Math.random() * Math.PI * 2;
  const right = new V3(Math.cos(P.yaw), 0, -Math.sin(P.yaw)), up = new V3().crossVectors(right, dir);
  dir.addScaledVector(right, Math.cos(ra) * rr).addScaledVector(up, Math.sin(ra) * rr).normalize();

  const hw = rayWorld(o, dir, w.range);
  let far = hw ? hw.t : w.range, hitP = null, endP;
  raycaster.set(o, dir); raycaster.far = far;
  const cands = [];
  for (const rp of remotes.values()) if (rp.alive) cands.push(...rp.op.hit);
  for (const t of targets) if (t.up && t.pivot.visible) cands.push(...t.hit);
  const hits = raycaster.intersectObjects(cands, false);
  if (hits.length) {
    const h = hits[0]; hitP = h.point; endP = h.point.clone();
    const part = h.object.userData.part; const head = part === 'head';
    const dmg = Math.round(w.dmg * (head ? w.head : part === 'leg' ? 0.8 : 1) * R(0.95, 1.05));
    let owner = h.object.userData.owner;
    if (!owner) { let p = h.object; while (p && !p.userData.owner) p = p.parent; owner = p && p.userData.owner; }
    if (owner && owner.kind === 'target') { bloodPuff(h.point, dir.clone().negate()); hitTarget(owner, head); showHit(head ? 'head' : 'hit'); }
    else if (owner && !isFriend(owner.id)) { bloodPuff(h.point, dir.clone().negate()); netSend({ t: 'hit', target: owner.id, dmg, head, w: P.weapon }); showHit(head ? 'head' : 'hit'); P.hits++; }
  } else if (hw) {
    endP = o.clone().addScaledVector(dir, hw.t);
    impact(endP, hw.n, hw.water);
  } else endP = o.clone().addScaledVector(dir, w.range);

  // visuals: every shot a little different
  const vm = viewmodels[P.weapon];
  vm.flash.visible = true; vm.flash.rotation.z = Math.random() * 6; const fs = (P.weapon === 2 ? 0.09 : 0.14) * R(0.75, 1.3); vm.flash.scale.set(fs, fs * R(0.85, 1.15), fs); vm._flashT = R(0.03, 0.055);
  wFlash.position.copy(vm.muzzle).applyMatrix4(vm.root.matrix); wFlash.intensity = R(2.2, 3.8);
  worldFlash(o.clone().addScaledVector(dir, 0.8), R(30, 50));
  const muzzleWorld = o.clone().addScaledVector(dir, 0.7).addScaledVector(right, P.ads > 0.5 ? 0 : 0.12).add(new V3(0, -0.08, 0));
  if (--P.tracerN <= 0 || P.weapon === 1) { tracer(muzzleWorld, endP); P.tracerN = 2 + (Math.random() < 0.4 ? 1 : 0); }
  if (Math.random() < 0.8) { smoke.spawn(muzzleWorld, dir.clone().multiplyScalar(R(0.3, 0.9)).add(new V3(R(-0.1, 0.1), R(0.15, 0.4), 0)), R(0.45, 0.8), R(0.04, 0.08), new THREE.Color(0x8a8580), -0.3, false, 2); smoke.p[smoke.p.length - 1].grow = true; }
  const c = casings[casingIdx++ % casings.length]; c.m.visible = true; c.m.position.copy(vm.eject).applyMatrix4(vm.root.matrix); c.v.set(R(0.7, 1.6), R(0.7, 1.5), R(-0.25, 0.3)); c.t = 0.7; c.spin.set(R(8, 34), R(8, 34), R(-5, 5));
  if (Math.random() < 0.75) setTimeout(() => SFX.tinkle(), R(420, 820));
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
  SFX.shot(P.weapon, null, { indoor: indoorAt(P.pos) });
  netSend({ t: 'shot', o: [muzzleWorld.x, muzzleWorld.y, muzzleWorld.z], e: [endP.x, endP.y, endP.z], w: P.weapon, n: hw && !hitP ? hw.n : null, wt: !!(hw && hw.water && !hitP) });
  noiseForBots(P.pos, myId);
}
const indoorAt = p => ceilingAt(p.x, p.z, 0.1, p.y + 1.9) < 50;

function updatePlayer(dt) {
  if (!P.alive) return;
  const w = WEAPONS[P.weapon];
  if (P.rope) { updateRopeRider(dt); return; }
  // input direction
  let fx = 0, fz = 0;
  if (keys.KeyW) fz -= 1; if (keys.KeyS) fz += 1; if (keys.KeyA) fx -= 1; if (keys.KeyD) fx += 1;
  const len = Math.hypot(fx, fz); if (len) { fx /= len; fz /= len; }
  const sprinting = keys.ShiftLeft && fz < 0 && !P.crouching && P.ads < 0.3 && P.reloadT <= 0;
  P.sprint = lerp(P.sprint, sprinting ? 1 : 0, Math.min(1, dt * 8));
  const speed = (P.crouching ? 2.3 : sprinting ? 6.8 : 4.4) * (P.adsHeld ? 0.6 : 1);
  const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  const wx = (fx * cy + fz * sy) * speed, wz = (-fx * sy + fz * cy) * speed;
  const acc = P.onGround ? 11 : 2.5;
  P.vel.x = lerp(P.vel.x, wx, Math.min(1, acc * dt)); P.vel.z = lerp(P.vel.z, wz, Math.min(1, acc * dt));
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
  P.pos.x = clamp(P.pos.x, MAP.x0 + 0.4, MAP.x1 - 0.4); P.pos.z = clamp(P.pos.z, MAP.z0 + 0.2, MAP.z1 - 0.4);

  // crouch (stand only if room)
  let target = P.crouching ? 1 : 0;
  if (!P.crouching && P.crouch > 0.01 && ceilingAt(P.pos.x, P.pos.z, 0.36, P.pos.y + 1.25) < P.pos.y + 1.85) target = 1;
  P.crouch = lerp(P.crouch, target, Math.min(1, dt * 10));

  // bob + footsteps
  const hs = Math.hypot(P.vel.x, P.vel.z);
  P.bobAmt = lerp(P.bobAmt, P.onGround ? Math.min(1, hs / 4.4) : 0, Math.min(1, dt * 8));
  P.bobPhase += hs * dt * 1.9;
  P.stepAcc += hs * dt; if (P.onGround && P.stepAcc > (sprinting ? 2.1 : 1.6) * R(0.92, 1.08)) { P.stepAcc = 0; if (!P.crouching) SFX.step(null, sprinting ? 1.2 : 0.8); }

  // aim
  P.ads = lerp(P.ads, P.adsHeld && !sprinting && P.reloadT <= 0 && P.switchT <= 0 ? 1 : 0, Math.min(1, dt * (w.scope ? 9 : 12)));
  // timers
  P.fireCD -= dt;
  if (P.switchT > 0) P.switchT -= dt;
  if (P.reloadT > 0) { P.reloadT -= dt; reloadEvents(); if (P.reloadT <= 0) finishReload(); }
  if (mouseDown && P.fireCD <= 0 && P.reloadT <= 0 && P.switchT <= 0 && P.sprint < 0.4) {
    fire(); if (!w.auto) mouseDown = false;
  }
  if (P.ammo[P.weapon].mag === 0 && P.reloadT <= 0 && P.fireCD <= -0.1 && !mouseDown) startReload();
  // recoil: springs settle, part of the climb stays (pull down to compensate)
  P.recP.step(dt); P.recY.step(dt);
  const cl = P.climb * Math.min(1, dt * 16); P.pitch += cl; P.climb -= cl;
  P.kick = Math.max(0, P.kick - dt * 6);
  P.pitch = clamp(P.pitch, -1.5, 1.5);

  // ammo crates
  for (const c of ammoCrates) {
    c.cool -= dt;
    if (c.cool <= 0 && Math.abs(P.pos.y - c.pos.y) < 1.5 && Math.hypot(P.pos.x - c.pos.x, P.pos.z - c.pos.z) < 1.6) {
      const needs = P.ammo.some((a, i) => a.reserve < WEAPONS[i].reserve);
      if (needs) { P.ammo.forEach((a, i) => a.reserve = WEAPONS[i].reserve); c.cool = 15; SFX.ammo(); showPrompt('Ammo restocked'); }
    }
  }
  ropeGrabCheck();
}
function reloadEvents() { // sounds and the falling magazine, at jittered moments of the reload
  const rl = P.rl; if (!rl) return;
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
function reloadPose(vm, k, out) { // gun tilt, support hand path, mag and charging-handle positions
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
  const w = WEAPONS[P.weapon];
  if (!P.alive) {
    P.deadT += dt; const k = Math.min(1, P.deadT / 1.2);
    const base = eye(); base.y = lerp(P.pos.y + 1.6, P.pos.y + 4.5, k);
    camera.position.copy(base);
    if (P.killer) { const kp = P.killer.clone(); kp.y += 1.2; const d = kp.sub(base); const ty = Math.atan2(-d.x, -d.z), tp = Math.atan2(d.y, Math.hypot(d.x, d.z)); P.yaw += angDiff(P.yaw, ty) * Math.min(1, dt * 3); P.pitch = lerp(P.pitch, tp, Math.min(1, dt * 3)); }
    camera.rotation.set(P.pitch, P.yaw, 0.15 * k);
    camera.fov = lerp(camera.fov, 70, dt * 4); camera.updateProjectionMatrix();
    return;
  }
  const e = eye();
  const bob = P.bobAmt * (1 - P.ads * 0.8);
  e.y += Math.abs(Math.sin(P.bobPhase)) * 0.045 * bob - 0.02 * bob;
  e.x += Math.cos(P.bobPhase) * 0.02 * bob * Math.cos(P.yaw); e.z -= Math.cos(P.bobPhase) * 0.02 * bob * Math.sin(P.yaw);
  camera.position.copy(e);
  for (const s of Object.values(VMS)) s.step(dt);
  camera.rotation.set(aimPitch(), aimYaw(), Math.cos(P.bobPhase) * 0.004 * bob + VMS.rz.x * 0.04 + (P.rope ? Math.sin(t * 1.3) * 0.03 : 0));
  const fovT = lerp(lerp(75, 82, P.sprint), w.fov, P.ads);
  if (Math.abs(camera.fov - fovT) > 0.01) { camera.fov = fovT; camera.updateProjectionMatrix(); }

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
  else { vm.lh.position.copy(vm.lhBase); vm.mag.visible = true; vm.mag.position.copy(vm.magBase); if (vm.ch) vm.ch.position.z = vm.chBase; }
  pos.x += o.x; pos.y += o.y;
  if (P.switchT > 0) pos.y -= (P.switchT / 0.35) * 0.3;
  vm.root.position.copy(pos); vm.root.rotation.set(o.rx, o.ry, o.rz);
  sleeveTo(vm.sleeve, vm.lh.position, vm.anchor);
  if (vm.slide) { P.slideKick = Math.max(0, P.slideKick - dt * 28); const locked = P.ammo[2].mag === 0 && !(P.rl && P.rl.slideFree); vm.slide.position.z = locked ? 0.03 : 0.026 * Math.sin(Math.min(1, P.slideKick) * Math.PI * 0.5); }
  vm.root.visible = !(w.scope && P.ads > 0.82) && !P.rope;
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
function bandColorFor(info) { return info.team >= 0 ? TEAM_COLORS[info.team] : info.bot ? 0x6b6a5c : SLOT_COLORS[info.slot] || 0x888888; }
class Remote {
  constructor(info) {
    this.id = info.id; this.kind = 'player'; this.bot = !!info.bot; this.look = info.look; this.team = info.team;
    this.op = makeOperator(info.look, bandColorFor(info)); this.op.g.userData.owner = this; this.op.hit.forEach(m => m.userData.owner = this);
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
    if (dt > 0) this.vel.lerp(new V3((this.pos.x - this.lastPos.x) / dt, 0, (this.pos.z - this.lastPos.z) / dt), Math.min(1, dt * 10));
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const vf = -(this.vel.x * sy + this.vel.z * cy), vs = this.vel.x * cy - this.vel.z * sy;
    const reloading = this.flags & 1, rope = this.flags & 2, sprint = this.flags & 4, aimed = this.flags & 8;
    const wantAim = sprint ? 0 : this.bot ? (aimed ? 1 : 0.35) : 1;
    this.aimS = lerp(this.aimS, wantAim, Math.min(1, dt * 6));
    if (reloading && this.reloadStart < 0) this.reloadStart = performance.now();
    if (!reloading) this.reloadStart = -1;
    const rk = this.reloadStart >= 0 ? clamp((performance.now() - this.reloadStart) / 1000 / (WEAPONS[this.w] || WEAPONS[0]).reload, 0, 1) : -1;
    op.g.visible = true; op.g.position.copy(this.pos); op.g.rotation.set(0, this.yaw + Math.PI, 0);
    poseOperator(op, { vf, vs, crouch: this.crouch, pitch: this.pitch, aim: this.aimS, reload: rk, rope, w: this.w, dt });
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.stepAcc += sp * dt; if (this.stepAcc > 1.7 && this.crouch < 0.5 && sp > 2.5 && !rope) { this.stepAcc = 0; SFX.step(this.pos, sp > 5.5 ? 1.4 : 1); }
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
  localMe = localMatch.join(settings.name || 'Operator', m => { const c = clone(m); setTimeout(() => onNet(c), 0); }, true, hostCfg);
}
function connect() {
  return new Promise(resolve => {
    const p2p = P2P.status();
    if (location.protocol === 'file:' && !p2p) return resolve(false);
    if (webMode && !p2p) return resolve(false);
    let done = false;
    try { ws = p2p ? P2P.openSocket() : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { return resolve(false); }
    const giveUp = () => { if (!done) { done = true; try { ws.close(); } catch (e) { } ws = null; resolve(false); } };
    let to = setTimeout(giveUp, /^(localhost|127\.)/.test(location.hostname) ? 5000 : 12000);
    ws.onopen = () => { clearTimeout(to); to = setTimeout(giveUp, 20000); ws.send(JSON.stringify({ t: 'hello', name: settings.name || 'Operator', cfg: hostCfg })); };
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
function colorOf(id) { const p = playerInfo.get(id); return p ? (p.team >= 0 ? TEAM_CSS[p.team] : p.bot ? '#d8d2c4' : SLOT_CSS[p.slot]) : '#fff'; }
function applyScores(list) { for (const s of list) { const p = playerInfo.get(s.id); if (p) Object.assign(p, s); else playerInfo.set(s.id, { ...s }); } renderScore(); }

// ---- bots: simulated by one browser (the host's when connected), seen by everyone else like players
const bots = new Map();
const botCtx = {
  weapons: WEAPONS, nav: null, bots: [], now: () => performance.now() / 1000,
  los: (a, b) => !losBlocked(a, b), collide: collideCircle, groundAt,
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
      const dmg = Math.round(W.dmg * (hc.part === 'head' ? W.head : hc.part === 'leg' ? 0.8 : 1) * R(0.92, 1.05));
      netSend({ t: 'hit', as: b.id, target: hc.c.id, dmg, head: hc.part === 'head', w: ev.w });
      if (hc.c.id !== myId) bloodPuff(endP, ev.dir.clone().negate());
    }
  } else if (hw) { endP = ev.o.clone().addScaledVector(ev.dir, hw.t); impact(endP, hw.n, hw.water); }
  else endP = ev.o.clone().addScaledVector(ev.dir, W.range);
  const mz = r ? r.muzzle() : ev.o;
  if (r) r.op.recoil = 1;
  if (Math.random() < 0.45 || ev.w === 1) tracer(mz, endP);
  worldFlash(mz, 40); SFX.shot(ev.w, mz, { supp: !!(r && lookFor(r.look).gun.supp && ev.w !== 2), indoor: indoorAt(b.pos) });
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
    if (r && r.look !== p.look) { r.dispose(); remotes.delete(p.id); r = null; }
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
  renderScore(); updateHostUI();
}
function onNet(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.you; isHost = !!m.host; matchOver = m.over;
      applyRoster(m); if (m.rope) startRopeHeli(m.rope);
      break;
    case 'roster': applyRoster(m); if (m.joined) { const p = playerInfo.get(m.joined); if (p) feed(`<b style="color:${colorOf(p.id)}">${esc(p.name)}</b> joined`); } break;
    case 'leave': { const r = remotes.get(m.id); feed(`${esc(nameOf(m.id))} left`); if (r) r.dispose(); remotes.delete(m.id); playerInfo.delete(m.id); bots.delete(m.id); renderScore(); break; }
    case 'gone':
      if (m.id === myId) { P.alive = false; P.deadT = 0; P.killer = null; P.rope = null; viewmodels.forEach(v => v.root.visible = false); showBanner('Switching teams', 'Respawning', 1500); }
      else { const r = remotes.get(m.id); if (r) r.hide(); const b = bots.get(m.id); if (b) b.alive = false; }
      break;
    case 'spawn': {
      if (m.id === myId) respawnLocal(m.s); else { const r = remotes.get(m.id); if (r) r.respawn(m.s); }
      const b = bots.get(m.id); if (b) b.spawn(SPAWNS[m.s][0], SPAWNS[m.s][1]);
      const p = playerInfo.get(m.id); if (p) { p.alive = true; p.hp = 100; } break;
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
      if (m.killer) feed(`<b style="color:${colorOf(m.killer)}">${esc(kn)}</b> <span>${WEAPONS[m.w] ? WEAPONS[m.w].name.toLowerCase() : ''}${m.head ? ' · headshot' : ''}</span> <b style="color:${colorOf(m.victim)}">${esc(vn)}</b>`);
      else feed(`<b style="color:${colorOf(m.victim)}">${esc(vn)}</b> <span>fell</span>`);
      const b = bots.get(m.victim); if (b) b.alive = false;
      if (m.victim === myId) { const r = remotes.get(m.killer); dieLocal(r ? r.pos.clone() : null, m.killer ? kn : 'a fall', m.head); }
      else { const r = remotes.get(m.victim); if (r) r.die(m.killer === myId ? P.pos : (remotes.get(m.killer) || {}).pos); }
      if (m.killer === myId) { SFX.kill(); showHit('kill'); showBanner(m.head ? 'Headshot' : 'Eliminated', vn, 1600); }
      break;
    }
    case 'end': {
      applyScores(m.scores); if (m.teams) teamKills = m.teams; matchOver = true;
      const team = m.team >= 0;
      const win = team ? m.team === P.team : m.winner === myId;
      showBanner(win ? 'Victory' : team ? `Team ${TEAM_NAMES[m.team]} wins` : `${nameOf(m.winner)} wins`, 'New match starts in 10 seconds', 10000);
      showBoard(true); break;
    }
    case 'start': if (m.cfg) cfg = m.cfg; if (m.target) killTarget = m.target; teamKills = m.teams || [0, 0]; applyScores(m.scores); matchOver = false; $('board').hidden = true;
      showBanner('New match', cfg.mode === 'team' ? `Teams · first team to ${killTarget} kills` : `First to ${killTarget} kills`, 2500); break;
    case 'rope': startRopeHeli(m); break;
    case 'pong': pingMs = Math.round(performance.now() - m.ts); break;
  }
}
function dieLocal(killerPos, killerName, head) {
  P.alive = false; P.deadT = 0; P.killer = killerPos; P.adsHeld = false; mouseDown = false; P.rope = null;
  viewmodels.forEach(v => v.root.visible = false);
  showBanner('Killed', `by ${killerName}${head ? ' · headshot' : ''} · respawning`, 3000);
}
function sendState(dt) {
  sendAcc += dt; if (sendAcc < 0.05) return; sendAcc = 0;
  if (!P.alive) return;
  const f = (P.reloadT > 0 ? 1 : 0) | (P.rope ? 2 : 0) | (P.sprint > 0.5 ? 4 : 0) | (P.ads > 0.5 ? 8 : 0);
  netSend({ t: 'state', p: [+P.pos.x.toFixed(3), +P.pos.y.toFixed(3), +P.pos.z.toFixed(3)], y: +P.yaw.toFixed(3), pi: +P.pitch.toFixed(3), c: +P.crouch.toFixed(2), w: P.weapon, f });
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
function hurt(fromPos, dmg) {
  dmgFlash = Math.min(1, dmgFlash + dmg / 40); SFX.hurt();
  if (fromPos) {
    const d = fromPos.clone().sub(P.pos); const ang = Math.atan2(-d.x, -d.z) - P.yaw;
    const i = document.createElement('i'); i.style.transform = `rotate(${-ang}rad)`; $('dmg').append(i); setTimeout(() => i.remove(), 1250);
  }
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
function showBoard(final = false) {
  const b = $('board');
  if (!online) { b.innerHTML = `<h2>Practice range</h2><p>Hits: ${practiceHits}.</p>`; b.hidden = false; return; }
  const row = p => `<tr><td><i style="background:${colorOf(p.id)}"></i>${esc(p.id === myId ? (settings.name || 'You') + ' (you)' : p.name)}${p.bot ? ' <span style="color:var(--dim);font-size:11px">BOT</span>' : ''}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${(p.kills / Math.max(1, p.deaths)).toFixed(2)}</td></tr>`;
  const sort = l => l.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const head = `<thead><tr><th>Operator</th><th>Kills</th><th>Deaths</th><th>K/D</th></tr></thead>`;
  let body;
  if (cfg.mode === 'team') body = [0, 1].map(t => `<tr><td colspan="4" style="color:${TEAM_CSS[t]};font:800 18px var(--display);text-transform:uppercase;padding-top:12px">${TEAM_NAMES[t]} · ${teamKills[t] || 0}</td></tr>` + sort([...playerInfo.values()].filter(p => p.team === t)).map(row).join('')).join('');
  else body = sort([...playerInfo.values()]).map(row).join('');
  b.innerHTML = `<h2>${final ? 'Match over' : 'Scoreboard'}</h2><table>${head}<tbody>${body}</tbody></table><p>${cfg.mode === 'team' ? 'Teams' : 'Free for all'} · first to ${killTarget} kills · ${netMode === 'local' ? 'offline practice' : 'ping ' + pingMs + ' ms'} · accuracy ${P.shots ? Math.round(P.hits / P.shots * 100) : 0}%</p>`;
  b.hidden = false;
}
function hideBoard() { if (!matchOver) $('board').hidden = true; }
function updateSlotsHUD() { $('slots').innerHTML = WEAPONS.map((w, i) => `<span class="${i === P.weapon ? 'on' : ''}">${i + 1} ${w.name.split(' ')[0]}</span>`).join(''); }
let lastHud = '';
function updateHUD(dt) {
  const w = WEAPONS[P.weapon], a = P.ammo[P.weapon];
  const s = `${a.mag}|${a.reserve}|${P.hp}|${P.weapon}|${P.reloadT > 0}`;
  if (s !== lastHud) {
    lastHud = s;
    $('ammo').innerHTML = `${a.mag}<small> / ${a.reserve}</small>`;
    $('wname').textContent = P.reloadT > 0 ? 'Reloading…' : w.name;
    $('hpnum').textContent = Math.max(0, Math.round(P.hp));
    $('hpbar').firstElementChild.style.width = clamp(P.hp, 0, 100) + '%';
    $('hpbar').classList.toggle('low', P.hp < 35);
  }
  // crosshair spread
  const speed = Math.hypot(P.vel.x, P.vel.z);
  const gap = 5 + (lerp(w.hip, w.ads, P.ads) * (1 + speed * 0.25) * (P.onGround ? 1 : 3) + P.kick * 0.02) * 260;
  const cr = $('cross').children; cr[0].style.left = (-gap - 9) + 'px'; cr[1].style.left = gap + 'px'; cr[2].style.top = (-gap - 9) + 'px'; cr[3].style.top = gap + 'px';
  $('cross').style.opacity = P.alive && !P.rope ? (w.scope ? 1 - P.ads : 1 - P.ads * 0.9) * (1 - P.sprint) : 0;
  $('scope').style.opacity = w.scope && P.alive ? clamp((P.ads - 0.75) * 5, 0, 1) : 0;
  if (hitT > 0) { hitT -= dt; if (hitT <= 0) $('hit').style.opacity = 0; }
  dmgFlash = Math.max(0, dmgFlash - dt * 0.9);
  grade.uniforms.dmg.value = Math.max(dmgFlash, P.alive ? clamp((40 - P.hp) / 40, 0, 1) * 0.6 : 0.8);
  { const key = `${perf.fps}|${online}|${pingMs}`; if (perf.shown !== key) { perf.shown = key; $('net').textContent = (netMode === 'local' ? 'Offline practice' : online ? `${viaTunnelHost() ? 'Online' : 'Wi-Fi'} · ${pingMs} ms` : 'Practice range') + (perf.fps ? ` · ${perf.fps} fps` : ''); } }
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
  draw(g, len); g.restore();
}
function drawFlag(g, w) { // flag with top-left at (-w/2,-h/2), canton toward the nose
  const h = w * 2 / 3, blue = '#0d5eaf', s = h / 9; g.translate(-w / 2, -h / 2);
  for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? '#f4f4f0' : blue; g.fillRect(0, i * s, w, s + 0.5); }
  const k = s * 5; g.fillStyle = blue; g.fillRect(0, 0, k, k); g.fillStyle = '#f4f4f0'; g.fillRect(k * 2 / 5, 0, k / 5, k); g.fillRect(0, k * 2 / 5, k, k / 5);
}
function drawRoundel(g, d) { for (const [r, c] of [[.5, '#0d5eaf'], [.34, '#f4f4f0'], [.17, '#0d5eaf']]) { g.fillStyle = c; g.beginPath(); g.arc(0, 0, d * r, 0, 7); g.fill(); } }
function drawText(g, txt, size, color = 'rgba(20,20,20,.8)') { g.fillStyle = color; g.font = `600 ${size}px "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, 0, 0); }

const AIRM = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1418, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.2 }),
  goldGlass: new THREE.MeshPhysicalMaterial({ color: 0x6b5a2c, roughness: 0.05, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.4 }),
  gunmetal: std({ color: 0x2b2d2e, roughness: 0.4, metalness: 0.8 }),
  black: std({ color: 0x141515, roughness: 0.6, metalness: 0.3 }),
  rubber: std({ color: 0x151515, roughness: 0.9 }),
  exhaust: std({ color: 0x1a1612, roughness: 0.8, metalness: 0.4 }),
  nozzleIn: new THREE.MeshStandardMaterial({ color: 0x0b0b0b, emissive: 0xff7a2a, emissiveIntensity: 0.6, roughness: 0.6, side: THREE.DoubleSide }),
  navR: new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 0.3, 0.2) }),
  navG: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 10, 0.6) }),
  strobe: new THREE.MeshBasicMaterial({ color: new THREE.Color(12, 12, 12) }),
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
        g.save(); g.translate(u * W, (1 - 0.82) * H); g.transform(0, 1, side > 0 ? -1 : 1, 0, 0, 0);
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
  gunTurret(g, 0, F + 0.1, L * 0.3, 0.85);
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
  return { g, radar, L, B, speed: R(15, 20), bowSpray: true, sound: 'fac' };
}
function makeCorvette() { // ~84 m missile corvette
  const L = 84, B = 11.5, F = 3.4, D = 6.6;
  const skin = navySkin('P 75');
  const g = new THREE.Group();
  am(g, loft(hullKeys(L, B, F, D), 56, 120), hullMaterial(skin.map, skin.bump));
  am(g, new THREE.BoxGeometry(B * 0.9, 0.06, L * 0.66), NAVY.deck, 0, F + 0.1, -L * 0.05);
  gunTurret(g, 0, F + 0.15, L * 0.31, 1.05);
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
  return { g, radar, L, B, speed: R(8, 11), bowSpray: false, sound: 'corvette' };
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
  for (const [kind, n] of [['heli', 1], ['jet', 2], ['fac', 1], ['corvette', 1], ['utility', 1]])
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
  const lane = kind === 'corvette' ? R(-210, -160) : R(-120, -80);
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
    const b = boats[i]; b.t += dt; const k = b.t / b.dur;
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
    const f = flybys[i]; f.t += dt; const k = f.t / f.dur;
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
const ropeHeli = { active: false, m: null, t: 0, n: 0, pts: [], prev: [], mesh: null, snd: null, yaw: 0, vel: new V3(), lastPos: new V3(), phase: '' };
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
function startRopeHeli(r) {
  if (ropeHeli.active && ropeHeli.n === r.n) return;
  stopRopeHeli();
  if (!ropeHeli.m) { ropeHeli.m = takeModel('utility'); ropeHeli.mesh = ropeMesh(); }
  ropeHeli.active = true; ropeHeli.n = r.n; ropeHeli.tl = ropeTimeline(r); ropeHeli.t = (r.age || 0) / 1000;
  const s = ropeHeliPos(ropeHeli.tl, ropeHeli.t); if (!s) { ropeHeli.active = false; return; }
  ropeHeli.m.g.position.copy(s.p); ropeHeli.lastPos.copy(s.p); ropeHeli.yaw = Math.atan2(ropeHeli.tl.A.x - ropeHeli.tl.E.x, ropeHeli.tl.A.z - ropeHeli.tl.E.z);
  scene.add(ropeHeli.m.g, ropeHeli.mesh);
  const an = ropeAnchor();
  ropeHeli.pts = []; ropeHeli.prev = [];
  for (let i = 0; i < ROPE_N; i++) { const p = an.clone().add(new V3(0, -i * ROPE_SEG, 0)); ropeHeli.pts.push(p); ropeHeli.prev.push(p.clone()); }
  if (AC) ropeHeli.snd = rotorSound();
  if (s.ph === 'in') showPrompt('Helicopter inbound · grab its rope (E) to fly across the compound');
}
function stopRopeHeli() {
  if (!ropeHeli.active) return;
  ropeHeli.active = false; if (P.rope) releaseRope();
  scene.remove(ropeHeli.m.g, ropeHeli.mesh);
  if (ropeHeli.snd) { try { ropeHeli.snd.s.stop(); ropeHeli.snd.o.stop(); ropeHeli.snd.lfo.stop(); } catch (e) { } ropeHeli.snd = null; }
}
function ropeAnchor() { const m = ropeHeli.m; m.g.updateMatrixWorld(true); return m.anchor.clone().applyMatrix4(m.g.matrixWorld); }
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
function updateRopeHeli(dt) {
  if (!ropeHeli.active) return;
  ropeHeli.t += dt;
  const s = ropeHeliPos(ropeHeli.tl, ropeHeli.t);
  if (!s) { stopRopeHeli(); return; }
  const m = ropeHeli.m, prevPh = ropeHeli.phase; ropeHeli.phase = s.ph;
  const v = s.p.clone().sub(ropeHeli.lastPos).divideScalar(Math.max(dt, 1e-3)); ropeHeli.lastPos.copy(s.p);
  const acc = v.clone().sub(ropeHeli.vel).divideScalar(Math.max(dt, 1e-3)); ropeHeli.vel.lerp(v, Math.min(1, dt * 4));
  const hs = Math.hypot(ropeHeli.vel.x, ropeHeli.vel.z);
  let wantYaw = ropeHeli.yaw;
  if (hs > 2.5) wantYaw = Math.atan2(ropeHeli.vel.x, ropeHeli.vel.z);
  const dy = clamp(angDiff(ropeHeli.yaw, wantYaw), -dt * 0.6, dt * 0.6); ropeHeli.yaw += dy;
  const fwd = new V3(Math.sin(ropeHeli.yaw), 0, Math.cos(ropeHeli.yaw));
  const pitch = clamp(ropeHeli.vel.dot(fwd) * 0.012 + clamp(acc.dot(fwd), -3, 3) * 0.02, -0.18, 0.25), roll = clamp(-dy / Math.max(dt, 1e-3) * 0.5, -0.3, 0.3);
  m.g.position.copy(s.p); m.g.rotation.set(0, 0, 0); m.g.rotation.order = 'YXZ'; m.g.rotation.set(pitch, ropeHeli.yaw, roll);
  m.rotor.rotation.y += dt * 28; m.tail.rotation.x += dt * 70; m.strobe.visible = (ropeHeli.t % 1.1) < 0.08; m.blink.forEach(b => b.visible = (ropeHeli.t % 1.0) < 0.6);
  poseOperator(m.crew, { vf: 0, vs: 0, crouch: 1, pitch: -0.6, aim: 0.15, reload: -1, rope: 0, w: 0, dt });
  // rope: verlet chain pinned at the hoist, pulled by riders
  const pts = ropeHeli.pts, prev = ropeHeli.prev, an = ropeAnchor();
  const riders = [];
  for (const r of remotes.values()) if (r.alive && (r.flags & 2)) riders.push(r.pos.clone().add(new V3(0, 2.05, 0)));
  const sub = Math.min(4, Math.ceil(dt / (1 / 120))), h = dt / sub;
  for (let k = 0; k < sub; k++) {
    for (let i = 1; i < ROPE_N; i++) {
      const p = pts[i], q = prev[i], vx = (p.x - q.x) * 0.99, vy = (p.y - q.y) * 0.99, vz = (p.z - q.z) * 0.99;
      q.copy(p); p.x += vx + (Math.random() - 0.5) * 0.0008 * (s.p.y < 20 ? 1 : 0); p.y += vy - 9.8 * h * h; p.z += vz;
      if (p.y < 0.03) p.y = 0.03;
    }
    pts[0].copy(an);
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < ROPE_N - 1; i++) {
        const a = pts[i], b = pts[i + 1], d = b.clone().sub(a), L = d.length() || 1e-6, diff = (L - ROPE_SEG) / L;
        const wa = i === 0 ? 0 : 0.5, wb = i === 0 ? 1 : 0.5;
        a.addScaledVector(d, diff * wa); b.addScaledVector(d, -diff * wb);
      }
      pts[0].copy(an);
      if (P.rope) pts[P.rope.i].lerp(P.rope.hold, 0.0); // rider follows the rope (below)
    }
  }
  for (const rp of riders) { let bi = 1, bd = 1e9; for (let i = 1; i < ROPE_N; i++) { const d = pts[i].distanceToSquared(rp); if (d < bd) { bd = d; bi = i; } } if (bd < 9) pts[bi].lerp(rp, 0.5); }
  const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  for (let i = 0; i < ROPE_N - 1; i++) { const a = pts[i], b = pts[i + 1], d = b.clone().sub(a), L = d.length(); q.setFromUnitVectors(up, d.divideScalar(L || 1)); mm.compose(a.clone().add(b).multiplyScalar(0.5), q, new V3(1, L, 1)); ropeHeli.mesh.setMatrixAt(i, mm); }
  ropeHeli.mesh.instanceMatrix.needsUpdate = true;
  // downwash dust
  if (s.p.y < 22 && Math.random() < 0.55) for (let i = 0; i < 1; i++) {
    const a = Math.random() * Math.PI * 2, rr = R(1.5, 7), gp = new V3(s.p.x + Math.cos(a) * rr, 0.15, s.p.z + Math.sin(a) * rr);
    if (gp.z < MAP.z0) continue;
    smoke.spawn(gp, new V3(Math.cos(a) * R(4, 8), R(0.3, 1.2), Math.sin(a) * R(4, 8)), R(0.7, 1.2), R(0.14, 0.3), new THREE.Color(0xc9bba4), -0.4, false, 1.6); smoke.p[smoke.p.length - 1].grow = true;
  }
  if (ropeHeli.snd) {
    const rel = s.p.clone().sub(camera.position), d = rel.length();
    ropeHeli.snd.g.gain.setTargetAtTime(clamp(95 / (d + 12), 0, 2.4), AC.currentTime, 0.1);
    if (ropeHeli.snd.pan) { const right = new V3(Math.cos(camera.rotation.y), 0, -Math.sin(camera.rotation.y)); ropeHeli.snd.pan.pan.setTargetAtTime(clamp(rel.normalize().dot(right), -1, 1) * 0.8, AC.currentTime, 0.1); }
  } else if (AC) ropeHeli.snd = rotorSound();
  if (P.rope && prevPh === 'hoverB' && s.ph === 'out') releaseRope('Dropped off');
}
let ropeHintT = 0;
function ropeGrabCheck() {
  if (!ropeHeli.active || P.rope || !P.alive) return;
  const pts = ropeHeli.pts; let best = -1, bd = 0.95;
  for (let i = 2; i < ROPE_N; i++) { const p = pts[i]; if (p.y < P.pos.y + 0.3 || p.y > P.pos.y + 2.5) continue; const d = Math.hypot(p.x - P.pos.x, p.z - P.pos.z); if (d < bd) { bd = d; best = i; } }
  ropeHeli.canGrab = best >= 0;
  if (best >= 0 && performance.now() - ropeHintT > 700) { ropeHintT = performance.now(); showPrompt('Press E to grab the rope'); }
}
function grabRope() {
  if (!ropeHeli.canGrab || P.rope) return;
  const pts = ropeHeli.pts; let bi = 2, bd = 1e9;
  for (let i = 2; i < ROPE_N; i++) { const d = Math.abs(pts[i].y - (P.pos.y + 2.05)) + Math.hypot(pts[i].x - P.pos.x, pts[i].z - P.pos.z); if (d < bd) { bd = d; bi = i; } }
  P.rope = { i: bi, hold: new V3() }; P.reloadT = 0; P.rl = null; P.ads = 0; P.crouching = false; mouseDown = false;
  SFX.mech('pouch'); showPrompt('On the rope · E to let go');
}
function releaseRope(msg) {
  if (!P.rope) return; P.rope = null; P.onGround = false; P.minVy = Math.min(0, P.vel.y);
  P.vel.x = clamp(P.vel.x, -8, 8); P.vel.z = clamp(P.vel.z, -8, 8); P.vel.y = clamp(P.vel.y, -6, 4);
  if (msg) showPrompt(msg);
}
function updateRopeRider(dt) {
  if (!ropeHeli.active) { releaseRope(); return; }
  const pt = ropeHeli.pts[P.rope.i], target = pt.clone().add(new V3(0, -2.05, 0));
  P.vel.copy(target).sub(P.pos).divideScalar(Math.max(dt, 1e-3)); P.pos.copy(target);
  P.onGround = false; P.ads = lerp(P.ads, 0, dt * 10); P.sprint = 0; P.bobAmt = 0; P.crouch = lerp(P.crouch, 0, dt * 8);
  P.recP.step(dt); P.recY.step(dt);
  if (ropeHeli.phase === 'hoverB' && P.pos.y - groundAt(P.pos.x, P.pos.z, 0.3, P.pos.y + 0.5) < 0.45) releaseRope('Dropped off');
}

// ======================================================= POST
let composer, bloom, grade, renderPass, wPass;
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, dmg: { value: 0 }, aspect: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time,dmg,aspect; varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
  void main(){ vec2 uv=vUv; vec2 q=uv-.5; q.x*=aspect; float r=length(q);
    vec3 c; float ca = 0.0012 + dmg*0.004; c.r = texture2D(tDiffuse, uv + q*ca).r; c.g = texture2D(tDiffuse, uv).g; c.b = texture2D(tDiffuse, uv - q*ca).b;
    c = mix(c, c*vec3(1.04,1.0,0.95), 0.6);
    c *= 1.0 - smoothstep(0.45, 1.15, r)*0.6;
    c += (hash(uv*vec2(1733.,977.)+fract(time*7.3))-.5)*0.022;
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
function sens() { const w = WEAPONS[P.weapon]; return 0.0021 * settings.sens * (P.ads > 0.5 ? (w.scope ? 0.3 : 0.65) : 1); }
addEventListener('mousemove', e => {
  if (gameState !== 'play' || !P.alive) return;
  if (!locked && !(e.buttons & 1)) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return; // ignore pointer-lock jumps
  P.yaw -= dx * sens(); P.pitch = clamp(P.pitch - dy * sens(), -1.5, 1.5);
  P.swayX = clamp(P.swayX - dx * 0.00012, -0.03, 0.03); P.swayY = clamp(P.swayY + dy * 0.00012, -0.03, 0.03);
});
addEventListener('mousedown', e => {
  if (gameState !== 'play') return;
  if (!locked && wantLock) requestLock();
  if (e.button === 0) mouseDown = true;
  if (e.button === 2) P.adsHeld = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; if (e.button === 2) P.adsHeld = false; });
addEventListener('contextmenu', e => { if (gameState === 'play') e.preventDefault(); });
addEventListener('keydown', e => {
  if (gameState !== 'play') return;
  if (e.code === 'Tab') { e.preventDefault(); showBoard(); return; }
  if (e.repeat) return;
  keys[e.code] = true;
  if (!P.alive) return;
  if (e.code === 'KeyE') { if (P.rope) releaseRope(); else grabRope(); }
  if (P.rope) return;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'KeyC') P.crouching = !P.crouching;
  if (e.code === 'Digit1') setWeapon(0); if (e.code === 'Digit2') setWeapon(1); if (e.code === 'Digit3') setWeapon(2);
  if (e.code === 'KeyQ') setWeapon(P.prevWeapon);
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') hideBoard(); });
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
$('name').addEventListener('input', e => { settings.name = e.target.value.trim().slice(0, 16); store.set('name', settings.name); });
$('sens').value = settings.sens;
$('sens').addEventListener('input', e => { settings.sens = +e.target.value; store.set('sens', settings.sens); });
const qButtons = [...document.querySelectorAll('#quality button')];
const syncQ = () => qButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.q === settings.quality));
qButtons.forEach(b => b.addEventListener('click', () => { settings.quality = b.dataset.q; store.set('quality2', settings.quality); dynScale = 1; syncQ(); setupPost(); }));
syncQ();
let joined = false;
deployBtn.addEventListener('click', async () => {
  initAudio();
  if (!settings.name) { settings.name = 'Operator ' + (100 + Math.floor(Math.random() * 900)); $('name').value = settings.name; store.set('name', settings.name); }
  if (!joined) {
    deployBtn.disabled = true; deployBtn.textContent = 'Connecting…';
    const ok = await connect();
    joined = true;
    if (ok === 'full') { setStatus('The match is full (4 players).', 'warn'); deployBtn.disabled = false; deployBtn.textContent = 'Deploy'; joined = false; return; }
    if (!ok) { startLocal(); setStatus(hostCfg.bots ? `Offline practice against ${hostCfg.bots} bot${hostCfg.bots > 1 ? 's' : ''}.` : 'Offline practice range.', 'warn'); }
    else setStatus(isHost ? 'Hosting the match.' : 'Connected to the host.', 'ok');
    renderScore(); deployBtn.disabled = false;
  }
  closeMenu();
});
function closeMenu() {
  gameState = 'play'; menu.hidden = true; $('hud').hidden = false; wantLock = true; requestLock();
  viewmodels.forEach((v, k) => v.root.visible = P.alive && k === P.weapon);
  deployBtn.textContent = 'Resume';
}
function openMenu() { gameState = 'menu'; menu.hidden = false; mouseDown = false; P.adsHeld = false; for (const k in keys) keys[k] = false; }

// ======================================================= LOOP
const clock = new THREE.Clock();
let elapsed = 0;
const perf = { n: 0, t: 0, fps: 0, lastChange: 0, shown: '' };
function trackPerf(raw) { // measure real fps once a second; in Auto, trade resolution for a steady 60
  if (document.hidden || raw > 0.5) { perf.n = 0; perf.t = 0; return; }
  perf.n++; perf.t += raw; if (perf.t < 1) return;
  const fps = perf.n / perf.t; perf.fps = Math.round(fps); perf.n = 0; perf.t = 0;
  if (!QUALITY[settings.quality].adaptive || gameState !== 'play') return;
  const now = performance.now();
  if (fps < 52 && dynScale > 0.55 && now - perf.lastChange > 900) { dynScale = Math.max(0.55, dynScale * (fps < 40 ? 0.8 : 0.88)); perf.lastChange = now; applyPR(); }
  else if (fps >= 58.5 && dynScale < 1 && now - perf.lastChange > 4000) { dynScale = Math.min(1, dynScale * 1.08); perf.lastChange = now; applyPR(); }
}
function frame() {
  const raw = clock.getDelta(); trackPerf(raw);
  const dt = Math.min(0.05, raw); elapsed += dt;
  skyUniforms.uTime.value = elapsed;
  if (water) water.material.uniforms.time.value = elapsed * 0.35;
  if (gameState === 'play' || joined) {
    if (gameState === 'play') updatePlayer(dt);
    if (gameState === 'play' && !window.__freeCam) updateCamera(dt, elapsed);
    if (online) sendState(dt);
  }
  if (!joined) { // menu flyover
    const a = elapsed * 0.06;
    camera.position.set(Math.cos(a) * 40, 15 + Math.sin(a * 0.7) * 2.5, Math.sin(a) * 30 + 8);
    camera.lookAt(0, 1.5, 6);
  }
  updateBots(dt);
  for (const r of remotes.values()) r.update(dt);
  updateRopeHeli(dt);
  updateTargets(dt);
  updateFlybys(dt); updateFlags(elapsed); updateBoats(dt, elapsed); updateBoatFlags(elapsed);
  sparks.update(dt); debris.update(dt); smoke.update(dt); updateTracers(dt);
  for (const f of flashLights) if (f.t > 0) { f.t -= dt; if (f.t <= 0) f.l.intensity = 0; }
  sky.position.copy(camera.position);
  if (gameState === 'play') updateHUD(dt);
  grade.uniforms.time.value = elapsed;
  composer.render(dt);
  requestAnimationFrame(frame);
}

// ======================================================= BOOT
buildMap();
botCtx.nav = new NavGrid(colliders, MAP);
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
  if (o.state === 'ready') return `<b style="color:var(--ink)">You are hosting.</b> Send the other player this <b>join code</b>:<br><span class="code">${esc(o.code)}</span> <button class="btn2" type="button" id="copyinv" style="padding:6px 10px;font-size:12px;vertical-align:middle">Copy invite</button><br>They open <b style="user-select:all">${esc(o.url)}</b> in Chrome or Safari (or type the code into the Join box of their Tidebreak).${lan}`;
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
  $('hostnote').innerHTML = 'Both players open this website. One clicks <b>Host a match</b> and reads out the code; the other types it and clicks <b>Join</b>. Keep the host\'s window open while you play.';
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
      const code = await P2P.host(() => { msg.innerHTML = codeHtml(code) + '<br><b style="color:var(--ink)">A player joined.</b> Click Deploy if you have not yet.'; });
      const link = location.origin + location.pathname + '#' + code;
      const codeHtml = c => `Your match code: <span class="code">${esc(c)}</span> <button class="btn2" type="button" id="copyweb" style="padding:6px 10px;font-size:12px;vertical-align:middle">Copy invite</button><br>The other player opens <b style="user-select:all">${esc(link)}</b> or types the code and clicks Join.`;
      msg.innerHTML = codeHtml(code) + '<br>Click <b>Deploy</b> to drop in while you wait.';
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
      msg.innerHTML = '<b style="color:var(--ink)">Connected to match ' + esc(code) + '.</b> Click Deploy to drop in.'; updateHostUI();
      setStatus('Connected to the host. Deploy to join the match.', 'ok');
    } catch (e) { lock(false); msg.className = 'err'; msg.textContent = why(e); }
  };
  jb.onclick = go;
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(); });
}
requestAnimationFrame(frame);
window.__tb = { composer, viewmodels, bots, get ropeHeli() { return ropeHeli; }, startRopeHeli, get localMatch() { return localMatch; }, get cfg() { return cfg; }, get netMode() { return netMode; }, perf, get dynScale() { return dynScale; }, get pr() { return curPR; }, spawnFlyby, flybys, boats, P, remotes, playerInfo, colliders, renderer, scene, camera, keys, get online() { return online; }, fire: () => fire(), setWeapon, onNet };
