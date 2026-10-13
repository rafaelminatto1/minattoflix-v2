import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';

function cryptoRandomIndex(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

export const profilesRoutes = new Hono<{ Bindings: Env }>();

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/progress
 */
profilesRoutes.post('/api/progress', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    profileId: string;
    mediaItemId: string;
    positionSeconds: number;
    durationSeconds: number;
    selectedAudioId?: string;
    selectedSubtitleId?: string;
  }>();

  if (!Number.isFinite(body.positionSeconds) || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0) return c.json({ error: 'Progresso inválido.' }, 400);
  const pos = Math.min(Math.floor(body.durationSeconds), Math.max(0, Math.floor(body.positionSeconds || 0)));
  const dur = Math.max(1, Math.floor(body.durationSeconds || 1));
  const isCompleted = pos / dur >= 0.92;

  const upserted = await sql`
    INSERT INTO watch_progress (
      profile_id, media_item_id, position_seconds, duration_seconds,
      is_completed, selected_audio_id, selected_subtitle_id, updated_at
    )
    VALUES (
      ${body.profileId}, ${body.mediaItemId}, ${pos}, ${dur},
      ${isCompleted}, ${body.selectedAudioId || null}, ${body.selectedSubtitleId || null}, NOW()
    )
    ON CONFLICT (profile_id, media_item_id)
    DO UPDATE SET
      position_seconds = EXCLUDED.position_seconds,
      duration_seconds = EXCLUDED.duration_seconds,
      is_completed = EXCLUDED.is_completed,
      selected_audio_id = COALESCE(EXCLUDED.selected_audio_id, watch_progress.selected_audio_id),
      selected_subtitle_id = COALESCE(EXCLUDED.selected_subtitle_id, watch_progress.selected_subtitle_id),
      updated_at = NOW()
    RETURNING *
  `;

  return c.json(upserted[0]);
});

/**
 * DELETE /api/progress/:mediaItemId
 */
profilesRoutes.delete('/api/progress/:mediaItemId', async (c) => {
  const profileId = c.req.query('profileId');
  const mediaItemId = c.req.param('mediaItemId');
  if (!profileId || !uuidRe.test(profileId) || !uuidRe.test(mediaItemId)) return c.json({ error: 'Perfil e título inválidos.' }, 400);
  const sql = getDb(c.env);
  await sql`DELETE FROM watch_progress WHERE profile_id = ${profileId} AND media_item_id = ${mediaItemId}`;
  return c.json({ ok: true });
});

/**
 * POST /api/my-list/toggle
 */
profilesRoutes.post('/api/my-list/toggle', async (c) => {
  const sql = getDb(c.env);
  const { profileId, mediaItemId } = await c.req.json<{ profileId: string; mediaItemId: string }>();

  const existing = await sql`
    SELECT id FROM my_list WHERE profile_id = ${profileId} AND media_item_id = ${mediaItemId}
  `;

  if (existing.length > 0) {
    await sql`DELETE FROM my_list WHERE profile_id = ${profileId} AND media_item_id = ${mediaItemId}`;
    return c.json({ inMyList: false });
  } else {
    await sql`INSERT INTO my_list (profile_id, media_item_id) VALUES (${profileId}, ${mediaItemId})`;
    return c.json({ inMyList: true });
  }
});

/**
 * POST /api/profiles
 */
profilesRoutes.post('/api/profiles', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    name: string;
    isKids?: boolean;
    preferredAudioLang?: string;
    preferredSubtitleLang?: string;
  }>();

  const colors = ['e50914', '0071eb', '2ecc71', 'f39c12', '9b59b6'];
  const color = colors[cryptoRandomIndex(colors.length)];
  const avatarUrl = `https://api.dicebear.com/9.x/fun-emoji/svg?seed=${encodeURIComponent(body.name)}&backgroundColor=${color}`;

  const created = await sql`
    INSERT INTO profiles (name, avatar_url, is_kids, preferred_audio_lang, preferred_subtitle_lang)
    VALUES (
      ${body.name.trim()},
      ${avatarUrl},
      ${Boolean(body.isKids)},
      ${body.preferredAudioLang || 'pt-BR'},
      ${body.preferredSubtitleLang || 'off'}
    )
    RETURNING *
  `;

  return c.json(created[0]);
});