import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './common/logger.js';
import { initRealtime } from './websocket/index.js';

const app = createApp();
const server = createServer(app);
initRealtime(server, config.corsOrigin);
server.listen(config.port, () => {
  logger.info(`teamchat-server listening on :${config.port}`);
});