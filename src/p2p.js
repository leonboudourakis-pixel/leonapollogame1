// Browser-hosted multiplayer for the website version (no Node server needed).
// One player's browser runs the match (the same rules as server.js) and the others
// connect to it directly over WebRTC. PeerJS's free public broker only introduces the
// two browsers; after that the game traffic goes straight between them.
import { Peer } from 'peerjs';

const KILL_TARGET = 10;
const MAX_PLAYERS = 4;
// Spawn points (must match SPAWNS in game.js and server.js)
const SPAWNS = [[-29, -14], [-29, 0], [-29, 12], [-21, 21.5], [29, -14], [29, 0], [29, 12], [21, 21.5], [-12, -21.5], [12, -21.5]];
const PREFIX = 'tidebreak-lag1-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const PEER_OPTS = Object.assign({ debug: 0 }, (typeof window !== 'undefined' && window.TB_PEER) || {}); // TB_PEER: test override for a private broker

export const normCode = v => String(v || '').toUpperCase().replace(/^.*#/, '').replace(/[^A-Z0-9]/g, '').slice(0, 8);
const newCode = () => Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

// ---------- the match (port of server.js) ----------
function createRoom() {
  const players = new Map();
  let nextId = 1, matchOver = false;
  const broadcast = (msg, except) => { for (const p of players.values()) if (p !== except) p.c.send(msg); };
  const summary = p => ({ id: p.id, name: p.name, slot: p.slot, kills: p.kills, deaths: p.deaths, hp: p.hp, alive: p.alive });
  function pickSpawn(p) {
    let best = 0, bestD = -1;
    SPAWNS.forEach((s, i) => {
      let d = 1e9;
      for (const o of players.values()) if (o !== p && o.alive && o.pos) d = Math.min(d, Math.hypot(o.pos[0] - s[0], o.pos[2] - s[1]));
      d += Math.random() * 6;
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
  function restart() {
    matchOver = false;
    for (const p of players.values()) { p.kills = 0; p.deaths = 0; }
    broadcast({ t: 'start', scores: [...players.values()].map(summary) });
    for (const p of players.values()) spawn(p);
  }
  setInterval(() => {
    const now = Date.now();
    for (const p of players.values()) if (p.alive && p.hp < 100 && now - p.lastHurt > 5000) {
      p.hp = Math.min(100, p.hp + 4);
      broadcast({ t: 'hp', id: p.id, hp: Math.round(p.hp) });
    }
  }, 200);
  // c: { send(obj), close(), onmsg, onclose }
  function onConnect(c) {
    let me = null;
    c.onmsg = m => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello' && !me) {
        if (players.size >= MAX_PLAYERS) { c.send({ t: 'full' }); setTimeout(() => c.close(), 300); return; }
        const used = new Set([...players.values()].map(p => p.slot));
        let slot = 0; while (used.has(slot)) slot++;
        me = { id: nextId++, c, name: String(m.name || 'Operator').replace(/[<>]/g, '').slice(0, 16) || 'Operator', slot, kills: 0, deaths: 0, hp: 100, alive: false, pos: null, lastHurt: 0 };
        players.set(me.id, me);
        c.send({ t: 'welcome', you: me.id, target: KILL_TARGET, players: [...players.values()].map(summary), over: matchOver });
        broadcast({ t: 'join', p: summary(me) }, me);
        spawn(me);
        return;
      }
      if (!me) return;
      switch (m.t) {
        case 'state': if (Array.isArray(m.p)) me.pos = m.p; m.id = me.id; broadcast(m, me); break;
        case 'shot': m.id = me.id; broadcast(m, me); break;
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
      if (players.size === 0) matchOver = false;
    };
  }
  return { onConnect, get count() { return players.size; } };
}

// A WebSocket look-alike so game.js can use the same code for every kind of link.
function fakeSocket() {
  return { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() { }, close() { } };
}

// The host's own player talks to the room through an in-page loopback.
function loopback(room) {
  const sock = fakeSocket();
  const end = { send: obj => setTimeout(() => sock.readyState === 1 && sock.onmessage && sock.onmessage({ data: JSON.stringify(obj) }), 0), close() { }, onmsg: null, onclose: null };
  room.onConnect(end);
  sock.send = str => { let m; try { m = JSON.parse(str); } catch (e) { return; } setTimeout(() => end.onmsg && end.onmsg(m), 0); };
  setTimeout(() => { sock.readyState = 1; sock.onopen && sock.onopen(); }, 0);
  return sock;
}

function wrapConn(dc) { // DataConnection -> room connection
  const c = { onmsg: null, onclose: null, send(obj) { if (dc.open) try { dc.send(JSON.stringify(obj)); } catch (e) { } }, close() { try { dc.close(); } catch (e) { } } };
  let closed = false;
  dc.on('data', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } try { c.onmsg && c.onmsg(m); } catch (e) { console.error(e); } });
  const done = () => { if (!closed) { closed = true; c.onclose && c.onclose(); } };
  dc.on('close', done); dc.on('error', done);
  dc.peerConnection && dc.peerConnection.addEventListener('connectionstatechange', () => { const s = dc.peerConnection.connectionState; if (s === 'failed' || s === 'closed') done(); });
  return c;
}

let mode = null; // null | { kind:'host', code, room, peer } | { kind:'join', code, dc, peer }

export function status() { return mode ? { kind: mode.kind, code: mode.code } : null; }

// Host: get a code from the broker and start accepting players.
export function host(onEvent) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const code = newCode();
      const peer = new Peer(PREFIX + code, PEER_OPTS);
      let opened = false;
      peer.on('open', () => {
        opened = true;
        const room = createRoom();
        mode = { kind: 'host', code, room, peer };
        peer.on('connection', dc => {
          dc.on('open', () => { room.onConnect(wrapConn(dc)); onEvent && onEvent('joined'); });
        });
        resolve(code);
      });
      peer.on('disconnected', () => { if (opened && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { } }, 1000); });
      peer.on('error', err => {
        if (!opened) {
          try { peer.destroy(); } catch (e) { }
          if (err.type === 'unavailable-id' && tries++ < 5) return attempt();
          reject(err);
        } else if (err.type !== 'peer-unavailable') console.warn('tidebreak host:', err.type);
      });
    };
    attempt();
  });
}

// Join: reach the host's browser with the code.
export function join(code) {
  code = normCode(code);
  return new Promise((resolve, reject) => {
    const peer = new Peer(PEER_OPTS);
    let settled = false;
    const fail = e => { if (settled) return; settled = true; clearTimeout(to); try { peer.destroy(); } catch (_) { } reject(e); };
    const to = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'timeout' })), 20000);
    peer.on('error', err => fail(err));
    peer.on('open', () => {
      const dc = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
      dc.on('open', () => { if (settled) return; settled = true; clearTimeout(to); mode = { kind: 'join', code, dc, peer }; resolve(code); });
      dc.on('error', err => fail(err));
    });
  });
}

// Called by game.js connect(): returns a WebSocket-like object, or null if not set up.
export function openSocket() {
  if (!mode) return null;
  if (mode.kind === 'host') return loopback(mode.room);
  const dc = mode.dc, sock = fakeSocket();
  sock.readyState = dc.open ? 1 : 3;
  sock.send = str => { if (dc.open) try { dc.send(str); } catch (e) { } };
  sock.close = () => { try { dc.close(); } catch (e) { } };
  let closed = false;
  const done = () => { if (closed) return; closed = true; sock.readyState = 3; sock.onclose && sock.onclose(); };
  dc.on('data', d => sock.onmessage && sock.onmessage({ data: d }));
  dc.on('close', done); dc.on('error', done);
  dc.peerConnection && dc.peerConnection.addEventListener('connectionstatechange', () => { const s = dc.peerConnection.connectionState; if (s === 'failed' || s === 'closed') done(); });
  setTimeout(() => { if (sock.readyState === 1) sock.onopen && sock.onopen(); else done(); }, 0);
  return sock;
}
