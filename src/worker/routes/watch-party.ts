import { Hono } from 'hono';
import { getDb, type Env } from '../db';
import { allowOperation } from './operations';

export const watchPartyRoutes = new Hono<{ Bindings: Env }>();

/**
 * WebSocket & State endpoint routed to the Cloudflare Durable Object WatchPartyRoom
 * Powers "Watch Party (Assistir Junto)" & "Controle Remoto da TV pelo Celular"
 */
const codePattern = /^[A-Z0-9-]{4,32}$/;
const clientPattern = /^[a-zA-Z0-9-]{8,64}$/;

// Polling uses only the existing Neon database. No Durable Object is invoked.
watchPartyRoutes.get('/api/watch-party/:roomCode', async c => {
  const code = c.req.param('roomCode').toUpperCase();
  const clientId = c.req.query('clientId') || '';
  const cursor = c.req.query('cursor');
  if (!codePattern.test(code) || !clientPattern.test(clientId) || (cursor !== undefined && !/^\d{1,20}$/.test(cursor))) return c.json({ error: 'Sala inválida.' }, 400);
  const sql = getDb(c.env);
  await sql`INSERT INTO app_room_members(room_code,client_id)
    SELECT code, ${clientId} FROM app_rooms WHERE code = ${code}
    ON CONFLICT(room_code,client_id) DO UPDATE SET seen_at = now()
    WHERE app_room_members.seen_at < now() - interval '30 seconds'`;
  const [room, events, members] = await Promise.all([
    sql`SELECT state, (SELECT COALESCE(MAX(id),0)::text FROM app_room_events WHERE room_code = ${code}) AS cursor FROM app_rooms WHERE code = ${code}`,
    cursor === undefined ? Promise.resolve([]) : sql`SELECT id::text, sender, payload FROM app_room_events WHERE room_code = ${code} AND id > ${cursor}::bigint ORDER BY id LIMIT 100`,
    sql`SELECT count(*)::int AS count FROM app_room_members WHERE room_code = ${code} AND seen_at > now() - interval '90 seconds'`,
  ]);
  return c.json({ state: room[0]?.state || null, cursor: events.at(-1)?.id || cursor || room[0]?.cursor || '0', events, participants: members[0]?.count || 1 });
});

watchPartyRoutes.post('/api/watch-party/:roomCode', async c => {
  const code = c.req.param('roomCode').toUpperCase();
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!codePattern.test(code) || !body || !clientPattern.test(String(body.clientId))) return c.json({ error: 'Sala inválida.' }, 400);
  if (!await allowOperation(c.env, `room:${c.req.header('CF-Connecting-IP') || 'local'}`, 40)) return c.body(null, 429);
  const senderName = String(body.senderName || 'Participante').slice(0,60);
  let payload: Record<string, unknown>;
  if (body.type === 'sync_state') {
    if (typeof body.playing !== 'boolean' || !Number.isFinite(body.currentTime) || Number(body.currentTime) < 0 || Number(body.currentTime) > 604800) return c.body(null,400);
    payload = { type: 'sync_state', senderName, payload: { roomCode: code,
      mediaItemId: String(body.mediaItemId || '').slice(0,64), mediaTitle: String(body.mediaTitle || '').slice(0,200),
      playing: body.playing, currentTime: Number(body.currentTime), selectedAudioId: String(body.selectedAudioId || '').slice(0,64),
      selectedSubtitleId: String(body.selectedSubtitleId || '').slice(0,64), updatedAt: Date.now() } };
  } else if (body.type === 'chat') {
    payload = { type: 'chat', senderName, chatText: String(body.chatText || '').slice(0,500), timestamp: new Date().toISOString() };
  } else if (body.type === 'remote_command' && ['toggle_play','skip_forward','skip_back','set_audio','set_subtitle'].includes(String(body.command))) {
    payload = { type: 'remote_command', senderName, command: body.command, value: typeof body.value === 'string' ? body.value.slice(0,64) : null };
  } else return c.body(null,400);
  const sql = getDb(c.env);
  const initial = body.type === 'sync_state' ? JSON.stringify(payload.payload) : '{}';
  await sql`INSERT INTO app_rooms(code,state) VALUES (${code},${initial}::jsonb)
    ON CONFLICT(code) DO UPDATE SET state = CASE WHEN ${body.type} = 'sync_state' THEN EXCLUDED.state ELSE app_rooms.state END, updated_at = now()`;
  await sql`INSERT INTO app_room_events(room_code,sender,payload) VALUES (${code},${String(body.clientId)},${JSON.stringify(payload)}::jsonb)`;
  return c.json({ ok: true });
});
