import React,{useEffect,useRef,useState} from 'react';
import {registerPlugin,type PluginListenerHandle} from '@capacitor/core';
import type {MediaItem,Profile} from '../types';
import {apiUrl,requestJson} from '../services/catalog';
import {useDialog} from '../hooks/useDialog';

interface Progress {position:number;duration:number}
interface NativePlayer {
 play(options:{url:string;position:number;audioLanguage:string;subtitleLanguage:string}):Promise<Progress>;
 addListener(event:'progress',callback:(progress:Progress)=>void):Promise<PluginListenerHandle>;
}
interface Status {state:string;url?:string|null;progress?:number;error?:string;quality?:string}
interface Props {
 item:MediaItem;activeProfile:Profile;initialFileId?:string;initialAudioId?:string;initialSubtitleId?:string;
 onClose:()=>void;onFallback:()=>void;
 onSaveProgress:(data:{mediaItemId:string;positionSeconds:number;durationSeconds:number;selectedAudioId?:string;selectedSubtitleId?:string})=>Promise<void>;
}
const player=registerPlugin<NativePlayer>('NativePlayer');

export function NativePlayback(props:Props) {
 const {item,activeProfile,onClose,onFallback}=props;
 const dialog=useDialog(onClose);
 const file=item.files.find(f=>f.id===props.initialFileId)||item.files.find(f=>/^(mp4|m4v)$/i.test(f.container||''))||item.files.find(f=>f.provider==='onedrive')||item.files[0];
 const [status,setStatus]=useState<Status|null>(null);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const started=useRef(false);
 const saveRef=useRef(props.onSaveProgress);saveRef.current=props.onSaveProgress;
 const closeRef=useRef(onClose);closeRef.current=onClose;
 const fallbackRef=useRef(onFallback);fallbackRef.current=onFallback;
 const [refresh,setRefresh]=useState(0);

 useEffect(()=>{
  if(!file)return;
  let active=true;let timer:ReturnType<typeof setTimeout>;
  const controller=new AbortController();
  const check=async()=>{
   try {
    const next=await requestJson<Status>(`/api/playback/${file.id}`,{signal:controller.signal});
    if(!active)return;
    // Unsupported native containers can still be decoded by the in-app player.
    // Keep playback automatic instead of blocking on disabled cloud preparation.
    if(['needs_local_preparation','needs_preparation','failed'].includes(next.state)) {
     fallbackRef.current();return;
    }
    setStatus(next);
    if(['queued','processing','uploading'].includes(next.state))timer=setTimeout(check,5000);
   }catch{if(active)fallbackRef.current();}
  };
  void check();
  return()=>{active=false;controller.abort();clearTimeout(timer);};
 },[file?.id,refresh]);

 useEffect(()=>{
  if(status?.state!=='ready'||!status.url||started.current)return;
  started.current=true;setError('');
  let listener:PluginListenerHandle|undefined;
  let disposed=false;
  const audio=item.audioTracks.find(track=>track.id===props.initialAudioId);
  const subtitle=item.subtitleTracks.find(track=>track.id===props.initialSubtitleId);
  const save=async(progress:Progress)=>{
   if(progress.position<=1||!Number.isFinite(progress.duration)||progress.duration<=0)return;
   await saveRef.current({mediaItemId:item.id,positionSeconds:progress.position,durationSeconds:progress.duration,
    selectedAudioId:audio?.id,selectedSubtitleId:props.initialSubtitleId});
  };
  const run=async()=>{
   try {
    listener=await player.addListener('progress',progress=>{void save(progress).catch(()=>{});});
    if(disposed){await listener.remove();return;}
    const result=await player.play({url:apiUrl(status.url!),position:item.progress?.is_completed?0:item.progress?.position_seconds||0,
     audioLanguage:audio?.language_code||activeProfile.preferred_audio_lang||'pt-BR',
     subtitleLanguage:props.initialSubtitleId==='off'?'off':subtitle?.language_code||activeProfile.preferred_subtitle_lang||'off'});
    await save(result);
    if(!disposed)closeRef.current();
   }catch{if(!disposed)fallbackRef.current();}
   finally{await listener?.remove();}
  };
  void run();
  return()=>{disposed=true;void listener?.remove();};
 },[status?.url]);

 const prepare=async()=>{
  if(!file||busy)return;
  setBusy(true);setError('');
  try {setStatus(await requestJson<Status>(`/api/preparation/${file.id}`,{method:'POST'}));setRefresh(value=>value+1);}
  catch(err){setError(err instanceof Error?err.message:'Não foi possível preparar o vídeo.');}
  finally{setBusy(false);}
 };
 const working=status&&['queued','processing','uploading'].includes(status.state);
 if(!error && (!status || status.state==='ready')) return <div ref={dialog} role="dialog" aria-modal="true" aria-label={`Reprodução de ${item.title}`} tabIndex={-1}
  className="fixed inset-0 z-[100] bg-black flex items-center justify-center text-zinc-400"><p role="status">Carregando filme…</p></div>;
 return <div ref={dialog} role="dialog" aria-modal="true" aria-label={`Reprodução de ${item.title}`} tabIndex={-1}
  className="fixed inset-0 z-[100] bg-[#101010] text-white flex items-center justify-center p-6 safe-top safe-bottom safe-left safe-right">
  <div className="w-full max-w-md space-y-5">
   <p className="text-[#E50914] text-sm font-bold">MINATTOFLIX · PLAYER NATIVO</p>
   <h1 className="text-2xl font-bold">{item.title}</h1>
   {working?<><p role="status">{status.state==='queued'?'Vídeo na fila de preparação…':status.state==='uploading'?'Salvando a versão compatível…':'Preparando áudio e vídeo…'}</p>
    <progress className="w-full accent-[#E50914]" max={100} value={status.progress||0} aria-label="Preparação do vídeo" />
    <p className="text-sm text-zinc-300">Você pode voltar ao catálogo. A preparação continua e a versão ficará disponível para os próximos acessos.</p></>:
    status?.state==='ready'?<p role="status">{error?'O vídeo está preparado.':'Abrindo o player do iPhone…'}</p>:
    <><p className="text-zinc-200">Este arquivo precisa de uma versão compatível para usar o player do iPhone.</p>
     <p className="text-sm text-zinc-400">A preparação cria uma cópia em HD de até 720p, com áudio AAC e legendas de texto disponíveis. O original é preservado. Essa operação usa processamento e armazenamento.</p>
     {status?.state==='needs_local_preparation'?<p className="text-sm text-zinc-300">O processamento na nuvem está desativado. Prepare uma cópia no computador com a ferramenta do projeto e envie à sua fonte, ou use o player alternativo.</p>:
     <button onClick={()=>void prepare()} disabled={busy||!status} className="w-full rounded bg-[#E50914] p-3 font-semibold disabled:opacity-50">{busy?'Iniciando…':status?.state==='failed'?'Tentar preparação novamente':'Preparar para iPhone (administrador)'}</button>}</>}
   {(error||status?.error)&&<p role="alert" className="text-red-300">{error||status?.error}</p>}
   <button onClick={onFallback} className="w-full rounded border border-zinc-600 p-3">Usar player alternativo</button>
   <button onClick={onClose} className="w-full rounded p-3 text-zinc-300">Voltar ao catálogo</button>
  </div>
 </div>;
}
