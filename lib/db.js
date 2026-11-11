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

-- accounts (added after the first release; safe to re-run)
alter table agt.room    add column if not exists secret text;
update agt.room set secret = md5(random()::text || clock_timestamp()::text) || md5(random()::text) where secret is null;
alter table agt.players add column if not exists login text;
alter table agt.players add column if not exists pass_hash text;
alter table agt.players add column if not exists state jsonb;
alter table agt.players add column if not exists email text;
alter table agt.players add column if not exists phish_pass text;   -- รหัสอีเมลที่เหยื่อพิมพ์ (จุดสอน: เว็บหลอกเก็บรหัสที่คุณกรอกได้)
alter table agt.players add column if not exists screen text;   -- หน้าที่ผู้ใช้กำลังดูอยู่ (ให้แอดมินสปายได้)
alter table agt.players add column if not exists closed boolean not null default false;   -- แอดมิน "ปิดบัญชี

-- บันทึกการกระทำของผู้ใช้ (แอดมินดู log แบบสด)
create table if not exists agt.activity (
  id          bigserial primary key,
  player_id   text not null references agt.players(id) on delete cascade,
  text        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists activity_player_idx on agt.activity (player_id, id desc);
alter table agt.activity enable row level security;
create unique index if not exists players_login_idx on agt.players (lower(login)) where login is not null;
alter table agt.players add column if not exists vip boolean not null default false;
alter table agt.players add column if not exists bot_off boolean not null default false;

-- support chat between each audience member and "customer service" (scripted bot or presenter)
create table if not exists agt.chat (
  id          bigserial primary key,
  player_id   text not null references agt.players(id) on delete cascade,
  sender      text not null check (sender in ('user', 'bot', 'admin', 'system')),
  text        text not null,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists chat_player_idx on agt.chat (player_id, id);
alter table agt.requests add column if not exists method text;

-- shared cache of real stock quotes (one refresh for every phone, keeps free API limits)
create table if not exists agt.quotes (
  sym         text primary key,
  data        jsonb not null,
  fetched_at  timestamptz not null default now()
);
alter table agt.room add column if not exists quotes_until timestamptz;
alter table agt.quotes enable row level security;
alter table agt.chat enable row level security;

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
  if (!url && process.env.VERCEL) {
    // An in-process database would be different on every function instance, so refuse clearly instead.
    const err = new Error('ยังไม่ได้เชื่อมฐานข้อมูล Supabase: ไม่พบ env POSTGRES_URL หรือ DATABASE_URL (เชื่อม Supabase ในแท็บ Storage แล้ว Redeploy)');
    err.status = 503;
    err.expose = true;
    throw err;
  }
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
  await db.query('insert into agt.room (id, epoch, secret) values (1, $1, $2) on conflict (id) do nothing', [
    crypto.randomBytes(9).toString('base64url'),
    crypto.randomBytes(32).toString('hex'),
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
