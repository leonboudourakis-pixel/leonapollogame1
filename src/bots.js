// Bot soldiers. One player's browser (the host when present) runs every bot and reports their moves,
// shots and hits to the match like a player would. Bots navigate a grid built from the level
// colliders, patrol hiding spots, react to gunfire, and aim with human-like delay and error.
import * as THREE from './vendor/three.module.js';
const V3 = THREE.Vector3;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t, R = (a, b) => a + (b - a) * Math.random();
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

// ---------------------------------------------------------------- hit shapes (for bot shots at anyone)
// Each combatant is a head sphere, a torso capsule and a legs capsule. Returns {t, part} or null.
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z, b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r, h = b * b - cc;
  if (h < 0) return -1; const t = -b - Math.sqrt(h); return t > 0 ? t : -1;
}
function rayCapsuleY(o, d, x, z, y0, y1, r) { // vertical capsule
  const ox = o.x - x, oz = o.z - z, a = d.x * d.x + d.z * d.z;
  let best = -1;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z, c = ox * ox + oz * oz - r * r, h = b * b - a * c;
    if (h >= 0) { const t = (-b - Math.sqrt(h)) / a, y = o.y + d.y * t; if (t > 0 && y >= y0 && y <= y1) best = t; }
  }
  for (const yc of [y0, y1]) { const t = raySphere(o, d, { x, y: yc, z }, r); if (t > 0 && (best < 0 || t < best)) best = t; }
  return best;
}
export function hitShapes(c) {
  const p = c.pos, k = c.crouch || 0;
  return { head: new V3(p.x, p.y + 1.66 - 0.5 * k, p.z), t0: p.y + 1.0 - 0.38 * k, t1: p.y + 1.45 - 0.48 * k, l1: p.y + 0.9 - 0.36 * k };
}
export function rayCombatants(o, d, maxT, list, exceptId) {
  let best = maxT, hit = null;
  for (const c of list) {
    if (!c.alive || c.id === exceptId) continue;
    const s = hitShapes(c);
    const th = raySphere(o, d, s.head, 0.13); if (th > 0 && th < best) { best = th; hit = { c, t: th, part: 'head' }; }
    const tb = rayCapsuleY(o, d, c.pos.x, c.pos.z, s.t0, s.t1, 0.21); if (tb > 0 && tb < best) { best = tb; hit = { c, t: tb, part: 'body' }; }
    const tl = rayCapsuleY(o, d, c.pos.x, c.pos.z, c.pos.y + 0.12, s.l1, 0.15); if (tl > 0 && tl < best) { best = tl; hit = { c, t: tl, part: 'leg' }; }
  }
  return hit;
}

// ---------------------------------------------------------------- navigation grid
const CELL = 0.5;
export class NavGrid {
  constructor(colliders, b) { // b: {x0,x1,z0,z1}
    this.x0 = b.x0; this.z0 = b.z0; this.nx = Math.ceil((b.x1 - b.x0) / CELL); this.nz = Math.ceil((b.z1 - b.z0) / CELL);
    this.block = new Uint8Array(this.nx * this.nz); this.roof = new Uint8Array(this.nx * this.nz);
    const rad = 0.42;
    for (const c of colliders) {
      if (c.min[1] > 1.75) { // roofs and upper floors: mark as covered
        if (c.max[0] - c.min[0] > 2 && c.max[2] - c.min[2] > 2 && c.min[1] < 8) this.mark(c, 0, this.roof);
        continue;
      }
      if (c.max[1] <= 0.45) continue;
      this.mark(c, rad, this.block);
    }
    for (let i = 0; i < this.nx; i++) { this.block[i] = 1; this.block[(this.nz - 1) * this.nx + i] = 1; }
    for (let j = 0; j < this.nz; j++) { this.block[j * this.nx] = 1; this.block[j * this.nx + this.nx - 1] = 1; }
    this.open = []; this.covered = [];
    for (let j = 2; j < this.nz - 2; j++) for (let i = 2; i < this.nx - 2; i++) { const k = j * this.nx + i; if (!this.block[k]) { this.open.push(k); if (this.roof[k]) this.covered.push(k); } }
    this.g = new Float32Array(this.nx * this.nz); this.from = new Int32Array(this.nx * this.nz); this.stamp = new Uint32Array(this.nx * this.nz); this.run = 1;
  }
  mark(c, rad, arr) {
    const i0 = Math.max(0, Math.floor((c.min[0] - rad - this.x0) / CELL)), i1 = Math.min(this.nx - 1, Math.floor((c.max[0] + rad - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((c.min[2] - rad - this.z0) / CELL)), j1 = Math.min(this.nz - 1, Math.floor((c.max[2] + rad - this.z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.x0 + (i + 0.5) * CELL, z = this.z0 + (j + 0.5) * CELL;
      const dx = Math.max(c.min[0] - x, 0, x - c.max[0]), dz = Math.max(c.min[2] - z, 0, z - c.max[2]);
      if (dx * dx + dz * dz < rad * rad || rad === 0 && dx === 0 && dz === 0) arr[j * this.nx + i] = 1;
    }
  }
  cellOf(x, z) { const i = clamp(Math.floor((x - this.x0) / CELL), 0, this.nx - 1), j = clamp(Math.floor((z - this.z0) / CELL), 0, this.nz - 1); return j * this.nx + i; }
  center(k, out = new V3()) { return out.set(this.x0 + (k % this.nx + 0.5) * CELL, 0, this.z0 + (Math.floor(k / this.nx) + 0.5) * CELL); }
  free(k) { return k >= 0 && k < this.block.length && !this.block[k]; }
  nearestFree(k) {
    if (this.free(k)) return k;
    const i0 = k % this.nx, j0 = Math.floor(k / this.nx);
    for (let rr = 1; rr < 8; rr++) for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue;
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
      const kk = j * this.nx + i; if (this.free(kk)) return kk;
    }
    return -1;
  }
  walkable(a, b) { // straight segment stays on free cells
    const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / (CELL * 0.5));
    for (let i = 1; i <= n; i++) { const t = i / n; if (!this.free(this.cellOf(lerp(a.x, b.x, t), lerp(a.z, b.z, t)))) return false; }
    return true;
  }
  path(from, to) {
    let s = this.nearestFree(this.cellOf(from.x, from.z)), e = this.nearestFree(this.cellOf(to.x, to.z));
    if (s < 0 || e < 0) return null;
    const nx = this.nx, run = ++this.run, G = this.g, F = this.from, ST = this.stamp;
    const ex = e % nx, ez = Math.floor(e / nx);
    const heap = [], push = (k, f) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const h = k => { const dx = Math.abs(k % nx - ex), dz = Math.abs(Math.floor(k / nx) - ez); return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz); };
    ST[s] = run; G[s] = 0; F[s] = -1; push(s, h(s));
    let iter = 0, found = false;
    while (heap.length && iter++ < 12000) {
      const [, k] = pop(); if (k === e) { found = true; break; }
      const i = k % nx, j = Math.floor(k / nx);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= this.nz) continue;
        const kk = jj * nx + ii; if (this.block[kk]) continue;
        if (di && dj && (this.block[j * nx + ii] || this.block[jj * nx + i])) continue;
        const ng = G[k] + (di && dj ? Math.SQRT2 : 1);
        if (ST[kk] === run && G[kk] <= ng) continue;
        ST[kk] = run; G[kk] = ng; F[kk] = k; push(kk, ng + h(kk));
      }
    }
    if (!found) return null;
    const cells = []; for (let k = e; k !== -1; k = F[k]) cells.push(k); cells.reverse();
    const pts = cells.map(k => this.center(k));
    // string-pull: keep only the turns
    const out = []; let cur = from.clone(), i = 0;
    while (i < pts.length - 1) { let j = pts.length - 1; while (j > i + 1 && !this.walkable(cur, pts[j])) j--; out.push(pts[j]); cur = pts[j]; i = j; }
    if (!out.length) out.push(pts[pts.length - 1]);
    return out;
  }
  randomOpen(covered = false) { const list = covered && this.covered.length ? this.covered : this.open; return this.center(list[Math.floor(Math.random() * list.length)]); }
}

// ---------------------------------------------------------------- the brain
const SKILL = [
  { react: [0.55, 0.95], err: 0.075, turn: 3.6, head: 0.06, pause: [0.35, 0.8], burst: [2, 4], track: 0.9 },
  { react: [0.33, 0.62], err: 0.045, turn: 5.0, head: 0.16, pause: [0.22, 0.55], burst: [3, 6], track: 1.4 },
  { react: [0.2, 0.4], err: 0.026, turn: 7.0, head: 0.3, pause: [0.15, 0.38], burst: [3, 7], track: 2.2 }
];
export class Bot {
  constructor(id, look, ctx) {
    this.id = id; this.ctx = ctx; this.pos = new V3(); this.vel = new V3(); this.yaw = 0; this.pitch = 0; this.crouch = 0; this.crouching = false;
    this.alive = false; this.team = -1;
    const r = (n => () => (n = (n * 16807) % 2147483647) / 2147483647)(look * 977 + 11);
    this.pers = { aggro: 0.3 + r() * 0.7, crouchy: r(), speed: 0.92 + r() * 0.14, marksman: r() < 0.25, strafe: 0.4 + r() * 0.6, campy: r() };
    this.w = this.pers.marksman ? 1 : 0; this.mag = 0; this.reloadT = 0; this.fireCD = 0; this.burst = 0; this.pauseT = 0;
    this.path = null; this.goal = null; this.goalT = 0; this.mode = 'patrol'; this.thinkT = 0; this.seeT = 0;
    this.target = null; this.spotAt = 0; this.trackT = 0; this.lastSeen = null; this.lastSeenT = -99; this.heard = null;
    this.errX = 0; this.errY = 0; this.errVX = 0; this.errVY = 0; this.strafeT = 0; this.strafeDir = 1; this.stuckT = 0; this.stuckPos = new V3();
    this.lookYaw = 0; this.waitT = 0; this.stepAcc = 0; this.flags = 0; this.onGround = true; this.vy = 0;
  }
  spawn(x, z) {
    this.pos.set(x, 0, z); this.vel.set(0, 0, 0); this.alive = true; this.yaw = Math.atan2(x, z); this.pitch = 0; this.path = null; this.goal = null; this.target = null;
    this.mode = 'patrol'; this.mag = this.ctx.weapons[this.w].mag; this.reloadT = 0; this.lastSeen = null; this.heard = null; this.crouching = false; this.vy = 0;
  }
  hear(p, fromId) {
    if (!this.alive || this.target) return;
    const d = p.distanceTo(this.pos); if (d > 55) return;
    this.heard = { p: p.clone(), t: this.ctx.now(), id: fromId };
  }
  hurtBy(pos) { if (!this.alive) return; if (pos && !this.target) { this.heard = { p: pos.clone(), t: this.ctx.now() }; this.lookYaw = Math.atan2(-(pos.x - this.pos.x), -(pos.z - this.pos.z)); } this.trackT *= 0.5; }
  eye() { return new V3(this.pos.x, this.pos.y + 1.6 - 0.5 * this.crouch, this.pos.z); }
  update(dt, combatants, skillN) {
    if (!this.alive) return null;
    const S = SKILL[skillN] || SKILL[1], ctx = this.ctx, now = ctx.now(), W = ctx.weapons[this.w];
    let event = null;
    // ---------------- perception (a few times a second)
    this.seeT -= dt;
    if (this.seeT <= 0) {
      this.seeT = R(0.12, 0.22);
      const eye = this.eye(); let best = null, bestD = 1e9;
      for (const c of combatants) {
        if (!c.alive || c.id === this.id || (this.team >= 0 && c.team === this.team)) continue;
        const to = c.pos.clone().sub(this.pos), d = to.length(); if (d > 95) continue;
        const ang = Math.abs(angDiff(this.yaw, Math.atan2(-to.x, -to.z)));
        const fov = this.target && this.target.id === c.id ? 2.6 : 1.25;
        if (ang > fov && d > 5) continue;
        const chest = c.pos.clone(); chest.y += 1.25 - 0.4 * (c.crouch || 0);
        if (!ctx.los(eye, chest)) { const hd = c.pos.clone(); hd.y += 1.62 - 0.5 * (c.crouch || 0); if (!ctx.los(eye, hd)) continue; }
        const score = d * (c.id === (this.target && this.target.id) ? 0.6 : 1);
        if (score < bestD) { bestD = score; best = c; }
      }
      if (best) {
        if (!this.target || this.target.id !== best.id) { this.target = best; this.spotAt = now + R(S.react[0], S.react[1]) * (bestD > 40 ? 1.3 : 1); this.trackT = 0; }
        else this.target = best;
        this.lastSeen = best.pos.clone(); this.lastSeenT = now;
      } else if (this.target && now - this.lastSeenT > 0.6) this.target = null;
    }
    // ---------------- decide
    const tgt = this.target, engaged = tgt && now >= this.spotAt;
    if (engaged) this.mode = 'fight';
    else if (this.lastSeen && now - this.lastSeenT < 9) this.mode = 'hunt';
    else if (this.heard && now - this.heard.t < 10) this.mode = 'investigate';
    else this.mode = 'patrol';
    // ---------------- reload
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) this.mag = W.mag; }
    else if (this.mag <= 0 || (!engaged && this.mag < W.mag * 0.45 && Math.random() < dt)) { this.reloadT = W.reload * R(0.95, 1.12); event = { type: 'reload' }; }
    // ---------------- movement goal
    let wantX = 0, wantZ = 0, speed = 0;
    const moveTo = (p, sp) => {
      if (!this.goal || this.goal.distanceTo(p) > 2.5 || !this.path || now > this.goalT) { this.goal = p.clone(); this.goalT = now + 6; this.path = ctx.nav.path(this.pos, p); }
      if (!this.path || !this.path.length) return false;
      const wp = this.path[0]; const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.45) { this.path.shift(); return this.path.length > 0; }
      wantX = dx / d; wantZ = dz / d; speed = sp; return true;
    };
    if (this.mode === 'fight') {
      const toT = tgt.pos.clone().sub(this.pos), d = toT.length();
      this.strafeT -= dt; if (this.strafeT <= 0) { this.strafeT = R(0.5, 1.6); this.strafeDir = Math.random() < 0.5 ? -1 : 1; if (Math.random() < 0.35 * this.pers.crouchy) this.crouching = !this.crouching; if (Math.random() < 0.25) this.strafeDir = 0; }
      if (this.reloadT > 0 || d < 4) this.crouching = false;
      const rx = -toT.z / d, rz = toT.x / d; let mx = rx * this.strafeDir * this.pers.strafe, mz = rz * this.strafeDir * this.pers.strafe;
      if (d > 30 && this.pers.aggro > 0.6) { mx += toT.x / d * 0.7; mz += toT.z / d * 0.7; }
      if (d < 7) { mx -= toT.x / d * 0.6; mz -= toT.z / d * 0.6; }
      const l = Math.hypot(mx, mz); if (l > 0.05) { wantX = mx / l; wantZ = mz / l; speed = (this.crouching ? 1.6 : 2.6) * Math.min(1, l); }
      this.path = null;
    } else if (this.mode === 'hunt') { this.crouching = false; if (!moveTo(this.lastSeen, 4.6)) this.lastSeen = null; }
    else if (this.mode === 'investigate') { this.crouching = false; if (!moveTo(this.heard.p, 4.2)) this.heard = null; }
    else { // patrol between hiding spots, pausing to look around
      this.crouching = false;
      if (this.waitT > 0) { this.waitT -= dt; if (Math.random() < dt * 0.6) this.lookYaw += R(-1.5, 1.5); }
      else if (!this.goal || !this.path || !this.path.length) {
        if (this.goal && this.path && !this.path.length) { this.waitT = R(0.5, 3.5) * (0.4 + this.pers.campy); this.goal = null; this.crouching = Math.random() < 0.3 * this.pers.crouchy; }
        else { const p = Math.random() < 0.4 ? ctx.nav.randomOpen(true) : ctx.pickGoal(this); this.goal = null; moveTo(p, 3.6); }
      } else moveTo(this.goal, 3.6);
    }
    // ---------------- physics
    const sp = speed * this.pers.speed * (this.crouching ? 0.55 : 1) * (this.reloadT > 0 ? 0.8 : 1);
    this.vel.x = lerp(this.vel.x, wantX * sp, Math.min(1, dt * 7)); this.vel.z = lerp(this.vel.z, wantZ * sp, Math.min(1, dt * 7));
    const prevX = this.pos.x, prevZ = this.pos.z;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    ctx.collide(this.pos, 0.34, this.pos.y, this.pos.y + 1.8);
    for (const o of ctx.bots) if (o !== this && o.alive) { const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z, d2 = dx * dx + dz * dz; if (d2 < 0.5 && d2 > 1e-6) { const d = Math.sqrt(d2), k = (0.71 - d) / d * 0.5; this.pos.x += dx * k; this.pos.z += dz * k; } }
    const gy = ctx.groundAt(this.pos.x, this.pos.z, 0.34, this.pos.y);
    if (this.pos.y > gy + 0.02) { this.vy -= 22 * dt; this.pos.y = Math.max(gy, this.pos.y + this.vy * dt); } else { this.pos.y = gy; this.vy = 0; }
    ctx.clampPos(this.pos);
    const moved = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ);
    this.stepAcc += moved; if (this.stepAcc > 1.7 && !this.crouching && moved / dt > 2) { this.stepAcc = 0; event = event || { type: 'step' }; }
    // stuck check
    this.stuckT += dt;
    if (this.stuckT > 1.3) { if (speed > 0.5 && this.stuckPos.distanceTo(this.pos) < 0.35) { this.path = null; this.goal = null; this.strafeDir = -this.strafeDir; } this.stuckT = 0; this.stuckPos.copy(this.pos); }
    this.crouch = lerp(this.crouch, this.crouching ? 1 : 0, Math.min(1, dt * 8));
    // ---------------- aim
    let aimYaw, aimPitch;
    if (tgt && (this.mode === 'fight' || now >= this.spotAt - 0.25)) {
      const aimAt = tgt.pos.clone(); const head = Math.random() < S.head ? 1 : 0;
      aimAt.y += (head ? 1.62 : 1.25) - (head ? 0.5 : 0.4) * (tgt.crouch || 0);
      const e = this.eye(), dv = aimAt.sub(e), dh = Math.hypot(dv.x, dv.z);
      this.trackT += dt;
      // aim error: drifts smoothly, shrinks as he tracks, grows when the target moves fast or he moves
      const tv = tgt.vel ? Math.hypot(tgt.vel.x, tgt.vel.z) : 0, selfV = Math.hypot(this.vel.x, this.vel.z);
      const mag = S.err * (1.4 / (1 + this.trackT * S.track) + 0.35) * (1 + tv * 0.08 + selfV * 0.06) * (this.crouching ? 0.8 : 1);
      this.errVX += (R(-1, 1) * mag * 6 - this.errX * 3) * dt * 4; this.errVY += (R(-1, 1) * mag * 6 - this.errY * 3) * dt * 4;
      this.errVX *= 1 - dt * 3; this.errVY *= 1 - dt * 3;
      this.errX = clamp(this.errX + this.errVX * dt, -mag * 1.5, mag * 1.5); this.errY = clamp(this.errY + this.errVY * dt, -mag * 1.5, mag * 1.5);
      aimYaw = Math.atan2(-dv.x, -dv.z) + this.errX; aimPitch = Math.atan2(dv.y, dh) + this.errY;
    } else {
      const v = Math.hypot(this.vel.x, this.vel.z);
      if (this.mode !== 'patrol' && this.heard && !this.path) { const d = this.heard.p.clone().sub(this.pos); this.lookYaw = Math.atan2(-d.x, -d.z); }
      else if (v > 0.6 && this.waitT <= 0) this.lookYaw = Math.atan2(-this.vel.x, -this.vel.z);
      aimYaw = this.lookYaw; aimPitch = 0;
    }
    const turn = S.turn * dt;
    this.yaw += clamp(angDiff(this.yaw, aimYaw), -turn, turn);
    this.pitch += clamp(aimPitch - this.pitch, -turn * 0.7, turn * 0.7);
    // ---------------- shoot
    this.fireCD -= dt; this.pauseT -= dt;
    if (this.mode === 'fight' && this.reloadT <= 0 && this.mag > 0 && this.fireCD <= 0 && this.pauseT <= 0) {
      const off = Math.abs(angDiff(this.yaw, aimYaw)) + Math.abs(aimPitch - this.pitch);
      const dist = tgt.pos.distanceTo(this.pos);
      if (off < 0.06 + 0.6 / Math.max(4, dist)) {
        this.fireCD += 60 / W.rpm * R(0.97, 1.06) * (W.auto ? 1 : R(1.6, 2.6));
        if (this.fireCD < 0) this.fireCD = 0;
        this.mag--;
        if (W.auto) { if (this.burst <= 0) this.burst = Math.round(R(S.burst[0], S.burst[1]) * (dist > 35 ? 0.5 : 1)) + 1; this.burst--; if (this.burst <= 0) this.pauseT = R(S.pause[0], S.pause[1]) * (dist > 30 ? 1.5 : 1); }
        const e = this.eye(); const dir = new V3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
        const moving = Math.hypot(this.vel.x, this.vel.z);
        const spread = (W.bot || 0.012) * (1 + moving * 0.3) * (this.crouching ? 0.75 : 1);
        const ra = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread;
        const right = new V3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), up = new V3().crossVectors(right, dir);
        dir.addScaledVector(right, Math.cos(ra) * rr).addScaledVector(up, Math.sin(ra) * rr).normalize();
        event = { type: 'shot', o: e, dir, w: this.w };
      }
    }
    this.flags = (this.reloadT > 0 ? 1 : 0) | (this.mode === 'fight' ? 8 : 0) | (speed > 4.4 ? 4 : 0);
    return event;
  }
}
