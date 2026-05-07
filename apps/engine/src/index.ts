import pino from 'pino';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { Engine } from './engine.js';
import { createServer } from './server.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

async function main() {
  const config = loadConfig();
  const dbPath = process.env.SQLITE_PATH ?? './data/cesar-arb.db';
  const storage = new Storage(dbPath);
  const engine = new Engine({ config, storage, logger });
  const server = await createServer({ engine, storage, logger });

  await engine.start();
  await server.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, mode: config.mode }, 'engine API listening');

  const shutdown = async () => {
    logger.info('shutdown requested');
    await engine.stop();
    await server.close();
    storage.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
  process.exit(1);
});
