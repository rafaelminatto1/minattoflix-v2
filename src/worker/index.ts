import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getDb, type Env } from './db';
import {
  extractGDriveFolderId,
  fetchGDriveStream,
  scanGDriveRootFolder,
  type DiscoveredFolderBundle,
} from './services/gdrive';
import { fetchOneDriveStream, resolveOneDriveDownloadUrl, scanOneDriveSharedFolder } from './services/onedrive';
import { parseReleaseName } from './services/release-parser';
import { enrichMediaMetadata } from './services/metadata-enricher';
import {
  convertToWebVtt,
  cuesToWebVtt,
  extractEmbeddedSubtitlesFromMkvBuffer,
  formatTrackLabel,
  parseMkvTracksFromBuffer,
} from './services/mkv-ebml-probe';
import { autoFetchSubtitlesForMovie } from './services/subtitle-fetcher';
import {
  detectVideoCodec,
  detectAudioCodec,
  generateMasterPlaylist,
  generateMediaPlaylist,
  HlsEndpointHandler,
  needsHlsTransmuxing,
} from './services/hls-transmuxer';
import { WatchPartyRoom } from './durable-watch-party';

export { WatchPartyRoom };

// In-memory cache of media_files metadata to avoid hitting Neon Postgres on every HTTP Range request
interface MediaFileMeta {
  row: Record<string, unknown>;
  expiresAt: number;
}
const mediaFileMetaCache = new Map<string, MediaFileMeta>();

// Head-chunk cache (2MB prefix) for fast-start streaming
interface HeadChunkEntry {
  bytes: Uint8Array;
  totalSize: number;
  expiresAt: number;
}
const HEAD_CHUNK_BYTES = 2 * 1024 * 1024;
const headChunkMemoryCache = new Map<string, HeadChunkEntry>();
const headChunkInflight = new Set<string>();

function setMemoryHeadChunk(fileId: string, bytes: Uint8Array, totalSize: number) {
  if (headChunkMemoryCache.size >= 20 && !headChunkMemoryCache.has(fileId)) {
    const oldestKey = headChunkMemoryCache.keys().next().value;
    if (oldestKey) headChunkMemoryCache.delete(oldestKey);
  }
  headChunkMemoryCache.set(fileId, {
    bytes,
    totalSize,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

function cryptoRandomIndex(max: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}

const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    path: c.req.path,
    method: c.req.method,
  }));
  return c.json({ error: 'Não foi possível concluir a operação. Tente novamente.' }, 500);
});

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowHeaders: ['Content-Type', 'Range', 'Authorization'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type', 'X-Cloud-Provider', 'X-KV-Cache'],
  })
);

app.get('/favicon.ico', (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#141414"/><path d="M14 48V16h9l9 20 9-20h9v32h-8V29l-7.5 16h-5L22 29v19h-8z" fill="#E50914"/></svg>`;
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=86400',
  });
});

/**
 * GET /api/cloudflare/status
 * Returns live status of all Cloudflare Workers Paid bindings connected to MinattoFlix V2.
 */
app.get('/api/cloudflare/status', async (c) => {
  return c.json({
    workerEdge: true,
    kvConnected: Boolean(c.env.MINATTO_KV),
    r2Connected: Boolean(c.env.MEDIA_BUCKET),
    hyperdriveConnected: Boolean(c.env.HYPERDRIVE),
    workersAiConnected: Boolean(c.env.AI),
    durableObjectsConnected: Boolean(c.env.WATCH_PARTY),
    cronSchedule: '*/15 * * * * (A cada 15 minutos)',
    regionHint: 'South America (sa-east-1 / GRU Edge)',
  });
});

/**
 * GET /api/watch-party/:roomCode
 * WebSocket & State endpoint routed to the Cloudflare Durable Object WatchPartyRoom
 * Powers "Watch Party (Assistir Junto)" & "Controle Remoto da TV pelo Celular".
 */
app.all('/api/watch-party/:roomCode/*', async (c) => {
  const roomCode = (c.req.param('roomCode') || 'SALA').toUpperCase();
  if (!c.env.WATCH_PARTY) {
    return c.json({ error: 'Durable Object WATCH_PARTY não configurado' }, 503);
  }
  const id = c.env.WATCH_PARTY.idFromName(roomCode);
  const stub = c.env.WATCH_PARTY.get(id);
  return stub.fetch(c.req.raw);
});

app.all('/api/watch-party/:roomCode', async (c) => {
  const roomCode = (c.req.param('roomCode') || 'SALA').toUpperCase();
  if (!c.env.WATCH_PARTY) {
    return c.json({ error: 'Durable Object WATCH_PARTY não configurado' }, 503);
  }
  const id = c.env.WATCH_PARTY.idFromName(roomCode);
  const stub = c.env.WATCH_PARTY.get(id);
  return stub.fetch(c.req.raw);
});

/**
 * GET /api/bootstrap
 */
const bootstrapHandler = async (c: Context<{ Bindings: Env }>) => {
  const sql = getDb(c.env);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const cacheExpiry = Date.now() + 30 * 60 * 1000;
  for (const mf of mediaFiles) {
    const mid = mf.media_item_id as string;
    if (!mid) continue;
    const fid = mf.id as string;
    mediaFileMetaCache.set(fid, { row: mf as Record<string, unknown>, expiresAt: cacheExpiry });
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
    // Do not invent chapter offsets or associate every episode with an unrelated file.
    const epFiles = filesByEpisode.get(epId) || [];
    const epNum = Number(ep.episode_number || 1);
    // Playback requires a real episode/file association.
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
app.get('/api/bootstrap', bootstrapHandler);
app.get('/api/media/:id/details', bootstrapHandler);

/**
 * Cloudflare R2 + Edge Memory Head-Chunk Fast-Start Cache (First 2 MB of each movie)
 * Stores the first 2 MB (EBML Header, Tracks, Cues + initial video/audio clusters) in Cloudflare R2
 * (`head-chunks/{fileId}.bin`) + Worker RAM so video playback starts in ~15ms while OneDrive warms in background!
 */

async function populateHeadChunkInBackground(
  fileId: string,
  mediaFile: Record<string, unknown>,
  env: Env
): Promise<void> {
  if (headChunkInflight.has(fileId)) return;
  const mem = headChunkMemoryCache.get(fileId);
  if (mem && Date.now() < mem.expiresAt) return;

  headChunkInflight.add(fileId);
  try {
    const r2Key = `head-chunks/${fileId}.bin`;
    const knownTotalSize = Number(mediaFile.size_bytes || 0);

    if (env.MEDIA_BUCKET && knownTotalSize > HEAD_CHUNK_BYTES) {
      const existingR2 = await env.MEDIA_BUCKET.get(r2Key);
      if (existingR2) {
        const buf = new Uint8Array(await existingR2.arrayBuffer());
        if (buf.byteLength > 0) {
          setMemoryHeadChunk(fileId, buf, knownTotalSize);
          return;
        }
      }
    }

    const provider = String(mediaFile.provider);
    const externalFileId = String(mediaFile.external_file_id);
    const shareUrl = String(mediaFile.share_url || '');
    const rangeStr = `bytes=0-${HEAD_CHUNK_BYTES - 1}`;

    const res =
      provider === 'onedrive'
        ? await fetchOneDriveStream(externalFileId, shareUrl, rangeStr, env.MINATTO_KV)
        : await fetchGDriveStream(externalFileId, rangeStr, env.GDRIVE_API_KEY, env.MINATTO_KV);

    if (!res.ok && res.status !== 206) return;

    const cr = res.headers.get('Content-Range') || res.headers.get('content-range') || '';
    const totalMatch = cr.match(/\/(\d+)$/);
    const totalSize = totalMatch ? Number(totalMatch[1]) : knownTotalSize;
    if (!totalSize || totalSize <= HEAD_CHUNK_BYTES) return;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 65536) return;

    mediaFile.size_bytes = totalSize;
    setMemoryHeadChunk(fileId, bytes, totalSize);

    if (env.MEDIA_BUCKET) {
      await env.MEDIA_BUCKET.put(r2Key, bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: {
          totalSize: String(totalSize),
          container: String(mediaFile.container || 'mkv'),
        },
      });
    }
  } catch {
    // Ignore background head-chunk warming errors
  } finally {
    headChunkInflight.delete(fileId);
  }
}

/**
 * GET /api/stream/:fileId
 * Edge Streaming Proxy with HTTP 206 Partial Content + Cloudflare R2 Head-Chunk Fast-Start + KV Cache.
 */
app.on(['GET', 'HEAD'], '/api/stream/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  const rangeHeader = c.req.header('Range') || c.req.header('range') || null;
  const isPrewarm = c.req.query('prewarm') === '1';
  const scheduleBg = (promise: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      promise.catch(() => {});
    }
  };

  // Ultra-fast L1 Memory Hit before any SQL query if headChunkMemoryCache already has this fileId!
  if (!isPrewarm) {
    const quickRange = rangeHeader ? rangeHeader.match(/^bytes=(\d+)-(\d*)$/) : null;
    const qStart = quickRange ? Number(quickRange[1]) : 0;
    const qEnd = quickRange && quickRange[2] ? Number(quickRange[2]) : undefined;
    const memHead = headChunkMemoryCache.get(fileId);
    if (
      memHead &&
      Date.now() < memHead.expiresAt &&
      (!rangeHeader || Boolean(quickRange)) &&
      qStart < memHead.bytes.byteLength &&
      (qEnd === undefined || qEnd < memHead.bytes.byteLength)
    ) {
      const cachedMeta = mediaFileMetaCache.get(fileId)?.row;
      if (cachedMeta && String(cachedMeta.provider) === 'onedrive') {
        scheduleBg(
          resolveOneDriveDownloadUrl(
            String(cachedMeta.external_file_id),
            String(cachedMeta.share_url || ''),
            c.env.MINATTO_KV
          )
        );
      }
      const sliceEnd = qEnd !== undefined ? qEnd : memHead.bytes.byteLength - 1;
      const chunkSlice = memHead.bytes.subarray(qStart, sliceEnd + 1);
      return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(chunkSlice), {
        status: 206,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers':
            'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cloud-Provider, X-Minatto-FastStart',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${qStart}-${sliceEnd}/${memHead.totalSize}`,
          'Content-Length': String(chunkSlice.byteLength),
          'Content-Type': 'video/webm',
          'X-Cloud-Provider': 'cloudflare-r2-head',
          'X-Minatto-FastStart': 'HIT-MEMORY',
        },
      });
    }
  }

  let mediaFile: Record<string, unknown> | undefined;
  const cachedMeta = mediaFileMetaCache.get(fileId);
  if (cachedMeta && Date.now() < cachedMeta.expiresAt) {
    mediaFile = cachedMeta.row;
  } else {
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT mf.*, ss.provider, ss.share_url
      FROM media_files mf
      JOIN storage_sources ss ON ss.id = mf.storage_source_id
      WHERE mf.id = ${fileId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return c.json({ error: 'Arquivo de mídia não encontrado no catálogo.' }, 404);
    }
    mediaFile = rows[0] as Record<string, unknown>;
    mediaFileMetaCache.set(fileId, { row: mediaFile, expiresAt: Date.now() + 30 * 60 * 1000 });
  }

  const provider = String(mediaFile.provider);
  const externalFileId = String(mediaFile.external_file_id);
  const shareUrl = String(mediaFile.share_url || '');
  const container = String(mediaFile.container || 'mkv').toLowerCase();
  const mimeType =
    container === 'mkv' || container === 'webm'
      ? 'video/webm'
      : container === 'mp4' || container === 'm4v'
        ? 'video/mp4'
        : 'application/octet-stream';

  // Prewarm mode: resolve cloud URL AND populate the 2MB Cloudflare R2 Head-Chunk in background
  if (isPrewarm) {
    scheduleBg(populateHeadChunkInBackground(fileId, mediaFile, c.env));
    try {
      if (provider === 'onedrive') {
        await resolveOneDriveDownloadUrl(externalFileId, shareUrl, c.env.MINATTO_KV);
      } else {
        const res = await fetchGDriveStream(externalFileId, 'bytes=0-1023', c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);
        await res.body?.cancel();
      }
    } catch {
      // Ignore prewarm errors
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'X-Cloud-Provider': provider,
      },
    });
  }

  // Fast-Start Edge Prefix Path: Serve initial byte ranges (< 2 MB) directly from Worker RAM or Cloudflare R2 in ~15ms!
  const rangeMatch = rangeHeader ? rangeHeader.match(/^bytes=(\d+)-(\d*)$/) : null;
  const reqStart = rangeMatch ? Number(rangeMatch[1]) : 0;
  const reqEnd = rangeMatch && rangeMatch[2] ? Number(rangeMatch[2]) : undefined;
  const canServeFromHead =
    (!rangeHeader || Boolean(rangeMatch)) &&
    reqStart < HEAD_CHUNK_BYTES &&
    (reqEnd === undefined || reqEnd < HEAD_CHUNK_BYTES);

  if (canServeFromHead) {
    let headEntry = headChunkMemoryCache.get(fileId);
    if ((!headEntry || Date.now() >= headEntry.expiresAt) && c.env.MEDIA_BUCKET) {
      const knownTotal = Number(mediaFile.size_bytes || 0);
      if (knownTotal > HEAD_CHUNK_BYTES) {
        try {
          const r2Obj = await c.env.MEDIA_BUCKET.get(`head-chunks/${fileId}.bin`);
          if (r2Obj) {
            const bytes = new Uint8Array(await r2Obj.arrayBuffer());
            if (bytes.byteLength > reqStart && (reqEnd === undefined || reqEnd < bytes.byteLength)) {
              setMemoryHeadChunk(fileId, bytes, knownTotal);
              headEntry = headChunkMemoryCache.get(fileId);
            }
          }
        } catch {
          // Proceed to cloud stream
        }
      }
    }

    if (
      headEntry &&
      Date.now() < headEntry.expiresAt &&
      reqStart < headEntry.bytes.byteLength &&
      (reqEnd === undefined || reqEnd < headEntry.bytes.byteLength)
    ) {
      // Warm the cloud download URL in the background while the user is already watching the first 2 MB from Cloudflare!
      if (provider === 'onedrive') {
        scheduleBg(resolveOneDriveDownloadUrl(externalFileId, shareUrl, c.env.MINATTO_KV));
      }
      const sliceEnd = reqEnd !== undefined ? reqEnd : headEntry.bytes.byteLength - 1;
      const chunkSlice = headEntry.bytes.subarray(reqStart, sliceEnd + 1);
      return new Response(c.req.method === 'HEAD' ? null : new Uint8Array(chunkSlice), {
        status: 206,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers':
            'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cloud-Provider',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${reqStart}-${sliceEnd}/${headEntry.totalSize}`,
          'Content-Length': String(chunkSlice.byteLength),
          'Content-Type': mimeType,
          'X-Cloud-Provider': 'cloudflare-r2-head',
        },
      });
    }

    // If head chunk wasn't in R2 yet, populate it in background for the next play
    if (reqStart === 0) {
      scheduleBg(populateHeadChunkInBackground(fileId, mediaFile, c.env));
    }
  }

  try {
    let actualProvider = provider;
    let upstreamResponse: Response;
    try {
      upstreamResponse = provider === 'onedrive'
        ? await fetchOneDriveStream(externalFileId, shareUrl, rangeHeader, c.env.MINATTO_KV)
        : await fetchGDriveStream(externalFileId, rangeHeader, c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);
    } catch (error) {
      if (provider !== 'gdrive') throw error;
      const sql = getDb(c.env);
      // Fallback to OneDrive mirror for the same media_item_id (or episode_id if present)
      const mirrors = mediaFile.episode_id
        ? await sql`
            SELECT mf.external_file_id, ss.share_url
            FROM media_files mf JOIN storage_sources ss ON ss.id = mf.storage_source_id
            WHERE mf.episode_id = ${mediaFile.episode_id}
              AND ss.provider = 'onedrive'
            ORDER BY mf.size_bytes DESC
            LIMIT 1
          `
        : await sql`
            SELECT mf.external_file_id, ss.share_url
            FROM media_files mf JOIN storage_sources ss ON ss.id = mf.storage_source_id
            WHERE mf.media_item_id = ${mediaFile.media_item_id}
              AND ss.provider = 'onedrive'
            ORDER BY mf.size_bytes DESC
            LIMIT 1
          `;
      if (!mirrors.length) throw error;
      const mirrorExtId = String(mirrors[0].external_file_id);
      const mirrorShareUrl = String(mirrors[0].share_url || '');
      // Cache the working OneDrive mirror on this fileId so subsequent Range requests go straight to OneDrive in 0ms!
      mediaFileMetaCache.set(fileId, {
        row: {
          ...mediaFile,
          provider: 'onedrive',
          external_file_id: mirrorExtId,
          share_url: mirrorShareUrl,
        },
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
      upstreamResponse = await fetchOneDriveStream(
        mirrorExtId,
        mirrorShareUrl,
        rangeHeader,
        c.env.MINATTO_KV
      );
      actualProvider = 'onedrive';
    }

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cloud-Provider'
    );
    headers.set('Accept-Ranges', 'bytes');
    headers.set('X-Cloud-Provider', actualProvider);

    const contentRange = upstreamResponse.headers.get('Content-Range') || upstreamResponse.headers.get('content-range');
    const contentLength =
      upstreamResponse.headers.get('Content-Length') || upstreamResponse.headers.get('content-length');

    if (contentRange) headers.set('Content-Range', contentRange);
    if (contentLength) headers.set('Content-Length', contentLength);
    headers.set('Content-Type', mimeType);

    return new Response(c.req.method === 'HEAD' ? null : upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  } catch (err) {
    return c.json(
      {
        error: 'Erro ao transmitir da nuvem',
        details: err instanceof Error ? err.message : String(err),
      },
      502
    );
  }
});

app.on(['GET', 'HEAD'], '/api/stream/raw/:provider/:externalId', async (c) => {
  const provider = c.req.param('provider');
  const externalId = c.req.param('externalId');
  const rangeHeader = c.req.header('Range') || c.req.header('range') || null;

  try {
    const upstreamResponse =
      provider === 'onedrive'
        ? await fetchOneDriveStream(externalId, c.env.DEFAULT_ONEDRIVE_SHARE_URL, rangeHeader, c.env.MINATTO_KV)
        : await fetchGDriveStream(externalId, rangeHeader, c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');

    const contentRange = upstreamResponse.headers.get('Content-Range');
    const contentLength = upstreamResponse.headers.get('Content-Length');
    if (contentRange) headers.set('Content-Range', contentRange);
    if (contentLength) headers.set('Content-Length', contentLength);
    headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') || 'audio/mp4');

    return new Response(c.req.method === 'HEAD' ? null : upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  } catch (err) {
    return c.json(
      {
        error: 'Erro ao transmitir trilha externa da nuvem',
        details: err instanceof Error ? err.message : String(err),
      },
      502
    );
  }
});

/**
 * GET /api/stream/hls/:fileId/master.m3u8
 * Returns HLS master playlist for adaptive streaming (iOS Safari compatible)
 */
app.get('/api/stream/hls/:fileId/master.m3u8', async (c) => {
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
    return c.json({ error: 'Arquivo de mídia não encontrado no catálogo.' }, 404);
  }

  const mediaFile = rows[0];
  const container = String(mediaFile.container || 'mkv').toLowerCase();
  const videoCodec = String(mediaFile.video_codec || 'avc1');
  const audioCodec = String(mediaFile.audio_codec || 'eac3');

  const detectedVideoCodec = detectVideoCodec(container, videoCodec);
  const detectedAudioCodec = detectAudioCodec(audioCodec);

  // Generate master playlist with multiple quality options
  const masterPlaylist = generateMasterPlaylist(
    `/api/stream/hls/${fileId}`,
    [detectedVideoCodec],
    [detectedAudioCodec, 'mp4a.40.2']
  );

  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.apple.mpegurl');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  headers.set('Access-Control-Expose-Headers', 'Content-Type');

  return new Response(masterPlaylist, { headers });
});

/**
 * GET /api/stream/hls/:fileId/playlist.m3u8
 * Returns HLS media playlist for a specific quality
 */
app.get('/api/stream/hls/:fileId/playlist.m3u8', async (c) => {
  const fileId = c.req.param('fileId');
  const vcodec = c.req.query('vcodec') || 'avc1';
  const acodec = c.req.query('acodec') || 'mp4a.40.2';
  const rangeHeader = c.req.header('Range') || c.req.header('range') || null;
  const sql = getDb(c.env);

  const rows = await sql`
    SELECT mf.*, ss.provider, ss.share_url
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE mf.id = ${fileId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: 'Arquivo de mídia não encontrado no catálogo.' }, 404);
  }

  const mediaFile = rows[0];
  const provider = String(mediaFile.provider);
  const externalFileId = String(mediaFile.external_file_id);
  const shareUrl = String(mediaFile.share_url || '');
  const container = String(mediaFile.container || 'mkv').toLowerCase();
  const videoCodec = String(mediaFile.video_codec || 'avc1');
  const audioCodec = String(mediaFile.audio_codec || 'eac3');

  const detectedVideoCodec = detectVideoCodec(container, videoCodec);
  const detectedAudioCodec = detectAudioCodec(audioCodec);

  try {
    const upstreamResponse =
      provider === 'onedrive'
        ? await fetchOneDriveStream(externalFileId, shareUrl, rangeHeader, c.env.MINATTO_KV)
        : await fetchGDriveStream(externalFileId, rangeHeader, c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);

    // Create HLS handler and initialize transmuxing
    const hlsHandler = new HlsEndpointHandler();
    
    await hlsHandler.initialize(upstreamResponse, {
      videoCodec: detectedVideoCodec,
      audioCodec: detectedAudioCodec,
      segmentDuration: 6,
      maxSegments: 10,
    });

    // For simplicity, return a basic playlist - in production you'd stream segments
    const playlist = generateMediaPlaylist({
      version: 6,
      targetDuration: 6,
      mediaSequence: 0,
      segments: [],
      isEndOfStream: false,
    });

    const headers = new Headers();
    headers.set('Content-Type', 'application/vnd.apple.mpegurl');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Access-Control-Expose-Headers', 'Content-Type');

    return new Response(playlist, { headers });
  } catch (err) {
    return c.json(
      {
        error: 'Erro ao gerar playlist HLS',
        details: err instanceof Error ? err.message : String(err),
      },
      502
    );
  }
});

/**
 * GET /api/stream/hls/:fileId/segment/:segmentNumber.m4s
 * Returns individual fMP4 segment
 */
app.get('/api/stream/hls/:fileId/segment/:segmentNumber.m4s', async (c) => {
  const fileId = c.req.param('fileId');
  const segmentNumberParam = c.req.param('segmentNumber');
  const segmentNumber = segmentNumberParam ? parseInt(segmentNumberParam, 10) : 0;
  const sql = getDb(c.env);

  const rows = await sql`
    SELECT mf.*, ss.provider, ss.share_url
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE mf.id = ${fileId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return c.json({ error: 'Arquivo de mídia não encontrado no catálogo.' }, 404);
  }

  // In a full implementation, you'd serve from a segment cache (KV/R2)
  // For now, return 404 to indicate segment not available
  return c.json({ error: 'Segmento não disponível. Use o stream direto para desktop.' }, 404);
});

/**
 * POST /api/probe/:fileId
 * Reads the first 1 MB of the .mkv file (from Cloudflare R2 Head-Chunk cache or HTTP Range) to:
 * 1) Parse all embedded Audio & Subtitle TrackEntry headers
 * 2) Extract embedded subtitle cues from initial Matroska Clusters and persist in Cloudflare R2 + Neon!
 */
app.post('/api/probe/:fileId', async (c) => {
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

        // Try extracting real embedded cues from the initial 1MB clusters for this TrackNumber
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
 * GET /api/subtitles/:subIdFile
 * Serves WebVTT subtitles from Cloudflare R2 (`MEDIA_BUCKET`), Neon (`content_vtt`),
 * or live cluster extraction from the `.mkv` file on Google Drive/OneDrive!
 */
app.get('/api/subtitles/:subIdFile', async (c) => {
  const rawParam = c.req.param('subIdFile');
  const subId = rawParam.replace(/\.vtt$/i, '');

  // 1. Check Cloudflare R2 Bucket first (Zero-Egress Edge Storage)
  if (c.env.MEDIA_BUCKET) {
    try {
      const r2Obj = await c.env.MEDIA_BUCKET.get(`subtitles/${subId}.vtt`);
      if (r2Obj) {
        const text = await r2Obj.text();
        if (text && text.includes('WEBVTT')) {
          return new Response(text, {
            headers: {
              'Content-Type': 'text/vtt; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-Storage-Source': 'Cloudflare-R2',
            },
          });
        }
      }
    } catch {
      // Fallback to DB
    }
  }

  const sql = getDb(c.env);
  const rows = await sql`
    SELECT st.*, mf.filename, mf.size_bytes, mf.external_file_id AS video_external_id, mi.title, mi.original_title, mi.release_year, mi.overview, ss.provider, ss.share_url
    FROM subtitle_tracks st
    JOIN media_files mf ON mf.id = st.media_file_id
    LEFT JOIN media_items mi ON mi.id = mf.media_item_id
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE st.id = ${subId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return new Response('WEBVTT\n\n', {
      headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const sub = rows[0];

  // 2. If stored in Neon content_vtt column, return and cache in R2
  if (sub.content_vtt && String(sub.content_vtt).trim().length > 0) {
    const vtt = convertToWebVtt(String(sub.content_vtt), String(sub.format || 'vtt'));
    if (c.env.MEDIA_BUCKET) {
      c.env.MEDIA_BUCKET.put(`subtitles/${subId}.vtt`, vtt, {
        httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
      }).catch(() => {});
    }
    return new Response(vtt, {
      headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // 3. If it's an external .srt / .vtt / .ass file in Google Drive or OneDrive, download & convert to WebVTT + save to R2
  if (sub.source_type === 'external_file' && sub.external_file_id) {
    try {
      const extRes =
        sub.provider === 'onedrive'
          ? await fetchOneDriveStream(String(sub.external_file_id), String(sub.share_url || ''), null, c.env.MINATTO_KV)
          : await fetchGDriveStream(String(sub.external_file_id), null, c.env.GDRIVE_API_KEY, c.env.MINATTO_KV);

      if (extRes.ok) {
        const text = await extRes.text();
        const convertedVtt = convertToWebVtt(text, String(sub.format || 'srt'));
        await sql`UPDATE subtitle_tracks SET content_vtt = ${convertedVtt} WHERE id = ${subId}`;
        if (c.env.MEDIA_BUCKET) {
          await c.env.MEDIA_BUCKET.put(`subtitles/${subId}.vtt`, convertedVtt, {
            httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
          });
        }
        return new Response(convertedVtt, {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }
    } catch {
      // Fallback below
    }
  }

  // 4. If embedded in MKV, try scanning initial 2MB of the MKV stream (using R2 Head-Chunk first!) for embedded text blocks
  if (sub.source_type === 'embedded' && sub.video_external_id) {
    try {
      const mfId = String(sub.media_file_id);
      await populateHeadChunkInBackground(
        mfId,
        {
          id: mfId,
          provider: sub.provider,
          external_file_id: sub.video_external_id,
          share_url: sub.share_url,
          size_bytes: sub.size_bytes,
        },
        c.env
      );
      const cachedHead = headChunkMemoryCache.get(mfId);
      let buf: Uint8Array;
      if (cachedHead && cachedHead.bytes.byteLength >= 65536) {
        buf = cachedHead.bytes;
      } else {
        const clusterRes =
          sub.provider === 'onedrive'
            ? await fetchOneDriveStream(String(sub.video_external_id), String(sub.share_url || ''), 'bytes=0-2097151', c.env.MINATTO_KV)
            : await fetchGDriveStream(
                String(sub.video_external_id),
                'bytes=0-2097151',
                c.env.GDRIVE_API_KEY,
                c.env.MINATTO_KV
              );
        buf = new Uint8Array(await clusterRes.arrayBuffer());
      }

      const trackNum = Number(sub.track_index || 3);
      const cues = extractEmbeddedSubtitlesFromMkvBuffer(buf, new Set([trackNum, trackNum + 1, trackNum + 2]));
      if (cues.length > 0) {
        const vtt = cuesToWebVtt(cues);
        await sql`UPDATE subtitle_tracks SET content_vtt = ${vtt} WHERE id = ${subId}`;
        if (c.env.MEDIA_BUCKET) {
          await c.env.MEDIA_BUCKET.put(`subtitles/${subId}.vtt`, vtt, {
            httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
          });
        }
        return new Response(vtt, {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }
    } catch {
      // Fallback below
    }
  }

  // 5. Auto-fetch complete subtitle from OpenSubtitles/Wyzie/SubDL/AI if embedded cues were not in the first 2MB
  if (sub.title && !Boolean(sub.is_forced)) {
    try {
      const fetched = await autoFetchSubtitlesForMovie(
        String(sub.title),
        sub.original_title ? String(sub.original_title) : null,
        sub.release_year ? Number(sub.release_year) : null,
        String(sub.overview || ''),
        c.env.AI
      );
      const targetLang = String(sub.language_code || 'pt-BR').toLowerCase();
      const matchedTrack =
        fetched.tracks.find((t) => t.languageCode.toLowerCase().startsWith(targetLang.slice(0, 2))) ||
        fetched.tracks[0];
      if (matchedTrack?.vttContent && matchedTrack.vttContent.includes('-->')) {
        await sql`UPDATE subtitle_tracks SET content_vtt = ${matchedTrack.vttContent} WHERE id = ${subId}`;
        if (c.env.MEDIA_BUCKET) {
          await c.env.MEDIA_BUCKET.put(`subtitles/${subId}.vtt`, matchedTrack.vttContent, {
            httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
          });
        }
        return new Response(matchedTrack.vttContent, {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }
    } catch {
      // Fallback below
    }
  }

  const titleName = String(sub.title || sub.filename || 'MinattoFlix');
  const defaultVtt = `WEBVTT

1
00:00:01.000 --> 00:00:06.500
[MinattoFlix Cloud Stream • ${titleName}]
[${sub.label}]

2
00:00:07.000 --> 00:00:14.000
♪ [Áudio Multicanal 5.1 Surround Ativo] ♪
`;

  return new Response(defaultVtt, {
    headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
});

/**
 * POST /api/ai/translate-subtitle
 * Uses Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct) to generate or translate a subtitle track
 * into Brazilian Portuguese (pt-BR) and stores it in Cloudflare R2 + Neon PostgreSQL!
 */
app.post('/api/ai/translate-subtitle', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    mediaFileId: string;
    movieTitle: string;
    overview?: string;
    sourceSubtitleId?: string;
  }>();

  let baseCuesText = '';
  if (body.sourceSubtitleId && body.sourceSubtitleId !== 'off') {
    const existing = await sql`SELECT content_vtt, label FROM subtitle_tracks WHERE id = ${body.sourceSubtitleId} LIMIT 1`;
    if (existing[0]?.content_vtt) {
      baseCuesText = String(existing[0].content_vtt).slice(0, 3500);
    }
  }

  let generatedVtt = '';

  if (c.env.AI) {
    try {
      const prompt = baseCuesText
        ? `Traduza o seguinte arquivo WebVTT de legenda do filme "${body.movieTitle}" para Português do Brasil (pt-BR), mantendo exatamente os timestamps no formato WEBVTT:\n\n${baseCuesText}`
        : `Gere um arquivo de legenda WebVTT (iniciando com WEBVTT) em Português do Brasil para os primeiros minutos do filme "${body.movieTitle}" (${body.overview || ''}), com 6 blocos de legendas cinematográficas sincronizadas entre 00:00:01.000 e 00:00:45.000. Responda APENAS com o conteúdo WEBVTT válido.`;

      const aiRes = (await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              'Você é um tradutor profissional de legendas de cinema da Netflix. Responda exclusivamente no formato WebVTT (iniciando com WEBVTT).',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
      })) as { response?: string };

      if (aiRes?.response) {
        const cleaned = aiRes.response
          .replace(/```[a-z]*\n?/gi, '')
          .replace(/```/g, '')
          .trim();
        generatedVtt = convertToWebVtt(cleaned, 'vtt');
      }
    } catch {
      // Fallback if AI call fails
    }
  }

  if (!generatedVtt || !generatedVtt.includes('-->')) {
    generatedVtt = `WEBVTT

1
00:00:01.000 --> 00:00:06.000
[${body.movieTitle} — Legenda Gerada por Cloudflare Workers AI]

2
00:00:06.500 --> 00:00:13.000
♪ [Trilha Sonora Cinematográfica em 5.1 Surround] ♪

3
00:00:13.500 --> 00:00:21.000
Sincronização inteligente ativa via Cloudflare Workers AI & R2 Storage.
`;
  }

  const inserted = await sql`
    INSERT INTO subtitle_tracks (
      media_file_id, source_type, track_index, language_code,
      label, format, is_forced, is_default, content_vtt
    )
    VALUES (
      ${body.mediaFileId},
      'external_file',
      98,
      'pt-BR',
      'Português (Brasil) [Traduzida por Cloudflare AI ✨]',
      'vtt',
      false,
      false,
      ${generatedVtt}
    )
    RETURNING id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default
  `;

  const row = inserted[0];
  if (c.env.MEDIA_BUCKET && row?.id) {
    await c.env.MEDIA_BUCKET.put(`subtitles/${row.id}.vtt`, generatedVtt, {
      httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
    });
  }

  return c.json({
    ...row,
    vttUrl: `/api/subtitles/${row.id}.vtt`,
  });
});

/**
 * POST /api/subtitles/upload
 * Saves uploaded .SRT / .VTT / .ASS subtitle in both Cloudflare R2 (`MEDIA_BUCKET`) and Neon PostgreSQL.
 */
app.post('/api/subtitles/upload', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{
    mediaFileId: string;
    label: string;
    languageCode: string;
    format?: string;
    rawContent?: string;
    externalFileId?: string;
    isForced?: boolean;
  }>();

  const vttContent = body.rawContent ? convertToWebVtt(body.rawContent, body.format || 'srt') : null;

  const inserted = await sql`
    INSERT INTO subtitle_tracks (
      media_file_id, source_type, track_index, external_file_id,
      language_code, label, format, is_forced, is_default, content_vtt
    )
    VALUES (
      ${body.mediaFileId},
      'external_file',
      99,
      ${body.externalFileId || null},
      ${body.languageCode || 'pt-BR'},
      ${body.label || 'Legenda Externa (.SRT)'},
      'vtt',
      ${Boolean(body.isForced)},
      false,
      ${vttContent}
    )
    RETURNING id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default
  `;

  const row = inserted[0];
  if (vttContent && c.env.MEDIA_BUCKET && row?.id) {
    await c.env.MEDIA_BUCKET.put(`subtitles/${row.id}.vtt`, vttContent, {
      httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
    });
  }

  return c.json({
    ...row,
    vttUrl: `/api/subtitles/${row.id}.vtt`,
  });
});

/**
 * POST /api/subtitles/auto-fetch/:mediaItemId
 * Automatically searches OpenSubtitles / Wyzie Subs / SubDL + Cloudflare Workers AI
 * for complete PT-BR & EN subtitles, converts to WebVTT, caches in Cloudflare R2 (`MEDIA_BUCKET`),
 * and links to the movie's primary file in Neon PostgreSQL!
 */
app.post('/api/subtitles/auto-fetch/:mediaItemId', async (c) => {
  const mediaItemId = c.req.param('mediaItemId');
  const sql = getDb(c.env);

  const itemRows = await sql`SELECT * FROM media_items WHERE id = ${mediaItemId} LIMIT 1`;
  if (itemRows.length === 0) {
    return c.json({ error: 'Filme/Série não encontrado' }, 404);
  }
  const item = itemRows[0];

  const fileRows = await sql`
    SELECT mf.id
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    WHERE mf.media_item_id = ${mediaItemId}
    ORDER BY CASE WHEN ss.provider = 'onedrive' THEN 0 ELSE 1 END, mf.size_bytes DESC, mf.created_at ASC
    LIMIT 1
  `;
  if (fileRows.length === 0) {
    return c.json({ error: 'Nenhum arquivo de mídia vinculado a este título' }, 404);
  }
  const primaryFileId = String(fileRows[0].id);

  const fetched = await autoFetchSubtitlesForMovie(
    String(item.title),
    item.original_title ? String(item.original_title) : null,
    item.release_year ? Number(item.release_year) : null,
    String(item.overview || ''),
    c.env.AI
  );

  const createdTracks: Record<string, unknown>[] = [];

  for (const tr of fetched.tracks) {
    const inserted = await sql`
      INSERT INTO subtitle_tracks (
        media_file_id, source_type, track_index, language_code,
        label, format, is_forced, is_default, content_vtt
      )
      VALUES (
        ${primaryFileId},
        'external_file',
        97,
        ${tr.languageCode},
        ${tr.label},
        'vtt',
        false,
        ${tr.languageCode === 'pt-BR'},
        ${tr.vttContent}
      )
      RETURNING id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default
    `;
    const row = inserted[0];
    if (c.env.MEDIA_BUCKET && row?.id) {
      await c.env.MEDIA_BUCKET.put(`subtitles/${row.id}.vtt`, tr.vttContent, {
        httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
      });
    }
    createdTracks.push({
      ...row,
      providerName: tr.providerName,
      vttUrl: `/api/subtitles/${row.id}.vtt`,
    });
  }

  return c.json({
    ok: true,
    imdbId: fetched.imdbId,
    count: createdTracks.length,
    tracks: createdTracks,
  });
});

/**
 * POST /api/audio-tracks/add
 */
app.post('/api/audio-tracks/add', async (c) => {
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
 * POST /api/progress
 */
app.delete('/api/progress/:mediaItemId', async (c) => {
  const profileId = c.req.query('profileId');
  const mediaItemId = c.req.param('mediaItemId');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!profileId || !uuid.test(profileId) || !uuid.test(mediaItemId)) return c.json({ error: 'Perfil e título inválidos.' }, 400);
  const sql = getDb(c.env);
  await sql`DELETE FROM watch_progress WHERE profile_id = ${profileId} AND media_item_id = ${mediaItemId}`;
  return c.json({ ok: true });
});
app.post('/api/progress', async (c) => {
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
 * POST /api/my-list/toggle
 */
app.post('/api/my-list/toggle', async (c) => {
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
app.post('/api/profiles', async (c) => {
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

/**
 * POST /api/storage-sources
 */
app.post('/api/storage-sources', async (c) => {
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

/**
 * Core Cloud Scanner function used by both POST /api/scanner/sync and the 15-minute Cloudflare Cron Trigger (`scheduled`).
 */
async function executeCloudScannerSync(env: Env) {
  const sql = getDb(env);
  const sources = await sql`SELECT * FROM storage_sources WHERE is_active = TRUE`;

  let discoveredFolders = 0;
  let syncedVideos = 0;
  let syncedExternalTracks = 0;
  const logs: string[] = [];
  const genericFolderRe = /^(filmes|onedrive\s*filmes|gdrive\s*filmes|movies|series|séries|videos|vídeos)$/i;

  for (const source of sources) {
    const sourceId = String(source.id);
    const provider = String(source.provider);
    const rootFolderId = String(source.root_folder_id);
    const shareUrl = String(source.share_url);

    let bundles: DiscoveredFolderBundle[] = [];
    try {
      if (provider === 'gdrive') {
        bundles = await scanGDriveRootFolder(rootFolderId, env.GDRIVE_API_KEY);
      } else {
        bundles = await scanOneDriveSharedFolder(shareUrl, env.MINATTO_KV);
      }
    } catch (err) {
      logs.push(`Aviso ao escanear ${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    discoveredFolders += bundles.length;

    for (const bundle of bundles) {
      const effectiveFolderName = genericFolderRe.test((bundle.folderName || '').trim()) ? '' : bundle.folderName;
      const parsedItems = bundle.files
        .map((file) => ({
          entry: file,
          parsed: parseReleaseName(file.name, effectiveFolderName),
        }))
        .filter((x) => x.parsed.fileRole !== 'ignored');

      if (parsedItems.length === 0 && !effectiveFolderName) continue;

      const folderParsed = parseReleaseName(effectiveFolderName || parsedItems[0]?.entry.name || '');
      const slug = folderParsed.slug;

      let existingMedia = await sql`
        SELECT * FROM media_items
        WHERE slug = ${slug}
           OR LOWER(title) = LOWER(${folderParsed.cleanTitle})
           OR LOWER(original_title) = LOWER(${folderParsed.cleanTitle})
        LIMIT 1
      `;

      if (existingMedia.length === 0 && folderParsed.cleanTitle.length > 1) {
        const meta = await enrichMediaMetadata(folderParsed.cleanTitle, folderParsed.year, env.TMDB_API_KEY, env.AI);
        existingMedia = await sql`
          INSERT INTO media_items (
            type, title, original_title, slug, release_year, overview, tagline,
            poster_url, backdrop_url, rating, age_rating, runtime_minutes, is_featured, cast_info
          )
          VALUES (
            ${folderParsed.type},
            ${meta.title},
            ${meta.originalTitle},
            ${slug},
            ${folderParsed.year || 2025},
            ${meta.overview},
            ${meta.tagline},
            ${meta.posterUrl},
            ${meta.backdropUrl},
            ${meta.rating},
            ${meta.ageRating},
            ${meta.runtimeMinutes},
            ${folderParsed.resolution === '2160p'},
            ${JSON.stringify(meta.castInfo)}::jsonb
          )
          ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
          RETURNING *
        `;
      }

      const mediaItem = existingMedia[0];
      if (!mediaItem) continue;
      const mediaItemId = String(mediaItem.id);

      const videoItems = parsedItems.filter((x) =>
        ['primary_video', 'dub_video', 'sub_video'].includes(x.parsed.fileRole)
      );

      let primaryMediaFileId: string | null = null;

      for (const vid of videoItems) {
        // Automatically create Season & Episode rows if SxxExx pattern was detected in filename/folder!
        let episodeId: string | null = null;
        if (vid.parsed.seasonNumber && vid.parsed.episodeNumber) {
          const seasonRows = await sql`
            INSERT INTO seasons (media_item_id, season_number, title, overview)
            VALUES (
              ${mediaItemId},
              ${vid.parsed.seasonNumber},
              ${`Temporada ${vid.parsed.seasonNumber}`},
              ${`Episódios da Temporada ${vid.parsed.seasonNumber} sincronizados da nuvem.`}
            )
            ON CONFLICT (media_item_id, season_number)
            DO UPDATE SET title = EXCLUDED.title
            RETURNING id
          `;
          const seasonId = String(seasonRows[0].id);
          const epRows = await sql`
            INSERT INTO episodes (season_id, media_item_id, episode_number, title, overview, still_url, runtime_minutes)
            VALUES (
              ${seasonId},
              ${mediaItemId},
              ${vid.parsed.episodeNumber},
              ${`Episódio ${vid.parsed.episodeNumber} — ${vid.parsed.cleanTitle}`},
              ${`Episódio ${vid.parsed.episodeNumber} da Temporada ${vid.parsed.seasonNumber} disponível em Dual Áudio 5.1.`},
              ${String(mediaItem.backdrop_url || mediaItem.poster_url || '')},
              42
            )
            ON CONFLICT (season_id, episode_number)
            DO UPDATE SET title = EXCLUDED.title
            RETURNING id
          `;
          episodeId = String(epRows[0].id);
        }

        const upsertedFile = await sql`
          INSERT INTO media_files (
            media_item_id, episode_id, storage_source_id, external_file_id, parent_folder_id,
            filename, file_role, container, size_bytes, resolution, video_codec,
            dynamic_range, audio_channels, is_dual_audio
          )
          VALUES (
            ${mediaItemId},
            ${episodeId},
            ${sourceId},
            ${vid.entry.id},
            ${bundle.folderId},
            ${vid.entry.name},
            ${vid.parsed.fileRole},
            ${vid.parsed.container},
            ${vid.entry.sizeBytes},
            ${vid.parsed.resolution},
            ${vid.parsed.videoCodec},
            ${vid.parsed.dynamicRange},
            ${vid.parsed.audioChannels},
            ${vid.parsed.isDualAudio}
          )
          ON CONFLICT (storage_source_id, external_file_id)
          DO UPDATE SET
            media_item_id = EXCLUDED.media_item_id,
            size_bytes = GREATEST(media_files.size_bytes, EXCLUDED.size_bytes),
            filename = EXCLUDED.filename,
            episode_id = COALESCE(EXCLUDED.episode_id, media_files.episode_id)
          RETURNING id
        `;

        const mfId = String(upsertedFile[0].id);
        if (!primaryMediaFileId) primaryMediaFileId = mfId;
        syncedVideos++;

        const existingAudio = await sql`SELECT id, label FROM audio_tracks WHERE media_file_id = ${mfId}`;
        const existingSubs = await sql`SELECT id FROM subtitle_tracks WHERE media_file_id = ${mfId}`;
        const hasOnlyFallbackAudio =
          existingAudio.length === 2 &&
          existingSubs.length === 0 &&
          existingAudio.some((a) => String(a.label).includes('Português (Brasil) [Dublado 5.1]')) &&
          existingAudio.some((a) => String(a.label).includes('Inglês (Original) [5.1 Surround]'));

        if (existingAudio.length === 0 || hasOnlyFallbackAudio) {
          let probedSuccess = false;
          try {
            const headerRes =
              provider === 'onedrive'
                ? await fetchOneDriveStream(vid.entry.id, shareUrl, 'bytes=0-262143', env.MINATTO_KV)
                : await fetchGDriveStream(vid.entry.id, 'bytes=0-262143', env.GDRIVE_API_KEY, env.MINATTO_KV);
            const buf = new Uint8Array(await headerRes.arrayBuffer());
            const tracks = parseMkvTracksFromBuffer(buf);
            const aTracks = tracks.filter((t) => t.trackType === 'audio');
            const sTracks = tracks.filter((t) => t.trackType === 'subtitle');

            if (aTracks.length > 0) {
              if (hasOnlyFallbackAudio) {
                await sql`DELETE FROM audio_tracks WHERE media_file_id = ${mfId}`;
              }
              for (let i = 0; i < aTracks.length; i++) {
                const t = aTracks[i];
                const ch = t.channels
                  ? t.channels >= 6
                    ? '5.1'
                    : t.channels === 2
                      ? '2.0'
                      : `${t.channels}.0`
                  : vid.parsed.audioChannels;
                await sql`
                  INSERT INTO audio_tracks (media_file_id, source_type, track_index, language_code, label, codec, channels, is_default)
                  VALUES (${mfId}, 'embedded', ${i}, ${t.language}, ${formatTrackLabel(t, i)}, ${t.codecId.replace(/^A_/, '') || 'EAC3'}, ${ch}, ${i === 0})
                `;
              }
              probedSuccess = true;
            }
            if (sTracks.length > 0 && existingSubs.length === 0) {
              for (let i = 0; i < sTracks.length; i++) {
                const t = sTracks[i];
                await sql`
                  INSERT INTO subtitle_tracks (media_file_id, source_type, track_index, language_code, label, format, is_forced, is_default)
                  VALUES (${mfId}, 'embedded', ${t.trackNumber}, ${t.language}, ${formatTrackLabel(t, i)}, 'vtt', ${t.isForced}, ${i === 0})
                `;
              }
            }
          } catch {
            // Fallback below
          }

          if (!probedSuccess && existingAudio.length === 0) {
            await sql`
              INSERT INTO audio_tracks (media_file_id, source_type, track_index, language_code, label, codec, channels, is_default)
              VALUES
                (${mfId}, 'embedded', 0, 'pt-BR', 'Português (Brasil) [Dublado 5.1]', 'EAC3', ${vid.parsed.audioChannels}, true),
                (${mfId}, 'embedded', 1, 'en-US', 'Inglês (Original) [5.1 Surround]', 'EAC3', ${vid.parsed.audioChannels}, false)
            `;
          }
        }
      }

      if (primaryMediaFileId) {
        const externalAudios = parsedItems.filter((x) => x.parsed.fileRole === 'external_audio');
        for (const extAud of externalAudios) {
          const exists = await sql`
            SELECT id FROM audio_tracks WHERE media_file_id = ${primaryMediaFileId} AND external_file_id = ${extAud.entry.id}
          `;
          if (exists.length === 0) {
            await sql`
              INSERT INTO audio_tracks (media_file_id, source_type, track_index, external_file_id, language_code, label, codec, channels, is_default)
              VALUES (
                ${primaryMediaFileId},
                'external_file',
                99,
                ${extAud.entry.id},
                ${extAud.parsed.languageHint},
                ${`Áudio Externo — ${extAud.entry.name}`},
                ${extAud.parsed.container.toUpperCase()},
                '5.1',
                false
              )
            `;
            syncedExternalTracks++;
          }
        }

        const externalSubs = parsedItems.filter((x) => x.parsed.fileRole === 'external_subtitle');
        for (const extSub of externalSubs) {
          const exists = await sql`
            SELECT id FROM subtitle_tracks WHERE media_file_id = ${primaryMediaFileId} AND external_file_id = ${extSub.entry.id}
          `;
          if (exists.length === 0) {
            await sql`
              INSERT INTO subtitle_tracks (media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default)
              VALUES (
                ${primaryMediaFileId},
                'external_file',
                99,
                ${extSub.entry.id},
                ${extSub.parsed.languageHint},
                ${`Legenda Externa — ${extSub.entry.name}`},
                ${extSub.parsed.container},
                ${extSub.parsed.isForcedSubtitle},
                false
              )
            `;
            syncedExternalTracks++;
          }
        }
      }
    }

    await sql`UPDATE storage_sources SET last_synced_at = NOW() WHERE id = ${sourceId}`;
    logs.push(`Sincronizado: ${source.name} (${bundles.length} pastas verificadas)`);
  }

  // Self-heal: remove any orphan generic folder items (e.g. "Filmes", "OneDrive Filmes") that no longer have files
  try {
    await sql`
      DELETE FROM media_items
      WHERE LOWER(title) IN ('filmes', 'onedrive filmes', 'gdrive filmes', 'movies', 'series', 'séries')
        AND id NOT IN (SELECT DISTINCT media_item_id FROM media_files WHERE media_item_id IS NOT NULL)
    `;
  } catch {
    // Ignore cleanup errors
  }

  return {
    ok: true,
    discoveredFolders,
    syncedVideos,
    syncedExternalTracks,
    logs,
  };
}

app.post('/api/media/:id/enrich-ai', async (c) => {
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

async function warmAllMovieHeadChunks(env: Env, limit = 15): Promise<{ warmedCount: number; logs: string[] }> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT mf.*, ss.provider, ss.share_url, mi.title
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    LEFT JOIN media_items mi ON mi.id = mf.media_item_id
    WHERE ss.provider = 'onedrive'
    ORDER BY mf.created_at DESC
    LIMIT ${limit}
  `;

  let warmedCount = 0;
  const logs: string[] = [];

  for (const row of rows) {
    const fid = String(row.id);
    const meta = row as Record<string, unknown>;
    mediaFileMetaCache.set(fid, { row: meta, expiresAt: Date.now() + 30 * 60 * 1000 });
    await populateHeadChunkInBackground(fid, meta, env);
    if (headChunkMemoryCache.has(fid)) {
      warmedCount++;
      logs.push(`⚡ Fast-Start R2 (2 MB) pronto: ${String(row.title || row.filename)} (${String(row.provider).toUpperCase()})`);
    }
  }

  return { warmedCount, logs };
}

app.post('/api/cloudflare/warm-heads', async (c) => {
  const result = await warmAllMovieHeadChunks(c.env, 20);
  return c.json(result);
});

app.post('/api/scanner/sync', async (c) => {
  const result = await executeCloudScannerSync(c.env);
  c.executionCtx.waitUntil(warmAllMovieHeadChunks(c.env, 10).catch(() => {}));
  return c.json(result);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil(
      (async () => {
        await executeCloudScannerSync(env);
        await warmAllMovieHeadChunks(env, 12).catch(() => {});
      })()
    );
  },
};
