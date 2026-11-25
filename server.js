
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

function broadcast() {
  for (const [ws, self] of clients) {
    if (ws.readyState !== WebSocket.OPEN || !self.joined) continue;

    const players = [];

    for (const other of clients.values()) {
      if (other.joined && other.room === self.room) {
        players.push({
          id: other.id,
          name: other.name,
          x: other.x,
          y: other.y,
          z: other.z,
          yaw: other.yaw, skin: other.skin || null, role: other.role || null
        });
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

    } else if (m.type === 'state' && p.joined) {
      const vals = [m.x, m.y, m.z, m.yaw].map(Number);

      if (!vals.every(Number.isFinite)) return;

      if (
        Math.abs(vals[0]) > 2000 ||
        Math.abs(vals[1]) > 2000 ||
        Math.abs(vals[2]) > 2000
      ) return;

      [p.x, p.y, p.z, p.yaw] = vals;
      broadcast();
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast();
  });

  ws.on('error', () => {
    clients.delete(ws);
    broadcast();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rope Runner multiplayer běží na portu ${PORT}`);
});

