'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Hash a password as "scrypt$<salt hex>$<hash hex>". */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

// A fixed hash used to spend the same time on unknown usernames as on real ones,
// so response timing does not reveal which accounts exist.
let dummyHashPromise;
function dummyHash() {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expiresAt);
  return { token, expiresAt };
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.email, u.created_at, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, email: row.email, createdAt: row.created_at };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns a list of Thai error messages; empty when the input is valid. */
function validateRegistration({ username, email, password, confirmPassword }) {
  const errors = [];
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    errors.push('ชื่อผู้ใช้ต้องมี 3-30 ตัวอักษร (a-z, 0-9, _)');
  }
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) {
    errors.push('รูปแบบอีเมลไม่ถูกต้อง');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    errors.push('รหัสผ่านต้องมี 8-128 ตัวอักษร');
  } else if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    errors.push('รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข');
  }
  if (confirmPassword !== undefined && confirmPassword !== password) {
    errors.push('รหัสผ่านยืนยันไม่ตรงกัน');
  }
  return errors;
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  dummyHash,
  createSession,
  getSessionUser,
  destroySession,
  purgeExpiredSessions,
  validateRegistration,
};
