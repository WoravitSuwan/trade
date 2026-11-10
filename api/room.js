'use strict';

// Audience phones: join the live demo room and poll it for presenter actions.
const room = require('../lib/room');
const { handle, body } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, store: room.getStore().kind });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const b = body(req);
  if (b.action === 'join') return res.status(200).json(await room.join(b.id, b.name));
  if (b.action === 'sync') return res.status(200).json(await room.sync(b.id, b.since, b.report));
  res.status(400).json({ error: 'action ไม่ถูกต้อง' });
});
