import { apiUrl } from './catalog';

export function createPlayerMetrics() {
  const startedAt = performance.now();
  const counts = new Map<string, number>();
  const agent = navigator.userAgent;
  const platform = /iPad|iPhone|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(agent) ? 'android' : 'web';
  return (event: 'start' | 'waiting' | 'error' | 'ended') => {
    const count = counts.get(event) || 0;
    if (count >= (event === 'waiting' ? 3 : 1)) return;
    counts.set(event, count + 1);
    void fetch(apiUrl('/api/player-events'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, platform, durationMs: event === 'start' ? Math.round(performance.now() - startedAt) : 0 }),
      signal: AbortSignal.timeout(10000), keepalive: true }).catch(() => {});
  };
}
