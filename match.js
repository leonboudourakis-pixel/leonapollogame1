// Tidebreak match rules. Shared by the host server (server.js) and the browser's offline practice mode,
// so a match with bots plays the same online and offline.
'use strict';

// Spawn points on the ground (x, z). Compound x -42..42, dock yard x 42..70, pier x 46..62 out to z -64.
const SPAWNS = [
  [-29, -14], [-29, 0], [-28, 14], [-21, 21.5], [29, -14], [29, 2], [28, 12], [18, 23.5], [-12, -21.5], [12, -21.5],
  [-39, -20], [39, -20], [-38.5, 21], [38.5, 29.5], [-13, 33], [12, 34], [-39, 31], [37.5, 35.5], [-4, -12], [6, 11],
  [50, -8], [66, -20], [64, 8], [52, 30], [54, -33], [56, -61.5]
];
// Open ground where the rope helicopter can hover (x, z)
const ROPE_POINTS = [[8, -10], [-12, 29], [14, 29], [-37.5, -3], [37, 9.5], [-27, -11], [27, -9], [-6, 21], [56.5, -15], [62, 13]];
const BOT_NAMES = ['Achilles', 'Odysseus', 'Leonidas', 'Perseus', 'Hector', 'Ajax', 'Theseus', 'Jason', 'Herakles', 'Orion', 'Atlas', 'Castor', 'Kostas', 'Nikos', 'Yannis', 'Dimitris', 'Stavros', 'Alexandros', 'Giorgos', 'Spyros', 'Themistokles', 'Miltiades', 'Kanaris', 'Kolokotronis'];
const MAX_HP = 200; // players and bots; damage depends on where you are hit (see game.js)
const TEAM_NAMES = ['Poseidon', 'Ares'];
const MAX_BOTS = 6;
const ROPE_LIFE = 80000; // ms a rope helicopter visit lasts, from first sight to gone

const rand = (a, b) => a + (b - a) * Math.random();
const clean = s => String(s || 'Operator').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Operator';

class Match {
  constructor(o = {}) {
    this.killTarget = o.killTarget || 10;
    this.maxHumans = o.maxHumans || 4;
    this.log = o.log || (() => { });
    this.cfg = { mode: 'ffa', bots: 0, skill: 1 };
    this.players = new Map(); this.nextId = 1; this.over = false; this.teamKills = [0, 0];
    this.owner = 0; this.rope = null; this.ropeN = 0; this.nextRope = Date.now() + rand(45, 70) * 1000;
    this.names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    this.gen = 0;
    this.iv = setInterval(() => this.tick(), 200);
  }
  get target() { return this.cfg.mode === 'team' ? this.killTarget * 2 : this.killTarget; }
  humans() { return [...this.players.values()].filter(p => !p.bot); }
  bots() { return [...this.players.values()].filter(p => p.bot); }
  broadcast(m, except) { for (const p of this.players.values()) if (p !== except && p.send) p.send(m); }
  summary(p) { return { id: p.id, name: p.name, slot: p.slot, kills: p.kills, deaths: p.deaths, hp: Math.round(p.hp), alive: p.alive, bot: !!p.bot, team: p.team, look: p.look }; }
  roster() { return [...this.players.values()].map(p => this.summary(p)); }
  scoresMsg() { return { scores: this.roster(), teams: this.teamKills.slice() }; }
  setCfg(c) {
    c = c || {};
    this.cfg = {
      mode: c.mode === 'team' ? 'team' : 'ffa',
      bots: Math.max(0, Math.min(MAX_BOTS, Math.round(+c.bots || 0))),
      skill: Math.max(0, Math.min(2, Math.round(c.skill == null ? 1 : +c.skill)))
    };
  }

  // ---- roster: bot count, teams, who runs the bots
  sync() {
    const humans = this.humans();
    const want = humans.length ? this.cfg.bots : 0;
    let bots = this.bots();
    const fresh = [];
    while (bots.length > want) { const b = bots.pop(); this.players.delete(b.id); }
    const usedLooks = new Set(bots.map(b => b.look));
    while (bots.length < want) {
      let k = 0; while (usedLooks.has(10 + k)) k++; usedLooks.add(10 + k);
      const b = { id: this.nextId++, send: null, name: this.names[k % this.names.length], slot: -1, kills: 0, deaths: 0, hp: MAX_HP, alive: false, pos: null, lastHurt: 0, bot: true, team: -1, look: 10 + k };
      this.players.set(b.id, b); bots.push(b); fresh.push(b);
    }
    if (this.cfg.mode === 'team') {
      const cnt = [0, 0];
      for (const h of humans) if (h.team === 0 || h.team === 1) cnt[h.team]++;
      for (const h of humans) if (h.team !== 0 && h.team !== 1) { h.team = cnt[0] <= cnt[1] ? 0 : 1; cnt[h.team]++; }
      // humans may end up stacked after someone leaves; even them out
      while (Math.abs(cnt[0] - cnt[1]) > 1) { const from = cnt[0] > cnt[1] ? 0 : 1; const h = humans.reverse().find(x => x.team === from); h.team = 1 - from; cnt[from]--; cnt[1 - from]++; this.respawnSoon(h); }
      for (const b of bots) { const t = cnt[0] <= cnt[1] ? 0 : 1; cnt[t]++; if (b.team !== t) { const had = b.team; b.team = t; if (had >= 0 && b.alive) this.respawnSoon(b); } }
    } else for (const p of this.players.values()) p.team = -1;
    const host = humans.find(h => h.host) || humans.slice().sort((a, b) => a.id - b.id)[0];
    this.owner = host ? host.id : 0;
    return fresh;
  }
  pushRoster() { this.broadcast({ t: 'roster', players: this.roster(), cfg: this.cfg, target: this.target, owner: this.owner, teams: this.teamKills.slice() }); }
  respawnSoon(p) { p.alive = false; this.broadcast({ t: 'gone', id: p.id }); setTimeout(() => this.spawn(p), 1200); }

  join(name, send, isHost, cfg) {
    if (this.humans().length >= this.maxHumans) return null;
    const used = new Set(this.humans().map(p => p.slot)); let slot = 0; while (used.has(slot)) slot++;
    const p = { id: this.nextId++, send, name: clean(name), slot, kills: 0, deaths: 0, hp: MAX_HP, alive: false, pos: null, lastHurt: 0, bot: false, team: -1, look: slot, host: !!isHost };
    if (this.humans().length === 0) { this.over = false; this.teamKills = [0, 0]; }
    if (isHost && cfg) this.setCfg(cfg);
    this.players.set(p.id, p);
    const fresh = this.sync();
    send({ t: 'welcome', you: p.id, host: p.host, target: this.target, cfg: this.cfg, owner: this.owner, players: this.roster(), over: this.over, teams: this.teamKills.slice(), rope: this.rope ? { ...this.rope, age: Date.now() - this.rope.t0 } : null });
    this.broadcast({ t: 'roster', players: this.roster(), cfg: this.cfg, target: this.target, owner: this.owner, teams: this.teamKills.slice(), joined: p.id }, p);
    this.log(`  + ${p.name} joined (${this.humans().length}/${this.maxHumans})`);
    this.spawn(p);
    for (const b of fresh) this.spawn(b);
    return p;
  }
  leave(id) {
    const p = this.players.get(id); if (!p) return;
    this.players.delete(id);
    this.broadcast({ t: 'leave', id });
    this.log(`  - ${p.name} left (${this.humans().length}/${this.maxHumans})`);
    const fresh = this.sync();
    this.pushRoster();
    for (const b of fresh) this.spawn(b);
    if (!this.humans().length) { this.over = false; this.rope = null; }
  }
  applyCfg(c) {
    this.setCfg(c);
    for (const h of this.humans()) h.team = -1;
    this.sync();
    this.restart(true);
  }

  pickSpawn(p) {
    let best = 0, bestD = -1;
    SPAWNS.forEach((s, i) => {
      let d = 1e9, crowd = 0, pull = 0;
      for (const o of this.players.values()) {
        if (o === p || !o.alive || !o.pos) continue;
        const dd = Math.hypot(o.pos[0] - s[0], o.pos[2] - s[1]);
        if (dd < 3) crowd++;
        const enemy = this.cfg.mode !== 'team' || o.team !== p.team;
        if (enemy) d = Math.min(d, dd);
        else pull += Math.max(0, 25 - dd) * 0.3; // a little pull toward teammates
      }
      if (d > 200) d = 200;
      d += pull + Math.random() * 8 - crowd * 50;
      if (d > bestD) { bestD = d; best = i; }
    });
    return best;
  }
  spawn(p) {
    if (!this.players.has(p.id) || p.alive) return;
    const s = this.pickSpawn(p);
    p.hp = MAX_HP; p.alive = true; p.pos = [SPAWNS[s][0], 0, SPAWNS[s][1]]; p.lastHurt = 0;
    this.broadcast({ t: 'spawn', id: p.id, s });
  }
  enemies(a, b) { return a !== b && (this.cfg.mode !== 'team' || a.team !== b.team); }
  damage(t, dmg, from, head, w, cause) {
    if (!t || !t.alive || this.over) return;
    t.hp -= dmg; t.lastHurt = Date.now();
    this.broadcast({ t: 'hp', id: t.id, hp: Math.max(0, Math.round(t.hp)), from: from ? from.id : 0, dmg });
    if (t.hp > 0) return;
    t.alive = false; t.deaths++;
    const credit = from && from !== t;
    if (credit) { from.kills++; if (from.team === 0 || from.team === 1) this.teamKills[from.team]++; }
    this.broadcast({ t: 'kill', killer: credit ? from.id : 0, victim: t.id, head: !!head, w, ...(cause ? { cause } : {}), ...this.scoresMsg() });
    const won = credit && (this.cfg.mode === 'team' ? this.teamKills[from.team] >= this.target : from.kills >= this.target);
    if (won) {
      this.over = true; const g = this.gen;
      this.broadcast({ t: 'end', winner: from.id, team: this.cfg.mode === 'team' ? from.team : -1, ...this.scoresMsg() });
      this.log(this.cfg.mode === 'team' ? `  ★ Team ${TEAM_NAMES[from.team]} wins the match` : `  ★ ${from.name} wins the match`);
      setTimeout(() => { if (g === this.gen) this.restart(); }, 10000);
    } else { const g = this.gen; setTimeout(() => { if (g === this.gen) this.spawn(t); }, 3000); }
  }
  restart(withRoster) {
    this.gen++; this.over = false; this.teamKills = [0, 0];
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.alive = false; }
    if (withRoster) this.pushRoster();
    this.broadcast({ t: 'start', target: this.target, cfg: this.cfg, ...this.scoresMsg() });
    for (const p of this.players.values()) this.spawn(p);
  }

  msg(p, m) {
    if (!p || !this.players.has(p.id) || !m) return;
    const asBot = id => { const b = this.players.get(id); return b && b.bot && p.id === this.owner ? b : null; };
    switch (m.t) {
      case 'state':
        if (Array.isArray(m.p)) p.pos = m.p;
        m.id = p.id; this.broadcast(m, p); break;
      case 'bstate':
        if (p.id !== this.owner || !Array.isArray(m.b)) return;
        for (const e of m.b) { const b = asBot(e[0]); if (b) b.pos = [e[1], e[2], e[3]]; }
        this.broadcast(m, p); break;
      case 'shot': {
        const a = m.as ? asBot(m.as) : p; if (!a) return;
        m.id = a.id; delete m.as; this.broadcast(m, p); break;
      }
      case 'hit': {
        const a = m.as ? asBot(m.as) : p, t = this.players.get(m.target);
        if (!a || !t || !a.alive || !this.enemies(a, t)) return;
        this.damage(t, Math.max(0, Math.min(260, +m.dmg || 0)), a, m.head, m.w);
        break;
      }
      case 'fall': { // fall damage or drowning, reported by the faller
        const a = m.as ? asBot(m.as) : p;
        if (a) this.damage(a, Math.max(0, Math.min(200, +m.dmg || 0)), null, false, -1, ['heli', 'jet', 'ship'].includes(m.cause) ? m.cause : undefined);
        break;
      }
      case 'cfg': if (p.host) { this.applyCfg(m.cfg); this.log(`  Settings: ${this.cfg.mode === 'team' ? 'teams' : 'free for all'}, ${this.cfg.bots} bots`); } break;
      case 'ping': p.send && p.send({ t: 'pong', ts: m.ts }); break;
    }
  }

  tick() {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.alive && p.hp < MAX_HP && now - p.lastHurt > 5000) {
        p.hp = Math.min(MAX_HP, p.hp + 5);
        this.broadcast({ t: 'hp', id: p.id, hp: Math.round(p.hp) });
      }
    }
    if (this.rope && now - this.rope.t0 > ROPE_LIFE) this.rope = null;
    if (!this.rope && now > this.nextRope && this.humans().length) {
      const a = ROPE_POINTS[Math.floor(Math.random() * ROPE_POINTS.length)];
      const far = ROPE_POINTS.filter(q => Math.hypot(q[0] - a[0], q[1] - a[1]) > 38);
      const b = far[Math.floor(Math.random() * far.length)] || ROPE_POINTS[0];
      this.rope = { n: ++this.ropeN, a, b, from: Math.random() < 0.5 ? -1 : 1, t0: now };
      this.broadcast({ t: 'rope', ...this.rope, age: 0 });
      this.nextRope = now + ROPE_LIFE + rand(50, 100) * 1000;
    }
  }
  close() { clearInterval(this.iv); }
}

module.exports = { Match, MAX_HP, SPAWNS, ROPE_POINTS, TEAM_NAMES, MAX_BOTS, ROPE_LIFE };
