'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, rateLimitMax: 1000 });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

const alice = { username: 'alice', email: 'Alice@Example.com', password: 'secret123', confirmPassword: 'secret123' };

test('register creates a user and logs them in', async () => {
  const res = await post('/api/register', alice);
  assert.equal(res.status, 201);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /sid=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const me = await fetch(base + '/api/me', { headers: { Cookie: cookieOf(res) } });
  assert.equal(me.status, 200);
  const { user } = await me.json();
  assert.equal(user.username, 'alice');
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.password_hash, undefined);
});

test('register rejects duplicate username (case-insensitive) and email', async () => {
  let res = await post('/api/register', { ...alice, username: 'ALICE', email: 'other@example.com' });
  assert.equal(res.status, 409);
  res = await post('/api/register', { ...alice, username: 'alice2', email: 'alice@EXAMPLE.com' });
  assert.equal(res.status, 409);
});

test('register validates input', async () => {
  const cases = [
    { ...alice, username: 'a' },
    { ...alice, username: 'bad name!' },
    { ...alice, username: 'bob', email: 'not-an-email' },
    { ...alice, username: 'bob', email: 'bob@example.com', password: 'short1', confirmPassword: 'short1' },
    { ...alice, username: 'bob', email: 'bob@example.com', password: 'onlyletters', confirmPassword: 'onlyletters' },
    { ...alice, username: 'bob', email: 'bob@example.com', confirmPassword: 'mismatch123' },
    { username: 123, email: [], password: {} },
  ];
  for (const body of cases) {
    const res = await post('/api/register', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
});

test('login works with username or email, rejects bad password', async () => {
  let res = await post('/api/login', { identifier: 'alice', password: 'secret123' });
  assert.equal(res.status, 200);
  assert.ok(cookieOf(res));

  res = await post('/api/login', { identifier: 'ALICE@example.com', password: 'secret123' });
  assert.equal(res.status, 200);

  res = await post('/api/login', { identifier: 'alice', password: 'wrong123' });
  assert.equal(res.status, 401);

  res = await post('/api/login', { identifier: 'nobody', password: 'secret123' });
  assert.equal(res.status, 401);

  res = await post('/api/login', {});
  assert.equal(res.status, 400);
});

test('logout invalidates the session', async () => {
  const login = await post('/api/login', { identifier: 'alice', password: 'secret123' });
  const cookie = cookieOf(login);

  const out = await post('/api/logout', {}, cookie);
  assert.equal(out.status, 200);

  const me = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 401);
});

test('non-JSON POSTs are rejected (CSRF guard)', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'identifier=alice&password=secret123',
  });
  assert.equal(res.status, 415);
});

test('dashboard requires login; login page redirects when logged in', async () => {
  let res = await fetch(base + '/dashboard', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');

  const cookie = cookieOf(await post('/api/login', { identifier: 'alice', password: 'secret123' }));
  res = await fetch(base + '/dashboard', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);

  res = await fetch(base + '/login', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('rate limiter blocks repeated attempts', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, rateLimitMax: 3 });
  const s = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const url = `http://127.0.0.1:${s.address().port}/api/login`;
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"identifier":"x","password":"y"}' };
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(url, opts)).status, 401);
    assert.equal((await fetch(url, opts)).status, 429);
  } finally {
    s.close();
  }
});
