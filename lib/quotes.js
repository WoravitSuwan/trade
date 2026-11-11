'use strict';

/*
 * Real stock quotes for markets that have a free API.
 *
 *   us   Finnhub (free plan: real-time US quotes, 60 calls/min). Needs the env
 *        var FINNHUB_API_KEY; without it the app simulates US stocks.
 *
 * Every phone polls this endpoint, so quotes are cached in Postgres and only
 * one function instance refreshes them at a time (at most every 12 seconds,
 * i.e. 6 symbols x 5/min = 30 calls/min). If the database is unavailable an
 * in-memory cache per instance is used instead.
 */

const { getDb } = require('./db');

const MARKETS = {
  us: ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL'],
};
const REFRESH_MS = 12_000;
const memory = { at: 0, quotes: {} };

async function fetchFinnhub(sym, key) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`, { signal: c.signal });
    if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
    const q = await r.json();
    if (!(Number(q.c) > 0)) return null;   // unknown symbol or no data
    return { c: +q.c, o: +q.o, h: +q.h, l: +q.l, pc: +q.pc, t: (+q.t || 0) * 1000 };
  } finally {
    clearTimeout(t);
  }
}

async function refresh(syms, key) {
  const out = {};
  const got = await Promise.all(syms.map((s) => fetchFinnhub(s, key).catch(() => null)));
  syms.forEach((s, i) => { if (got[i]) out[s] = got[i]; });
  return out;
}

async function quotes(market) {
  const syms = MARKETS[market];
  if (!syms) return { available: false, reason: 'no-free-source' };
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { available: false, reason: 'no-key' };

  let db = null;
  try { db = await getDb(); } catch { db = null; }

  if (!db) {   // no database: per-instance cache
    if (Date.now() - memory.at > REFRESH_MS) {
      const fresh = await refresh(syms, key);
      if (Object.keys(fresh).length) Object.assign(memory.quotes, fresh);
      memory.at = Date.now();
    }
    return { available: Object.keys(memory.quotes).length > 0, source: 'finnhub', quotes: memory.quotes };
  }

  const claim = await db.query(
    `update agt.room set quotes_until = now() + make_interval(secs => $1)
      where id = 1 and (quotes_until is null or quotes_until < now()) returning 1`,
    [REFRESH_MS / 1000],
  );
  if (claim.length) {
    const fresh = await refresh(syms, key);
    for (const [sym, data] of Object.entries(fresh)) {
      await db.query(
        `insert into agt.quotes (sym, data, fetched_at) values ($1, $2::jsonb, now())
         on conflict (sym) do update set data = excluded.data, fetched_at = now()`,
        [sym, JSON.stringify(data)],
      );
    }
  }
  const rows = await db.query('select sym, data from agt.quotes where sym = any($1::text[])', [syms]);
  const out = Object.fromEntries(rows.map((r) => [r.sym, r.data]));
  return { available: rows.length > 0, source: 'finnhub', quotes: out };
}

module.exports = { quotes, MARKETS };
