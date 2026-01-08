const WebSocket = require('ws');

const INVITE_TIMEOUT_MS = 5 * 60 * 1000;

const onlineUsers = new Map();
const inviteTimers = new Map();
const connectionInfo = new Map();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(sockets, payload) {
  sockets.forEach((socket) => send(socket, payload));
}

function registerConnection(userId, ws) {
  const existing = onlineUsers.get(userId) || new Set();
  existing.add(ws);
  onlineUsers.set(userId, existing);
  connectionInfo.set(ws, { userId });
}

function unregisterConnection(userId, ws) {
  const existing = onlineUsers.get(userId);
  if (!existing) return;
  existing.delete(ws);
  if (existing.size === 0) {
    onlineUsers.delete(userId);
  }
  connectionInfo.delete(ws);
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

function listUsersWithStatus(db) {
  return db.listUsers().map((user) => ({
    id: user.id,
    nickname: user.username,
    status: onlineUsers.has(user.id) ? 'online' : 'offline',
  }));
}

function formatRoom(room) {
  const members = Array.isArray(room.members) ? room.members : [];
  if (!members.includes(room.ownerId)) {
    members.unshift(room.ownerId);
  }
  return {
    ...room,
    members,
    membersCount: members.length,
  };
}

function listRoomsForUser(db, userId) {
  return db.listRoomsForUser(userId).map(formatRoom);
}

function broadcastUsersUpdate(db) {
  const users = listUsersWithStatus(db);
  onlineUsers.forEach((sockets) => {
    broadcast(sockets, { type: 'users_update', users });
  });
}

function broadcastRoomsUpdate(db, userId) {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return;
  broadcast(sockets, { type: 'rooms_update', rooms: listRoomsForUser(db, userId) });
}

function broadcastMessageToRoom(db, roomId, payload) {
  const memberIds = db.listRoomMembers(roomId);
  memberIds.forEach((memberId) => {
    const sockets = onlineUsers.get(memberId);
    if (sockets) {
      broadcast(sockets, payload);
    }
  });
}

function attachWebSocketServer({ server, db }) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  db.listPendingInvites().forEach((invite) => {
    const expiresAtMs = new Date(invite.expiresAt).getTime();
    if (expiresAtMs <= Date.now()) {
      db.updateInvite(invite.id, 'declined');
      return;
    }
    scheduleInviteTimeout(invite.id, invite.expiresAt, () => {
      const updated = db.updateInvite(invite.id, 'declined');
      if (!updated) return;
      const fromSockets = onlineUsers.get(updated.fromUserId) || [];
      const toSockets = onlineUsers.get(updated.toUserId) || [];
      broadcast(fromSockets, { type: 'invitation_expired', invitationId: updated.id });
      broadcast(toSockets, { type: 'invitation_expired', invitationId: updated.id });
    });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let payload;
      try {
        payload = JSON.parse(data.toString());
      } catch (error) {
        send(ws, { type: 'error', message: 'Неверный формат данных.' });
        return;
      }

      if (payload.type === 'auth') {
        const { mode, nickname, password } = payload;
        if (!nickname || !password) {
          send(ws, { type: 'error', message: 'Нужен логин и пароль.' });
          return;
        }
        try {
          let user = db.getUserByUsername(nickname);
          if (mode === 'register') {
            if (user) {
              send(ws, { type: 'error', message: 'Пользователь уже существует.' });
              return;
            }
            user = db.createUser({ username: nickname, password });
          } else {
            user = db.validateUser({ username: nickname, password });
            if (!user) {
              send(ws, { type: 'error', message: 'Неверные данные входа.' });
              return;
            }
          }
          registerConnection(user.id, ws);
          send(ws, {
            type: 'auth_ok',
            user: { id: user.id, nickname: user.username },
            rooms: listRoomsForUser(db, user.id),
            users: listUsersWithStatus(db),
          });
          broadcastUsersUpdate(db);
        } catch (error) {
          send(ws, { type: 'error', message: error.message });
        }
        return;
      }

      const info = connectionInfo.get(ws);
      if (!info?.userId) {
        send(ws, { type: 'error', message: 'Сначала войдите в систему.' });
        return;
      }
      const userId = info.userId;

      if (payload.type === 'create_room') {
        const name = payload.name?.toString().trim();
        if (!name) {
          send(ws, { type: 'error', message: 'Название комнаты обязательно.' });
          return;
        }
        const room = db.createRoom({ name, ownerId: userId });
        broadcastRoomsUpdate(db, userId);
        send(ws, { type: 'room_joined', room: formatRoom(room), roomId: room.id, messages: [] });
        return;
      }

      if (payload.type === 'join_room') {
        if (!db.isRoomMember(payload.roomId, userId)) {
          send(ws, { type: 'error', message: 'Нет доступа к комнате.' });
          return;
        }
        const room = db.getRoom(payload.roomId);
        if (!room) {
          send(ws, { type: 'error', message: 'Комната не найдена.' });
          return;
        }
        const messages = db.listMessages(room.id).map((message) => ({
          ...message,
          from: db.getUserById(message.fromUserId)?.username || 'Пользователь',
          timestamp: new Date(message.createdAt).getTime(),
        }));
        send(ws, { type: 'room_joined', room: formatRoom(room), roomId: room.id, messages });
        return;
      }

      if (payload.type === 'message') {
        const roomId = payload.roomId;
        if (!db.isRoomMember(roomId, userId)) {
          send(ws, { type: 'error', message: 'Нет доступа к комнате.' });
          return;
        }
        const incoming = payload.message || {};
        const messageType = incoming.type || (incoming.file ? 'file' : 'text');
        const stored = db.addMessage({
          roomId,
          fromUserId: userId,
          type: messageType,
          text: incoming.text,
          file: incoming.file || null,
        });
        const message = {
          ...stored,
          from: db.getUserById(userId)?.username || 'Пользователь',
          timestamp: new Date(stored.createdAt).getTime(),
        };
        broadcastMessageToRoom(db, roomId, { type: 'message', roomId, message });
        return;
      }

      if (payload.type === 'invite') {
        const room = db.getRoom(payload.roomId);
        if (!room || room.ownerId !== userId) {
          send(ws, { type: 'error', message: 'Приглашать может только создатель комнаты.' });
          return;
        }
        const targetUser = db.getUserById(payload.toUserId);
        if (!targetUser) {
          send(ws, { type: 'error', message: 'Пользователь не найден.' });
          return;
        }
        if (!onlineUsers.has(targetUser.id)) {
          send(ws, { type: 'error', message: 'Пользователь сейчас оффлайн.' });
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
          if (!updated) return;
          const fromSockets = onlineUsers.get(updated.fromUserId) || [];
          const toSockets = onlineUsers.get(updated.toUserId) || [];
          broadcast(fromSockets, { type: 'invitation_expired', invitationId: updated.id });
          broadcast(toSockets, { type: 'invitation_expired', invitationId: updated.id });
        });
        const invitationPayload = {
          id: invite.id,
          roomId: room.id,
          roomTitle: room.name,
          from: db.getUserById(userId)?.username || 'Пользователь',
          fromId: userId,
          expiresAt: invite.expiresAt,
        };
        const targetSockets = onlineUsers.get(targetUser.id) || [];
        broadcast(targetSockets, { type: 'invitation', invitation: invitationPayload });
        send(ws, { type: 'invitation_sent', invitation: invitationPayload });
        return;
      }

      if (payload.type === 'invitation_response') {
        const invite = db.updateInvite(
          payload.invitationId,
          payload.action === 'accept' ? 'accepted' : 'declined'
        );
        if (!invite) {
          send(ws, { type: 'error', message: 'Приглашение не найдено.' });
          return;
        }
        clearInviteTimeout(invite.id);
        if (payload.action === 'accept') {
          db.addRoomMember(invite.roomId, invite.toUserId);
          broadcastRoomsUpdate(db, invite.toUserId);
          broadcastRoomsUpdate(db, invite.fromUserId);
        }
        const fromSockets = onlineUsers.get(invite.fromUserId) || [];
        const toSockets = onlineUsers.get(invite.toUserId) || [];
        broadcast(fromSockets, { type: 'invitation_response', invite });
        broadcast(toSockets, { type: 'invitation_response', invite });
        return;
      }
    });

    ws.on('close', () => {
      const info = connectionInfo.get(ws);
      if (!info?.userId) return;
      unregisterConnection(info.userId, ws);
      broadcastUsersUpdate(db);
    });
  });

  return wss;
}

module.exports = { attachWebSocketServer, onlineUsers };
