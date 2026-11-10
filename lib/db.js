'use strict';

/*
 * Postgres connection for the live demo room.
 *
 * Production (Vercel + Supabase): set POSTGRES_URL (added automatically by
 * Vercel's Supabase integration) or DATABASE_URL to Supabase's connection
 * string. Prefer the pooled "Transaction" URL (port 6543) for serverless.
 *
 * Without a URL an in-process Postgres (PGlite) is used: fine for local
 * development and tests, but NOT for Vercel (each function instance would
 * have its own empty database).
 *
 * Tables live in their own schema "agt" (not exposed by Supabase's REST API)
 * and have row level security enabled with no policies, so the public anon
 * key cannot read or change them. The server connects as the table owner.
 */

const crypto = require('node:crypto');

const SCHEMA = `
select pg_advisory_xact_lock(1441001);
create schema if not exists agt;

create table if not exists agt.room (
  id            int primary key default 1 check (id = 1),
  epoch         text not null,
  evseq         int not null default 0,
  credit_all    numeric(16,2) not null default 0,
  auto_deposit  boolean not null default true,
  auto_tax_pct  numeric(5,2) not null default 15,
  start_bank    numeric(16,2) not null default 5000
);

create table if not exists agt.players (
  id          text primary key,
  name        text not null,
  bank        numeric(16,2) not null,
  bank_start  numeric(16,2) not null,
  credit      numeric(16,2) not null default 0,
  all_base    numeric(16,2) not null default 0,
  value       numeric(16,2) not null default 0,
  cash        numeric(16,2) not null default 0,
  joined_at   timestamptz not null default now(),
  seen_at     timestamptz not null default now()
);

create table if not exists agt.requests (
  id          bigserial primary key,
  player_id   text not null references agt.players(id) on delete cascade,
  kind        text not null check (kind in ('deposit', 'withdraw', 'tax')),
  amount      numeric(16,2) not null check (amount > 0),
  status      text not null check (status in ('pending', 'approved', 'held', 'rejected')),
  fee         numeric(16,2),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists requests_player_idx on agt.requests (player_id, id desc);
create index if not exists requests_status_idx on agt.requests (status, id desc);

create table if not exists agt.events (
  seq         int primary key,
  type        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists agt.login_fails (
  ip     text primary key,
  fails  int not null default 0,
  until  timestamptz not null
);

alter table agt.room        enable row level security;
alter table agt.players     enable row level security;
alter table agt.requests    enable row level security;
alter table agt.events      enable row level security;
alter table agt.login_fails enable row level security;
`;

function dbUrl() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
}

/** node-postgres config: TLS for remote hosts, verified when a CA cert is supplied. */
function pgConfig(url) {
  const u = new URL(url);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa']) u.searchParams.delete(k);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const ca = process.env.DATABASE_CA_CERT;
  const ssl = local ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  return { connectionString: u.toString(), ssl, max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 };
}

async function open() {
  const url = dbUrl();
  let db;
  if (url) {
    const { Pool } = require('pg');
    const pool = new Pool(pgConfig(url));
    pool.on('error', () => {}); // idle client dropped by the pooler; next query reconnects
    db = {
      kind: 'postgres',
      query: async (text, params) => (await pool.query(text, params)).rows,
      exec: (text) => pool.query(text),
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite();
    db = {
      kind: 'memory',
      query: async (text, params) => (await pg.query(text, params)).rows,
      exec: (text) => pg.exec(text),
      close: () => pg.close(),
    };
  }
  await db.exec(SCHEMA);
  await db.query('insert into agt.room (id, epoch) values (1, $1) on conflict (id) do nothing', [
    crypto.randomBytes(9).toString('base64url'),
  ]);
  return db;
}

let dbPromise;
function getDb() {
  if (!dbPromise) {
    dbPromise = open().catch((err) => {
      dbPromise = undefined; // retry on next request
      throw err;
    });
  }
  return dbPromise;
}

/** Tests: drop the current database so the next getDb() starts empty. */
async function resetDbForTests() {
  const old = dbPromise;
  dbPromise = undefined;
  if (old) await (await old).close();
}

module.exports = { getDb, resetDbForTests, pgConfig };
