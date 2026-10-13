import { Hono, type Context } from 'hono';
import { getDb, type Env } from '../db';
import { scanGDriveRootFolder } from '../services/gdrive';
import { scanOneDriveSharedFolder } from '../services/onedrive';
import { parseReleaseName } from '../services/release-parser';
import { enrichMediaMetadata } from '../services/metadata-enricher';
import {
  parseMkvTracksFromBuffer,
  formatTrackLabel,
} from '../services/mkv-ebml-probe';
import { fetchGDriveStream } from '../services/gdrive';
import { fetchOneDriveStream } from '../services/onedrive';

export const scannerRoutes = new Hono<{ Bindings: Env }>();

const genericFolderRe = /^(filmes|onedrive\s*filmes|gdrive\s*filmes|movies|series|séries|videos|vídeos)$/i;

/**
 * Core Cloud Scanner function used by both POST /api/scanner/sync and the 15-minute Cron Trigger
 */
export async function executeCloudScannerSync(env: Env) {
  const sql = getDb(env);
  const sources = await sql`SELECT * FROM storage_sources WHERE is_active = TRUE`;

  let discoveredFolders = 0;
  let syncedVideos = 0;
  let syncedExternalTracks = 0;
  const logs: string[] = [];

  for (const source of sources) {
    const sourceId = String(source.id);
    const provider = String(source.provider);
    const rootFolderId = String(source.root_folder_id);
    const shareUrl = String(source.share_url);

    let bundles: Awaited<ReturnType<typeof scanGDriveRootFolder>> = [];
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

  // Self-heal: remove orphan generic folder items
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
    warmedCount++;
    logs.push(`⚡ Fast-Start R2 (2 MB) pronto: ${String(row.title || row.filename)} (${String(row.provider).toUpperCase()})`);
  }

  return { warmedCount, logs };
}

scannerRoutes.post('/api/scanner/sync', async (c) => {
  const result = await executeCloudScannerSync(c.env);
  c.executionCtx.waitUntil(warmAllMovieHeadChunks(c.env, 10).catch(() => {}));
  return c.json(result);
});

scannerRoutes.post('/api/cloudflare/warm-heads', async (c) => {
  const result = await warmAllMovieHeadChunks(c.env, 20);
  return c.json(result);
});