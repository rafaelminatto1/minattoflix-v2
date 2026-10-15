import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { fetchGDriveStream } from '../services/gdrive';
import { fetchOneDriveStream } from '../services/onedrive';
import {
  parseMkvTracksFromBuffer,
  formatTrackLabel,
  extractEmbeddedSubtitlesFromMkvBuffer,
  cuesToWebVtt,
  convertToWebVtt,
} from '../services/mkv-ebml-probe';
import { populateHeadChunkInBackground, headChunkMemoryCache } from './stream';

export const mediaRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/probe/:fileId - Parse MKV header for embedded audio/subtitle tracks
 */
mediaRoutes.post('/api/probe/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  const sql = getDb(c.env);

  const rows = await sql`
    SELECT mf.*, ss.provider, ss.share_url
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE mf.id = ${fileId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: 'Arquivo não encontrado' }, 404);
  }

  const mediaFile = rows[0] as Record<string, unknown>;
  const provider = String(mediaFile.provider);
  const externalFileId = String(mediaFile.external_file_id);
  const shareUrl = String(mediaFile.share_url || '');

  try {
    await populateHeadChunkInBackground(fileId, mediaFile, c.env);
    const cachedHead = headChunkMemoryCache.get(fileId);
    let bytes: Uint8Array;

    if (cachedHead && cachedHead.bytes.byteLength >= 65536) {
      bytes = cachedHead.bytes.subarray(0, Math.min(1048576, cachedHead.bytes.byteLength));
    } else {
      const headerRes =
        provider === 'onedrive'
          ? await fetchOneDriveStream(externalFileId, shareUrl, 'bytes=0-1048575', c.env.MINATTO_KV)
          : await fetchGDriveStream(externalFileId, 'bytes=0-1048575', c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);

      const arrayBuf = await headerRes.arrayBuffer();
      bytes = new Uint8Array(arrayBuf);
    }

    const probedTracks = parseMkvTracksFromBuffer(bytes);

    const audioProbed = probedTracks.filter((t) => t.trackType === 'audio');
    const subProbed = probedTracks.filter((t) => t.trackType === 'subtitle');

    if (audioProbed.length > 0) {
      await sql`DELETE FROM audio_tracks WHERE media_file_id = ${fileId} AND source_type = 'embedded'`;
      for (let i = 0; i < audioProbed.length; i++) {
        const t = audioProbed[i];
        const label = formatTrackLabel(t, i);
        const channels = t.channels ? (t.channels >= 6 ? '5.1' : t.channels === 2 ? '2.0' : `${t.channels}.0`) : '5.1';
        const codec = t.codecId.replace(/^A_/, '') || 'EAC3';
        await sql`
          INSERT INTO audio_tracks (media_file_id, source_type, track_index, language_code, label, codec, channels, is_default)
          VALUES (${fileId}, 'embedded', ${i}, ${t.language}, ${label}, ${codec}, ${channels}, ${i === 0 || t.isDefault})
        `;
      }
    }

    if (subProbed.length > 0) {
      await sql`DELETE FROM subtitle_tracks WHERE media_file_id = ${fileId} AND source_type = 'embedded'`;
      for (let i = 0; i < subProbed.length; i++) {
        const t = subProbed[i];
        const label = formatTrackLabel(t, i);
        const fmt = t.codecId.includes('ASS') || t.codecId.includes('SSA') ? 'ass' : 'vtt';

        const extractedCues = extractEmbeddedSubtitlesFromMkvBuffer(bytes, new Set([t.trackNumber]));
        const extractedVtt = extractedCues.length > 0 ? cuesToWebVtt(extractedCues) : null;

        const insertedSub = await sql`
          INSERT INTO subtitle_tracks (media_file_id, source_type, track_index, language_code, label, format, is_forced, is_default, content_vtt)
          VALUES (${fileId}, 'embedded', ${t.trackNumber}, ${t.language}, ${label}, ${fmt}, ${t.isForced}, ${i === 0}, ${extractedVtt})
          RETURNING id
        `;

        if (extractedVtt && c.env.MEDIA_BUCKET && insertedSub[0]?.id) {
          await c.env.MEDIA_BUCKET.put(`subtitles/${insertedSub[0].id}.vtt`, extractedVtt, {
            httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
          });
        }
      }
    }

    await sql`UPDATE media_files SET tracks_probed = TRUE WHERE id = ${fileId}`;

    const [updatedAudio, updatedSubs] = await Promise.all([
      sql`SELECT * FROM audio_tracks WHERE media_file_id = ${fileId} ORDER BY track_index ASC`,
      sql`SELECT id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default
          FROM subtitle_tracks WHERE media_file_id = ${fileId} ORDER BY track_index ASC`,
    ]);

    return c.json({
      probedCount: probedTracks.length,
      probedRaw: probedTracks,
      audioTracks: updatedAudio,
      subtitleTracks: updatedSubs.map((st) => ({
        ...st,
        vttUrl: `/api/subtitles/${st.id}.vtt`,
      })),
    });
  } catch (err) {
    return c.json(
      {
        error: 'Falha ao inspecionar cabeçalho MKV',
        details: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

/**
 * POST /api/audio-tracks/add
 */
mediaRoutes.post('/api/audio-tracks/add', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    mediaFileId: string;
    sourceType: 'external_file' | 'alternate_video' | 'embedded';
    externalFileId: string;
    languageCode: string;
    label: string;
    channels?: string;
    codec?: string;
  }>();

  let cleanExternalId = (body.externalFileId || '').trim();
  const fileMatch =
    cleanExternalId.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || cleanExternalId.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fileMatch) cleanExternalId = fileMatch[1];

  const parentRows = await sql`
    SELECT ss.provider
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE mf.id = ${body.mediaFileId}
    LIMIT 1
  `;
  const parentProvider = String(parentRows[0]?.provider || 'gdrive');

  const inserted = await sql`
    INSERT INTO audio_tracks (
      media_file_id, source_type, track_index, external_file_id,
      language_code, label, codec, channels, is_default
    )
    VALUES (
      ${body.mediaFileId},
      ${body.sourceType || 'external_file'},
      99,
      ${cleanExternalId},
      ${body.languageCode || 'pt-BR'},
      ${body.label || 'Áudio Externo Sincronizado'},
      ${body.codec || 'AAC'},
      ${body.channels || '5.1'},
      false
    )
    RETURNING *
  `;

  const row = inserted[0];
  const extId = row.external_file_id ? String(row.external_file_id) : null;
  const extProv = extId && (extId.includes('!') || parentProvider === 'onedrive') ? 'onedrive' : 'gdrive';
  return c.json({
    ...row,
    externalStreamUrl: extId ? `/api/stream/raw/${extProv}/${extId}` : null,
  });
});

/**
 * GET /api/media/next-episode/:episodeId - Get next episode in series
 */
mediaRoutes.get('/api/media/next-episode/:episodeId', async (c) => {
  const episodeId = c.req.param('episodeId');
  const sql = getDb(c.env);

  // Get current episode info
  const currentRows = await sql`
    SELECT mi.*, mf.id as file_id, mf.episode_id, mf.media_item_id
    FROM media_items mi
    JOIN media_files mf ON mf.media_item_id = mi.id
    WHERE mf.episode_id = ${episodeId}
    LIMIT 1
  `;

  if (currentRows.length === 0) {
    return c.json({ error: 'Episódio não encontrado' }, 404);
  }

  const current = currentRows[0];
  const mediaItemId = current.media_item_id;
  const seasonNumber = current.season_number || 1;
  const episodeNumber = current.episode_number || 1;

  // Find next episode
  const nextRows = await sql`
    SELECT mi.*, mf.id as file_id
    FROM media_items mi
    JOIN media_files mf ON mf.media_item_id = mi.id
    WHERE mi.id = ${mediaItemId}
      AND mi.season_number = ${seasonNumber}
      AND mi.episode_number = ${episodeNumber + 1}
      AND mf.episode_id IS NOT NULL
    ORDER BY mi.episode_number ASC
    LIMIT 1
  `;

  if (nextRows.length === 0) {
    // Try next season
    const nextSeasonRows = await sql`
      SELECT mi.*, mf.id as file_id
      FROM media_items mi
      JOIN media_files mf ON mf.media_item_id = mi.id
      WHERE mi.id = ${mediaItemId}
        AND mi.season_number = ${seasonNumber + 1}
        AND mi.episode_number = 1
        AND mf.episode_id IS NOT NULL
      ORDER BY mi.episode_number ASC
      LIMIT 1
    `;

    if (nextSeasonRows.length === 0) {
      return c.json(null, 404);
    }
    return c.json(nextSeasonRows[0]);
  }

  return c.json(nextRows[0]);
});

/**
 * GET /api/media/continue-watching - Get continue watching row for profile
 */
mediaRoutes.get('/api/media/continue-watching', async (c) => {
  const sql = getDb(c.env);
  const profileId = c.req.query('profileId');
  
  if (!profileId) {
    return c.json({ error: 'profileId required' }, 400);
  }
  
  const rows = await sql`
    SELECT 
      mi.id,
      mi.title,
      mi.overview,
      mi.poster_url,
      mi.backdrop_url,
      mi.rating,
      mi.release_year,
      mi.age_rating,
      mi.duration_minutes,
      mi.media_type,
      mi.season_number,
      mi.episode_number,
      mi.episode_id,
      mf.id as file_id,
      mf.provider,
      mf.container,
      p.position_seconds,
      p.duration_seconds,
      p.selected_audio_id,
      p.selected_subtitle_id,
      p.updated_at
    FROM progress p
    JOIN media_items mi ON mi.id = p.media_item_id
    JOIN media_files mf ON mf.media_item_id = mi.id
    WHERE p.profile_id = ${profileId}
      AND p.position_seconds > 60
      AND p.is_completed = FALSE
      AND mf.episode_id IS NOT NULL
    ORDER BY p.updated_at DESC
    LIMIT 20
  `;
  
  const movieRows = await sql`
    SELECT 
      mi.id,
      mi.title,
      mi.overview,
      mi.poster_url,
      mi.backdrop_url,
      mi.rating,
      mi.release_year,
      mi.age_rating,
      mi.duration_minutes,
      mi.media_type,
      mf.id as file_id,
      mf.provider,
      mf.container,
      p.position_seconds,
      p.duration_seconds,
      p.selected_audio_id,
      p.selected_subtitle_id,
      p.updated_at
    FROM progress p
    JOIN media_items mi ON mi.id = p.media_item_id
    JOIN media_files mf ON mf.media_item_id = mi.id
    WHERE p.profile_id = ${profileId}
      AND p.position_seconds > 60
      AND p.is_completed = FALSE
      AND (mi.media_type = 'movie' OR mf.episode_id IS NULL)
    ORDER BY p.updated_at DESC
    LIMIT 10
  `;
  
  return c.json({
    series: rows,
    movies: movieRows,
  });
});

/**
 * GET /api/metrics/playback-quality - Get playback quality metrics (admin)
 */
mediaRoutes.get('/api/metrics/playback-quality', async (c) => {
  const sql = getDb(c.env);
  const hours = Number(c.req.query('hours') || '24');
  const since = Date.now() - hours * 60 * 60 * 1000;
  
  // This would require a metrics table - for now return mock structure
  return c.json({
    message: 'Playback quality dashboard - implement metrics collection',
    suggestedMetrics: {
      startupTime: 'Time from click to first frame',
      rebufferRatio: 'Rebuffer duration / total watch time',
      errorRate: 'Errors per 1000 plays',
      avgBitrate: 'Average bitrate delivered',
      qualitySwitches: 'Manual/auto quality changes per session',
      syncDrift: 'Audio/video sync drift reports',
      completionRate: 'Percentage of videos watched to 90%+',
      providerPerformance: 'Latency/errors by provider (GDrive/OneDrive)',
      codecPerformance: 'Performance by codec (H264/HEVC/VP9/AV1)',
      devicePerformance: 'Performance by device type',
    },
  });
});

/**
 * POST /api/metrics - Ingest custom metrics from client
 */
mediaRoutes.post('/api/metrics', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      value: number;
      url?: string;
      timestamp?: number;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    }>();
    
    // Log structured metric
    console.log(JSON.stringify({
      level: 'metric',
      event: body.name,
      value: body.value,
      url: body.url,
      timestamp: body.timestamp || Date.now(),
      sessionId: body.sessionId,
      metadata: body.metadata,
    }));
    
    // In production, store in analytics DB (ClickHouse, BigQuery, etc.)
    // For now just acknowledge
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Invalid metric payload' }, 400);
  }
});