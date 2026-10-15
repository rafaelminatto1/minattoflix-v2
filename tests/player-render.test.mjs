import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/client/components/NetflixPlayer.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

for (const ios of [false, true]) {
  test(`player renders on ${ios ? 'iOS' : 'desktop'} without initialization errors`, () => {
    const exports = {};
    runInNewContext(code, {
      exports,
      require(id) {
        if (id === '../hooks/useDialog') return { useDialog: () => React.useRef(null) };
        if (id === '../services/mkvAudioController') return { isIosWebKit: () => ios };
        if (id.startsWith('../services/')) return { apiUrl: (path) => path };
        return require(id);
      },
      localStorage: { getItem: () => null },
      navigator: { onLine: true },
    });
    const html = renderToString(React.createElement(exports.NetflixPlayer, {
      item: {
        id: 'movie', title: 'Filme de teste', type: 'movie', runtime_minutes: 90,
        files: [{ id: 'file', container: 'mp4', filename: 'movie.mp4', streamUrl: '/video.mp4' }],
        audioTracks: [], subtitleTracks: [], progress: null,
      },
      activeProfile: { preferred_audio_lang: 'pt', preferred_subtitle_lang: 'off' },
      onClose() {}, onSaveProgress: async () => {}, onRefreshCatalog: async () => {},
    }));
    assert.match(html, /Reproduzindo Filme de teste/);
    assert.match(html, /<video/);
  });
}
