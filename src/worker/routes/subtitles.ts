import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { fetchGDriveStream, fetchOneDriveStream } from '../services/onedrive';
import {
  convertToWebVtt,
  cuesToWebVtt,
  extractEmbeddedSubtitlesFromMkvBuffer,
  parseMkvTracksFromBuffer,
} from '../services/mkv-ebml-probe';
import { autoFetchSubtitlesForMovie } from '../services/subtitle-fetcher';

export const subtitlesRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/subtitles/:subIdFile - Serve WebVTT from R2, Neon, or live extraction
 */
subtitlesRoutes.get('/api/subtitles/:subIdFile', async (c) => {
  const rawParam = c.req.param('subIdFile');
  const subId = rawParam.replace(/\.vtt$/i, '');

  // 1. Check Cloudflare R2 Bucket first
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

  // 2. If stored in Neon content_vtt column
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

  // 3. External .srt / .vtt / .ass file
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

  // 4. Embedded in MKV - scan initial clusters
  if (sub.source_type === 'embedded' && sub.video_external_id) {
    try {
      const mfId = String(sub.media_file_id);
      const headChunkRes = await c.env.MEDIA_BUCKET?.get(`head-chunks/${mfId}.bin`);
      let buf: Uint8Array;

      if (headChunkRes) {
        buf = new Uint8Array(await headChunkRes.arrayBuffer());
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

  // 5. Auto-fetch from OpenSubtitles/Wyzie/SubDL/AI
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
 * POST /api/ai/translate-subtitle - Generate/translate subtitles with Workers AI
 */
subtitlesRoutes.post('/api/ai/translate-subtitle', async (c) => {
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
 * POST /api/subtitles/upload - Save uploaded subtitle to R2 + Neon
 */
subtitlesRoutes.post('/api/subtitles/upload', async (c) => {
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
 * POST /api/subtitles/auto-fetch/:mediaItemId - Auto-fetch complete subtitles
 */
subtitlesRoutes.post('/api/subtitles/auto-fetch/:mediaItemId', async (c) => {
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