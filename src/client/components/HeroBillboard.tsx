import React, { useState } from 'react';
import { Play, Info, Volume2, VolumeX, Check, Plus, Languages, Subtitles } from 'lucide-react';
import type { MediaItem } from '../types';
import { audioLabel, preferredFile, prewarmStream } from '../services/catalog';

interface HeroBillboardProps {
  featuredItems: MediaItem[];
  onPlay: (item: MediaItem) => void;
  onMoreInfo: (item: MediaItem) => void;
  onToggleMyList: (item: MediaItem) => void;
}

export const HeroBillboard: React.FC<HeroBillboardProps> = ({
  featuredItems,
  onPlay,
  onMoreInfo,
  onToggleMyList,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [showTrailer, setShowTrailer] = useState(false);
  const [muted, setMuted] = useState(true);

  if (featuredItems.length === 0) return null;
  const item = featuredItems[activeIndex % featuredItems.length];
  const primaryFile = preferredFile(item);

  return (
    <section className="hero-billboard relative w-full h-[74svh] sm:h-[78svh] md:h-[86svh] min-h-[480px] sm:min-h-[560px] md:min-h-[580px] max-h-[820px] overflow-hidden select-none bg-black safe-top hero-mobile-landscape">
      {/* Backdrop Image or Live YouTube Trailer Preview */}
      {showTrailer && item.trailer_youtube_key ? (
        <div className="absolute inset-0 w-full h-full pointer-events-none scale-110">
          <iframe
            title={`Trailer ${item.title}`}
            src={`https://www.youtube.com/embed/${item.trailer_youtube_key}?autoplay=1&mute=${
              muted ? 1 : 0
            }&controls=0&loop=1&playlist=${item.trailer_youtube_key}&modestbranding=1&rel=0`}
            className="w-full h-full object-cover"
            allow="autoplay; encrypted-media"
          />
        </div>
      ) : (
        <div className="absolute inset-0">
          <img
            src={item.backdrop_url || item.poster_url}
            alt={item.title}
            className="w-full h-full object-cover object-center scale-105 transition-transform duration-1000"
          />
        </div>
      )}

      {/* Netflix Cinematic Vignette Gradients */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/70 sm:via-[#141414]/65 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/35 sm:via-transparent to-black/60 sm:to-black/40" />

      {/* Hero Content */}
      <div className="hero-content relative z-10 max-w-[1800px] mx-auto h-full px-4 md:px-12 pt-28 sm:pt-32 flex flex-col justify-end pb-12 sm:pb-24 md:pb-32 safe-left safe-right">
        <div className="max-w-2xl space-y-2.5 sm:space-y-4">
          {/* Netflix N Series / Cloud Original Badge */}
          <div className="flex items-center gap-2">
            <span className="bg-[#E50914] text-white font-netflix-logo text-base sm:text-xl px-1.5 sm:px-2 py-0.5 rounded-xs leading-none shadow">
              M
            </span>
            <span className="text-[10px] sm:text-sm font-bold tracking-[0.18em] sm:tracking-[0.25em] text-zinc-300 uppercase truncate">
              FILME EM DESTAQUE • ALTA DEFINIÇÃO
            </span>
          </div>

          {/* Movie Title */}
          <h1 className="font-netflix-logo text-3xl min-[380px]:text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl text-white leading-[0.94] tracking-wide drop-shadow-[0_6px_24px_rgba(0,0,0,0.9)] line-clamp-2">
            {item.title}
          </h1>

          {/* Technical & Quality Badges */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-[11px] sm:text-sm font-semibold">
            <span className="text-[#46D369] font-bold">Nota {item.rating.toFixed(1)}/10</span>
            <span className="text-zinc-300">{item.release_year}</span>

            <span
              className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-extrabold ${
                item.age_rating === 'L'
                  ? 'bg-emerald-600 text-white'
                  : item.age_rating === '16' || item.age_rating === '18'
                    ? 'bg-red-600 text-white'
                    : 'bg-amber-500 text-black'
              }`}
            >
              {item.age_rating}
            </span>

            <span className="text-zinc-300">{item.runtime_minutes} min</span>

            {primaryFile && (
              <>
                <span className="border border-zinc-400/80 text-zinc-100 px-1.5 py-0.5 rounded-xs text-[10px] sm:text-[11px] uppercase tracking-wider">
                  {primaryFile.resolution === '2160p' ? '4K ULTRA HD' : primaryFile.resolution}
                </span>
                {primaryFile.dynamic_range && primaryFile.dynamic_range !== 'SDR' && (
                  <span className="bg-amber-400/20 border border-amber-400 text-amber-300 px-1.5 py-0.5 rounded-xs text-[10px] sm:text-[11px] font-bold">
                    {primaryFile.dynamic_range}
                  </span>
                )}
                <span className="hidden sm:inline-block border border-zinc-500 text-zinc-200 px-1.5 py-0.5 rounded-xs text-[10px] sm:text-[11px]">
                  {primaryFile.audio_channels || 'Canais a verificar'}
                </span>
                {primaryFile.is_dual_audio && (
                  <span className="bg-[#E50914]/25 border border-[#E50914] text-white px-2 py-0.5 rounded-xs text-[10px] sm:text-[11px] flex items-center gap-1">
                    <Languages className="w-3 h-3 text-[#E50914] shrink-0" /> {audioLabel(item)}
                  </span>
                )}
              </>
            )}

            <span className="bg-zinc-800/90 border border-zinc-700 text-zinc-300 px-2 py-0.5 rounded-xs text-[10px] sm:text-[11px] flex items-center gap-1">
              <Subtitles className="w-3 h-3 text-zinc-400 shrink-0" /> {item.subtitleTracks.length} legendas
            </span>
          </div>

          {/* Tagline / Synopsis */}
          <p className="text-xs sm:text-base text-zinc-200 line-clamp-2 sm:line-clamp-3 leading-relaxed drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)] max-w-xl">
            {item.overview}
          </p>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 sm:gap-3 pt-1 sm:pt-2">
            <button
              disabled={!primaryFile}
              onClick={() => onPlay(item)}
              className="w-11 sm:w-auto sm:flex-initial flex items-center justify-center gap-2 bg-white hover:bg-white/85 text-black font-bold text-sm sm:text-lg px-0 sm:px-6 md:px-8 py-2.5 md:py-3 rounded transition shadow-lg cursor-pointer touch-target tap-highlight"
              aria-label={item.progress && !item.progress.is_completed && item.progress.position_seconds > 15 ? `Continuar ${item.title}` : `Assistir ${item.title}`}
            >
              <Play className="w-4 sm:w-6 h-4 sm:h-6 fill-black shrink-0" />
              <span className="hidden sm:inline">{item.progress && !item.progress.is_completed && item.progress.position_seconds > 15 ? 'Continuar' : 'Assistir'}</span>
            </button>

            <button
              onClick={() => onMoreInfo(item)}
              className="w-11 sm:w-auto sm:flex-initial flex items-center justify-center gap-2 bg-zinc-500/70 hover:bg-zinc-500/50 backdrop-blur-md text-white font-semibold text-sm sm:text-lg px-0 sm:px-6 md:px-7 py-2.5 md:py-3 rounded transition cursor-pointer touch-target tap-highlight"
              aria-label={`Mais informações sobre ${item.title}`}
            >
              <Info className="w-4 sm:w-6 h-4 sm:h-6 shrink-0" />
              <span className="hidden sm:inline truncate">Mais informações</span>
            </button>

            <button
              onClick={() => onToggleMyList(item)}
              title={item.inMyList ? 'Remover da Minha Lista' : 'Adicionar à Minha Lista'}
              className="w-11 h-11 md:w-12 md:h-12 shrink-0 rounded-full border-2 border-zinc-400 hover:border-white bg-black/50 flex items-center justify-center text-white transition cursor-pointer touch-target tap-highlight"
              aria-label={item.inMyList ? `Remover ${item.title} da Minha Lista` : `Adicionar ${item.title} à Minha Lista`}
            >
              {item.inMyList ? <Check className="w-5 h-5 text-[#46D369]" /> : <Plus className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Right Bottom Controls: Trailer Toggle, Mute & Age Badge */}
      <div className="hidden sm:flex absolute right-0 bottom-20 md:bottom-24 z-10 items-center gap-2 sm:gap-3 safe-right">
        {item.trailer_youtube_key && (
          <button
            onClick={() => setShowTrailer((prev) => !prev)}
            className="text-xs font-semibold bg-black/60 hover:bg-black/80 border border-white/30 text-white px-3 py-2 rounded-full backdrop-blur-sm transition cursor-pointer touch-target-sm tap-highlight"
          >
            {showTrailer ? 'Ver Capa' : 'Preview Trailer'}
          </button>
        )}

        {showTrailer && (
          <button
            onClick={() => setMuted((m) => !m)}
            className="w-10 h-10 rounded-full border border-white/60 bg-black/50 hover:bg-black/80 flex items-center justify-center text-white transition cursor-pointer touch-target-sm tap-highlight"
          >
            {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
          </button>
        )}

        <div className="bg-zinc-900/80 border-l-4 border-[#E50914] pl-3 pr-6 py-1.5 text-sm font-bold text-white backdrop-blur-sm">
          {item.age_rating === 'L' ? 'LIVRE' : `${item.age_rating}+`}
        </div>
      </div>

      {/* Featured Carousel Switcher Indicators */}
      {featuredItems.length > 1 && (
        <div className="absolute bottom-3 sm:bottom-10 md:bottom-14 right-4 md:right-12 z-10 flex items-center gap-1">
          {featuredItems.map((f, idx) => {
            const isCurrent = idx === activeIndex % featuredItems.length;
            return (
              <button
                key={f.id}
                onClick={() => {
                  setActiveIndex(idx);
                  setShowTrailer(false);
                }}
                className="touch-target py-2 px-1 cursor-pointer tap-highlight flex items-center"
                title={f.title}
                aria-label={`Ir para ${f.title}`}
              >
                <span
                  className={`block h-1 rounded-full transition-all ${
                    isCurrent ? 'w-6 sm:w-7 bg-[#E50914]' : 'w-2.5 sm:w-3 bg-zinc-600 hover:bg-zinc-400'
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};

