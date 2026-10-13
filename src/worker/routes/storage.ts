import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { extractGDriveFolderId } from '../services/gdrive';

export const storageRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/storage-sources
 */
storageRoutes.post('/api/storage-sources', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    name: string;
    provider: 'gdrive' | 'onedrive';
    shareUrl: string;
  }>();

  const rootFolderId =
    body.provider === 'gdrive' ? extractGDriveFolderId(body.shareUrl) : body.shareUrl.trim();

  const inserted = await sql`
    INSERT INTO storage_sources (name, provider, root_folder_id, share_url, is_active, last_synced_at)
    VALUES (${body.name}, ${body.provider}, ${rootFolderId}, ${body.shareUrl.trim()}, true, NOW())
    ON CONFLICT (provider, root_folder_id)
    DO UPDATE SET name = EXCLUDED.name, share_url = EXCLUDED.share_url, is_active = TRUE
    RETURNING *
  `;

  return c.json(inserted[0]);
});