#!/usr/bin/env node
// Tidebreak server: serves the game and runs the deathmatch. No npm install needed.
// Same Wi-Fi: the other Mac opens the LAN link. Internet: a free Cloudflare quick tunnel
// gives a public https address; its first part is the join code (no account, no port forwarding).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { spawn: spawnProc, execFile } = require('child_process');

const PORT = +process.env.PORT || 8080;
const KILL_TARGET = +process.env.KILLS || 10;
const MAX_PLAYERS = 4;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

// Spawn points (must match SPAWNS in public/game.js)
const SPAWNS = [[-29, -14], [-29, 0], [-29, 12], [-21, 21.5], [29, -14], [29, 0], [29, 12], [21, 21.5], [-12, -21.5], [12, -21.5]];

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  let u;
  try { u = decodeURIComponent(req.url.split('?')[0]); } catch (e) { u = '/'; }
  if (u === '/info') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); const viaNet = !!req.headers['cf-connecting-ip'] || /trycloudflare\.com$/i.test((req.headers.host || '').split(':')[0]);
    const o = { state: tunnel.state, msg: tunnel.msg, code: tunnel.state === 'ready' ? tunnel.code : '', url: tunnel.state === 'ready' ? tunnel.url : '' };
    return res.end(JSON.stringify({ lan: viaNet ? [] : lanAddresses().map(a => a.address), port: PORT, players: players.size, online: o, viaNet })); }
  if (u === '/probe.gif') { // lets a join page check a code without CORS rules getting in the way
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- Minimal WebSocket (RFC 6455) ----------
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws') || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  onConnect(wrapSocket(sock));
});

function frame(op, data) {
  const n = data.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, data]);
}

function wrapSocket(sock) {
  const c = {
    buf: Buffer.alloc(0), frags: [], onmsg: null, onclose: null, closed: false,
    send(obj) { if (!sock.destroyed) sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); },
    close() { if (!sock.destroyed) { sock.write(frame(8, Buffer.alloc(0))); sock.end(); } }
  };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    for (;;) {
      const b = c.buf; if (b.length < 2) break;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const ml = masked ? 4 : 0;
      if (b.length < off + ml + len) break;
      let p = Buffer.from(b.subarray(off + ml, off + ml + len));
      if (masked) { const m = b.subarray(off, off + 4); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      c.buf = b.subarray(off + ml + len);
      if (op === 8) { c.close(); break; }
      if (op === 9) { sock.write(frame(10, p)); continue; }
      if (op === 10) continue;
      c.frags.push(p);
      if (fin) {
        const s = Buffer.concat(c.frags).toString(); c.frags = [];
        let msg; try { msg = JSON.parse(s); } catch (e) { continue; }
        try { c.onmsg && c.onmsg(msg); } catch (e) { console.error(e); }
      }
    }
  });
  const done = () => { if (!c.closed) { c.closed = true; c.onclose && c.onclose(); } };
  sock.on('close', done); sock.on('end', done); sock.on('error', done);
  return c;
}

// ---------- Deathmatch ----------
const players = new Map();
let nextId = 1, matchOver = false;

const broadcast = (msg, except) => { for (const p of players.values()) if (p !== except) p.c.send(msg); };
const summary = p => ({ id: p.id, name: p.name, slot: p.slot, kills: p.kills, deaths: p.deaths, hp: p.hp, alive: p.alive });

function pickSpawn(p) {
  let best = 0, bestD = -1;
  SPAWNS.forEach((s, i) => {
    let d = 1e9;
    for (const o of players.values()) if (o !== p && o.alive && o.pos) d = Math.min(d, Math.hypot(o.pos[0] - s[0], o.pos[2] - s[1]));
    d += Math.random() * 6; // a little variety
    if (d > bestD) { bestD = d; best = i; }
  });
  return best;
}

function spawn(p) {
  if (!players.has(p.id)) return;
  const s = pickSpawn(p);
  p.hp = 100; p.alive = true; p.pos = [SPAWNS[s][0], 0, SPAWNS[s][1]]; p.lastHurt = 0;
  broadcast({ t: 'spawn', id: p.id, s });
}

function onConnect(c) {
  let me = null;
  c.onmsg = m => {
    if (m.t === 'hello' && !me) {
      if (players.size >= MAX_PLAYERS) { c.send({ t: 'full' }); c.close(); return; }
      const used = new Set([...players.values()].map(p => p.slot));
      let slot = 0; while (used.has(slot)) slot++;
      me = { id: nextId++, c, name: String(m.name || 'Operator').replace(/[<>]/g, '').slice(0, 16) || 'Operator', slot, kills: 0, deaths: 0, hp: 100, alive: false, pos: null, lastHurt: 0 };
      players.set(me.id, me);
      c.send({ t: 'welcome', you: me.id, target: KILL_TARGET, players: [...players.values()].map(summary), over: matchOver });
      broadcast({ t: 'join', p: summary(me) }, me);
      console.log(`  + ${me.name} joined (${players.size}/${MAX_PLAYERS})`);
      spawn(me);
      return;
    }
    if (!me) return;
    switch (m.t) {
      case 'state':
        if (Array.isArray(m.p)) me.pos = m.p;
        m.id = me.id; broadcast(m, me); break;
      case 'shot':
        m.id = me.id; broadcast(m, me); break;
      case 'hit': {
        const t = players.get(m.target);
        if (!t || !t.alive || !me.alive || matchOver || t === me) return;
        const dmg = Math.max(0, Math.min(150, +m.dmg || 0));
        t.hp -= dmg; t.lastHurt = Date.now();
        broadcast({ t: 'hp', id: t.id, hp: Math.max(0, Math.round(t.hp)), from: me.id, dmg });
        if (t.hp <= 0) {
          t.alive = false; t.deaths++; me.kills++;
          broadcast({ t: 'kill', killer: me.id, victim: t.id, head: !!m.head, w: m.w, scores: [...players.values()].map(summary) });
          if (me.kills >= KILL_TARGET) {
            matchOver = true;
            broadcast({ t: 'end', winner: me.id, scores: [...players.values()].map(summary) });
            console.log(`  ★ ${me.name} wins the match`);
            setTimeout(restart, 10000);
          } else setTimeout(() => spawn(t), 3000);
        }
        break;
      }
      case 'ping': c.send({ t: 'pong', ts: m.ts }); break;
    }
  };
  c.onclose = () => {
    if (!me) return;
    players.delete(me.id);
    broadcast({ t: 'leave', id: me.id });
    console.log(`  - ${me.name} left (${players.size}/${MAX_PLAYERS})`);
    if (players.size === 0) matchOver = false;
  };
}

function restart() {
  matchOver = false;
  for (const p of players.values()) { p.kills = 0; p.deaths = 0; }
  broadcast({ t: 'start', scores: [...players.values()].map(summary) });
  for (const p of players.values()) spawn(p);
}

setInterval(() => { // health regen after 5s without damage
  const now = Date.now();
  for (const p of players.values()) {
    if (p.alive && p.hp < 100 && now - p.lastHurt > 5000) {
      p.hp = Math.min(100, p.hp + 4);
      broadcast({ t: 'hp', id: p.id, hp: Math.round(p.hp) });
    }
  }
}, 200);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  out.sort((a, b) => (a.name === 'en0' ? -1 : 0) - (b.name === 'en0' ? -1 : 0));
  return out;
}


// ---------- Internet play: Cloudflare quick tunnel ----------
// tunnel.state: 'off' | 'download' | 'starting' | 'ready' | 'failed'
const tunnel = { state: 'off', code: '', url: '', msg: '' };
const BIN_DIR = path.join(__dirname, 'bin');
const CF_LOCAL = path.join(BIN_DIR, 'cloudflared');
let cfProc = null, cfRestarts = 0;

function findCloudflared() {
  if (fs.existsSync(CF_LOCAL)) return CF_LOCAL;
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(':')]) {
    const f = path.join(d, 'cloudflared');
    if (d && fs.existsSync(f)) return f;
  }
  return null;
}

function downloadCloudflared(cb) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  let asset;
  if (process.platform === 'darwin') asset = `cloudflared-darwin-${arch}.tgz`;
  else if (process.platform === 'linux') asset = `cloudflared-linux-${arch}`;
  else return cb(new Error('automatic download only on Mac/Linux'));
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = path.join(BIN_DIR, asset + '.part');
  tunnel.state = 'download'; tunnel.msg = 'Downloading the internet-play helper (one time, about 20 MB)...';
  console.log('  ' + tunnel.msg);
  execFile('curl', ['-fsSL', '--retry', '3', '-o', tmp, url], { timeout: 300000 }, err => {
    if (err) return cb(err);
    const finish = e => {
      try { fs.unlinkSync(tmp); } catch (_) { }
      if (e) return cb(e);
      try { fs.chmodSync(CF_LOCAL, 0o755); } catch (e2) { return cb(e2); }
      execFile('xattr', ['-d', 'com.apple.quarantine', CF_LOCAL], () => cb(null));
    };
    if (asset.endsWith('.tgz')) execFile('tar', ['-xzf', tmp, '-C', BIN_DIR], finish);
    else { try { fs.renameSync(tmp, CF_LOCAL); finish(null); } catch (e) { finish(e); } }
  });
}

function startTunnel() {
  if (process.env.ONLINE === '0') { tunnel.state = 'off'; return; }
  const bin = findCloudflared();
  if (!bin) {
    return downloadCloudflared(err => {
      if (err) { tunnel.state = 'failed'; tunnel.msg = 'Could not download the internet-play helper. Check the internet connection and restart Tidebreak. Same Wi-Fi play still works.'; console.log('\n  ' + tunnel.msg + '\n  (' + err.message + ')\n'); return; }
      startTunnel();
    });
  }
  tunnel.state = 'starting'; tunnel.code = ''; tunnel.url = ''; tunnel.msg = 'Getting a join code...';
  // An empty config file stops a personal ~/.cloudflared/config.yml from interfering.
  const emptyCfg = path.join(os.tmpdir(), 'tidebreak-cloudflared.yml');
  try { fs.writeFileSync(emptyCfg, ''); } catch (_) { }
  cfProc = spawnProc(bin, ['tunnel', '--config', emptyCfg, '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pendingUrl = '';
  const onLine = chunk => {
    const t = chunk.toString();
    const m = t.match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/);
    if (m && !pendingUrl && m[1] !== 'api') pendingUrl = m[0];
    if (pendingUrl && tunnel.state === 'starting' && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(t)) {
      tunnel.state = 'linking'; tunnel.url = pendingUrl; tunnel.code = pendingUrl.replace('https://', '').replace('.trycloudflare.com', '');
      // give Cloudflare's DNS a moment before telling anyone to join
      setTimeout(() => {
        tunnel.state = 'ready'; tunnel.msg = ''; cfRestarts = 0;
        console.log('\n  ┌──────────────────────────────────────────────────────────┐');
        console.log('  │  INTERNET PLAY IS ON                                     │');
        console.log('  └──────────────────────────────────────────────────────────┘');
        console.log(`  Join code:   ${tunnel.code}`);
        console.log(`  Or open:     ${tunnel.url}`);
        console.log('  Send the code to the other player. It changes each time Tidebreak starts.\n');
      }, 3000);
    }
  };
  cfProc.stdout.on('data', onLine); cfProc.stderr.on('data', onLine);
  cfProc.on('error', e => { tunnel.state = 'failed'; tunnel.msg = 'The internet-play helper could not start (' + e.message + ').'; console.log('  ' + tunnel.msg); });
  cfProc.on('exit', () => {
    cfProc = null;
    if (shuttingDown) return;
    const wasReady = tunnel.state === 'ready';
    tunnel.state = 'failed'; tunnel.code = ''; tunnel.url = '';
    if (cfRestarts++ < 5) {
      tunnel.state = 'starting'; tunnel.msg = wasReady ? 'Internet link dropped, getting a new join code...' : 'Still setting up internet play, retrying...';
      console.log('  ' + tunnel.msg + (wasReady ? ' (the old code no longer works)' : ''));
      setTimeout(startTunnel, 3000 * cfRestarts);
    } else { tunnel.msg = 'Internet play is not available right now. Same Wi-Fi play still works. Try restarting Tidebreak.'; console.log('  ' + tunnel.msg); }
  });
}

let shuttingDown = false;
function shutdown() { shuttingDown = true; if (cfProc) try { cfProc.kill(); } catch (_) { } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);
process.on('exit', () => { if (cfProc) try { cfProc.kill(); } catch (_) { } });

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is Tidebreak already running in another window?\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log('  │  TIDEBREAK server is running                 │');
  console.log('  └──────────────────────────────────────────────┘\n');
  console.log(`  On this Mac, open:      http://localhost:${PORT}`);
  if (ips.length) {
    console.log(`  On the other laptop:    http://${ips[0].address}:${PORT}`);
    for (const a of ips.slice(1)) console.log(`                          http://${a.address}:${PORT}   (${a.name})`);
  } else console.log('  (No Wi-Fi address found. Are you connected to Wi-Fi?)');
  console.log(`\n  First to ${KILL_TARGET} kills wins. Keep this window open while you play.`);
  console.log('  Press Ctrl+C to stop the server.\n');
  if (process.env.ONLINE !== '0') { console.log('  Setting up internet play (join code)...'); startTunnel(); }
});
