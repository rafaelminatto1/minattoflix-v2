import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { restrictedCosts } from '../services/cost-policy';
import { fetchGDriveStream } from '../services/gdrive';
import { fetchOneDriveStream, resolveOneDriveDownloadUrl } from '../services/onedrive';
import {
  detectVideoCodec,
  detectAudioCodec,
  generateMasterPlaylist,
  generateMediaPlaylist,
  HlsEndpointHandler,
} from '../services/hls-transmuxer';

export { populateHeadChunkInBackground, headChunkMemoryCache, setMemoryHeadChunk };

// Global HLS handler cache (per isolate)
const hlsHandlerCache = new Map<string, { handler: HlsEndpointHandler; expiresAt: number }>();

function getHlsCacheKey(fileId: string, vcodec: string, acodec: string): string {
  return `${fileId}:${vcodec}:${acodec}`;
}

function getOrCreateHlsHandler(
  fileId: string,
  vcodec: string,
  acodec: string,
  factory: () => Promise<HlsEndpointHandler>
): Promise<HlsEndpointHandler> {
  const key = getHlsCacheKey(fileId, vcodec, acodec);
  const cached = hlsHandlerCache.get(key);
  const now = Date.now();
  
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.handler);
  }
  
  // Clean up expired entries
  if (cached) {
    cached.handler.close();
    hlsHandlerCache.delete(key);
  }
  
  return factory().then(handler => {
    hlsHandlerCache.set(key, { handler, expiresAt: now + 5 * 60 * 1000 }); // 5 min TTL
    return handler;
  });
}
interface HeadChunkEntry {
  bytes: Uint8Array;
  totalSize: number;
  expiresAt: number;
}

// Pre-aquecimento: 8 MB para catálogo geral (4x maior que os 2 MB originais)
// e 24 MB para mídias 4K / alto bitrate (>8 GB) para garantir carregamento instantâneo
export const DEFAULT_HEAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const HEAD_CHUNK_4K_BYTES = 24 * 1024 * 1024;
export const HEAD_CHUNK_BYTES = DEFAULT_HEAD_CHUNK_BYTES;

export function getHeadChunkBytes(fileMeta?: Record<string, unknown> | null): number {
  if (!fileMeta) return DEFAULT_HEAD_CHUNK_BYTES;
  const resolution = String(fileMeta.resolution || '').toLowerCase();
  const filename = String(fileMeta.filename || '').toLowerCase();
  const sizeBytes = Number(fileMeta.size_bytes || 0);

  const is4K =
    resolution.includes('2160') ||
    resolution.includes('4k') ||
    filename.includes('2160p') ||
    filename.includes('4k') ||
    sizeBytes > 8 * 1024 * 1024 * 1024;

  return is4K ? HEAD_CHUNK_4K_BYTES : DEFAULT_HEAD_CHUNK_BYTES;
}

const headChunkMemoryCache = new Map<string, HeadChunkEntry>();
const headChunkInflight = new Set<string>();

function setMemoryHeadChunk(fileId: string, bytes: Uint8Array, totalSize: number) {
  const maximumBytes = 48 * 1024 * 1024;
  if (bytes.byteLength > maximumBytes) return;
  headChunkMemoryCache.delete(fileId);
  let used = [...headChunkMemoryCache.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  for (const [key, entry] of headChunkMemoryCache) {
    if (used + bytes.byteLength <= maximumBytes && headChunkMemoryCache.size < 30) break;
    used -= entry.bytes.byteLength;
    headChunkMemoryCache.delete(key);
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
    const targetHeadBytes = getHeadChunkBytes(mediaFile);

    if (env.MEDIA_BUCKET && knownTotalSize > targetHeadBytes) {
      const existingR2 = await env.MEDIA_BUCKET.get(r2Key);
      if (existingR2) {
        const buf = new Uint8Array(await existingR2.arrayBuffer());
        if (buf.byteLength >= targetHeadBytes || buf.byteLength >= knownTotalSize) {
          setMemoryHeadChunk(fileId, buf, knownTotalSize);
          return;
        }
      }
    }

    const provider = String(mediaFile.provider);
    const externalFileId = String(mediaFile.external_file_id);
    const shareUrl = String(mediaFile.share_url || '');
    const rangeStr = `bytes=0-${targetHeadBytes - 1}`;

    const res =
      provider === 'onedrive'
        ? await fetchOneDriveStream(externalFileId, shareUrl, rangeStr, env.MINATTO_KV)
        : await fetchGDriveStream(externalFileId, rangeStr, env.GDRIVE_API_KEY, env.MINATTO_KV);

    if (!res.ok && res.status !== 206) return;

    const cr = res.headers.get('Content-Range') || res.headers.get('content-range') || '';
    const totalMatch = cr.match(/\/(\d+)$/);
    const totalSize = totalMatch ? Number(totalMatch[1]) : knownTotalSize;
    if (!totalSize || totalSize <= targetHeadBytes) return;

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
          is4K: String(targetHeadBytes === HEAD_CHUNK_4K_BYTES),
        },
      });
    }
  } catch {
    // Ignore background head-chunk warming errors
  } finally {
    headChunkInflight.delete(fileId);
  }
}

interface MediaFileMeta {
  row: Record<string, unknown>;
  expiresAt: number;
}

export const streamRoutes = new Hono<{ Bindings: Env }>();
streamRoutes.use('/api/stream/hls/*', async (c, next) => {
  if (restrictedCosts(c.env)) return c.json({ error: 'HLS dinâmico indisponível. Use o arquivo original ou uma cópia MP4 preparada localmente.' }, 409);
  await next();
});

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

  if (!mediaFile) {
    return c.json({ error: 'Arquivo de mídia não encontrado no catálogo.' }, 404);
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

  // Fast-Start Edge Prefix Path (adaptativo: 24 MB para 4K, 8 MB para geral)
  const targetHeadBytes = getHeadChunkBytes(mediaFile);
  const rangeMatch = rangeHeader ? rangeHeader.match(/^bytes=(\d+)-(\d*)$/) : null;
  const reqStart = rangeMatch ? Number(rangeMatch[1]) : 0;
  const reqEnd = rangeMatch && rangeMatch[2] ? Number(rangeMatch[2]) : undefined;
  const canServeFromHead =
    (!rangeHeader || Boolean(rangeMatch)) &&
    reqStart < targetHeadBytes &&
    (reqEnd === undefined || reqEnd < targetHeadBytes);

  if (canServeFromHead) {
    let headEntry = headChunkMemoryCache.get(fileId);
    if ((!headEntry || Date.now() >= headEntry.expiresAt) && c.env.MEDIA_BUCKET) {
      const knownTotal = Number(mediaFile.size_bytes || 0);
      if (knownTotal > targetHeadBytes) {
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

    // Get or create HLS handler from cache
    const hlsHandler = await getOrCreateHlsHandler(fileId, vcodec, acodec, async () => {
      const handler = new HlsEndpointHandler();
      await handler.initialize(upstreamResponse, {
        videoCodec: detectedVideoCodec,
        audioCodec: detectedAudioCodec,
        segmentDuration: 6,
        maxSegments: 10,
      });
      return handler;
    });

    // Wait for at least first segment to be produced (max 5 seconds)
    let waited = 0;
    while (hlsHandler.getSegment(0) === null && waited < 5000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }

    const playlist = hlsHandler.generatePlaylist();
    
    // If no segments produced, return error so client falls back to WebCodecs
    if (!playlist.includes('#EXTINF')) {
      hlsHandler.close();
      hlsHandlerCache.delete(getHlsCacheKey(fileId, vcodec, acodec));
      return c.json({ error: 'HLS transmuxing não produziu segmentos. Use WebCodecs.' }, 503);
    }

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

streamRoutes.get('/api/stream/hls/:fileId/segment/:segmentNumber', async (c) => {
  const fileId = c.req.param('fileId');
  const segmentNumberParam = c.req.param('segmentNumber');
  const segmentNumber = parseInt(segmentNumberParam.replace('.m4s', ''), 10);
  const vcodec = c.req.query('vcodec') || 'avc1';
  const acodec = c.req.query('acodec') || 'mp4a.40.2';

  if (isNaN(segmentNumber)) {
    return c.json({ error: 'Número de segmento inválido' }, 400);
  }

  const key = getHlsCacheKey(fileId, vcodec, acodec);
  const cached = hlsHandlerCache.get(key);
  
  if (!cached || cached.expiresAt < Date.now()) {
    return c.json({ error: 'Segmento não encontrado. Playlist pode ter expirado.' }, 404);
  }

  const segment = cached.handler.getSegment(segmentNumber);
  
  if (!segment) {
    // Segment not ready yet - return 404 so client retries
    return c.json({ error: 'Segmento ainda não disponível. Tente novamente.' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'video/mp4');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(segment.byteLength));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(segment as unknown as BodyInit, { headers, status: 200 });
});

/**
 * Warm head chunks for fast-start streaming (24 MB para 4K, 8 MB para catálogo geral)
 */
export async function warmAllMovieHeadChunks(env: Env, limit = 20): Promise<{ warmedCount: number; logs: string[] }> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT mf.*, ss.provider, ss.share_url, mi.title
    FROM media_files mf
    JOIN storage_sources ss ON ss.id = mf.storage_source_id
    LEFT JOIN media_items mi ON mi.id = mf.media_item_id
    ORDER BY mf.size_bytes DESC, mf.created_at DESC
    LIMIT ${limit}
  `;

  let warmedCount = 0;
  const logs: string[] = [];

  for (const row of rows) {
    const fid = String(row.id);
    const meta = row as Record<string, unknown>;
    const is4K = getHeadChunkBytes(meta) === HEAD_CHUNK_4K_BYTES;
    const sizeLabel = is4K ? '24 MB (4K)' : '8 MB (Geral)';
    await populateHeadChunkInBackground(fid, meta, env);
    if (headChunkMemoryCache.has(fid)) {
      warmedCount++;
      logs.push(`⚡ Fast-Start R2 (${sizeLabel}) pronto: ${String(row.title || row.filename)} (${String(row.provider).toUpperCase()})`);
    }
  }

  return { warmedCount, logs };
}
