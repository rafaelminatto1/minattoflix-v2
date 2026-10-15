import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/client/services/fullscreen.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { togglePlayerFullscreen, enterPlayerFullscreen, exitPlayerFullscreen, isPlayerFullscreen } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('iOS calls native fullscreen synchronously even when container API exists', async () => {
  let native = false;
  const video = { webkitEnterFullscreen() { native = true; this.webkitDisplayingFullscreen = true; } };
  const pending = togglePlayerFullscreen({}, { requestFullscreen() { throw new Error('Wrong API'); } }, video, true);
  assert.equal(native, true);
  await pending;
  assert.equal(isPlayerFullscreen({}, video), true);
});

test('native fullscreen exits without a document fullscreen element', async () => {
  const video = { webkitDisplayingFullscreen: true, webkitExitFullscreen() { this.webkitDisplayingFullscreen = false; } };
  await togglePlayerFullscreen({}, {}, video, true);
  assert.equal(isPlayerFullscreen({}, video), false);
});

test('rejected container fullscreen falls back to native video', async () => {
  let calls = 0;
  await togglePlayerFullscreen({}, { requestFullscreen: async () => { throw new Error('Unsupported'); } }, { webkitEnterFullscreen() { calls++; } }, false);
  assert.equal(calls, 1);
});

test('desktop enters and exits document fullscreen', async () => {
  const doc = { fullscreenElement: null, async exitFullscreen() { this.fullscreenElement = null; } };
  const target = { async requestFullscreen() { doc.fullscreenElement = this; } };
  await togglePlayerFullscreen(doc, target, null, false);
  assert.equal(isPlayerFullscreen(doc, null), true);
  await togglePlayerFullscreen(doc, target, null, false);
  assert.equal(isPlayerFullscreen(doc, null), false);
});

test('enterPlayerFullscreen enters fullscreen and does nothing if already fullscreen', async () => {
  const doc = { fullscreenElement: null };
  let calls = 0;
  const target = { async requestFullscreen() { calls++; doc.fullscreenElement = this; } };
  await enterPlayerFullscreen(doc, target, null, false);
  assert.equal(calls, 1);
  assert.equal(isPlayerFullscreen(doc, null), true);
  // Calling again while already in fullscreen should not trigger requestFullscreen again
  await enterPlayerFullscreen(doc, target, null, false);
  assert.equal(calls, 1);
});

test('exitPlayerFullscreen exits fullscreen properly', async () => {
  const doc = { fullscreenElement: {}, async exitFullscreen() { this.fullscreenElement = null; } };
  await exitPlayerFullscreen(doc, null);
  assert.equal(isPlayerFullscreen(doc, null), false);
});

test('failure never reports fullscreen as active', async () => {
  const doc = {};
  await assert.rejects(togglePlayerFullscreen(doc, { requestFullscreen: async () => { throw new Error('Denied'); } }, null, false));
  assert.equal(isPlayerFullscreen(doc, null), false);
});

