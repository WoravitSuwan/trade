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
const A = 'player-aaaa-1111';
const B = 'player-bbbb-2222';

test('status reports the in-process Postgres store', async () => {
  const r = await call('/api/room');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, store: 'memory' });
});

test('players start with a 5,000 bank and an empty platform balance', async () => {
  const j = (await P({ action: 'join', id: A, name: 'Alpha' })).body;
  assert.equal(j.bank, 5000);
  assert.equal(j.flow, 0);
  assert.ok(j.epoch);
  // re-joining (reload) keeps the bank
  await P({ action: 'deposit', id: A, amount: 1000 });
  const again = (await P({ action: 'join', id: A, name: 'Alpha' })).body;
  assert.equal(again.bank, 4000);
});

test('deposits come out of the bank, are auto-approved, and cannot overdraw', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  const d = (await P({ action: 'deposit', id: A, amount: 3000 })).body;
  assert.equal(d.bank, 2000);
  assert.equal(d.deposited, 3000);
  assert.equal(d.flow, 3000);
  assert.equal(d.requests[0].kind, 'deposit');
  assert.equal(d.requests[0].status, 'approved');

  const over = await P({ action: 'deposit', id: A, amount: 2500 });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /ไม่พอ/);
  assert.equal((await P({ action: 'deposit', id: A, amount: -5 })).status, 400);
});

test('manual deposit approval: rejected deposits lose the bank money', async () => {
  await ADM({ action: 'settings', settings: { autoDeposit: false } });
  await P({ action: 'join', id: A, name: 'Alpha' });
  const d1 = (await P({ action: 'deposit', id: A, amount: 1000 })).body;
  assert.equal(d1.requests[0].status, 'pending');
  assert.equal(d1.flow, 0);
  assert.equal(d1.bank, 4000);

  await ADM({ action: 'decide', requestId: d1.requests[0].id, decision: 'approve' });
  const d2 = (await P({ action: 'deposit', id: A, amount: 500 })).body;
  assert.equal(d2.flow, 1000);

  await ADM({ action: 'decide', requestId: d2.requests[0].id, decision: 'reject' });
  const s = (await P({ action: 'sync', id: A, since: 0 })).body;
  assert.equal(s.bank, 3500);         // 500 left the bank...
  assert.equal(s.flow, 1000);         // ...and never arrived
  assert.equal((await ADM({ action: 'decide', requestId: d2.requests[0].id, decision: 'approve' })).status, 409);
});

test('withdrawals are held for a 15% "tax"; paying it re-queues, approval refunds the bank', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  await P({ action: 'deposit', id: A, amount: 4000 });
  const w = (await P({ action: 'withdraw', id: A, amount: 2000 })).body;
  const req = w.requests.find((q) => q.kind === 'withdraw');
  assert.equal(req.status, 'held');
  assert.equal(req.fee, 300);
  assert.equal(w.flow, 2000);          // frozen amount leaves the platform balance

  const paid = (await P({ action: 'paytax', id: A, requestId: req.id })).body;
  assert.equal(paid.bank, 700);        // 1000 left after deposit, minus 300 tax
  assert.equal(paid.taxPaid, 300);
  assert.equal(paid.requests.find((q) => q.id === req.id).status, 'pending');
  assert.equal((await P({ action: 'paytax', id: A, requestId: req.id })).status, 409);

  await ADM({ action: 'decide', requestId: req.id, decision: 'approve' });
  const s = (await P({ action: 'sync', id: A, since: 0 })).body;
  assert.equal(s.bank, 2700);
  assert.equal(s.withdrawnOk, 2000);
});

test('tax cannot be paid without enough bank money; rejected withdrawals return to the platform', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  await P({ action: 'deposit', id: A, amount: 5000 });   // bank now 0
  const w = (await P({ action: 'withdraw', id: A, amount: 5000 })).body;
  const req = w.requests.find((q) => q.kind === 'withdraw');
  const broke = await P({ action: 'paytax', id: A, requestId: req.id });
  assert.equal(broke.status, 400);
  assert.match(broke.body.error, /ไม่พอ/);

  await ADM({ action: 'decide', requestId: req.id, decision: 'reject' });
  const s = (await P({ action: 'sync', id: A, since: 0 })).body;
  assert.equal(s.flow, 5000);
  assert.equal(s.requests.find((q) => q.id === req.id).status, 'rejected');
});

test('manual withdraw review: presenter can approve or demand a custom fee', async () => {
  await ADM({ action: 'settings', settings: { autoTaxPct: 0 } });
  await P({ action: 'join', id: A, name: 'Alpha' });
  await P({ action: 'deposit', id: A, amount: 2000 });
  const w1 = (await P({ action: 'withdraw', id: A, amount: 500 })).body.requests[0];
  assert.equal(w1.status, 'pending');
  await ADM({ action: 'decide', requestId: w1.id, decision: 'approve' });   // small withdrawal works: builds trust

  const w2 = (await P({ action: 'withdraw', id: A, amount: 1000 })).body.requests[0];
  await ADM({ action: 'decide', requestId: w2.id, decision: 'tax', feePct: 30 });
  const s = (await P({ action: 'sync', id: A, since: 0 })).body;
  assert.equal(s.bank, 3500);
  assert.equal(s.requests.find((q) => q.id === w2.id).fee, 300);
});

test('presenter bonus reaches one player or everyone, without back pay for late joiners', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  await ADM({ action: 'credit', target: 'all', amount: 1000 });
  await P({ action: 'join', id: B, name: 'Beta' });
  await ADM({ action: 'credit', target: A, amount: 50000 });
  await ADM({ action: 'credit', target: 'all', amount: -200 });

  assert.equal((await P({ action: 'sync', id: A, since: 0 })).body.bonus, 50800);
  assert.equal((await P({ action: 'sync', id: B, since: 0 })).body.bonus, -200);
  assert.equal((await ADM({ action: 'credit', target: 'player-nope-0000', amount: 1 })).status, 404);
  assert.equal((await ADM({ action: 'credit', target: A, amount: 'abc' })).status, 400);
});

test('overview totals: money lost vs numbers on screen', async () => {
  await P({ action: 'join', id: A, name: '<b>Alpha</b>\u0000' });
  await P({ action: 'join', id: B, name: 'Beta' });
  await P({ action: 'deposit', id: A, amount: 5000 });
  await P({ action: 'deposit', id: B, amount: 1500 });
  await P({ action: 'sync', id: A, since: 0, report: { value: 123456.789, cash: 1000 } });
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.stats.players, 2);
  assert.equal(o.stats.lost, 6500);
  assert.equal(o.players[0].sent, 5000);
  assert.equal(o.stats.onScreen, 123456.79);
  assert.equal(o.players[0].name, 'bAlpha/b');
  assert.equal(o.settings.startBank, 5000);
  assert.equal(o.requests.length, 2);
  assert.equal(o.requests[0].player === 'Beta' || o.requests[0].player === 'bAlpha/b', true);
});

test('"money sent" counts transfers and taxes even when bonuses let a player withdraw more', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  await P({ action: 'deposit', id: A, amount: 1000 });
  await ADM({ action: 'credit', target: A, amount: 10000 });
  const w = (await P({ action: 'withdraw', id: A, amount: 6000 })).body.requests[0];
  await P({ action: 'paytax', id: A, requestId: w.id });           // 900 tax
  await ADM({ action: 'decide', requestId: w.id, decision: 'approve' });
  const o = (await ADM({ action: 'overview' })).body;
  assert.equal(o.stats.lost, 1900);
  assert.equal(o.stats.paidOut, 6000);
  assert.equal(o.players[0].bank, 9100);
});

test('leave removes the player (presenter device leaves the audience list)', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  assert.equal((await P({ action: 'leave', id: A })).status, 200);
  assert.equal((await ADM({ action: 'overview' })).body.players.length, 0);
  assert.equal((await P({ action: 'sync', id: A, since: 0 })).body.missing, true);
});

test('settings change the starting bank for new players only', async () => {
  await P({ action: 'join', id: A, name: 'Alpha' });
  const s = (await ADM({ action: 'settings', settings: { startBank: 20000, autoTaxPct: 120 } })).body.settings;
  assert.equal(s.startBank, 20000);
  assert.equal(s.autoTaxPct, 90);   // clamped
  assert.equal((await P({ action: 'join', id: B, name: 'Beta' })).body.bank, 20000);
  assert.equal((await P({ action: 'sync', id: A, since: 0 })).body.bank, 5000);
});

test('broadcast events (incl. notices) arrive once, in order', async () => {
  const j = (await P({ action: 'join', id: A, name: 'Alpha' })).body;
  await ADM({ action: 'event', type: 'pump' });
  await ADM({ action: 'event', type: 'notice', text: 'ทองกำลังพุ่ง!' });
  assert.equal((await ADM({ action: 'event', type: 'notice', text: '   ' })).status, 400);
  assert.equal((await ADM({ action: 'event', type: 'rm -rf' })).status, 400);

  const s1 = (await P({ action: 'sync', id: A, since: j.evseq })).body;
  assert.deepEqual(s1.events.map((e) => e.type), ['pump', 'notice']);
  assert.equal(s1.events[0].pct, 0.2);
  assert.equal(s1.events[1].text, 'ทองกำลังพุ่ง!');
  assert.equal(s1.events[1].title, 'ประกาศจากระบบ');
  assert.deepEqual((await P({ action: 'sync', id: A, since: s1.evseq })).body.events, []);
});

test('reset changes the epoch and removes players; their phones see "missing"', async () => {
  const j = (await P({ action: 'join', id: A, name: 'Alpha' })).body;
  await ADM({ action: 'reset' });
  const s = (await P({ action: 'sync', id: A, since: 0 })).body;
  assert.equal(s.missing, true);
  assert.notEqual(s.epoch, j.epoch);
  assert.equal((await ADM({ action: 'overview' })).body.players.length, 0);
});

test('admin actions need a valid token; bad passwords are rate limited', async () => {
  assert.equal((await call('/api/admin', { action: 'overview' })).status, 401);
  assert.equal((await call('/api/admin', { action: 'overview' }, '9999999999999.forged')).status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'nope' })).status, 401);
  }
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

test('invalid ids, actions and unknown players are rejected', async () => {
  assert.equal((await P({ action: 'join', id: 'x', name: 'a' })).status, 400);
  assert.equal((await P({ action: 'dance', id: A })).status, 400);
  assert.equal((await P({ action: 'deposit', id: A, amount: 10 })).status, 404);
  assert.equal((await P({ action: 'withdraw', id: A, amount: 10 })).status, 404);
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
