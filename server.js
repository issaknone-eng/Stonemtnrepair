const express = require('express');
const session = require('express-session');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_ADMIN = {
  id: 'u1', username: 'admin', password: 'admin1234',
  name: 'Admin', role: 'Admin', active: true,
};

function readData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('readData error:', e); }
  return null;
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
}

function getUsers() {
  const d = readData();
  if (d && Array.isArray(d.users) && d.users.length) return d.users;
  return [DEFAULT_ADMIN];
}

// ── Middleware ──────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'storemtn-change-this-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8-hour sessions
}));

// Block direct access to server-side files
const BLOCKED = new Set([
  '/server.js', '/package.json', '/package-lock.json',
  '/data.json', '/main.js', '/preload.js',
]);
app.use((req, res, next) => {
  if (BLOCKED.has(req.path)) return res.status(404).end();
  next();
});

// ── Auth routes ─────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const user = getUsers().find(
    u => u.username === username && u.password === password && u.active
  );
  if (!user)
    return res.status(401).json({ error: 'Invalid username or password.' });

  req.session.userId = user.id;
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId)
    return res.status(401).json({ error: 'Not authenticated' });

  const user = getUsers().find(u => u.id === req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'User not found' });
  }
  const { password: _, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ── Data routes ─────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: 'Not authenticated' });
  next();
}

app.get('/api/data', requireAuth, (req, res) => {
  res.json(readData() || {});
});

app.put('/api/data', requireAuth, (req, res) => {
  writeData(req.body);
  res.json({ ok: true });
});

app.delete('/api/data', requireAuth, (req, res) => {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// ── Static files ────────────────────────────────────────────────────
app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stone MTN Portal → http://localhost:${PORT}`);
});
