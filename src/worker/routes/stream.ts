import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { fetchGDriveStream } from '../services/gdrive';
import { fetchOneDriveStream, resolveOneDriveDownloadUrl } from '../services/onedrive';
import {
  detectVideoCodec,
  detectAudioCodec,
  generateMasterPlaylist,
  generateMediaPlaylist,
  HlsEndpointHandler,
} from '../services/hls-transmuxer';

export { populateHeadChunkInBackground, headChunkMemoryCache, HEAD_CHUNK_BYTES, setMemoryHeadChunk };

interface MediaFileMeta {
  row: Record<string, unknown>;
  expiresAt: number;
}
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

export const streamRoutes = new Hono<{ Bindings: Env }>();

const mediaFileMetaCache = new Map<string, MediaFileMeta>();

/**
 * GET /api/stream/:fileId - Edge Streaming Proxy with HTTP 206 + R2 Head-Chunk Fast-Start
 */
streamRoutes.on(['GET', 'HEAD'], '/api/stream/:fileId', async (c) => {
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

  // Ultra-fast L1 Memory Hit before any SQL query
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

  // Prewarm mode
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

  // Fast-Start Edge Prefix Path
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
      // Fallback to OneDrive mirror
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

/**
 * GET /api/stream/raw/:provider/:externalId - Direct external stream (audio tracks)
 */
streamRoutes.on(['GET', 'HEAD'], '/api/stream/raw/:provider/:externalId', async (c) => {
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
 * HLS Endpoints for iOS Safari
 */
streamRoutes.get('/api/stream/hls/:fileId/master.m3u8', async (c) => {
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

streamRoutes.get('/api/stream/hls/:fileId/playlist.m3u8', async (c) => {
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

    const hlsHandler = new HlsEndpointHandler();

    await hlsHandler.initialize(upstreamResponse, {
      videoCodec: detectedVideoCodec,
      audioCodec: detectedAudioCodec,
      segmentDuration: 6,
      maxSegments: 10,
    });

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

streamRoutes.get('/api/stream/hls/:fileId/segment/:segmentNumber.m4s', async (c) => {
  return c.json({ error: 'Segmento não disponível. Use o stream direto para desktop.' }, 404);
});

/**
 * Warm head chunks for fast-start streaming
 */
export async function warmAllMovieHeadChunks(env: Env, limit = 15): Promise<{ warmedCount: number; logs: string[] }> {
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
    await populateHeadChunkInBackground(fid, meta, env);
    if (headChunkMemoryCache.has(fid)) {
      warmedCount++;
      logs.push(`⚡ Fast-Start R2 (2 MB) pronto: ${String(row.title || row.filename)} (${String(row.provider).toUpperCase()})`);
    }
  }

  return { warmedCount, logs };
}