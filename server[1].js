// Rope Runner 3D – jednoduchý multiplayer server
// Vyžaduje Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const GAME_FILE = path.join(__dirname, 'Rope_Runner_3D_Multiplayer.html');
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.createReadStream(GAME_FILE).on('error', () => { res.writeHead(404); res.end('Game file not found'); })
      .pipe(res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 2048 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

let nextId = 1;
const clients = new Map();
function broadcast() {
  for (const [ws, self] of clients) {
    if (ws.readyState !== WebSocket.OPEN || !self.joined) continue;
    const players = [];
    for (const other of clients.values()) {
      if (other.joined && other.room === self.room)
        players.push({ id: other.id, name: other.name, x: other.x, y: other.y, z: other.z, yaw: other.yaw });
    }
    ws.send(JSON.stringify({ type: 'snapshot', id: self.id, players }));
  }
}
wss.on('connection', ws => {
  const p = { id: String(nextId++), name: 'Hráč', x: 0, y: 0.92, z: -36, yaw: 0, joined: false };
  clients.set(ws, p);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'join') {
      p.joined = true;
      p.name = String(m.name || 'Hráč').replace(/[<>]/g, '').slice(0, 20) || 'Hráč';
      p.room = String(m.room || 'sidliste').slice(0, 32);
      broadcast();
    } else if (m.type === 'state' && p.joined) {
      const vals = [m.x, m.y, m.z, m.yaw].map(Number);
      if (!vals.every(Number.isFinite)) return;
      // Basic sanity limits prevent malformed coordinates.
      if (Math.abs(vals[0]) > 2000 || Math.abs(vals[1]) > 2000 || Math.abs(vals[2]) > 2000) return;
      [p.x, p.y, p.z, p.yaw] = vals;
      broadcast();
    }
  });
  ws.on('close', () => { clients.delete(ws); broadcast(); });
  ws.on('error', () => { clients.delete(ws); broadcast(); });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Rope Runner multiplayer běží na portu ${PORT}`));
