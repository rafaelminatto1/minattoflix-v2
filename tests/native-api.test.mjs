import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/client/services/catalog.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const native = await import(moduleUrl(`const __API_ORIGIN__ = 'https://api.example.test';\n${js}`));
const web = await import(moduleUrl(js));

test('bundled app uses hosted API while website keeps same-origin requests', () => {
  assert.equal(native.apiUrl('/api/bootstrap?summary=true'), 'https://api.example.test/api/bootstrap?summary=true');
  assert.equal(web.apiUrl('/api/bootstrap'), '/api/bootstrap');
  for (const url of ['https://cdn.example/video.mp4', 'blob:local-subtitle', 'data:image/svg+xml,test', '/assets/icon.svg']) {
    assert.equal(native.apiUrl(url), url);
  }
});

test('native bootstrap resolves streams, subtitles and artwork throughout nested payloads', async t => {
  let fetched;
  t.mock.method(globalThis, 'fetch', async url => {
    fetched = url;
    return new Response(JSON.stringify({ catalog: [{ files: [{ streamUrl: '/api/stream/file' }],
      subtitleTracks: [{ vttUrl: '/api/subtitles/pt.vtt' }], poster_url: 'https://cdn.example/poster.jpg' }], activeProfile: null }), { status: 200 });
  });
  const result = await native.requestJson('/api/bootstrap');
  assert.equal(fetched, 'https://api.example.test/api/bootstrap');
  assert.equal(result.catalog[0].files[0].streamUrl, 'https://api.example.test/api/stream/file');
  assert.equal(result.catalog[0].subtitleTracks[0].vttUrl, 'https://api.example.test/api/subtitles/pt.vtt');
  assert.equal(result.catalog[0].poster_url, 'https://cdn.example/poster.jpg');
  assert.equal(result.activeProfile, null);
});

test('native stream prewarming reaches remote backend with HEAD', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, method: init.method }); return new Response(null, {status:200}); });
  native.prewarmStream(undefined, 'native-fixture');
  assert.deepEqual(calls, [{url:'https://api.example.test/api/stream/native-fixture?prewarm=1',method:'HEAD'}]);
});
