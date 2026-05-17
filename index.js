const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(cors());
app.use(express.json());
const SECRET = 'chatapp_secret_key';
const users = {};
const messages = {};
const onlineUsers = {};
const lastSeen = {};
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
  res.json({ token, username });
});
app.get('/users', (req, res) => res.json(Object.keys(users)));
app.get('/lastseen', (req, res) => res.json(lastSeen));
io.on('connection', (socket) => {
  socket.on('join', ({ username }) => {
    onlineUsers[username] = socket.id;
    socket.username = username;
    delete lastSeen[username];
    for (const roomId in messages) {
      if (roomId.includes(username)) {
        messages[roomId].forEach(msg => {
          if (msg.to === username && msg.status === 'sent') {
            msg.status = 'delivered';
            const sender = onlineUsers[msg.from];
            if (sender) io.to(sender).emit('msg_status', { msgId: msg.id, status: 'delivered' });
          }
        });
      }
    }
    io.emit('online_users', Object.keys(onlineUsers));
    io.emit('lastseen_update', lastSeen);
  });
  socket.on('send_message', ({ to, from, text }) => {
    const roomId = [from, to].sort().join('_');
    if (!messages[roomId]) messages[roomId] = [];
    const msg = { id: Date.now().toString(), from, to, text, time: new Date().toISOString(), status: onlineUsers[to] ? 'delivered' : 'sent' };
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
