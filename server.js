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
const G = 0.12, START = Math.max(0, Math.floor(Number(process.env.START_BALANCE) || 0)), // no free starting balance unless START_BALANCE is set
   MIN_BET = 1, MAX_BET = 100000, MAX_MULT = 10000, INIT_TTL = 86400;
const INDEX = [path.join(import.meta.dirname, 'index.html'), path.join(import.meta.dirname, 'public', 'index.html')].find((f) => fs.existsSync(f));

/* ---------- database ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
try { db.chmodSync(DB_PATH, 0o600); } catch {}
// Separate durable accounting database. The game database remains the source of player balances;
// every ledger movement is mirrored here for independent financial reporting/audit.
const BANK_DB_PATH = process.env.BANK_DB_PATH || path.join(path.dirname(DB_PATH), 'bank.db');
fs.mkdirSync(path.dirname(BANK_DB_PATH), { recursive: true });
const bankDb = new DatabaseSync(BANK_DB_PATH);
try { fs.chmodSync(BANK_DB_PATH, 0o600); } catch {}
bankDb.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS bank_ledger(
 id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER UNIQUE, tg_id INTEGER NOT NULL,
 delta INTEGER NOT NULL, reason TEXT NOT NULL, ref_id INTEGER, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bank_ledger_ts ON bank_ledger(ts);
CREATE TABLE IF NOT EXISTS bank_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
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
const SIZES = [3, 5, 7, 10], MINES = [3, 4, 5, 8], EDGE = 0.97, MIN_WD = 50;
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
const giftName = (id) => (id && GIFT[id] ? `${GIFT[id].e} ${GIFT[id].n}` : null);

db.exec(`CREATE TABLE IF NOT EXISTS admin_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target INTEGER, detail TEXT, ts INTEGER NOT NULL);`);

try { db.exec('ALTER TABLE withdrawals ADD COLUMN gift TEXT'); } catch {} // gift withdrawals reuse the withdrawals table

db.exec(`CREATE TABLE IF NOT EXISTS crash_rounds(
  id INTEGER PRIMARY KEY, seed_enc TEXT NOT NULL, seed_hash TEXT NOT NULL, crash REAL NOT NULL,
  t_bet0 INTEGER NOT NULL, t_fly0 INTEGER NOT NULL, t_end INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS crash_bets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  amount INTEGER NOT NULL, auto REAL, status TEXT NOT NULL DEFAULT 'open', mult REAL, payout INTEGER, UNIQUE(round_id, tg_id));
CREATE TABLE IF NOT EXISTS chicken(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id), amount INTEGER NOT NULL,
  level TEXT NOT NULL, burn TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, nonce INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', mult REAL, payout INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_chicken ON chicken(tg_id) WHERE status='active';`);
db.exec(`CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id), provider_id INTEGER UNIQUE,
  usdt REAL NOT NULL, coins INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', url TEXT, created_at INTEGER NOT NULL, paid_at INTEGER);`);
// Automatic top-up through Crypto Pay (@CryptoBot). Testnet: CRYPTO_PAY_API=https://testnet-pay.crypt.bot/api
const PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN || '';
const PAY_API = (process.env.CRYPTO_PAY_API || 'https://pay.crypt.bot/api').replace(/\/$/, '');
const COINS_PER_USDT = Math.max(1, Math.floor(Number(process.env.COINS_PER_USDT)) || 100);
const MIN_USDT = Math.max(0.1, Number(process.env.MIN_USDT) || 1), MAX_USDT = 5000;
const CRYPTO_PAYOUTS_ENABLED = process.env.CRYPTO_PAY_TRANSFERS_ENABLED === 'true';
// A process crash during a provider call is ambiguous; keep funds held for manual reconciliation.

const MIN_WD_USDT = Math.max(1, Number(process.env.MIN_WD_USDT) || 1);
try { db.exec('ALTER TABLE withdrawals ADD COLUMN recipient_tg INTEGER'); } catch {}
try { db.exec('ALTER TABLE withdrawals ADD COLUMN usdt REAL'); } catch {}
try { db.exec('ALTER TABLE withdrawals ADD COLUMN transfer_id INTEGER'); } catch {}
db.prepare(`UPDATE withdrawals SET status='payout_review',updated_at=? WHERE status='processing' AND gift IS NULL`).run(Date.now());
db.exec(`CREATE TABLE IF NOT EXISTS terms(tg_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, ts INTEGER NOT NULL);`);
const TERMS_VERSION = 3; // bump it to make everybody accept new rules again
const WEBAPP_URL = process.env.WEBAPP_URL || ''; // public URL of the game, used for the "Играть" button in the bot
const TERMS_TEXT = `ПОЛЬЗОВАТЕЛЬСКОЕ СОГЛАШЕНИЕ И ПРАВИЛА · Neon Arcade

1. Общие положения
Neon Arcade — игровое приложение в Telegram (Crash, Mines, Chicken Run, Апгрейд подарков). Пользоваться им могут только совершеннолетние (18+). Используя приложение, вы принимаете это соглашение.

2. Аккаунт
Один человек — один аккаунт Telegram. Мультиаккаунты, боты, скрипты, передача аккаунта и использование ошибок (багов) запрещены.

3. Игры и риск
Результат каждой игры определяется сервером случайно и не зависит от вашего устройства. Честность можно проверить: перед игрой публикуется хеш секретного ключа, а после игры сам ключ. Ставки окончательны. Максимальная ставка и максимальная выплата за один раунд ограничены, актуальные лимиты показаны в приложении. Любая игра связана с риском потерять ставку. Играйте только теми средствами, которые готовы потерять, и не пытайтесь отыграться любой ценой.

4. Баланс, пополнение и вывод
Пополнение возможно автоматически (криптовалюта USDT через CryptoBot, курс 1 USDT = ${COINS_PER_USDT} ◆) или по заявке через администратора; платёж в блокчейне необратим, проверяйте сумму перед оплатой. Выводы выполняет вручную администратор, заявки на вывод рассматриваются в течение 8 часов. Минимальная сумма вывода — ${MIN_WD} ◆. Администратор вправе запросить подтверждение данных и отклонить заявку при признаках нарушения правил.

5. Запрещено
Обман, использование уязвимостей, несколько аккаунтов, отмывание средств, оскорбления и попытки взлома. За нарушения аккаунт блокируется, а выигрыши, полученные нечестным путём, аннулируются.

6. Данные
Мы храним ваш Telegram ID, имя, username, баланс и историю операций, чтобы игра работала и заявки обрабатывались. Данные не передаются третьим лицам, кроме технических сервисов хостинга и случаев, предусмотренных законом.

7. Ответственность
Сервис предоставляется «как есть»: возможны сбои и технические работы. Администрация может изменять правила; при существенных изменениях потребуется принять их заново.

8. Согласие
Нажимая «Согласен», вы подтверждаете, что вам исполнилось 18 лет, вы действуете от своего имени и принимаете это соглашение.`;
const hasAgreed = (id) => !!db.prepare('SELECT 1 FROM terms WHERE tg_id=? AND version>=?').get(id, TERMS_VERSION);
const saveAgreement = (id) => db.prepare('INSERT INTO terms(tg_id,version,ts) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET version=excluded.version, ts=excluded.ts').run(id, TERMS_VERSION, Date.now());
db.exec(`CREATE TABLE IF NOT EXISTS deposits(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL REFERENCES users(tg_id), amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', credited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
const MIN_DEP = Math.max(1, Math.floor(Number(process.env.MIN_DEPOSIT)) || 50);
const CONTACT = /^@?[A-Za-z0-9_]{5,32}$/.test(process.env.ADMIN_CONTACT || '') ? process.env.ADMIN_CONTACT.replace(/^@/, '') : ''; // admin's @username shown to players
db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals(referred INTEGER PRIMARY KEY, referrer INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ref_by ON referrals(referrer);`);
const LIM = { maxBet: Number(process.env.MAX_BET) || 10000, maxPayout: Number(process.env.MAX_PAYOUT) || 100000 }; // changeable by the admin in the app
for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in LIM) LIM[r.key] = Number(r.value);
const capPay = (v) => Math.min(Math.floor(v), LIM.maxPayout); // max payout per round
const REF_PERCENT = Math.min(50, Math.max(0, Number(process.env.REF_PERCENT ?? 5))); // % of a friend's deposits that the inviter receives
const APP_NAME = process.env.APP_NAME || 'arcade'; // short name of the mini app in BotFather
let BOT_USERNAME = '';
const BET_MS = 5000, END_MS = 3000; // betting window (5 s) and pause after the crash
const CH_LEVELS = { easy: 0.92, mid: 0.85, hard: 0.75 }, CH_STEPS = 20; // chance to survive one step

const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};
const getUser = (id) => db.prepare('SELECT * FROM users WHERE tg_id=?').get(id);
const flying = (id) => db.prepare(`SELECT * FROM rounds WHERE tg_id=? AND status='flying'`).get(id);
const led = (id, d, why, rid) => {
  const ts = Date.now();
  const r = db.prepare('INSERT INTO ledger(tg_id,delta,reason,round_id,ts) VALUES(?,?,?,?,?)').run(id, d, why, rid, ts);
  bankDb.prepare('INSERT OR IGNORE INTO bank_ledger(source_id,tg_id,delta,reason,ref_id,ts) VALUES(?,?,?,?,?,?)').run(Number(r.lastInsertRowid), id, d, why, rid ?? null, ts);
  return r;
};
// Backfill ledger entries created before the separate bank database was introduced.
for (const row of db.prepare('SELECT id,tg_id,delta,reason,round_id,ts FROM ledger').all()) bankDb.prepare('INSERT OR IGNORE INTO bank_ledger(source_id,tg_id,delta,reason,ref_id,ts) VALUES(?,?,?,?,?,?)').run(row.id,row.tg_id,row.delta,row.reason,row.round_id,row.ts);

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
  try { const u = JSON.parse(p.get('user')); return Number.isSafeInteger(u.id) ? { ...u, auth_date: Number(p.get('auth_date')), start_param: p.get('start_param') || '' } : null; } catch { return null; }
}
function ensureUser(u) {
  let row = getUser(u.id);
  if (!row) {
    const s = newSeed();
    tx(() => {
      db.prepare('INSERT INTO users(tg_id,username,first_name,balance,seed_enc,seed_hash,client_seed,nonce,created_at) VALUES(?,?,?,?,?,?,?,0,?)')
        .run(u.id, u.username ?? null, u.first_name ?? null, START, s.enc, s.hash, crypto.randomBytes(6).toString('hex'), Date.now());
      if (START) led(u.id, START, 'signup', null);
    });
    row = getUser(u.id);
    const m = /^ref_(\d{1,15})$/.exec(u.start_param || ''); // invited through a friend's link
    if (m && Number(m[1]) !== u.id && getUser(Number(m[1]))) db.prepare('INSERT OR IGNORE INTO referrals(referred,referrer,created_at) VALUES(?,?,?)').run(u.id, Number(m[1]), Date.now());
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
  const payout = res === 'win' ? capPay(g.amount * mult) : 0;
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

/* ---------- Crash: ONE shared round for all players (commit-reveal: hash is public before, seed after) ---------- */
const crashMs = (c) => Math.ceil((Math.log(c) / G) * 1000);
const phaseOf = (r, now) => (now < r.t_fly0 ? 'bet' : now < r.t_end ? 'fly' : 'end');
function newRound(t0) {
  const seed = crypto.randomBytes(32).toString('hex');
  const id = (db.prepare('SELECT MAX(id) m FROM crash_rounds').get().m ?? 0) + 1;
  const crash = crashPoint(seed, 'round', id), tf = t0 + BET_MS;
  db.prepare('INSERT INTO crash_rounds(id,seed_enc,seed_hash,crash,t_bet0,t_fly0,t_end) VALUES(?,?,?,?,?,?,?)').run(id, enc(seed), sha(seed), crash, t0, tf, tf + crashMs(crash));
  return id;
}
function winBet(b, mult) {
  const payout = capPay(b.amount * mult);
  tx(() => {
    const d = db.prepare(`UPDATE crash_bets SET status='win', mult=?, payout=? WHERE id=? AND status='open'`).run(mult, payout, b.id);
    if (d.changes === 1) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(payout, b.tg_id); led(b.tg_id, payout, 'crash_win', b.round_id); }
  });
}
function settleRound(r) { // everyone who did not cash out: auto-cashout wins, the rest lose
  tx(() => {
    for (const b of db.prepare(`SELECT * FROM crash_bets WHERE round_id=? AND status='open'`).all(r.id)) {
      if (b.auto && b.auto <= r.crash) {
        const p = capPay(b.amount * b.auto);
        db.prepare(`UPDATE crash_bets SET status='win', mult=?, payout=? WHERE id=?`).run(b.auto, p, b.id);
        db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(p, b.tg_id); led(b.tg_id, p, 'crash_win', r.id);
      } else db.prepare(`UPDATE crash_bets SET status='loss', mult=0, payout=0 WHERE id=?`).run(b.id);
    }
    db.prepare(`UPDATE crash_rounds SET status='done' WHERE id=?`).run(r.id);
  });
}
function currentRound(now) { // rounds advance lazily: whoever asks first moves the clock forward
  let r = db.prepare('SELECT * FROM crash_rounds ORDER BY id DESC LIMIT 1').get();
  if (r && r.status === 'open' && now >= r.t_end) { settleRound(r); r = { ...r, status: 'done' }; }
  if (!r || now >= r.t_end + END_MS) r = db.prepare('SELECT * FROM crash_rounds WHERE id=?').get(newRound(now));
  return r;
}
const myBet = (rid, uid) => db.prepare('SELECT * FROM crash_bets WHERE round_id=? AND tg_id=?').get(rid, uid);
const crashAgg = (id) => {
  const a = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM rounds WHERE tg_id=? AND amount>0 AND status!='flying'`).get(id);
  const b = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM crash_bets WHERE tg_id=? AND status IN ('win','loss')`).get(id);
  return { n: a.n + b.n, bet: a.bet + b.bet, won: a.won + b.won, best: Math.max(a.best, b.best) };
};

/* ---------- Chicken Run: every step may burn; the burn step is fixed (HMAC of the seeds) when the game starts ---------- */
const chMult = (level, step) => EDGE / CH_LEVELS[level] ** step;
function burnStep(ss, cs, nonce, p) { // first step whose roll >= p burns the chicken (0 = survives all steps)
  for (let i = 1; i <= CH_STEPS; i++) {
    const roll = parseInt(crypto.createHmac('sha256', ss).update(`${cs}:${nonce}:c${i}`).digest('hex').slice(0, 13), 16) / 2 ** 52;
    if (roll >= p) return i;
  }
  return 0;
}
const activeChicken = (id) => db.prepare(`SELECT * FROM chicken WHERE tg_id=? AND status='active'`).get(id);
function endChicken(g, res, mult) {
  const payout = res === 'win' ? capPay(g.amount * mult) : 0;
  return tx(() => {
    const d = db.prepare(`UPDATE chicken SET status=?, mult=?, payout=? WHERE id=? AND status='active'`).run(res, mult, payout, g.id);
    if (d.changes === 1 && payout) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(payout, g.tg_id); led(g.tg_id, payout, 'chicken_win', g.id); }
    return { mult, payout, balance: getUser(g.tg_id).balance };
  });
}

const refInfo = (id) => ({
  link: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}/${APP_NAME}?startapp=ref_${id}` : '', percent: REF_PERCENT,
  count: db.prepare('SELECT COUNT(*) n FROM referrals WHERE referrer=?').get(id).n,
  earned: db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE tg_id=? AND reason='referral'`).get(id).s,
});
function startOfDay(now = Date.now()) { // local midnight in the TIMEZONE
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t) => Number(f.find((x) => x.type === t).value);
  return now - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000 - (now % 1000);
}

const routes = {
  '/api/auth': (u) => {
    const hist = db.prepare(`SELECT crash FROM crash_rounds WHERE status='done' ORDER BY id DESC LIMIT 12`).all().map((x) => x.crash);
    const cg = activeChicken(u.tg_id);
    const n = getUser(u.tg_id);
    const mg = activeMines(u.tg_id), op = mg ? JSON.parse(mg.opened) : [];
    return {
      balance: n.balance, history: hist, fair: fair(n), limits: { maxBet: LIM.maxBet, maxPayout: LIM.maxPayout },
      mines: mg ? { n: mg.n, k: mg.k, amount: mg.amount, opened: op, mult: minesMult(mg.n, mg.k, op.length) } : null,
      chicken: cg ? { level: cg.level, amount: cg.amount, step: cg.step, mult: cg.step ? chMult(cg.level, cg.step) : 1 } : null,
    };
  },
  '/api/crash/state': (u) => {
    const now = Date.now(), r = currentRound(now), ph = phaseOf(r, now);
    let b = myBet(r.id, u.tg_id);
    if (b && b.status === 'open' && ph === 'fly' && b.auto && b.auto <= r.crash && mAt(now - r.t_fly0) >= b.auto) { winBet(b, b.auto); b = myBet(r.id, u.tg_id); }
    const hist = db.prepare(`SELECT id, crash, seed_enc FROM crash_rounds WHERE status='done' ORDER BY id DESC LIMIT 12`).all();
    return {
      now, id: r.id, phase: ph, hash: r.seed_hash, t_fly0: r.t_fly0, crash: ph === 'end' ? r.crash : undefined, // the crash point is NEVER sent before the round ends
      players: db.prepare('SELECT COUNT(*) n FROM crash_bets WHERE round_id=?').get(r.id).n,
      bet: b ? { amount: b.amount, auto: b.auto, status: b.status, mult: b.mult, payout: b.payout } : null,
      balance: getUser(u.tg_id).balance,
      history: hist.map((x) => x.crash),
      recent: hist.slice(0, 3).map((x) => ({ id: x.id, crash: x.crash, seed: dec(x.seed_enc) })), // seeds are revealed AFTER the round: sha256(seed) must equal the published hash
    };
  },
  '/api/crash/bet': (u, b) => {
    const amount = b.amount, auto = b.auto == null ? null : Math.floor(Number(b.auto) * 100) / 100;
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > LIM.maxBet) throw new Error('bad_amount');
    if (auto !== null && !(auto >= 1.01 && auto <= MAX_MULT)) throw new Error('bad_auto');
    const now = Date.now(), r = currentRound(now);
    if (phaseOf(r, now) !== 'bet') throw new Error('late');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < amount) throw new Error('no_balance');
      if (myBet(r.id, x.tg_id)) throw new Error('round_active');
      db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(amount, x.tg_id);
      const id = db.prepare('INSERT INTO crash_bets(round_id,tg_id,amount,auto) VALUES(?,?,?,?)').run(r.id, x.tg_id, amount, auto).lastInsertRowid;
      led(x.tg_id, -amount, 'crash_bet', id);
      return { balance: getUser(x.tg_id).balance };
    });
  },
  '/api/crash/cancel': (u) => {
    const now = Date.now(), r = currentRound(now);
    if (phaseOf(r, now) !== 'bet') throw new Error('late');
    return tx(() => {
      const b = myBet(r.id, u.tg_id);
      if (!b || b.status !== 'open') throw new Error('no_game');
      db.prepare('DELETE FROM crash_bets WHERE id=?').run(b.id);
      db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(b.amount, b.tg_id);
      led(b.tg_id, b.amount, 'crash_cancel', b.id);
      return { balance: getUser(u.tg_id).balance };
    });
  },
  '/api/crash/cash': (u) => { // the multiplier is taken from the SERVER clock, never from the client
    const now = Date.now(), r = currentRound(now);
    if (phaseOf(r, now) !== 'fly') throw new Error('late');
    const b = myBet(r.id, u.tg_id);
    if (!b || b.status !== 'open') throw new Error('no_game');
    const m = mAt(now - r.t_fly0);
    if (m >= r.crash) throw new Error('late');
    winBet(b, b.auto && b.auto <= r.crash && m >= b.auto ? b.auto : Math.max(1, Math.floor(m * 100) / 100));
    const fin = myBet(r.id, u.tg_id);
    return { mult: fin.mult, payout: fin.payout, balance: getUser(u.tg_id).balance };
  },
  '/api/mines/start': (u, b) => {
    const { amount, n, k } = b;
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > LIM.maxBet) throw new Error('bad_amount');
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
  '/api/chicken/start': (u, b) => {
    const { amount, level } = b;
    if (!Number.isSafeInteger(amount) || amount < MIN_BET || amount > LIM.maxBet) throw new Error('bad_amount');
    if (!(level in CH_LEVELS)) throw new Error('bad_game');
    if (activeChicken(u.tg_id)) throw new Error('round_active');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (x.balance < amount) throw new Error('no_balance');
      const burn = burnStep(dec(x.seed_enc), x.client_seed, x.nonce, CH_LEVELS[level]);
      db.prepare('UPDATE users SET balance=balance-?, nonce=nonce+1 WHERE tg_id=?').run(amount, x.tg_id);
      const id = db.prepare('INSERT INTO chicken(tg_id,amount,level,burn,nonce) VALUES(?,?,?,?,?)').run(x.tg_id, amount, level, enc(String(burn)), x.nonce).lastInsertRowid;
      led(x.tg_id, -amount, 'chicken_bet', id);
      return { balance: getUser(x.tg_id).balance, fair: fair(getUser(x.tg_id)) };
    });
  },
  '/api/chicken/step': (u) => {
    const g = activeChicken(u.tg_id); if (!g) throw new Error('no_game');
    const step = g.step + 1, burn = Number(dec(g.burn));
    db.prepare('UPDATE chicken SET step=? WHERE id=?').run(step, g.id);
    if (burn === step) return { result: 'burn', step, ...endChicken(g, 'loss', 0) };
    const mult = chMult(g.level, step);
    if (step >= CH_STEPS) return { result: 'win', step, auto: true, ...endChicken(g, 'win', mult) };
    return { result: 'ok', step, mult, next: chMult(g.level, step + 1) };
  },
  '/api/chicken/cash': (u) => {
    const g = activeChicken(u.tg_id); if (!g) throw new Error('no_game');
    if (g.step < 1) throw new Error('bad_cell');
    return { result: 'win', step: g.step, ...endChicken(g, 'win', chMult(g.level, g.step)) };
  },
  '/api/pay/create': async (u, b) => { // creates a CryptoBot invoice; coins arrive automatically after the payment
    if (!PAY_TOKEN) throw new Error('bad_game');
    const usdt = Math.round(Number(b.usdt) * 100) / 100;
    if (!(usdt >= MIN_USDT && usdt <= MAX_USDT)) throw new Error('bad_amount');
    if (db.prepare(`SELECT COUNT(*) n FROM invoices WHERE tg_id=? AND status='pending' AND created_at>?`).get(u.tg_id, Date.now() - 3600e3).n >= 3) throw new Error('dep_pending');
    const coins = Math.floor(usdt * COINS_PER_USDT);
    const local = db.prepare('INSERT INTO invoices(tg_id,usdt,coins,created_at) VALUES(?,?,?,?)').run(u.tg_id, usdt, coins, Date.now()).lastInsertRowid;
    try {
      const inv = await cryptoApi('createInvoice', { asset: 'USDT', amount: String(usdt), description: `Neon Arcade: ${coins} ◆`, payload: `u${u.tg_id}:i${local}`, expires_in: 3600, allow_comments: false, allow_anonymous: false });
      const url = inv.bot_invoice_url || inv.pay_url;
      db.prepare('UPDATE invoices SET provider_id=?, url=? WHERE id=?').run(inv.invoice_id, url, local);
      return { id: local, url, usdt, coins };
    } catch (e) { db.prepare(`UPDATE invoices SET status='failed' WHERE id=?`).run(local); console.error('createInvoice:', e.message); throw new Error('pay_failed'); }
  },
  '/api/pay/check': async (u) => { await checkInvoices(u.tg_id); return { balance: getUser(u.tg_id).balance, invoices: myInvoices(u.tg_id) }; },
  '/api/deposit': (u, b) => { // a request only: the admin confirms and credits the coins by hand
    const amount = b.amount;
    if (!Number.isSafeInteger(amount) || amount < MIN_DEP || amount > 1e7) throw new Error('bad_amount');
    return tx(() => {
      const x = getUser(u.tg_id);
      if (db.prepare(`SELECT 1 FROM deposits WHERE tg_id=? AND status='pending'`).get(x.tg_id)) throw new Error('dep_pending');
      const id = db.prepare('INSERT INTO deposits(tg_id,amount,created_at,updated_at) VALUES(?,?,?,?)').run(x.tg_id, amount, Date.now(), Date.now()).lastInsertRowid;
      try { notifyDeposit(id, x, amount); } catch (e) { console.error('notify:', e.message); }
      return { id, contact: CONTACT };
    });
  },
  '/api/admin/deposits': (u, b, t) => {
    assertAdmin(u, t, 'deposits');
    return db.prepare(`SELECT d.id, d.amount, d.tg_id, x.first_name, x.username, x.balance FROM deposits d JOIN users x ON x.tg_id=d.tg_id WHERE d.status='pending' ORDER BY d.id LIMIT 50`)
      .all().map((r) => ({ ...r, ...stats(r.tg_id) }));
  },
  '/api/admin/deposit_set': (u, b, t) => { // amount (optional) = how much to credit, may differ from the request
    assertAdmin(u, t, 'deposit_set');
    if (!['paid', 'rejected'].includes(b.status) || !Number.isInteger(b.id)) throw new Error('bad_game');
    const r = reviewDeposit(b.id, b.status, u.tg_id, b.amount == null ? undefined : b.amount);
    return { ok: true, credited: r.credited, balance: r.balance };
  },
  '/api/terms/accept': (u, b) => { // the only route (besides auth) that works before the rules are accepted
    if (b.adult !== true) throw new Error('bad_game');
    saveAgreement(u.tg_id);
    return { ok: true };
  },
  '/api/top': (u) => { // only first names are exposed, never usernames or IDs
    const top = db.prepare('SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 10').all()
      .map((r, i) => ({ rank: i + 1, name: (r.first_name || 'Игрок').slice(0, 16), balance: r.balance, me: r.tg_id === u.tg_id }));
    const rank = db.prepare('SELECT COUNT(*)+1 AS r FROM users WHERE balance>?').get(getUser(u.tg_id).balance).r;
    return { top, rank };
  },
  '/api/profile': (u) => {
    const x = getUser(u.tg_id);
    const c = crashAgg(u.tg_id);
    const ch = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM chicken WHERE tg_id=? AND status!='active'`).get(u.tg_id);
    const m = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet, COALESCE(SUM(payout),0) won, COALESCE(MAX(CASE WHEN status='win' THEN mult END),0) best FROM mines WHERE tg_id=? AND status!='active'`).get(u.tg_id);
    const w = db.prepare('SELECT id, amount, status, created_at, gift FROM withdrawals WHERE tg_id=? ORDER BY id DESC LIMIT 10').all(u.tg_id).map((r) => ({ ...r, gift_name: giftName(r.gift) }));
    return { id: x.tg_id, name: x.first_name, username: x.username, since: x.created_at, balance: x.balance, crash: { ...c }, mines: { ...m }, chicken: { ...ch }, withdrawals: w, contact: CONTACT, min_dep: MIN_DEP, ref: refInfo(u.tg_id), pay: { enabled: !!PAY_TOKEN, min: MIN_USDT, rate: COINS_PER_USDT }, payout: { enabled: !!PAY_TOKEN && CRYPTO_PAYOUTS_ENABLED, minCoins: Math.max(MIN_WD, Math.ceil(MIN_WD_USDT * COINS_PER_USDT)), minUsdt: MIN_WD_USDT }, invoices: myInvoices(u.tg_id),
      deposits: db.prepare('SELECT id, amount, credited, status, created_at FROM deposits WHERE tg_id=? ORDER BY id DESC LIMIT 10').all(u.tg_id).map((r) => ({ ...r })), admin: ADMIN_IDS.has(x.tg_id) };
  },
  '/api/withdraw': async (u, b) => { // automatic Crypto Pay transfer to the user's Telegram ID
    if (!PAY_TOKEN || !CRYPTO_PAYOUTS_ENABLED) throw new Error('payout_disabled');
    const amount = b.amount, minCoins = Math.max(MIN_WD, Math.ceil(MIN_WD_USDT * COINS_PER_USDT));
    if (!Number.isSafeInteger(amount) || amount < minCoins) throw new Error('bad_amount');
    const usdt = Math.floor((amount / COINS_PER_USDT) * 100) / 100;
    if (usdt < MIN_WD_USDT || usdt > 25000) throw new Error('bad_amount');
    const x = getUser(u.tg_id);
    if (x.balance < amount) throw new Error('no_balance');
    const id = tx(() => {
      const fresh = getUser(u.tg_id);
      if (fresh.balance < amount) throw new Error('no_balance');
      if (db.prepare(`SELECT 1 FROM withdrawals WHERE tg_id=? AND status IN ('pending','processing','payout_review') AND gift IS NULL`).get(fresh.tg_id)) throw new Error('wd_pending');
      db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(amount, fresh.tg_id);
      const wid = db.prepare(`INSERT INTO withdrawals(tg_id,amount,status,created_at,updated_at,recipient_tg,usdt) VALUES(?,?,'processing',?,?,?,?)`).run(fresh.tg_id, amount, Date.now(), Date.now(), fresh.tg_id, usdt).lastInsertRowid;
      led(fresh.tg_id, -amount, 'withdraw_hold', wid);
      return wid;
    });
    try {
      // Crypto Pay transfers must be enabled under My Apps -> Security -> Transfers.
      const tr = await cryptoApi('transfer', { user_id: u.tg_id, asset: 'USDT', amount: usdt.toFixed(2), spend_id: `neon_wd_${id}`, comment: `Neon Arcade withdrawal #${id}` });
      tx(() => db.prepare(`UPDATE withdrawals SET status='paid',transfer_id=?,updated_at=? WHERE id=? AND status='processing'`).run(tr.transfer_id, Date.now(), id));
      sendSafe(u.tg_id, `💸 Вывод #${id} выполнен автоматически: ${usdt.toFixed(2)} USDT отправлены через Crypto Pay.
Списано: ${num(amount)} ◆`);
      return { balance: getUser(u.tg_id).balance, id, status: 'paid', usdt };
    } catch (e) {
      // Do not refund on an ambiguous network error: first check Crypto Pay by idempotency key.
      try {
        const found = await cryptoApi('getTransfers', { spend_id: `neon_wd_${id}`, asset: 'USDT' });
        const list = Array.isArray(found) ? found : (found.items || []);
        const tr = list.find(x => x.spend_id === `neon_wd_${id}`);
        if (tr) {
          tx(() => db.prepare(`UPDATE withdrawals SET status='paid',transfer_id=?,updated_at=? WHERE id=? AND status='processing'`).run(tr.transfer_id, Date.now(), id));
          sendSafe(u.tg_id, `💸 Вывод #${id} подтверждён Crypto Pay: ${usdt.toFixed(2)} USDT.`);
          return { balance: getUser(u.tg_id).balance, id, status: 'paid', usdt };
        }
      } catch {}
      if (e.providerRejected) {
        tx(() => {
          const changed = db.prepare(`UPDATE withdrawals SET status='rejected',updated_at=? WHERE id=? AND status='processing'`).run(Date.now(), id);
          if (changed.changes) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(amount, u.tg_id); led(u.tg_id, amount, 'withdraw_refund', id); }
        });
        sendSafe(u.tg_id, `❌ Crypto Pay отклонил выплату #${id}. ${num(amount)} ◆ возвращены на баланс. Проверь, что ты запускал @CryptoBot.`);
        return { balance: getUser(u.tg_id).balance, id, status: 'rejected', usdt };
      }
      db.prepare(`UPDATE withdrawals SET status='payout_review',updated_at=? WHERE id=? AND status='processing'`).run(Date.now(), id);
      for (const adminId of ADMIN_IDS) sendSafe(adminId, `⚠️ Вывод #${id} (${u.tg_id}, ${usdt.toFixed(2)} USDT) требует проверки Crypto Pay. Средства удержаны, повторно не отправляйте выплату до проверки /report.`);
      sendSafe(u.tg_id, `⏳ Заявка #${id} создана, но Crypto Pay не подтвердил результат. Средства временно удержаны до проверки; повторную заявку создавать не нужно.`);
      console.error('Crypto Pay payout:', e.message);
      return { balance: getUser(u.tg_id).balance, id, status: 'payout_review', usdt };
    }
  },
  '/api/admin/list': (u, b, t) => {
    assertAdmin(u, t, 'list');
    return db.prepare(`SELECT w.id, w.amount, w.gift, w.tg_id, x.first_name, x.username, x.balance FROM withdrawals w JOIN users x ON x.tg_id=w.tg_id WHERE w.status='pending' ORDER BY w.id LIMIT 50`)
      .all().map((r) => ({ ...r, gift_name: giftName(r.gift), ...stats(r.tg_id) }));
  },
  '/api/admin/set': (u, b, t) => {
    assertAdmin(u, t, 'set');
    if (!['paid', 'rejected'].includes(b.status) || !Number.isInteger(b.id)) throw new Error('bad_game');
    reviewWithdrawal(b.id, b.status, u.tg_id);
    return { ok: true };
  },
  '/api/admin/stats': (u, b, t) => { // turnover, payouts and profit for a period
    assertAdmin(u, t, 'stats');
    const now = Date.now(), since = { day: startOfDay(now), week: now - 7 * 864e5, month: now - 30 * 864e5, all: 0 }[b.period] ?? 0;
    const sum = (reasons) => db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE ts>=? AND reason IN (${reasons.map(() => '?').join(',')})`).get(since, ...reasons).s;
    const bets = -sum(['crash_bet', 'crash_cancel', 'mines_bet', 'chicken_bet', 'bet']), wins = sum(['crash_win', 'mines_win', 'chicken_win', 'win']);
    const wd = db.prepare(`SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM withdrawals WHERE status='paid' AND gift IS NULL AND updated_at>=?`).get(since);
    const gw = db.prepare(`SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM withdrawals WHERE status='paid' AND gift IS NOT NULL AND updated_at>=?`).get(since);
    return {
      period: b.period || 'all', bets, wins, profit: bets - wins, rtp: bets ? Math.round((wins / bets) * 1000) / 10 : 0,
      players: db.prepare(`SELECT COUNT(DISTINCT tg_id) n FROM ledger WHERE ts>=? AND reason IN ('crash_bet','mines_bet','chicken_bet','bet')`).get(since).n,
      deposits: sum(['deposit', 'crypto_deposit']), withdrawals: wd.s, withdrawals_n: wd.n, gifts_out: gw.s, gifts_out_n: gw.n,
      gifts_bought: -sum(['gift_buy']), referral: sum(['referral']),
      balances: { ...db.prepare('SELECT COALESCE(SUM(balance),0) s, COUNT(*) n FROM users').get() },
      pending: { wd: db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE status IN ('pending','processing','payout_review')`).get().n, dep: db.prepare(`SELECT COUNT(*) n FROM deposits WHERE status='pending'`).get().n },
    };
  },
  '/api/admin/limits': (u, b, t) => { // read or change max bet / max payout per round
    assertAdmin(u, t, 'limits');
    if (b.maxBet !== undefined || b.maxPayout !== undefined) {
      const mb = Number(b.maxBet), mp = Number(b.maxPayout);
      if (!Number.isSafeInteger(mb) || mb < 1 || mb > 1e7 || !Number.isSafeInteger(mp) || mp < 1 || mp > 1e9) throw new Error('bad_amount');
      LIM.maxBet = mb; LIM.maxPayout = mp;
      const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      up.run('maxBet', String(mb)); up.run('maxPayout', String(mp));
      audit(u.tg_id, 'limits', null, `maxBet=${mb} maxPayout=${mp}`);
    }
    return { maxBet: LIM.maxBet, maxPayout: LIM.maxPayout };
  },
  '/api/admin/user': (u, b, t) => {
    assertAdmin(u, t, 'user');
    if (!Number.isSafeInteger(b.id)) throw new Error('bad_game');
    const x = getUser(b.id); if (!x) throw new Error('no_game');
    return { id: x.tg_id, name: x.first_name, username: x.username, balance: x.balance, ...stats(x.tg_id) };
  },
  '/api/admin/balance': (u, b, t) => { // credit/debit a player; the player gets a bot message, the admin gets a receipt
    assertAdmin(u, t, 'balance');
    if (!Number.isSafeInteger(b.id) || !Number.isSafeInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > 1e9) throw new Error('bad_amount');
    const res = tx(() => {
      const x = getUser(b.id); if (!x) throw new Error('no_game');
      if (x.balance + b.amount < 0) throw new Error('bad_amount');
      db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(b.amount, x.tg_id);
      led(x.tg_id, b.amount, 'admin_adjust', null);
      audit(u.tg_id, 'balance', x.tg_id, `${b.amount > 0 ? '+' : ''}${b.amount} (was ${x.balance})`);
      return { balance: getUser(x.tg_id).balance };
    });
    const plus = b.amount > 0;
    sendSafe(b.id, plus ? `💰 Вам начислено ${num(b.amount)} ◆\\nБаланс: ${num(res.balance)} ◆` : `➖ С вашего счёта списано ${num(-b.amount)} ◆\\nБаланс: ${num(res.balance)} ◆`);
    sendSafe(u.tg_id, `✅ ${plus ? 'Начислено' : 'Списано'} ${num(Math.abs(b.amount))} ◆ · 🆔 ${b.id}\\nБаланс игрока: ${num(res.balance)} ◆\\n🕒 ${fmtDate(Date.now())}`);
    return res;
  },
  '/api/history': (u) => { // balance operations visible to the player (no individual bets)
    const L = { deposit: 'Пополнение', crypto_deposit: 'Пополнение (крипто)', referral: 'Реферальный бонус', signup: 'Стартовый баланс', admin_adjust: 'Начисление/списание админом', withdraw_hold: 'Заявка на вывод', withdraw_refund: 'Возврат по заявке', gift_buy: 'Покупка подарка', gift_sell: 'Продажа подарка' };
    return db.prepare(`SELECT delta, reason, ts FROM ledger WHERE tg_id=? AND reason IN ('signup','deposit','crypto_deposit','referral','admin_adjust','withdraw_hold','withdraw_refund','gift_buy','gift_sell') ORDER BY id DESC LIMIT 20`)
      .all(u.tg_id).map((r) => ({ delta: r.delta, label: L[r.reason], ts: r.ts }));
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
  '/api/gifts/withdraw': (u, b) => { // request to take a gift out; the item is held until the admin decides
    if (!Number.isInteger(b.item)) throw new Error('no_game');
    return tx(() => {
      const it = db.prepare('SELECT * FROM inventory WHERE id=? AND tg_id=?').get(b.item, u.tg_id);
      if (!it) throw new Error('no_game');
      const g = GIFT[it.gift], x = getUser(u.tg_id);
      db.prepare('DELETE FROM inventory WHERE id=?').run(it.id);
      const id = db.prepare('INSERT INTO withdrawals(tg_id,amount,gift,created_at,updated_at) VALUES(?,?,?,?,?)').run(x.tg_id, g.p, g.id, Date.now(), Date.now()).lastInsertRowid;
      try { notifyGiftWithdraw(id, x, g); } catch (e) { console.error('notify:', e.message); }
      return { id };
    });
  },
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
    if (activeMines(u.tg_id) || activeChicken(u.tg_id)) throw new Error('round_active');
    const x = getUser(u.tg_id), s = newSeed();
    const cs = typeof b.clientSeed === 'string' && /^[\w-]{1,32}$/.test(b.clientSeed) ? b.clientSeed : x.client_seed;
    const old = { serverSeed: dec(x.seed_enc), clientSeed: x.client_seed, rounds: x.nonce };
    db.prepare('UPDATE users SET seed_enc=?, seed_hash=?, client_seed=?, nonce=0 WHERE tg_id=?').run(s.enc, s.hash, cs, x.tg_id);
    return { revealed: old, fair: fair(getUser(x.tg_id)) };
  },
};
const KNOWN = new Set(['bad_amount', 'bad_auto', 'bad_game', 'bad_cell', 'no_game', 'forbidden', 'wd_pending', 'inv_full', 'no_balance', 'round_active', 'late', 'terms', 'pay_failed', 'dep_pending', 'bad_json', 'big', 'payout_disabled']);

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
  const c = crashAgg(id);
  const h = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet FROM chicken WHERE tg_id=? AND status!='active'`).get(id);
  const m = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bet FROM mines WHERE tg_id=? AND status!='active'`).get(id);
  const g = db.prepare('SELECT COUNT(*) n FROM upgrades WHERE tg_id=?').get(id);
  return { games: c.n + m.n + g.n + h.n, wagered: c.bet + m.bet + h.bet };
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
async function cryptoApi(method, params) { // server-to-server only, the token never leaves the server
  const r = await fetch(`${PAY_API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': PAY_TOKEN }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!j.ok) { const e = new Error(`${method}: ${j.error?.name || j.error || r.status}`); e.providerRejected = true; throw e; }
  return j.result;
}
function creditInvoice(inv) { // idempotent: only the pending -> paid transition credits the coins, so a double check never pays twice
  const out = tx(() => {
    const d = db.prepare(`UPDATE invoices SET status='paid', paid_at=? WHERE id=? AND status='pending'`).run(Date.now(), inv.id);
    if (d.changes !== 1) return null;
    db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(inv.coins, inv.tg_id);
    led(inv.tg_id, inv.coins, 'crypto_deposit', inv.id);
    let bonus = 0, refTo = null;
    const rf = REF_PERCENT ? db.prepare('SELECT referrer FROM referrals WHERE referred=?').get(inv.tg_id) : null;
    if (rf) {
      bonus = Math.floor((inv.coins * REF_PERCENT) / 100);
      if (bonus > 0) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(bonus, rf.referrer); led(rf.referrer, bonus, 'referral', inv.id); refTo = rf.referrer; }
    }
    return { bonus, refTo, balance: getUser(inv.tg_id).balance };
  });
  if (!out) return;
  sendSafe(inv.tg_id, `💰 Оплата получена: ${num(inv.usdt)} USDT → +${num(inv.coins)} ◆\nБаланс: ${num(out.balance)} ◆`);
  if (out.bonus > 0) sendSafe(out.refTo, `🎁 Реферальный бонус +${num(out.bonus)} ◆: ваш друг пополнил счёт.`);
  for (const id of ADMIN_IDS) sendSafe(id, `💰 Автопополнение · 🆔 ${inv.tg_id} · ${num(inv.usdt)} USDT → ${num(inv.coins)} ◆`);
}
let checking = false;
async function checkInvoices(onlyUser) { // asks Crypto Pay which pending invoices are paid; the amount comes from the provider, never from the client
  if (!PAY_TOKEN || checking) return;
  checking = true;
  try {
    const rows = db.prepare(`SELECT * FROM invoices WHERE status='pending' AND provider_id IS NOT NULL${onlyUser ? ' AND tg_id=?' : ''} ORDER BY id DESC LIMIT 100`).all(...(onlyUser ? [onlyUser] : []));
    if (!rows.length) return;
    const res = await cryptoApi('getInvoices', { invoice_ids: rows.map((r) => r.provider_id).join(',') });
    for (const it of Array.isArray(res) ? res : res.items || []) {
      const inv = rows.find((r) => r.provider_id === Number(it.invoice_id));
      if (!inv) continue;
      if (it.status === 'paid') {
        if (it.asset === 'USDT' && Number(it.amount) + 1e-9 >= inv.usdt) creditInvoice(inv);
        else { // wrong asset/amount: do not credit, tell the admin
          db.prepare(`UPDATE invoices SET status='mismatch' WHERE id=? AND status='pending'`).run(inv.id);
          for (const id of ADMIN_IDS) sendSafe(id, `⚠️ Счёт #${inv.id} (🆔 ${inv.tg_id}) оплачен, но сумма или валюта не совпали: ждали ${inv.usdt} USDT, пришло ${it.amount} ${it.asset}. Монеты не начислены.`);
        }
      } else if (it.status === 'expired') db.prepare(`UPDATE invoices SET status='expired' WHERE id=? AND status='pending'`).run(inv.id);
    }
  } catch (e) { console.error('pay check:', e.message); } finally { checking = false; }
}
const myInvoices = (id) => db.prepare('SELECT id, usdt, coins, status, created_at FROM invoices WHERE tg_id=? ORDER BY id DESC LIMIT 5').all(id).map((r) => ({ ...r }));
function notifyDeposit(did, x, amount) { // the bot sends the admin the player's data + confirm/reject buttons
  const s = stats(x.tg_id);
  const text = `💰 Заявка на пополнение #${did}\n\n🆔 ${x.tg_id}${x.username ? ` (@${x.username})` : ''}${x.first_name ? ` · ${x.first_name}` : ''}\n`
    + `🎮 Сыграно игр: ${s.games} (ставок на ${num(s.wagered)} ◆)\n💵 Хочет пополнить на: ${num(amount)} ◆\n`
    + `💼 Сумма на счету: ${num(getUser(x.tg_id).balance)} ◆\n🕒 ${fmtDate(Date.now())}`;
  const kb = { inline_keyboard: [[{ text: `✅ Начислить ${num(amount)} ◆`, callback_data: `dp:ok:${did}` }, { text: '❌ Отклонить', callback_data: `dp:no:${did}` }]] };
  for (const id of ADMIN_IDS) sendSafe(id, text, { reply_markup: kb });
  sendSafe(x.tg_id, `✅ Заявка #${did} на пополнение ${num(amount)} ◆ принята.\nНапиши админу${CONTACT ? ` (@${CONTACT})` : ''}, чтобы он подтвердил пополнение и начислил монеты.`);
}
function reviewDeposit(id, status, adminId, amount) { // 'paid' credits the coins (the admin may choose another amount), 'rejected' only closes the request
  const r = tx(() => {
    const d = db.prepare(`SELECT * FROM deposits WHERE id=? AND status='pending'`).get(id);
    if (!d) throw new Error('no_game');
    let credited = 0, bonus = 0, refTo = null;
    if (status === 'paid') {
      credited = amount == null ? d.amount : amount;
      if (!Number.isSafeInteger(credited) || credited < 1 || credited > 1e9) throw new Error('bad_amount');
      db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(credited, d.tg_id);
      led(d.tg_id, credited, 'deposit', d.id);
      const rf = REF_PERCENT ? db.prepare('SELECT referrer FROM referrals WHERE referred=?').get(d.tg_id) : null;
      if (rf) { // the inviter gets a share of the friend's deposit
        bonus = Math.floor((credited * REF_PERCENT) / 100);
        if (bonus > 0) { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(bonus, rf.referrer); led(rf.referrer, bonus, 'referral', d.id); refTo = rf.referrer; }
      }
    }
    db.prepare('UPDATE deposits SET status=?, credited=?, updated_at=? WHERE id=?').run(status, credited, Date.now(), d.id);
    audit(adminId, `deposit_${status}`, d.tg_id, `#${d.id} ${credited || d.amount}`);
    return { ...d, credited, bonus, refTo, balance: getUser(d.tg_id).balance };
  });
  if (r.bonus > 0) sendSafe(r.refTo, `🎁 Реферальный бонус +${num(r.bonus)} ◆: ваш друг пополнил счёт.`);
  sendSafe(r.tg_id, status === 'paid' ? `💰 Ваш счёт пополнен на ${num(r.credited)} ◆\nБаланс: ${num(r.balance)} ◆` : `❌ Заявка #${r.id} на пополнение отклонена.`);
  return r;
}
function notifyGiftWithdraw(wid, x, g) {
  const s = stats(x.tg_id);
  const text = `🎁 Заявка на вывод подарка #${wid}\n\n🆔 ${x.tg_id}${x.username ? ` (@${x.username})` : ''}${x.first_name ? ` · ${x.first_name}` : ''}\n`
    + `🎮 Сыграно игр: ${s.games} (ставок на ${num(s.wagered)} ◆)\n🎁 Подарок: ${g.e} ${g.n} (${num(g.p)} ◆)\n`
    + `💼 Сумма на счету: ${num(getUser(x.tg_id).balance)} ◆\n🕒 ${fmtDate(Date.now())}\n\nВывод делается в течение 8 часов.`;
  const kb = { inline_keyboard: [[{ text: '✅ Выплачено', callback_data: `wd:paid:${wid}` }, { text: '❌ Отклонить', callback_data: `wd:rej:${wid}` }]] };
  for (const id of ADMIN_IDS) sendSafe(id, text, { reply_markup: kb });
  sendSafe(x.tg_id, `✅ Заявка #${wid} на вывод ${g.e} ${g.n} принята.\nВывод делается в течение 8 часов.`);
}
function reviewWithdrawal(id, status, adminId) {
  const w = tx(() => {
    const r = db.prepare(`SELECT * FROM withdrawals WHERE id=? AND status='pending'`).get(id);
    if (!r) throw new Error('no_game');
    db.prepare('UPDATE withdrawals SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), r.id);
    if (status === 'rejected') {
      if (r.gift) db.prepare('INSERT INTO inventory(tg_id,gift,created_at) VALUES(?,?,?)').run(r.tg_id, r.gift, Date.now()); // the gift goes back to the inventory
      else { db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(r.amount, r.tg_id); led(r.tg_id, r.amount, 'withdraw_refund', r.id); }
    }
    audit(adminId, `withdraw_${status}`, r.tg_id, `#${r.id} ${r.amount}`);
    return r;
  });
  if (w.gift) sendSafe(w.tg_id, status === 'paid' ? `🎁 Заявка #${w.id}: ${giftName(w.gift)} выведен.` : `❌ Заявка #${w.id} отклонена, ${giftName(w.gift)} вернулся в инвентарь.`);
  else sendSafe(w.tg_id, status === 'paid' ? `💸 Заявка #${w.id} на ${num(w.amount)} ◆ выплачена.` : `❌ Заявка #${w.id} отклонена, ${num(w.amount)} ◆ возвращены на счёт.`);
}
const WELCOME = '👋 Добро пожаловать в Neon Arcade!\n\n🚀 Crash · 💎 Mines · 🐔 Chicken Run · 🎁 Апгрейд подарков\n\nПеред началом прочитай правила и пользовательское соглашение. Нажимая «Согласен», ты подтверждаешь, что тебе исполнилось 18 лет и ты принимаешь правила.';
const playKb = () => (WEBAPP_URL ? { inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: WEBAPP_URL } }]] } : undefined);
async function sendWelcome(chatId, uid) { // photo welcome for first-time users; compact return message afterwards
  if (hasAgreed(uid)) return sendSafe(chatId, `👋 С возвращением! Нажми «Играть», чтобы открыть Neon Arcade.${WEBAPP_URL ? '' : '\n(Кнопка игры слева от поля ввода.)'}`, { reply_markup: playKb() });
  const reply_markup = { inline_keyboard: [[{ text: '📄 Читать правила', callback_data: 'terms:rules' }], [{ text: '✅ Согласен', callback_data: 'terms:yes' }, { text: '❌ Не согласен', callback_data: 'terms:no' }]] };
  try {
    const bytes = await fs.promises.readFile(path.join(import.meta.dirname, 'assets', 'cash-king-welcome.png'));
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'cash-king-welcome.png');
    form.append('caption', WELCOME);
    form.append('reply_markup', JSON.stringify(reply_markup));
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (result.ok) return result.result;
    throw new Error(result.description || 'sendPhoto failed');
  } catch (e) {
    console.error('welcome photo:', e.message);
    return sendSafe(chatId, WELCOME, { reply_markup });
  }
}
async function handleTerms(cb) {
  const chat = cb.message?.chat.id ?? cb.from.id;
  const ack = (text, alert = false) => tgCall('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  if (cb.data === 'terms:rules') { await ack(); return sendSafe(chat, TERMS_TEXT); }
  if (cb.data === 'terms:no') { await ack('Без согласия доступ к игре закрыт.', true); return; }
  if (cb.data === 'terms:yes') {
    saveAgreement(cb.from.id);
    await ack('Спасибо! Доступ открыт.');
    return sendSafe(chat, `✅ Правила приняты. Приятной игры!\n\nОткрой игру${WEBAPP_URL ? ' кнопкой ниже.' : ' кнопкой меню слева от поля ввода.'}`, { reply_markup: playKb() });
  }
}
function makeAdminReport(period='day') {
  const now=Date.now(), since={day:startOfDay(now),week:now-7*864e5,month:now-30*864e5,all:0}[period] ?? startOfDay(now);
  const sum=(reasons)=>bankDb.prepare(`SELECT COALESCE(SUM(delta),0) s FROM bank_ledger WHERE ts>=? AND reason IN (${reasons.map(()=>'?').join(',')})`).get(since,...reasons).s;
  const bets=-sum(['crash_bet','crash_cancel','mines_bet','chicken_bet','bet']);
  const wins=sum(['crash_win','mines_win','chicken_win','win']);
  const deposits=sum(['deposit','crypto_deposit']);
  const payouts=bankDb.prepare(`SELECT COALESCE(SUM(amount),0) s,COUNT(*) n FROM withdrawals WHERE status='paid' AND gift IS NULL AND updated_at>=?`).get(since);
  const plus=Math.max(0,bets-wins), minus=Math.max(0,wins-bets), scale=Math.max(1,plus,minus);
  const bar=(v)=>'█'.repeat(Math.max(1,Math.round(v/scale*12)));
  const pending=db.prepare(`SELECT COUNT(*) n FROM withdrawals WHERE status IN ('pending','processing','payout_review') AND gift IS NULL`).get().n;
  return `📊 CASH KING · ОТЧЁТ (${({day:'сегодня',week:'7 дней',month:'30 дней',all:'всё время'})[period]})\n\n`+
    `💰 Пополнения: ${num(deposits)} ◆\n💸 Выводы USDT: ${num(payouts.s)} ◆ (${payouts.n})\n`+
    `🎮 Ставки: ${num(bets)} ◆\n🏆 Выигрыши: ${num(wins)} ◆\n`+
    `🟢 Плюс: ${num(plus)} ◆\n🔴 Минус: ${num(minus)} ◆\n\n`+
    `ДИАГРАММА РЕЗУЛЬТАТА\n🟢 ${bar(plus)} ${num(plus)} ◆\n🔴 ${bar(minus)} ${num(minus)} ◆\n\n`+
    `👥 Игроков: ${db.prepare(`SELECT COUNT(DISTINCT tg_id) n FROM ledger WHERE ts>=?`).get(since).n}\n`+
    `⏳ Выводы на проверке: ${pending}\n🏦 Отдельный банк: ${BANK_DB_PATH}`;
}
async function handleUpdate(up) { // /start, admin reports and terms callbacks
  if (up.message) {
    const msg=up.message.text || '';
    if (/^\/start(\s|$)/.test(msg)) return sendWelcome(up.message.chat.id, up.message.from.id);
    const rep=/^\/report(?:@\w+)?(?:\s+(day|week|month|all))?\s*$/i.exec(msg);
    if (rep) {
      if (!ADMIN_IDS.has(up.message.from.id)) return sendSafe(up.message.chat.id, '⛔ Команда доступна только администратору.');
      return sendSafe(up.message.chat.id, makeAdminReport((rep[1]||'day').toLowerCase()));
    }
  }
  const cb = up.callback_query; if (!cb) return;
  if ((cb.data || '').startsWith('terms:')) return handleTerms(cb);
  const dp = /^dp:(ok|no):(\d+)$/.exec(cb.data || '');
  if (dp) { // ✅ / ❌ under a deposit request
    const answer = (text) => tgCall('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: true }).catch(() => {});
    if (!ADMIN_IDS.has(cb.from.id)) { audit(cb.from.id, 'denied', null, 'bot button'); return answer('Нет доступа'); }
    const ok = dp[1] === 'ok';
    let r;
    try { r = reviewDeposit(Number(dp[2]), ok ? 'paid' : 'rejected', cb.from.id); } catch { return answer('Заявка уже обработана'); }
    await answer(ok ? `Начислено ${num(r.credited)} ◆` : 'Отклонено');
    if (cb.message) await tgCall('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `${cb.message.text}\n\n${ok ? `✅ НАЧИСЛЕНО ${num(r.credited)} ◆` : '❌ ОТКЛОНЕНО'} · ${fmtDate(Date.now())}` }).catch(() => {});
    return;
  }
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
      const ups = await tgCall('getUpdates', { offset, timeout: 25, allowed_updates: ['callback_query', 'message'] }, 35000);
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
    if (!hasAgreed(tgUser.id)) { // nothing is created or served until the rules are accepted
      if (req.url === '/api/auth') return send(res, 200, { terms: true, version: TERMS_VERSION, text: TERMS_TEXT });
      if (req.url !== '/api/terms/accept') return send(res, 400, { error: 'terms' });
    }
    send(res, 200, await fn(ensureUser(tgUser), body, tgUser));
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
pollBot(); // the bot answers /start for everybody, so it always runs
tgCall('getMe', {}).then((r) => { BOT_USERNAME = r.username || ''; }).catch((e) => console.error('getMe:', e.message)); // needed for referral links
if (PAY_TOKEN) setInterval(() => checkInvoices(), 10000); // automatic top-up: look for paid invoices every 10 s
