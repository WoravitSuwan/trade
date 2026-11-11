'use strict';

// Audience phones: sign up / log in, poll the live demo room, and move simulated money.
// Logging in with the presenter's name returns an admin token instead.
const room = require('../lib/room');
const { handle, body, clientIp } = require('../lib/http');

module.exports = handle(async (req, res) => {
  if (req.method === 'GET') return res.status(200).json(await room.status());
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const b = body(req);
  switch (b.action) {
    case 'signup': return res.status(200).json(await room.signup(b.name, b.pass));
    case 'login': return res.status(200).json(await room.login(b.user, b.pass, clientIp(req)));
    case 'session': return res.status(200).json(await room.session(b.token));
    case 'sync': return res.status(200).json(await room.sync(b.token, b.since, b.report));
    case 'deposit': return res.status(200).json(await room.deposit(b.token, b.amount));
    case 'withdraw': return res.status(200).json(await room.withdraw(b.token, b.amount));
    case 'paytax': return res.status(200).json(await room.payTax(b.token, b.requestId));
    default: return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  }
});
