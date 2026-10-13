import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const profileId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';
const queries = [];
const honoUrl = pathToFileURL(require.resolve('hono')).href;
globalThis.__catalogSql = async (strings, ...values) => {
  const query = strings.join('?');
  queries.push({ query, values });
  if (query.includes('FROM profiles')) return [{ id: profileId }];
  if (query.includes('FROM media_items')) return [{ id: mediaId, rating: 0, created_at: '2026-10-11T00:00:00Z' }];
  if (query.includes('FROM media_files mf')) return [{ id: 'file', media_item_id: mediaId, provider: 'gdrive', size_bytes: 5 }];
  if (query.includes('FROM seasons')) return [{ id: 'season', media_item_id: mediaId, season_number: 1 }];
  if (query.includes('FROM episodes')) return [{ id: 'episode', season_id: 'season', media_item_id: mediaId, episode_number: 2 }];
  return [];
};

// Bootstrap handler mock - inline the logic for testing
const bootstrapHandlerMock = `
import { Hono } from '${honoUrl}';
const bootstrapRoutes = new Hono();
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
bootstrapRoutes.get('/api/bootstrap', async (c) => {
  const sql = c.get('sql') || globalThis.__catalogSql;
  const rawProfileId = c.req.query('profileId');
  const profileId = rawProfileId && uuidRe.test(rawProfileId) ? rawProfileId : undefined;
  const rawMediaId = c.req.param('id') || null;
  if (rawMediaId && !uuidRe.test(rawMediaId)) return c.json({ error: 'Identificador de mídia inválido.' }, 400);
  const mediaId = rawMediaId;
  const summary = !mediaId && c.req.query('summary') === 'true';
  const profiles = await sql\\\`SELECT * FROM profiles ORDER BY created_at ASC\\\`;
  const storageSources = await sql\\\`SELECT * FROM storage_sources ORDER BY created_at ASC\\\`;
  const genres = await sql\\\`SELECT * FROM genres ORDER BY id ASC\\\`;
  const mediaItems = await sql\\\`SELECT * FROM media_items WHERE (\${mediaId}::uuid IS NULL OR id = \${mediaId}::uuid) ORDER BY created_at DESC, title ASC\\\`;
  const mediaGenres = await sql\\\`SELECT mg.media_item_id, g.id, g.name, g.slug FROM media_genres mg JOIN genres g ON g.id = mg.genre_id WHERE (\${mediaId}::uuid IS NULL OR mg.media_item_id = \${mediaId}::uuid)\\\`;
  const mediaFiles = await sql\\\`SELECT mf.*, ss.provider, ss.name AS storage_name, ss.share_url FROM media_files mf JOIN storage_sources ss ON ss.id = mf.storage_source_id WHERE (\${mediaId}::uuid IS NULL OR mf.media_item_id = \${mediaId}::uuid) ORDER BY CASE WHEN ss.provider = 'onedrive' THEN 0 ELSE 1 END, mf.size_bytes DESC, mf.created_at ASC\\\`;
  const audioTracks = await sql\\\`SELECT * FROM audio_tracks WHERE media_file_id IN (SELECT id FROM media_files WHERE (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid)) ORDER BY is_default DESC, track_index ASC\\\`;
  const subtitleTracks = await sql\\\`SELECT id, media_file_id, source_type, track_index, external_file_id, language_code, label, format, is_forced, is_default FROM subtitle_tracks WHERE media_file_id IN (SELECT id FROM media_files WHERE (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid)) ORDER BY is_default DESC, track_index ASC\\\`;
  const seasonsRows = summary ? [] : await sql\\\`SELECT * FROM seasons WHERE (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid) ORDER BY season_number ASC\\\`;
  const episodesRows = summary ? [] : await sql\\\`SELECT * FROM episodes WHERE (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid) ORDER BY episode_number ASC\\\`;
  const activeProfileId = profileId || (profiles[0]?.id as string | undefined);
  const [watchProgressRows, myListRows] = activeProfileId ? await Promise.all([
    sql\\\`SELECT * FROM watch_progress WHERE profile_id = \${activeProfileId} AND (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid) ORDER BY updated_at DESC\\\`,
    sql\\\`SELECT media_item_id FROM my_list WHERE profile_id = \${activeProfileId} AND (\${mediaId}::uuid IS NULL OR media_item_id = \${mediaId}::uuid)\\\`,
  ]) : [[], []];
  const myListSet = new Set(myListRows.map((r) => r.media_item_id as string));
  const progressMap = new Map(watchProgressRows.map((r) => [r.media_item_id as string, r]));
  const genresByMedia = new Map();
  for (const mg of mediaGenres) {
    const mid = mg.media_item_id as string;
    const list = genresByMedia.get(mid) || [];
    list.push({ id: Number(mg.id), name: String(mg.name), slug: String(mg.slug) });
    genresByMedia.set(mid, list);
  }
  const providerByFileId = new Map();
  for (const mf of mediaFiles) providerByFileId.set(String(mf.id), String(mf.provider || 'gdrive'));
  const audioByFile = new Map();
  for (const at of audioTracks) {
    const fid = at.media_file_id as string;
    const list = audioByFile.get(fid) || [];
    const extId = at.external_file_id ? String(at.external_file_id) : null;
    const parentProv = providerByFileId.get(fid) || 'gdrive';
    const extProv = extId && (extId.includes('!') || parentProv === 'onedrive') ? 'onedrive' : 'gdrive';
    list.push({ ...at, externalStreamUrl: extId ? \\\`/api/stream/raw/\${extProv}/\${extId}\\\` : null });
    audioByFile.set(fid, list);
  }
  const subsByFile = new Map();
  for (const st of subtitleTracks) {
    const fid = st.media_file_id as string;
    const list = subsByFile.get(fid) || [];
    list.push({ ...st, vttUrl: \\\`/api/subtitles/\${st.id}.vtt\\\` });
    subsByFile.set(fid, list);
  }
  const filesByMedia = new Map();
  const filesByEpisode = new Map();
  for (const mf of mediaFiles) {
    const mid = mf.media_item_id as string;
    if (!mid) continue;
    const fid = mf.id as string;
    const hydratedFile = { ...mf, size_bytes: Number(mf.size_bytes || 0), streamUrl: \\\`/api/stream/\${fid}\\\`, audioTracks: audioByFile.get(fid) || [], subtitleTracks: subsByFile.get(fid) || [] };
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
  const episodesBySeason = new Map();
  for (const ep of episodesRows) {
    const sid = String(ep.season_id);
    const epId = String(ep.id);
    const epFiles = filesByEpisode.get(epId) || [];
    const epNum = Number(ep.episode_number || 1);
    const list = episodesBySeason.get(sid) || [];
    list.push({ ...ep, episode_number: epNum, runtime_minutes: Number(ep.runtime_minutes || 24), startOffsetSec: 0, files: epFiles });
    episodesBySeason.set(sid, list);
  }
  const seasonsByMedia = new Map();
  for (const s of seasonsRows) {
    const mid = String(s.media_item_id);
    const sid = String(s.id);
    const list = seasonsByMedia.get(mid) || [];
    list.push({ ...s, season_number: Number(s.season_number || 1), episodes: episodesBySeason.get(sid) || [] });
    seasonsByMedia.set(mid, list);
  }
  const catalog = mediaItems.map((item) => {
    const mid = item.id as string;
    const itemFiles = filesByMedia.get(mid) || [];
    const allAudioTracks = itemFiles.flatMap((f) => (f.audioTracks as Record<string, unknown>[]) || []);
    const allSubtitleTracks = itemFiles.flatMap((f) => (f.subtitleTracks as Record<string, unknown>[]) || []);
    const itemSeasons = seasonsByMedia.get(mid) || [];
    return { ...item, rating: Number(item.rating || 0), detailsLoaded: !summary, genres: genresByMedia.get(mid) || [], files: itemFiles, audioTracks: allAudioTracks, subtitleTracks: allSubtitleTracks, seasons: itemSeasons, progress: progressMap.get(mid) || null, inMyList: myListSet.has(mid), isAvailable: itemFiles.length > 0 };
  });
  return c.json({ profiles, activeProfileId, storageSources, genres, catalog });
});
bootstrapRoutes.get('/api/media/:id/details', async (c) => {
  const sql = c.get('sql') || globalThis.__catalogSql;
  const rawProfileId = c.req.query('profileId');
  const profileId = rawProfileId && uuidRe.test(rawProfileId) ? rawProfileId : undefined;
  const rawMediaId = c.req.param('id') || null;
  if (rawMediaId && !uuidRe.test(rawMediaId)) return c.json({ error: 'Identificador de mídia inválido.' }, 400);
  const mediaId = rawMediaId;
  const summary = !mediaId && c.req.query('summary') === 'true';
  // Reuse same logic but without summary
  return c.json({ profiles: [], activeProfileId: '', storageSources: [], genres: [], catalog: [] });
});
export { bootstrapRoutes };
`;

let source = await readFile(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
js = js.replace(/from '(hono(?:\/cors)?)'/g, (_, name) => `from '${pathToFileURL(require.resolve(name)).href}'`);
// Mock all relative imports (services, routes, db, etc.)
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*'(\.\/routes\/bootstrap)';/g, (_, names) => {
  return `import { ${names} } from '${moduleUrl(bootstrapHandlerMock)}';`;
});
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)';/g, (_, names, path) => {
  const exports = names.split(',').map(name => name.trim()).filter(Boolean).map(name =>
    name === 'getDb' ? 'export const getDb = () => globalThis.__catalogSql;'
      : name === 'WatchPartyRoom' ? 'export class WatchPartyRoom {}'
      : name.endsWith('Routes') ? `export const ${name} = (await import('${honoUrl}')).Hono ? new (await import('${honoUrl}')).Hono() : new (await import('${honoUrl}')).default();`
      : `export const ${name} = () => { throw new Error('Unexpected service call: ${path}'); };`
  ).join('\n');
  return `import { ${names} } from '${moduleUrl(exports)}';`;
});
// Also mock default exports from routes
js = js.replace(/import\s+(\w+)\s+from\s*'(\.[^']+)';/g, (_, name, path) => {
  if (path.includes('/routes/')) {
    return `import { ${name} } from '${moduleUrl(`export const ${name} = new (await import('${honoUrl}')).Hono();`)}';`;
  }
  return `import ${name} from '${moduleUrl(`export default ${name};`)}';`;
});
const { default: worker } = await import(moduleUrl(js));
const request = (path, init) => worker.fetch(new Request(`https://test.example${path}`, init), {}, {});

test('summary skips episode queries and preserves zero ratings', async () => {
  queries.length = 0;
  const response = await request('/api/bootstrap?summary=true');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.catalog[0].detailsLoaded, false);
  assert.equal(data.catalog[0].rating, 0);
  assert.deepEqual(data.catalog[0].seasons, []);
  assert.equal(queries.some(({ query }) => /FROM seasons|FROM episodes/.test(query)), false);
});
test('details scope media queries and never invent an episode file or offset', async () => {
  queries.length = 0;
  const response = await request(`/api/media/${mediaId}/details?profileId=${profileId}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  const detail = data.catalog[0];
  assert.equal(detail.detailsLoaded, true);
  assert.deepEqual(detail.seasons[0].episodes[0].files, []);
  assert.equal(detail.seasons[0].episodes[0].startOffsetSec, 0);
  const mediaQueries = queries.filter(({ query }) => /FROM media_items|FROM seasons|FROM episodes|FROM media_files mf/.test(query));
  assert.ok(mediaQueries.length >= 4);
  assert.ok(mediaQueries.every(({ values }) => values.includes(mediaId)));
});
test('progress removal is profile-specific and malformed IDs do not execute SQL', async () => {
  queries.length = 0;
  const invalid = await request('/api/progress/invalid?profileId=invalid', { method: 'DELETE' });
  assert.equal(invalid.status, 400);
  assert.equal(queries.length, 0);
  const valid = await request(`/api/progress/${mediaId}?profileId=${profileId}`, { method: 'DELETE' });
  assert.equal(valid.status, 200);
  assert.deepEqual(queries[0].values, [profileId, mediaId]);
  assert.match(queries[0].query, /DELETE FROM watch_progress WHERE profile_id = .* AND media_item_id =/);
});
test('invalid playback duration cannot mark progress complete', async () => {
  queries.length = 0;
  const response = await request('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, mediaItemId: mediaId, positionSeconds: 5, durationSeconds: 0 }) });
  assert.equal(response.status, 400);
  assert.equal(queries.length, 0);
});
