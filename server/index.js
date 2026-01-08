const express = require('express');
const http = require('http');
const path = require('path');

const Database = require('./db');
const { attachFileRoutes } = require('./files');
const { attachWebSocketServer } = require('./ws');
const { attachSignalingServer } = require('./signaling');

const app = express();
const server = http.createServer(app);
const db = new Database();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

attachFileRoutes({ app });

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return null;
}

function authMiddleware(req, res, next) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  const session = db.getSession(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }
  const user = db.getUserById(session.userId);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  try {
    const user = db.createUser({ username, password });
    const token = db.createSession(user.id);
    res.status(201).json({ token, user: { id: user.id, username: user.username } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  const user = db.validateUser({ username, password });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const token = db.createSession(user.id);
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  db.deleteSession(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/rooms', authMiddleware, (req, res) => {
  res.json({ rooms: db.listRoomsForUser(req.user.id) });
});

app.post('/api/rooms', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Room name required' });
    return;
  }
  const room = db.createRoom({ name, ownerId: req.user.id });
  res.status(201).json({ room });
});

app.get('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room || !db.isRoomMember(room.id, req.user.id)) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const messages = db.listMessages(room.id);
  res.json({ room, messages });
});

app.put('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room || room.ownerId !== req.user.id) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const updated = db.updateRoom(room.id, { name: req.body.name });
  res.json({ room: updated });
});

app.delete('/api/rooms/:id', authMiddleware, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room || room.ownerId !== req.user.id) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  db.deleteRoom(room.id);
  res.json({ ok: true });
});

attachWebSocketServer({ server, db });
attachSignalingServer({ server });

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
