// Operator (soldier) models for players and bots. Every look is generated from a seed, so each
// soldier gets his own camo, face, beard, headgear, eyewear, vest, pack and rifle setup.
// Body parts are merged per bone and per material to keep draw calls low. Arms use two-bone IK
// so the hands stay on the rifle in every pose (aim, low ready, reload, rope).
import * as THREE from './vendor/three.module.js';
import { mergeGeometries } from './vendor/jsm/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function rng(seed) { let s = seed * 9301 + 49297 | 0; return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

// ---------------------------------------------------------------- looks
export const CAMOS = ['lizard', 'multi', 'woodland', 'arid', 'ranger', 'black', 'aor', 'coyote'];
const HEADGEAR = ['helmet', 'helmetNvg', 'boonie', 'cap', 'bare', 'helmetCover', 'balaclava'];
const SKIN = ['#c99f7e', '#b98b67', '#a87a5b', '#93664a', '#d5ae8f', '#7a5139', '#bf9370', '#9c7154'];
const HAIR = ['#1c1612', '#2a1f17', '#3b2a1d', '#141210', '#4a3624', '#5b4a3a', '#2e2a26'];
const GEAR = ['#7f6a4c', '#4a4f3a', '#25272a', '#6e6a50', '#8a7656', '#3f4434', '#5b5444'];
const HELM = ['#7d6d52', '#3a3d33', '#1f2124', '#5b5d4a', '#8b7a5e', '#4c4a40'];
// Fixed looks for the four human slots, then seeded looks for bots (look 10, 11, ...)
const HUMAN_LOOKS = [
  { camo: 'lizard', pants: 'lizard', head: 'helmet', eyes: 'shades', beard: 'stubble', skin: 1, hair: 1, gear: 0, helm: 0, pack: 'assault', vest: 'plate', sleeves: 'down', gun: { supp: true, optic: 'holo', tan: false }, h: 1.0, wide: 1.0 },
  { camo: 'black', pants: 'black', head: 'helmetNvg', eyes: 'clear', beard: 'none', skin: 4, hair: 0, gear: 2, helm: 2, pack: 'radio', vest: 'plate', sleeves: 'down', gun: { supp: true, optic: 'lpvo', tan: false }, h: 1.03, wide: 1.02 },
  { camo: 'multi', pants: 'multi', head: 'cap', eyes: 'shades', beard: 'short', skin: 2, hair: 2, gear: 4, helm: 0, pack: 'hydration', vest: 'chest', sleeves: 'rolled', gun: { supp: false, optic: 'holo', tan: true }, h: 0.97, wide: 0.98 },
  { camo: 'aor', pants: 'ranger', head: 'boonie', eyes: 'none', beard: 'full', skin: 3, hair: 3, gear: 1, helm: 1, pack: 'assault', vest: 'plate', sleeves: 'down', gun: { supp: false, optic: 'red', tan: false }, h: 1.01, wide: 1.05 }
];
export function lookFor(id) {
  if (id >= 0 && id < HUMAN_LOOKS.length) return { ...HUMAN_LOOKS[id], seed: id + 1 };
  const k = Math.max(0, id - 10), r = rng(id * 7919 + 13);
  const camo = CAMOS[(k * 3 + 1) % CAMOS.length];
  return {
    seed: id + 1,
    camo, pants: r() < 0.65 ? camo : pick(r, ['ranger', 'coyote', 'black', 'multi', 'lizard']),
    head: HEADGEAR[(k * 2 + 3) % HEADGEAR.length], eyes: pick(r, ['none', 'shades', 'clear', 'shades', 'goggles']),
    beard: pick(r, ['none', 'stubble', 'short', 'full', 'stubble', 'mustache']), skin: Math.floor(r() * SKIN.length), hair: Math.floor(r() * HAIR.length),
    gear: (k * 3 + 2) % GEAR.length, helm: Math.floor(r() * HELM.length), pack: pick(r, ['none', 'assault', 'hydration', 'radio', 'assault']),
    vest: r() < 0.68 ? 'plate' : 'chest', sleeves: r() < 0.28 ? 'rolled' : 'down',
    gun: { supp: r() < 0.5, optic: pick(r, ['holo', 'red', 'lpvo', 'holo']), tan: r() < 0.3 },
    h: 0.94 + r() * 0.12, wide: 0.94 + r() * 0.13
  };
}

// ---------------------------------------------------------------- textures
const texCache = new Map();
function canvasTex(key, size, draw, srgb = true, w = size) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas'); c.width = w; c.height = size; const g = c.getContext('2d'); draw(g, w, size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  texCache.set(key, t); return t;
}
function weave(g, W, H, r, amt = 18) {
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, n = ((x + y) % 2 ? 1 : -1) * 4 + (r() - 0.5) * amt + (((y >> 1) % 2) ? 3 : -3);
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(im, 0, 0);
}
function blobs(g, W, H, r, n, col, rmin, rmax, sx = 1, sy = 1) {
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = r() * H, rad = rmin + r() * (rmax - rmin);
    for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
      g.beginPath(); const k = 7 + Math.floor(r() * 5);
      for (let j = 0; j <= k; j++) { const a = j / k * Math.PI * 2, rr = rad * (0.6 + r() * 0.6); const px = x + ox + Math.cos(a) * rr * sx, py = y + oy + Math.sin(a) * rr * sy; j ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.closePath(); g.fill();
    }
  }
}
function camoTex(kind, seed) {
  return canvasTex('camo:' + kind + ':' + seed, 256, (g, W, H) => {
    const r = rng(seed * 31 + kind.length);
    const base = { lizard: '#a89a72', multi: '#9f9170', woodland: '#7a7454', arid: '#bfa982', ranger: '#4d533b', black: '#26282c', aor: '#5d6544', coyote: '#8a7556' }[kind];
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    if (kind === 'lizard') { // Greek lizard: short vertical brush strokes
      for (const [col, n] of [['#56653a', 70], ['#6b4e33', 55], ['#3b3a28', 25]]) { g.fillStyle = col; for (let i = 0; i < n; i++) { const x = r() * W, y = r() * H, w = 4 + r() * 7, h = 18 + r() * 40; g.beginPath(); g.ellipse(x, y, w / 2, h / 2, (r() - 0.5) * 0.25, 0, 7); g.fill(); g.beginPath(); g.ellipse(x, y + H - (y > H / 2 ? 2 * H : 0), w / 2, h / 2, 0, 0, 7); g.fill(); } }
    } else if (kind === 'multi') {
      blobs(g, W, H, r, 10, '#c3b48d', 20, 40, 1.4, 0.8); blobs(g, W, H, r, 14, '#7b7a4d', 14, 30, 1.2, 1); blobs(g, W, H, r, 10, '#6a5236', 10, 22, 1, 1.4);
      g.strokeStyle = '#3b2e20'; g.lineWidth = 2.5; for (let i = 0; i < 18; i++) { let x = r() * W, y = r() * H; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 22; y += r() * 18; g.lineTo(x, y); } g.stroke(); }
    } else if (kind === 'woodland') {
      blobs(g, W, H, r, 12, '#3f4b2c', 22, 44, 1.6, 0.9); blobs(g, W, H, r, 10, '#5a4530', 18, 34, 1.5, 0.8); blobs(g, W, H, r, 9, '#1e1d17', 8, 16, 1.8, 0.7);
    } else if (kind === 'arid' || kind === 'aor') {
      const cols = kind === 'arid' ? ['#a08d66', '#7d6c4e', '#cbb894', '#8f7a58'] : ['#3f4630', '#747451', '#2d3022', '#868259'];
      for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) { const v = Math.sin(x * 0.05 + r() * 0.8) + Math.cos(y * 0.06 + x * 0.02) + r() * 1.4; if (v > 1.2) { g.fillStyle = cols[Math.floor(r() * cols.length)]; g.fillRect(x, y, 4, 4); } }
      blobs(g, W, H, r, 8, cols[1] + '88', 14, 26);
    }
    weave(g, W, H, r, kind === 'black' ? 10 : 16);
    // seams and grime
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, H * 0.5, W, 2); g.fillRect(W * 0.5, 0, 2, H);
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(60,45,30,0)'); gr.addColorStop(1, 'rgba(60,45,30,.18)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  });
}
function corduraTex(col, seed) {
  return canvasTex('cord:' + col, 128, (g, W, H) => {
    const r = rng(seed); g.fillStyle = col; g.fillRect(0, 0, W, H);
    // MOLLE webbing rows
    g.fillStyle = 'rgba(0,0,0,.28)'; for (let y = 6; y < H; y += 16) { g.fillRect(0, y, W, 2); g.fillRect(0, y + 7, W, 1); for (let x = 0; x < W; x += 12) g.fillRect(x, y, 2, 8); }
    weave(g, W, H, r, 14);
  });
}
function faceTex(L) {
  return canvasTex('face:' + L.seed + L.skin + L.beard + L.head, 256, (g, W, H) => {
    const r = rng(L.seed * 17 + 5), skin = SKIN[L.skin % SKIN.length], hair = HAIR[L.hair % HAIR.length];
    g.fillStyle = skin; g.fillRect(0, 0, W, H);
    // subtle tone variation, warmer cheeks and nose
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '90,50,35' : '255,220,200'},${0.02 + r() * 0.04})`; g.fillRect(r() * W, r() * H, 2 + r() * 6, 2 + r() * 6); }
    const fx = W * 0.25; // face centre (sphere u = 0.25 faces +z)
    const blush = g.createRadialGradient(fx, 140, 2, fx, 140, 34); blush.addColorStop(0, 'rgba(170,80,60,.22)'); blush.addColorStop(1, 'rgba(170,80,60,0)'); g.fillStyle = blush; g.fillRect(fx - 40, 100, 80, 80);
    // hairline at the top/back
    g.fillStyle = hair; g.fillRect(0, 0, W, 58);
    g.beginPath(); g.ellipse(fx, 60, 34, 14, 0, 0, Math.PI); g.fillStyle = skin; g.fill();
    // brows, eye sockets, eyes
    const eyeY = 118;
    for (const s of [-1, 1]) {
      const ex = fx + s * 12;
      const sock = g.createRadialGradient(ex, eyeY, 1, ex, eyeY, 11); sock.addColorStop(0, 'rgba(40,20,15,.45)'); sock.addColorStop(1, 'rgba(40,20,15,0)'); g.fillStyle = sock; g.fillRect(ex - 12, eyeY - 12, 24, 24);
      g.fillStyle = '#e9e2d6'; g.beginPath(); g.ellipse(ex, eyeY, 5.2, 2.6, 0, 0, 7); g.fill();
      g.fillStyle = pick(r, ['#3b2a1c', '#2a1d12', '#4f3a22', '#2f3a2a', '#3d4a52']); g.beginPath(); g.arc(ex + s * 0.5, eyeY, 2.3, 0, 7); g.fill();
      g.fillStyle = '#0c0a08'; g.beginPath(); g.arc(ex + s * 0.5, eyeY, 1.1, 0, 7); g.fill();
      g.strokeStyle = 'rgba(30,18,12,.75)'; g.lineWidth = 1.2; g.beginPath(); g.ellipse(ex, eyeY - 0.5, 5.6, 2.9, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.fillStyle = hair; g.save(); g.translate(ex, eyeY - 9); g.rotate(s * -0.08); g.fillRect(-7, -1.6, 14, 3.4); g.restore();
    }
    // nose shading and mouth
    g.fillStyle = 'rgba(80,40,30,.25)'; g.fillRect(fx - 2, 124, 4, 22); g.fillStyle = 'rgba(60,30,20,.35)'; g.fillRect(fx - 6, 147, 12, 2);
    g.fillStyle = 'rgba(120,55,50,.75)'; g.beginPath(); g.ellipse(fx, 166, 9, 2.4, 0, 0, 7); g.fill();
    g.strokeStyle = 'rgba(50,20,15,.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(fx - 9, 166); g.quadraticCurveTo(fx, 168, fx + 9, 166); g.stroke();
    // facial hair
    const stub = (a, y0, y1, wHalf) => { for (let i = 0; i < 2600 * a; i++) { const x = fx + (r() - 0.5) * 2 * wHalf, y = y0 + r() * (y1 - y0); const edge = Math.abs(x - fx) / wHalf; if (y < 150 && edge < 0.6 && y > 140) continue; g.fillStyle = hair; g.globalAlpha = 0.25 + r() * 0.35; g.fillRect(x, y, 1.3, 1.3); } g.globalAlpha = 1; };
    if (L.beard === 'stubble') stub(0.8, 140, 200, 40);
    if (L.beard === 'short' || L.beard === 'full') { stub(1.6, 135, 205, 44); g.fillStyle = hair; g.globalAlpha = 0.8; g.beginPath(); g.ellipse(fx, 158, 13, 4, 0, 0, 7); g.fill(); g.globalAlpha = 1; }
    if (L.beard === 'mustache') { g.fillStyle = hair; g.beginPath(); g.ellipse(fx, 158, 14, 4.2, 0, 0, 7); g.fill(); stub(0.4, 150, 200, 36); }
    if (L.head === 'balaclava') { // fabric over everything except an eye band
      const gc = GEAR[L.gear % GEAR.length]; g.fillStyle = gc; g.fillRect(0, 0, W, eyeY - 14); g.fillRect(0, eyeY + 10, W, H); g.fillRect(0, 0, fx - 26, H); g.fillRect(fx + 26, 0, W, H);
      weave(g, W, H, r, 12);
    }
  });
}
const ropeTex = () => canvasTex('rope', 64, (g, W, H) => { g.fillStyle = '#8b7a55'; g.fillRect(0, 0, W, H); for (let i = -H; i < W + H; i += 8) { g.strokeStyle = 'rgba(40,30,15,.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke(); } weave(g, W, H, rng(3), 20); });

// ---------------------------------------------------------------- geometry helpers
function rbox(w, h, d, r = 0.012) {
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const iw = w - 2 * r, ih = h - 2 * r, rr = Math.min(iw, ih) * 0.25, s = new THREE.Shape();
  s.moveTo(-iw / 2 + rr, -ih / 2); s.lineTo(iw / 2 - rr, -ih / 2); s.quadraticCurveTo(iw / 2, -ih / 2, iw / 2, -ih / 2 + rr);
  s.lineTo(iw / 2, ih / 2 - rr); s.quadraticCurveTo(iw / 2, ih / 2, iw / 2 - rr, ih / 2); s.lineTo(-iw / 2 + rr, ih / 2);
  s.quadraticCurveTo(-iw / 2, ih / 2, -iw / 2, ih / 2 - rr); s.lineTo(-iw / 2, -ih / 2 + rr); s.quadraticCurveTo(-iw / 2, -ih / 2, -iw / 2 + rr, -ih / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.95, bevelSegments: 2, curveSegments: 2 });
  g.translate(0, 0, -(d - 2 * r) / 2);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 2);
  return g;
}
const tcyl = (r0, r1, len, seg = 12) => new THREE.CylinderGeometry(r1, r0, len, seg, 1); // r0 bottom, r1 top
const sph = (r, ws = 14, hs = 10, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, ts, tl);

class Bone {
  constructor(group, part) { this.group = group; this.part = part; this.parts = new Map(); }
  add(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4().compose(new V3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new V3(sx, sy, sz));
    let g = geo.index ? geo.toNonIndexed() : geo.clone(); g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g); return this;
  }
  build(hitList) {
    for (const [mat, geos] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat); mesh.castShadow = true; mesh.receiveShadow = true;
      if (this.part) { mesh.userData.part = this.part; hitList.push(mesh); }
      this.group.add(mesh);
    }
    this.parts.clear();
  }
}

// ---------------------------------------------------------------- shared materials
const SH = {
  black: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.7, metalness: 0.1 }),
  webbing: new THREE.MeshStandardMaterial({ color: 0x2a2a26, roughness: 0.9 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x202224, roughness: 0.38, metalness: 0.85 }),
  gunTan: new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.65, metalness: 0.1 }),
  polymer: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.6, metalness: 0.15 }),
  lens: new THREE.MeshPhysicalMaterial({ color: 0x0a0c0e, roughness: 0.05, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.5 }),
  clearLens: new THREE.MeshPhysicalMaterial({ color: 0x9fb0b8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35, clearcoat: 1, envMapIntensity: 2 }),
  sole: new THREE.MeshStandardMaterial({ color: 0x151412, roughness: 0.95 }),
  rope: null
};
const matCache = new Map();
const cmat = (key, make) => matCache.get(key) || (matCache.set(key, make()), matCache.get(key));
export function ropeMaterial() { return SH.rope || (SH.rope = new THREE.MeshStandardMaterial({ map: ropeTex(), roughness: 0.95 })); }

// ---------------------------------------------------------------- the model
const L1 = 0.29, L2 = 0.29; // upper arm, forearm+hand reach
export function makeOperator(lookId, bandColor = 0x888888) {
  const L = lookFor(lookId), r = rng(L.seed * 101 + 7);
  const shirt = cmat('camo' + L.camo + L.seed, () => new THREE.MeshStandardMaterial({ map: camoTex(L.camo, L.seed), roughness: 0.93 }));
  const pants = L.pants === L.camo ? shirt : cmat('camo' + L.pants + L.seed + 'p', () => new THREE.MeshStandardMaterial({ map: camoTex(L.pants, L.seed + 50), roughness: 0.94 }));
  const gearCol = GEAR[L.gear % GEAR.length];
  const gear = cmat('gear' + gearCol, () => new THREE.MeshStandardMaterial({ map: corduraTex(gearCol, L.gear + 3), roughness: 0.86 }));
  const skin = cmat('skin' + L.skin, () => new THREE.MeshStandardMaterial({ color: SKIN[L.skin % SKIN.length], roughness: 0.62, metalness: 0 }));
  const face = cmat('face' + L.seed, () => new THREE.MeshStandardMaterial({ map: faceTex(L), roughness: 0.6 }));
  const hair = cmat('hair' + L.hair, () => new THREE.MeshStandardMaterial({ color: HAIR[L.hair % HAIR.length], roughness: 0.95 }));
  const helm = cmat('helm' + L.helm + L.head, () => L.head === 'helmetCover' ? new THREE.MeshStandardMaterial({ map: camoTex(L.camo, L.seed + 9), roughness: 0.9 }) : new THREE.MeshStandardMaterial({ color: HELM[L.helm % HELM.length], roughness: 0.55, metalness: 0.05 }));
  const glove = cmat('glove' + (L.seed % 3), () => new THREE.MeshStandardMaterial({ color: ['#2a2723', '#6e5d45', '#1c1c1c'][L.seed % 3], roughness: 0.85 }));
  const boot = cmat('boot' + (L.seed % 3), () => new THREE.MeshStandardMaterial({ color: ['#6b5940', '#2a2622', '#4d4535'][L.seed % 3], roughness: 0.8 }));
  const band = new THREE.MeshStandardMaterial({ color: bandColor, emissive: bandColor, emissiveIntensity: 0.35, roughness: 0.6 });
  const gunMat = L.gun.tan ? SH.gunTan : SH.polymer;

  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const body = new THREE.Group(); body.scale.set(L.wide, L.h, L.wide); g.add(body);
  const hit = [];
  const hips = new THREE.Group(); hips.position.set(0, 0.97, 0); body.add(hips);
  const spine = new THREE.Group(); spine.position.set(0, 0.07, 0); hips.add(spine);
  const neck = new THREE.Group(); neck.position.set(0, 0.53, 0.01); spine.add(neck);
  const bones = [];
  const bone = (grp, part) => { const b = new Bone(grp, part); bones.push(b); return b; };

  // pelvis + belt
  const bp = bone(hips, 'body');
  bp.add(tcyl(0.15, 0.155, 0.2, 14), pants, 0, 0, 0, 0, 0, 0, 1, 1, 0.72);
  for (const s of [-1, 1]) bp.add(sph(0.085, 10, 8), pants, s * 0.07, -0.05, -0.06, 0, 0, 0, 1, 1, 0.9);
  bp.add(tcyl(0.162, 0.162, 0.05, 16), SH.webbing, 0, 0.06, 0, 0, 0, 0, 1, 1, 0.74);
  bp.add(rbox(0.06, 0.04, 0.02), SH.metal, 0, 0.06, 0.12);
  bp.add(rbox(0.12, 0.13, 0.07, 0.015), gear, 0.12, -0.01, -0.09, 0, 0.5, 0); // dump pouch
  if (r() < 0.6) bp.add(rbox(0.07, 0.09, 0.05), gear, 0.16, 0.02, 0.05, 0, -0.5, 0);

  // legs
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 0.095, -0.03, 0); hips.add(hip);
    const bt = bone(hip, 'leg');
    bt.add(tcyl(0.062, 0.088, 0.46, 12), pants, 0, -0.22, 0);
    bt.add(rbox(0.05, 0.13, 0.11, 0.01), pants, s * 0.075, -0.25, 0.0); // cargo pocket
    if (s < 0 && L.vest === 'plate' && r() < 0.55) { bt.add(rbox(0.05, 0.16, 0.08), gear, -0.09, -0.12, 0.01); bt.add(rbox(0.04, 0.14, 0.12), SH.polymer, -0.105, -0.05, 0.02); } // drop-leg holster with pistol
    const knee = new THREE.Group(); knee.position.set(0, -0.45, 0); hip.add(knee);
    const bs = bone(knee, 'leg');
    bs.add(tcyl(0.046, 0.061, 0.42, 12), pants, 0, -0.2, 0);
    bs.add(rbox(0.1, 0.12, 0.05, 0.02), SH.black, 0, -0.02, 0.055, -0.1, 0, 0); // knee pad
    bs.add(tcyl(0.052, 0.055, 0.12, 12), boot, 0, -0.38, 0.0);
    bs.add(rbox(0.105, 0.085, 0.27, 0.03), boot, 0, -0.445, 0.045);
    bs.add(rbox(0.11, 0.025, 0.28, 0.01), SH.sole, 0, -0.495, 0.045);
    legs.push({ hip, knee });
  }

  // torso
  const bt = bone(spine, 'body');
  bt.add(tcyl(0.145, 0.185, 0.48, 16), shirt, 0, 0.24, 0, 0, 0, 0, 1, 1, 0.64);
  bt.add(sph(0.16, 14, 10), shirt, 0, 0.4, 0.0, 0, 0, 0, 1.15, 0.62, 0.72);
  for (const s of [-1, 1]) bt.add(sph(0.068, 12, 8), shirt, s * 0.185, 0.45, 0);
  bt.add(tcyl(0.05, 0.055, 0.09, 12), skin, 0, 0.53, 0.01);
  const plate = L.vest === 'plate';
  if (plate) {
    bt.add(rbox(0.31, 0.34, 0.055, 0.02), gear, 0, 0.32, 0.125, 0.05);
    bt.add(rbox(0.31, 0.36, 0.05, 0.02), gear, 0, 0.32, -0.125, -0.04);
    bt.add(tcyl(0.165, 0.17, 0.15, 18), gear, 0, 0.17, 0, 0, 0, 0, 1.05, 1, 0.82); // cummerbund
    for (const s of [-1, 1]) bt.add(rbox(0.07, 0.03, 0.26, 0.01), gear, s * 0.12, 0.505, 0, 0, 0, s * 0.18);
  } else {
    bt.add(rbox(0.3, 0.16, 0.05, 0.015), gear, 0, 0.24, 0.115, 0.08);
    for (const s of [-1, 1]) { bt.add(rbox(0.05, 0.025, 0.3, 0.008), SH.webbing, s * 0.1, 0.42, 0, 0.0, 0, s * 0.25); bt.add(rbox(0.05, 0.3, 0.02, 0.008), SH.webbing, s * 0.09, 0.32, -0.11, 0, 0, s * 0.12); }
  }
  const nMag = plate ? pick(r, [3, 3, 2]) : 4;
  for (let i = 0; i < nMag; i++) {
    const x = (i - (nMag - 1) / 2) * 0.075, y = plate ? 0.2 : 0.21;
    bt.add(rbox(0.068, 0.12, 0.05, 0.012), gear, x, y, plate ? 0.17 : 0.155);
    bt.add(rbox(0.066, 0.03, 0.054, 0.008), gear, x, y + 0.055, plate ? 0.172 : 0.157, -0.15);
  }
  if (plate) { bt.add(rbox(0.16, 0.08, 0.035, 0.01), gear, 0, 0.33, 0.165); bt.add(rbox(0.07, 0.045, 0.01, 0.004), cmat('flagpatch', () => new THREE.MeshStandardMaterial({ map: flagTex(), roughness: 0.8 })), 0.05, 0.345, 0.184); }
  bt.add(rbox(0.06, 0.09, 0.04), gear, -0.17, 0.2, 0.06, 0, 0.7, 0); // side pouch
  if (L.pack === 'assault') { bt.add(rbox(0.28, 0.34, 0.13, 0.03), gear, 0, 0.3, -0.21); bt.add(rbox(0.22, 0.12, 0.05, 0.02), gear, 0, 0.22, -0.29); }
  else if (L.pack === 'hydration') bt.add(rbox(0.22, 0.3, 0.07, 0.025), gear, 0, 0.33, -0.175);
  else if (L.pack === 'radio') {
    bt.add(rbox(0.09, 0.2, 0.07, 0.012), SH.black, -0.08, 0.33, -0.18); bt.add(rbox(0.09, 0.2, 0.07, 0.012), gear, 0.06, 0.3, -0.18);
    bt.add(tcyl(0.004, 0.006, 0.55, 5), SH.black, -0.1, 0.65, -0.19, 0.1, 0, 0.12);
  }
  if (r() < 0.5) { bt.add(tcyl(0.012, 0.012, 0.11, 8), SH.black, -0.11, 0.47, 0.12, 0.3, 0, 0); bt.add(rbox(0.03, 0.05, 0.02), SH.black, -0.1, 0.43, 0.14); } // PTT/flashlight on strap

  // head
  const head = new THREE.Group(); head.position.set(0, 0.12, 0.0); neck.add(head);
  const bh = bone(head, 'head');
  bh.add(sph(0.104, 20, 16), face, 0, 0, 0, 0, 0, 0, 0.9, 1.08, 1.0);
  bh.add(sph(0.075, 14, 10), L.head === 'balaclava' ? gear : skin, 0, -0.06, 0.035, 0, 0, 0, 1, 0.75, 0.9); // jaw
  bh.add(rbox(0.024, 0.045, 0.03, 0.01), L.head === 'balaclava' ? gear : skin, 0, -0.012, 0.102, -0.2); // nose
  for (const s of [-1, 1]) bh.add(sph(0.022, 8, 6), L.head === 'balaclava' ? gear : skin, s * 0.093, 0.0, 0, 0, 0, 0, 0.45, 1, 0.8);
  if (L.beard === 'full' && L.head !== 'balaclava') bh.add(sph(0.088, 14, 10, Math.PI * 0.45, Math.PI * 0.55), hair, 0, -0.035, 0.035, 0, 0, 0, 0.98, 1.05, 0.95);
  if (L.beard === 'short' && L.head !== 'balaclava') bh.add(sph(0.08, 14, 8, Math.PI * 0.55, Math.PI * 0.45), hair, 0, -0.045, 0.035, 0, 0, 0, 0.96, 0.9, 0.95);
  const headset = () => { for (const s of [-1, 1]) { bh.add(tcyl(0.038, 0.038, 0.035, 14), SH.black, s * 0.1, -0.005, 0.0, 0, 0, Math.PI / 2); } bh.add(new THREE.TorusGeometry(0.108, 0.008, 5, 18, Math.PI), SH.black, 0, 0.0, -0.005); };
  const hd = L.head;
  if (hd.startsWith('helmet')) {
    bh.add(sph(0.128, 20, 10, 0, Math.PI * 0.5), helm, 0, 0.012, -0.004, -0.12, 0, 0, 0.98, 1.0, 1.05);
    bh.add(tcyl(0.124, 0.127, 0.03, 20), helm, 0, 0.012, -0.004, -0.12, 0, 0, 0.98, 1, 1.05);
    for (const s of [-1, 1]) bh.add(rbox(0.02, 0.03, 0.12, 0.006), SH.black, s * 0.122, 0.035, 0.0, -0.12);
    bh.add(rbox(0.05, 0.035, 0.02, 0.008), SH.black, 0, 0.09, 0.115, -0.5); // NVG shroud
    bh.add(rbox(0.07, 0.05, 0.03, 0.01), SH.black, 0, 0.07, -0.13, 0.4); // counterweight
    bh.add(rbox(0.04, 0.03, 0.01, 0.004), band, 0, 0.11, -0.105, 0.9); // IR / team patch
    headset();
    if (hd === 'helmetNvg') { for (const s of [-1, 1]) bh.add(tcyl(0.016, 0.018, 0.06, 10), SH.black, s * 0.022, 0.135, 0.11, -1.2); bh.add(rbox(0.07, 0.03, 0.04), SH.black, 0, 0.125, 0.12, -0.6); }
  } else if (hd === 'boonie') {
    bh.add(tcyl(0.108, 0.116, 0.075, 18), shirt, 0, 0.085, -0.005); bh.add(sph(0.108, 16, 6, 0, Math.PI / 2), shirt, 0, 0.12, -0.005, 0, 0, 0, 1, 0.35, 1);
    bh.add(tcyl(0.19, 0.19, 0.008, 22), shirt, 0, 0.05, -0.005, 0.04); bh.add(tcyl(0.118, 0.118, 0.02, 18), gear, 0, 0.065, -0.005);
  } else if (hd === 'cap') {
    bh.add(sph(0.11, 18, 8, 0, Math.PI / 2), helm, 0, 0.025, -0.004, -0.1, 0, 0, 1, 0.95, 1.05);
    bh.add(rbox(0.13, 0.012, 0.08, 0.005), helm, 0, 0.04, 0.115, -0.25);
    headset();
  } else if (hd === 'bare') {
    bh.add(sph(0.108, 18, 8, 0, Math.PI * 0.48), hair, 0, 0.012, -0.008, -0.15, 0, 0, 0.92, 1.05, 1.03);
    headset();
  } else if (hd === 'balaclava') {
    bh.add(sph(0.108, 18, 10, 0, Math.PI * 0.5), gear, 0, 0.01, -0.005, -0.1, 0, 0, 0.92, 1.05, 1.03);
    if (r() < 0.6) { bh.add(sph(0.128, 20, 10, 0, Math.PI * 0.5), helm, 0, 0.012, -0.004, -0.12, 0, 0, 0.98, 1.0, 1.05); bh.add(rbox(0.04, 0.03, 0.01, 0.004), band, 0, 0.11, -0.105, 0.9); }
  }
  if (L.eyes === 'shades' || L.eyes === 'clear') bh.add(new THREE.CylinderGeometry(0.103, 0.103, 0.032, 18, 1, true, -0.85, 1.7), L.eyes === 'shades' ? SH.lens : SH.clearLens, 0, 0.012, 0.0, 0, 0, 0, 0.92, 1, 1.02);
  if (L.eyes === 'goggles') { bh.add(new THREE.CylinderGeometry(0.108, 0.108, 0.05, 18, 1, true, -0.9, 1.8), SH.lens, 0, 0.01, 0.0, 0, 0, 0, 0.94, 1, 1.04); bh.add(new THREE.TorusGeometry(0.11, 0.007, 4, 20), SH.black, 0, 0.012, -0.003, Math.PI / 2, 0, 0, 0.93, 1.02, 1); }

  // arms (IK)
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(s * 0.19, 0.45, 0); spine.add(sh);
    const bu = bone(sh, 'body');
    bu.add(tcyl(0.045, 0.054, L1, 12), shirt, 0, -L1 / 2, 0);
    if (s === 1) bu.add(tcyl(0.057, 0.057, 0.045, 12), band, 0, -0.08, 0);
    if (r() < 0.5) bu.add(rbox(0.012, 0.05, 0.06, 0.004), cmat('flagpatch', () => new THREE.MeshStandardMaterial({ map: flagTex(), roughness: 0.8 })), s * 0.052, -0.1, 0, 0, 0, 0);
    const el = new THREE.Group(); el.position.set(0, -L1, 0); sh.add(el);
    const bf = bone(el, 'body');
    const rolled = L.sleeves === 'rolled';
    bf.add(tcyl(0.034, 0.045, 0.25, 12), rolled ? skin : shirt, 0, -0.125, 0);
    if (rolled) bf.add(tcyl(0.05, 0.05, 0.04, 12), shirt, 0, -0.01, 0);
    bf.add(rbox(0.05, 0.085, 0.08, 0.018), glove, 0, -0.285, 0.0);
    bf.add(rbox(0.022, 0.05, 0.022, 0.008), glove, -s * 0.03, -0.27, 0.03, 0.4);
    arms.push({ sh, el, side: s });
  }

  // weapons (only the one in hand is shown)
  const gun = new THREE.Group(); spine.add(gun);
  const guns = [buildCarbine(L, gunMat), buildMarksman(L, gunMat), buildPistol()];
  for (const gw of guns) { gw.g.visible = false; gun.add(gw.g); gw.g.traverse(o => { if (o.isMesh) { o.castShadow = true; } }); }
  guns[0].g.visible = true;

  for (const b of bones) b.build(hit);
  g.traverse(o => { if (o.isMesh) o.userData.op = true; });
  return {
    g, body, hips, spine, neck, head, legs, arms, gun, guns, hit, band, look: L,
    w: 0, phase: 0, aim: 1, recoil: 0, flinch: 0, flinchDir: 1, reloadT: -1, deadT: -1, fallDir: 1, idleT: Math.random() * 10,
    muzzleLocal: new V3()
  };
}
function flagTex() {
  return canvasTex('flagpatch', 64, (g, W, H) => {
    const b = '#0d5eaf', s = H / 9; for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? '#eeeeea' : b; g.fillRect(0, i * s, W, s + 0.5); }
    const k = s * 5; g.fillStyle = b; g.fillRect(0, 0, k, k); g.fillStyle = '#eeeeea'; g.fillRect(k * 0.4, 0, k * 0.2, k); g.fillRect(0, k * 0.4, k, k * 0.2);
  }, true, 96);
}
function gpart(grp, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); grp.add(m); return m; }
// Third-person rifles. Local frame: +z = muzzle, origin at the trigger. grip/fore = hand points.
function buildCarbine(L, mat) {
  const g = new THREE.Group();
  gpart(g, rbox(0.045, 0.07, 0.3, 0.008), SH.metal, 0, 0.0, 0.02);
  gpart(g, rbox(0.05, 0.06, 0.28, 0.01), mat, 0, 0.005, 0.3);
  gpart(g, rbox(0.032, 0.13, 0.07, 0.008), SH.polymer, 0, -0.09, 0.08, 0.2);
  gpart(g, rbox(0.03, 0.09, 0.04, 0.008), SH.polymer, 0, -0.07, -0.06, -0.35);
  gpart(g, rbox(0.04, 0.07, 0.17, 0.012), mat, 0, -0.01, -0.22);
  gpart(g, rbox(0.045, 0.1, 0.03, 0.008), SH.polymer, 0, -0.02, -0.31);
  gpart(g, new THREE.CylinderGeometry(0.009, 0.009, 0.14, 8).rotateX(Math.PI / 2), SH.metal, 0, 0, 0.5);
  if (L.gun.supp) gpart(g, new THREE.CylinderGeometry(0.019, 0.019, 0.17, 12).rotateX(Math.PI / 2), SH.metal, 0, 0, 0.62);
  else gpart(g, new THREE.CylinderGeometry(0.013, 0.011, 0.05, 8).rotateX(Math.PI / 2), SH.metal, 0, 0, 0.59);
  gpart(g, rbox(0.022, 0.012, 0.42, 0.004), SH.metal, 0, 0.042, 0.12);
  if (L.gun.optic === 'lpvo') { gpart(g, new THREE.CylinderGeometry(0.018, 0.018, 0.2, 12).rotateX(Math.PI / 2), SH.black, 0, 0.075, 0.04); gpart(g, new THREE.CylinderGeometry(0.024, 0.024, 0.04, 12).rotateX(Math.PI / 2), SH.black, 0, 0.075, 0.14); }
  else if (L.gun.optic === 'holo') { gpart(g, rbox(0.04, 0.045, 0.08, 0.006), SH.black, 0, 0.07, 0.02); gpart(g, new THREE.PlaneGeometry(0.03, 0.03), SH.lens, 0, 0.075, 0.061); }
  else gpart(g, new THREE.CylinderGeometry(0.017, 0.017, 0.05, 12).rotateX(Math.PI / 2), SH.black, 0, 0.07, 0.03);
  if (L.seed % 2) gpart(g, rbox(0.025, 0.03, 0.06, 0.005), SH.black, 0.03, 0.0, 0.36); // light
  const muzzle = new V3(0, 0, L.gun.supp ? 0.71 : 0.62);
  return { g, grip: new V3(0, -0.06, -0.06), fore: new V3(0, -0.035, 0.27), mag: new V3(0, -0.09, 0.08), muzzle, cheek: 0.07 };
}
function buildMarksman(L, mat) {
  const g = new THREE.Group();
  gpart(g, rbox(0.048, 0.075, 0.34, 0.008), SH.metal, 0, 0, 0.02);
  gpart(g, rbox(0.055, 0.065, 0.4, 0.012), mat, 0, 0.0, 0.38);
  gpart(g, rbox(0.032, 0.09, 0.08, 0.008), SH.polymer, 0, -0.07, 0.08, 0.1);
  gpart(g, rbox(0.03, 0.09, 0.04, 0.008), SH.polymer, 0, -0.07, -0.07, -0.35);
  gpart(g, rbox(0.045, 0.09, 0.24, 0.012), mat, 0, -0.02, -0.25);
  gpart(g, new THREE.CylinderGeometry(0.011, 0.011, 0.28, 8).rotateX(Math.PI / 2), SH.metal, 0, 0, 0.71);
  gpart(g, new THREE.CylinderGeometry(0.021, 0.021, 0.3, 14).rotateX(Math.PI / 2), SH.black, 0, 0.08, 0.04);
  gpart(g, new THREE.CylinderGeometry(0.029, 0.029, 0.07, 14).rotateX(Math.PI / 2), SH.black, 0, 0.08, 0.2);
  gpart(g, new THREE.CylinderGeometry(0.025, 0.025, 0.05, 14).rotateX(Math.PI / 2), SH.black, 0, 0.08, -0.12);
  gpart(g, new THREE.CircleGeometry(0.026, 14), SH.lens, 0, 0.08, 0.236);
  return { g, grip: new V3(0, -0.06, -0.07), fore: new V3(0, -0.035, 0.32), mag: new V3(0, -0.07, 0.08), muzzle: new V3(0, 0, 0.86), cheek: 0.08 };
}
function buildPistol() {
  const g = new THREE.Group();
  gpart(g, rbox(0.03, 0.035, 0.19, 0.006), SH.metal, 0, 0.03, 0.06);
  gpart(g, rbox(0.028, 0.03, 0.15, 0.006), SH.polymer, 0, 0.005, 0.05);
  gpart(g, rbox(0.03, 0.1, 0.05, 0.008), SH.polymer, 0, -0.045, -0.01, -0.25);
  return { g, grip: new V3(0, -0.03, -0.015), fore: new V3(0.0, -0.05, 0.0), mag: new V3(0, -0.09, -0.02), muzzle: new V3(0, 0.03, 0.16), cheek: 0, pistol: true };
}

// ---------------------------------------------------------------- posing
const _v = new V3(), _w = new V3(), _e = new V3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const DOWN = new V3(0, -1, 0);
function ik(arm, target, pole) {
  const S = arm.sh.position;
  _v.copy(target).sub(S); let d = _v.length();
  d = clamp(d, 0.08, L1 + L2 - 0.002); _v.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _w.copy(pole).addScaledVector(_v, -pole.dot(_v)).normalize();
  _e.copy(S).addScaledVector(_v, a).addScaledVector(_w, h); // elbow
  const dirU = _e.clone().sub(S).normalize();
  arm.sh.quaternion.setFromUnitVectors(DOWN, dirU);
  const hand = S.clone().addScaledVector(_v, d);
  const dirF = hand.sub(_e).normalize().applyQuaternion(_q2.copy(arm.sh.quaternion).invert());
  arm.el.quaternion.setFromUnitVectors(DOWN, dirF);
}
const gunPoint = (op, p, out) => out.copy(p).applyQuaternion(op.gun.quaternion).add(op.gun.position);
const poleR = new V3(), poleL = new V3();

// s: {vf, vs (local forward/side speed), crouch, pitch, sprint, aim, reload (0..1 or -1), rope, w, dt, moving}
export function poseOperator(op, s) {
  const dt = s.dt || 0.016; op.idleT += dt;
  if (op.w !== s.w) { op.guns.forEach((gw, i) => gw.g.visible = i === s.w); op.w = s.w; }
  if (op.deadT >= 0) return poseDead(op, dt);
  const sp = Math.hypot(s.vf, s.vs), amp = clamp(sp / 4.2, 0, 1.25), c = s.crouch;
  op.phase += sp * dt * 4.0;
  const ph = op.phase;
  const run = clamp((sp - 4.5) / 2.5, 0, 1);
  const fwdK = sp > 0.1 ? s.vf / sp : 1, sideK = sp > 0.1 ? s.vs / sp : 0;
  const rope = s.rope;
  // legs
  for (let i = 0; i < 2; i++) {
    const L = op.legs[i], p = ph + (i ? Math.PI : 0), side = i ? 1 : -1;
    if (rope) { const sw = Math.sin(op.idleT * 1.7 + i) * 0.12; L.hip.rotation.set(-0.35 + sw, 0, side * 0.08); L.knee.rotation.x = 0.55 + sw * 0.5; continue; }
    const swing = Math.sin(p) * (0.5 + run * 0.25) * amp;
    L.hip.rotation.x = -swing * fwdK - 1.1 * c - 0.15 * run;
    L.hip.rotation.z = side * 0.03 + swing * sideK * 0.45 * (i ? 1 : -1) * 0.5;
    L.knee.rotation.x = Math.max(0, Math.sin(p + 1.25)) * (0.9 + run * 0.6) * amp + 1.7 * c + 0.06;
  }
  // hips: bob, sway, crouch drop
  const bob = rope ? 0 : Math.abs(Math.cos(ph)) * 0.035 * amp;
  op.hips.position.y = 0.97 - 0.36 * c - bob + (rope ? 0 : 0.01 * Math.sin(op.idleT * 1.4));
  op.hips.position.x = rope ? 0 : Math.sin(ph) * 0.018 * amp;
  op.hips.rotation.y = Math.sin(ph) * 0.08 * amp * fwdK;
  op.hips.rotation.z = rope ? Math.sin(op.idleT * 1.3) * 0.05 : Math.sin(ph) * 0.03 * amp;
  // torso: aim pitch, forward lean when running/crouched, counter-rotation, breathing, flinch
  op.flinch = Math.max(0, op.flinch - dt * 4);
  op.recoil = Math.max(0, op.recoil - dt * 9);
  const pitch = clamp(s.pitch, -1.2, 1.2), breathe = Math.sin(op.idleT * 1.9) * 0.012;
  op.spine.rotation.x = -pitch * 0.62 + 0.18 * c + 0.22 * run + breathe - op.flinch * 0.25 * op.flinchDir;
  op.spine.rotation.y = -op.hips.rotation.y * 0.9 + (s.aim > 0.5 ? -0.08 : 0);
  op.spine.rotation.z = -op.hips.rotation.z * 0.8 + op.flinch * 0.12;
  op.neck.rotation.x = -pitch * 0.38 - 0.18 * run * 0.5 - 0.06 * c;
  op.neck.rotation.y = s.aim > 0.5 ? 0.12 : 0.0;
  // gun placement in spine space
  const gw = op.guns[s.w] || op.guns[0], pistol = !!gw.pistol;
  const aimK = rope ? 0 : clamp(s.aim, 0, 1), low = rope ? 0 : 1 - aimK;
  const G = op.gun; G.visible = true;
  if (rope) { G.position.set(0.02, 0.36, -0.2); G.rotation.set(1.3, 0, 0.6); }
  else if (pistol) { G.position.set(lerp(-0.05, -0.03, aimK), lerp(0.18, 0.42, aimK), lerp(0.28, 0.5, aimK)); G.rotation.set(lerp(0.9, 0, aimK), lerp(0.2, 0.06, aimK), 0); }
  else { G.position.set(lerp(-0.04, -0.105, aimK), lerp(0.26, 0.41, aimK), lerp(0.2, 0.24, aimK)); G.rotation.set(lerp(0.75, 0, aimK) + 0.0, lerp(0.55, 0.03, aimK), lerp(-0.25, 0, aimK)); }
  // recoil kick
  G.position.z -= op.recoil * 0.035; G.rotation.x -= op.recoil * 0.09;
  // reload: tilt the rifle, support hand goes to the mag then to a pouch
  let fore = gw.fore, reloadHand = null;
  if (s.reload >= 0 && !rope) {
    const k = s.reload, tilt = Math.sin(clamp(k * 1.15, 0, 1) * Math.PI);
    G.rotation.z += 0.55 * tilt; G.rotation.x += 0.35 * tilt; G.position.y -= 0.04 * tilt;
    if (k > 0.12 && k < 0.78) {
      const toPouch = smooth((k - 0.22) / 0.14) * (1 - smooth((k - 0.45) / 0.16));
      gunPoint(op, gw.mag, _v);
      reloadHand = _v.clone().lerp(new V3(0.07, 0.2, 0.2), toPouch);
    }
  }
  G.updateMatrix();
  // arm IK: right arm (side -1, index 0) holds the grip, left arm (side +1) the handguard
  poleR.set(-0.8, -0.5, -0.35).normalize(); poleL.set(0.9, -0.6, -0.1).normalize();
  if (rope) {
    const sway = Math.sin(op.idleT * 1.6) * 0.02;
    ik(op.arms[0], new V3(-0.02 + sway, 1.02, 0.08), new V3(-1, 0, 0.2).normalize());
    ik(op.arms[1], new V3(0.03 + sway, 1.2, 0.08), new V3(1, 0, 0.2).normalize());
  } else {
    const gripP = gunPoint(op, gw.grip, new V3());
    const foreP = reloadHand || gunPoint(op, pistol ? gw.fore : fore, new V3());
    if (pistol) poleL.set(0.7, -0.7, 0.1).normalize();
    ik(op.arms[0], gripP, poleR);
    ik(op.arms[1], foreP, poleL);
  }
}
function poseDead(op, dt) {
  op.deadT += dt;
  const k1 = smooth(op.deadT / 0.35), k2 = smooth((op.deadT - 0.15) / 0.65);
  op.hips.position.y = lerp(0.97, 0.55, k1) * (1 - k2) + 0.16 * k2;
  for (let i = 0; i < 2; i++) { op.legs[i].hip.rotation.x = lerp(op.legs[i].hip.rotation.x, -0.9 * (1 - k2) - 0.1, Math.min(1, dt * 8)); op.legs[i].knee.rotation.x = lerp(op.legs[i].knee.rotation.x, 1.3 * (1 - k2) + 0.2, Math.min(1, dt * 8)); }
  op.spine.rotation.x = lerp(op.spine.rotation.x, op.fallDir * 0.2, Math.min(1, dt * 5));
  op.g.rotation.x = op.fallDir * k2 * Math.PI / 2 * 0.94;
  op.neck.rotation.x = lerp(op.neck.rotation.x, op.fallDir * 0.4, Math.min(1, dt * 4));
  for (const a of op.arms) { a.sh.rotation.set(lerp(a.sh.rotation.x, -0.6 * op.fallDir, dt * 3), 0, a.side * lerp(0.2, 1.1, k2)); a.el.rotation.set(-0.4, 0, 0); }
  op.gun.position.lerp(new V3(-0.25, 0.1, 0.35), Math.min(1, dt * 4)); op.gun.rotation.x += dt * 2 * (1 - k2);
}
export function killOperator(op, fallDir) { op.deadT = 0; op.fallDir = fallDir; }
export function reviveOperator(op) {
  op.deadT = -1; op.g.rotation.x = 0; op.g.visible = true; op.gun.visible = true;
  for (const a of op.arms) { a.sh.quaternion.identity(); a.el.quaternion.identity(); }
}
export function muzzleWorld(op, out) {
  const gw = op.guns[op.w] || op.guns[0];
  op.g.updateMatrixWorld(true);
  return out.copy(gw.muzzle).applyMatrix4(gw.g.matrixWorld);
}
