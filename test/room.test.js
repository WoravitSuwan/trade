'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.ADMIN_PASSWORD = 'test-pass-123';
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const room = require('../lib/room');
const { createServer } = require('../scripts/demo-server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => room.setStore(room.memoryStore()));

async function call(path, body, token) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const admin = async () => (await call('/api/admin', { action: 'login', user: 'admin', pass: 'test-pass-123' })).body.token;
const A = 'player-aaaa-1111';
const B = 'player-bbbb-2222';

test('status endpoint reports the store', async () => {
  const r = await call('/api/room');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, store: 'memory' });
});

test('join starts at the current credit so late joiners get no back pay', async () => {
  const token = await admin();
  await call('/api/room', { action: 'join', id: A, name: 'Alpha' });
  await call('/api/admin', { action: 'credit', target: 'all', amount: 5000 }, token);
  const late = await call('/api/room', { action: 'join', id: B, name: 'Beta' });
  assert.equal(late.status, 200);
  assert.equal(late.body.credit, 5000);
  assert.ok(late.body.epoch);
});

test('presenter credit reaches one player or everyone', async () => {
  const token = await admin();
  const j = (await call('/api/room', { action: 'join', id: A, name: 'Alpha' })).body;
  await call('/api/room', { action: 'join', id: B, name: 'Beta' });

  assert.equal((await call('/api/admin', { action: 'credit', target: A, amount: 10000 }, token)).status, 200);
  assert.equal((await call('/api/admin', { action: 'credit', target: 'all', amount: -2500 }, token)).status, 200);

  const sa = (await call('/api/room', { action: 'sync', id: A, since: 0 })).body;
  const sb = (await call('/api/room', { action: 'sync', id: B, since: 0 })).body;
  assert.equal(sa.credit - j.credit, 7500);
  assert.equal(sb.credit, -2500);
  assert.equal(sa.epoch, j.epoch);

  assert.equal((await call('/api/admin', { action: 'credit', target: 'player-nope-0000', amount: 1 }, token)).status, 404);
  assert.equal((await call('/api/admin', { action: 'credit', target: A, amount: 'abc' }, token)).status, 400);
});

test('sync reports balances that the presenter can list', async () => {
  const token = await admin();
  await call('/api/room', { action: 'join', id: A, name: '<b>Alpha</b>\u0000' });
  await call('/api/room', { action: 'sync', id: A, since: 0, report: { value: 123456.789, cash: 1000, deposited: 50000 } });
  const list = (await call('/api/admin', { action: 'players' }, token)).body.players;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'bAlpha/b');
  assert.equal(list[0].value, 123456.79);
  assert.equal(list[0].deposited, 50000);
});

test('broadcast events arrive once, in order', async () => {
  const token = await admin();
  const j = (await call('/api/room', { action: 'join', id: A, name: 'Alpha' })).body;
  await call('/api/admin', { action: 'event', type: 'pump' }, token);
  await call('/api/admin', { action: 'event', type: 'vip' }, token);
  assert.equal((await call('/api/admin', { action: 'event', type: 'rm -rf' }, token)).status, 400);

  const s1 = (await call('/api/room', { action: 'sync', id: A, since: j.evseq })).body;
  assert.deepEqual(s1.events.map((e) => e.type), ['pump', 'vip']);
  assert.equal(s1.events[0].pct, 0.2);
  const s2 = (await call('/api/room', { action: 'sync', id: A, since: s1.evseq })).body;
  assert.deepEqual(s2.events, []);
});

test('reset changes the epoch and clears players and credit', async () => {
  const token = await admin();
  const j = (await call('/api/room', { action: 'join', id: A, name: 'Alpha' })).body;
  await call('/api/admin', { action: 'credit', target: A, amount: 999 }, token);
  await call('/api/admin', { action: 'reset' }, token);
  const s = (await call('/api/room', { action: 'sync', id: A, since: 0 })).body;
  assert.notEqual(s.epoch, j.epoch);
  assert.equal(s.credit, 0);
  assert.equal((await call('/api/admin', { action: 'players' }, token)).body.players.length, 0);
});

test('admin actions need a valid token; bad passwords are rate limited', async () => {
  assert.equal((await call('/api/admin', { action: 'players' })).status, 401);
  assert.equal((await call('/api/admin', { action: 'players' }, '9999999999999.forged')).status, 401);
  assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'nope' })).status, 401);
  for (let i = 0; i < 9; i++) await call('/api/admin', { action: 'login', user: 'admin', pass: 'nope' });
  assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: 'test-pass-123' })).status, 429);
});

test('admin login is disabled when ADMIN_PASSWORD is unset', async () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.equal((await call('/api/admin', { action: 'login', user: 'admin', pass: '' })).status, 503);
    assert.equal(room.verifyToken('anything'), false);
  } finally {
    process.env.ADMIN_PASSWORD = saved;
  }
});

test('invalid ids and actions are rejected', async () => {
  assert.equal((await call('/api/room', { action: 'join', id: 'x', name: 'a' })).status, 400);
  assert.equal((await call('/api/room', { action: 'dance', id: A })).status, 400);
});

test('QR endpoint only encodes links on its own host', async () => {
  const own = await fetch(`${base}/api/qr?u=${encodeURIComponent(base + '/')}`);
  assert.equal(own.status, 200);
  assert.match(own.headers.get('content-type'), /svg/);
  assert.match(await own.text(), /<svg/);
  const other = await fetch(`${base}/api/qr?u=${encodeURIComponent('https://evil.example/')}`);
  assert.equal(other.status, 400);
});

test('Upstash REST client speaks the pipeline protocol', async () => {
  const backing = room.memoryStore();
  let auth;
  const fake = http.createServer(async (req, res) => {
    auth = req.headers.authorization;
    let raw = '';
    for await (const c of req) raw += c;
    assert.equal(req.url, '/pipeline');
    const results = await backing.pipeline(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(results.map((result) => ({ result }))));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    room.setStore(room.upstashStore(`http://127.0.0.1:${fake.address().port}/`, 'tok'));
    const j = await room.join(A, 'Alpha');
    await room.credit(A, 42);
    const s = await room.sync(A, 0, { value: 1 });
    assert.equal(s.credit - j.credit, 42);
    assert.equal(auth, 'Bearer tok');
  } finally {
    fake.close();
  }
});
