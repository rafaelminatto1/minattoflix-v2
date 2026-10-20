import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/client/services/catalog.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { qualityLabel, audioLabel, matchesSearch, requestJson, addedTime } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const item = {
  title: 'Ação no Coração', original_title: 'Action', overview: 'Uma aventura', cast_info: ['José Silva'],
  genres: [{ name: 'Ficção científica' }], created_at: '2026-10-11T00:00:00Z',
  files: [{ filename: 'action.mkv', resolution: '2160p', dynamic_range: 'SDR', audioTracks: [{ language_code: 'pt-BR' }] }],
  audioTracks: [{ language_code: 'en-US' }], subtitleTracks: [{ language_code: 'es' }],
};

test('search ignores accents and matches multiple terms, actors, genres and actual languages', () => {
  assert.equal(matchesSearch(item, 'acao coracao'), true);
  assert.equal(matchesSearch(item, 'jose ficcao'), true);
  assert.equal(matchesSearch(item, '4k pt-br'), true);
  assert.equal(matchesSearch(item, 'acao inexistente'), false);
  assert.equal(matchesSearch(item, '  CORAÇÃO  '), true);
});
test('quality never invents HDR and audio never invents channels or languages', () => {
  assert.equal(qualityLabel(item.files[0]), '4K');
  assert.equal(qualityLabel({ resolution: '1080p', dynamic_range: 'HDR10' }), '1080p HDR10');
  assert.equal(qualityLabel(undefined), 'Indisponível');
  assert.equal(audioLabel(item), 'PT-BR');
  assert.equal(audioLabel({ files: [], audioTracks: [] }), 'Áudio a verificar');
  assert.equal(addedTime(item), Date.parse(item.created_at));
});
test('failed requests reject instead of announcing success', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    await assert.rejects(requestJson('/api/test'), /500/);
    globalThis.fetch = async () => Response.json({ ok: true });
    assert.deepEqual(await requestJson('/api/test'), { ok: true });
  } finally { globalThis.fetch = original; }
});

test('concurrent catalog consumers receive independent response bodies', async t => {
 let finish; let calls=0;
 t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
 const first=requestJson('/api/concurrent');
 const second=requestJson('/api/concurrent');
 finish(Response.json({ok:true}));
 assert.deepEqual(await Promise.all([first,second]),[{ok:true},{ok:true}]);
 assert.equal(calls,1);
});

test('independent cancellation signals cannot abort another consumer', async t => {
 let calls=0;
 t.mock.method(globalThis,'fetch',async ()=>{calls++;return Response.json({ok:true});});
 await Promise.all([requestJson('/api/cancel',{signal:new AbortController().signal}),requestJson('/api/cancel',{signal:new AbortController().signal})]);
 assert.equal(calls,2);
});
