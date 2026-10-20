import test from 'node:test';
import assert from 'node:assert/strict';
import { PolymarketUsExecutor } from './polymarket-us.js';
const leg = { venue: 'polymarket-us' as const, symbol: 'a:LONG', side: 'buy' as const, price: 0.45, qty: 10 };
function executor(response: unknown) {
  const e = new PolymarketUsExecutor({ enableLive: true, dryRun: false, keyId: 'test', secretKey: 'test' });
  const requests: any[] = [];
  (e as any).authedFetch = async (_method: string, _path: string, body: unknown) => {
    requests.push(body); return new Response(JSON.stringify(response));
  };
  return { e, requests };
}
test('entry uses fill-or-kill and never raises scanner price cap', async () => {
  const f = executor({ executions: [{ type: 'EXECUTION_TYPE_FILL', lastShares: '10', lastPx: { value: '.45' }, commissionNotionalCollected: { value: '.15' } }] });
  const r = await f.e.placeMarketOrder(leg); assert.equal(r.ok, true);
  assert.equal(f.requests[0].tif, 'TIME_IN_FORCE_FILL_OR_KILL'); assert.equal(f.requests[0].price.value, '0.450');
  assert.equal(r.fill?.feeUsd, 0.15);
});
test('fractional recovery quantities are not silently rounded down', async () => {
  const f = executor({ executions: [{ type: 'EXECUTION_TYPE_FILL', lastShares: '3.93', lastPx: { value: '.44' } }] });
  await f.e.placeMarketOrder({ ...leg, side: 'sell', qty: 3.93 });
  assert.equal(f.requests[0].quantity, 3.93); assert.equal(f.requests[0].tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
});
test('fill is not discarded when a later execution reports rejection', async () => {
  const f = executor({ executions: [
    { type: 'EXECUTION_TYPE_PARTIAL_FILL', lastShares: '2', lastPx: { value: '.45' } },
    { type: 'EXECUTION_TYPE_REJECTED' },
  ] });
  assert.equal((await f.e.placeMarketOrder(leg)).fill?.qty, 2);
});
test('accepted response without a terminal execution is uncertain', async () => {
  const f = executor({ id: 'accepted', executions: [{ type: 'EXECUTION_TYPE_NEW' }] });
  assert.equal((await f.e.placeMarketOrder(leg)).uncertain, true);
});
test('transport timeout is uncertain and never automatically retried', async () => {
  const f = executor({}); let count = 0;
  (f.e as any).authedFetch = async () => { count++; throw new Error('timeout'); };
  assert.equal((await f.e.placeMarketOrder(leg)).uncertain, true); assert.equal(count, 1);
});
