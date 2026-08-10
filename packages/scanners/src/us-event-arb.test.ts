import assert from 'node:assert/strict';
import test from 'node:test';
import type { PolymarketUsExecutor, UsEvent, UsTopOfBook } from '@cesar-arb/executors';
import { UsEventArbScanner } from './us-event-arb.js';

function eventEndingIn(days: number | null): UsEvent {
  const endDate = days == null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
  return {
    slug: 'test-event',
    title: 'Test Sports Winner',
    category: 'sports',
    endDate,
    markets: [
      {
        slug: 'outcome-a',
        question: 'Will A win?',
        marketType: 'moneyline',
        active: true,
        closed: false,
        endDate,
      },
      {
        slug: 'outcome-b',
        question: 'Will B win?',
        marketType: 'moneyline',
        active: true,
        closed: false,
        endDate,
      },
    ],
  };
}

function executorFor(event: UsEvent): PolymarketUsExecutor {
  const books = new Map<string, UsTopOfBook>([
    ['outcome-a', { bestAsk: 0.45, askSize: 100, bestBid: 0.44, bidSize: 100 }],
    ['outcome-b', { bestAsk: 0.45, askSize: 100, bestBid: 0.44, bidSize: 100 }],
  ]);
  return {
    listActiveEvents: async () => [event],
    topOfBooks: async () => books,
  } as unknown as PolymarketUsExecutor;
}

test('long-dated baskets remain visible but can never auto-trade', async () => {
  const scanner = new UsEventArbScanner({
    executor: executorFor(eventEndingIn(150)),
    minEdgePct: 0.5,
    sizeUsd: 10,
    maxSettlementDays: 14,
  });

  const [opportunity] = await scanner.scan();
  assert.ok(opportunity);
  assert.equal(opportunity.requiresReview, true);
  assert.match(opportunity.reasoning, /capital locked for 150 days/i);
});

test('unknown settlement dates fail closed', async () => {
  const scanner = new UsEventArbScanner({
    executor: executorFor(eventEndingIn(null)),
    minEdgePct: 0.5,
    sizeUsd: 10,
    maxSettlementDays: 14,
  });

  const [opportunity] = await scanner.scan();
  assert.ok(opportunity);
  assert.equal(opportunity.requiresReview, true);
  assert.match(opportunity.reasoning, /settlement date unavailable/i);
});

test('near-term exhaustive baskets remain eligible for live execution', async () => {
  const scanner = new UsEventArbScanner({
    executor: executorFor(eventEndingIn(2)),
    minEdgePct: 0.5,
    sizeUsd: 10,
    maxSettlementDays: 14,
  });

  const [opportunity] = await scanner.scan();
  assert.ok(opportunity);
  assert.equal(opportunity.requiresReview, false);
  assert.match(opportunity.reasoning, /settles in 2 days/i);
});
