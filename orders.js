// Provider (SMM API v2) + services + orders + admin balance
const API_URL = process.env.SMM_API_URL || '';
const API_KEY = process.env.SMM_API_KEY || '';
const MARKUP = Number.isFinite(+process.env.MARKUP_PERCENT) ? +process.env.MARKUP_PERCENT : 30;
const FINAL = new Set(['Completed', 'Partial', 'Canceled', 'Failed']);
const r2 = n => Math.round(n * 100) / 100;

async function provider(params) {
  if (!API_URL || !API_KEY) throw new Error('Provider API set nahi hai.');
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: API_KEY, ...params }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  if (j && typeof j === 'object' && j.error) throw new Error(String(j.error));
  return j;
}

let cache = { at: 0, list: [], map: new Map() };
async function getServices() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.list.length) return cache;
  const raw = await provider({ action: 'services' });
  if (!Array.isArray(raw)) throw new Error('Provider se services nahi mili.');
  const list = raw
    .filter(s => String(s.type || 'Default').toLowerCase() === 'default') // custom comments/package abhi support nahi
    .map(s => ({
      id: +s.service, name: String(s.name), category: String(s.category || 'Other'),
      rate: +s.rate, min: +s.min, max: +s.max,
      price: r2(+s.rate * (1 + MARKUP / 100) * 10000) / 10000   // user ko dikhne wala rate per 1000
    }))
    .filter(s => s.id && s.rate >= 0 && s.min > 0 && s.max >= s.min);
  cache = { at: Date.now(), list, map: new Map(list.map(s => [s.id, s])) };
  return cache;
}

module.exports = function mount(app, { db, currentUser, sendJson, sendPage }) {
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, service_id INTEGER NOT NULL, service_name TEXT NOT NULL,
    link TEXT NOT NULL, quantity INTEGER NOT NULL, charge REAL NOT NULL, provider_order TEXT,
    status TEXT NOT NULL DEFAULT 'Placing', remains INTEGER, start_count INTEGER, refunded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, checked_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS credits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, by_admin TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

  const needUser = (req, res) => { const u = currentUser(req); if (!u) sendJson(res, 401, { error: 'Pehle login karo.' }); return u; };
  const needAdmin = (req, res) => { const u = needUser(req, res); if (!u) return null; if (!u.is_admin) { sendJson(res, 403, { error: 'Sirf admin.' }); return null; } return u; };

  // pages (sab ek hi panel.html, JS path dekh kar dikhata hai)
  for (const p of ['/order', '/orders', '/services', '/admin']) app.get(p, (req, res) => sendPage(res, 'panel.html'));

  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    sendJson(res, 200, u ? { username: u.username, balance: u.balance, admin: !!u.is_admin } : { guest: true });
  });

  app.get('/api/services', async (req, res) => {
    try { const c = await getServices(); sendJson(res, 200, c.list.map(({ rate, ...s }) => s)); }
    catch (e) { console.error('services', e.message); sendJson(res, 502, { error: 'Services abhi load nahi ho pa rahi. Thodi der baad try karo.' }); }
  });

  app.post('/api/order', async (req, res) => {
    const u = needUser(req, res); if (!u) return;
    let orderId = null, charge = 0;
    try {
      const b = req.body || {};
      const sid = parseInt(b.service, 10), qty = parseInt(b.quantity, 10), link = String(b.link || '').trim();
      if (!/^(https?:\/\/|@)\S{2,500}$/i.test(link)) return sendJson(res, 400, { error: 'Sahi link ya @username daalo.' });
      const { map } = await getServices();
      const s = map.get(sid);
      if (!s) return sendJson(res, 400, { error: 'Service nahi mili.' });
      if (!Number.isInteger(qty) || qty < s.min || qty > s.max) return sendJson(res, 400, { error: `Quantity ${s.min} se ${s.max} ke beech ho.` });
      charge = Math.ceil(s.rate * (1 + MARKUP / 100) * qty / 1000 * 100 - 1e-9) / 100;
      // paise pehle kaato (atomic), fail hua to wapas
      const tx = db.transaction(() => {
        const d = db.prepare('UPDATE users SET balance = ROUND(balance - ?, 2) WHERE id = ? AND balance >= ?').run(charge, u.id, charge);
        if (!d.changes) return null;
        return db.prepare('INSERT INTO orders (user_id, service_id, service_name, link, quantity, charge) VALUES (?,?,?,?,?,?)')
          .run(u.id, s.id, s.name, link, qty, charge).lastInsertRowid;
      });
      orderId = tx();
      if (!orderId) return sendJson(res, 402, { error: 'Balance kam hai. Add funds ke liye @Mbbsloverr se contact karo.' });
      try {
        const out = await provider({ action: 'add', service: s.id, link, quantity: qty });
        if (!out || !out.order) throw new Error('no order id');
        db.prepare("UPDATE orders SET provider_order = ?, status = 'Pending' WHERE id = ?").run(String(out.order), orderId);
        const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(u.id).balance;
        sendJson(res, 200, { ok: true, order: orderId, charge, balance: bal });
      } catch (e) {
        console.error('provider add', e.message);
        db.transaction(() => {
          db.prepare("UPDATE orders SET status = 'Failed', refunded = 1 WHERE id = ?").run(orderId);
          db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(charge, u.id);
        })();
        sendJson(res, 502, { error: 'Order place nahi ho paya, paise wapas kar diye gaye. Thodi der baad try karo.' });
      }
    } catch (e) { console.error('order', e.message); sendJson(res, 500, { error: 'Server error.' }); }
  });

  async function refresh(userId) {
    const rows = db.prepare(`SELECT * FROM orders WHERE user_id = ? AND provider_order IS NOT NULL AND status NOT IN ('Completed','Partial','Canceled','Failed')
      AND checked_at < ? ORDER BY id DESC LIMIT 100`).all(userId, Date.now() - 30000);
    if (!rows.length) return;
    let st;
    try { st = await provider({ action: 'status', orders: rows.map(r => r.provider_order).join(',') }); } catch (e) { console.error('status', e.message); return; }
    for (const o of rows) {
      const s = st && st[o.provider_order];
      db.prepare('UPDATE orders SET checked_at = ? WHERE id = ?').run(Date.now(), o.id);
      if (!s || s.error) continue;
      const status = String(s.status || o.status);
      const remains = s.remains != null ? parseInt(s.remains, 10) : null;
      db.transaction(() => {
        db.prepare('UPDATE orders SET status = ?, remains = ?, start_count = ? WHERE id = ?')
          .run(status, Number.isFinite(remains) ? remains : null, s.start_count != null ? parseInt(s.start_count, 10) || null : null, o.id);
        if (!o.refunded) {
          let refund = 0;
          if (status === 'Canceled') refund = o.charge;
          else if (status === 'Partial' && Number.isFinite(remains)) refund = r2(o.charge * Math.min(remains, o.quantity) / o.quantity);
          if (refund > 0) {
            db.prepare('UPDATE orders SET refunded = 1 WHERE id = ?').run(o.id);
            db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(refund, o.userId || o.user_id);
          }
        }
      })();
    }
  }

  app.get('/api/orders', async (req, res) => {
    const u = needUser(req, res); if (!u) return;
    try { await refresh(u.id); } catch (e) { console.error(e.message); }
    const rows = db.prepare('SELECT id, service_name, link, quantity, charge, status, remains, start_count, refunded, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id);
    sendJson(res, 200, rows);
  });

  // ---- admin ----
  app.get('/api/admin/summary', async (req, res) => {
    if (!needAdmin(req, res)) return;
    let providerBalance = null;
    try { const b = await provider({ action: 'balance' }); providerBalance = `${b.balance} ${b.currency || ''}`.trim(); } catch (e) { providerBalance = 'Error: ' + e.message; }
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const recent = db.prepare('SELECT c.amount, c.by_admin, c.created_at, u.username FROM credits c JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 20').all();
    sendJson(res, 200, { providerBalance, users, markup: MARKUP, recent });
  });

  app.post('/api/admin/credit', (req, res) => {
    const a = needAdmin(req, res); if (!a) return;
    const username = String((req.body || {}).username || '').trim();
    const amount = r2(Number((req.body || {}).amount));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) return sendJson(res, 400, { error: 'Amount sahi daalo (0 nahi, max 1,00,000).' });
    const user = db.prepare('SELECT id, username, balance FROM users WHERE username = ?').get(username);
    if (!user) return sendJson(res, 404, { error: 'Ye username nahi mila.' });
    if (amount < 0 && user.balance + amount < 0) return sendJson(res, 400, { error: 'Itna balance user ke paas nahi hai.' });
    const out = db.transaction(() => {
      db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(amount, user.id);
      db.prepare('INSERT INTO credits (user_id, amount, by_admin) VALUES (?,?,?)').run(user.id, amount, a.username);
      return db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance;
    })();
    sendJson(res, 200, { ok: true, username: user.username, balance: out });
  });
};
module.exports.MARKUP = MARKUP;
