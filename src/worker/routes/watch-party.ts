import { Hono, type Context } from 'hono';
import { type Env } from '../db';

export const watchPartyRoutes = new Hono<{ Bindings: Env }>();

/**
 * WebSocket & State endpoint routed to the Cloudflare Durable Object WatchPartyRoom
 * Powers "Watch Party (Assistir Junto)" & "Controle Remoto da TV pelo Celular"
 */
watchPartyRoutes.all('/api/watch-party/:roomCode/*', async (c) => {
  const roomCode = (c.req.param('roomCode') || 'SALA').toUpperCase();
  if (!c.env.WATCH_PARTY) {
    return c.json({ error: 'Durable Object WATCH_PARTY não configurado' }, 503);
  }
  const id = c.env.WATCH_PARTY.idFromName(roomCode);
  const stub = c.env.WATCH_PARTY.get(id);
  return stub.fetch(c.req.raw);
});

watchPartyRoutes.all('/api/watch-party/:roomCode', async (c) => {
  const roomCode = (c.req.param('roomCode') || 'SALA').toUpperCase();
  if (!c.env.WATCH_PARTY) {
    return c.json({ error: 'Durable Object WATCH_PARTY não configurado' }, 503);
  }
  const id = c.env.WATCH_PARTY.idFromName(roomCode);
  const stub = c.env.WATCH_PARTY.get(id);
  return stub.fetch(c.req.raw);
});