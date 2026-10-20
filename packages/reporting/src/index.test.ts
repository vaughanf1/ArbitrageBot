import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyReport } from './index.js';
import type { Trade } from '@cesar-arb/shared';
test('report includes realised failed-unwind losses but excludes paper profits and pending positions', () => {
  const base: Trade = { id: 't', opportunityId: 'o', strategy: 'prediction-pair', assetClass: 'prediction', mode: 'live', status: 'failed', fills: [], notionalUsd: 8, pnlUsd: -0.2, reasoning: '', openedAt: 0, closedAt: 1 };
  const report = buildDailyReport('2026-10-20', [base, { ...base, mode: 'paper', status: 'closed', pnlUsd: 99 }, { ...base, status: 'open', pnlUsd: null }]);
  assert.equal(report.totalPnlUsd, -0.2); assert.equal(report.byStrategy[0]?.trades, 1);
});
