
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
const WEAPON_IDS = ['knife', 'bat', 'pistol', 'revolver', 'smg', 'sword', 'shotgun', 'rifle', 'sniper', 'bazooka', 'minigun', 'spray'];
const SKIN_IDS = ['gold', 'neon', 'lava', 'ice', 'ghost'];
const SPRAYS = {}; // graffiti podle místnosti (posledních 800) – novým hráčům se pošlou po připojení

// Tituly nad hlavou (Matýsek je přidává/odebírá) – ukládají se podle jména do titles.json, platí dokud je admin neodebere
const TITLES_FILE = path.join(__dirname, 'titles.json');
let TITLES = {};
try { TITLES = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8')) || {}; } catch {}
const saveTitles = () => { try { fs.writeFileSync(TITLES_FILE, JSON.stringify(TITLES)); } catch (e) { console.error('titles.json:', e.message); } };
const NODRIVE = new Set(); // jména hráčů se zakázaným řízením (do restartu serveru)
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

// ===== Spolujízda: do každého auta se vejdou 4 lidé (včetně řidiče), do G-Wagonu 6, do GT-R jen 2 =====
const VEH_KINDS = ['std', 'm4', 'gtr', 'gw'];
const seatCap = d => (d.veh && d.veh.k === 'gtr') ? 2 : (d.veh && d.veh.k === 'gw') ? 6 : 4;

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
          yaw: src.yaw, skin: other.skin || other.mySkin || null, role: other.role || null, title: other.title || null, nodrive: !!other.noDrive, gtrok: !!(other.gtrOk || other.admin)
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
      p.noDrive = NODRIVE.has(titleKey(p.name));
      p.gtrOk = false; // GT-R se povoluje jen dočasně (do odpojení)
      if (p.noDrive) sendTo(ws, { type: 'grant', kind: 'drive', value: false });
      if ((SPRAYS[p.room] || []).length) sendTo(ws, { type: 'spraylog', list: SPRAYS[p.room] });
      broadcast();

    } else if (m.type === 'auth' && p.joined) {
      p.authFails = p.authFails || 0;
      if (p.authFails >= 5) { sendTo(ws, { type: 'admin', ok: false }); return; }

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
        sendTo(ws, { type: 'admin', ok: false });
      }

    } else if (m.type === 'myskin' && p.joined) {
      // vlastní skin – může si ho změnit kdokoli (jen běžné skiny, ne creator/developer)
      const v = m.value === null || m.value === undefined || m.value === '' ? null : String(m.value);
      if (v !== null && !SKIN_IDS.includes(v) && !(v === 'helper' && p.admin)) return;
      p.mySkin = v;
      broadcast();

    } else if (m.type === 'spray' && p.joined) {
      const now = Date.now();
      if (now - (p.sprayT || 0) < 30) return;
      p.sprayT = now;
      const v = ['x', 'y', 'z', 'nx', 'ny', 'nz', 's'].map(k => Number(m[k]));
      if (!v.every(Number.isFinite)) return;
      if (Math.abs(v[0]) > 5000 || Math.abs(v[1]) > 1000 || Math.abs(v[2]) > 5000) return;
      if (Math.abs(v[3]) > 1.01 || Math.abs(v[4]) > 1.01 || Math.abs(v[5]) > 1.01) return;
      const item = {
        type: 'spray', x: v[0], y: v[1], z: v[2], nx: v[3], ny: v[4], nz: v[5],
        c: /^#[0-9a-f]{6}$/i.test(String(m.c || '')) ? String(m.c) : '#ff2a2a',
        s: Math.max(0.1, Math.min(2, v[6]))
      };
      const list = SPRAYS[p.room] = SPRAYS[p.room] || [];
      list.push(item);
      if (list.length > 800) list.shift();
      for (const [tws, t] of clients) {
        if (t.joined && t !== p && t.room === p.room) sendTo(tws, item);
      }

    } else if (m.type === 'spraycls' && p.admin) {
      SPRAYS[p.room] = [];
      for (const [tws, t] of clients) {
        if (t.joined && t.room === p.room) sendTo(tws, { type: 'spraycls' });
      }

    } else if (m.type === 'grant' && p.admin) {
      const kind = m.kind;
      let value = m.value;

      if (kind === 'money') {
        value = Math.floor(Number(value));
        if (!Number.isFinite(value) || value < 1 || value > 1000000) return;
      } else if (kind === 'weapon') {
        if (!WEAPON_IDS.includes(value)) return;
      } else if (kind === 'aim' || kind === 'drive' || kind === 'gtr') {
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
        if (kind === 'gtr') { t.gtrOk = value; if (!value && t.veh && t.veh.k === 'gtr') { t.veh = null; releaseRiders(t, 'driver'); } }
        if (kind === 'drive') { t.noDrive = !value; if (value) NODRIVE.delete(titleKey(t.name)); else NODRIVE.add(titleKey(t.name)); }
        if (tws.readyState === WebSocket.OPEN) {
          tws.send(JSON.stringify({ type: 'grant', kind, value }));
        }
      }
      broadcast();

    } else if (m.type === 'pay' && p.joined) {
      // převod peněz mezi hráči z mobilu (stejná místnost, max $1 000 000, 1× za sekundu)
      const amt = Math.floor(Number(m.amount));
      const now = Date.now();
      if (!Number.isFinite(amt) || amt < 1 || amt > 1000000 || now - (p.lastPay || 0) < 1000) { sendTo(ws, { type: 'payfail' }); return; }
      p.lastPay = now;
      let sent = false;
      for (const [tws, t] of clients) {
        if (t.joined && t !== p && t.id === String(m.to) && t.room === p.room) {
          sendTo(tws, { type: 'pay', from: p.name, amount: amt });
          sendTo(ws, { type: 'payok', to: t.name, amount: amt });
          sent = true;
          break;
        }
      }
      if (!sent) sendTo(ws, { type: 'payfail' });

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
      if (v && typeof v === 'object' && VEH_KINDS.includes(v.k) && (v.k !== 'gtr' || p.admin || p.gtrOk)) {
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

