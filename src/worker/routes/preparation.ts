import {Hono} from 'hono';
import {getDb,type Env} from '../db';
import {fetchGDriveStream} from '../services/gdrive';
import {fetchOneDriveStream} from '../services/onedrive';
import {verifyPreparationRunner} from '../services/github-identity';
import {restrictedCosts} from '../services/cost-policy';

interface PreparationJob {
 id:string; fileId:string; state:'queued'|'processing'|'uploading'|'ready'|'failed'; createdAt:number; updatedAt:number;
 provider:string; externalId:string; shareUrl:string; filename:string; objectKey:string;
 uploadId?:string; sizeBytes?:number; duration?:number; error?:string; progress?:number;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobKey=(id:string)=>`preparation:job:${id}`;
const fileKey=(id:string)=>`preparation:file:${id}`;
const load=async(env:Env,id:string):Promise<PreparationJob|null>=>{
 const value=await env.MINATTO_KV?.get(jobKey(id));return value?JSON.parse(value):null;
};
const save=async(env:Env,job:PreparationJob)=>{
 job.updatedAt=Date.now();await env.MINATTO_KV!.put(jobKey(job.id),JSON.stringify(job));
};
const publicStatus=(job:PreparationJob|null)=>job?{
 state:job.state,jobId:job.id,progress:job.progress||0,error:job.error,
 url:job.state==='ready'?`/api/prepared/${job.fileId}/${job.id}.mp4`:null,
 duration:job.duration,quality:'HD compatível (até 720p)',
}:{state:'needs_preparation',url:null};

export function parsePreparedRange(header:string,size:number):{offset:number;length:number}|null {
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);
 if(!match || (!match[1]&&!match[2]) || size<=0)return null;
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
 const end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;
 return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start?{offset:start,length:end-start+1}:null;
}

export const preparationRoutes=new Hono<{Bindings:Env}>();
preparationRoutes.get('/api/playback/:fileId',async c=>{
 const fileId=c.req.param('fileId');if(!uuid.test(fileId))return c.json({error:'Arquivo inválido.'},400);
 if(restrictedCosts(c.env)) {
  const sql=getDb(c.env);
  const files=await sql`SELECT container,filename FROM media_files WHERE id=${fileId} LIMIT 1`;
  if(!files[0])return c.json({error:'Arquivo não encontrado.'},404);
  const compatible=/^(mp4|m4v)$/i.test(String(files[0].container||'')) || /\.(mp4|m4v)$/i.test(String(files[0].filename||''));
  return c.json(compatible?{state:'ready',url:`/api/stream/${fileId}`,quality:'Arquivo original; compatibilidade depende dos codecs'}:
   {state:'needs_local_preparation',url:null,error:'Preparação na nuvem desativada para evitar cobrança. Use o player alternativo ou prepare uma cópia MP4 no computador.'});
 }
 const id=await c.env.MINATTO_KV?.get(fileKey(fileId));
 const job=id?await load(c.env,id):null;
 return c.json(publicStatus(job),200,{'Cache-Control':'no-store'});
});

preparationRoutes.post('/api/preparation/:fileId',async c=>{
 if(restrictedCosts(c.env))return c.json({error:'Preparação na nuvem desativada para evitar cobrança adicional.'},409);
 if(!c.env.MINATTO_KV || !c.env.MEDIA_BUCKET?.createMultipartUpload || !c.env.GITHUB_TOKEN)return c.json({error:'Preparação não configurada.'},503);
 const fileId=c.req.param('fileId');if(!uuid.test(fileId))return c.json({error:'Arquivo inválido.'},400);
 const previousId=await c.env.MINATTO_KV.get(fileKey(fileId));
 const previous=previousId?await load(c.env,previousId):null;
 if(previous && (previous.state==='ready' || (previous.state!=='failed' && Date.now()-previous.updatedAt<6*60*60*1000)))return c.json(publicStatus(previous));
 const sql=getDb(c.env);
 const rows=await sql`SELECT mf.id,mf.filename,mf.external_file_id,ss.provider,ss.share_url FROM media_files mf JOIN storage_sources ss ON ss.id=mf.storage_source_id WHERE mf.id=${fileId} LIMIT 1`;
 if(!rows.length)return c.json({error:'Arquivo não encontrado.'},404);
 const row=rows[0];const id=crypto.randomUUID();
 const job:PreparationJob={id,fileId,state:'queued',createdAt:Date.now(),updatedAt:Date.now(),provider:String(row.provider),
  externalId:String(row.external_file_id),shareUrl:String(row.share_url||''),filename:String(row.filename),objectKey:`prepared/v1/${fileId}/${id}.mp4`,progress:0};
 await save(c.env,job);await c.env.MINATTO_KV.put(fileKey(fileId),id);
 try {
  const response=await fetch('https://api.github.com/repos/rafaelminatto1/minattoflix-v2/actions/workflows/prepare-media.yml/dispatches',{
   method:'POST',headers:{Authorization:`Bearer ${c.env.GITHUB_TOKEN}`,'User-Agent':'MinattoFlix','Content-Type':'application/json',Accept:'application/vnd.github+json'},
   body:JSON.stringify({ref:'main',inputs:{job_id:id,file_id:fileId,api_origin:new URL(c.req.url).origin}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`O executor de preparação respondeu HTTP ${response.status}.`);
 }catch(error){job.state='failed';job.error=error instanceof Error?error.message:'Não foi possível iniciar a preparação.';await save(c.env,job);return c.json({error:job.error},502);}
 return c.json(publicStatus(job),202);
});

preparationRoutes.use('/api/preparation/jobs/*',async(c,next)=>{
 if(!await verifyPreparationRunner(c.req.header('Authorization')))return c.json({error:'Executor não autorizado.'},401);
 await next();
});

preparationRoutes.get('/api/preparation/jobs/:jobId/source',async c=>{
 const job=await load(c.env,c.req.param('jobId'));if(!job)return c.json({error:'Trabalho inexistente.'},404);
 if(job.state==='ready'||job.state==='failed')return c.json({error:'Trabalho encerrado.'},409);
 const range=c.req.header('Range');
 return job.provider==='onedrive'?fetchOneDriveStream(job.externalId,job.shareUrl,range,c.env.MINATTO_KV):fetchGDriveStream(job.externalId,range,c.env.GDRIVE_API_KEY,c.env.MINATTO_KV);
});

preparationRoutes.post('/api/preparation/jobs/:jobId/status',async c=>{
 const job=await load(c.env,c.req.param('jobId'));if(!job)return c.json({error:'Trabalho inexistente.'},404);
 if(job.state==='ready')return c.json({ok:true});
 const body=await c.req.json().catch(()=>null);
 if(!['processing','failed'].includes(body?.state))return c.json({error:'Estado inválido.'},400);
 job.state=body.state;job.progress=Math.min(90,Math.max(0,Number(body.progress)||0));
 if(body.state==='failed')job.error='A preparação falhou. Consulte o trabalho no GitHub e tente novamente.';
 await save(c.env,job);return c.json({ok:true});
});

preparationRoutes.post('/api/preparation/jobs/:jobId/upload',async c=>{
 const job=await load(c.env,c.req.param('jobId'));if(!job)return c.json({error:'Trabalho inexistente.'},404);
 if(job.state==='ready'||job.state==='failed')return c.json({error:'Trabalho encerrado.'},409);
 if(!job.uploadId){
  const upload=await c.env.MEDIA_BUCKET!.createMultipartUpload!(job.objectKey,{httpMetadata:{contentType:'video/mp4'}});
  job.uploadId=upload.uploadId;job.state='uploading';job.progress=90;await save(c.env,job);
 }
 return c.json({uploadId:job.uploadId});
});

preparationRoutes.put('/api/preparation/jobs/:jobId/parts/:part',async c=>{
 const job=await load(c.env,c.req.param('jobId'));const part=Number(c.req.param('part'));
 if(!job?.uploadId||job.state!=='uploading')return c.json({error:'Upload indisponível.'},409);
 const length=Number(c.req.header('Content-Length'));
 if(!Number.isInteger(part)||part<1||part>10000||!c.req.raw.body||!Number.isFinite(length)||length<1||length>32*1024*1024)return c.json({error:'Parte inválida.'},400);
 const upload=c.env.MEDIA_BUCKET!.resumeMultipartUpload!(job.objectKey,job.uploadId);
 const uploaded=await upload.uploadPart(part,c.req.raw.body);
 return c.json(uploaded);
});

preparationRoutes.post('/api/preparation/jobs/:jobId/complete',async c=>{
 const job=await load(c.env,c.req.param('jobId'));if(!job?.uploadId)return c.json({error:'Upload indisponível.'},409);
 if(job.state==='ready')return c.json(publicStatus(job));
 if(job.state!=='uploading')return c.json({error:'Trabalho encerrado.'},409);
 const body=await c.req.json().catch(()=>null);
 const parts=body?.parts as Array<{partNumber:number;etag:string}>|undefined;
 if(!Array.isArray(parts)||parts.length<1||parts.length>10000||parts.some((p,i)=>p.partNumber!==i+1||typeof p.etag!=='string')||!Number.isFinite(body.duration)||body.duration<=0)return c.json({error:'Resultado de mídia inválido.'},400);
 const upload=c.env.MEDIA_BUCKET!.resumeMultipartUpload!(job.objectKey,job.uploadId);
 const result=await upload.complete(parts);
 job.state='ready';job.sizeBytes=result.size;job.duration=body.duration;job.progress=100;await save(c.env,job);
 return c.json(publicStatus(job));
});

preparationRoutes.on(['GET','HEAD'],'/api/prepared/:fileId/:object',async c=>{
 const fileId=c.req.param('fileId'),id=c.req.param('object').replace(/\.mp4$/,'');
 if(!uuid.test(fileId)||!uuid.test(id))return c.json({error:'Arquivo inválido.'},400);
 const job=await load(c.env,id);
 if(!job||job.fileId!==fileId||job.state!=='ready'||!job.sizeBytes)return c.json({error:'Vídeo ainda não preparado.'},404);
 const size=job.sizeBytes;const rangeHeader=c.req.header('Range');
 const range=rangeHeader?parsePreparedRange(rangeHeader,size):undefined;
 if(rangeHeader&&!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
 const headers=new Headers({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(range?.length||size),'Cache-Control':'public, max-age=3600'});
 if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${size}`);
 if(c.req.method==='HEAD')return new Response(null,{status:range?206:200,headers});
 const object=await c.env.MEDIA_BUCKET!.get(job.objectKey,range?{range}:undefined);
 if(!object)return c.json({error:'Vídeo preparado indisponível.'},404);
 return new Response(object.body,{status:range?206:200,headers});
});
