'use strict';

const { HttpError } = require('./room');

/** Wrap a Vercel-style handler with JSON error handling and no-store caching. */
function handle(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  };
}

function body(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { throw new HttpError(400, 'JSON ไม่ถูกต้อง'); }
  }
  return {};
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

module.exports = { handle, body, clientIp };
