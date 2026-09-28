const express      = require('express');
const session       = require('express-session');
const rateLimit     = require('express-rate-limit');
const bcrypt        = require('bcryptjs');
const crypto        = require('crypto');
const fs             = require('fs');
const path           = require('path');

const app       = express();
const DATA_FILE = path.join(__dirname, 'data.json');
const PIN_SENTINEL      = '••••••••'; // masked placeholder, never a real value
const PASSWORD_SENTINEL = '••••••••';
const BCRYPT_RE = /^\$2[aby]\$/;

// ── Session secret ──────────────────────────────────────────────────
// A weak, publicly-known fallback lets anyone forge a session cookie for
// any user id. If SESSION_SECRET isn't configured we generate a random
// one at boot instead — sessions won't survive a restart, but they can
// never be forged. Set SESSION_SECRET in Railway's variables for
// persistent sessions across deploys.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[stonemtn] SESSION_SECRET is not set — using a random secret for this process. ' +
    'All sessions will be invalidated on restart. Set SESSION_SECRET in your environment for persistent sessions.');
}

const DEFAULT_ADMIN = {
  id: 'u1', username: 'admin', password: bcrypt.hashSync('admin1234', 10),
  name: 'Admin', role: 'Admin', active: true, forcePasswordChange: true,
};

function readData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('readData error:', e); }
  return null;
}

// Atomic write: write to a temp file, then rename over the target.
// Prevents two concurrent saves from interleaving and corrupting the file.
function writeData(data) {
  const tmp = DATA_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function getUsers() {
  const d = readData();
  if (d && Array.isArray(d.users) && d.users.length) return d.users;
  return [DEFAULT_ADMIN];
}

function getUserById(id) {
  return getUsers().find(u => u.id === id);
}

// ── Middleware ──────────────────────────────────────────────────────
app.set('trust proxy', 1); // Railway terminates TLS in front of us
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8-hour sessions
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Block direct access to server-side files
const BLOCKED = new Set([
  '/server.js', '/package.json', '/package-lock.json',
  '/data.json', '/main.js', '/preload.js',
]);
app.use((req, res, next) => {
  if (BLOCKED.has(req.path.toLowerCase())) return res.status(404).end();
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

// ── Auth routes ─────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const users = getUsers();
  const user = users.find(u => u.username === username && u.active);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  let ok = false;
  if (BCRYPT_RE.test(user.password)) {
    ok = bcrypt.compareSync(password, user.password);
  } else {
    // Legacy plaintext record — verify, then transparently upgrade to a hash.
    ok = user.password === password;
    if (ok) {
      const d = readData() || { users };
      const u = (d.users || users).find(x => x.id === user.id);
      if (u) { u.password = bcrypt.hashSync(password, 10); writeData({ ...d, users: d.users || users }); }
    }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  req.session.userId = user.id;
  const { password: _pw, ...safeUser } = user;
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
  const { password: _pw, ...safeUser } = user;
  res.json({ user: safeUser });
});

function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: 'Not authenticated' });
  req.currentUser = getUserById(req.session.userId);
  if (!req.currentUser || !req.currentUser.active) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.currentUser.role))
      return res.status(403).json({ error: 'Insufficient permissions.' });
    next();
  };
}

// Self-service password change (used by the "Change PW" admin-account flow).
// Verifies the CURRENT password server-side — the real hash never reaches the client.
app.put('/api/auth/password', requireAuth, requireRole('Admin'), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Current and new password required.' });

  const d = readData();
  if (!d || !Array.isArray(d.users)) return res.status(400).json({ error: 'No data to update.' });
  const target = d.users.find(u => u.role === 'Admin');
  if (!target) return res.status(404).json({ error: 'Admin account not found.' });

  const matches = BCRYPT_RE.test(target.password)
    ? bcrypt.compareSync(currentPassword, target.password)
    : target.password === currentPassword;
  if (!matches) return res.status(401).json({ error: 'Current password is incorrect.' });

  target.password = bcrypt.hashSync(newPassword, 10);
  target.forcePasswordChange = false;
  writeData(d);
  res.json({ ok: true });
});

// Admin-PIN verification — the PIN itself never leaves the server.
app.post('/api/auth/verify-pin', requireAuth, (req, res) => {
  const { pin } = req.body || {};
  const d = readData();
  const stored = (d && d.storeSettings && d.storeSettings.adminPin) || '';
  if (!stored) return res.json({ ok: true }); // no PIN configured — allow through
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN required.' });

  let ok;
  if (BCRYPT_RE.test(stored)) {
    ok = bcrypt.compareSync(pin.toString().trim(), stored);
  } else {
    ok = stored === pin.toString().trim();
    if (ok) { d.storeSettings.adminPin = bcrypt.hashSync(pin.toString().trim(), 10); writeData(d); }
  }
  res.json({ ok });
});

// ── Data routes ─────────────────────────────────────────────────────
const SENSITIVE_TOP_LEVEL_KEYS = ['users']; // only Admin may write these via the bulk endpoint

app.get('/api/data', requireAuth, (req, res) => {
  const d = readData() || {};
  const out = { ...d };
  if (Array.isArray(out.users)) {
    out.users = out.users.map(u => ({ ...u, password: PASSWORD_SENTINEL }));
  }
  if (out.storeSettings) {
    out.storeSettings = { ...out.storeSettings };
    if (req.currentUser.role === 'Admin') {
      if (out.storeSettings.adminPin) out.storeSettings.adminPin = PIN_SENTINEL;
    } else {
      delete out.storeSettings.adminPin;
    }
  }
  res.json(out);
});

app.put('/api/data', requireAuth, (req, res) => {
  const incoming = req.body || {};
  const existing = readData() || {};
  const isAdminUser = req.currentUser.role === 'Admin';

  const merged = { ...incoming };

  if (!isAdminUser) {
    // Non-admins can never touch account records or the admin PIN, no matter
    // what their client sends — the server's copy always wins. getUsers()
    // (not existing.users) so the built-in default admin survives until the
    // very first real write, instead of resolving to an empty array.
    merged.users = getUsers();
    merged.storeSettings = {
      ...(incoming.storeSettings || {}),
      adminPin: existing.storeSettings ? existing.storeSettings.adminPin : undefined,
    };
  } else {
    // Admin: reconcile password sentinels back to real stored hashes, and
    // hash any genuinely new password values.
    const existingUsers = getUsers();
    if (Array.isArray(merged.users)) {
      merged.users = merged.users.map(u => {
        const prior = existingUsers.find(x => x.id === u.id);
        let pw = u.password;
        if (!pw || pw === PASSWORD_SENTINEL) {
          pw = prior ? prior.password : bcrypt.hashSync(crypto.randomBytes(9).toString('base64url'), 10);
        } else if (!BCRYPT_RE.test(pw)) {
          pw = bcrypt.hashSync(pw, 10);
        }
        return { ...u, password: pw };
      });
    }
    if (merged.storeSettings) {
      const priorPin = existing.storeSettings ? existing.storeSettings.adminPin : undefined;
      const pin = merged.storeSettings.adminPin;
      if (pin === PIN_SENTINEL) {
        merged.storeSettings.adminPin = priorPin; // unchanged — keep the stored hash
      } else if (!pin) {
        merged.storeSettings.adminPin = ''; // explicitly cleared / never set — "blank to disable"
      } else if (!BCRYPT_RE.test(pin)) {
        merged.storeSettings.adminPin = bcrypt.hashSync(pin.toString().trim(), 10);
      }
    }
  }

  writeData(merged);
  res.json({ ok: true });
});

app.delete('/api/data', requireAuth, requireRole('Admin'), (req, res) => {
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
