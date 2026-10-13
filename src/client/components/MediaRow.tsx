import React, { useEffect, useRef, useState } from 'react';
import { audioLabel, preferredFile, prewarmStream, qualityLabel } from '../services/catalog';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Plus,
  Check,
  ChevronDown,
  Languages,
  Subtitles,
  HardDrive,
  Clock,
} from 'lucide-react';
import type { MediaItem } from '../types';

interface MediaRowProps {
  title: string;
  subtitle?: string;
  items: MediaItem[];
  onPlay: (item: MediaItem) => void;
  onMoreInfo: (item: MediaItem) => void;
  onToggleMyList: (item: MediaItem) => void;
  isTop10?: boolean;
  onExplore?: () => void;
  onRemoveProgress?: (item: MediaItem) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'Tamanho não informado';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export const MediaRow: React.FC<MediaRowProps> = ({
  title,
  subtitle,
  items,
  onPlay,
  onMoreInfo,
  onToggleMyList,
  isTop10 = false,
  onExplore,
  onRemoveProgress,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => setEdges({ left: row.scrollLeft > 2, right: row.scrollLeft + row.clientWidth < row.scrollWidth - 2 });
    update();
    row.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => { row.removeEventListener('scroll', update); observer.disconnect(); };
  }, [items.length]);

  const scroll = (direction: 'left' | 'right') => {
    if (!rowRef.current) return;
    const row = rowRef.current;
    const card = row.firstElementChild as HTMLElement | null;
    if (!card) return;
    const stride = card.offsetWidth + parseFloat(getComputedStyle(row).columnGap || '0');
    const page = Math.max(1, Math.floor((row.clientWidth - parseFloat(getComputedStyle(row).paddingLeft) * 2) / stride));
    const index = Math.round(row.scrollLeft / stride) + (direction === 'left' ? -page : page);
    row.scrollTo({ left: Math.max(0, index * stride), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  if (items.length === 0) return null;

  return (
    <div className="media-row relative group/row py-2 sm:py-3 md:py-4 select-none safe-left safe-right">
      {/* Row Header */}
      <div className="media-row-heading mb-1.5 sm:mb-2.5 flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base sm:text-lg md:text-2xl font-bold text-zinc-100 group-hover/row:text-white transition flex flex-wrap items-baseline gap-x-2.5 gap-y-1 leading-snug">
            <span>{title}</span>
            {onExplore && (
              <button
                type="button"
                onClick={onExplore}
                className="touch-target-inline text-xs font-semibold text-[#46D369] hover:underline shrink-0 py-0.5 cursor-pointer tap-highlight"
              >
                Explorar tudo ›
              </button>
            )}
          </h2>
          {subtitle && <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5 line-clamp-1">{subtitle}</p>}
        </div>
      </div>

      {/* Left Scroll Arrow - Hidden on mobile (use swipe), visible on desktop */}
      <button
        type="button"
        onClick={() => scroll('left')}
        disabled={!edges.left}
        className="hidden sm:flex absolute left-0 top-1/2 z-30 w-9 h-16 rounded-r bg-black/80 hover:bg-black items-center justify-center text-white cursor-pointer disabled:invisible touch-target tap-highlight"
        aria-label={`Títulos anteriores em ${title}`}
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      {/* Horizontal Cards Container */}
      <div
        ref={rowRef}
        role="region" aria-label={title} tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); scroll(event.key === 'ArrowLeft' ? 'left' : 'right'); }
          if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.currentTarget.scrollTo({ left: event.key === 'Home' ? 0 : event.currentTarget.scrollWidth, behavior: 'instant' }); }
        }}
        className="catalog-carousel flex items-stretch gap-2.5 sm:gap-3 md:gap-4 overflow-x-auto no-scrollbar py-3 sm:py-5 scroll-smooth"
      >
        {items.map((item, idx) => {
          const primaryFile = preferredFile(item);
          const progress = item.progress;
          const progressPercent =
            progress && progress.duration_seconds > 0
              ? Math.min(100, Math.round((progress.position_seconds / progress.duration_seconds) * 100))
              : 0;

          return (
            <div
              key={item.id}
              onMouseEnter={() => prewarmStream(item)}
              className="media-card group/card relative flex-shrink-0 w-[152px] min-[390px]:w-[168px] sm:w-[190px] md:w-[220px] lg:w-[240px] xl:w-[260px] rounded-md bg-[#181818] overflow-hidden shadow-lg transition-all duration-300 sm:hover:scale-105 hover:z-20 hover:shadow-[0_14px_38px_rgba(0,0,0,0.9)] border border-zinc-800/80 hover:border-zinc-600 flex flex-col tap-highlight"
            >
              {/* Thumbnail / Poster Area */}
              <button
                type="button"
                aria-label={`Assistir ${item.title}`}
                disabled={!primaryFile}
                onFocus={() => prewarmStream(item)}
                onClick={() => onPlay(item)}
                className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-900 cursor-pointer tap-highlight"
              >
                <img
                  src={item.poster_url}
                  alt={item.title}
                  loading="lazy"
                  className="w-full h-full object-cover object-center group-hover/card:scale-105 transition-transform duration-500"
                />

                {/* Gradient Overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#181818] via-transparent to-black/30 opacity-90" />

                {/* Top Left Netflix M Badge & Top Right Resolution Badge */}
                <div className="absolute top-2 left-2 flex items-center gap-1">
                  <span className="bg-[#E50914] text-white font-netflix-logo text-xs sm:text-sm px-1.5 py-0.5 rounded-xs shadow">
                    M
                  </span>
                  {isTop10 && idx < 10 && (
                    <span className="bg-black/80 border border-[#E50914] text-white text-[9px] sm:text-[10px] font-extrabold px-1.5 py-0.5 rounded-xs">
                      TOP {idx + 1}
                    </span>
                  )}
                </div>

                <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                  {primaryFile ? (
                    <span
                      className={`text-[9px] sm:text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow ${
                        primaryFile.resolution === '2160p'
                          ? 'bg-amber-400 text-black'
                          : 'bg-black/80 text-white border border-white/30'
                      }`}
                    >
                      {qualityLabel(primaryFile)}
                    </span>
                  ) : (
                    <span className="bg-amber-500/90 text-black text-[9px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Indisponível
                    </span>
                  )}
                </div>

                {/* Center Play Hover Button */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity bg-black/45">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/95 text-black flex items-center justify-center shadow-2xl transform scale-90 group-hover/card:scale-100 transition-transform">
                    <Play className="w-6 h-6 sm:w-7 sm:h-7 fill-black ml-0.5" />
                  </div>
                </div>

                {/* Continue Watching Red Progress Bar */}
                {progressPercent > 0 && (
                  <div className="absolute bottom-0 inset-x-0 h-1.5 bg-zinc-700/80">
                    <div
                      className="h-full bg-[#E50914] transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </button>

              {/* Card Details Footer (Netflix Mini-Modal Style) */}
              <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between bg-[#181818]">
                <div>
                  {/* Action Buttons Row */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onPlay(item)}
                        disabled={!primaryFile}
                        className="w-8 h-8 rounded-full bg-white hover:bg-zinc-200 text-black flex items-center justify-center transition cursor-pointer touch-target-sm tap-highlight"
                        title="Assistir agora"
                      >
                        <Play className="w-4 h-4 fill-black ml-0.5" />
                      </button>

                      <button
                        onClick={() => onToggleMyList(item)}
                        className="w-8 h-8 rounded-full border border-zinc-500 hover:border-white bg-zinc-900 text-white flex items-center justify-center transition cursor-pointer touch-target-sm tap-highlight"
                        title={item.inMyList ? 'Remover da Minha Lista' : 'Adicionar à Minha Lista'}
                      >
                        {item.inMyList ? (
                          <Check className="w-4 h-4 text-[#46D369]" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </button>
                    </div>

                    <button
                      onClick={() => onMoreInfo(item)}
                      className="w-8 h-8 rounded-full border border-zinc-500 hover:border-white bg-zinc-900 text-white flex items-center justify-center transition cursor-pointer touch-target-sm tap-highlight"
                      title="Mais informações, faixas de áudio e legendas"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Title */}
                  <button
                    type="button"
                    onClick={() => onMoreInfo(item)}
                    className="media-card-title w-full font-bold text-xs sm:text-sm text-left text-white line-clamp-1 hover:text-[#E50914] transition cursor-pointer py-0.5 tap-highlight"
                  >
                    {item.title}
                  </button>

                  {/* Match & Year & Age */}
                  <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mt-0.5 text-[10px] sm:text-[11px] font-semibold">
                    <span className="text-[#46D369]">Nota {item.rating.toFixed(1)}/10</span>
                    <span className="text-zinc-400">{item.release_year}</span>
                    <span className="px-1 py-0.2 bg-zinc-800 border border-zinc-600 rounded text-[9px] sm:text-[10px] text-zinc-200">
                      {item.age_rating}
                    </span>
                  </div>
                </div>

                {/* Audio, Subtitles & Cloud File Info */}
                <div className="mt-2 pt-2 border-t border-zinc-800/90 flex flex-wrap items-center justify-between gap-1 text-[10px] text-zinc-400">
                  <span className="flex items-center gap-1 text-zinc-300 font-medium truncate max-w-full">
                    <Languages className="w-3 h-3 text-[#E50914] shrink-0" />
                    <span className="truncate">{audioLabel(item)}</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <Subtitles className="w-3 h-3 text-zinc-400 shrink-0" />
                    {item.subtitleTracks.length} Legendas
                  </span>
                  {primaryFile && (
                    <span className="hidden sm:flex text-zinc-500 items-center gap-0.5">
                      <HardDrive className="w-2.5 h-2.5" />
                      {formatBytes(primaryFile.size_bytes)}
                    </span>
                  )}
                </div>
                {onRemoveProgress && (
                  <button
                    type="button"
                    onClick={() => onRemoveProgress(item)}
                    className="mt-2.5 text-[11px] sm:text-xs text-zinc-400 hover:text-white underline text-left py-1 cursor-pointer tap-highlight"
                  >
                    Remover de Continuar assistindo
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right Scroll Arrow - Hidden on mobile (use swipe), visible on desktop */}
      <button
        type="button"
        onClick={() => scroll('right')}
        disabled={!edges.right}
        className="hidden sm:block absolute right-0 top-1/2 z-30 w-9 h-16 rounded-l bg-black/80 hover:bg-black flex items-center justify-center text-white cursor-pointer disabled:invisible touch-target tap-highlight"
        aria-label={`Próximos títulos em ${title}`}
      >
        <ChevronRight className="w-8 h-8" />
      </button>
    </div>
  );
};
