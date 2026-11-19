// Browser-hosted multiplayer for the website version (no Node server needed).
// One player's browser runs the match (match.js, the same rules as server.js) and the others
// connect to it directly over WebRTC. PeerJS's free public broker only introduces the
// two browsers; after that the game traffic goes straight between them.
import { Peer } from 'peerjs';
import { Match } from '../match.js';

const KILL_TARGET = 10;
const MAX_PLAYERS = 4;
const PREFIX = 'tidebreak-lag1-';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const PEER_OPTS = Object.assign({ debug: 0 }, (typeof window !== 'undefined' && window.TB_PEER) || {}); // TB_PEER: test override for a private broker

export const normCode = v => String(v || '').toUpperCase().replace(/^.*#/, '').replace(/[^A-Z0-9]/g, '').slice(0, 8);
const newCode = () => Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

// ---------- the match: the same rules as server.js (match.js) ----------
function createRoom() {
  const match = new Match({ killTarget: KILL_TARGET, maxHumans: MAX_PLAYERS });
  // c: { send(obj), close(), onmsg, onclose }; isHost: the hosting browser's own player
  function onConnect(c, isHost) {
    let me = null;
    c.onmsg = m => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello' && !me) {
        me = match.join(m.name, o => c.send(o), !!isHost, m.cfg);
        if (!me) { c.send({ t: 'full' }); setTimeout(() => c.close(), 300); }
        return;
      }
      if (me) match.msg(me, m);
    };
    c.onclose = () => { if (me) match.leave(me.id); me = null; };
  }
  return { onConnect };
}

// A WebSocket look-alike so game.js can use the same code for every kind of link.
function fakeSocket() {
  return { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() { }, close() { } };
}

// The host's own player talks to the room through an in-page loopback.
function loopback(room) {
  const sock = fakeSocket();
  const end = { send: obj => setTimeout(() => sock.readyState === 1 && sock.onmessage && sock.onmessage({ data: JSON.stringify(obj) }), 0), close() { }, onmsg: null, onclose: null };
  room.onConnect(end, true);
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
