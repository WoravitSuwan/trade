'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');

const SESSION_COOKIE = 'sid';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

/** Simple fixed-window, in-memory rate limiter keyed by client IP. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'พยายามหลายครั้งเกินไป กรุณาลองใหม่ภายหลัง' });
    }
    next();
  };
}

function createApp({ db, secureCookies = false, rateLimitMax = 20 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // Attach the logged-in user (if any) to every request.
  app.use((req, res, next) => {
    req.sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.user = auth.getSessionUser(db, req.sessionToken);
    next();
  });

  // CSRF protection: state-changing API calls must be JSON, which a
  // cross-site HTML form cannot send without a CORS preflight.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type ต้องเป็น application/json' });
    }
    next();
  });

  function setSessionCookie(res, token, expiresAt) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      expires: new Date(expiresAt),
    });
  }

  function startSession(res, userId) {
    const { token, expiresAt } = auth.createSession(db, userId);
    setSessionCookie(res, token, expiresAt);
  }

  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: rateLimitMax });

  // ---------- API ----------

  app.post('/api/register', limiter, async (req, res, next) => {
    try {
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : body.username;
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
      const { password, confirmPassword } = body;

      const errors = auth.validateRegistration({ username, email, password, confirmPassword });
      if (errors.length) return res.status(400).json({ error: errors[0], errors });

      const taken = db
        .prepare('SELECT username, email FROM users WHERE username = ? OR email = ?')
        .all(username, email);
      if (taken.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
      }
      if (taken.length) return res.status(409).json({ error: 'อีเมลนี้ถูกใช้แล้ว' });

      const passwordHash = await auth.hashPassword(password);
      let userId;
      try {
        const result = db
          .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
          .run(username, email, passwordHash);
        userId = Number(result.lastInsertRowid);
      } catch (err) {
        // A concurrent registration may have taken the name between check and insert.
        if (String(err.message).includes('UNIQUE')) {
          return res.status(409).json({ error: 'ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้แล้ว' });
        }
        throw err;
      }

      startSession(res, userId);
      res.status(201).json({ user: { id: userId, username, email } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/login', limiter, async (req, res, next) => {
    try {
      const { identifier, password } = req.body || {};
      if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password) {
        return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้/อีเมล และรหัสผ่าน' });
      }

      const id = identifier.trim();
      const user = db
        .prepare('SELECT id, username, email, password_hash FROM users WHERE username = ? OR email = ?')
        .get(id, id.toLowerCase());

      const ok = user
        ? await auth.verifyPassword(password, user.password_hash)
        : (await auth.verifyPassword(password, await auth.dummyHash()), false);

      if (!ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });

      // Rotate: drop any session the client already had before issuing a new one.
      auth.destroySession(db, req.sessionToken);
      startSession(res, user.id);
      res.json({ user: { id: user.id, username: user.username, email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'ยังไม่ได้เข้าสู่ระบบ' });
    res.json({ user: req.user });
  });

  // ---------- Pages ----------

  const page = (name) => path.join(PUBLIC_DIR, `${name}.html`);
  const guestOnly = (name) => (req, res) =>
    req.user ? res.redirect('/dashboard') : res.sendFile(page(name));

  app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
  app.get('/login', guestOnly('login'));
  app.get('/register', guestOnly('register'));
  app.get('/dashboard', (req, res) =>
    req.user ? res.sendFile(page('dashboard')) : res.redirect('/login'),
  );

  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON ไม่ถูกต้อง' });
    }
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
  });

  return app;
}

module.exports = { createApp };
