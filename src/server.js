'use strict';
const config = require('./config');
config.validate();
const createApp = require('./app');
const { pool } = require('./db');

const app = createApp();
const server = app.listen(config.port, config.host, () => console.log(`[web] listening on ${config.host}:${config.port} (${config.baseUrl})`));

function shutdown(sig) {
  console.log(`[web] ${sig} received, shutting down`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
