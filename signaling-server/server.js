/*
 * RemoteLink — Rendezvous server (peer model, AnyDesk-style)
 * ---------------------------------------------------------
 * Every machine runs the SAME app (app.html) and is a "peer" with a permanent
 * numeric ID and an access password. No accounts, no email — the ID is the
 * identity, the access password is the security.
 *
 *   • register {id, secret, access}  claim/reclaim your permanent ID
 *   • call {targetId, access}        ask to connect to another peer
 *   • accept / decline               callee answers the request
 *   • signal {payload}               relay SDP/ICE to the peer you're paired with
 *   • swap                           reverse who-shares / who-controls
 *   • hangup                         end the current pairing
 *
 * The server only introduces peers and relays their WebRTC handshake; it never
 * sees screen pixels or input (those flow peer-to-peer, or via TURN).
 *
 * Permanent IDs live in peers.json: id -> { secret, accessSalt, accessHash }.
 * A peer proves ownership of its ID with the secret it stored on first use, so
 * nobody else can claim your ID.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// State that changes (device IDs, login sessions) must live somewhere WRITABLE.
// The installed app dir is read-only, so the desktop app points RL_DATA_DIR at
// a per-user folder; otherwise we fall back to this folder (dev / server host).
const DATA_DIR = process.env.RL_DATA_DIR || __dirname;
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const USERS_FILE = path.join(__dirname, 'users.json');   // read-only roster (bundled)

// ---- Persistent state -------------------------------------------------------
// peers.json:  id -> { secret, owner, accessSalt, accessHash }   permanent device IDs
// tokens.json: token -> { user, expires }                        login sessions
// users.json:  username -> { salt, hash }                        the fixed user roster
let peers = {}, users = {};
try { peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); } catch (e) { /* first run */ }
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { /* run seed-users.js */ }
if (!Object.keys(users).length) {
  console.log('!! No users found. Run:  node seed-users.js   (nobody can log in until you do)');
}
let saveTimer = null;
function savePeers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(PEERS_FILE, JSON.stringify(peers, null, 2), () => {});
  }, 200);
}

// scrypt is memory-hard — much stronger than PBKDF2 against cracking.
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
// Constant-time compare so response timing can't leak the hash.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Allocate a globally unique device ID. The SERVER owns allocation, so two
// devices can never end up with the same ID.
function allocateId() {
  for (let i = 0; i < 10000; i++) {
    let s = '';
    for (let j = 0; j < 9; j++) s += Math.floor(Math.random() * 10);
    const id = s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
    if (!peers[id]) return id;
  }
  throw new Error('ID space exhausted');
}

// id -> ws, for peers currently connected.
const online = new Map();

// ---- Login ------------------------------------------------------------------
// Sessions persist to disk so relaunching the app doesn't force a re-login.
const tokens = new Map();   // token -> { user, expires }
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days
const fails = new Map();    // user -> { count, until }  brute-force throttle

try {
  const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const now = Date.now();
  for (const t in raw) if (raw[t] && raw[t].expires > now) tokens.set(t, raw[t]);
} catch (e) { /* first run / no tokens yet */ }
let tokTimer = null;
function saveTokens() {
  clearTimeout(tokTimer);
  tokTimer = setTimeout(() => {
    const obj = {};
    for (const [t, v] of tokens) obj[t] = v;
    fs.writeFile(TOKENS_FILE, JSON.stringify(obj), () => {});
  }, 200);
}

function lockedOut(u) {
  const f = fails.get(u);
  return f && f.count >= 5 && Date.now() < f.until;
}
function recordFail(u) {
  const f = fails.get(u) || { count: 0, until: 0 };
  f.count += 1; f.until = Date.now() + 5 * 60 * 1000;
  fails.set(u, f);
}
function userOfToken(t) {
  const rec = tokens.get(String(t || ''));
  if (!rec) return null;
  if (Date.now() > rec.expires) { tokens.delete(String(t)); saveTokens(); return null; }
  return rec.user;
}

function handleApi(req, res, urlPath) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', () => {
    let d = {};
    try { d = JSON.parse(body); } catch (e) {}
    // CORS: the app is served from each device's own origin but logs in against
    // the SHARED server (a different origin), so the browser needs these headers.
    const reply = (c, o) => {
      res.writeHead(c, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(o));
    };

    if (urlPath === '/api/login') {
      const username = String(d.username || '').trim().toLowerCase();
      const password = String(d.password || '');
      if (lockedOut(username)) return reply(429, { error: 'too-many-attempts' });
      const u = users[username];
      // Same generic error whether the user exists or not — no account enumeration.
      if (!u || !safeEqual(hashPassword(password, u.salt), u.hash)) {
        recordFail(username);
        return reply(401, { error: 'wrong-credentials' });
      }
      fails.delete(username);
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, { user: username, expires: Date.now() + TOKEN_TTL });
      saveTokens();
      console.log('Login: ' + username);
      return reply(200, { token, username });
    }

    reply(404, { error: 'unknown-endpoint' });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

// ---- Static file server -----------------------------------------------------
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/app.html';   // the unified peer app is the entry point

  if (urlPath.indexOf('/api/') === 0) {
    // CORS preflight from a cross-origin app (shared-server setup).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    return handleApi(req, res, urlPath);
  }

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    // Always revalidate the code + service worker so a new build lands instantly
    // (a stale cached app.js was causing "registration failed" after updates).
    const base = path.basename(filePath);
    if (/\.(html|js|webmanifest)$/.test(base)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---- Signaling --------------------------------------------------------------
const wss = new WebSocket.Server({ server: httpServer });

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function peerWs(ws) {
  return ws.peerId ? online.get(ws.peerId) : null;
}
// Break a pairing and notify the other side.
function hangup(ws, reason) {
  const other = peerWs(ws);
  if (other) { send(other, { type: 'hangup', reason: reason || 'peer-left' }); other.peerId = null; }
  ws.peerId = null;
}

wss.on('connection', (ws) => {
  ws.id = null;
  ws.peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      // Claim (or reclaim) a permanent ID and publish an access password.
      // REQUIRES LOGIN. The ID is allocated by the server on first use and then
      // bound to (device secret, owner) — so it's permanent and unique.
      case 'register': {
        const user = userOfToken(msg.token);
        if (!user) return send(ws, { type: 'register-failed', reason: 'auth-required' });

        const secret = String(msg.secret || '');
        if (secret.length < 16) return send(ws, { type: 'register-failed', reason: 'bad-secret' });

        let id = String(msg.id || '').trim();
        let rec = id ? peers[id] : null;

        if (!id) {
          id = allocateId();               // brand-new device -> unique ID from the server
          rec = null;
        } else if (rec) {
          // Known ID — must match this device's secret and owner, else it's taken.
          if (!safeEqual(rec.secret, secret) || rec.owner !== user) {
            return send(ws, { type: 'register-failed', reason: 'id-owned' });
          }
        } else if (!/^\d{3} \d{3} \d{3}$/.test(id)) {
          id = allocateId();               // malformed stored ID -> fresh one
          rec = null;
        }
        // else: a well-formed ID the server has no record of (its storage reset on
        // the free tier). Let the device RECLAIM it so permanent IDs stay stable
        // across server restarts. It is re-bound to this owner+secret just below,
        // so a DIFFERENT device claiming the same ID is rejected as 'id-owned'.

        const accessSalt = (rec && rec.accessSalt) || crypto.randomBytes(8).toString('hex');
        const access = String(msg.access || '');
        peers[id] = {
          secret,
          owner: user,
          accessSalt,
          accessHash: access ? hashPassword(access, accessSalt)
                             : (rec ? rec.accessHash : null)
        };
        savePeers();
        // If this ID was online elsewhere, retire the old socket.
        const prev = online.get(id);
        if (prev && prev !== ws) { send(prev, { type: 'displaced' }); try { prev.close(); } catch (e) {} }
        ws.id = id;
        ws.user = user;
        online.set(id, ws);
        send(ws, { type: 'registered', id, user });
        break;
      }

      // Update just the access password for the already-registered ID.
      case 'set-access': {
        if (!ws.id || !peers[ws.id]) return;
        const access = String(msg.access || '');
        peers[ws.id].accessHash = access ? hashPassword(access, peers[ws.id].accessSalt) : null;
        savePeers();
        break;
      }

      // Ask to connect to another peer. Requires their access password.
      case 'call': {
        if (!ws.id) return send(ws, { type: 'error', reason: 'not-registered' });
        const targetId = String(msg.targetId || '').trim();
        if (targetId === ws.id) return send(ws, { type: 'error', reason: 'cannot-call-self' });
        const rec = peers[targetId];
        const target = online.get(targetId);
        if (!rec) return send(ws, { type: 'error', reason: 'unknown-id' });
        if (!target) return send(ws, { type: 'error', reason: 'peer-offline' });
        if (target.peerId) return send(ws, { type: 'error', reason: 'peer-busy' });
        if (rec.accessHash) {
          const access = String(msg.access || '');
          if (!access) return send(ws, { type: 'error', reason: 'access-required' });
          if (hashPassword(access, rec.accessSalt) !== rec.accessHash) {
            return send(ws, { type: 'error', reason: 'wrong-access-password' });
          }
        }
        // Tentatively pair; finalized on accept. The CALLER wants to VIEW the
        // target, so the target will SHARE (be the host) once it accepts.
        ws.peerId = targetId;
        target.peerId = ws.id;
        send(ws, { type: 'ringing', peer: targetId });
        send(target, { type: 'incoming', peer: ws.id });
        break;
      }

      // Callee accepts: caller becomes viewer, callee becomes sharer.
      case 'accept': {
        const other = peerWs(ws);
        if (!other) return;
        send(other, { type: 'accepted', peer: ws.id, youShare: false });
        send(ws,    { type: 'start',    peer: other.id, youShare: true });
        break;
      }
      case 'decline': {
        const other = peerWs(ws);
        if (other) { send(other, { type: 'declined' }); other.peerId = null; }
        ws.peerId = null;
        break;
      }

      // Reverse roles mid-call. Relayed; both sides rebuild with swapped share.
      case 'swap': {
        const other = peerWs(ws);
        if (other) send(other, { type: 'swap' });
        break;
      }

      // Opaque relay of the WebRTC handshake to the paired peer.
      case 'signal': {
        const other = peerWs(ws);
        if (other) send(other, { type: 'signal', payload: msg.payload });
        break;
      }

      case 'hangup':
        hangup(ws, 'peer-left');
        break;

      // Keepalive — bidirectional traffic stops proxies/tunnels idling the socket.
      case 'ping':
        send(ws, { type: 'pong' });
        break;

      default: break;
    }
  });

  ws.on('close', () => {
    hangup(ws, 'peer-left');
    if (ws.id && online.get(ws.id) === ws) online.delete(ws.id);
  });
});

httpServer.listen(PORT, () => {
  console.log('RemoteLink server listening on port ' + PORT);
  console.log('  Open the app:  http://localhost:' + PORT + '/app.html');
});
