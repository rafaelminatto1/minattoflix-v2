import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function transpile(file){return ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;}
const fixture={authorized:false};globalThis.__preparationFixture=fixture;
const dependency=moduleUrl(`export function restrictedCosts(){return false;} export function getDb(){return async()=>[];} export async function fetchGDriveStream(){return new Response('source');} export async function fetchOneDriveStream(){return new Response('source');} export async function verifyPreparationRunner(){return globalThis.__preparationFixture.authorized;}`);
let source=await transpile('../src/worker/routes/preparation.ts');
source=source.replace(/from 'hono'/,`from '${pathToFileURL(require.resolve('hono')).href}'`).replace(/from '\.\.\/[^']+'/g,`from '${dependency}'`);
const {preparationRoutes,parsePreparedRange}=await import(moduleUrl(source));
const fileId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const base=`https://test.invalid/api/preparation/jobs/${jobId}`;
function setup(){
 const job={id:jobId,fileId,state:'uploading',uploadId:'upload',objectKey:'fixture.mp4',createdAt:Date.now(),updatedAt:Date.now()};
 const store=new Map([[`preparation:job:${jobId}`,JSON.stringify(job)],[`preparation:file:${fileId}`,jobId]]);
 const reads=[];
 const env={MINATTO_KV:{get:async key=>store.get(key)||null,put:async(key,value)=>store.set(key,value)},MEDIA_BUCKET:{get:async(key,options)=>{reads.push({key,options});return {body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.close();}})};},
 resumeMultipartUpload:()=>({complete:async()=>({size:100}),uploadPart:async number=>({partNumber:number,etag:'etag'})})}};
 return {env,store,job,reads};
}
test('prepared ranges reject malformed and unsatisfiable requests and support suffixes',()=>{
 assert.deepEqual(parsePreparedRange('bytes=10-19',100),{offset:10,length:10});
 assert.deepEqual(parsePreparedRange('bytes=-10',100),{offset:90,length:10});
 assert.deepEqual(parsePreparedRange('bytes=90-',100),{offset:90,length:10});
 for(const input of ['bytes=100-','bytes=4-2','bytes=-0','bytes=0-1,4-5','bytes=-','invalid'])assert.equal(parsePreparedRange(input,100),null);
});
test('untrusted executor cannot upload or finalize media',async()=>{
 fixture.authorized=false;
 const {env}=setup();
 assert.equal((await preparationRoutes.fetch(new Request(base+'/complete',{method:'POST',body:'{}'}),env)).status,401);
});
test('media is not playable before multipart completion; complete publishes range-readable output',async()=>{
 fixture.authorized=true;
 const {env,reads}=setup();
 const statusUrl=`https://test.invalid/api/playback/${fileId}`;
 assert.equal((await (await preparationRoutes.fetch(new Request(statusUrl),env)).json()).url,null);
 const completed=await preparationRoutes.fetch(new Request(base+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{partNumber:1,etag:'etag'}],duration:10})}),env);
 assert.equal(completed.status,200);
 const status=await completed.json();assert.equal(status.state,'ready');
 const media=await preparationRoutes.fetch(new Request('https://test.invalid'+status.url,{headers:{Range:'bytes=10-19'}}),env);
 assert.equal(media.status,206);assert.equal(media.headers.get('Content-Range'),'bytes 10-19/100');
 assert.deepEqual(reads,[{key:'fixture.mp4',options:{range:{offset:10,length:10}}}]);
 const head=await preparationRoutes.fetch(new Request('https://test.invalid'+status.url,{method:'HEAD'}),env);
 assert.equal(head.headers.get('Content-Length'),'100');assert.equal(reads.length,1);
});
test('invalid multipart sequence cannot mark media ready',async()=>{
 fixture.authorized=true;
 const {env}=setup();
 const response=await preparationRoutes.fetch(new Request(base+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{partNumber:2,etag:'etag'}],duration:10})}),env);
 assert.equal(response.status,400);
});

const {verifyPreparationRunner}=await import(moduleUrl(await transpile('../src/worker/services/github-identity.ts')));
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
test('runner authentication verifies signature, repository, workflow, audience and expiry',async t=>{
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);
 t.mock.method(globalThis,'fetch',async()=>Response.json({keys:[{...jwk,kid:'fixture'}]}));
 const claims={iss:'https://token.actions.githubusercontent.com',aud:'minattoflix-media',repository:'rafaelminatto1/minattoflix-v2',ref:'refs/heads/main',workflow_ref:'rafaelminatto1/minattoflix-v2/.github/workflows/prepare-media.yml@refs/heads/main',exp:Date.now()/1000+300};
 const token=async overrides=>{
  const body=`${encode({alg:'RS256',kid:'fixture'})}.${encode({...claims,...overrides})}`;
  const signature=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(body))).toString('base64url');
  return `Bearer ${body}.${signature}`;
 };
 assert.equal(await verifyPreparationRunner(await token({})),true);
 for(const overrides of [{aud:'other'},{repository:'attacker/repo'},{workflow_ref:'other'},{exp:1},{ref:'refs/heads/untrusted'}])assert.equal(await verifyPreparationRunner(await token(overrides)),false);
 assert.equal(await verifyPreparationRunner('Bearer invalid'),false);
});
