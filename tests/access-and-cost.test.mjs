import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import ts from 'typescript';

const queries = [];
let handler = async () => [];
globalThis.__operationsSql = async (strings, ...values) => {
  const query = strings.join('?'); queries.push({ query, values });
  if (query.includes('INSERT INTO app_rate_limits')) return [{ hits: 1 }];
  return handler(query, values);
};
const result = await build({ entryPoints: ['src/worker/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'test-database', setup(builder) {
    builder.onResolve({ filter: /(^|\/)db$/ }, () => ({ path: 'test-db', namespace: 'test-db' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-db' }, () => ({ contents: 'export const getDb = () => globalThis.__operationsSql;' }));
  } }], logLevel: 'silent' });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const accessSource = await readFile(new URL('../src/worker/services/access.ts', import.meta.url), 'utf8');
const accessJs = ts.transpileModule(accessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { issueSession, readSession } = await import(`data:text/javascript;base64,${Buffer.from(accessJs).toString('base64')}`);
const env = { DATABASE_URL: 'test-only', ACCESS_CODE: 'viewer-test-code', ADMIN_CODE: 'admin-test-code', SESSION_SECRET: 'test-only-0123456789abcdef0123456789abcdef', COST_MODE: 'restricted' };
const context = { waitUntil() {}, passThroughOnException() {} };
const request = (path, init = {}, bindings = env) => worker.fetch(new Request(`https://app.test${path}`, init), bindings, context);
const authorization = async role => ({ Authorization: `Bearer ${await issueSession(env, role)}` });

test('public liveness never queries the database, private API fails closed', async () => {
  queries.length = 0;
  assert.equal((await request('/api/health')).status, 200);
  assert.equal(queries.length, 0);
  assert.equal((await request('/api/bootstrap')).status, 401);
  assert.equal((await request('/api/bootstrap', {}, { DATABASE_URL: 'test' })).status, 503);
});

test('viewer cannot mutate sources or access administrative metrics', async () => {
  const headers = await authorization('viewer');
  assert.equal((await request('/api/storage-sources', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await request('/api/admin/diagnostics', { headers })).status, 403);
  assert.equal((await request('/api/metrics/playback-quality', { headers })).status, 403);
});

test('restricted mode masks paid bindings even when someone supplies them', async () => {
  const trap = () => { throw new Error('A disabled binding was invoked'); };
  const bindings = { ...env, AI: { run: trap }, MINATTO_KV: { get: trap }, MEDIA_BUCKET: { get: trap }, WATCH_PARTY: { get: trap }, HYPERDRIVE: {}, GITHUB_TOKEN: 'must-not-use' };
  const headers = await authorization('admin');
  const status = await (await request('/api/cloudflare/status', { headers }, bindings)).json();
  assert.equal(status.workersAiConnected, false);
  assert.equal(status.r2Connected, false);
  assert.equal(status.kvConnected, false);
  assert.equal(status.hyperdriveConnected, false);
  assert.equal(status.durableObjectsConnected, false);
  assert.equal(status.connectivityTested, false);
  for (const path of ['/api/ai/translate-subtitle', '/api/downloads/request', '/api/preparation/11111111-1111-4111-8111-111111111111']) {
    assert.equal((await request(path, { method: 'POST', headers, body: '{}' }, bindings)).status, 409, path);
  }
  assert.equal((await request('/api/stream/hls/file/master.m3u8', { headers }, bindings)).status, 409);
});

test('query session tokens work only for read-only media; tampering and wrong signing keys fail', async () => {
  const token = await issueSession(env, 'admin');
  assert.equal((await readSession(new Request(`https://app.test/api/stream/file?session=${token}`), env))?.role, 'admin');
  assert.equal(await readSession(new Request(`https://app.test/api/storage-sources?session=${token}`, { method: 'POST' }), env), null);
  assert.equal(await readSession(new Request(`https://app.test/api/stream/file?session=${token}tampered`), env), null);
  assert.equal(await readSession(new Request(`https://app.test/api/stream/file?session=${token}`), { ...env, SESSION_SECRET: 'a-different-test-key-0123456789abcdef' }), null);
});

test('missing webhook secret fails closed and oversized requests are rejected', async () => {
  assert.equal((await request('/api/downloads/webhook', { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await request('/api/session', { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
});

test('login issues a signed session without exposing access codes', async () => {
  const response = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: env.ACCESS_CODE }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, 'viewer');
  assert.ok(body.token);
  assert.equal(JSON.stringify(body).includes(env.ACCESS_CODE), false);
  assert.equal((await readSession(new Request('https://app.test/api/bootstrap', { headers: { Authorization: `Bearer ${body.token}` } }), env))?.role, 'viewer');
});

test('CORS allows the Capacitor origin and does not allow arbitrary websites', async () => {
  assert.equal((await request('/api/session', { headers: { Origin: 'capacitor://localhost' } })).headers.get('Access-Control-Allow-Origin'), 'capacitor://localhost');
  assert.equal((await request('/api/session', { headers: { Origin: 'https://evil.test' } })).headers.get('Access-Control-Allow-Origin'), null);
  const token = await issueSession(env, 'viewer');
  const subtitle = await request(`/api/subtitles/file.vtt?session=${token}`, { headers: { Origin: 'https://evil.test' } });
  assert.equal(subtitle.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(subtitle.headers.get('Cache-Control'), 'private, no-store');
});
