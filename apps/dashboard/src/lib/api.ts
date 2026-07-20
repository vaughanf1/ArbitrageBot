import type {
  EngineStatus,
  Opportunity,
  Trade,
  DailyReport,
  RiskLimits,
} from '@cesar-arb/shared';

const ENGINE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

/**
 * Control token for mutating engine endpoints (limits, start/stop, resuming
 * after a kill). Entered once on the Controls page, kept in this browser's
 * localStorage — it is a per-operator secret, so it must NOT be baked into
 * the client bundle via NEXT_PUBLIC_*.
 */
const TOKEN_KEY = 'cesar-control-token';

export function getControlToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setControlToken(token: string): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(getControlToken() ? { 'x-control-token': getControlToken() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('Locked — enter the control token on the Controls page');
    }
    throw new Error(`${path} ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => get<EngineStatus>('/api/status'),
  opportunities: () => get<{ live: Opportunity[]; recent: Opportunity[] }>('/api/opportunities'),
  candidates: () => get<{ live: Opportunity[]; recent: Opportunity[] }>('/api/candidates'),
  trades: (limit = 100) => get<{ trades: Trade[] }>(`/api/trades?limit=${limit}`),
  report: (date?: string) => get<DailyReport>(`/api/report${date ? `?date=${date}` : ''}`),
  updateLimits: (patch: Partial<RiskLimits>) =>
    post<{ ok: boolean; limits: RiskLimits }>('/api/limits', patch),
  setKillSwitch: (active: boolean) => post<{ ok: boolean; killSwitch: boolean }>('/api/kill-switch', { active }),
  start: () => post<{ ok: boolean }>('/api/start'),
  stop: () => post<{ ok: boolean }>('/api/stop'),
};
