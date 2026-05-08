import type {
  EngineStatus,
  Opportunity,
  Trade,
  DailyReport,
} from '@cesar-arb/shared';

const ENGINE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => get<EngineStatus>('/api/status'),
  opportunities: () => get<{ live: Opportunity[]; recent: Opportunity[] }>('/api/opportunities'),
  candidates: () => get<{ live: Opportunity[]; recent: Opportunity[] }>('/api/candidates'),
  trades: (limit = 100) => get<{ trades: Trade[] }>(`/api/trades?limit=${limit}`),
  report: (date?: string) => get<DailyReport>(`/api/report${date ? `?date=${date}` : ''}`),
  setKillSwitch: (active: boolean) => post<{ ok: boolean; killSwitch: boolean }>('/api/kill-switch', { active }),
  start: () => post<{ ok: boolean }>('/api/start'),
  stop: () => post<{ ok: boolean }>('/api/stop'),
};
