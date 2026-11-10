'use strict';

// Audience phones: join the live demo room, poll it, and move simulated money.
const room = require('../lib/room');
const { handle, body } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (req.method === 'GET') return res.status(200).json(await room.status());
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const b = body(req);
  switch (b.action) {
    case 'join': return res.status(200).json(await room.join(b.id, b.name));
    case 'sync': return res.status(200).json(await room.sync(b.id, b.since, b.report));
    case 'deposit': return res.status(200).json(await room.deposit(b.id, b.amount));
    case 'withdraw': return res.status(200).json(await room.withdraw(b.id, b.amount));
    case 'leave': return res.status(200).json(await room.leave(b.id));
    case 'paytax': return res.status(200).json(await room.payTax(b.id, b.requestId));
    default: return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  }
});
