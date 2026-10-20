import { Hono } from 'hono';
import { getDb, type Env } from '../db';
import { accessConfigured, issueSession, readSession, sameSecret } from '../services/access';

export const operationsRoutes = new Hono<{ Bindings: Env }>();

/** Database-backed limiter, shared by instances. Never stores raw IP addresses. */
export async function allowOperation(env: Env, identity: string, maximum: number, seconds = 60) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const sql = getDb(env);
  const rows = await sql`INSERT INTO app_rate_limits (key, hits, expires_at)
    VALUES (${hash}, 1, now() + ${seconds} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN app_rate_limits.expires_at <= now() THEN 1 ELSE app_rate_limits.hits + 1 END,
      expires_at = CASE WHEN app_rate_limits.expires_at <= now() THEN EXCLUDED.expires_at ELSE app_rate_limits.expires_at END
    RETURNING hits`;
  return Number(rows[0].hits) <= maximum;
}

operationsRoutes.get('/api/session', async c => {
  const session = await readSession(c.req.raw, c.env);
  c.header('Cache-Control', 'no-store');
  return c.json({ configured: accessConfigured(c.env), authenticated: Boolean(session), role: session?.role || null, apiVersion: 1 });
});

operationsRoutes.post('/api/session', async c => {
  c.header('Cache-Control', 'no-store');
  if (!accessConfigured(c.env)) return c.json({ error: 'Configure os códigos de acesso no servidor.' }, 503);
  if (!await allowOperation(c.env, `login:${c.req.header('CF-Connecting-IP') || 'local'}`, 8, 900)) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Muitas tentativas. Aguarde 15 minutos.' }, 429);
  }
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  if (typeof body?.code !== 'string' || body.code.length > 200) return c.json({ error: 'Código inválido.' }, 400);
  const [admin, viewer] = await Promise.all([sameSecret(body.code, c.env.ADMIN_CODE!), sameSecret(body.code, c.env.ACCESS_CODE!)]);
  if (!admin && !viewer) return c.json({ error: 'Código inválido.' }, 401);
  const role = admin ? 'admin' : 'viewer';
  return c.json({ token: await issueSession(c.env, role), role, expiresIn: 86400 });
});

operationsRoutes.post('/api/player-events', async c => {
  if (!await allowOperation(c.env, `telemetry:${c.req.header('CF-Connecting-IP') || 'local'}`, 30)) return c.body(null, 429);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || !['start','waiting','error','ended'].includes(String(body.event)) || !['ios','android','web'].includes(String(body.platform))) return c.body(null, 400);
  const duration = Math.max(0, Math.min(3600000, Math.floor(Number(body.durationMs) || 0)));
  const sql = getDb(c.env);
  await sql`INSERT INTO app_player_metrics (platform,event,count,duration_ms) VALUES (${body.platform},${body.event},1,${duration})
    ON CONFLICT (day,platform,event) DO UPDATE SET count = app_player_metrics.count + 1,
      duration_ms = app_player_metrics.duration_ms + EXCLUDED.duration_ms`;
  return c.body(null, 204);
});

operationsRoutes.get('/api/admin/diagnostics', async c => {
  const sql = getDb(c.env);
  const [metrics, tasks] = await Promise.all([
    sql`SELECT * FROM app_player_metrics WHERE day >= current_date - 7 ORDER BY day DESC`,
    sql`SELECT id,kind,status,attempts,created_at,updated_at FROM app_tasks ORDER BY created_at DESC LIMIT 25`,
  ]);
  return c.json({ apiVersion: 1, costMode: c.env.COST_MODE || 'restricted', databaseDriver: 'neon-http', metrics, tasks });
});
