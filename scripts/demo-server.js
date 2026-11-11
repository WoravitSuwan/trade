'use strict';

/*
 * Local stand-in for Vercel: serves index.html and the /api functions with the
 * same req/res helpers Vercel provides. Uses an in-memory Postgres (PGlite) unless
 * POSTGRES_URL / DATABASE_URL points at a real database (e.g. Supabase).
 *
 *   ADMIN_PASSWORD=... npm run demo     ->  http://localhost:3001
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const routes = {
  '/api/room': require('../api/room'),
  '/api/admin': require('../api/admin'),
  '/api/qr': require('../api/qr'),
  '/api/quotes': require('../api/quotes'),
};

function adapt(handler) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (raw && /json/i.test(req.headers['content-type'] || '')) {
      try {
        req.body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end('{"error":"invalid JSON"}');
      }
    } else {
      req.body = raw || undefined;
    }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
    res.send = (data) => { res.end(data); return res; };
    await handler(req, res);
  };
}

function createServer() {
  const api = Object.fromEntries(Object.entries(routes).map(([k, h]) => [k, adapt(h)]));
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (api[pathname]) return api[pathname](req, res);
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3001;
  createServer().listen(port, () => {
    console.log(`Demo running at http://localhost:${port}`);
    if (!process.env.ADMIN_PASSWORD) console.log('ADMIN_PASSWORD is not set: presenter login is disabled.');
  });
}

module.exports = { createServer };
