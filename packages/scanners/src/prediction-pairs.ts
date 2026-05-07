/**
 * Curated Polymarket ↔ Kalshi market allowlist.
 *
 * Each entry asserts that a specific Polymarket condition resolves to the
 * same real-world outcome as a specific Kalshi market. The prediction
 * scanner uses this list as the source of truth in `allowlist` mode —
 * pairs not in this list are NEVER traded, regardless of how high the
 * fuzzy text similarity is.
 *
 * Why an allowlist exists at all: fuzzy text matching produces false
 * pairs on common templates like "Will <X> win <election>?" — e.g.
 * matching a specific candidate on Polymarket against a specific party
 * on Kalshi. Both legs can lose, and the supposed arb is fictional.
 *
 * To add a pair:
 *   1. Find the Polymarket market — note its `slug` (the URL fragment).
 *   2. Find the Kalshi market — note its `eventTicker` (e.g. KXFRENCHPRES-27).
 *   3. Confirm by reading the resolution sources on each that they
 *      pay out on the *same* binary outcome of the same event.
 *   4. Append below.
 *
 * Keep this list small and high-conviction. Quality over quantity.
 */

export interface PredictionPair {
  /** Polymarket market slug (from gamma response). */
  polymarketSlug: string;
  /** Kalshi event_ticker — pair scopes ALL markets under that event. */
  kalshiEventTicker: string;
  /**
   * Optional Kalshi market ticker if the event has multiple markets and
   * only one corresponds to the Polymarket question. If omitted, the
   * scanner will match the Polymarket market against any market in the
   * Kalshi event.
   */
  kalshiTicker?: string;
  /** Free-form note for humans, e.g. resolution source link. */
  note?: string;
}

export const PREDICTION_PAIRS: PredictionPair[] = [
  // Empty by default. Populate with confirmed equivalent markets.
  // Example:
  // {
  //   polymarketSlug: 'will-donald-trump-win-the-2024-us-presidential-election',
  //   kalshiEventTicker: 'PRES-2024',
  //   kalshiTicker: 'PRES-2024-DT',
  //   note: 'Resolution: AP / state certifications. Confirmed equivalent.',
  // },
];
