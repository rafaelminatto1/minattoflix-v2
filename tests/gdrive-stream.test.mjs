import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/worker/services/gdrive.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { fetchGDriveStream } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('Drive open-ended and initial requests use bounded media ranges; explicit ranges are preserved', async t => {
  const ranges = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    ranges.push(options.headers.get('Range'));
    return new Response(new Uint8Array([0x1a, 0x45]), { status: 206, headers: { 'Content-Type': 'video/x-matroska' } });
  });
  await fetchGDriveStream('file', 'bytes=0-');
  await fetchGDriveStream('file', 'bytes=100-');
  await fetchGDriveStream('file', null);
  await fetchGDriveStream('file', 'bytes=5-15');
  await fetchGDriveStream('file', 'bytes=0-1048575');
  assert.deepEqual(ranges, ['bytes=0-2097151', 'bytes=100-2097251', 'bytes=0-2097151', 'bytes=5-15', 'bytes=0-1048575']);
});

test('Drive confirmation HTML is rejected instead of returned as video', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>download unavailable</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(fetchGDriveStream('file', 'bytes=0-'), /não disponibilizou os bytes/);
});
