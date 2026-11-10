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

/* ------------------------------------------------------------ audience API */

async function join(id, name) {
  checkId(id);
  const db = await getDb();
  await db.query(`delete from agt.players where seen_at < now() - interval '24 hours'`);
  const [{ count, mine }] = await db.query(
    'select count(*)::int as count, bool_or(id = $1) as mine from agt.players',
    [id],
  );
  if (!mine && count >= MAX_PLAYERS) throw new HttpError(409, 'ห้องเต็มแล้ว');
  await db.query(
    `insert into agt.players (id, name, bank, bank_start, all_base)
       select $1, $2, r.start_bank, r.start_bank, r.credit_all from agt.room r where r.id = 1
     on conflict (id) do update set name = excluded.name, seen_at = now()`,
    [id, cleanName(name)],
  );
  return state(db, id, 0);
}

async function state(db, id, since) {
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
  return {
    epoch: p.epoch,
    evseq: p.evseq,
    name: p.name,
    ...playerMoney(p),
    requests: requests.map(reqOut),
    events,
  };
}

async function sync(id, since, report) {
  checkId(id);
  const db = await getDb();
  const [r] = await db.query('select epoch from agt.room where id = 1');
  const [p] = await db.query('select 1 from agt.players where id = $1', [id]);
  if (!p) return { epoch: r.epoch, missing: true };
  if (report && typeof report === 'object') {
    await db.query(
      `update agt.players set value = $2, cash = $3, name = coalesce($4, name), seen_at = now() where id = $1`,
      [id, money(report.value), money(report.cash), report.name === undefined ? null : cleanName(report.name)],
    );
  } else {
    await db.query('update agt.players set seen_at = now() where id = $1', [id]);
  }
  return state(db, id, since);
}

async function deposit(id, amount) {
  checkId(id);
  const amt = positive(amount);
  const db = await getDb();
  const rows = await db.query(
    `with p as (
        update agt.players set bank = bank - $2, seen_at = now()
         where id = $1 and bank >= $2 returning id),
      r as (select auto_deposit from agt.room where id = 1)
     insert into agt.requests (player_id, kind, amount, status, decided_at)
       select p.id, 'deposit', $2,
              case when r.auto_deposit then 'approved' else 'pending' end,
              case when r.auto_deposit then now() end
         from p, r
     returning id`,
    [id, amt],
  );
  if (!rows.length) {
    const [exists] = await db.query('select 1 from agt.players where id = $1', [id]);
    throw exists ? new HttpError(400, 'เงินในบัญชีธนาคารไม่พอ') : new HttpError(404, 'ไม่พบผู้เล่นในห้อง');
  }
  return state(db, id, Number.MAX_SAFE_INTEGER);
}

async function withdraw(id, amount) {
  checkId(id);
  const amt = positive(amount);
  const db = await getDb();
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

async function leave(id) {
  checkId(id);
  const db = await getDb();
  await db.query('delete from agt.players where id = $1', [id]);
  return { ok: true };
}

async function payTax(id, requestId) {
  checkId(id);
  const db = await getDb();
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
    ...playerMoney(p),
  }));
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
  const db = await getDb();
  await db.query('select 1');
  return { ok: true, store: db.kind };
}

/* ------------------------------------------------------------ admin auth */

const TOKEN_TTL = 12 * 3600 * 1000;
const LOGIN_MAX_FAILS = 10;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const adminUser = () => process.env.ADMIN_USER || 'admin';
const adminPass = () => process.env.ADMIN_PASSWORD || '';
const signKey = () => digest(`agt-admin:${process.env.ADMIN_SECRET || ''}:${adminPass()}`);
const sign = (msg) => crypto.createHmac('sha256', signKey()).update(msg).digest('base64url');

async function login(user, pass, ip) {
  if (!adminPass()) throw new HttpError(503, 'ยังไม่ได้ตั้งรหัสผู้บรรยาย (ADMIN_PASSWORD) บนเซิร์ฟเวอร์');
  const key = String(ip || 'unknown').slice(0, 64);
  const db = await getDb();
  const [f] = await db.query('select fails from agt.login_fails where ip = $1 and until > now()', [key]);
  if (f && f.fails >= LOGIN_MAX_FAILS) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที');
  const ok = safeEq(user ?? '', adminUser()) & safeEq(pass ?? '', adminPass());
  if (!ok) {
    await db.query(
      `insert into agt.login_fails (ip, fails, until) values ($1, 1, now() + interval '15 minutes')
       on conflict (ip) do update set
         fails = case when agt.login_fails.until < now() then 1 else agt.login_fails.fails + 1 end,
         until = case when agt.login_fails.until < now() then now() + interval '15 minutes' else agt.login_fails.until end`,
      [key],
    );
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
  join,
  sync,
  deposit,
  withdraw,
  payTax,
  leave,
  overview,
  credit,
  decide,
  settings,
  broadcast,
  reset,
  login,
  verifyToken,
};
