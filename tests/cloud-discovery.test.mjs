import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function load(name) {
  const source = await readFile(new URL(`../src/worker/services/${name}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const {listGDriveFolderEntries,scanGDriveRootFolder}=await load('gdrive');
const {scanOneDriveSharedFolder}=await load('onedrive');

test('Drive follows pagination and an empty API folder does not fall back to scraping', async t => {
 const calls=[];
 t.mock.method(globalThis,'fetch',async url=>{
  const parsed=new URL(url);calls.push(parsed);
  return Response.json(parsed.searchParams.has('pageToken')?{files:[{id:'b',name:'b.mp4',mimeType:'video/mp4'}]}:
   {nextPageToken:'page-2',files:[{id:'a',name:'a.mp4',mimeType:'video/mp4'}]});
 });
 assert.deepEqual((await listGDriveFolderEntries('root','test-key')).map(f=>f.id),['a','b']);
 assert.equal(calls[1].searchParams.get('pageToken'),'page-2');
 t.mock.method(globalThis,'fetch',async ()=>Response.json({files:[]}));
 assert.deepEqual(await listGDriveFolderEntries('empty','test-key'),[]);
});

test('Drive partial subfolder failure rejects the scan instead of returning an empty folder', async t => {
 t.mock.method(globalThis,'fetch',async url=>new URL(url).searchParams.get('q').includes("'root'")?
  Response.json({files:[{id:'folder',name:'Library',mimeType:'application/vnd.google-apps.folder'}]}):new Response(null,{status:503}));
 await assert.rejects(scanGDriveRootFolder('root','test-key'),/Falha na pasta Library/);
});

test('OneDrive includes root and child continuation pages and rejects partial results', async t => {
 let fail=false;
 t.mock.method(globalThis,'fetch',async url=>{
  url=String(url);
  if(url.includes('/v1.0/token'))return Response.json({token:'fixture-only'});
  if(url.includes('/driveItem?'))return Response.json({id:'root',children:[{id:'folder',name:'Movies',folder:{},parentReference:{driveId:'drive'}}],
   'children@odata.nextLink':'https://my.microsoftpersonalcontent.com/root-page-2'});
  if(url.endsWith('/root-page-2'))return Response.json({value:[{id:'a',name:'a.mp4'}]});
  if(url.endsWith('/children'))return fail?new Response(null,{status:503}):Response.json({value:[{id:'b',name:'b.mp4'}],
   '@odata.nextLink':'https://my.microsoftpersonalcontent.com/child-page-2'});
  if(url.endsWith('/child-page-2'))return Response.json({value:[{id:'c',name:'c.mp4'}]});
  throw new Error('Unexpected URL');
 });
 const result=await scanOneDriveSharedFolder('https://1drv.ms/f/fixture');
 assert.deepEqual(result.flatMap(b=>b.files.map(f=>f.id)),['a','b','c']);
 fail=true;
 await assert.rejects(scanOneDriveSharedFolder('https://1drv.ms/f/fixture'),/Falha na pasta Movies/);
});
