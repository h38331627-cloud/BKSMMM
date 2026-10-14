const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IS_PROD = process.env.NODE_ENV === 'production';
fs.mkdirSync(DATA_DIR, { recursive: true });

// Session secret: env var, ya pehli baar random bana kar file mein save
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, '.session_secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8');
}

const db = new Database(path.join(DATA_DIR, 'bksmm.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || (ADMIN_USERNAME ? ADMIN_USERNAME + '@admin.local' : '')).trim();
db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);

// Login restart ke baad bhi bana rahe, isliye sessions SQLite mein
class SqliteStore extends session.Store {
  get(sid, cb) {
    try { const r = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); }
    catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?,?,?)').run(sid, JSON.stringify(sess), exp); cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}
setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); db.prepare('DELETE FROM password_resets WHERE expires < ?').run(Date.now()); } catch (_) {} }, 3600e3).unref();

const app = express();
if (IS_PROD) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'bksmm.sid',
  store: new SqliteStore(),
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 * 14 }
}));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Bahut zyada koshish. Thodi der baad try karo.' } });

const USERNAME_RE = /^[A-Za-z0-9_.]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sendJson = (res, code, obj) => res.status(code).json(obj);
const login = (req, user) => new Promise((resolve, reject) =>
  req.session.regenerate(err => {
    if (err) return reject(err);
    req.session.uid = user.id;
    req.session.save(e => (e ? reject(e) : resolve()));
  }));

// ---------- Auth API ----------
app.get('/auth/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

app.post('/auth/signup', authLimiter, async (req, res) => {
  try {
    const { username = '', email = '', password = '' } = req.body || {};
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username 3-24 characters ka ho (letters, numbers, _ ya .).' });
    if (!EMAIL_RE.test(email) || email.length > 120) return sendJson(res, 400, { error: 'Sahi email daalo.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return sendJson(res, 400, { error: 'Password 8 se 72 characters ka ho.' });
    if (ADMIN_USERNAME && (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() || email.toLowerCase() === ADMIN_EMAIL.toLowerCase()))
      return sendJson(res, 409, { error: 'Username ya email pehle se registered hai.' });
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email);
    if (exists) return sendJson(res, 409, { error: 'Username ya email pehle se registered hai.' });
    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?,?,?)').run(username, email, hash);
    await login(req, { id: info.lastInsertRowid });
    sendJson(res, 200, { ok: true });
  } catch (e) { console.error(e); sendJson(res, 500, { error: 'Server error.' }); }
});

app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { username = '', password = '' } = req.body || {};
    // username ya email dono chalenge
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
    const ok = user && user.password_hash && await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      if (user && !user.password_hash) return sendJson(res, 401, { error: 'Ye account Google se bana hai. "Sign in with Google" use karo.' });
      return sendJson(res, 401, { error: 'Username ya password galat hai.' });
    }
    await login(req, user);
    sendJson(res, 200, { ok: true });
  } catch (e) { console.error(e); sendJson(res, 500, { error: 'Server error.' }); }
});

const gClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
app.post('/auth/google', authLimiter, async (req, res) => {
  try {
    if (!gClient) return sendJson(res, 503, { error: 'Google login abhi set up nahi hai.' });
    const ticket = await gClient.verifyIdToken({ idToken: String((req.body || {}).credential || ''), audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email || !p.email_verified) return sendJson(res, 401, { error: 'Google email verified nahi hai.' });
    let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(p.sub);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(p.email);
      if (user) {
        // email pehle password se bina verify register hua ho sakta hai: wo password hata do, asli owner (Google) ka hi control rahe
        if (!user.google_sub && user.password_hash && !user.is_admin) {
          db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(user.id);
          db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.uid') = ?").run(user.id);
        }
        db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(p.sub, user.id);
      } else {
        let base = p.email.split('@')[0].replace(/[^A-Za-z0-9_.]/g, '').slice(0, 18) || 'user';
        if (base.length < 3) base += '_user';
        let name = base;
        while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) name = base + Math.floor(Math.random() * 10000);
        const info = db.prepare('INSERT INTO users (username, email, google_sub) VALUES (?,?,?)').run(name, p.email, p.sub);
        user = { id: info.lastInsertRowid };
      }
    }
    await login(req, user);
    sendJson(res, 200, { ok: true });
  } catch (e) { console.error('google auth', e.message); sendJson(res, 401, { error: 'Google login fail hua.' }); }
});

// ---------- Forgot password / username ----------
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const mailer = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +(process.env.SMTP_PORT || 465),
      secure: (process.env.SMTP_PORT || '465') === '465', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  : null;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

app.post('/auth/forgot', authLimiter, async (req, res) => {
  const generic = { ok: true, message: 'Agar ye email registered hai to reset link bhej diya gaya hai. Inbox/Spam check karo.' };
  try {
    const email = String((req.body || {}).email || '').trim();
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Sahi email daalo.' });
    const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email);
    if (user) {
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires) VALUES (?,?,?)').run(sha(token), user.id, Date.now() + 30 * 60 * 1000);
      const link = `${APP_URL}/reset?token=${token}`;
      const text = `Hello ${user.username},\n\nTumhara BKSMM username: ${user.username}\n\nPassword reset karne ke liye ye link kholo (30 minute tak valid):\n${link}\n\nAgar tumne request nahi ki to is mail ko ignore karo.`;
      if (mailer) await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: user.email, subject: 'BKSMM - Password reset', text });
      else console.log(`[SMTP set nahi hai] ${user.email} ka reset link: ${link}`);
    }
    sendJson(res, 200, generic);   // email registered ho ya na ho, same jawab
  } catch (e) { console.error('forgot', e.message); sendJson(res, 200, generic); }
});

app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.post('/auth/reset', authLimiter, async (req, res) => {
  try {
    const { token = '', password = '' } = req.body || {};
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return sendJson(res, 400, { error: 'Password 8 se 72 characters ka ho.' });
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires > ?').get(sha(String(token)), Date.now());
    if (!row) return sendJson(res, 400, { error: 'Link galat ya expire ho gaya. Dobara "Forgot password" karo.' });
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
    // purane sab sessions band (kisi aur ke paas login ho to wo bhi hat jaye)
    db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.uid') = ?").run(row.user_id);
    await login(req, { id: row.user_id });
    sendJson(res, 200, { ok: true });
  } catch (e) { console.error(e); sendJson(res, 500, { error: 'Server error.' }); }
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('bksmm.sid'); res.json({ ok: true }); }));

// ---------- Pages ----------
const currentUser = req => req.session && req.session.uid
  ? db.prepare('SELECT id, username, email, balance, is_admin FROM users WHERE id = ?').get(req.session.uid) : null;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/login', (req, res) => currentUser(req) ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.redirect('/login#signup'));

const dashboardHtml = fs.readFileSync(path.join(__dirname, 'views', 'dashboard.html'), 'utf8');
app.get('/', (req, res) => {
  const u = currentUser(req);
  const box = 'position:fixed;top:0;right:0;z-index:99999;background:#0b1220;color:#fff;font:13px/1 sans-serif;padding:8px 12px;border-bottom-left-radius:10px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;max-width:100%';
  const lk = (h, t, c = '#7dd3fc') => `<a href="${h}" style="color:${c}">${t}</a>`;
  const bar = u
    ? `<div style="${box}"><span>👤 ${esc(u.username)} · ₹${u.balance.toFixed(2)}</span>${lk('/order', 'New order')}${lk('/orders', 'Orders')}${lk('/services', 'Services')}${lk('/addfunds', 'Add funds')}${u.is_admin ? lk('/admin', 'Admin', '#fde68a') : ''}
<a href="#" onclick="fetch('/auth/logout',{method:'POST'}).then(()=>location='/');return false" style="color:#fca5a5">Logout</a></div>`
    : `<div style="${box}">${lk('/services', 'Services')}${lk('/login', 'Login')}${lk('/signup', 'Sign up', '#86efac')}</div>`;
  // purane PerfectPanel order form ko apne /order page par bhej do
  const hook = `<script>document.addEventListener('submit',function(e){if(e.target&&e.target.id==='order-form'){e.preventDefault();e.stopImmediatePropagation();location.href='/order';}},true);</script>`;
  res.set('Cache-Control', 'no-store').type('html').send(dashboardHtml.replace(/<body[^>]*>/i, m => m + bar + hook));
});

const simplePage = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - BKSMM</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{background:#111a2e;border:1px solid #1f2b46;border-radius:14px;padding:28px;max-width:440px;text-align:center}a{color:#7dd3fc}</style></head>
<body><div class="c"><h2>${title}</h2>${body}<p><a href="/">← Wapas</a></p></div></body></html>`;

app.get('/addfunds', (req, res) => {
  res.send(simplePage('Add funds', '<p><strong>Contact for add fund user - <a href="https://t.me/Mbbsloverr" target="_blank" rel="noopener">@Mbbsloverr</a></strong></p>'));
});

// Order form abhi kisi provider se connected nahi hai - jhoota success nahi dikhayenge
const sendPage = (res, f) => res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', f));
require('./orders')(app, { db, currentUser, sendJson, sendPage });
app.post('/', (req, res) => res.status(410).json({ error: 'Order ke liye /order page use karo.' }));

// Baaki panel pages (orders, tickets, etc.) abhi bane nahi
app.get('*', (req, res) => {
  res.status(404).send(simplePage('Jald aa raha hai', '<p>Ye page abhi available nahi hai.</p>'));
});

if (ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
  const ex = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (ex) db.prepare('UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?').run(hash, ex.id);
  else db.prepare('INSERT INTO users (username, email, password_hash, is_admin) VALUES (?,?,?,1)').run(ADMIN_USERNAME, ADMIN_EMAIL, hash);
  db.prepare('UPDATE users SET is_admin = 0 WHERE username <> ?').run(ADMIN_USERNAME);
  console.log('Admin account ready:', ADMIN_USERNAME);
} else db.prepare('UPDATE users SET is_admin = 0').run();

app.listen(PORT, () => console.log(`BKSMM running on :${PORT} (Google login: ${GOOGLE_CLIENT_ID ? 'ON' : 'OFF'})`));
