'use strict';

/*
 * Live demo room shared by the presenter and audience phones.
 *
 * State lives in Upstash Redis (REST API) when KV_REST_API_URL / KV_REST_API_TOKEN
 * (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) are set, which is what
 * Vercel's Upstash integration provides. Without them an in-memory store is used,
 * which is fine for local development but not for Vercel (each function
 * instance would have its own memory).
 *
 * Keys (all expire 24h after the last join, so nicknames are not kept around):
 *   agt:room    hash  <playerId> -> credit given to that player by the presenter
 *                     _all       -> credit given to everyone
 *                     _evseq     -> last broadcast event number
 *                     _epoch     -> random id, changes when the presenter resets the room
 *   agt:players hash  <playerId> -> JSON {name, value, cash, deposited, joined, seen}
 *   agt:events  list  newest-first JSON {seq, type, ...}
 */

const crypto = require('node:crypto');

const K = { room: 'agt:room', players: 'agt:players', events: 'agt:events' };
const TTL = 24 * 3600;
const MAX_PLAYERS = 500;
const MAX_EVENTS = 20;
const MAX_AMOUNT = 1e9;
const EVENT_TYPES = new Set(['pump', 'vip', 'flags']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ stores */

/** In-memory subset of Redis that returns values shaped like the Upstash REST API. */
function memoryStore() {
  const data = new Map(); // key -> {v, exp}
  const live = (k) => {
    const e = data.get(k);
    if (e && e.exp && e.exp <= Date.now()) {
      data.delete(k);
      return undefined;
    }
    return e;
  };
  const hash = (k, create) => {
    let e = live(k);
    if (!e && create) data.set(k, (e = { v: new Map(), exp: 0 }));
    return e ? e.v : null;
  };
  const list = (k, create) => {
    let e = live(k);
    if (!e && create) data.set(k, (e = { v: [], exp: 0 }));
    return e ? e.v : null;
  };
  const num = (x) => String(Number(x));

  function exec([cmd, k, ...a]) {
    switch (String(cmd).toUpperCase()) {
      case 'GET': { const e = live(k); return e ? e.v : null; }
      case 'INCR': { const e = live(k); const v = String((e ? Number(e.v) : 0) + 1); data.set(k, { v, exp: e ? e.exp : 0 }); return Number(v); }
      case 'EXPIRE': { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(a[0]) * 1000; return 1; }
      case 'DEL': { let n = 0; for (const key of [k, ...a]) n += data.delete(key) ? 1 : 0; return n; }
      case 'HSET': { const h = hash(k, true); let n = 0; for (let i = 0; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], String(a[i + 1])); } return n; }
      case 'HSETNX': { const h = hash(k, true); if (h.has(a[0])) return 0; h.set(a[0], String(a[1])); return 1; }
      case 'HGET': { const h = hash(k); return h && h.has(a[0]) ? h.get(a[0]) : null; }
      case 'HMGET': { const h = hash(k); return a.map((f) => (h && h.has(f) ? h.get(f) : null)); }
      case 'HGETALL': { const h = hash(k); return h ? [...h].flat() : []; }
      case 'HEXISTS': { const h = hash(k); return h && h.has(a[0]) ? 1 : 0; }
      case 'HLEN': { const h = hash(k); return h ? h.size : 0; }
      case 'HINCRBY':
      case 'HINCRBYFLOAT': {
        const h = hash(k, true);
        const v = Number(h.get(a[0]) || 0) + Number(a[1]);
        h.set(a[0], num(v));
        return String(cmd).toUpperCase() === 'HINCRBY' ? v : num(v);
      }
      case 'LPUSH': { const l = list(k, true); for (const x of a) l.unshift(String(x)); return l.length; }
      case 'LTRIM': { const l = list(k); if (l) l.splice(0, l.length, ...l.slice(Number(a[0]), Number(a[1]) + 1)); return 'OK'; }
      case 'LRANGE': { const l = list(k); return l ? l.slice(Number(a[0]), Number(a[1]) + 1) : []; }
      default: throw new Error(`memoryStore: unsupported command ${cmd}`);
    }
  }
  return { kind: 'memory', async pipeline(cmds) { return cmds.map(exec); } };
}

/** Upstash Redis over its REST pipeline endpoint (no SDK needed). */
function upstashStore(url, token) {
  const endpoint = url.replace(/\/+$/, '') + '/pipeline';
  return {
    kind: 'redis',
    async pipeline(cmds) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
      });
      if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
      const out = await res.json();
      return out.map((r) => {
        if (r.error) throw new Error(`Upstash: ${r.error}`);
        return r.result;
      });
    },
  };
}

let store;
function getStore() {
  if (!store) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    store = url && token ? upstashStore(url, token) : memoryStore();
  }
  return store;
}
function setStore(s) {
  store = s;
}

/* ----------------------------------------------------------------- helpers */

const rid = () => crypto.randomBytes(9).toString('base64url');
const n = (x) => Number(x) || 0;

function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw new HttpError(400, 'id ไม่ถูกต้อง');
  return id;
}
function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return s || 'ผู้เล่น';
}
function cleanMoney(x) {
  const v = Number(x);
  return Number.isFinite(v) ? Math.max(-MAX_AMOUNT, Math.min(MAX_AMOUNT, Math.round(v * 100) / 100)) : 0;
}
function parse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

/* ------------------------------------------------------------ audience API */

async function join(id, name) {
  checkId(id);
  const s = getStore();
  const [, [mine, all, evseq, epoch], count, exists, prev] = await s.pipeline([
    ['HSETNX', K.room, '_epoch', rid()],
    ['HMGET', K.room, id, '_all', '_evseq', '_epoch'],
    ['HLEN', K.players],
    ['HEXISTS', K.players, id],
    ['HGET', K.players, id],
  ]);
  if (!exists && n(count) >= MAX_PLAYERS) throw new HttpError(409, 'ห้องเต็มแล้ว');
  const old = parse(prev) || {};
  const now = Date.now();
  const player = { name: cleanName(name), value: 0, cash: 0, deposited: 0, joined: old.joined || now, seen: now };
  await s.pipeline([
    ['HSET', K.players, id, JSON.stringify(player)],
    ['EXPIRE', K.players, TTL],
    ['EXPIRE', K.room, TTL],
  ]);
  return { epoch, credit: n(mine) + n(all), evseq: n(evseq) };
}

async function sync(id, since, report) {
  checkId(id);
  const s = getStore();
  const cmds = [['HMGET', K.room, id, '_all', '_evseq', '_epoch'], ['HGET', K.players, id]];
  const [[mine, all, evseq, epoch], prev] = await s.pipeline(cmds);

  const out = { epoch, credit: n(mine) + n(all), evseq: n(evseq), events: [] };
  const old = parse(prev);
  if (old && report && typeof report === 'object') {
    const player = {
      ...old,
      name: report.name !== undefined ? cleanName(report.name) : old.name,
      value: cleanMoney(report.value),
      cash: cleanMoney(report.cash),
      deposited: cleanMoney(report.deposited),
      seen: Date.now(),
    };
    await s.pipeline([['HSET', K.players, id, JSON.stringify(player)]]);
  }
  if (out.evseq > n(since)) {
    const [raw] = await s.pipeline([['LRANGE', K.events, 0, MAX_EVENTS - 1]]);
    out.events = raw.map(parse).filter((e) => e && e.seq > n(since)).sort((a, b) => a.seq - b.seq);
  }
  return out;
}

/* ------------------------------------------------------------- admin API */

async function players() {
  const [flat, roomFlat] = await getStore().pipeline([['HGETALL', K.players], ['HGETALL', K.room]]);
  const room = {};
  for (let i = 0; i < roomFlat.length; i += 2) room[roomFlat[i]] = roomFlat[i + 1];
  const list = [];
  for (let i = 0; i < flat.length; i += 2) {
    const p = parse(flat[i + 1]);
    if (p) list.push({ id: flat[i], ...p, credit: n(room[flat[i]]) + n(room._all) });
  }
  list.sort((a, b) => a.joined - b.joined);
  return { players: list, creditAll: n(room._all) };
}

async function credit(target, amount) {
  const amt = cleanMoney(amount);
  if (!amt) throw new HttpError(400, 'จำนวนเงินไม่ถูกต้อง');
  const s = getStore();
  if (target === 'all') {
    await s.pipeline([['HINCRBYFLOAT', K.room, '_all', amt]]);
    return { ok: true };
  }
  checkId(target);
  const [exists] = await s.pipeline([['HEXISTS', K.players, target]]);
  if (!exists) throw new HttpError(404, 'ไม่พบผู้เล่นนี้');
  await s.pipeline([['HINCRBYFLOAT', K.room, target, amt]]);
  return { ok: true };
}

async function broadcast(type, data = {}) {
  if (!EVENT_TYPES.has(type)) throw new HttpError(400, 'ชนิด event ไม่ถูกต้อง');
  const s = getStore();
  const [seq] = await s.pipeline([['HINCRBY', K.room, '_evseq', 1]]);
  const ev = { seq: n(seq), type, at: Date.now() };
  if (type === 'pump') ev.pct = Math.max(0.01, Math.min(1, n(data.pct) || 0.2));
  await s.pipeline([
    ['LPUSH', K.events, JSON.stringify(ev)],
    ['LTRIM', K.events, 0, MAX_EVENTS - 1],
    ['EXPIRE', K.events, TTL],
  ]);
  return ev;
}

async function reset() {
  const epoch = rid();
  await getStore().pipeline([
    ['DEL', K.room, K.players, K.events],
    ['HSET', K.room, '_epoch', epoch],
    ['EXPIRE', K.room, TTL],
  ]);
  return { ok: true, epoch };
}

/* ------------------------------------------------------------ admin auth */

const TOKEN_TTL = 12 * 3600 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW = 15 * 60;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const adminUser = () => process.env.ADMIN_USER || 'admin';
const adminPass = () => process.env.ADMIN_PASSWORD || '';
const signKey = () => digest(`agt-admin:${process.env.ADMIN_SECRET || ''}:${adminPass()}`);
const sign = (msg) => crypto.createHmac('sha256', signKey()).update(msg).digest('base64url');

async function login(user, pass, ip) {
  if (!adminPass()) throw new HttpError(503, 'ยังไม่ได้ตั้งรหัสผู้บรรยาย (ADMIN_PASSWORD) บนเซิร์ฟเวอร์');
  const key = `agt:loginfail:${String(ip || 'unknown').slice(0, 64)}`;
  const s = getStore();
  const [fails] = await s.pipeline([['GET', key]]);
  if (n(fails) >= LOGIN_MAX_FAILS) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที');
  const ok = safeEq(user ?? '', adminUser()) & safeEq(pass ?? '', adminPass());
  if (!ok) {
    await s.pipeline([['INCR', key], ['EXPIRE', key, LOGIN_WINDOW]]);
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
  memoryStore,
  upstashStore,
  getStore,
  setStore,
  join,
  sync,
  players,
  credit,
  broadcast,
  reset,
  login,
  verifyToken,
};
