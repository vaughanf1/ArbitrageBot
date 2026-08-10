import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGatewayIsoDate } from './polymarket-us.js';

test('accepts and normalizes timezone-qualified ISO gateway dates', () => {
  assert.equal(normalizeGatewayIsoDate('2026-08-10T12:34:56Z'), '2026-08-10T12:34:56.000Z');
  assert.equal(normalizeGatewayIsoDate('2026-08-10T13:34:56+01:00'), '2026-08-10T12:34:56.000Z');
});

test('rejects malformed, impossible, or timezone-ambiguous gateway dates', () => {
  for (const value of ['2026-02-30T12:00:00Z', '2026-08-10T12:00:00', '08/10/2026', '0', '']) {
    assert.equal(normalizeGatewayIsoDate(value), null, value);
  }
});
