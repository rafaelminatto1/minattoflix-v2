import { apiUrl } from './catalog';

interface RoomSnapshot {
  state: Record<string, unknown> | null;
  cursor: string;
  events: Array<{ id: string; sender: string; payload: Record<string, unknown> }>;
  participants: number;
}

/** Socket-like transport, backed by HTTP/Neon. Stops polling while the app is hidden. */
export class RoomTransport {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private clientId = crypto.randomUUID();
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private failures = 0;
  private ignoreInitialSync = false;
  private sends = Promise.resolve();
  constructor(private code: string) { this.timer = setTimeout(() => void this.poll(), 0); }
  private emit(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  private async poll() {
    if (this.readyState === 3) return;
    try {
      if (document.visibilityState === 'hidden') return;
      const query = new URLSearchParams({ clientId: this.clientId });
      if (this.cursor !== undefined) query.set('cursor', this.cursor);
      const response = await fetch(apiUrl(`/api/watch-party/${encodeURIComponent(this.code)}?${query}`), { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) {
        if ([400,401,403,503].includes(response.status)) { this.close(); return; }
        throw new Error('Room temporarily unavailable');
      }
      const snapshot = await response.json() as RoomSnapshot;
      if (this.readyState === 3) return;
      this.failures = 0;
      if (this.readyState === 0) {
        this.readyState = 1;
        this.ignoreInitialSync = Boolean(snapshot.state?.mediaItemId);
        this.onopen?.();
        if (snapshot.state?.mediaItemId) this.emit({ type: 'sync_state', payload: { ...snapshot.state, participants: snapshot.participants } });
      }
      this.cursor = snapshot.cursor;
      this.emit({ type: 'participants_update', participants: snapshot.participants });
      for (const event of snapshot.events) if (event.sender !== this.clientId || event.payload.type === 'chat') this.emit(event.payload);
    } catch { this.failures++; }
    finally {
      if (this.readyState !== 3) this.timer = setTimeout(() => void this.poll(), Math.min(30000, 5000 * 2 ** Math.min(this.failures, 3)));
    }
  }
  send(data: string) {
    if (this.readyState !== 1) return;
    const payload = JSON.parse(data);
    if (this.ignoreInitialSync && payload.type === 'sync_state') { this.ignoreInitialSync = false; return; }
    this.sends = this.sends.then(async () => {
      if (this.readyState === 3) return;
      const response = await fetch(apiUrl(`/api/watch-party/${encodeURIComponent(this.code)}`), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, clientId: this.clientId }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error('Não foi possível enviar para a sala.');
    }).catch(() => { this.close(); });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.timer); this.controller.abort(); this.onclose?.();
  }
}
