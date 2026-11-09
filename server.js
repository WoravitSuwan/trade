'use strict';

const path = require('node:path');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { purgeExpiredSessions } = require('./src/auth');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db');

const db = openDatabase(DB_FILE);
const app = createApp({ db, secureCookies: process.env.NODE_ENV === 'production' });

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
