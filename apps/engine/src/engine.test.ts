import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Engine } from './engine.js';
import { Storage } from './storage.js';
import { loadConfig } from './config.js';
import type { Opportunity, OpportunityLeg, Trade } from '@cesar-arb/shared';

const opportunity: Opportunity = {
  id: 'test', strategy: 'prediction-pair', assetClass: 'prediction', venues: ['polymarket-us'],
  description: 'two outcome basket', edgePct: 10, estProfitUsd: 1, sizeUsd: 8,
  legs: ['a', 'b'].map((symbol) => ({ venue: 'polymarket-us', symbol, side: 'buy', price: 0.4, qty: 10 })),
  reasoning: 'test', detectedAt: Date.now(), expiresAt: Date.now() + 60_000, source: 'confirmed', requiresReview: false,
};
function fixture(handler: (leg: OpportunityLeg, index: number) => any) {
  const storage = new Storage(':memory:');
  const config = loadConfig();
  config.mode = 'paper'; config.execution.liveVenues = [];
  const engine = new Engine({ config, storage, logger: pino({ level: 'silent' }) });
  const calls: OpportunityLeg[] = [];
  (engine as any).executorByVenue.set('polymarket-us', {
    ticker: async () => ({ bid: 0.4, ask: 0.4 }),
    placeMarketOrder: async (leg: OpportunityLeg) => { calls.push(leg); return handler(leg, calls.length - 1); },
  });
  return { engine, storage, calls, run: () => (engine as any).executeOpportunity(opportunity, 'paper') };
}
function fill(leg: OpportunityLeg, qty = leg.qty) {
  return { ok: true, fill: { ...leg, qty, feeUsd: 0.01, filledAt: Date.now() } };
}
test('complete prediction basket remains open with no invented realised profit', async () => {
  const f = fixture((leg) => fill(leg)); await f.run();
  const t = f.storage.recentTrades(1)[0]!;
  assert.equal(t.status, 'open'); assert.equal(t.pnlUsd, null); assert.equal(t.closedAt, null);
  assert.equal((f.engine as any).paperState.exposureTodayUsd, 8);
  f.storage.close();
});
test('partial entry unwinds only actual fractional quantity and stops further entries', async () => {
  const f = fixture((leg, i) => fill(leg, i === 0 ? 3.93 : leg.qty)); await f.run();
  assert.deepEqual(f.calls.map((l) => [l.side, l.qty]), [['buy', 10], ['sell', 3.93]]);
  const t = f.storage.recentTrades(1)[0]!;
  assert.equal(t.status, 'failed'); assert.equal(t.fills.length, 2);
  assert.ok(Math.abs(t.pnlUsd! + 0.02) < 1e-8);
  assert.ok((f.engine as any).paperState.exposureTodayUsd > 0);
  f.storage.close();
});
test('partial unwind halts and cannot report a closed profitable trade', async () => {
  const f = fixture((leg, i) => i === 1 ? { ok: false, error: 'rejected' } : fill(leg, i === 2 ? 2 : leg.qty));
  await f.run();
  assert.equal(f.engine.status().killSwitch, true);
  const t = f.storage.recentTrades(1)[0]!;
  assert.equal(t.pnlUsd, null); assert.equal(t.status, 'failed'); assert.equal(t.fills.length, 2);
  f.storage.close();
});
test('unknown submission halts and preserves earlier fills plus recovery', async () => {
  const f = fixture((leg, i) => i === 1 ? { ok: false, uncertain: true, error: 'timeout' } : fill(leg));
  await f.run(); assert.equal(f.engine.status().killSwitch, true);
  assert.equal(f.storage.recentTrades(1)[0]!.fills.length, 2);
  assert.equal(f.storage.recentTrades(1)[0]!.pnlUsd, null);
  f.storage.close();
});
test('each fill is persisted before submitting the next leg', async () => {
  const f = fixture((leg, i) => {
    if (i === 1) assert.equal(f.storage.recentTrades(1)[0]!.fills.length, 1);
    return fill(leg);
  }); await f.run(); f.storage.close();
});
test('durable stop is recovered even when the saved daily row is from yesterday', () => {
  const f = fixture(fill); f.engine.setKillSwitch(true);
  f.storage.saveDailyState('2000-01-01', { startingEquityUsd: 59, exposureUsd: 0, realizedPnlUsd: 0, killSwitch: true });
  const config = loadConfig(); config.mode = 'paper'; config.execution.liveVenues = [];
  const recovered = new Engine({ config, storage: f.storage, logger: pino({ level: 'silent' }) });
  assert.equal(recovered.status().killSwitch, true); f.storage.close();
});
test('unreadable buying power blocks new live exposure', async () => {
  const f = fixture(fill);
  (f.engine as any).polymarketUs.buyingPowerUsd = async () => { throw new Error('offline'); };
  assert.equal((await (f.engine as any).canAfford(opportunity)).ok, false); f.storage.close();
});
test('buying power gate includes commissions', async () => {
  const f = fixture(fill); (f.engine as any).polymarketUs.buyingPowerUsd = async () => 8;
  assert.equal((await (f.engine as any).canAfford(opportunity)).ok, false); f.storage.close();
});
