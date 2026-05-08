import type { Opportunity } from '@cesar-arb/shared';

export interface Scanner {
  name: string;
  /**
   * Run one scan pass and return ALL evaluated candidates — including
   * sub-threshold edges. The engine filters tradable vs candidate using
   * its risk-limit threshold; surfacing everything keeps the dashboard
   * alive when no edge clears the bar (which is the common case in
   * efficient markets).
   */
  scan(): Promise<Opportunity[]>;
}

let counter = 0;
export function newOpportunityId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
