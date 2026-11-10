'use strict';

// Presenter controls. Every action except "login" needs the Bearer token that
// "login" returns; the password itself only lives in the ADMIN_PASSWORD env var.
const room = require('../lib/room');
const { handle, body, clientIp } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = body(req);

  if (b.action === 'login') return res.status(200).json(await room.login(b.user, b.pass, clientIp(req)));

  const auth = String(req.headers.authorization || '');
  if (!room.verifyToken(auth.replace(/^Bearer\s+/i, ''))) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่โหมดผู้บรรยายใหม่' });
  }

  switch (b.action) {
    case 'players': return res.status(200).json(await room.players());
    case 'credit': return res.status(200).json(await room.credit(b.target, b.amount));
    case 'event': return res.status(200).json(await room.broadcast(b.type, b));
    case 'reset': return res.status(200).json(await room.reset());
    default: return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  }
});
