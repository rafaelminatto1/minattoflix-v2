import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const fixture = { tracks: [], disposed: 0, urls: [] };
globalThis.__audioFixture = fixture;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const mediaMock = moduleUrl(`
  const f = globalThis.__audioFixture;
  export class UrlSource { constructor(url) { f.urls.push(url); } }
  export class Input { async getAudioTracks() { return f.tracks; } dispose() { f.disposed++; } }
  export class AudioBufferSink {
    constructor(track) { this.track = track; }
    async getBuffer() { return this.track.decode(); }
    async *buffers() {}
  }
  export const MATROSKA={}, MP4={}, WEBM={};
`);
const ac3Mock = moduleUrl('export function registerAc3Decoder() {}');
const source = await readFile(new URL('../src/client/services/mkvAudioController.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from 'mediabunny'/g, `from '${mediaMock}'`)
  .replace(/import\('@mediabunny\/ac3'\)/g, `import('${ac3Mock}')`);
const { HybridAudioSyncController } = await import(moduleUrl(js));
const node = () => ({ gain: {value:1, setValueAtTime(value){this.value=value;}}, frequency:{}, Q:{}, threshold:{}, knee:{}, ratio:{}, attack:{}, release:{}, connect(){} });
globalThis.window = { location: { origin:'https://example.test' }, AudioContext: class {
  state='running'; currentTime=0; destination={};
  createGain=node; createBiquadFilter=node; createDynamicsCompressor=node;
  createAnalyser() { return {connect(){},getFloatTimeDomainData(array){array.fill(0);}}; }
  async close() { this.state='closed'; }
} };
const track = { source_type:'embedded', track_index:0, codec:'E-AC-3', label:'Português' };
function setup() {
  fixture.tracks=[{canDecode:async()=>true,decode:async()=>({buffer:{},timestamp:0})}];
  fixture.disposed=0; fixture.urls=[];
  const listeners = new Map();
  const video={paused:true,muted:false,volume:1,currentTime:0,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); }};
  return {video,ctrl:new HybridAudioSyncController(video)};
}

test('Dolby first track uses WASM and the selected stream; native AAC stays native', async () => {
  const {ctrl,video}=setup();
  const result=await ctrl.selectAudioTrack(track,undefined,'/mirror');
  assert.equal(result.mode,'wasm_ac3_mediabunny');
  assert.equal(video.muted,true);
  assert.deepEqual(fixture.urls,['https://example.test/mirror']);
  ctrl.setOutputVolume(0.4,true);
  assert.equal(ctrl.gainNode.gain.value,0);
  ctrl.setOutputVolume(0.4,false);
  assert.equal(ctrl.gainNode.gain.value,0.4);
  assert.equal(video.muted,true);
  assert.equal((await ctrl.selectAudioTrack({...track,codec:'AAC'})).mode,'embedded_container');
  assert.equal(video.muted,false);
  assert.equal(fixture.disposed,1);
  ctrl.destroy();
});

test('decoder capability failure reports unavailable audio and disposes input', async (t) => {
  t.mock.method(console, 'error', () => {});
  const {ctrl}=setup(); fixture.tracks[0].canDecode=async()=>false;
  const result=await ctrl.selectAudioTrack(track,undefined,'/mirror');
  assert.equal(result.mode,'audio_error'); assert.match(result.statusText,/Áudio indisponível/);
  assert.equal(fixture.disposed,1); ctrl.destroy();
});

test('worker startup failure cannot announce successful WASM decoding', async (t) => {
  t.mock.method(console, 'error', () => {});
  const {ctrl}=setup(); fixture.tracks[0].decode=async()=>{throw new Error('worker unavailable');};
  assert.equal((await ctrl.selectAudioTrack(track,undefined,'/mirror')).mode,'audio_error');
  assert.equal(fixture.disposed,1); ctrl.destroy();
});

test('a slow previous selection cannot replace the newer selection', async () => {
  const {ctrl,video}=setup(); let resolveDecode;
  fixture.tracks[0].decode=()=>new Promise(resolve=>resolveDecode=resolve);
  const previous=ctrl.selectAudioTrack(track,undefined,'/mirror');
  while(!resolveDecode) await new Promise(resolve=>setImmediate(resolve));
  await ctrl.selectAudioTrack({...track,codec:'AAC'});
  resolveDecode({buffer:{},timestamp:0});
  assert.equal((await previous).mode,'cancelled'); assert.equal(video.muted,false);
  assert.equal(fixture.disposed,1); ctrl.destroy();
});

test('hidden native video events cannot stop audio driven by the canvas clock', async () => {
  const {ctrl}=setup();
  ctrl.setClockOverride({getCurrentTime:()=>0,isPaused:()=>true,getPlaybackRate:()=>1},true);
  await ctrl.selectAudioTrack(track,undefined,'/mirror');
  let stops=0;
  ctrl.stopActiveBufferNodes=()=>{stops++;};
  ctrl.handlePause(new Event('pause'));
  ctrl.handleWaiting(new Event('waiting'));
  ctrl.handleSeek(new Event('seeking'));
  assert.equal(stops,0);
  ctrl.notifyClockPause();
  assert.equal(stops,1);
  ctrl.destroy();
});

test('play notification cannot start audio while the canvas waits for its first frame', () => {
 const {ctrl}=setup();
 let waiting=true;
 ctrl.setClockOverride({getCurrentTime:()=>0,isPaused:()=>waiting,getPlaybackRate:()=>1},true);
 let starts=0;
 ctrl.handlePlay=()=>{starts++;};
 ctrl.handlePlaying=()=>{starts++;};
 ctrl.notifyClockPlay();
 assert.equal(starts,0);
 waiting=false;
 ctrl.notifyClockPlay();
 assert.equal(starts,2);
 ctrl.destroy();
});

test('a playback tap resumes an interrupted iOS audio context', () => {
  const {ctrl}=setup();
  ctrl.resumeAudioContext();
  let resumes=0;
  ctrl.audioCtx.state='interrupted';
  ctrl.audioCtx.resume=()=>{resumes++;ctrl.audioCtx.state='running';return Promise.resolve();};
  ctrl.resumeAudioContext();
  assert.equal(resumes,1);
  ctrl.destroy();
});

test('audio uses a media playback session to bypass the iPhone silent switch', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const session = {type:'auto'};
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{audioSession:session}});
  const {ctrl}=setup();
  try {
    ctrl.resumeAudioContext();
    assert.equal(session.type,'playback');
  } finally {
    ctrl.destroy();
    if (original) Object.defineProperty(globalThis,'navigator',original);
    else delete globalThis.navigator;
  }
});

test('a tap starts an unlock source while iOS resume is pending', () => {
  const {ctrl}=setup();
  ctrl.resumeAudioContext();
  const ctx=ctrl.audioCtx;
  ctx.state='suspended';
  ctx.resume=()=>new Promise(()=>{});
  let started=0;
  ctx.createBuffer=()=>({});
  ctx.createBufferSource=()=>({connect(){},disconnect(){},start(){started++;}});
  ctrl.resumeAudioContext();
  assert.equal(started,1);
  ctrl.destroy();
});

test('decoded packets wait for audio unlock and use the current video position', async () => {
  const {ctrl,video}=setup();
  await ctrl.selectAudioTrack(track,undefined,'/mirror');
  video.paused=false;
  const ctx=ctrl.audioCtx;
  ctx.state='suspended';
  let unlock;
  ctx.resume=()=>new Promise(resolve=>{unlock=resolve;});
  const positions=[];
  ctrl.wasmSink={async *buffers(position){positions.push(position);}};
  const pumping=ctrl.startWasmPumpFrom(0);
  assert.deepEqual(positions,[]);
  video.currentTime=12;
  ctx.state='running';
  unlock();
  await pumping;
  assert.deepEqual(positions,[12]);
  ctrl.destroy();
});


test('native audio is suppressed during decoding and cannot leak after a browser unmute', async () => {
  const {ctrl,video}=setup(); let resolveDecode;
  video.audioTracks=[{enabled:true},{enabled:true}];
  fixture.tracks[0].decode=()=>new Promise(resolve=>resolveDecode=resolve);
  const selecting=ctrl.selectAudioTrack(track,undefined,'/mirror');
  assert.equal(video.muted,true);
  assert.deepEqual(video.audioTracks.map(t=>t.enabled),[false,false]);
  while(!resolveDecode) await new Promise(resolve=>setImmediate(resolve));
  video.muted=false; video.audioTracks[1].enabled=true; video.dispatch('volumechange');
  assert.equal(video.muted,true);
  assert.deepEqual(video.audioTracks.map(t=>t.enabled),[false,false]);
  resolveDecode({buffer:{},timestamp:0}); await selecting;
  video.muted=false; video.audioTracks[0].enabled=true; video.dispatch('loadedmetadata');
  assert.equal(video.muted,true);
  assert.deepEqual(video.audioTracks.map(t=>t.enabled),[false,false]);
  ctrl.stopWasmAudio();
  assert.equal(video.muted,true);
  ctrl.destroy();
});

test('failed selected audio stays silent instead of playing the original language', async (t) => {
  t.mock.method(console,'error',()=>{});
  const {ctrl,video}=setup(); fixture.tracks[0].canDecode=async()=>false;
  await ctrl.selectAudioTrack(track,undefined,'/mirror');
  assert.equal(video.muted,true);
  ctrl.setOutputVolume(1,false);
  assert.equal(video.muted,true);
  ctrl.destroy();
});

test('native track selection enables exactly one language after WASM playback', async () => {
  const {ctrl,video}=setup();
  await ctrl.selectAudioTrack(track,undefined,'/mirror');
  video.audioTracks=[{enabled:true},{enabled:true}];
  await ctrl.selectAudioTrack({...track,codec:'AAC',track_index:1});
  assert.equal(video.muted,false);
  assert.deepEqual(video.audioTracks.map(t=>t.enabled),[false,true]);
  ctrl.destroy();
});
