import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const policyExports = {};
runInNewContext(ts.transpileModule(await readFile(new URL('../src/client/services/playbackPolicy.ts', import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText, {exports:policyExports});
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
        if (id === '../services/playbackPolicy') return policyExports;
        if (id === '../services/playbackPolicy') return policyExports;
      if (id === '../hooks/useDialog') return { useDialog: () => React.useRef(null) };
        if (id === '../services/mkvAudioController') return { isIosWebKit: () => ios, isTvOrAndroidNative: () => false };
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

test('index.css contains YouTube-like cursor hiding rules for player-shell', async () => {
  const css = await readFile(new URL('../src/client/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.player-shell\.hide-cursor/);
  assert.match(css, /cursor:\s*none\s*!important/);
});

test('NetflixPlayer implements streaming best practices (Media Session, HLS buffer, shortcuts)', async () => {
  const content = await readFile(new URL('../src/client/components/NetflixPlayer.tsx', import.meta.url), 'utf8');
  assert.match(content, /navigator\.mediaSession/);
  assert.match(content, /setPositionState/);
  assert.match(content, /backBufferLength:\s*60/);
  assert.match(content, /capLevelToPlayerSize:\s*true/);
  assert.match(content, /fastSeek/);
  assert.match(content, /handleVideoDoubleClick/);
  assert.match(content, /showOsdFeedback/);

});

test('NetflixPlayer starts every title without subtitles despite saved or forced defaults', () => {
  const exports = {};
  const initialStates=[];
  runInNewContext(code, {
    exports,
    require(id) {
      if(id==='react') return {...React,useState(initial){const value=typeof initial==='function'?initial():initial;initialStates.push(value);return React.useState(initial);}};
      if (id === '../services/playbackPolicy') return policyExports;
      if (id === '../hooks/useDialog') return { useDialog: () => React.useRef(null) };
      if (id === '../services/mkvAudioController') return { isIosWebKit: () => false, isTvOrAndroidNative: () => false };
      if (id.startsWith('../services/')) return { apiUrl: (path) => path };
      return require(id);
    },
    localStorage: { getItem: () => null },
    navigator: { onLine: true },
  });

  // 1. Portuguese movie - subtitles must default to disabled
  const ptHtml = renderToString(React.createElement(exports.NetflixPlayer, {
    item: {
      id: 'movie-pt', title: 'Filme Nacional', type: 'movie', runtime_minutes: 90,
      files: [{ id: 'file-pt', container: 'mp4', filename: 'filme.mp4', streamUrl: '/filme.mp4' }],
      audioTracks: [{ id: 'audio-pt', media_file_id: 'file-pt', language_code: 'pt-BR', label: 'Português', is_default: true }],
      subtitleTracks: [{ id: 'sub-pt', media_file_id: 'file-pt', language_code: 'pt-BR', label: 'Português (Brasil)', is_default: false }],
      progress: {selected_subtitle_id:'sub-pt'},
    },
    activeProfile: { preferred_audio_lang: 'pt-BR', preferred_subtitle_lang: 'off' },
    onClose() {}, onSaveProgress: async () => {}, onRefreshCatalog: async () => {},
  }));
  assert.ok(ptHtml.includes('Filme Nacional'));
  assert.ok(initialStates.includes('off'));
  assert.ok(!initialStates.includes('sub-pt'));
  initialStates.length=0;

  // Foreign and forced subtitles must also start disabled.
  const enHtml = renderToString(React.createElement(exports.NetflixPlayer, {
    item: {
      id: 'movie-en', title: 'The Odyssey', type: 'movie', runtime_minutes: 120,
      files: [{ id: 'file-en', container: 'mkv', filename: 'odyssey.mkv', streamUrl: '/odyssey.mkv' }],
      audioTracks: [{ id: 'audio-en', media_file_id: 'file-en', language_code: 'en-US', label: 'Inglês', is_default: true }],
      subtitleTracks: [
        { id: 'sub-pt', media_file_id: 'file-en', language_code: 'pt-BR', label: 'Português (Brasil) [OpenSubtitles]', is_default: true },
        { id: 'sub-en', media_file_id: 'file-en', language_code: 'en-US', label: 'Inglês [OpenSubtitles]', is_default: false },
      ],
      progress: {selected_subtitle_id:'sub-pt'},
    },
    activeProfile: { preferred_audio_lang: 'pt-BR', preferred_subtitle_lang: 'off' },
    onClose() {}, onSaveProgress: async () => {}, onRefreshCatalog: async () => {},
  }));
  assert.ok(enHtml.includes('The Odyssey'));
  assert.ok(initialStates.includes('off'));
  assert.ok(!initialStates.includes('sub-pt'));
});
