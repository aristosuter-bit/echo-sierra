import { WebSocketServer, WebSocket } from 'ws';

// ─── Configuration ────────────────────────────────────────────────
const PORT = process.env.PORT || 8765;
const POSITION_FUZZ = 0.0003; // ~30m fuzz for enemy positions
const PHOTO_COOLDOWN_MS = 5000;  // 5s between photo attempts
const PHOTO_RANGE_M = 60;        // must be within 60m to photograph
const PHOTO_PENALTY = 50;        // points deducted from victim
const WAYPOINT_POINTS = 100;     // base points per waypoint (for score tracking)
const HEARTBEAT_MS = 30000;      // ping interval
const PLAYER_TIMEOUT_MS = 60000; // disconnect if no pong for 60s

// ─── State ────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode → Room

class Room {
  constructor(code) {
    this.code = code.toUpperCase();
    this.players = new Map();    // playerId → Player
    this.teams = { alpha: { score: 0, players: new Set() }, bravo: { score: 0, players: new Set() } };
    this.missionActive = false;
    this.createdAt = Date.now();
  }
}

let nextPlayerId = 1;

class Player {
  constructor(ws, name, roomCode, team) {
    this.id = 'p' + (nextPlayerId++);
    this.ws = ws;
    this.name = name;
    this.roomCode = roomCode;
    this.team = team || 'alpha';
    this.role = 'operative';
    this.lat = null;
    this.lng = null;
    this.heading = null;
    this.lastPhoto = 0;         // timestamp of last photo attempt
    this.lastPong = Date.now();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitize(s, max = 12) {
  return String(s).replace(/[<>&"']/g, '').slice(0, max) || 'UNKNOWN';
}

// Dist between two lat/lng points in meters (Haversine)
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function playerInfo(p) {
  return { id: p.id, name: p.name, team: p.team, role: p.role };
}

// ─── Broadcast ────────────────────────────────────────────────────
function broadcast(room, msg, excludePlayerId = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === WebSocket.OPEN && p.id !== excludePlayerId) {
      p.ws.send(data);
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── Room Management ──────────────────────────────────────────────
function createRoom(ws, name, requestedCode) {
  let code;
  if (requestedCode && requestedCode.length === 4 && !rooms.has(requestedCode.toUpperCase())) {
    code = requestedCode.toUpperCase();
  } else {
    // Generate unique code
    for (let i = 0; i < 100; i++) {
      code = generateCode();
      if (!rooms.has(code)) break;
    }
  }
  if (!code || rooms.has(code)) {
    send(ws, { type: 'error', message: 'Could not create room. Try again.' });
    return;
  }

  const room = new Room(code);
  rooms.set(code, room);
  addPlayer(ws, name, code, 'alpha', room);
}

function joinRoom(ws, name, roomCode) {
  const code = roomCode.toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'error', message: 'Room not found.' });
    return;
  }
  if (room.missionActive) {
    send(ws, { type: 'error', message: 'Mission already in progress.' });
    return;
  }

  // Auto-assign to smaller team
  const alphaCount = room.teams.alpha.players.size;
  const bravoCount = room.teams.bravo.players.size;
  const team = bravoCount < alphaCount ? 'bravo' : 'alpha';
  addPlayer(ws, name, code, team, room);
}

function addPlayer(ws, name, roomCode, team, room) {
  const player = new Player(ws, name, roomCode, team);
  room.players.set(player.id, player);
  room.teams[team].players.add(player.id);

  // Tell the new player the full room state
  const allPlayers = [];
  for (const p of room.players.values()) {
    allPlayers.push(playerInfo(p));
  }

  send(ws, {
    type: 'room-state',
    roomCode,
    yourId: player.id,
    yourTeam: team,
    players: allPlayers,
    teams: {
      alpha: { score: room.teams.alpha.score, playerCount: room.teams.alpha.players.size },
      bravo: { score: room.teams.bravo.score, playerCount: room.teams.bravo.players.size },
    },
    missionActive: room.missionActive,
  });

  // Tell everyone else
  broadcast(room, { type: 'player-joined', ...playerInfo(player) }, player.id);

  ws._player = player;
  console.log(`[+] ${player.name} (${player.id}) joined ${roomCode} on ${team} — ${room.players.size} players`);
}

function leaveRoom(player) {
  if (!player) return;
  const room = rooms.get(player.roomCode);
  if (!room) return;

  const team = room.teams[player.team];
  if (team) team.players.delete(player.id);
  room.players.delete(player.id);

  console.log(`[-] ${player.name} (${player.id}) left ${player.roomCode} — ${room.players.size} remaining`);

  broadcast(room, { type: 'player-left', playerId: player.id, team: player.team });

  // Cleanup empty rooms
  if (room.players.size === 0) {
    rooms.delete(player.roomCode);
    console.log(`[x] Room ${player.roomCode} deleted (empty)`);
  }
}

// ─── Message Handler ──────────────────────────────────────────────
function handleMessage(player, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const room = rooms.get(player.roomCode);
  if (!room && msg.type !== 'create-room' && msg.type !== 'join-room') return;

  switch (msg.type) {

    case 'set-team': {
      const newTeam = msg.team === 'alpha' || msg.team === 'bravo' ? msg.team : null;
      if (!newTeam || newTeam === player.team) break;
      if (room.missionActive) {
        send(player.ws, { type: 'error', message: 'Cannot switch teams during mission.' });
        break;
      }
      // Move player
      room.teams[player.team].players.delete(player.id);
      player.team = newTeam;
      room.teams[newTeam].players.add(player.id);
      broadcast(room, { type: 'player-joined', ...playerInfo(player) });
      break;
    }

    case 'set-role': {
      const validRoles = ['scout', 'operative', 'sniper'];
      if (validRoles.includes(msg.role)) {
        player.role = msg.role;
        broadcast(room, { type: 'player-joined', ...playerInfo(player) });
      }
      break;
    }

    case 'position': {
      if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number') break;
      player.lat = msg.lat;
      player.lng = msg.lng;
      player.heading = typeof msg.heading === 'number' ? msg.heading : null;

      // Build position list for recipient: exact for teammates, fuzzed for enemies
      const positions = [];
      for (const p of room.players.values()) {
        if (p.id === player.id) continue; // skip self
        const isTeammate = p.team === player.team;
        positions.push({
          playerId: p.id,
          name: p.name,
          team: p.team,
          role: p.role,
          lat: isTeammate ? p.lat : fuzz(p.lat, POSITION_FUZZ),
          lng: isTeammate ? p.lng : fuzz(p.lng, POSITION_FUZZ),
          heading: isTeammate ? p.heading : null,
          fuzzy: !isTeammate,
        });
      }
      send(player.ws, { type: 'positions', positions });
      break;
    }

    case 'photo': {
      const targetId = msg.targetPlayerId;
      const target = room.players.get(targetId);
      if (!target) {
        send(player.ws, { type: 'error', message: 'Target not found.' });
        break;
      }
      if (target.team === player.team) {
        send(player.ws, { type: 'error', message: 'Cannot photograph teammate.' });
        break;
      }
      // Cooldown
      if (Date.now() - player.lastPhoto < PHOTO_COOLDOWN_MS) {
        send(player.ws, { type: 'error', message: 'Photo cooldown active.' });
        break;
      }
      // Range check
      if (player.lat == null || target.lat == null) {
        send(player.ws, { type: 'error', message: 'Position unknown.' });
        break;
      }
      const d = distanceM(player.lat, player.lng, target.lat, target.lng);
      if (d > PHOTO_RANGE_M) {
        send(player.ws, { type: 'error', message: `Too far: ${Math.round(d)}m (max ${PHOTO_RANGE_M}m).` });
        break;
      }

      player.lastPhoto = Date.now();

      // Score update
      room.teams[target.team].score = Math.max(0, room.teams[target.team].score - PHOTO_PENALTY);

      broadcast(room, {
        type: 'photo-result',
        attackerId: player.id,
        attackerName: player.name,
        attackerTeam: player.team,
        victimId: target.id,
        victimName: target.name,
        victimTeam: target.team,
        deltaPoints: -PHOTO_PENALTY,
        scores: {
          alpha: room.teams.alpha.score,
          bravo: room.teams.bravo.score,
        },
        distance: Math.round(d),
      });

      console.log(`[📷] ${player.name} (${player.team}) tagged ${target.name} (${target.team}) — ${Math.round(d)}m`);
      break;
    }

    case 'waypoint-captured': {
      // Client reports waypoint capture — server credits the team
      if (!room.missionActive) break;
      room.teams[player.team].score += WAYPOINT_POINTS;

      broadcast(room, {
        type: 'waypoint-captured',
        playerId: player.id,
        team: player.team,
        wpIndex: msg.wpIndex,
        scores: {
          alpha: room.teams.alpha.score,
          bravo: room.teams.bravo.score,
        },
      });
      break;
    }

    case 'mission-start': {
      if (room.missionActive) break;
      room.missionActive = true;
      room.teams.alpha.score = 0;
      room.teams.bravo.score = 0;
      broadcast(room, { type: 'mission-started', timestamp: Date.now() });
      console.log(`[▶] Mission started in ${player.roomCode}`);
      break;
    }

    case 'leave': {
      leaveRoom(player);
      break;
    }
  }
}

// ─── Position fuzzing ─────────────────────────────────────────────
function fuzz(val, range) {
  if (val == null) return null;
  return val + (Math.random() - 0.5) * range * 2;
}

// ─── Heartbeat / Cleanup ──────────────────────────────────────────
function heartbeat() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [pid, player] of room.players) {
      if (player.ws.readyState !== WebSocket.OPEN) {
        leaveRoom(player);
      } else if (now - player.lastPong > PLAYER_TIMEOUT_MS) {
        player.ws.terminate();
        leaveRoom(player);
      } else {
        try { player.ws.ping(); } catch {}
      }
    }
  }
}

// ─── Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
console.log(`[ES-SERVER] Echo Sierra signaling server on ws://0.0.0.0:${PORT}`);
console.log(`[ES-SERVER] Ready for Cloudflare Tunnel: cloudflared tunnel --url http://localhost:${PORT}`);

wss.on('connection', (ws, req) => {
  let player = null;

  ws.on('message', (raw) => {
    const msg = raw.toString();
    // First message must be create-room or join-room
    if (!player) {
      let parsed;
      try { parsed = JSON.parse(msg); } catch { return; }
      const name = sanitize(parsed.name || 'GHOST');

      if (parsed.type === 'create-room') {
        createRoom(ws, name, parsed.code);
        player = ws._player;
      } else if (parsed.type === 'join-room') {
        const roomCode = String(parsed.roomCode || '').toUpperCase();
        if (roomCode.length !== 4) {
          send(ws, { type: 'error', message: 'Room code must be 4 characters.' });
          return;
        }
        joinRoom(ws, name, roomCode);
        player = ws._player;
      } else {
        send(ws, { type: 'error', message: 'Must create or join a room first.' });
      }
      return;
    }

    handleMessage(player, msg);
  });

  ws.on('pong', () => {
    if (ws._player) ws._player.lastPong = Date.now();
  });

  ws.on('close', () => {
    if (ws._player) leaveRoom(ws._player);
  });

  ws.on('error', (err) => {
    console.error(`[!] WS error: ${err.message}`);
    if (ws._player) leaveRoom(ws._player);
  });
});

// Heartbeat every 30s
setInterval(heartbeat, HEARTBEAT_MS);

// Health check on separate HTTP
import { createServer } from 'http';
const health = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      players: [...rooms.values()].reduce((s, r) => s + r.players.size, 0),
      uptime: process.uptime(),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
health.listen(PORT + 1, () => {
  console.log(`[ES-SERVER] Health check on http://0.0.0.0:${PORT + 1}/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[ES-SERVER] Shutting down...');
  for (const [code, room] of rooms) {
    broadcast(room, { type: 'error', message: 'Server shutting down.' });
    for (const p of room.players.values()) p.ws.terminate();
  }
  wss.close();
  health.close();
  process.exit(0);
});
