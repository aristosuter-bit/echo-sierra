# Echo Sierra — WebSocket Signaling Server

Multiplayer signaling server for Echo Sierra v8. Replaces PeerJS cloud dependency with a self-hosted WebSocket server.

## Architecture

```
Client (GitHub Pages) ──wss──▶ Cloudflare Tunnel ──▶ Mac Mini:8765 (this server)
```

- **Server**: Node.js + `ws` library, port 8765
- **Health check**: HTTP on port 8766 (`/health`)
- **Tunnel**: `waypoint-zero.swisschatbot.ch` → `localhost:8765` (via cloudflared named tunnel)

## Message Protocol

### Client → Server
| Message | Fields | Description |
|---------|--------|-------------|
| `create-room` | `name` | Create a room (leader joins Alpha) |
| `join-room` | `roomCode`, `name` | Join existing room (auto-assigned to smaller team) |
| `set-team` | `team` | Switch to `alpha` or `bravo` |
| `set-role` | `role` | Set role: `scout`, `operative`, `sniper` |
| `position` | `lat`, `lng`, `heading?` | GPS position update |
| `photo` | `targetPlayerId` | Photograph enemy player |
| `waypoint-captured` | `wpIndex` | Report waypoint capture (+100 team points) |
| `mission-start` | — | Start mission (resets scores) |
| `leave` | — | Leave room |

### Server → Client
| Message | Fields | Description |
|---------|--------|-------------|
| `room-state` | `roomCode`, `yourId`, `yourTeam`, `players[]`, `teams{}` | Full room state on join |
| `player-joined` | `id`, `name`, `team`, `role` | New player notification |
| `player-left` | `playerId`, `team` | Player disconnect |
| `positions` | `positions[]` with `playerId`, `lat`, `lng`, `team`, `fuzzy` | Position batch (teammates exact, enemies ±30m fuzz) |
| `photo-result` | `attackerId`, `victimId`, `deltaPoints`, `scores{}` | Tag confirmation (-50 victim team) |
| `waypoint-captured` | `playerId`, `team`, `wpIndex`, `scores{}` | Waypoint scored (+100 team) |
| `mission-started` | `timestamp` | Mission began |
| `error` | `message` | Error feedback |

## Game Rules

- **Two teams**: Alpha (diamond ◆) and Bravo (diamond ◇)
- **Photo range**: 60m — player must be within range to tag
- **Photo cooldown**: 5 seconds between attempts
- **Tag penalty**: -50 points to victim's team
- **Waypoint bonus**: +100 points to captor's team
- **Position fuzzing**: Enemies get ±30m fuzzed positions
- **Room codes**: 4-character alphanumeric (no 0/O, 1/I confusion)

## Deployment

### 1. Copy server to permanent location
```bash
cp -r server/ ~/Projects/echo-sierra-server/
cd ~/Projects/echo-sierra-server
npm install
```

### 2. Start server
```bash
./start.sh
# or: node server.js
```

### 3. Verify
```bash
curl http://localhost:8766/health
# {"status":"ok","rooms":0,"players":0,"uptime":...}
```

### 4. Auto-start (launchd)
```bash
cp com.echosierra.signaling.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.echosierra.signaling.plist
```

### 5. Cloudflare Tunnel
Already configured — `waypoint-zero.swisschatbot.ch` routes to `localhost:8765` in the existing cloudflared named tunnel config.

## Files

- `server.js` — WebSocket signaling server
- `package.json` — Dependencies (ws)
- `start.sh` — Startup script
- `com.echosierra.signaling.plist` — macOS launchd service
