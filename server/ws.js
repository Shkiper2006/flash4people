const WebSocket = require('ws');

const INVITE_TIMEOUT_MS = 5 * 60 * 1000;

const onlineUsers = new Map();
const inviteTimers = new Map();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(connections, payload) {
  connections.forEach((socket) => send(socket, payload));
}

function registerConnection(userId, ws) {
  const existing = onlineUsers.get(userId) || new Set();
  existing.add(ws);
  onlineUsers.set(userId, existing);
}

function unregisterConnection(userId, ws) {
  const existing = onlineUsers.get(userId);
  if (!existing) {
    return;
  }
  existing.delete(ws);
  if (existing.size === 0) {
    onlineUsers.delete(userId);
  }
}

function notifyStatus(userId, status) {
  onlineUsers.forEach((sockets, targetId) => {
    if (targetId !== userId) {
      broadcast(sockets, { type: 'status', userId, status });
    }
  });
}

function scheduleInviteTimeout(inviteId, expiresAt, onTimeout) {
  const expiresAtMs = new Date(expiresAt).getTime();
  const delay = Math.max(expiresAtMs - Date.now(), 0);
  const timer = setTimeout(() => {
    inviteTimers.delete(inviteId);
    onTimeout();
  }, delay);
  inviteTimers.set(inviteId, timer);
}

function clearInviteTimeout(inviteId) {
  const timer = inviteTimers.get(inviteId);
  if (timer) {
    clearTimeout(timer);
    inviteTimers.delete(inviteId);
  }
}

function attachWebSocketServer({ server, db }) {
  const wss = new WebSocket.Server({ server });

  db.listPendingInvites().forEach((invite) => {
    const expiresAtMs = new Date(invite.expiresAt).getTime();
    if (expiresAtMs <= Date.now()) {
      db.updateInvite(invite.id, 'declined');
      return;
    }
    scheduleInviteTimeout(invite.id, invite.expiresAt, () => {
      const updated = db.updateInvite(invite.id, 'declined');
      if (!updated) {
        return;
      }
      const fromSockets = onlineUsers.get(updated.fromUserId) || [];
      const toSockets = onlineUsers.get(updated.toUserId) || [];
      broadcast(fromSockets, { type: 'invite_timeout', invite: updated });
      broadcast(toSockets, { type: 'invite_timeout', invite: updated });
    });
  });

  wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      send(ws, { type: 'error', message: 'Missing token' });
      ws.close();
      return;
    }
    const session = db.getSession(token);
    if (!session) {
      send(ws, { type: 'error', message: 'Invalid session' });
      ws.close();
      return;
    }
    const userId = session.userId;
    registerConnection(userId, ws);
    notifyStatus(userId, 'online');

    ws.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (error) {
        send(ws, { type: 'error', message: 'Invalid JSON payload' });
        return;
      }

      if (payload.type === 'send_message') {
        const room = db.getRoom(payload.roomId);
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          return;
        }
        const message = db.addMessage({
          roomId: room.id,
          fromUserId: userId,
          type: 'text',
          text: payload.text,
        });
        onlineUsers.forEach((sockets) => {
          broadcast(sockets, { type: 'message', message });
        });
      }

      if (payload.type === 'send_file') {
        const room = db.getRoom(payload.roomId);
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          return;
        }
        const message = db.addMessage({
          roomId: room.id,
          fromUserId: userId,
          type: 'file',
          fileName: payload.fileName,
          fileData: payload.fileData,
        });
        onlineUsers.forEach((sockets) => {
          broadcast(sockets, { type: 'file', message });
        });
      }

      if (payload.type === 'invite') {
        const room = db.getRoom(payload.roomId);
        if (!room || room.ownerId !== userId) {
          send(ws, { type: 'error', message: 'Invite not allowed' });
          return;
        }
        const targetUser = db.getUserById(payload.toUserId);
        if (!targetUser) {
          send(ws, { type: 'error', message: 'User not found' });
          return;
        }
        const expiresAt = new Date(Date.now() + INVITE_TIMEOUT_MS).toISOString();
        const invite = db.createInvite({
          roomId: room.id,
          fromUserId: userId,
          toUserId: targetUser.id,
          expiresAt,
        });
        scheduleInviteTimeout(invite.id, invite.expiresAt, () => {
          const updated = db.updateInvite(invite.id, 'declined');
          if (!updated) {
            return;
          }
          const fromSockets = onlineUsers.get(updated.fromUserId) || [];
          const toSockets = onlineUsers.get(updated.toUserId) || [];
          broadcast(fromSockets, { type: 'invite_timeout', invite: updated });
          broadcast(toSockets, { type: 'invite_timeout', invite: updated });
        });
        const targetSockets = onlineUsers.get(targetUser.id) || [];
        broadcast(targetSockets, { type: 'invite', invite });
        send(ws, { type: 'invite_sent', invite });
      }

      if (payload.type === 'invite_response') {
        const invite = db.updateInvite(payload.inviteId, payload.accept ? 'accepted' : 'declined');
        if (!invite) {
          send(ws, { type: 'error', message: 'Invite not found' });
          return;
        }
        clearInviteTimeout(invite.id);
        const fromSockets = onlineUsers.get(invite.fromUserId) || [];
        const toSockets = onlineUsers.get(invite.toUserId) || [];
        broadcast(fromSockets, { type: 'invite_response', invite });
        broadcast(toSockets, { type: 'invite_response', invite });
      }
    });

    ws.on('close', () => {
      unregisterConnection(userId, ws);
      if (!onlineUsers.has(userId)) {
        notifyStatus(userId, 'offline');
      }
    });
  });

  return wss;
}

module.exports = { attachWebSocketServer, onlineUsers };
