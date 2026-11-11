'use strict';

// Presenter back office. Every action except "login" needs the Bearer token that
// "login" returns; the password itself only lives in the ADMIN_PASSWORD env var.
const room = require('../lib/room');
const { handle, body, clientIp } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = body(req);

  if (b.action === 'login') return res.status(200).json(await room.adminLogin(b.user, b.pass, clientIp(req)));

  const auth = String(req.headers.authorization || '');
  if (!room.verifyToken(auth.replace(/^Bearer\s+/i, ''))) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่โหมดผู้บรรยายใหม่' });
  }

  switch (b.action) {
    case 'overview': return res.status(200).json(await room.overview());
    case 'credit': return res.status(200).json(await room.credit(b.target, b.amount));
    case 'grant': return res.status(200).json(await room.grant(b.targets, b.kind, b.amount, b.message));
    case 'activity': return res.status(200).json(await room.activity(b.playerId));
    case 'close': return res.status(200).json(await room.closeAccount(b.playerId));
    case 'thread': return res.status(200).json(await room.thread(b.playerId));
    case 'reply': return res.status(200).json(await room.reply(b.playerId, b.text));
    case 'bot': return res.status(200).json(await room.setBot(b.playerId, b.on));
    case 'decide': return res.status(200).json(await room.decide(b.requestId, b.decision, b.feePct));
    case 'settings': return res.status(200).json(await room.settings(b.settings));
    case 'event': return res.status(200).json(await room.broadcast(b.type, b));
    case 'reset': return res.status(200).json(await room.reset());
    default: return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  }
});
