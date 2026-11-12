import React, { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';

export function Artwork({
  src,
  alt,
  className,
  referrerPolicy = 'no-referrer',
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) {
      setState('failed');
      return;
    }

    // Immediately resolve if already cached in browser memory
    if (imgRef.current && imgRef.current.complete) {
      if (imgRef.current.naturalWidth > 0) {
        setState('ready');
        return;
      }
    }

    setState('loading');

    // Watchdog fallback: never leave shimmer skeleton spinning forever on dropped connections
    const timer = window.setTimeout(() => {
      setState((prev) => (prev === 'loading' ? 'failed' : prev));
    }, 6000);

    return () => window.clearTimeout(timer);
  }, [src]);

  if (state === 'failed' || !src) {
    return (
      <div
        role="img"
        aria-label={alt || 'Imagem indisponível'}
        className={`${className || ''} flex flex-col items-center justify-center bg-zinc-900 border border-zinc-800 text-zinc-500 p-3 text-center select-none`}
      >
        <Film className="w-6 h-6 mb-1 text-zinc-600 shrink-0" />
        <span className="text-[11px] leading-tight line-clamp-2 max-w-[120px] font-medium text-zinc-400">
          {alt || 'MinattoFlix'}
        </span>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden ${className || ''}`}>
      {state === 'loading' && (
        <div aria-hidden="true" className="absolute inset-0 shimmer-skeleton z-0" />
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        referrerPolicy={referrerPolicy}
        className={`w-full h-full object-cover transition-opacity duration-300 ${
          state === 'ready' ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={() => setState('ready')}
        onError={() => setState('failed')}
        {...rest}
      />
    </div>
  );
}
