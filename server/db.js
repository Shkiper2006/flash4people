const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'DB.dat');

const DEFAULT_DATA = {
  users: [],
  sessions: {},
  rooms: [],
  messages: [],
  invites: [],
  files: [],
};

class Database {
  constructor() {
    this.data = this.load();
  }

  load() {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw.trim()) {
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const parsed = JSON.parse(raw);
    return { ...JSON.parse(JSON.stringify(DEFAULT_DATA)), ...parsed };
  }

  save() {
    fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2));
  }

  hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  createUser({ username, password }) {
    if (this.data.users.find((user) => user.username === username)) {
      throw new Error('User already exists');
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: this.hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  validateUser({ username, password }) {
    const user = this.data.users.find((entry) => entry.username === username);
    if (!user) {
      return null;
    }
    return user.passwordHash === this.hashPassword(password) ? user : null;
  }

  getUserById(userId) {
    return this.data.users.find((user) => user.id === userId) || null;
  }

  getUserByUsername(username) {
    return this.data.users.find((user) => user.username === username) || null;
  }

  listUsers() {
    return [...this.data.users];
  }

  createSession(userId) {
    const token = crypto.randomUUID();
    this.data.sessions[token] = {
      userId,
      createdAt: new Date().toISOString(),
    };
    this.save();
    return token;
  }

  getSession(token) {
    return this.data.sessions[token] || null;
  }

  deleteSession(token) {
    delete this.data.sessions[token];
    this.save();
  }

  listRoomsByOwner(ownerId) {
    return this.data.rooms.filter((room) => room.ownerId === ownerId);
  }

  listRoomsForUser(userId) {
    return this.data.rooms.filter((room) => {
      if (room.ownerId === userId) {
        return true;
      }
      if (Array.isArray(room.members)) {
        return room.members.includes(userId);
      }
      return false;
    });
  }

  getRoom(roomId) {
    return this.data.rooms.find((room) => room.id === roomId) || null;
  }

  createRoom({ name, ownerId }) {
    const room = {
      id: crypto.randomUUID(),
      name,
      ownerId,
      members: [ownerId],
      createdAt: new Date().toISOString(),
    };
    this.data.rooms.push(room);
    this.save();
    return room;
  }

  updateRoom(roomId, { name }) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    room.name = name ?? room.name;
    room.updatedAt = new Date().toISOString();
    this.save();
    return room;
  }

  addRoomMember(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return null;
    }
    room.members = Array.isArray(room.members) ? room.members : [];
    if (!room.members.includes(userId)) {
      room.members.push(userId);
      room.updatedAt = new Date().toISOString();
      this.save();
    }
    return room;
  }

  isRoomMember(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return false;
    }
    if (room.ownerId === userId) {
      return true;
    }
    if (!Array.isArray(room.members)) {
      return false;
    }
    return room.members.includes(userId);
  }

  listRoomMembers(roomId) {
    const room = this.getRoom(roomId);
    if (!room) {
      return [];
    }
    const members = Array.isArray(room.members) ? room.members : [];
    if (!members.includes(room.ownerId)) {
      return [room.ownerId, ...members];
    }
    return [...members];
  }

  deleteRoom(roomId) {
    this.data.rooms = this.data.rooms.filter((room) => room.id !== roomId);
    this.data.messages = this.data.messages.filter((msg) => msg.roomId !== roomId);
    this.data.invites = this.data.invites.filter((invite) => invite.roomId !== roomId);
    this.save();
  }

  addMessage({ roomId, fromUserId, type, text, file }) {
    const message = {
      id: crypto.randomUUID(),
      roomId,
      fromUserId,
      type,
      text: text || null,
      file: file || null,
      createdAt: new Date().toISOString(),
    };
    this.data.messages.push(message);
    this.save();
    return message;
  }

  listMessages(roomId) {
    return this.data.messages.filter((msg) => msg.roomId === roomId);
  }

  createInvite({ roomId, fromUserId, toUserId, expiresAt }) {
    const invite = {
      id: crypto.randomUUID(),
      roomId,
      fromUserId,
      toUserId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    this.data.invites.push(invite);
    this.save();
    return invite;
  }

  updateInvite(inviteId, status) {
    const invite = this.data.invites.find((entry) => entry.id === inviteId);
    if (!invite) {
      return null;
    }
    invite.status = status;
    invite.updatedAt = new Date().toISOString();
    this.save();
    return invite;
  }

  listPendingInvites() {
    return this.data.invites.filter((invite) => invite.status === 'pending');
  }
}

module.exports = Database;
