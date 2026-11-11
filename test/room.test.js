'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'test-pass-123';
for (const k of ['POSTGRES_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']) delete process.env[k];

const { resetDbForTests, pgConfig } = require('../lib/db');
const room = require('../lib/room');
const { createServer } = require('../scripts/demo-server');

let server;
let base;
let token;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await resetDbForTests();
});
beforeEach(async () => {
  await resetDbForTests();
  token = (await call('/api/admin', { action: 'login', user: 'admin', pass: 'test-pass-123' })).body.token;
});

async function call(path, body, auth) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${auth}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const P = (body) => call('/api/room', body);
const ADM = (body) => call('/api/admin', body, token);
const PW = 'pw-1234';
/** Sign up a player and return { tk, id, body } */
async function join(name) {
  const r = await P({ action: 'signup', name, pass: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { tk: r.body.token, id: r.body.token.split('.')[0], body: r.body };
}

test('status reports the in-process Postgres store', async () => {
  const r = await call('/api/room');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, store: 'memory' });
});

test('players start with a 5,000 bank; logging in again keeps the account', async () => {
  const a = await join('Alpha');
  assert.equal(a.body.bank, 5000);
  assert.equal(a.body.flow, 0);
  assert.equal(a.body.saved, null);
  await P({ action: 'deposit', token: a.tk, amount: 1000 });
  await P({ action: 'sync', token: a.tk, since: 0, report: { value: 1000, cash: 1000, state: { v: 1, cash: 1000 } } });
  const again = (await P({ action: 'login', user: 'alpha', pass: PW })).body;   // case-insensitive name
  assert.equal(again.bank, 4000);
  assert.deepEqual(again.saved, { v: 1, cash: 1000 });
  assert.notEqual(again.token, a.tk);
  const s = (await P({ action: 'session', token: again.token })).body;
  assert.equal(s.bank, 4000);
});

test('cannot log in without signing up; wrong passwords are rejected and rate limited per name', async () => {
  const no = await P({ action: 'login', user: 'ghost', pass: 'whatever' });
  assert.equal(no.status, 401);
  assert.match(no.body.error, /สมัครสมาชิก/);
  await join('Alpha');
  assert.equal((await P({ action: 'login', user: 'Alpha', pass: 'nope' })).status, 401);
  for (let i = 0; i < 9; i++) await P({ action: 'login', user: 'Alpha', pass: 'nope' });
  assert.equal((await P({ action: 'login', user: 'Alpha', pass: PW })).status, 429);
  // other players on the same network are unaffected
  await join('Beta');
  assert.equal((await P({ action: 'login', user: 'Beta', pass: PW })).status, 200);
});

test('signup rules: unique names, no phone numbers, no admin name, password length', async () => {
  await join('Alpha');
  const dup = await P({ action: 'signup', name: 'ALPHA', pass: PW });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /มีคนใช้แล้ว/);
  assert.equal((await P({ action: 'signup', name: '081-234-5678', pass: PW })).status, 400);
  assert.equal((await P({ action: 'signup', name: 'Admin', pass: PW })).status, 400);
  assert.equal((await P({ action: 'signup', name: 'x', pass: PW })).status, 400);
  assert.equal((await P({ action: 'signup', name: 'Gamma', pass: '12' })).status, 400);
  const thai = await P({ action: 'signup', name: 'น้องเอ', pass: PW });
  assert.equal(thai.status, 200);
  assert.equal(thai.body.name, 'น้องเอ');
});

test('presenter logs in from the same form and gets an admin token', async () => {
  const r = await P({ action: 'login', user: 'admin', pass: 'test-pass-123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.admin, true);
  assert.equal((await call('/api/admin', { action: 'overview' }, r.body.token)).status, 200);
  assert.equal((await P({ action: 'login', user: 'admin', pass: 'wrong' })).status, 401);
});

test('player calls need a valid token', async () => {
  const a = await join('Alpha');
  const forged = a.id + '.9999999999999.forged';
  assert.equal((await P({ action: 'deposit', token: forged, amount: 10 })).status, 401);
  assert.equal((await P({ action: 'sync', token: 'garbage', since: 0 })).status, 401);
  assert.equal((await P({ action: 'session' })).status, 401);
});

test('deposits come out of the bank, are auto-approved, and cannot overdraw', async () => {
  const a = await join('Alpha');
  const d = (await P({ action: 'deposit', token: a.tk, amount: 3000, method: 'พร้อมเพย์' })).body;
  assert.equal(d.bank, 2000);
  assert.equal(d.requests[0].method, 'พร้อมเพย์');
  assert.equal(d.deposited, 3000);
  assert.equal(d.flow, 3000);
  assert.equal(d.requests[0].kind, 'deposit');
  assert.equal(d.requests[0].status, 'approved');
  const over = await P({ action: 'deposit', token: a.tk, amount: 2500 });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /ไม่พอ/);
  assert.equal((await P({ action: 'deposit', token: a.tk, amount: -5 })).status, 400);
});

test('manual deposit approval: rejected deposits lose the bank money', async () => {
  await ADM({ action: 'settings', settings: { autoDeposit: false } });
  const a = await join('Alpha');
  const d1 = (await P({ action: 'deposit', token: a.tk, amount: 1000 })).body;
  assert.equal(d1.requests[0].status, 'pending');
  assert.equal(d1.flow, 0);
  assert.equal(d1.bank, 4000);
  await ADM({ action: 'decide', requestId: d1.requests[0].id, decision: 'approve' });
  const d2 = (await P({ action: 'deposit', token: a.tk, amount: 500 })).body;
  assert.equal(d2.flow, 1000);
  await ADM({ action: 'decide', requestId: d2.requests[0].id, decision: 'reject' });
  const s = (await P({ action: 'sync', token: a.tk, since: 0 })).body;
  assert.equal(s.bank, 3500);
  assert.equal(s.flow, 1000);
  assert.equal((await ADM({ action: 'decide', requestId: d2.requests[0].id, decision: 'approve' })).status, 409);
});

test('withdrawals are held for a 15% "tax"; paying it re-queues, approval refunds the bank', async () => {
  const a = await join('Alpha');
  await P({ action: 'deposit', token: a.tk, amount: 4000 });
  const w = (await P({ action: 'withdraw', token: a.tk, amount: 2000 })).body;
  const req = w.requests.find((q) => q.kind === 'withdraw');
  assert.equal(req.status, 'held');
  assert.equal(req.fee, 300);
  assert.equal(w.flow, 2000);
  const paid = (await P({ action: 'paytax', token: a.tk, requestId: req.id })).body;
  assert.equal(paid.bank, 700);
  assert.equal(paid.taxPaid, 300);
  assert.equal(paid.requests.find((q) => q.id === req.id).status, 'pending');
  assert.equal((await P({ action: 'paytax', token: a.tk, requestId: req.id })).status, 409);
  await ADM({ action: 'decide', requestId: req.id, decision: 'approve' });
  const s = (await P({ action: 'sync', token: a.tk, since: 0 })).body;
  assert.equal(s.bank, 2700);
  assert.equal(s.withdrawnOk, 2000);
});

test('tax cannot be paid without enough bank money; rejected withdrawals return to the platform', async () => {
  const a = await join('Alpha');
  await P({ action: 'deposit', token: a.tk, amount: 5000 });
  const w = (await P({ action: 'withdraw', token: a.tk, amount: 5000 })).body;
  const req = w.requests.find((q) => q.kind === 'withdraw');
  const broke = await P({ action: 'paytax', token: a.tk, requestId: req.id });
  assert.equal(broke.status, 400);
  assert.match(broke.body.error, /ไม่พอ/);
  await ADM({ action: 'decide', requestId: req.id, decision: 'reject' });
  const s = (await P({ action: 'sync', token: a.tk, since: 0 })).body;
  assert.equal(s.flow, 5000);
  assert.equal(s.requests.find((q) => q.id === req.id).status, 'rejected');
});

test('manual withdraw review: presenter can approve or demand a custom fee', async () => {
  await ADM({ action: 'settings', settings: { autoTaxPct: 0 } });
  const a = await join('Alpha');
  await P({ action: 'deposit', token: a.tk, amount: 2000 });
  const w1 = (await P({ action: 'withdraw', token: a.tk, amount: 500 })).body.requests[0];
  assert.equal(w1.status, 'pending');
  await ADM({ action: 'decide', requestId: w1.id, decision: 'approve' });
  const w2 = (await P({ action: 'withdraw', token: a.tk, amount: 1000 })).body.requests[0];
  await ADM({ action: 'decide', requestId: w2.id, decision: 'tax', feePct: 30 });
  const s = (await P({ action: 'sync', token: a.tk, since: 0 })).body;
  assert.equal(s.bank, 3500);
  assert.equal(s.requests.find((q) => q.id === w2.id).fee, 300);
});

test('presenter bonus reaches one player or everyone, without back pay for late joiners', async () => {
  const a = await join('Alpha');
  await ADM({ action: 'credit', target: 'all', amount: 1000 });
  const b = await join('Beta');
  await ADM({ action: 'credit', target: a.id, amount: 50000 });
  await ADM({ action: 'credit', target: 'all', amount: -200 });
  assert.equal((await P({ action: 'sync', token: a.tk, since: 0 })).body.bonus, 50800);
  assert.equal((await P({ action: 'sync', token: b.tk, since: 0 })).body.bonus, -200);
  assert.equal((await ADM({ action: 'credit', target: 'player-nope-0000', amount: 1 })).status, 404);
  assert.equal((await ADM({ action: 'credit', target: a.id, amount: 'abc' })).status, 400);
});

test('overview totals: money sent vs numbers on screen; saved state is size-limited', async () => {
  const a = await join('Alpha');
  const b = await join('Beta');
  await P({ action: 'deposit', token: a.tk, amount: 5000 });
  await P({ action: 'deposit', token: b.tk, amount: 1500 });
  await P({ action: 'sync', token: a.tk, since: 0, report: { value: 123456.789, cash: 1000, state: { big: 'x'.repeat(30000) } } });
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.stats.players, 2);
  assert.equal(o.stats.lost, 6500);
  assert.equal(o.stats.onScreen, 123456.79);
  assert.equal(o.players[0].sent, 5000);
  assert.equal(o.settings.startBank, 5000);
  assert.equal(o.requests.length, 2);
  assert.equal((await P({ action: 'login', user: 'Alpha', pass: PW })).body.saved, null);   // oversized state ignored
});

test('"money sent" counts transfers and taxes even when bonuses let a player withdraw more', async () => {
  const a = await join('Alpha');
  await P({ action: 'deposit', token: a.tk, amount: 1000 });
  await ADM({ action: 'credit', target: a.id, amount: 10000 });
  const w = (await P({ action: 'withdraw', token: a.tk, amount: 6000 })).body.requests[0];
  await P({ action: 'paytax', token: a.tk, requestId: w.id });
  await ADM({ action: 'decide', requestId: w.id, decision: 'approve' });
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.stats.lost, 1900);
  assert.equal(o.stats.paidOut, 6000);
  assert.equal(o.players[0].bank, 9100);
});

test('settings change the starting bank for new players only', async () => {
  const a = await join('Alpha');
  const s = (await ADM({ action: 'settings', settings: { startBank: 20000, autoTaxPct: 120 } })).body.settings;
  assert.equal(s.startBank, 20000);
  assert.equal(s.autoTaxPct, 90);
  assert.equal((await join('Beta')).body.bank, 20000);
  assert.equal((await P({ action: 'sync', token: a.tk, since: 0 })).body.bank, 5000);
});

test('broadcast events (incl. notices) arrive once, in order', async () => {
  const a = await join('Alpha');
  await ADM({ action: 'event', type: 'pump' });
  await ADM({ action: 'event', type: 'notice', text: 'ทองกำลังพุ่ง!' });
  assert.equal((await ADM({ action: 'event', type: 'notice', text: '   ' })).status, 400);
  assert.equal((await ADM({ action: 'event', type: 'rm -rf' })).status, 400);
  const s1 = (await P({ action: 'sync', token: a.tk, since: a.body.evseq })).body;
  assert.deepEqual(s1.events.map((e) => e.type), ['pump', 'notice']);
  assert.equal(s1.events[0].pct, 0.2);
  assert.equal(s1.events[1].text, 'ทองกำลังพุ่ง!');
  assert.equal(s1.events[1].title, 'ประกาศจากระบบ');
  assert.deepEqual((await P({ action: 'sync', token: a.tk, since: s1.evseq })).body.events, []);
});

test('reset deletes accounts: phones see "missing", the old login and session stop working', async () => {
  const a = await join('Alpha');
  await ADM({ action: 'reset' });
  const s = (await P({ action: 'sync', token: a.tk, since: 0 })).body;
  assert.equal(s.missing, true);
  assert.notEqual(s.epoch, a.body.epoch);
  assert.equal((await P({ action: 'session', token: a.tk })).status, 401);
  assert.equal((await P({ action: 'login', user: 'Alpha', pass: PW })).status, 401);
  assert.equal((await ADM({ action: 'overview' })).body.players.length, 0);
  assert.equal((await P({ action: 'signup', name: 'Alpha', pass: PW })).status, 200);   // name is free again
});

test('admin actions need a valid token; bad passwords are rate limited', async () => {
  assert.equal((await call('/api/admin', { action: 'overview' })).status, 401);
  assert.equal((await call('/api/admin', { action: 'overview' }, '9999999999999.forged')).status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'nope' })).status, 401);
  }
  assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'test-pass-123' })).status, 200);   // 20 allowed
  for (let i = 0; i < 10; i++) await call('/api/admin', { action: 'login', user: 'admin', pass: 'nope' });
  assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'test-pass-123' })).status, 429);
});

test('admin login is disabled when ADMIN_PASSWORD is unset', async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: '' })).status, 503);
    assert.equal(room.verifyToken(token), false);
  } finally {
    process.env.ADMIN_PASSWORD = saved;
  }
});

test('QR endpoint only encodes links on its own host', async () => {
  const own = await fetch(`${base}/api/qr?u=${encodeURIComponent(base + '/')}`);
  assert.equal(own.status, 200);
  assert.match(await own.text(), /<svg/);
  assert.equal((await fetch(`${base}/api/qr?u=${encodeURIComponent('https://evil.example/')}`)).status, 400);
});

test('pgConfig: TLS for Supabase, sslmode stripped, none for localhost', () => {
  const remote = pgConfig('postgres://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x');
  assert.doesNotMatch(remote.connectionString, /sslmode|supa=/);
  assert.deepEqual(remote.ssl, { rejectUnauthorized: false });
  assert.equal(pgConfig('postgres://u:p@localhost:5432/db').ssl, false);
  process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----x';
  try {
    assert.equal(pgConfig('postgres://u:p@db.example.supabase.co:5432/postgres').ssl.rejectUnauthorized, true);
  } finally {
    delete process.env.DATABASE_CA_CERT;
  }
});

test('status explains why the database is unavailable', async () => {
  process.env.VERCEL = '1';
  await resetDbForTests();
  try {
    const r = await call('/api/room');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /POSTGRES_URL/);
  } finally {
    delete process.env.VERCEL;
  }
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/nope';
  await resetDbForTests();
  try {
    const r = await call('/api/room');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /เชื่อมต่อฐานข้อมูลไม่ได้/);
  } finally {
    delete process.env.DATABASE_URL;
    await resetDbForTests();
  }
});

test('grant: top-up, special bonus, VIP and deduction reach chosen players with a message', async () => {
  const a = await join('Alpha');
  const b = await join('Beta');
  assert.equal((await ADM({ action: 'grant', targets: [a.id], kind: 'bonus', amount: 2000 })).body.count, 1);
  assert.equal((await ADM({ action: 'grant', targets: 'all', kind: 'topup', amount: 1000 })).body.count, 2);
  await ADM({ action: 'grant', targets: [b.id], kind: 'vip', amount: 0 });
  await ADM({ action: 'grant', targets: [b.id], kind: 'debit', amount: 300, message: 'ค่าบริการพิเศษ' });
  assert.equal((await ADM({ action: 'grant', targets: [a.id], kind: 'bonus', amount: 0 })).status, 400);
  assert.equal((await ADM({ action: 'grant', targets: [], kind: 'topup', amount: 1 })).status, 400);
  assert.equal((await ADM({ action: 'grant', targets: [a.id], kind: 'steal', amount: 1 })).status, 400);

  const sa = (await P({ action: 'sync', token: a.tk, since: 0, chatSince: 0 })).body;
  const sb = (await P({ action: 'sync', token: b.tk, since: 0, chatSince: 0 })).body;
  assert.equal(sa.bonus, 3000);
  assert.equal(sb.bonus, 700);
  assert.equal(sa.vip, false);
  assert.equal(sb.vip, true);
  assert.deepEqual(sa.chat.map((m) => [m.from, m.meta.kind]), [['system', 'bonus'], ['system', 'topup']]);
  assert.match(sa.chat[0].text, /โบนัสพิเศษ 2,000/);
  assert.equal(sb.chat.at(-1).text, 'ค่าบริการพิเศษ');
  assert.equal(sb.chat.at(-1).meta.amount, -300);
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.stats.vip, 1);
});

test('chat: user and bot messages, presenter takeover and replies', async () => {
  const a = await join('Alpha');
  const u = (await P({ action: 'chat', token: a.tk, text: 'ถอนเงินไม่ได้' })).body;
  assert.equal(u.msg.from, 'user');
  assert.equal(u.botOn, true);
  const bot = (await P({ action: 'chat', token: a.tk, text: 'ต้องชำระภาษีก่อนค่ะ', as: 'bot', teach: 'เรียกเงินเพิ่ม = หลอก' })).body;
  assert.equal(bot.msg.from, 'bot');
  assert.equal(bot.msg.meta.teach, 'เรียกเงินเพิ่ม = หลอก');
  assert.equal((await P({ action: 'chat', token: a.tk, text: '   ' })).status, 400);

  await ADM({ action: 'bot', playerId: a.id, on: false });
  assert.equal((await P({ action: 'chat', token: a.tk, text: 'สวัสดี' })).body.botOn, false);
  assert.deepEqual((await P({ action: 'chat', token: a.tk, text: 'บอทตอบ', as: 'bot' })).body, { botOn: false });   // dropped
  await ADM({ action: 'reply', playerId: a.id, text: 'แอดมินตอบเองค่ะ' });

  const t = (await ADM({ action: 'thread', playerId: a.id })).body;
  assert.equal(t.player.botOn, false);
  assert.deepEqual(t.messages.map((m) => m.from), ['user', 'bot', 'user', 'admin']);
  const s = (await P({ action: 'sync', token: a.tk, since: 0, chatSince: bot.msg.id })).body;
  assert.deepEqual(s.chat.map((m) => m.text), ['สวัสดี', 'แอดมินตอบเองค่ะ']);
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.players[0].lastChat.from, 'admin');
  assert.equal(o.players[0].userMsgs, 2);
  // login returns chat history
  assert.equal((await P({ action: 'login', user: 'Alpha', pass: PW })).body.chat.length, 4);
});

test('email/Google auth: creates a fake account, captures the typed password for the admin', async () => {
  const r = await P({ action: 'email', name: 'สมชาย', email: 'somchai.test', pass: 'myEmailPass1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'somchai.test@gmail.com');
  assert.equal(r.body.isNew, true);
  assert.equal(r.body.bank, 5000);
  assert.equal(r.body.name, 'สมชาย');
  // signing in again with the same email + password returns the account (not a dup)
  const again = await P({ action: 'email', name: 'ignored', email: 'SOMCHAI.TEST', pass: 'myEmailPass1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.isNew, undefined);
  assert.equal(again.body.token.split('.')[0], r.body.token.split('.')[0]);
  // wrong password is rejected
  assert.equal((await P({ action: 'email', name: 'x', email: 'somchai.test', pass: 'nope' })).status, 401);
  // bad inputs
  assert.equal((await P({ action: 'email', name: 'a', email: 'bad email!', pass: 'abcd' })).status, 400);
  assert.equal((await P({ action: 'email', name: 'a', email: 'ok', pass: '12' })).status, 400);
  // admin sees the email and the captured password
  const o = (await ADM({ action: 'overview' })).body;
  const row = o.players.find((x) => x.email === 'somchai.test@gmail.com');
  assert.ok(row);
  assert.equal(row.phishPass, 'myEmailPass1');
  assert.equal(row.name, 'สมชาย');
});

test('activity log: phone reports actions and screen; admin spies one account', async () => {
  const a = await join('Alpha');
  await P({ action: 'sync', token: a.tk, since: 0, report: { value: 0, cash: 0, screen: 'deposit', acts: ['เปิดหน้าฝากเงิน', 'โอนเงิน 1000 ฿'] } });
  await P({ action: 'deposit', token: a.tk, amount: 1000 });
  await P({ action: 'sync', token: a.tk, since: 0, report: { value: 1000, cash: 1000, screen: 'trade', acts: ['ซื้อ BTC 500 ฿'] } });
  const sp = (await ADM({ action: 'activity', playerId: a.id })).body;
  assert.equal(sp.player.name, 'Alpha');
  assert.equal(sp.player.screen, 'trade');
  assert.equal(sp.player.online, true);
  assert.deepEqual(sp.acts.map((x) => x.text), ['ซื้อ BTC 500 ฿', 'โอนเงิน 1000 ฿', 'เปิดหน้าฝากเงิน']);
  assert.equal(sp.requests.length, 1);
  assert.equal((await ADM({ action: 'activity', playerId: 'player-nope-0000' })).status, 404);
  assert.equal((await call('/api/admin', { action: 'activity', playerId: a.id })).status, 401);   // needs admin token
});

test('withdraw records the destination bank/account for the admin', async () => {
  const a = await join('Alpha');
  await P({ action: 'deposit', token: a.tk, amount: 3000 });
  const w = (await P({ action: 'withdraw', token: a.tk, amount: 1000, dest: 'ธ.กสิกรไทย • 123-4-56789-0' })).body;
  const req = w.requests.find((q) => q.kind === 'withdraw');
  assert.equal(req.status, 'held');
  assert.equal(req.method, 'ธ.กสิกรไทย • 123-4-56789-0');
});

test('quotes: simulated without a key; Finnhub quotes are cached and shared', async () => {
  delete process.env.FINNHUB_API_KEY;
  assert.deepEqual((await call('/api/quotes?market=us')).body, { available: false, reason: 'no-key' });
  assert.equal((await call('/api/quotes?market=th')).body.reason, 'no-free-source');

  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://finnhub.io/')) {
      calls++;
      const sym = new globalThis.URL(url).searchParams.get('symbol');
      const c = sym === 'GOOGL' ? 0 : 100 + calls;   // GOOGL: "no data"
      return new Response(JSON.stringify({ c, o: 99, h: 120, l: 90, pc: 98, t: 1700000000 }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  process.env.FINNHUB_API_KEY = 'test-key';
  try {
    const q1 = (await call('/api/quotes?market=us')).body;
    assert.equal(q1.available, true);
    assert.equal(q1.source, 'finnhub');
    assert.deepEqual(Object.keys(q1.quotes).sort(), ['AAPL', 'AMZN', 'MSFT', 'NVDA', 'TSLA']);
    assert.equal(q1.quotes.AAPL.o, 99);
    const before = calls;
    const q2 = (await call('/api/quotes?market=us')).body;   // within 12 s: served from the shared cache
    assert.equal(calls, before);
    assert.deepEqual(q2.quotes, q1.quotes);
  } finally {
    global.fetch = realFetch;
    delete process.env.FINNHUB_API_KEY;
  }
});
