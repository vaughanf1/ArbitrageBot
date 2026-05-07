import type { Opportunity } from '@cesar-arb/shared';

export interface Scanner {
  name: string;
  /** Run one scan pass and return any opportunities meeting the spread threshold. */
  scan(): Promise<Opportunity[]>;
}

let counter = 0;
export function newOpportunityId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
