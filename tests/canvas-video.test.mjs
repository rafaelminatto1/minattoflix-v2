import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const fixture = { fail: false, clock: 0 };
globalThis.__canvasVideoFixture = fixture;
const mediaMock = dataModule(`
 export class UrlSource {}
 export class AudioBufferSink {}
 export const MATROSKA={}, WEBM={}, MP4={};
 export class Input {
   dispose() {}
   async getPrimaryVideoTrack() { return {canDecode:async()=>true,getDisplayWidth:async()=>1920,getDisplayHeight:async()=>1080}; }
   async getDurationFromMetadata() { return 100; }
 }
 export class CanvasSink {
   async getCanvas() { throw new Error('Preview must not decode before a user gesture'); }
   async *canvases() {
     if(globalThis.__canvasVideoFixture.firstFrame) await globalThis.__canvasVideoFixture.firstFrame;
     yield {timestamp:0,canvas:{}};
     if(globalThis.__canvasVideoFixture.nextFrame) await globalThis.__canvasVideoFixture.nextFrame;
     if(globalThis.__canvasVideoFixture.fail) throw new Error('decoder stopped');
     yield {timestamp:0.04,canvas:{}};
   }
 }
`);
let source = await readFile(new URL('../src/client/services/mkvAudioController.ts', import.meta.url), 'utf8');
let js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
 .replace(/from 'mediabunny'/g, `from '${mediaMock}'`)
 .replace(/import\('mediabunny'\)/g, `import('${mediaMock}')`);
const { MkvWebCodecsCanvasPlayer } = await import(dataModule(js));
globalThis.window = {location:{origin:'https://test.invalid'}};
function setup() {
 const events = [];
 const canvas = {width:0,height:0,dataset:{},getContext:()=>({drawImage(){events.push('draw');}})};
 const player = new MkvWebCodecsCanvasPlayer(canvas, {
  onLoadedMetadata(){},onTimeUpdate(){events.push('time');},onCanPlay(){events.push('ready');},onReadyToPlay(){events.push('prepared');},onWaiting(){},onError(reason){events.push(reason);}
 });
 return {events,player,canvas};
}
const settle = async () => { for(let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve)); };
test('slow decoding draws frames before announcing readiness instead of dropping all late frames', async t => {
 fixture.fail=false; fixture.clock=0;
 t.mock.method(performance,'now',()=>fixture.clock+=400);
 const {player,events,canvas}=setup();
 await player.open('/movie'); await settle();
 assert.equal(events.filter(x=>x==='draw').length,2);
 assert.equal(events[0],'draw'); assert.equal(events[1],'ready');
 assert.equal(canvas.dataset.presentedFrames,'2'); player.destroy();
});

test('a stalled decoder gates audio before the delayed frame arrives and resumes after drawing it', async () => {
 fixture.fail=false;
 let release;
 fixture.nextFrame=new Promise(resolve=>{release=resolve;});
 const {player,events}=setup();
 try {
  await player.open('/movie');await settle();
  assert.equal(player.isWaitingForFrame(),false);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(player.isWaitingForFrame(),true);
  release();await settle();
  assert.equal(player.isWaitingForFrame(),false);
  assert.equal(events.filter(event=>event==='ready').length,2);
 } finally {release();fixture.nextFrame=null;player.destroy();}
});
test('frame decoder failure reports an error and stops its playback clock', async t => {
 fixture.fail=true; t.mock.method(console,'warn',()=>{});
 const {player,events}=setup(); await player.open('/movie'); await settle();
 assert.ok(events.includes('decoder stopped')); assert.equal(player.isPaused(),true); player.destroy();
});

test('iPhone preparation offers play without decoding a preview or advancing the clock', async () => {
 fixture.fail=false;
 const {player,events}=setup();
 assert.equal(await player.open('/movie',12,false),true);
 await settle();
 assert.equal(player.isPaused(),true);
 assert.equal(player.getCurrentTime(),12);
 assert.deepEqual(events,['prepared']);
 player.play(); await settle();
 assert.equal(player.isPaused(),false);
 assert.ok(events.includes('time'));
 player.destroy();
});

test('audio clock remains gated until the first decoded frame is drawn, including after seeking', async () => {
 fixture.fail=false;
 let release;
 fixture.firstFrame=new Promise(resolve=>{release=resolve;});
 const {player,events}=setup();
 try {
  await player.open('/movie',12,false);
  player.play(); await settle();
  assert.equal(player.isPaused(),false);
  assert.equal(player.isWaitingForFrame(),true);
  assert.equal(player.getCurrentTime(),12);
  assert.ok(!events.includes('draw'));
  release(); await settle();
  assert.equal(player.isWaitingForFrame(),false);
  assert.ok(events.indexOf('draw')<events.indexOf('ready'));
  fixture.firstFrame=new Promise(resolve=>{release=resolve;});
  player.seek(40); await settle();
  assert.equal(player.isWaitingForFrame(),true);
  assert.equal(player.getCurrentTime(),40);
  release(); await settle();
  assert.equal(player.isWaitingForFrame(),false);
 } finally { release(); fixture.firstFrame=null; player.destroy(); }
});
