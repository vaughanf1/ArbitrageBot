/**
 * Diagnostic: run each scanner once and print what it finds, with no
 * threshold filtering. Helps us see if there's *any* edge being detected
 * before the risk filter is applied.
 *
 *   pnpm --filter @cesar-arb/engine exec tsx src/diag.ts
 */
import { BitgetExecutor, KalshiExecutor, PolymarketExecutor } from '@cesar-arb/executors';
import { TriangularScanner, PredictionScanner } from '@cesar-arb/scanners';

async function main() {
  const bitget = new BitgetExecutor();
  const polymarket = new PolymarketExecutor();
  const kalshi = new KalshiExecutor();

  console.log('=== Triangular (BitGet, no min-edge filter) ===');
  const tri = new TriangularScanner({
    executor: bitget,
    venue: 'bitget',
    feeBps: 10,
    minEdgePct: -100, // accept everything to see raw edges
    sizeUsd: 100,
  });
  const triRes = await tri.scan();
  console.log(`found ${triRes.length} candidates`);
  for (const o of triRes.sort((a, b) => b.edgePct - a.edgePct)) {
    console.log(`  ${o.edgePct.toFixed(3).padStart(7)}%  ${o.description}`);
  }

  console.log('\n=== Polymarket markets (top 5 by volume24hr) ===');
  const polyMarkets = await polymarket.listActiveMarkets();
  console.log(`fetched ${polyMarkets.length} markets`);
  for (const m of polyMarkets.slice(0, 5)) {
    console.log(`  yes=${m.yesPrice.toFixed(3)} no=${m.noPrice.toFixed(3)} vol24h=${m.volume24h.toFixed(0)} | ${m.question.slice(0, 80)}`);
  }

  console.log('\n=== Kalshi markets (sample) ===');
  const kalshiMarkets = await kalshi.listActiveMarkets();
  console.log(`fetched ${kalshiMarkets.length} markets`);
  for (const m of kalshiMarkets.slice(0, 5)) {
    console.log(`  yes=${m.yesAsk.toFixed(3)} no=${m.noAsk.toFixed(3)} vol24h=${m.volume24h.toFixed(0)} | ${m.title.slice(0, 80)}`);
  }

  console.log('\n=== Prediction-pair (no min-edge, min-volume=0) ===');
  const pred = new PredictionScanner({
    polymarket,
    kalshi,
    minEdgePct: -100,
    sizeUsd: 100,
    minVolume24h: 0,
    minSimilarity: 0.4,
  });
  const predRes = await pred.scan();
  console.log(`found ${predRes.length} candidates`);
  for (const o of predRes.sort((a, b) => b.edgePct - a.edgePct).slice(0, 10)) {
    console.log(`  ${o.edgePct.toFixed(3).padStart(7)}%  ${o.description.slice(0, 90)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
