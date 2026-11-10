'use strict';

// QR code (SVG) for the audience join link. Only encodes URLs on this site's own host.
const QRCode = require('qrcode');
const { handle } = require('../lib/http');

module.exports = handle(async (req, res) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  let url;
  try {
    url = new URL(String(req.query?.u || ''));
  } catch {
    return res.status(400).json({ error: 'URL ไม่ถูกต้อง' });
  }
  if (!/^https?:$/.test(url.protocol) || url.host !== host || url.href.length > 300) {
    return res.status(400).json({ error: 'URL ต้องเป็นลิงก์ของเว็บนี้' });
  }
  const svg = await QRCode.toString(url.href, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).send(svg);
});
