'use strict';

// GET /api/quotes?market=us -> real quotes when a free API is configured, else { available: false }
const { quotes } = require('../lib/quotes');
const { handle } = require('../lib/http');

module.exports = handle(async (req, res) => {
  const market = String(req.query?.market || '').toLowerCase();
  res.status(200).json(await quotes(market));
});
