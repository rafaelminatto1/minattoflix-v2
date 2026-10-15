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
import { warmAllMovieHeadChunks } from './stream';

export { warmAllMovieHeadChunks };
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

    // Cleanup: remove media_files that no longer exist in the cloud source
    // Collect all external_file_ids that were found in this sync
    const foundExternalFileIds = new Set<string>();
    for (const bundle of bundles) {
      for (const file of bundle.files) {
        if (!file.isFolder) {
          foundExternalFileIds.add(file.id);
        }
      }
    }

    if (foundExternalFileIds.size > 0) {
      // Get all media_files for this storage source
      const existingFiles = await sql`
        SELECT id, external_file_id FROM media_files WHERE storage_source_id = ${sourceId}
      `;

      const toDelete = existingFiles
        .map((row) => ({ id: String(row.id), externalFileId: String(row.external_file_id) }))
        .filter((row) => !foundExternalFileIds.has(row.externalFileId));

      if (toDelete.length > 0) {
        const idsToDelete = toDelete.map((r) => r.id);
        // Delete related tracks first (audio_tracks and subtitle_tracks reference media_files)
        await sql`DELETE FROM audio_tracks WHERE media_file_id = ANY(${idsToDelete})`;
        await sql`DELETE FROM subtitle_tracks WHERE media_file_id = ANY(${idsToDelete})`;
        // Then delete the media_files
        await sql`DELETE FROM media_files WHERE id = ANY(${idsToDelete})`;
        logs.push(`Limpeza: ${toDelete.length} arquivo(s) removido(s) que não existem mais no ${source.name}`);
      }
    }

    await sql`UPDATE storage_sources SET last_synced_at = NOW() WHERE id = ${sourceId}`;
    logs.push(`Sincronizado: ${source.name} (${bundles.length} pastas verificadas)`);
  }

  // Auto-heal covers: search for posters for movies that currently lack covers
  const coverHealing = await healMissingMediaCovers(env, 20);
  if (coverHealing.healedCount > 0) {
    logs.push(`🎨 Capas: ${coverHealing.healedCount} títulos atualizados com capas em alta definição.`);
    logs.push(...coverHealing.logs);
  }

  return {
    ok: true,
    discoveredFolders,
    syncedVideos,
    syncedExternalTracks,
    healedCovers: coverHealing.healedCount,
    logs,
  };
}

/**
 * Auto-healing job to find and enrich covers for media items that currently have
 * missing covers or fallback unsplash placeholders.
 */
export async function healMissingMediaCovers(env: Env, limit = 25): Promise<{ healedCount: number; logs: string[] }> {
  const sql = getDb(env);
  const logs: string[] = [];
  let healedCount = 0;

  try {
    const items = await sql`
      SELECT id, title, original_title, release_year, poster_url
      FROM media_items
      WHERE poster_url ILIKE '%unsplash%'
         OR poster_url IS NULL
         OR poster_url = ''
         OR poster_url ILIKE '%placeholder%'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    for (const item of items) {
      try {
        const meta = await enrichMediaMetadata(
          String(item.title),
          item.release_year ? Number(item.release_year) : null,
          env.TMDB_API_KEY,
          env.AI
        );

        if (meta.posterUrl && !meta.posterUrl.includes('unsplash')) {
          await sql`
            UPDATE media_items
            SET
              poster_url = ${meta.posterUrl},
              backdrop_url = ${meta.backdropUrl || meta.posterUrl},
              title = COALESCE(NULLIF(${meta.title}, ''), title),
              original_title = COALESCE(NULLIF(${meta.originalTitle}, ''), original_title),
              overview = CASE WHEN overview LIKE '%sincronizado diretamente%' OR overview IS NULL THEN ${meta.overview} ELSE overview END,
              tagline = CASE WHEN tagline LIKE '%Disponível na sua nuvem%' OR tagline IS NULL THEN ${meta.tagline} ELSE tagline END,
              rating = CASE WHEN rating = 0 OR rating = 8.5 THEN ${meta.rating} ELSE rating END,
              updated_at = NOW()
            WHERE id = ${item.id}
          `;
          healedCount++;
          logs.push(`✓ Capa atualizada: ${item.title} -> ${meta.originalTitle || meta.title}`);
        }
      } catch (err) {
        logs.push(`Aviso ao buscar capa de ${item.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logs.push(`Falha no auto-healing de capas: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { healedCount, logs };
}

scannerRoutes.post('/api/scanner/sync', async (c) => {
  const result = await executeCloudScannerSync(c.env);
  c.executionCtx.waitUntil(warmAllMovieHeadChunks(c.env, 10).catch(() => {}));
  return c.json(result);
});

scannerRoutes.post('/api/scanner/enrich-covers', async (c) => {
  const result = await healMissingMediaCovers(c.env, 50);
  return c.json(result);
});

scannerRoutes.post('/api/cloudflare/warm-heads', async (c) => {
  const result = await warmAllMovieHeadChunks(c.env, 20);
  return c.json(result);
});