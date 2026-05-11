import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Engine } from './engine.js';
import type { Storage } from './storage.js';
import type { Logger } from 'pino';
import { buildDailyReport, renderDailyReportHtml } from '@cesar-arb/reporting';
import { ymdUtc } from '@cesar-arb/risk';

export async function createServer(opts: {
  engine: Engine;
  storage: Storage;
  logger: Logger;
}) {
  const fastify = Fastify({ loggerInstance: opts.logger });
  await fastify.register(cors, { origin: true });

  fastify.get('/health', async () => ({ ok: true, ts: Date.now() }));

  fastify.get('/api/status', async () => opts.engine.status());

  fastify.get('/api/opportunities', async () => {
    const live = opts.engine.liveOpportunities();
    const recent = opts.storage.recentOpportunities(50);
    return { live, recent };
  });

  fastify.get('/api/candidates', async () => {
    const live = opts.engine.liveCandidates();
    const recent = opts.storage.recentCandidates(100);
    return { live, recent };
  });

  fastify.get('/api/trades', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? '100');
    return { trades: opts.storage.recentTrades(isFinite(limit) ? limit : 100) };
  });

  fastify.post('/api/kill-switch', async (req) => {
    const { active } = req.body as { active: boolean };
    opts.engine.setKillSwitch(Boolean(active));
    return { ok: true, killSwitch: Boolean(active) };
  });

  fastify.post('/api/start', async () => {
    await opts.engine.start();
    return { ok: true };
  });

  fastify.post('/api/stop', async () => {
    await opts.engine.stop();
    return { ok: true };
  });

  /**
   * Admin: wipe trade history + reset daily state. One-shot for clearing
   * inflated paper-trade data left over from earlier bugs. Token-gated to
   * stop random callers from nuking the demo.
   */
  fastify.post('/api/admin/reset', async (req, reply) => {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      reply.code(403);
      return { ok: false, error: 'ADMIN_TOKEN not configured' };
    }
    const provided = (req.headers['x-admin-token'] as string | undefined) ?? '';
    if (provided !== adminToken) {
      reply.code(403);
      return { ok: false, error: 'bad token' };
    }
    opts.engine.resetForDemo();
    return { ok: true, message: 'trade history + daily state cleared' };
  });

  fastify.get('/api/report', async (req) => {
    const date = (req.query as { date?: string }).date ?? ymdUtc(new Date());
    const trades = opts.storage.tradesForDate(date);
    return buildDailyReport(date, trades);
  });

  fastify.get('/api/report/html', async (req, reply) => {
    const date = (req.query as { date?: string }).date ?? ymdUtc(new Date());
    const trades = opts.storage.tradesForDate(date);
    const html = renderDailyReportHtml(buildDailyReport(date, trades));
    reply.type('text/html').send(html);
  });

  return fastify;
}
