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
  // ============================================================
  // FED CHAIR CONFIRMATION
  // ============================================================
  // Both venues resolve YES when the Senate confirms the named individual
  // as Federal Reserve Chair. Standard government-action-by-date markets
  // — resolution source is the official Senate roll-call vote on each
  // venue. Verified on 2026-05-11.
  {
    polymarketSlug: 'will-judy-shelton-be-confirmed-as-fed-chair',
    kalshiEventTicker: 'KXFEDCHAIRCONFIRM',
    kalshiTicker: 'KXFEDCHAIRCONFIRM-JSHE',
    note: 'Judy Shelton confirmed as Fed Chair. Source: Senate confirmation vote.',
  },
  {
    polymarketSlug: 'will-kevin-warsh-be-confirmed-as-fed-chair',
    kalshiEventTicker: 'KXFEDCHAIRCONFIRM',
    kalshiTicker: 'KXFEDCHAIRCONFIRM-KWAR',
    note: 'Kevin Warsh confirmed as Fed Chair. Source: Senate confirmation vote.',
  },

  // ============================================================
  // 2028 REPUBLICAN PRESIDENTIAL NOMINATION
  // ============================================================
  // Both venues resolve YES when the named individual is officially
  // nominated by the Republican Party at the 2028 convention.
  // Resolution source on both: the convention's official nominee
  // announcement. Verified on 2026-05-11.
  {
    polymarketSlug: 'will-ted-cruz-win-the-2028-republican-presidential-nomination',
    kalshiEventTicker: 'KXPRESNOMR-28',
    kalshiTicker: 'KXPRESNOMR-28-TC',
    note: 'Ted Cruz wins 2028 GOP presidential nomination. Source: RNC convention.',
  },
  {
    polymarketSlug: 'will-jd-vance-win-the-2028-republican-presidential-nomination',
    kalshiEventTicker: 'KXPRESNOMR-28',
    kalshiTicker: 'KXPRESNOMR-28-JDV',
    note: 'JD Vance wins 2028 GOP presidential nomination. Source: RNC convention.',
  },

  // ============================================================
  // 2028 DEMOCRATIC PRESIDENTIAL NOMINATION
  // ============================================================
  // Same structure as the Republican set: resolved on official party
  // nominee at the 2028 DNC convention. Verified on 2026-05-11.
  {
    polymarketSlug: 'will-kamala-harris-win-the-2028-democratic-presidential-nomination-641',
    kalshiEventTicker: 'KXPRESNOMD-28',
    kalshiTicker: 'KXPRESNOMD-28-KH',
    note: 'Kamala Harris wins 2028 Democratic presidential nomination. Source: DNC convention.',
  },
  {
    polymarketSlug: 'will-josh-shapiro-win-the-2028-democratic-presidential-nomination-977',
    kalshiEventTicker: 'KXPRESNOMD-28',
    kalshiTicker: 'KXPRESNOMD-28-JS',
    note: 'Josh Shapiro wins 2028 Democratic presidential nomination. Source: DNC convention.',
  },
  {
    polymarketSlug: 'will-mark-kelly-win-the-2028-democratic-presidential-nomination-479',
    kalshiEventTicker: 'KXPRESNOMD-28',
    kalshiTicker: 'KXPRESNOMD-28-MK',
    note: 'Mark Kelly wins 2028 Democratic presidential nomination. Source: DNC convention.',
  },
];
