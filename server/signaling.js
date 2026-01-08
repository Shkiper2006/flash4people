const WebSocket = require('ws');

function attachSignalingServer({ server }) {
  const wss = new WebSocket.Server({ server, path: '/signaling' });
  const rooms = new Map();

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function getRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    return rooms.get(roomId);
  }

  function broadcast(roomId, payload, exceptPeerId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.forEach((socket, peerId) => {
      if (peerId !== exceptPeerId) {
        send(socket, payload);
      }
    });
  }

  wss.on('connection', (ws) => {
    let roomId = null;
    let peerId = null;

    ws.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (error) {
        send(ws, { type: 'error', message: 'Invalid JSON payload' });
        return;
      }

      if (payload.type === 'join') {
        roomId = payload.roomId;
        peerId = payload.peerId;
        if (!roomId || !peerId) {
          send(ws, { type: 'error', message: 'Missing roomId or peerId' });
          return;
        }
        const room = getRoom(roomId);
        room.set(peerId, ws);
        const peers = Array.from(room.keys()).filter((id) => id !== peerId);
        send(ws, { type: 'peers', peers });
        broadcast(roomId, { type: 'peer_joined', peerId }, peerId);
        return;
      }

      if (!roomId || !peerId) {
        send(ws, { type: 'error', message: 'Not joined to a room' });
        return;
      }

      if (['offer', 'answer', 'ice'].includes(payload.type)) {
        const target = payload.target;
        const room = rooms.get(roomId);
        if (!target || !room || !room.has(target)) {
          send(ws, { type: 'error', message: 'Target peer not found' });
          return;
        }
        const targetSocket = room.get(target);
        send(targetSocket, {
          type: payload.type,
          from: peerId,
          data: payload.data,
        });
      }
    });

    ws.on('close', () => {
      if (!roomId || !peerId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.delete(peerId);
      broadcast(roomId, { type: 'peer_left', peerId }, peerId);
      if (room.size === 0) {
        rooms.delete(roomId);
      }
    });
  });

  return wss;
}

module.exports = { attachSignalingServer };
