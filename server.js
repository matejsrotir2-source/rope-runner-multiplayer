
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const GAME_FILE = path.join(__dirname, 'Rope_Runner_3D_Multiplayer.html');

// Admin (Matýsek) – heslo se ověřuje tady na serveru. Hash můžeš přepsat proměnnou ADMIN_HASH.
const ADMIN_NAME = 'matysek';
const ADMIN_HASH = process.env.ADMIN_HASH || '3e27c7ca3f5bd42636e743e906278057ee13f8791fbf086bb72ba178fa1f8bfe';
const WEAPON_IDS = ['knife', 'bat', 'pistol', 'revolver', 'smg', 'sword', 'shotgun', 'rifle', 'sniper', 'bazooka', 'minigun'];
const SKIN_IDS = ['gold', 'neon', 'lava', 'ice', 'ghost'];

// Tituly nad hlavou (Matýsek je přidává/odebírá) – ukládají se podle jména do titles.json, platí dokud je admin neodebere
const TITLES_FILE = path.join(__dirname, 'titles.json');
let TITLES = {};
try { TITLES = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) || {}; } catch {}
const saveTitles = () => { try { fs.writeFileSync(TITLES_FILE, JSON.stringify(TITLES)); } catch (e) { console.error('titles.json:', e.message); } };
const titleKey = n => String(n || '').toLowerCase();

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  console.log('Požadavek:', pathname);

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) {
        console.error('HTML soubor nenalezen:', err.message);
        res.writeHead(404);
        res.end('Game file not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: 2048
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

let nextId = 1;
const clients = new Map();

// ===== Spolujízda: do každého auta se vejdou 4 lidé (včetně řidiče), do GT-R jen 2 =====
const VEH_KINDS = ['std', 'm4', 'gtr'];
const seatCap = d => (d.veh && d.veh.k === 'gtr') ? 2 : 4;

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function ridersOf(d) {
  const r = [];
  for (const t of clients.values()) if (t.ride === d.id) r.push(t);
  return r;
}

function releaseRiders(d, reason) {
  for (const [tws, t] of clients) {
    if (t.ride === d.id) {
      t.ride = null;
      t.seat = null;
      sendTo(tws, { type: 'ride', ok: false, reason });
    }
  }
}

function broadcast() {
  for (const [ws, self] of clients) {
    if (ws.readyState !== WebSocket.OPEN || !self.joined) continue;

    const players = [];

    for (const other of clients.values()) {
      if (other.joined && other.room === self.room) {
        // spolujezdec se pohybuje společně s řidičem
        let src = other, rideId = null;
        if (other.ride) {
          for (const d of clients.values()) {
            if (d.id === other.ride) { src = d; rideId = d.id; break; }
          }
        }
        const entry = {
          id: other.id,
          name: other.name,
          x: src.x,
          y: src.y,
          z: src.z,
          yaw: src.yaw, skin: other.skin || null, role: other.role || null, title: other.title || null
        };
        if (rideId) {
          entry.ride = rideId;
          entry.seat = other.seat || 1;
        } else if (other.veh) {
          entry.veh = other.veh;
          entry.pax = ridersOf(other).length;
        }
        players.push(entry);
      }
    }

    ws.send(JSON.stringify({
      type: 'snapshot',
      id: self.id,
      players
    }));
  }
}

wss.on('connection', ws => {
  const p = {
    id: String(nextId++),
    name: 'Hráč',
    x: 0,
    y: 0.92,
    z: -36,
    yaw: 0,
    joined: false
  };

  clients.set(ws, p);

  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!m || typeof m !== 'object') return;

    if (m.type === 'join') {
      p.joined = true;
      p.name = String(m.name || 'Hráč')
        .replace(/[<>]/g, '')
        .slice(0, 20) || 'Hráč';

      p.room = String(m.room || 'sidliste').slice(0, 32);
      p.title = TITLES[titleKey(p.name)] || null;
      broadcast();

    } else if (m.type === 'auth' && p.joined) {
      p.authFails = p.authFails || 0;
      if (p.authFails >= 5) return;

      const n = String(m.name || '').toLowerCase();
      const h = crypto.createHash('sha256').update(n + ':' + String(m.pass || '')).digest('hex');

      if (n === ADMIN_NAME && h === ADMIN_HASH) {
        p.admin = true;
        p.role = 'creator';
        p.name = String(m.name).replace(/[<>]/g, '').slice(0, 20);
        ws.send(JSON.stringify({ type: 'admin', ok: true }));
        broadcast();
      } else {
        p.authFails++;
      }

    } else if (m.type === 'grant' && p.admin) {
      const kind = m.kind;
      let value = m.value;

      if (kind === 'money') {
        value = Math.floor(Number(value));
        if (!Number.isFinite(value) || value < 1 || value > 1000000) return;
      } else if (kind === 'weapon') {
        if (!WEAPON_IDS.includes(value)) return;
      } else if (kind === 'aim') {
        value = !!value;
      } else if (kind === 'skin') {
        if (value !== null && !SKIN_IDS.includes(value)) return;
      } else {
        return;
      }

      for (const [tws, t] of clients) {
        if (!t.joined || t === p || t.room !== p.room) continue;
        if (String(m.to) !== 'all' && t.id !== String(m.to)) continue;
        if (kind === 'skin') t.skin = value;
        if (tws.readyState === WebSocket.OPEN) {
          tws.send(JSON.stringify({ type: 'grant', kind, value }));
        }
      }
      broadcast();

    } else if (m.type === 'title' && p.admin) {
      const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 24);
      const color = /^#[0-9a-f]{6}$/i.test(String(m.color || '')) ? String(m.color) : '#ff4fd8';
      for (const t of clients.values()) {
        if (!t.joined || t.id !== String(m.to) || t.room !== p.room) continue;
        if (text) { t.title = { text, color }; TITLES[titleKey(t.name)] = t.title; }
        else { t.title = null; delete TITLES[titleKey(t.name)]; }
        saveTitles();
        break;
      }
      broadcast();

    } else if (m.type === 'chat' && p.joined) {
      const now = Date.now();
      if (now - (p.lastChat || 0) < 800) return; // ochrana proti spamu
      const text = String(m.text || '')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      if (!text) return;
      p.lastChat = now;

      const out = JSON.stringify({
        type: 'chat',
        name: p.name,
        text,
        role: p.role || null
      });
      for (const [tws, t] of clients) {
        if (!t.joined || t.room !== p.room) continue;
        if (tws.readyState === WebSocket.OPEN) tws.send(out);
      }

    } else if (m.type === 'board' && p.joined) {
      // nastoupení k jinému hráči do auta
      if (p.ride || p.veh) return;
      const tid = String(m.target || '');
      let d = null;
      for (const t of clients.values()) {
        if (t.joined && t.id === tid && t.room === p.room) { d = t; break; }
      }
      if (!d || !d.veh) { sendTo(ws, { type: 'ride', ok: false, reason: 'none' }); return; }
      if (Math.hypot(d.x - p.x, d.z - p.z) > 16 || Math.abs(d.y - p.y) > 8) {
        sendTo(ws, { type: 'ride', ok: false, reason: 'far' });
        return;
      }
      const cap = seatCap(d);
      const taken = new Set(ridersOf(d).map(t => t.seat));
      let seat = 0;
      for (let i = 1; i < cap; i++) if (!taken.has(i)) { seat = i; break; }
      if (!seat) { sendTo(ws, { type: 'ride', ok: false, reason: 'full' }); return; }
      p.ride = d.id;
      p.seat = seat;
      sendTo(ws, { type: 'ride', ok: true, id: d.id, seat, cap });
      broadcast();

    } else if (m.type === 'unboard' && p.joined) {
      if (p.ride) {
        p.ride = null;
        p.seat = null;
        sendTo(ws, { type: 'ride', ok: false, reason: 'left' });
        broadcast();
      }

    } else if (m.type === 'state' && p.joined) {
      if (p.ride) return; // spolujezdec se hýbe s řidičem
      const vals = [m.x, m.y, m.z, m.yaw].map(Number);

      if (!vals.every(Number.isFinite)) return;

      if (
        Math.abs(vals[0]) > 2000 ||
        Math.abs(vals[1]) > 2000 ||
        Math.abs(vals[2]) > 2000
      ) return;

      [p.x, p.y, p.z, p.yaw] = vals;

      // auto, ve kterém hráč právě jede (vidí ho ostatní)
      const v = m.veh;
      if (v && typeof v === 'object' && VEH_KINDS.includes(v.k)) {
        const pt = Number(v.pt);
        p.veh = {
          k: v.k,
          c: (Number(v.c) >>> 0) & 0xffffff,
          pt: Number.isFinite(pt) ? Math.max(-1, Math.min(1, pt)) : 0
        };
      } else if (p.veh) {
        p.veh = null;
        releaseRiders(p, 'driver');
      }
      broadcast();
    }
  });

  const drop = () => {
    const self = clients.get(ws);
    if (self) releaseRiders(self, 'driver');
    clients.delete(ws);
    broadcast();
  };

  ws.on('close', drop);

  ws.on('error', drop);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rope Runner multiplayer běží na portu ${PORT}`);
});

