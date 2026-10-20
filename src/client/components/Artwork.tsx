import React,{useEffect,useState} from 'react';
export function Artwork(props:React.ImgHTMLAttributes<HTMLImageElement>) {
 const [state,setState]=useState<'loading'|'ready'|'failed'>('loading');
 useEffect(()=>setState('loading'),[props.src]);
 if(state==='failed'||!props.src)return <div role="img" aria-label={props.alt||'Imagem indisponível'} className={`${props.className||''} flex items-center justify-center bg-zinc-800 text-zinc-400 p-4`}><span className="text-center text-sm">{props.alt||'Imagem indisponível'}</span></div>;
 return <img {...props} className={`${props.className||''} ${state==='loading'?'shimmer-skeleton':''}`} onLoad={()=>setState('ready')} onError={()=>setState('failed')}/>;
}
