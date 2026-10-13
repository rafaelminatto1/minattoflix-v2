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
let source = await readFile(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
js = js.replace(/from '(hono(?:\/cors)?)'/g, (_, name) => `from '${pathToFileURL(require.resolve(name)).href}'`);
js = js.replace(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)';/g, (_, names, path) => {
  const exports = names.split(',').map(name => name.trim()).filter(Boolean).map(name =>
    name === 'getDb' ? 'export const getDb = () => globalThis.__catalogSql;'
      : name === 'WatchPartyRoom' ? 'export class WatchPartyRoom {}'
      : `export const ${name} = () => { throw new Error('Unexpected service call: ${path}'); };`
  ).join('\n');
  return `import { ${names} } from '${moduleUrl(exports)}';`;
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
