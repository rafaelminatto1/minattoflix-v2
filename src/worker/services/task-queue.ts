import { getDb, type Env } from '../db';

export async function enqueueTask(env: Env, kind: 'scan' | 'covers') {
  const sql = getDb(env);
  const rows = await sql`
    INSERT INTO app_tasks (dedupe_key, kind) VALUES (${kind}, ${kind})
    ON CONFLICT (dedupe_key) WHERE status IN ('queued','running')
    DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
    RETURNING id, kind, status, attempts, created_at
  `;
  return rows[0];
}

/** Atomic claim, fenced completion and bounded retries. Processing is at-least-once. */
export async function runNextTask(env: Env, handlers: Record<'scan' | 'covers', () => Promise<unknown>>) {
  const sql = getDb(env);
  const token = crypto.randomUUID();
  const rows = await sql`
    UPDATE app_tasks SET status = 'running', attempts = attempts + 1,
      lease_token = ${token}::uuid, lease_until = now() + interval '15 minutes', updated_at = now()
    WHERE id = (
      SELECT id FROM app_tasks WHERE attempts < 3 AND available_at <= now()
        AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING id, kind, attempts
  `;
  if (!rows[0]) return { processed: false };
  const task = rows[0];
  try {
    const result = await handlers[task.kind as 'scan' | 'covers']();
    const summary = { ok: true, resultType: typeof result };
    await sql`UPDATE app_tasks SET status = 'completed', result = ${JSON.stringify(summary)}::jsonb,
      lease_until = NULL, updated_at = now() WHERE id = ${task.id} AND lease_token = ${token}::uuid`;
    return { processed: true, id: task.id, status: 'completed' };
  } catch {
    // Never persist upstream exception messages: they may contain private URLs/tokens.
    await sql`UPDATE app_tasks SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
      result = '{"error":"Falha no processamento; consulte o diagnóstico."}'::jsonb,
      available_at = now() + interval '15 minutes', lease_until = NULL, updated_at = now()
      WHERE id = ${task.id} AND lease_token = ${token}::uuid`;
    return { processed: true, id: task.id, status: Number(task.attempts) >= 3 ? 'failed' : 'queued' };
  }
}

export async function cleanupOperationalData(env: Env) {
  const sql = getDb(env);
  await sql`DELETE FROM app_rate_limits WHERE expires_at < now()`;
  await sql`DELETE FROM app_player_metrics WHERE day < current_date - 7`;
  await sql`DELETE FROM app_rooms WHERE updated_at < now() - interval '1 day'`;
  await sql`DELETE FROM app_room_events WHERE created_at < now() - interval '1 hour'`;
  await sql`DELETE FROM app_room_members WHERE seen_at < now() - interval '2 minutes'`;
  await sql`UPDATE app_tasks SET status = 'failed', updated_at = now()
    WHERE status = 'running' AND lease_until < now() AND attempts >= 3`;
  await sql`DELETE FROM app_tasks WHERE status IN ('completed','failed') AND updated_at < now() - interval '7 days'`;
}
