'use strict';

/*
 * Live demo room shared by the presenter and the audience phones.
 *
 * Money model (all amounts are simulated):
 *   bank      Each audience member's "bank account". Starts at room.start_bank
 *             (default 5,000 ฿). Moving money into the platform takes it out of
 *             the bank; only an approved withdrawal puts it back. Once spent it
 *             is gone, which is the lesson.
 *   platform  The scam app's balance = approved deposits − withdrawals that are
 *             pending/approved/held + presenter adjustments ("bonus"). The phone
 *             adds its own trading profit/loss on top.
 *
 * Request lifecycle:
 *   deposit   pending → approved (credited) | rejected (bank money is lost)
 *             auto-approved when room.auto_deposit is on.
 *   withdraw  pending → approved (back to bank) | held (fee demanded, money stays
 *             frozen) | rejected (returned to the platform balance)
 *             auto-held with an auto_tax_pct fee when that setting is > 0.
 *   held      paying the fee from the bank records a "tax" request (money gone)
 *             and puts the withdrawal back to pending.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { getDb } = require('./db');

const MAX_PLAYERS = 500;
const MAX_AMOUNT = 1e9;
const ONLINE_MS = 20_000;
const EVENT_TYPES = new Set(['pump', 'vip', 'flags', 'notice']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ----------------------------------------------------------------- helpers */

const rid = () => crypto.randomBytes(9).toString('base64url');
const num = (x) => Math.round((Number(x) || 0) * 100) / 100;

function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw new HttpError(400, 'id ไม่ถูกต้อง');
  return id;
}
function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return s || 'ผู้เล่น';
}
function cleanText(text, max) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}
function money(x, { min = -MAX_AMOUNT, max = MAX_AMOUNT } = {}) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, Math.round(v * 100) / 100));
}
function positive(x, label = 'จำนวนเงิน') {
  const v = money(x, { min: 0 });
  if (!(v > 0)) throw new HttpError(400, `${label}ไม่ถูกต้อง`);
  return v;
}
function reqOut(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    amount: num(r.amount),
    status: r.status,
    fee: r.fee == null ? null : num(r.fee),
    method: r.method || null,
    at: new Date(r.created_at).getTime(),
    decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : null,
  };
}

/* Per-player money summary, computed in SQL so every caller agrees. */
const PLAYER_SUMS = `
  coalesce((select sum(q.amount) from agt.requests q
            where q.player_id = p.id and q.kind = 'deposit' and q.status = 'approved'), 0) as deposited,
  coalesce((select sum(q.amount) from agt.requests q
            where q.player_id = p.id and q.kind = 'withdraw' and q.status in ('pending', 'approved', 'held')), 0) as withdrawn,
  coalesce((select sum(q.amount) from agt.requests q
            where q.player_id = p.id and q.kind = 'withdraw' and q.status = 'approved'), 0) as withdrawn_ok,
  coalesce((select sum(q.amount) from agt.requests q
            where q.player_id = p.id and q.kind = 'tax'), 0) as tax_paid,
  coalesce((select sum(q.amount) from agt.requests q
            where q.player_id = p.id and q.kind in ('deposit', 'tax')), 0) as sent,
  p.credit + r.credit_all - p.all_base as bonus`;

function playerMoney(row) {
  const deposited = num(row.deposited);
  const withdrawn = num(row.withdrawn);
  const bonus = num(row.bonus);
  return {
    bank: num(row.bank),
    bankStart: num(row.bank_start),
    deposited,
    withdrawn,
    withdrawnOk: num(row.withdrawn_ok),
    taxPaid: num(row.tax_paid),
    sent: num(row.sent),             // everything that ever left the bank (transfers in any status + fees)
    bonus,
    flow: num(deposited - withdrawn + bonus),
  };
}

async function room(db) {
  const [r] = await db.query('select * from agt.room where id = 1');
  return r;
}

/* -------------------------------------------------------------- accounts */
// Audience accounts: nickname + password (scrypt-hashed). A signed token
// "<playerId>.<expiry>.<hmac>" identifies the player on every later call.

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const PLAYER_TTL = 48 * 3600 * 1000;
const PLAYER_MAX_FAILS = 10;
const ADMIN_MAX_FAILS = 20;
const MAX_STATE_BYTES = 20_000;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [algo, salt, hex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hex) return false;
  const want = Buffer.from(hex, 'hex');
  const got = await scrypt(String(pw), Buffer.from(salt, 'hex'), want.length, SCRYPT);
  return crypto.timingSafeEqual(got, want);
}
let dummyHash;   // spend the same time on unknown names as on real ones
const dummy = () => (dummyHash ??= hashPassword(crypto.randomBytes(8).toString('hex')));

function cleanLogin(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().replace(/\s+/g, ' ');
  const len = [...s].length;
  if (len < 2 || len > 24) throw new HttpError(400, 'ชื่อผู้ใช้ต้องมี 2–24 ตัวอักษร');
  if (s.replace(/\D/g, '').length >= 6) throw new HttpError(400, 'ห้ามใช้เบอร์โทรเป็นชื่อผู้ใช้ — ใช้ชื่อเล่นแทน');
  if (s.toLowerCase() === adminUser().toLowerCase()) throw new HttpError(400, 'ชื่อนี้สงวนไว้สำหรับผู้บรรยาย');
  return s;
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 4 || pw.length > 64) throw new HttpError(400, 'รหัสผ่านต้องมี 4–64 ตัวอักษร');
  return pw;
}

async function roomSecret(db) {
  if (!db.secret) db.secret = (await db.query('select secret from agt.room where id = 1'))[0].secret;
  return db.secret;
}
const signPlayer = (secret, body) => crypto.createHmac('sha256', secret).update(`player:${body}`).digest('base64url');
async function issuePlayerToken(db, id) {
  const body = `${id}.${Date.now() + PLAYER_TTL}`;
  return `${body}.${signPlayer(await roomSecret(db), body)}`;
}
async function playerId(db, token) {
  const parts = String(token || '').split('.');
  if (parts.length === 3) {
    const [id, exp, sig] = parts;
    if (Number(exp) > Date.now() && safeEq(sig, signPlayer(await roomSecret(db), `${id}.${exp}`))) return id;
  }
  throw new HttpError(401, 'กรุณาเข้าสู่ระบบใหม่');
}

async function failGate(db, key, max) {
  const [f] = await db.query('select fails from agt.login_fails where ip = $1 and until > now()', [key]);
  if (f && f.fails >= max) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที');
}
async function recordFail(db, key) {
  await db.query(
    `insert into agt.login_fails (ip, fails, until) values ($1, 1, now() + interval '15 minutes')
     on conflict (ip) do update set
       fails = case when agt.login_fails.until < now() then 1 else agt.login_fails.fails + 1 end,
       until = case when agt.login_fails.until < now() then now() + interval '15 minutes' else agt.login_fails.until end`,
    [key],
  );
}
const cleanupIdle = (db) => db.query(`delete from agt.players where seen_at < now() - interval '24 hours'`);

/* ------------------------------------------------------------ audience API */

async function signup(name, pass) {
  const login = cleanLogin(name);
  checkPassword(pass);
  const db = await getDb();
  await cleanupIdle(db);
  const [{ count }] = await db.query('select count(*)::int as count from agt.players');
  if (count >= MAX_PLAYERS) throw new HttpError(409, 'ห้องเต็มแล้ว');
  const id = 'p' + crypto.randomBytes(12).toString('hex');
  const hash = await hashPassword(pass);
  try {
    await db.query(
      `insert into agt.players (id, name, login, pass_hash, bank, bank_start, all_base)
         select $1, $2, $2, $3, r.start_bank, r.start_bank, r.credit_all from agt.room r where r.id = 1`,
      [id, login, hash],
    );
  } catch (err) {
    if (err.code === '23505' || /duplicate key|players_login_idx/.test(err.message)) {
      throw new HttpError(409, 'ชื่อผู้ใช้นี้มีคนใช้แล้ว ลองชื่ออื่น');
    }
    throw err;
  }
  return { token: await issuePlayerToken(db, id), saved: null, ...(await state(db, id, Number.MAX_SAFE_INTEGER, 'latest')) };
}

/** One login form for everyone: the presenter's name goes to the admin check. */
async function login(user, pass, ip) {
  const u = String(user ?? '').trim();
  if (u && u.toLowerCase() === adminUser().toLowerCase()) return { admin: true, ...(await adminLogin(u, pass, ip)) };
  if (!u || typeof pass !== 'string' || !pass) throw new HttpError(400, 'กรอกชื่อผู้ใช้และรหัสผ่าน');
  const db = await getDb();
  await cleanupIdle(db);
  const key = `u:${u.toLowerCase().slice(0, 40)}`;
  await failGate(db, key, PLAYER_MAX_FAILS);
  const [p] = await db.query('select id, pass_hash, state from agt.players where lower(login) = lower($1)', [u]);
  const ok = await verifyPassword(pass, p ? p.pass_hash : await dummy());
  if (!p || !ok) {
    await recordFail(db, key);
    throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (ถ้ายังไม่มีบัญชี กดสมัครสมาชิกก่อน)');
  }
  await db.query('delete from agt.login_fails where ip = $1', [key]);
  await db.query('update agt.players set seen_at = now() where id = $1', [p.id]);
  return { token: await issuePlayerToken(db, p.id), saved: p.state || null, ...(await state(db, p.id, Number.MAX_SAFE_INTEGER, 'latest')) };
}

/** Phone reloaded: is the saved token still a live account? */
async function session(token) {
  const db = await getDb();
  const id = await playerId(db, token);
  const [p] = await db.query('update agt.players set seen_at = now() where id = $1 returning state', [id]);
  if (!p) throw new HttpError(401, 'บัญชีนี้ถูกลบแล้ว (ผู้บรรยายเริ่มรอบใหม่) กรุณาสมัครสมาชิกใหม่');
  return { saved: p.state || null, ...(await state(db, id, Number.MAX_SAFE_INTEGER, 'latest')) };
}

function chatOut(c) {
  return { id: Number(c.id), from: c.sender, text: c.text, meta: c.meta || {}, at: new Date(c.created_at).getTime() };
}

/** chatSince: null = no chat, 'latest' = recent history, n = messages after id n */
async function state(db, id, since, chatSince = null) {
  const rows = await db.query(
    `select p.*, r.epoch, r.evseq, ${PLAYER_SUMS}
       from agt.players p cross join agt.room r
      where p.id = $1 and r.id = 1`,
    [id],
  );
  if (!rows.length) throw new HttpError(404, 'ไม่พบผู้เล่นในห้อง');
  const p = rows[0];
  const requests = await db.query(
    'select * from agt.requests where player_id = $1 order by id desc limit 30',
    [id],
  );
  let events = [];
  if (p.evseq > Number(since || 0)) {
    events = (await db.query(
      'select seq, type, data from agt.events where seq > $1 order by seq limit 20',
      [Number(since) || 0],
    )).map((e) => ({ seq: e.seq, type: e.type, ...e.data }));
  }
  let chat;
  if (chatSince != null) {
    chat = chatSince !== 'latest'
      ? await db.query('select * from agt.chat where player_id = $1 and id > $2 order by id limit 100', [id, Number(chatSince)])
      : (await db.query('select * from agt.chat where player_id = $1 order by id desc limit 100', [id])).reverse();
  }
  return {
    epoch: p.epoch,
    evseq: p.evseq,
    name: p.name,
    vip: !!p.vip,
    botOn: !p.bot_off,
    ...playerMoney(p),
    requests: requests.map(reqOut),
    events,
    ...(chat ? { chat: chat.map(chatOut) } : {}),
  };
}

async function sync(token, since, report, chatSince) {
  const db = await getDb();
  const id = await playerId(db, token);
  const [r] = await db.query('select epoch from agt.room where id = 1');
  const [p] = await db.query('select 1 from agt.players where id = $1', [id]);
  if (!p) return { epoch: r.epoch, missing: true };
  if (report && typeof report === 'object') {
    let st = null;
    if (report.state && typeof report.state === 'object') {
      const json = JSON.stringify(report.state);
      if (json.length <= MAX_STATE_BYTES) st = json;
    }
    await db.query(
      `update agt.players set value = $2, cash = $3, state = coalesce($4::jsonb, state), seen_at = now() where id = $1`,
      [id, money(report.value), money(report.cash), st],
    );
  } else {
    await db.query('update agt.players set seen_at = now() where id = $1', [id]);
  }
  return state(db, id, since, chatSince == null ? null : Math.max(0, Number(chatSince) || 0));
}

/** Audience chat: the phone posts the user's message, then (if the bot is on) the scripted bot reply. */
async function chatPost(token, text, as, teach) {
  const db = await getDb();
  const id = await playerId(db, token);
  const sender = as === 'bot' ? 'bot' : 'user';
  const body = cleanText(text, 500);
  if (!body) throw new HttpError(400, 'พิมพ์ข้อความก่อนส่ง');
  const meta = sender === 'bot' && teach ? { teach: cleanText(teach, 300) } : {};
  const [p] = await db.query('select bot_off from agt.players where id = $1', [id]);
  if (!p) throw new HttpError(404, 'ไม่พบผู้เล่นในห้อง');
  if (sender === 'bot' && p.bot_off) return { botOn: false };   // presenter took over meanwhile
  const [m] = await db.query(
    'insert into agt.chat (player_id, sender, text, meta) values ($1, $2, $3, $4::jsonb) returning *',
    [id, sender, body, JSON.stringify(meta)],
  );
  await db.query('update agt.players set seen_at = now() where id = $1', [id]);
  return { msg: chatOut(m), botOn: !p.bot_off };
}

async function deposit(token, amount, method) {
  const amt = positive(amount);
  const via = cleanText(method, 40) || null;
  const db = await getDb();
  const id = await playerId(db, token);
  const rows = await db.query(
    `with p as (
        update agt.players set bank = bank - $2, seen_at = now()
         where id = $1 and bank >= $2 returning id),
      r as (select auto_deposit from agt.room where id = 1)
     insert into agt.requests (player_id, kind, amount, status, decided_at, method)
       select p.id, 'deposit', $2,
              case when r.auto_deposit then 'approved' else 'pending' end,
              case when r.auto_deposit then now() end, $3
         from p, r
     returning id`,
    [id, amt, via],
  );
  if (!rows.length) {
    const [exists] = await db.query('select 1 from agt.players where id = $1', [id]);
    throw exists ? new HttpError(400, 'เงินในบัญชีธนาคารไม่พอ') : new HttpError(404, 'ไม่พบผู้เล่นในห้อง');
  }
  return state(db, id, Number.MAX_SAFE_INTEGER);
}

async function withdraw(token, amount) {
  const amt = positive(amount);
  const db = await getDb();
  const id = await playerId(db, token);
  const rows = await db.query(
    `with r as (select auto_tax_pct from agt.room where id = 1)
     insert into agt.requests (player_id, kind, amount, status, fee, decided_at)
       select p.id, 'withdraw', $2,
              case when r.auto_tax_pct > 0 then 'held' else 'pending' end,
              case when r.auto_tax_pct > 0 then round($2 * r.auto_tax_pct / 100, 2) end,
              case when r.auto_tax_pct > 0 then now() end
         from agt.players p, r where p.id = $1
     returning id`,
    [id, amt],
  );
  if (!rows.length) throw new HttpError(404, 'ไม่พบผู้เล่นในห้อง');
  return state(db, id, Number.MAX_SAFE_INTEGER);
}

async function payTax(token, requestId) {
  const db = await getDb();
  const id = await playerId(db, token);
  const rows = await db.query(
    `with w as (
        select id, fee from agt.requests
         where id = $2 and player_id = $1 and kind = 'withdraw' and status = 'held' and fee > 0
         for update),
      p as (
        update agt.players pl set bank = pl.bank - w.fee from w
         where pl.id = $1 and pl.bank >= w.fee returning w.id as wid, w.fee),
      t as (
        insert into agt.requests (player_id, kind, amount, status, decided_at)
          select $1, 'tax', p.fee, 'approved', now() from p returning id),
      u as (
        update agt.requests set status = 'pending', fee = null, decided_at = null
         where id in (select wid from p) returning id)
     select (select count(*) from u)::int as paid, (select count(*) from w)::int as held`,
    [id, Number(requestId) || 0],
  );
  const { paid, held } = rows[0];
  if (!held) throw new HttpError(409, 'คำขอนี้ไม่ได้รอชำระค่าธรรมเนียมแล้ว');
  if (!paid) throw new HttpError(400, 'เงินในบัญชีธนาคารไม่พอชำระ');
  return state(db, id, Number.MAX_SAFE_INTEGER);
}

/* ------------------------------------------------------------- admin API */

async function overview() {
  const db = await getDb();
  const r = await room(db);
  const players = (await db.query(
    `select p.*, ${PLAYER_SUMS} from agt.players p cross join agt.room r where r.id = 1 order by p.joined_at`,
  )).map((p) => ({
    id: p.id,
    name: p.name,
    value: num(p.value),
    cash: num(p.cash),
    joined: new Date(p.joined_at).getTime(),
    seen: new Date(p.seen_at).getTime(),
    online: Date.now() - new Date(p.seen_at).getTime() < ONLINE_MS,
    vip: !!p.vip,
    botOn: !p.bot_off,
    ...playerMoney(p),
  }));
  const last = Object.fromEntries((await db.query(
    `select distinct on (player_id) player_id, sender, text, created_at from agt.chat order by player_id, id desc`,
  )).map((c) => [c.player_id, { from: c.sender, text: c.text, at: new Date(c.created_at).getTime() }]));
  const counts = Object.fromEntries((await db.query(
    `select player_id, count(*)::int as n from agt.chat where sender = 'user' group by player_id`,
  )).map((c) => [c.player_id, c.n]));
  players.forEach((p) => { p.lastChat = last[p.id] || null; p.userMsgs = counts[p.id] || 0; });
  const names = Object.fromEntries(players.map((p) => [p.id, p.name]));
  const requests = (await db.query(
    `select * from agt.requests
      order by (status = 'pending') desc, id desc
      limit 300`,
  )).map((q) => ({ ...reqOut(q), playerId: q.player_id, player: names[q.player_id] || '?' }));

  const sum = (f) => num(players.reduce((s, p) => s + f(p), 0));
  return {
    settings: {
      autoDeposit: r.auto_deposit,
      autoTaxPct: num(r.auto_tax_pct),
      startBank: num(r.start_bank),
    },
    stats: {
      players: players.length,
      online: players.filter((p) => p.online).length,
      lost: sum((p) => p.sent),                         // bank money the audience sent to the app (incl. "tax")
      onScreen: sum((p) => p.value),                    // what the app shows them
      paidOut: sum((p) => p.withdrawnOk),              // what actually came back
      taxPaid: sum((p) => p.taxPaid),
      pending: requests.filter((q) => q.status === 'pending').length,
      held: requests.filter((q) => q.status === 'held').length,
      vip: players.filter((p) => p.vip).length,
      chatsWaiting: players.filter((p) => p.lastChat && p.lastChat.from === 'user' && !p.botOn).length,
    },
    players,
    requests,
  };
}

async function credit(target, amount) {
  const amt = money(amount);
  if (!amt) throw new HttpError(400, 'จำนวนเงินไม่ถูกต้อง');
  const db = await getDb();
  if (target === 'all') {
    await db.query('update agt.room set credit_all = credit_all + $1 where id = 1', [amt]);
    return { ok: true };
  }
  checkId(target);
  const rows = await db.query('update agt.players set credit = credit + $2 where id = $1 returning id', [target, amt]);
  if (!rows.length) throw new HttpError(404, 'ไม่พบผู้เล่นนี้');
  return { ok: true };
}

const GRANT_KINDS = new Set(['topup', 'bonus', 'vip', 'debit']);
const baht = (n) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
function grantText(kind, amt) {
  if (kind === 'topup') return `💰 ระบบเติมเงินเข้าพอร์ตของคุณ ${baht(amt)} ฿`;
  if (kind === 'bonus') return `🎁 ยินดีด้วย! คุณได้รับโบนัสพิเศษ ${baht(amt)} ฿ จากกิจกรรมของเรา`;
  if (kind === 'debit') return `⚠️ ระบบหักเงิน ${baht(-amt)} ฿ จากพอร์ตของคุณ (ค่าธรรมเนียมบริการ)`;
  return `👑 ยินดีด้วย! คุณได้รับสิทธิ์สมาชิก VIP${amt ? ` พร้อมโบนัส ${baht(amt)} ฿` : ''} — ถอนเงินได้ไวขึ้น และรับโบนัสฝากเพิ่ม 50%`;
}

/** Give money / a special bonus / VIP status (or take money) to chosen players or everyone. */
async function grant(targets, kind, amount, message) {
  if (!GRANT_KINDS.has(kind)) throw new HttpError(400, 'ชนิดรายการไม่ถูกต้อง');
  let amt = money(amount, { min: 0 });
  if ((kind === 'topup' || kind === 'bonus' || kind === 'debit') && !(amt > 0)) throw new HttpError(400, 'จำนวนเงินไม่ถูกต้อง');
  if (kind === 'debit') amt = -amt;
  const db = await getDb();
  let ids;
  if (targets === 'all') ids = (await db.query('select id from agt.players')).map((r) => r.id);
  else if (Array.isArray(targets)) ids = [...new Set(targets.map(String))].filter((t) => /^[A-Za-z0-9_-]{8,40}$/.test(t));
  else throw new HttpError(400, 'เลือกบัญชีก่อน');
  if (!ids.length) throw new HttpError(400, 'ยังไม่มีบัญชีให้ส่ง');
  const done = (await db.query(
    'update agt.players set credit = credit + $2, vip = vip or $3 where id = any($1::text[]) returning id',
    [ids, amt, kind === 'vip'],
  )).map((r) => r.id);
  if (!done.length) throw new HttpError(404, 'ไม่พบบัญชีที่เลือก');
  const text = cleanText(message, 300) || grantText(kind, amt);
  await db.query(
    `insert into agt.chat (player_id, sender, text, meta)
       select unnest($1::text[]), 'system', $2, $3::jsonb`,
    [done, text, JSON.stringify({ kind, amount: amt })],
  );
  return { ok: true, count: done.length };
}

async function thread(playerIdArg) {
  checkId(playerIdArg);
  const db = await getDb();
  const [p] = await db.query('select id, name, vip, bot_off from agt.players where id = $1', [playerIdArg]);
  if (!p) throw new HttpError(404, 'ไม่พบผู้เล่นนี้');
  const msgs = (await db.query('select * from agt.chat where player_id = $1 order by id desc limit 200', [p.id])).reverse();
  return { player: { id: p.id, name: p.name, vip: p.vip, botOn: !p.bot_off }, messages: msgs.map(chatOut) };
}

async function reply(playerIdArg, text) {
  checkId(playerIdArg);
  const body = cleanText(text, 500);
  if (!body) throw new HttpError(400, 'พิมพ์ข้อความก่อนส่ง');
  const db = await getDb();
  const rows = await db.query(
    `insert into agt.chat (player_id, sender, text) select id, 'admin', $2 from agt.players where id = $1 returning *`,
    [playerIdArg, body],
  );
  if (!rows.length) throw new HttpError(404, 'ไม่พบผู้เล่นนี้');
  return { ok: true, msg: chatOut(rows[0]) };
}

async function setBot(playerIdArg, on) {
  checkId(playerIdArg);
  const db = await getDb();
  const rows = await db.query('update agt.players set bot_off = $2 where id = $1 returning id', [playerIdArg, !on]);
  if (!rows.length) throw new HttpError(404, 'ไม่พบผู้เล่นนี้');
  return { ok: true, botOn: !!on };
}

async function decide(requestId, decision, feePct) {
  const id = Number(requestId) || 0;
  const db = await getDb();
  let rows;
  if (decision === 'approve') {
    rows = await db.query(
      `with q as (
          update agt.requests set status = 'approved', fee = null, decided_at = now()
           where id = $1 and (
                 (kind = 'deposit'  and status = 'pending') or
                 (kind = 'withdraw' and status in ('pending', 'held')))
          returning player_id, kind, amount),
        b as (
          update agt.players p set bank = p.bank + q.amount from q
           where p.id = q.player_id and q.kind = 'withdraw' returning p.id)
       select kind from q`,
      [id],
    );
  } else if (decision === 'reject') {
    rows = await db.query(
      `update agt.requests set status = 'rejected', fee = null, decided_at = now()
        where id = $1 and (
              (kind = 'deposit'  and status = 'pending') or
              (kind = 'withdraw' and status in ('pending', 'held')))
        returning kind`,
      [id],
    );
  } else if (decision === 'tax') {
    const pct = money(feePct, { min: 1, max: 90 }) || 15;
    rows = await db.query(
      `update agt.requests set status = 'held', fee = round(amount * $2 / 100, 2), decided_at = now()
        where id = $1 and kind = 'withdraw' and status = 'pending'
        returning kind`,
      [id, pct],
    );
  } else {
    throw new HttpError(400, 'คำสั่งไม่ถูกต้อง');
  }
  if (!rows.length) throw new HttpError(409, 'คำขอนี้ถูกจัดการไปแล้ว หรือทำแบบนี้ไม่ได้');
  return { ok: true };
}

async function settings(s = {}) {
  const db = await getDb();
  const cur = await room(db);
  const autoDeposit = s.autoDeposit === undefined ? cur.auto_deposit : !!s.autoDeposit;
  const autoTaxPct = s.autoTaxPct === undefined ? num(cur.auto_tax_pct) : money(s.autoTaxPct, { min: 0, max: 90 });
  const startBank = s.startBank === undefined ? num(cur.start_bank) : money(s.startBank, { min: 0, max: 1e7 });
  await db.query(
    'update agt.room set auto_deposit = $1, auto_tax_pct = $2, start_bank = $3 where id = 1',
    [autoDeposit, autoTaxPct, startBank],
  );
  return { ok: true, settings: { autoDeposit, autoTaxPct, startBank } };
}

async function broadcast(type, data = {}) {
  if (!EVENT_TYPES.has(type)) throw new HttpError(400, 'ชนิด event ไม่ถูกต้อง');
  const payload = {};
  if (type === 'pump') payload.pct = Math.max(0.01, Math.min(1, Number(data.pct) || 0.2));
  if (type === 'notice') {
    payload.title = cleanText(data.title, 60) || 'ประกาศจากระบบ';
    payload.text = cleanText(data.text, 300);
    if (!payload.text) throw new HttpError(400, 'ใส่ข้อความก่อนส่ง');
  }
  const db = await getDb();
  const [ev] = await db.query(
    `with s as (update agt.room set evseq = evseq + 1 where id = 1 returning evseq)
     insert into agt.events (seq, type, data) select evseq, $1, $2::jsonb from s
     returning seq`,
    [type, JSON.stringify(payload)],
  );
  await db.query('delete from agt.events where seq < $1', [ev.seq - 50]);
  return { seq: ev.seq, type, ...payload };
}

async function reset() {
  const db = await getDb();
  const epoch = rid();
  await db.query('delete from agt.players'); // requests cascade
  await db.query('delete from agt.events');
  await db.query('update agt.room set epoch = $1, credit_all = 0 where id = 1', [epoch]);
  return { ok: true, epoch };
}

async function status() {
  try {
    const db = await getDb();
    await db.query('select 1 from agt.room');
    return { ok: true, store: db.kind };
  } catch (err) {
    if (err.expose) throw err;
    console.error(err);
    throw new HttpError(503, `เชื่อมต่อฐานข้อมูลไม่ได้: ${err.message}`);
  }
}

/* ------------------------------------------------------------ admin auth */

const TOKEN_TTL = 12 * 3600 * 1000;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const adminUser = () => process.env.ADMIN_USER || 'admin';
const adminPass = () => process.env.ADMIN_PASSWORD || '';
const signKey = () => digest(`agt-admin:${process.env.ADMIN_SECRET || ''}:${adminPass()}`);
const sign = (msg) => crypto.createHmac('sha256', signKey()).update(msg).digest('base64url');

async function adminLogin(user, pass, ip) {
  if (!adminPass()) throw new HttpError(503, 'ยังไม่ได้ตั้งรหัสผู้บรรยาย (ADMIN_PASSWORD) บนเซิร์ฟเวอร์');
  const key = `a:${String(ip || 'unknown').slice(0, 64)}`;
  const db = await getDb();
  await failGate(db, key, ADMIN_MAX_FAILS);
  const ok = safeEq(String(user ?? '').toLowerCase(), adminUser().toLowerCase()) & safeEq(pass ?? '', adminPass());
  if (!ok) {
    await recordFail(db, key);
    throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  const exp = String(Date.now() + TOKEN_TTL);
  return { token: `${exp}.${sign(exp)}`, expiresAt: Number(exp) };
}

function verifyToken(token) {
  if (!adminPass()) return false;
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEq(sig, sign(exp));
}

module.exports = {
  HttpError,
  status,
  signup,
  login,
  session,
  sync,
  deposit,
  withdraw,
  payTax,
  chatPost,
  overview,
  grant,
  thread,
  reply,
  setBot,
  credit,
  decide,
  settings,
  broadcast,
  reset,
  adminLogin,
  verifyToken,
};
