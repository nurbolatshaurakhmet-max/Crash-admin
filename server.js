// Neon Crash backend. Node 22.13+ (built-in node:sqlite), zero npm dependencies.
// Run: BOT_TOKEN=123:abc SEED_KEY=$(openssl rand -hex 32) node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const { BOT_TOKEN, SEED_KEY, PORT = 3000, DB_PATH = './data/game.db' } = process.env;
if (!BOT_TOKEN || !/^[0-9a-f]{64}$/i.test(SEED_KEY || '')) {
  console.error('Set BOT_TOKEN and SEED_KEY (64 hex chars: openssl rand -hex 32)');
  process.exit(1);
}
const KEY = Buffer.from(SEED_KEY, 'hex');
const G = 0.12, START = 1000, MIN_BET = 1, MAX_BET = 100000, MAX_MULT = 10000, INIT_TTL = 86400;
const INDEX = [path.join(import.meta.dirname, 'index.html'), path.join(import.meta.dirname, 'public', 'index.html')].find((f) => fs.existsSync(f));

/* ---------- database ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch {}
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(
  tg_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
  balance INTEGER NOT NULL CHECK(balance>=0),
  seed_enc TEXT NOT NULL, seed_hash TEXT NOT NULL, client_seed TEXT NOT NULL,
  nonce INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  amount INTEGER NOT NULL, auto REAL, crash REAL NOT NULL, nonce INTEGER NOT NULL,
  t0 INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'flying', mult REAL, payout INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_active ON rounds(tg_id) WHERE status='flying';
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, delta INTEGER NOT NULL,
  reason TEXT NOT NULL, round_id INTEGER, ts INTEGER NOT NULL);`);

db.exec(`CREATE TABLE IF NOT EXISTS mines(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  amount INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL, board TEXT NOT NULL,
  opened TEXT NOT NULL DEFAULT '[]', nonce INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', mult REAL, payout INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_mines ON mines(tg_id) WHERE status='active';`);
db.exec(`CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
const SIZES = [3, 5, 7, 10], MINES = [3, 4, 5, 8], EDGE = 0.97, MIN_WD = 100;
// ADMIN_ID: your Telegram ID (several: comma separated). Admin = Telegram-signed identity + ID whitelist + fresh session.
const ADMIN_IDS = new Set((process.env.ADMIN_ID || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0));
const TZ = process.env.TIMEZONE || 'Etc/GMT-5';

db.exec(`CREATE TABLE IF NOT EXISTS inventory(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id), gift TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inv_user ON inventory(tg_id);
CREATE TABLE IF NOT EXISTS upgrades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, from_gift TEXT NOT NULL, to_gift TEXT NOT NULL,
  chance REAL NOT NULL, roll REAL NOT NULL, win INTEGER NOT NULL, nonce INTEGER NOT NULL, ts INTEGER NOT NULL);`);
// Virtual gift catalog (coins). Telegram-style gifts, NOT real Telegram gifts.
const GIFTS = [
  { id: 'heart', e: '💝', n: 'Сердце', p: 100 }, { id: 'bear', e: '🧸', n: 'Мишка', p: 100 },
  { id: 'rose', e: '🌹', n: 'Роза', p: 170 }, { id: 'cake', e: '🎂', n: 'Торт', p: 340 },
  { id: 'bouquet', e: '💐', n: 'Букет', p: 340 }, { id: 'rocket', e: '🚀', n: 'Ракета', p: 340 },
  { id: 'champ', e: '🍾', n: 'Шампанское', p: 340 }, { id: 'trophy', e: '🏆', n: 'Кубок', p: 700 },
  { id: 'ring', e: '💍', n: 'Кольцо', p: 700 }, { id: 'diamond', e: '💎', n: 'Алмаз', p: 700 },
  { id: 'crown', e: '👑', n: 'Корона', p: 2500 }, { id: 'yacht', e: '🛥️', n: 'Яхта', p: 5000 },
];
const GIFT = Object.fromEntries(GIFTS.map((g) => [g.id, g]));
const UP_EDGE = 0.95, SELL_RATE = 0.9, MAX_INV = 100;

db.exec(`CREATE TABLE IF NOT EXISTS admin_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target INTEGER, detail TEXT, ts INTEGER NOT NULL);`);

const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};
const getUser = (id) => db.prepare('SELECT * FROM users WHERE tg_id=?').get(id);
const flying = (id) => db.prepare(`SELECT * FROM rounds WHERE tg_id=? AND status='flying'`).get(id);
const led = (id, d, why, rid) => db.prepare('INSERT INTO ledger(tg_id,delta,reason,round_id,ts) VALUES(?,?,?,?,?)').run(id, d, why, rid, Date.now());

/* ---------- crypto ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => { // AES-256-GCM: server seeds are never stored in plaintext
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const b = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64');
};
const dec = (s) => {
  const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
const newSeed = () => { const s = crypto.randomBytes(32).toString('hex'); return { enc: enc(s), hash: sha(s) }; };

// Aviator/Bustabit-style provably fair crash point: RTP 97%, ~3% instant 1.00x.
function crashPoint(serverSeed, clientSeed, nonce) {
  const hex = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  const h = parseInt(hex.slice(0, 13), 16), e = 2 ** 52; // first 52 bits
  if (h % 33 === 0) return 1;
  return Math.min(MAX_MULT, Math.floor((100 * e - h) / (e - h)) / 100);
}
const rollFloat = (ss, cs, nonce) => // provably fair upgrade roll in [0,1)
  parseInt(crypto.createHmac('sha256', ss).update(`${cs}:${nonce}:u`).digest('hex').slice(0, 13), 16) / 2 ** 52;
const mAt = (ms) => Math.exp((G * ms) / 1000);

/* ---------- Telegram auth (HMAC check of initData) ---------- */
function verifyInit(raw) {
  if (!raw || raw.length > 4096) return null;
  const p = new URLSearchParams(raw), hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  p.delete('hash');
  const data = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(data).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calc)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > INIT_TTL) return null;
  try { const u = JSON.parse(p.get('user')); return Number.isSafeInteger(u.id) ? { ...u, auth_date: Number(p.get('auth_date')) } : null; } catch { return null; }
}
function ensureUser(u) {
  let row = getUser(u.id);
  if (!row) {
    const s = newSeed();
    tx(() => {
      db.prepare('INSERT INTO users(tg_id,username,first_name,balance,seed_enc,seed_hash,client_seed,nonce,created_at) VALUES(?,?,?,?,?,?,?,0,?)')
        .run(u.id, u.username ?? null, u.first_name ?? null, START, s.enc, s.hash, crypto.randomBytes(6).toString('hex'), Date.now());
      led(u.id, START, 'signup', null);
    });
    row = getUser(u.id);
  }
  return row;
}

/* ---------- game logic (server is the only source of truth) ---------- */
const broke = () => {}; // no free refills: closed economy, otherwise withdrawal requests could be farmed
// Mines: positions derived from HMAC(serverSeed, clientSeed:nonce) with a Fisher-Yates shuffle -> provably fair
function minePositions(ss, cs, nonce, N, k) {
  const a = [...Array(N).keys()]; let blk = 0, buf = Buffer.alloc(0), pos = 0;
  const rnd = () => {
    if (pos + 4 > buf.length) { buf = crypto.createHmac('sha256', ss).update(`${cs}:${nonce}:m${blk++}`).digest(); pos = 0; }
    const v = buf.readUInt32BE(pos); pos += 4; return v;
  };
  for (let i = N - 1; i > N - 1 - k; i--) { const j = rnd() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(N - k).sort((x, y) => x - y);
}
const minesMult = (n, k, i) => { const N = n * n; let m = EDGE; for (let j = 0; j < i; j++) m *= (N - j) / (N - k - j); return m; };
const activeMines = (id) => db.prepare(`SELECT * FROM mines WHERE tg_id=? AND status='active'`).get(id);
function endMines(g, res, mult) {
  const payout = res === 'win' ? Math.floor(g.amount * mult) : 0;
  return tx(() => {
    const d = db.prepare(`UPDATE mines SET status=?, mult=?, payout=? WHERE id=? AND status='active'`).run(res, mult, payout, g.id);
    if (d.changes === 1) {
      if (payout) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(payout, g.tg_id); led(g.tg_id, payout, 'mines_win', g.id); }
      broke(g.tg_id, g.id);
    }
    return { result: res, mult, payout, mines: JSON.parse(dec(g.board)), balance: getUser(g.tg_id).balance };
  });
}
function settle(r, res, mult) {
  const payout = res === 'win' ? Math.floor(r.amount * mult) : 0;
  return tx(() => {
    const done = db.prepare(`UPDATE rounds SET status=?, mult=?, payout=? WHERE id=? AND status='flying'`).run(res, mult, payout, r.id);
    if (done.changes === 1) {
      if (payout) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(payout, r.tg_id); led(r.tg_id, payout, 'win', r.id); }
      broke(r.tg_id, r.id);
    }
    return db.prepare('SELECT * FROM rounds WHERE id=?').get(r.id);
  });
}
function resolve(r, now) { // settled row, or null while the rocket is still flying
  const m = mAt(now - r.t0);
  if (r.auto && r.auto <= r.crash && m >= r.auto) return settle(r, 'win', r.auto);
  if (m >= r.crash) return settle(r, 'loss', r.crash);
  return null;
}
const view = (r) => ({ status: 'settled', result: r.status, mult: r.mult, payout: r.payout, crashAt: r.crash, balance: getUser(r.tg_id).balance });
const lastView = (id) => {
  const r = db.prepare('SELECT * FROM rounds WHERE tg_id=? ORDER BY id DESC LIMIT 1').get(id);
  return r ? view(r) : { status: 'idle' };
};
const fair = (u) => ({ hash: u.seed_hash, clientSeed: u.client_seed, nonce: u.nonce });

const routes = {
  '/api/auth': (u) => {
    const f = flying(u.tg_id); if (f) resolve(f, Date.now());
    const hist = db.prepare(`SELECT crash FROM rounds WHERE tg_id=? AND status!='flying' ORDER BY id DESC LIMIT 12`).all(u.tg_id).map((x) => x.crash);
    const n = getUser(u.tg_id);
    const mg = activeMines(u.tg_id), op = mg ? JSON.parse(mg.opened) : [];
    return {
      balance: n.balance, history: hist, fair: fair(n),
      mines: mg ? { n: mg.n, k: mg.k, amount: mg.amount, opened: op, mult: minesMult(mg.n, mg.k, op.length) } : null,
    };
  },
  '/api/bet': (u, b) => {
    const amount = b.amount;
    const auto = b.auto == null ? null : Math.floor(Number(b.auto) * 100) / 100;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_BET) throw new Error('bad_amount'); // 0 = watch-only flight
    if (auto !== null && !(auto >= 1.01 && auto <= MAX_MULT)) throw new Error('bad_auto');
    const f = flying(u.tg_id); if (f && !resolve(f, Date.now())) throw new Error('round_active');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < amount) throw new Error('no_balance');
      const crash = crashPoint(dec(x.seed_enc), x.client_seed, x.nonce);
      db.prepare('UPDATE users SET balance=balance-?, nonce=nonce+1 WHERE tg_id=?').run(amount, x.tg_id);
      const id = db.prepare('INSERT INTO rounds(tg_id,amount,auto,crash,nonce,t0) VALUES(?,?,?,?,?,?)').run(x.tg_id, amount, auto, crash, x.nonce, Date.now()).lastInsertRowid;
      if (amount) led(x.tg_id, -amount, 'bet', id);
      const n = getUser(x.tg_id);
      return { balance: n.balance, fair: fair(n) };
    });
  },
  '/api/status': (u) => {
    const f = flying(u.tg_id); if (!f) return lastView(u.tg_id);
    const now = Date.now(), r = resolve(f, now);
    return r ? view(r) : { status: 'flying' };
  },
  '/api/cashout': (u) => {
    const f = flying(u.tg_id); if (!f) return lastView(u.tg_id);
    const now = Date.now(), r = resolve(f, now);
    if (r) return view(r); // too late, or auto-cashout already fired
    return view(settle(f, 'win', Math.max(1, Math.floor(mAt(now - f.t0) * 100) / 100))); // multiplier from SERVER clock
  },
  '/api/mines/start': (u, b) => {
    const { amount, n, k } = b;
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new Error('bad_amount');
    if (!SIZES.includes(n) || !MINES.includes(k) || k >= n * n) throw new Error('bad_game');
    if (activeMines(u.tg_id)) throw new Error('round_active');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < amount) throw new Error('no_balance');
      const board = minePositions(dec(x.seed_enc), x.client_seed, x.nonce, n * n, k);
      db.prepare('UPDATE users SET balance=balance-?, nonce=nonce+1 WHERE tg_id=?').run(amount, x.tg_id);
      const id = db.prepare('INSERT INTO mines(tg_id,amount,n,k,board,nonce) VALUES(?,?,?,?,?,?)').run(x.tg_id, amount, n, k, enc(JSON.stringify(board)), x.nonce).lastInsertRowid;
      led(x.tg_id, -amount, 'mines_bet', id);
      const y = getUser(x.tg_id);
      return { balance: y.balance, fair: fair(y) };
    });
  },
  '/api/mines/open': (u, b) => {
    const g = activeMines(u.tg_id); if (!g) throw new Error('no_game');
    const N = g.n * g.n, i = b.i, opened = JSON.parse(g.opened);
    if (!Number.isInteger(i) || i < 0 || i >= N || opened.includes(i)) throw new Error('bad_cell');
    if (JSON.parse(dec(g.board)).includes(i)) return { ...endMines(g, 'loss', 0), hit: i };
    opened.push(i);
    db.prepare('UPDATE mines SET opened=? WHERE id=?').run(JSON.stringify(opened), g.id);
    const m = minesMult(g.n, g.k, opened.length);
    if (opened.length === N - g.k) return { ...endMines(g, 'win', m), auto: true };
    return { result: 'safe', mult: m, count: opened.length };
  },
  '/api/mines/cash': (u) => {
    const g = activeMines(u.tg_id); if (!g) throw new Error('no_game');
    const c = JSON.parse(g.opened).length; if (c < 1) throw new Error('bad_cell');
    return endMines(g, 'win', minesMult(g.n, g.k, c));
  },
  '/api/top': (u) => { // only first names are exposed, never usernames or IDs
    const top = db.prepare('SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 10').all()
      .map((r, i) => ({ rank: i + 1, name: (r.first_name || 'Игрок').slice(0, 16), balance: r.balance, me: r.tg_id === u.tg_id }));
    const rank = db.prepare('SELECT COUNT(*)+1 AS r FROM users WHERE balance>?').get(getUser(u.tg_id).balance).r;
    return { top, rank };
  },
  '/api/profile': (u) => {
    const x = getUser(u.tg_id);
    const c = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM rounds WHERE tg_id=? AND amount>0 AND status!='flying'`).get(u.tg_id);
    const m = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM mines WHERE tg_id=? AND status!='active'`).get(u.tg_id);
    const w = db.prepare('SELECT id, amount, status, created_at FROM withdrawals WHERE tg_id=? ORDER BY id DESC LIMIT 10').all(u.tg_id).map((r) => ({ ...r }));
    return { id: x.tg_id, name: x.first_name, username: x.username, since: x.created_at, balance: x.balance, crash: { ...c }, mines: { ...m }, withdrawals: w, admin: ADMIN_IDS.has(x.tg_id) };
  },
  '/api/withdraw': (u, b) => { // request only: funds are held until the request is reviewed
    const amount = b.amount;
    if (!Number.isSafeInteger(amount) || amount < MIN_WD) throw new Error('bad_amount');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < amount) throw new Error('no_balance');
      if (db.prepare(`SELECT 1 FROM withdrawals WHERE tg_id=? AND status='pending'`).get(x.tg_id)) throw new Error('wd_pending');
      db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(amount, x.tg_id);
      const id = db.prepare('INSERT INTO withdrawals(tg_id,amount,created_at,updated_at) VALUES(?,?,?,?)').run(x.tg_id, amount, Date.now(), Date.now()).lastInsertRowid;
      led(x.tg_id, -amount, 'withdraw_hold', id);
      try { notifyWithdraw(id, x, amount, x.balance); } catch (e) { console.error('notify:', e.message); } // a failed message must never block a withdrawal request
      return { balance: getUser(x.tg_id).balance, id };
    });
  },
  '/api/admin/list': (u, b, t) => {
    assertAdmin(u, t, 'list');
    return db.prepare(`SELECT w.id, w.amount, w.tg_id, x.first_name, x.username, x.balance FROM withdrawals w JOIN users x ON x.tg_id=w.tg_id WHERE w.status='pending' ORDER BY w.id LIMIT 50`)
      .all().map((r) => ({ ...r, ...stats(r.tg_id) }));
  },
  '/api/admin/set': (u, b, t) => {
    assertAdmin(u, t, 'set');
    if (!['paid', 'rejected'].includes(b.status) || !Number.isInteger(b.id)) throw new Error('bad_game');
    reviewWithdrawal(b.id, b.status, u.tg_id);
    return { ok: true };
  },
  '/api/admin/user': (u, b, t) => {
    assertAdmin(u, t, 'user');
    if (!Number.isSafeInteger(b.id)) throw new Error('bad_game');
    const x = getUser(b.id); if (!x) throw new Error('no_game');
    return { id: x.tg_id, name: x.first_name, username: x.username, balance: x.balance, ...stats(x.tg_id) };
  },
  '/api/admin/balance': (u, b, t) => { // change a player's balance (+ adds, - removes); every change is logged
    assertAdmin(u, t, 'balance');
    if (!Number.isSafeInteger(b.id) || !Number.isSafeInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 1e9) throw new Error('bad_amount');
    return tx(() => {
      const x = getUser(b.id); if (!x) throw new Error('no_game');
      if (x.balance + b.amount < 0) throw new Error('bad_amount');
      db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(b.amount, x.tg_id);
      led(x.tg_id, b.amount, 'admin_adjust', null);
      audit(u.tg_id, 'balance', x.tg_id, `${b.amount > 0 ? '+' : ''}${b.amount} (was ${x.balance})`);
      return { balance: getUser(x.tg_id).balance };
    });
  },
  '/api/gifts': (u) => ({
    catalog: GIFTS, balance: getUser(u.tg_id).balance,
    items: db.prepare('SELECT id, gift FROM inventory WHERE tg_id=? ORDER BY id').all(u.tg_id).map((r) => ({ ...r })),
  }),
  '/api/gifts/buy': (u, b) => {
    const g = GIFT[b.gift]; if (!g) throw new Error('bad_game');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < g.p) throw new Error('no_balance');
      if (db.prepare('SELECT COUNT(*) c FROM inventory WHERE tg_id=?').get(x.tg_id).c >= MAX_INV) throw new Error('inv_full');
      db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(g.p, x.tg_id);
      const id = db.prepare('INSERT INTO inventory(tg_id,gift,created_at) VALUES(?,?,?)').run(x.tg_id, g.id, Date.now()).lastInsertRowid;
      led(x.tg_id, -g.p, 'gift_buy', id);
      return { balance: getUser(x.tg_id).balance, id };
    });
  },
  '/api/gifts/sell': (u, b) => tx(() => {
    const it = Number.isInteger(b.item) ? db.prepare('SELECT * FROM inventory WHERE id=? AND tg_id=?').get(b.item, u.tg_id) : null;
    if (!it) throw new Error('no_game');
    const pay = Math.floor(GIFT[it.gift].p * SELL_RATE);
    db.prepare('DELETE FROM inventory WHERE id=?').run(it.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(pay, u.tg_id);
    led(u.tg_id, pay, 'gift_sell', it.id);
    return { balance: getUser(u.tg_id).balance, payout: pay };
  }),
  '/api/upgrade': (u, b) => { // chance = price(mine)/price(target) * 0.95; roll is provably fair
    const tg = GIFT[b.target];
    if (!tg || !Number.isInteger(b.item)) throw new Error('bad_game');
    return tx(() => {
      const it = db.prepare('SELECT * FROM inventory WHERE id=? AND tg_id=?').get(b.item, u.tg_id);
      if (!it) throw new Error('no_game');
      const from = GIFT[it.gift];
      if (tg.p <= from.p || tg.p > from.p * 50) throw new Error('bad_game');
      const x = getUser(u.tg_id);
      const chance = Math.round(Math.min(0.95, (from.p / tg.p) * UP_EDGE) * 10000) / 10000;
      const roll = rollFloat(dec(x.seed_enc), x.client_seed, x.nonce), win = roll < chance;
      db.prepare('UPDATE users SET nonce=nonce+1 WHERE tg_id=?').run(x.tg_id);
      db.prepare('DELETE FROM inventory WHERE id=?').run(it.id);
      const nid = win ? db.prepare('INSERT INTO inventory(tg_id,gift,created_at) VALUES(?,?,?)').run(x.tg_id, tg.id, Date.now()).lastInsertRowid : null;
      db.prepare('INSERT INTO upgrades(tg_id,from_gift,to_gift,chance,roll,win,nonce,ts) VALUES(?,?,?,?,?,?,?,?)').run(x.tg_id, from.id, tg.id, chance, roll, win ? 1 : 0, x.nonce, Date.now());
      return { win, roll, chance, item: nid ? { id: nid, gift: tg.id } : null, fair: fair(getUser(x.tg_id)) };
    });
  },
  '/api/seed': (u, b) => { // rotate seed and reveal the old one so past rounds can be verified
    if (flying(u.tg_id) || activeMines(u.tg_id)) throw new Error('round_active');
    const x = getUser(u.tg_id), s = newSeed();
    const cs = typeof b.clientSeed === 'string' && /^[\w-]{1,32}$/.test(b.clientSeed) ? b.clientSeed : x.client_seed;
    const old = { serverSeed: dec(x.seed_enc), clientSeed: x.client_seed, rounds: x.nonce };
    db.prepare('UPDATE users SET seed_enc=?, seed_hash=?, client_seed=?, nonce=0 WHERE tg_id=?').run(s.enc, s.hash, cs, x.tg_id);
    return { revealed: old, fair: fair(getUser(x.tg_id)) };
  },
};
const KNOWN = new Set(['bad_amount', 'bad_auto', 'bad_game', 'bad_cell', 'no_game', 'forbidden', 'wd_pending', 'inv_full', 'no_balance', 'round_active', 'bad_json', 'big']);

/* ---------- admin security + Telegram bot notifications ---------- */
const audit = (admin, action, target, detail = '') =>
  db.prepare('INSERT INTO admin_log(admin_id,action,target,detail,ts) VALUES(?,?,?,?,?)').run(admin, action, target ?? null, detail, Date.now());
const deniedAt = new Map();
function assertAdmin(u, t, what) { // whitelist + Telegram signature (checked earlier) + session younger than 1 hour
  if (ADMIN_IDS.has(u.tg_id) && Date.now() / 1000 - t.auth_date < 3600) return;
  if (Date.now() - (deniedAt.get(u.tg_id) ?? 0) > 60000) { deniedAt.set(u.tg_id, Date.now()); audit(u.tg_id, 'denied', null, what); }
  throw new Error('forbidden');
}
function stats(id) {
  const c = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet FROM rounds WHERE tg_id=? AND amount>0 AND status!='flying'`).get(id);
  const m = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet FROM mines WHERE tg_id=? AND status!='active'`).get(id);
  const g = db.prepare('SELECT COUNT(*) n FROM upgrades WHERE tg_id=?').get(id);
  return { games: c.n + m.n + g.n, wagered: c.bet + m.bet };
}
const num = (n) => Number(n).toLocaleString('ru-RU');
const fmtDate = (ms) => new Date(ms).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
async function tgCall(method, body, ms = 10000) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const sendSafe = (chat_id, text, extra = {}) => tgCall('sendMessage', { chat_id, text, ...extra }).catch((e) => console.error('tg send:', e.message));
function notifyWithdraw(wid, x, amount, before) { // the bot sends the admin the player's data
  const s = stats(x.tg_id);
  const text = `💸 Заявка на вывод #${wid}\n\n🆔 ${x.tg_id}${x.username ? ` (@${x.username})` : ''}${x.first_name ? ` · ${x.first_name}` : ''}\n`
    + `🎮 Сыграно игр: ${s.games} (ставок на ${num(s.wagered)} ◆)\n💵 Запросил: ${num(amount)} ◆\n`
    + `💼 Сумма на счету: ${num(before)} ◆ (останется ${num(before - amount)} ◆)\n🕒 ${fmtDate(Date.now())}\n\nВывод делается в течение 8 часов.`;
  const kb = { inline_keyboard: [[{ text: '✅ Выплачено', callback_data: `wd:paid:${wid}` }, { text: '❌ Отклонить', callback_data: `wd:rej:${wid}` }]] };
  for (const id of ADMIN_IDS) sendSafe(id, text, { reply_markup: kb });
  sendSafe(x.tg_id, `✅ Заявка #${wid} на ${num(amount)} ◆ принята.\nВывод делается в течение 8 часов.`);
}
function reviewWithdrawal(id, status, adminId) {
  const w = tx(() => {
    const r = db.prepare(`SELECT * FROM withdrawals WHERE id=? AND status='pending'`).get(id);
    if (!r) throw new Error('no_game');
    db.prepare('UPDATE withdrawals SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), r.id);
    if (status === 'rejected') { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(r.amount, r.tg_id); led(r.tg_id, r.amount, 'withdraw_refund', r.id); }
    audit(adminId, `withdraw_${status}`, r.tg_id, `#${r.id} ${r.amount}`);
    return r;
  });
  sendSafe(w.tg_id, status === 'paid' ? `💸 Заявка #${w.id} на ${num(w.amount)} ◆ выплачена.` : `❌ Заявка #${w.id} отклонена, ${num(w.amount)} ◆ возвращены на счёт.`);
}
async function handleUpdate(up) { // buttons under the admin's message
  const cb = up.callback_query; if (!cb) return;
  const m = /^wd:(paid|rej):(\d+)$/.exec(cb.data || ''); if (!m) return;
  const answer = (text) => tgCall('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: true }).catch(() => {});
  if (!ADMIN_IDS.has(cb.from.id)) { audit(cb.from.id, 'denied', null, 'bot button'); return answer('Нет доступа'); }
  const status = m[1] === 'paid' ? 'paid' : 'rejected';
  try { reviewWithdrawal(Number(m[2]), status, cb.from.id); } catch { return answer('Заявка уже обработана'); }
  await answer(status === 'paid' ? 'Отмечено: выплачено' : 'Отклонено, деньги возвращены игроку');
  if (cb.message) await tgCall('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `${cb.message.text}\n\n${status === 'paid' ? '✅ ВЫПЛАЧЕНО' : '❌ ОТКЛОНЕНО'} · ${fmtDate(Date.now())}` }).catch(() => {});
}
async function pollBot() {
  await tgCall('deleteWebhook', {}).catch(() => {});
  let offset = 0;
  for (;;) {
    try {
      const ups = await tgCall('getUpdates', { offset, timeout: 25, allowed_updates: ['callback_query'] }, 35000);
      for (const up of ups) { offset = up.update_id + 1; await handleUpdate(up).catch((e) => console.error('update:', e.message)); }
    } catch (e) { console.error('poll:', e.message); await new Promise((r) => setTimeout(r, 4000)); }
  }
}

/* ---------- http ---------- */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org";
const HDR = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' };
const send = (res, code, obj) => { res.writeHead(code, { ...HDR, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 2048) { no(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('bad_json')); } });
});
const buckets = new Map();
const limited = (id) => { // 20 requests / second / user
  const now = Date.now(), b = buckets.get(id) ?? { t: now, n: 0 };
  if (now - b.t > 1000) { b.t = now; b.n = 0; }
  b.n++; buckets.set(id, b); return b.n > 20;
};
setInterval(() => buckets.clear(), 600000).unref();

const srv = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { ...HDR, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }
    const fn = req.method === 'POST' ? routes[req.url] : null;
    if (!fn) { res.writeHead(404, HDR); return res.end(); }
    const tgUser = verifyInit(req.headers['x-tg-init']);
    if (!tgUser) return send(res, 401, { error: 'unauthorized' });
    if (limited(tgUser.id)) return send(res, 429, { error: 'slow_down' });
    const body = await readBody(req);
    send(res, 200, fn(ensureUser(tgUser), body, tgUser));
  } catch (e) {
    if (!KNOWN.has(e.message)) console.error(e);
    send(res, 400, { error: KNOWN.has(e.message) ? e.message : 'error' });
  }
}).listen(PORT, () => console.log(`Neon Crash on :${PORT}`));
// Keep-alive longer than the hosting proxy's, otherwise POST requests sporadically fail with "error handling handler error".
srv.keepAliveTimeout = 65000;
srv.headersTimeout = 66000;
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message ?? e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message ?? e));
if (ADMIN_IDS.size) pollBot();
