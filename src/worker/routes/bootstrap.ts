import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { enrichMediaMetadata } from '../services/metadata-enricher';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const bootstrapRoutes = new Hono<{ Bindings: Env }>();

/**
 * Core bootstrap handler for /api/bootstrap and /api/media/:id/details
 */
const bootstrapHandler = async (c: Context<{ Bindings: Env }>) => {
  const sql = getDb(c.env);
  const rawProfileId = c.req.query('profileId');
  const profileId = rawProfileId && uuidRe.test(rawProfileId) ? rawProfileId : undefined;
  const rawMediaId = c.req.param('id') || null;
  if (rawMediaId && !uuidRe.test(rawMediaId)) {
    return c.json({ error: 'Identificador de mídia inválido.' }, 400);
  }
  const mediaId = rawMediaId;
  const summary = !mediaId && c.req.query('summary') === 'true';

  const [
    profiles,
    storageSources,
    genres,
    mediaItems,
    mediaGenres,
    mediaFiles,
    audioTracks,
    subtitleTracks,
    seasonsRows,
    episodesRows,
  ] = await Promise.all([
    sql`SELECT * FROM profiles ORDER BY created_at ASC`,
    sql`SELECT * FROM storage_sources ORDER BY created_at ASC`,
    sql`SELECT * FROM genres ORDER BY id ASC`,
    sql`SELECT * FROM media_items WHERE (${mediaId}::uuid IS NULL OR id = ${mediaId}::uuid) ORDER BY created_at DESC, title ASC`,
    sql`SELECT mg.media_item_id, g.id, g.name, g.slug FROM media_genres mg JOIN genres g ON g.id = mg.genre_id WHERE (${mediaId}::uuid IS NULL OR mg.media_item_id = ${mediaId}::uuid)`,
    sql`SELECT mf.*, ss.provider, ss.name AS storage_name, ss.share_url
        FROM media_files mf
        JOIN storage_sources ss ON ss.id = mf.storage_source_id
        WHERE (${mediaId}::uuid IS NULL OR mf.media_item_id = ${mediaId}::uuid)
        ORDER BY CASE WHEN ss.provider = 'onedrive' THEN 0 ELSE 1 END, mf.size_bytes DESC, mf.created_at ASC`,
    sql`SELECT * FROM audio_tracks WHERE media_file_id IN (SELECT id FROM media_files WHERE (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid)) ORDER BY is_default DESC, track_index ASC`,
    sql`SELECT id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default
        FROM subtitle_tracks
        WHERE media_file_id IN (SELECT id FROM media_files WHERE (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid))
        ORDER BY is_default DESC, track_index ASC`,
    summary ? Promise.resolve([]) : sql`SELECT * FROM seasons WHERE (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid) ORDER BY season_number ASC`,
    summary ? Promise.resolve([]) : sql`SELECT * FROM episodes WHERE (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid) ORDER BY episode_number ASC`,
  ]);

  const activeProfileId = profileId || (profiles[0]?.id as string | undefined);

  const [watchProgressRows, myListRows] = activeProfileId
    ? await Promise.all([
        sql`SELECT * FROM watch_progress WHERE profile_id = ${activeProfileId} AND (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid) ORDER BY updated_at DESC`,
        sql`SELECT media_item_id FROM my_list WHERE profile_id = ${activeProfileId} AND (${mediaId}::uuid IS NULL OR media_item_id = ${mediaId}::uuid)`,
      ])
    : [[], []];

  const myListSet = new Set(myListRows.map((r) => r.media_item_id as string));
  const progressMap = new Map(watchProgressRows.map((r) => [r.media_item_id as string, r]));

  const genresByMedia = new Map<string, Array<{ id: number; name: string; slug: string }>>();
  for (const mg of mediaGenres) {
    const mid = mg.media_item_id as string;
    const list = genresByMedia.get(mid) || [];
    list.push({ id: Number(mg.id), name: String(mg.name), slug: String(mg.slug) });
    genresByMedia.set(mid, list);
  }

  const providerByFileId = new Map<string, string>();
  for (const mf of mediaFiles) {
    providerByFileId.set(String(mf.id), String(mf.provider || 'gdrive'));
  }

  const audioByFile = new Map<string, Record<string, unknown>[]>();
  for (const at of audioTracks) {
    const fid = at.media_file_id as string;
    const list = audioByFile.get(fid) || [];
    const extId = at.external_file_id ? String(at.external_file_id) : null;
    const parentProv = providerByFileId.get(fid) || 'gdrive';
    const extProv = extId && (extId.includes('!') || parentProv === 'onedrive') ? 'onedrive' : 'gdrive';
    list.push({
      ...at,
      externalStreamUrl: extId ? `/api/stream/raw/${extProv}/${extId}` : null,
    });
    audioByFile.set(fid, list);
  }

  const subsByFile = new Map<string, Record<string, unknown>[]>();
  for (const st of subtitleTracks) {
    const fid = st.media_file_id as string;
    const list = subsByFile.get(fid) || [];
    list.push({
      ...st,
      vttUrl: `/api/subtitles/${st.id}.vtt`,
    });
    subsByFile.set(fid, list);
  }

  const filesByMedia = new Map<string, Record<string, unknown>[]>();
  const filesByEpisode = new Map<string, Record<string, unknown>[]>();
  for (const mf of mediaFiles) {
    const mid = mf.media_item_id as string;
    if (!mid) continue;
    const fid = mf.id as string;
    const hydratedFile = {
      ...mf,
      size_bytes: Number(mf.size_bytes || 0),
      streamUrl: `/api/stream/${fid}`,
      audioTracks: audioByFile.get(fid) || [],
      subtitleTracks: subsByFile.get(fid) || [],
    };
    const list = filesByMedia.get(mid) || [];
    list.push(hydratedFile);
    filesByMedia.set(mid, list);

    if (mf.episode_id) {
      const epId = String(mf.episode_id);
      const epList = filesByEpisode.get(epId) || [];
      epList.push(hydratedFile);
      filesByEpisode.set(epId, epList);
    }
  }

  const episodesBySeason = new Map<string, Record<string, unknown>[]>();
  for (const ep of episodesRows) {
    const sid = String(ep.season_id);
    const epId = String(ep.id);
    const mid = String(ep.media_item_id);
    const epFiles = filesByEpisode.get(epId) || [];
    const epNum = Number(ep.episode_number || 1);
    const startOffsetSec = 0;

    const list = episodesBySeason.get(sid) || [];
    list.push({
      ...ep,
      episode_number: epNum,
      runtime_minutes: Number(ep.runtime_minutes || 24),
      startOffsetSec,
      files: epFiles,
    });
    episodesBySeason.set(sid, list);
  }

  const seasonsByMedia = new Map<string, Record<string, unknown>[]>();
  for (const s of seasonsRows) {
    const mid = String(s.media_item_id);
    const sid = String(s.id);
    const list = seasonsByMedia.get(mid) || [];
    list.push({
      ...s,
      season_number: Number(s.season_number || 1),
      episodes: episodesBySeason.get(sid) || [],
    });
    seasonsByMedia.set(mid, list);
  }

  const catalog = mediaItems.map((item) => {
    const mid = item.id as string;
    const itemFiles = filesByMedia.get(mid) || [];
    const allAudioTracks = itemFiles.flatMap((f) => (f.audioTracks as Record<string, unknown>[]) || []);
    const allSubtitleTracks = itemFiles.flatMap((f) => (f.subtitleTracks as Record<string, unknown>[]) || []);
    const itemSeasons = seasonsByMedia.get(mid) || [];

    return {
      ...item,
      rating: Number(item.rating || 0),
      detailsLoaded: !summary,
      genres: genresByMedia.get(mid) || [],
      files: itemFiles,
      audioTracks: allAudioTracks,
      subtitleTracks: allSubtitleTracks,
      seasons: itemSeasons,
      progress: progressMap.get(mid) || null,
      inMyList: myListSet.has(mid),
      isAvailable: itemFiles.length > 0,
    };
  });

  return c.json({
    profiles,
    activeProfileId,
    storageSources,
    genres,
    catalog,
  });
};

bootstrapRoutes.get('/api/bootstrap', bootstrapHandler);
bootstrapRoutes.get('/api/media/:id/details', bootstrapHandler);

/**
 * POST /api/media/:id/enrich-ai
 */
bootstrapRoutes.post('/api/media/:id/enrich-ai', async (c) => {
  const mediaId = c.req.param('id');
  const sql = getDb(c.env);
  const rows = await sql`SELECT * FROM media_items WHERE id = ${mediaId} LIMIT 1`;
  if (rows.length === 0) {
    return c.json({ error: 'Mídia não encontrada' }, 404);
  }
  const item = rows[0];
  let newOverview = String(item.overview || '');
  let newTagline = String(item.tagline || '');

  if (c.env.AI) {
    try {
      const aiRes = (await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              'Você é redator oficial do catálogo da Netflix Brasil. Escreva em Português do Brasil no formato exato:\nTAGLINE: <frase curta de impacto>\nSINOPSE: <sinopse envolvente de 2 a 3 frases sobre o filme>',
          },
          {
            role: 'user',
            content: `Filme: "${item.title}" (Título original: "${item.original_title || item.title}", Ano: ${item.release_year || 2025}).`,
          },
        ],
        max_tokens: 300,
      })) as { response?: string };

      if (aiRes?.response) {
        const text = aiRes.response.trim();
        const tagMatch = text.match(/TAGLINE:\s*(.+)/i);
        const synMatch = text.match(/SINOPSE:\s*([\s\S]+)/i);
        if (tagMatch?.[1]) {
          newTagline = tagMatch[1].replace(/^["']|["']$/g, '').trim();
        }
        if (synMatch?.[1]) {
          newOverview = synMatch[1].replace(/^["']|["']$/g, '').trim();
        }
      }
    } catch {
      // Keep existing overview/tagline
    }
  }

  const updated = await sql`
    UPDATE media_items
    SET overview = ${newOverview},
        tagline = ${newTagline},
        updated_at = NOW()
    WHERE id = ${mediaId}
    RETURNING *
  `;
  return c.json(updated[0]);
});

/**
 * GET /api/cloudflare/status
 */
bootstrapRoutes.get('/api/cloudflare/status', async (c) => {
  return c.json({
    workerEdge: true,
    kvConnected: Boolean(c.env.MINATTO_KV),
    r2Connected: Boolean(c.env.MEDIA_BUCKET),
    hyperdriveConnected: Boolean(c.env.HYPERDRIVE),
    workersAiConnected: Boolean(c.env.AI),
    durableObjectsConnected: Boolean(c.env.WATCH_PARTY),
    cronSchedule: '*/5 * * * * (A cada 5 minutos)',
    regionHint: 'South America (sa-east-1 / GRU Edge)',
  });
});

/**
 * GET /favicon.ico
 */
bootstrapRoutes.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141414"/><path d="M14 48V16h9l9 20 9-20h9v32h-8V29l-7.5 16h-5L22 29v19h-8z" fill="#E50914"/></svg>`;
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=86400',
  });
});