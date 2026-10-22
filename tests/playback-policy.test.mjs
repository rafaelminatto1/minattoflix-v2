import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import ts from 'typescript';
const source=await readFile(new URL('../src/client/services/playbackPolicy.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {isPortugueseAudio,portugueseAudio,portugueseFile,watchPlaybackVisibility}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('Brazilian Portuguese wins over original/default audio, including ISO and regional tags',()=>{
 const english={id:'en',language_code:'en',label:'Original',is_default:true};
 const pt={id:'pt',language_code:'pt_PT',label:'Português'};
 const br={id:'br',language_code:'pt-BR',label:'Português Brasil'};
 assert.equal(portugueseAudio([english,pt,br]),br);
 for(const language_code of ['pt','pt-PT','pt_BR','por','pob'])assert.equal(isPortugueseAudio({language_code,label:''}),true);
 assert.equal(isPortugueseAudio({language_code:'und',label:'Português'}),true);
 assert.equal(portugueseAudio([english]),undefined);
});
test('locking or hiding pauses playback; showing the app never resumes it and cleanup removes listeners',()=>{
 const doc=new EventTarget();doc.visibilityState='visible';const target=new EventTarget();
 let paused=0;const cleanup=watchPlaybackVisibility(doc,target,()=>paused++);
 assert.equal(paused,0);
 doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));assert.equal(paused,1);
 doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));assert.equal(paused,1);
 target.dispatchEvent(new Event('pagehide'));assert.equal(paused,2);
 cleanup();target.dispatchEvent(new Event('pagehide'));assert.equal(paused,2);
});

test('a dubbed version wins over a compatible original-language file',()=>{
 const original={id:'original',container:'mp4'};const dubbed={id:'dubbed',container:'mkv'};
 const tracks=[{media_file_id:'dubbed',language_code:'pt-BR',label:'Português'}];
 assert.equal(portugueseFile([original,dubbed],tracks,original),dubbed);
 assert.equal(portugueseFile([original],[],original),original);
});
