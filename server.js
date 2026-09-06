const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Salas: roomId -> { host: ws, viewers: Set<ws> }
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function broadcast(room, message, exclude) {
  const data = JSON.stringify(message);
  if (room.host && room.host !== exclude && room.host.readyState === 1) {
    room.host.send(data);
  }
  for (const viewer of room.viewers) {
    if (viewer !== exclude && viewer.readyState === 1) {
      viewer.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const roomId = generateRoomId();
        rooms.set(roomId, { host: ws, viewers: new Set() });
        ws.roomId = roomId;
        ws.role = 'host';
        ws.send(JSON.stringify({ type: 'room-created', roomId }));
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada' }));
          return;
        }
        room.viewers.add(ws);
        ws.roomId = msg.roomId;
        ws.role = 'viewer';
        ws.viewerId = Math.random().toString(36).slice(2, 10);
        ws.send(JSON.stringify({ type: 'joined', roomId: msg.roomId, viewerId: ws.viewerId }));

        // Notifica o host que um novo viewer entrou
        if (room.host && room.host.readyState === 1) {
          room.host.send(JSON.stringify({ type: 'viewer-joined', viewerId: ws.viewerId }));
        }
        break;
      }

      // Sinalização WebRTC
      case 'offer': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        // Host envia offer para viewer específico
        for (const viewer of room.viewers) {
          if (viewer.viewerId === msg.viewerId && viewer.readyState === 1) {
            viewer.send(JSON.stringify({ type: 'offer', offer: msg.offer }));
          }
        }
        break;
      }

      case 'answer': {
        const room = rooms.get(ws.roomId);
        if (!room || !room.host || room.host.readyState !== 1) return;
        room.host.send(JSON.stringify({ type: 'answer', answer: msg.answer, viewerId: ws.viewerId }));
        break;
      }

      case 'ice-candidate': {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        if (ws.role === 'host') {
          for (const viewer of room.viewers) {
            if (viewer.viewerId === msg.viewerId && viewer.readyState === 1) {
              viewer.send(JSON.stringify({ type: 'ice-candidate', candidate: msg.candidate }));
            }
          }
        } else {
          if (room.host && room.host.readyState === 1) {
            room.host.send(JSON.stringify({ type: 'ice-candidate', candidate: msg.candidate, viewerId: ws.viewerId }));
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (ws.role === 'host') {
      // Notifica todos os viewers que o host saiu
      for (const viewer of room.viewers) {
        if (viewer.readyState === 1) {
          viewer.send(JSON.stringify({ type: 'host-left' }));
        }
      }
      rooms.delete(ws.roomId);
    } else {
      room.viewers.delete(ws);
      if (room.host && room.host.readyState === 1) {
        room.host.send(JSON.stringify({ type: 'viewer-left', viewerId: ws.viewerId }));
      }
    }
  });
});

// Heartbeat para limpar conexões mortas
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
