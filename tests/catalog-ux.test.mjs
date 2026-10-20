import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const result=await build({stdin:{contents:`
 import React from 'react';
 import {renderToStaticMarkup} from 'react-dom/server';
 import {HeroBillboard} from './src/client/components/HeroBillboard';
 import {DetailModal} from './src/client/components/DetailModal';
 import {MediaRow} from './src/client/components/MediaRow';
 import {AccessContext} from './src/client/hooks/useAccess';
 export function render(kind,item,admin=false){const noop=()=>{};const props={item,onClose:noop,onPlay:noop,onMoreInfo:noop,onToggleMyList:noop,onRefreshCatalog:async()=>{}};
 const element=kind==='hero'?<HeroBillboard {...props} featuredItems={[item]}/>:kind==='row'?<MediaRow {...props} title="Continuar" items={[item]} onRemoveProgress={noop}/>:<DetailModal {...props}/>;
 return renderToStaticMarkup(<AccessContext.Provider value={{admin}}>{element}</AccessContext.Provider>);}
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',write:false,banner:{js:"import {createRequire as requireFactory} from 'node:module';import {fileURLToPath as urlPath} from 'node:url';const localRequire=requireFactory(process.cwd()+'/package.json');const require=id=>localRequire(id.startsWith('file:')?urlPath(id):id);"},plugins:[{name:'shared-react',setup(b){b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));}}],logLevel:'silent'});
const {render}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`).catch(error=>{throw new Error(error.message);});
const item={id:'film',title:'Filme de teste',files:[{id:'file',provider:'onedrive',container:'mp4',filename:'film.mp4',resolution:'1080p'}],audioTracks:[],subtitleTracks:[],seasons:[],rating:8,release_year:2026,runtime_minutes:100,age_rating:'L',overview:'Uma sinopse.',genres:[],progress:{position_seconds:1200,duration_seconds:6000,is_completed:false}};
test('viewer details keep playback choices without exposing management or disabled paid actions',()=>{
 const html=render('detail',item);
 assert.match(html,/Continuar/);assert.match(html,/Áudio e legendas/);
 assert.doesNotMatch(html,/Inspecionar Faixas|Curadoria IA|OpenSubtitles R2|Vincular Áudio/);
 assert.match(render('detail',item,true),/Inspecionar Faixas/);
});
test('continue watching reports remaining time, and artwork opens details even for missing media',()=>{
 const html=render('row',item);assert.match(html,/80 min restantes/);assert.match(html,/Ver detalhes de Filme de teste/);
 const unavailable=render('row',{...item,files:[]});assert.match(unavailable,/Ver detalhes de Filme de teste/);
 assert.match(render('detail',{...item,files:[]}),/Arquivo não disponível/);
});
test('primary mobile hero action has a visible continue label and no codec jargon',()=>{
 const html=render('hero',item);assert.match(html,/<span>Continuar<\/span>/);assert.doesNotMatch(html,/Canais a verificar|Codec a verificar/);
});
