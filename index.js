const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const fileUpload = require('express-fileupload');

cloudinary.config({
  cloud_name: 'djqas8rjp',
  api_key: '413989616896491',
  api_secret: 'zhtHF709f82XVvAJK-XfcEnYslY'
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(fileUpload({ useTempFiles: false }));

const SECRET = 'chatapp_secret_key';
const users = {};
const messages = {};
const onlineUsers = {};
const lastSeen = {};
const profiles = {};
const statuses = {};

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (users[username]) return res.status(400).json({ error: 'User exists' });
  users[username] = await bcrypt.hash(password, 10);
  res.json({ message: 'Registered!' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!users[username]) return res.status(400).json({ error: 'User not found' });
  const valid = await bcrypt.compare(password, users[username]);
  if (!valid) return res.status(400).json({ error: 'Wrong password' });
  const token = jwt.sign({ username }, SECRET);
  res.json({ token, username, avatar: profiles[username] || null });
});

app.get('/users', (req, res) => {
  const list = Object.keys(users).map(u => ({ username: u, avatar: profiles[u] || null }));
  res.json(list);
});

app.get('/lastseen', (req, res) => res.json(lastSeen));

app.get('/statuses', (req, res) => {
  const now = Date.now();
  const active = {};
  for (const user in statuses) {
    active[user] = statuses[user].filter(s => now - s.time < 86400000);
    if (active[user].length === 0) delete active[user];
  }
  res.json(active);
});

app.post('/status', async (req, res) => {
  try {
    const { username, text, color } = req.body;
    let mediaUrl = null, mediaType = null;
    if (req.files && req.files.media) {
      const file = req.files.media;
      const isVideo = file.mimetype.startsWith('video/');
      const resourceType = isVideo ? 'video' : 'image';
      const b64 = file.data.toString('base64');
      const dataUri = `data:${file.mimetype};base64,${b64}`;
      const result = await cloudinary.uploader.upload(dataUri, { resource_type: resourceType, folder: 'chatapp/statuses' });
      mediaUrl = result.secure_url;
      mediaType = resourceType;
    }
    if (!statuses[username]) statuses[username] = [];
    const status = { id: Date.now().toString(), username, text: text || '', color: color || '#075e54', mediaUrl, mediaType, time: Date.now(), views: [] };
    statuses[username].push(status);
    io.emit('new_status', { username, status });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/status/view', (req, res) => {
  const { statusId, username, viewer } = req.body;
  if (statuses[username]) {
    const s = statuses[username].find(s => s.id === statusId);
    if (s && !s.views.includes(viewer)) s.views.push(viewer);
  }
  res.json({ success: true });
});

app.post('/upload', async (req, res) => {
  try {
    if (!req.files || !req.files.file) return res.status(400).json({ error: 'No file' });
    const file = req.files.file;
    const isImage = file.mimetype.startsWith('image/');
    const isVideo = file.mimetype.startsWith('video/');
    const resourceType = isImage ? 'image' : isVideo ? 'video' : 'raw';
    const b64 = file.data.toString('base64');
    const dataUri = `data:${file.mimetype};base64,${b64}`;
    const result = await cloudinary.uploader.upload(dataUri, { resource_type: resourceType, folder: 'chatapp' });
    res.json({ url: result.secure_url, type: resourceType, name: file.name, mimetype: file.mimetype });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload-avatar', async (req, res) => {
  try {
    const { username } = req.body;
    if (!req.files || !req.files.avatar) return res.status(400).json({ error: 'No file' });
    const file = req.files.avatar;
    const b64 = file.data.toString('base64');
    const dataUri = `data:${file.mimetype};base64,${b64}`;
    const result = await cloudinary.uploader.upload(dataUri, { folder: 'chatapp/avatars', transformation: [{ width: 200, height: 200, crop: 'fill' }] });
    profiles[username] = result.secure_url;
    io.emit('avatar_update', { username, avatar: result.secure_url });
    res.json({ avatar: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  socket.on('join', ({ username }) => {
    onlineUsers[username] = socket.id;
    socket.username = username;
    delete lastSeen[username];
    io.emit('online_users', Object.keys(onlineUsers));
    io.emit('lastseen_update', lastSeen);
  });

  socket.on('send_message', ({ to, from, text, file }) => {
    const roomId = [from, to].sort().join('_');
    if (!messages[roomId]) messages[roomId] = [];
    const msg = { id: Date.now().toString(), from, to, text: text || '', file: file || null, time: new Date().toISOString(), status: onlineUsers[to] ? 'delivered' : 'sent' };
    messages[roomId].push(msg);
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('receive_message', { roomId, msg });
    socket.emit('receive_message', { roomId, msg });
  });

  socket.on('msg_read', ({ msgId, roomId, from }) => {
    const room = messages[roomId];
    if (room) { const msg = room.find(m => m.id === msgId); if (msg) msg.status = 'read'; }
    if (onlineUsers[from]) io.to(onlineUsers[from]).emit('msg_status', { msgId, status: 'read' });
  });

  socket.on('get_messages', ({ user1, user2 }) => {
    const roomId = [user1, user2].sort().join('_');
    socket.emit('message_history', { roomId, messages: messages[roomId] || [] });
  });

  socket.on('typing_start', ({ from, to }) => {
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('typing', { from, typing: true });
  });

  socket.on('typing_stop', ({ from, to }) => {
    if (onlineUsers[to]) io.to(onlineUsers[to]).emit('typing', { from, typing: false });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      lastSeen[socket.username] = new Date().toISOString();
      delete onlineUsers[socket.username];
      io.emit('online_users', Object.keys(onlineUsers));
      io.emit('lastseen_update', lastSeen);
    }
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
