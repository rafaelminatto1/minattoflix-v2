import React, { useCallback, useEffect, useMemo, useState, useRef, useLayoutEffect, Suspense, lazy } from 'react';
import type { BootstrapResponse, MediaItem, Profile, StorageSource, WatchProgress, EpisodeItem } from './types';
import { ProfileGate } from './components/ProfileGate';
import { Navbar, type NavSection } from './components/Navbar';
import { HeroBillboard } from './components/HeroBillboard';
import { MediaRow } from './components/MediaRow';
import { NetflixPlayer } from './components/NetflixPlayer';
import {Capacitor} from '@capacitor/core';
const NativePlayback=lazy(()=>import('./components/NativePlayback').then(module=>({default:module.NativePlayback})));
const DetailModal = lazy(() => import('./components/DetailModal').then(module => ({ default: module.DetailModal })));
const CloudManagerModal = lazy(() => import('./components/CloudManagerModal').then(module => ({ default: module.CloudManagerModal })));
import { addedTime, matchesSearch, preferredFile, prewarmStream, qualityLabel, requestJson } from './services/catalog';
import { isIosWebKit } from './services/mkvAudioController';
import { Cloud, Play, Info, Languages, Subtitles, RefreshCw, SlidersHorizontal } from 'lucide-react';

export const App: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequestRef = useRef(0);
  const bootstrapRequestRef = useRef(0);
  const listPendingRef = useRef(new Set<string>());
  const [filters, setFilters] = useState({ genre: '', year: '', language: '', quality: '', sort: 'recent' });
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [visibleCount, setVisibleCount] = useState(48);
  const scrollPositions = useRef<Record<string, number>>({});
  const viewKeyRef = useRef('home');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [showProfileGate, setShowProfileGate] = useState<boolean>(false);

  const [storageSources, setStorageSources] = useState<StorageSource[]>([]);
  const [catalog, setCatalog] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const [activeSection, setActiveSection] = useState<NavSection>('home');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals & Player state
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<{
    item: MediaItem;
    audioId?: string;
    subtitleId?: string;
    fileId?: string;
    webFallback?: boolean;
  } | null>(null);
  const [showCloudStudio, setShowCloudStudio] = useState<boolean>(false);

  // Mobile-specific state
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile on mount
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const loadBootstrap = useCallback(async (profileId?: string) => {
    const requestId = ++bootstrapRequestRef.current;
    try {
      let savedId = '';
      try { savedId = localStorage.getItem('minattoflix_profile_id') || ''; } catch { /* Storage may be unavailable. */ }
      const targetProfileId = profileId || savedId;
      const data = await requestJson<BootstrapResponse>(`/api/bootstrap?summary=true&profileId=${encodeURIComponent(targetProfileId)}`);
      if (requestId !== bootstrapRequestRef.current) return;
      setProfiles(data.profiles || []);
      setStorageSources(data.storageSources || []);
      setCatalog(data.catalog || []);
      setActiveProfile(data.profiles.find(profile => profile.id === targetProfileId) || data.profiles[0] || null);
      setError(null);
      // Preload NetflixPlayer bundle and prewarm the primary featured OneDrive stream in background
      void import('./components/NetflixPlayer');
      const featured = (data.catalog || []).find(m => m.is_featured) || data.catalog?.[0];
      if (featured) prewarmStream(featured);
    } catch (error) {
      if (requestId === bootstrapRequestRef.current) setError(error instanceof Error ? error.message : 'Falha ao carregar o catálogo.');
    } finally {
      if (requestId === bootstrapRequestRef.current) setLoading(false);
    }
  }, []);

  const loadDetails = async (item: MediaItem) => {
    if (item.detailsLoaded) return item;
    const data = await requestJson<BootstrapResponse>(`/api/media/${item.id}/details?profileId=${encodeURIComponent(activeProfile?.id || '')}`);
    const detail = data.catalog[0];
    if (!detail) throw new Error('Título não encontrado. Sincronize o catálogo e tente novamente.');
    return detail;
  };
  const openDetails = async (item: MediaItem) => {
    prewarmStream(item);
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    try {
      const detail = await loadDetails(item);
      if (requestId !== detailRequestRef.current) return;
      setCatalog(previous => previous.map(media => media.id === detail.id ? detail : media));
      setDetailItemId(detail.id);
    } catch (error) { setError(error instanceof Error ? error.message : 'Falha ao carregar detalhes.'); }
    finally { if (requestId === detailRequestRef.current) setDetailLoading(false); }
  };
  const openPlayer = async (item: MediaItem, audioId?: string, subtitleId?: string, episode?: EpisodeItem, fileId?: string) => {
    prewarmStream(episode || item);
    // Automatically enter fullscreen on both desktop and mobile devices within the synchronous user gesture
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const rootEl = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    // WKWebView identifies its bundled page as localhost. Use the player's
    // immersive layout on iOS instead of requesting browser fullscreen here.
    if (!isIosWebKit() && !doc.fullscreenElement && !doc.webkitFullscreenElement) {
      if (rootEl.requestFullscreen) {
        rootEl.requestFullscreen().catch(() => {});
      } else if (rootEl.webkitRequestFullscreen) {
        try {
          rootEl.webkitRequestFullscreen();
        } catch {
          // Ignore
        }
      }
    }
    const isMobileDevice =
      window.innerWidth < 768 ||
      window.matchMedia?.('(pointer: coarse)').matches ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobileDevice) {
      const orientation = (screen as Screen & { orientation?: { lock?: (mode: string) => Promise<void> } }).orientation;
      orientation?.lock?.('landscape')?.catch(() => {});
    }
    // Fast-path: if playing a movie (not a specific episode) and files are already hydrated from bootstrap, open in 0ms!
    if (!episode && item.type !== 'series' && item.files.length > 0) {
      setDetailItemId(null);
      setPlayerState({ item, audioId, subtitleId, fileId });
      return;
    }
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    try {
      const detail = await loadDetails(item);
      if (requestId !== detailRequestRef.current) return;
      const playable = episode ? { ...detail, title: `${detail.title} — ${episode.title}`, files: episode.files,
        audioTracks: episode.files.flatMap(file => file.audioTracks), subtitleTracks: episode.files.flatMap(file => file.subtitleTracks), progress: null } : detail;
      if (!playable.files.length) throw new Error('Este título ainda não tem um arquivo de vídeo disponível. Sincronize o catálogo.');
      setDetailItemId(null);
      setPlayerState({ item: playable, audioId, subtitleId, fileId });
    } catch (error) { 
      const msg = error instanceof Error ? error.message : 'Falha ao abrir vídeo.';
      setError(msg);
      // Also show as toast-like notification that doesn't trigger ErrorBoundary
      console.error('[openPlayer]', msg);
    }
    finally { if (requestId === detailRequestRef.current) setDetailLoading(false); }
  };

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  const handleSelectProfile = (profile: Profile) => {
    try { localStorage.setItem('minattoflix_profile_id', profile.id); } catch {}
    detailRequestRef.current++;
    setDetailLoading(false);
    setDetailItemId(null);
    setPlayerState(null);
    setActiveProfile(profile);
    setShowProfileGate(false);
    loadBootstrap(profile.id);
  };

  const handleCreateProfile = async (input: {
    name: string;
    isKids: boolean;
    preferredAudioLang: string;
    preferredSubtitleLang: string;
  }) => {
    try {
    const created = await requestJson<Profile>('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    {
      try { localStorage.setItem('minattoflix_profile_id', created.id); } catch {}
      await loadBootstrap(created.id);
      setShowProfileGate(false);
    }
    } catch (error) { setError(error instanceof Error ? error.message : 'Falha ao criar perfil.'); throw error; }
  };

  const handleToggleMyList = async (item: MediaItem) => {
    if (!activeProfile || listPendingRef.current.has(item.id)) return;
    listPendingRef.current.add(item.id);
    const profileId = activeProfile.id;
    const generation = bootstrapRequestRef.current;
    setCatalog(previous => previous.map(media => media.id === item.id ? { ...media, inMyList: !media.inMyList } : media));
    try {
      await requestJson('/api/my-list/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, mediaItemId: item.id }) });
    } catch (error) {
      if (generation === bootstrapRequestRef.current) setCatalog(previous => previous.map(media => media.id === item.id ? { ...media, inMyList: item.inMyList } : media));
      setError(error instanceof Error ? error.message : 'Falha ao atualizar Minha Lista.');
    } finally { listPendingRef.current.delete(item.id); }
  };
  const handleRemoveProgress = async (item: MediaItem) => {
    if (!activeProfile) return;
    const generation = bootstrapRequestRef.current;
    try {
      await requestJson(`/api/progress/${item.id}?profileId=${encodeURIComponent(activeProfile.id)}`, { method: 'DELETE' });
      if (generation === bootstrapRequestRef.current) setCatalog(previous => previous.map(media => media.id === item.id ? { ...media, progress: null } : media));
    } catch (error) { setError(error instanceof Error ? error.message : 'Falha ao remover progresso.'); }
  };

  const handleSaveProgress = async (data: {
    mediaItemId: string;
    positionSeconds: number;
    durationSeconds: number;
    selectedAudioId?: string;
    selectedSubtitleId?: string;
  }) => {
    if (!activeProfile) return;
    const generation = bootstrapRequestRef.current;
    try {
    const progress = await requestJson<WatchProgress>('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: activeProfile.id,
        ...data,
      }),
    });
    if (generation === bootstrapRequestRef.current) setCatalog(previous => previous.map(media => media.id === data.mediaItemId ? { ...media, progress } : media));
    } catch (error) { setError(error instanceof Error ? error.message : 'Falha ao salvar progresso.'); }
  };

  const handleSyncCloudNow = async () => {
    setIsSyncing(true);
    try {
      const data = await requestJson<{ discoveredFolders?: number; syncedVideos?: number; logs?: string[] }>('/api/scanner/sync', { method: 'POST', signal: AbortSignal.timeout(180000) });
      await loadBootstrap(activeProfile?.id);
      return data;
    } catch (error) { setError(error instanceof Error ? error.message : 'Falha ao sincronizar.'); throw error; } finally {
      setIsSyncing(false);
    }
  };

  const handleAddStorageSource = async (data: {
    name: string;
    provider: 'gdrive' | 'onedrive';
    shareUrl: string;
  }) => {
    await requestJson('/api/storage-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await handleSyncCloudNow();
  };

  // Filter catalog by Kids profile if applicable
  const profileFilteredCatalog = useMemo(() => {
    if (!activeProfile?.is_kids) return catalog;
    return catalog.filter((item) => item.age_rating === 'L' || item.age_rating === '10');
  }, [catalog, activeProfile]);

  const featuredItems = useMemo(() => {
    const feat = profileFilteredCatalog.filter((m) => m.is_featured);
    return feat.length > 0 ? feat : profileFilteredCatalog.slice(0, 3);
  }, [profileFilteredCatalog]);

  const continueWatchingItems = useMemo(
    () =>
      profileFilteredCatalog.filter(
        (m) => m.progress && m.progress.position_seconds > 5 && !m.progress.is_completed
      ).sort((a, b) => (Date.parse(b.progress?.updated_at || '') || 0) - (Date.parse(a.progress?.updated_at || '') || 0)),
    [profileFilteredCatalog]
  );

  const myListItems = useMemo(
    () => profileFilteredCatalog.filter((m) => m.inMyList),
    [profileFilteredCatalog]
  );

  const uhd4kItems = useMemo(
    () =>
      profileFilteredCatalog.filter((m) =>
        m.files.some((f) => f.resolution === '2160p')
      ),
    [profileFilteredCatalog]
  );

  const dcHeroItems = useMemo(
    () =>
      profileFilteredCatalog.filter(
        (m) =>
          m.genres.some((g) => g.slug === 'dc-herois' || g.slug === 'acao-aventura') ||
          /batman|constantine|mario/i.test(m.title)
      ),
    [profileFilteredCatalog]
  );

  const familyAnimationItems = useMemo(
    () =>
      profileFilteredCatalog.filter((m) =>
        m.genres.some((g) => g.slug === 'animacao' || g.slug === 'familia-kids')
      ),
    [profileFilteredCatalog]
  );

  // Search or Section Filtered Grid
  const sectionGridItems = useMemo(() => {
    if (searchQuery.trim()) {
      return profileFilteredCatalog.filter(item => matchesSearch(item, searchQuery));
    }

    if (activeSection === '4k') return uhd4kItems;
    if (activeSection === 'dc') return dcHeroItems;
    if (activeSection === 'kids') return familyAnimationItems;
    if (activeSection === 'mylist') return myListItems;
    if (activeSection === 'movies') return profileFilteredCatalog;
    return [];
  }, [
    searchQuery,
    activeSection,
    profileFilteredCatalog,
    uhd4kItems,
    dcHeroItems,
    familyAnimationItems,
    myListItems,
  ]);

  const filteredGridItems = useMemo(() => {
    const items = sectionGridItems.filter(item =>
      (!filters.genre || item.genres.some(genre => genre.slug === filters.genre)) &&
      (!filters.year || String(item.release_year) === filters.year) &&
      (!filters.language || item.audioTracks.some(track => track.language_code === filters.language)) &&
      (!filters.quality || item.files.some(file => file.resolution === filters.quality)));
    return items.sort((a, b) => filters.sort === 'title' ? a.title.localeCompare(b.title, 'pt-BR') : filters.sort === 'rating' ? b.rating - a.rating : filters.sort === 'year' ? b.release_year - a.release_year : addedTime(b) - addedTime(a));
  }, [sectionGridItems, filters]);
  const recentItems = useMemo(() => [...profileFilteredCatalog].sort((a, b) => addedTime(b) - addedTime(a)).slice(0, 30), [profileFilteredCatalog]);
  const topRatedItems = useMemo(() => [...profileFilteredCatalog].filter(item => item.rating > 0).sort((a, b) => b.rating - a.rating).slice(0, 10), [profileFilteredCatalog]);
  const viewKey = searchQuery.trim() ? 'search' : activeSection;
  useLayoutEffect(() => {
    const previousKey = viewKeyRef.current;
    if (previousKey === viewKey) return;
    viewKeyRef.current = viewKey;
    window.scrollTo({ top: scrollPositions.current[viewKey] || 0, behavior: 'instant' });
  }, [viewKey]);
  useEffect(() => {
    const savePosition = () => { scrollPositions.current[viewKeyRef.current] = window.scrollY; };
    window.addEventListener('scroll', savePosition, { passive: true });
    return () => window.removeEventListener('scroll', savePosition);
  }, []);
  useEffect(() => { setVisibleCount(48); }, [filters, searchQuery, activeSection]);
  const selectSection = (section: NavSection) => { scrollPositions.current[viewKeyRef.current] = window.scrollY; setFilters({ genre: '', year: '', language: '', quality: '', sort: 'recent' }); setActiveSection(section); };
  const explore = (section: NavSection) => { setSearchQuery(''); selectSection(section); };
  const errorBanner = error && (
    <div
      role="alert"
      className="fixed bottom-20 sm:bottom-4 left-4 right-4 z-[70] mx-auto max-w-xl bg-red-950 border border-red-500 rounded-lg p-3.5 sm:p-4 flex items-center justify-between gap-4 shadow-xl text-sm"
    >
      <span>{error}</span>
      <button
        type="button"
        aria-label="Fechar aviso"
        className="w-8 h-8 flex items-center justify-center rounded hover:bg-red-900 shrink-0 cursor-pointer"
        onClick={() => setError(null)}
      >
        ×
      </button>
    </div>
  );

  const detailItem = useMemo(
    () => catalog.find((m) => m.id === detailItemId) || null,
    [catalog, detailItemId]
  );

  if (loading) {
    return (
      <div className="min-h-screen dvh-100 bg-[#141414] flex flex-col items-center justify-center gap-4">
        <span className="font-netflix-logo text-5xl text-[#E50914] tracking-wider animate-pulse">
          MINATTOFLIX
        </span>
        <div className="w-10 h-10 border-4 border-[#E50914] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!activeProfile && error) return <div className="min-h-screen dvh-100 flex flex-col items-center justify-center gap-4 px-6 text-center"><h1 className="text-2xl">Não foi possível carregar o sistema</h1><p role="alert">{error}</p><button className="bg-red-600 px-5 py-3 rounded" onClick={() => { setLoading(true); void loadBootstrap(); }}>Tentar novamente</button></div>;
  if (showProfileGate || !activeProfile) {
    return (
      <><ProfileGate
        profiles={profiles}
        onSelectProfile={handleSelectProfile}
        onCreateProfile={handleCreateProfile}
      />{errorBanner}</>
    );
  }

  return (
    <div className="min-h-screen dvh-100 bg-[#141414] text-white flex flex-col justify-between">
      {/* Top Fixed Netflix Navbar */}
      <Navbar
        activeSection={activeSection}
        onSelectSection={selectSection}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeProfile={activeProfile}
        onSwitchProfile={() => { detailRequestRef.current++; setDetailLoading(false); setShowProfileGate(true); }}
        onOpenCloudStudio={() => setShowCloudStudio(true)}
        onQuickSync={async () => {
          await handleSyncCloudNow().catch(() => {});
        }}
        isSyncing={isSyncing}
        totalMovies={profileFilteredCatalog.length}
      />

      {/* Main Content Area */}
      {searchQuery.trim() || activeSection !== 'home' ? (
        <main className={`catalog-main max-w-[1800px] w-full mx-auto px-3.5 sm:px-4 md:px-12 ${searchQuery.trim() ? 'pt-36 sm:pt-32' : 'pt-28 sm:pt-32'} xl:pt-28 pb-16 sm:pb-20 flex-1 safe-left safe-right`}>
          <div className="mb-5 sm:mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl md:text-4xl font-bold text-white leading-tight">
                {searchQuery.trim()
                  ? `Resultados para "${searchQuery}"`
                  : activeSection === '4k'
                    ? 'Filmes em 4K Ultra HD'
                    : activeSection === 'dc'
                      ? 'Heróis, Ação & Universo DC'
                      : activeSection === 'kids'
                        ? 'Animação & Família'
                        : activeSection === 'mylist'
                          ? `Minha Lista (${activeProfile.name})`
                          : 'Todos os Filmes na Nuvem'}
              </h1>
              <p className="text-xs text-zinc-400 mt-1">
                Escolha um título e confira as opções de áudio e legenda disponíveis.
              </p>
            </div>
          </div>

          <div className="sm:hidden flex items-center justify-between gap-3 mb-4">
            <button type="button" aria-label={showMobileFilters ? 'Fechar filtros e ordenação' : 'Abrir filtros e ordenação'} aria-expanded={showMobileFilters} aria-controls="catalog-filters"
              onClick={() => setShowMobileFilters(value => !value)}
              className="touch-target flex items-center justify-center px-3 rounded-lg border border-zinc-700 bg-zinc-900 text-sm font-semibold">
              <SlidersHorizontal className="w-5 h-5" aria-hidden="true" />
              {(filters.genre || filters.year || filters.language || filters.quality || filters.sort !== 'recent') && <span className="ml-1 text-[#46D369]" aria-label="Filtros ativos">•</span>}
            </button>
            <span className="text-xs text-zinc-400 shrink-0" role="status">{filteredGridItems.length} títulos</span>
          </div>
          <div id="catalog-filters" className={`catalog-filters ${showMobileFilters ? 'grid' : 'hidden'} grid-cols-2 sm:flex sm:flex-wrap items-end gap-2.5 sm:gap-3 mb-6`}>
            {([
              ['genre', 'Gênero', [...new Map(profileFilteredCatalog.flatMap(item => item.genres).map(genre => [genre.slug, genre.name])).entries()]],
              ['year', 'Ano', [...new Set(profileFilteredCatalog.map(item => item.release_year))].sort((a,b) => b-a).map(year => [String(year), String(year)])],
              ['language', 'Áudio', [...new Set(profileFilteredCatalog.flatMap(item => item.audioTracks.map(track => track.language_code)))].filter(Boolean).sort().map(language => [language, language.toUpperCase()])],
              ['quality', 'Qualidade', [...new Set(profileFilteredCatalog.flatMap(item => item.files.map(file => file.resolution)))].filter(Boolean).sort().map(quality => [quality, quality === '2160p' ? '4K' : quality])],
              ['sort', 'Ordenar', [['recent', 'Mais recentes'], ['title', 'Título A–Z'], ['rating', 'Maior nota'], ['year', 'Ano de lançamento']]],
            ] as Array<[keyof typeof filters, string, string[][]]>).map(([key, label, options]) => (
              <label key={key} className={`text-xs text-zinc-300 flex flex-col gap-1 ${key === 'sort' ? 'col-span-2 sm:col-span-1' : ''}`}>
                {label}
                <select
                  value={filters[key]}
                  onChange={event => setFilters(previous => ({ ...previous, [key]: event.target.value }))}
                  className="w-full sm:w-auto bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-white touch-target-sm tap-highlight"
                >
                  {key !== 'sort' && <option value="">Todos</option>}
                  {options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
                </select>
              </label>
            ))}
            <div className="col-span-2 sm:col-span-1 flex items-center justify-between sm:justify-start gap-3 pt-1 sm:pt-0">
              <button
                className="text-xs text-zinc-200 hover:text-white underline py-2 cursor-pointer tap-highlight"
                onClick={() => setFilters({ genre: '', year: '', language: '', quality: '', sort: 'recent' })}
              >
                Limpar filtros
              </button>
              <span className="hidden sm:inline text-xs text-zinc-400 py-2" role="status">{filteredGridItems.length} títulos</span>
            </div>
          </div>

          {filteredGridItems.length === 0 ? (
            <div className="bg-[#181818] border border-zinc-800 rounded-xl p-8 sm:p-12 text-center max-w-lg mx-auto my-8 sm:my-12">
              <p className="text-zinc-300 font-semibold text-base sm:text-lg mb-2">
                Nenhum título encontrado nesta seção
              </p>
              <p className="text-xs text-zinc-500 mb-6">
                Tente outra busca, limpe os filtros ou sincronize seu catálogo.
              </p>
              <button
                onClick={() => {
                  setActiveSection('home');
                  setSearchQuery('');
                }}
                className="bg-[#E50914] text-white text-sm font-bold px-6 py-2.5 rounded cursor-pointer touch-target tap-highlight"
              >
                Voltar ao Início
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3 md:gap-4">
              {filteredGridItems.slice(0, visibleCount).map((item) => {
                const f = preferredFile(item);
                return (
                  <div
                    key={item.id}
                    onMouseEnter={() => prewarmStream(item)}
                    className="catalog-grid-card group bg-[#181818] border border-zinc-800 hover:border-zinc-600 rounded-md overflow-hidden flex flex-col transition-transform duration-300 sm:hover:scale-105 shadow-xl tap-highlight card-hover-glow"
                  >
                    <button
                      type="button"
                      aria-label={`Assistir ${item.title}`}
                      disabled={!f}
                      onFocus={() => prewarmStream(item)}
                      onClick={() => void openPlayer(item)}
                      className="relative aspect-[2/3] bg-zinc-900 cursor-pointer overflow-hidden tap-highlight"
                    >
                      <img
                        src={item.poster_url}
                        alt={item.title}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <div className="w-12 h-12 rounded-full bg-white text-black flex items-center justify-center">
                          <Play className="w-6 h-6 fill-black ml-0.5" />
                        </div>
                      </div>
                      {f && (
                        <span className="absolute top-2 right-2 bg-black/80 border border-white/30 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                          {qualityLabel(f)}
                        </span>
                      )}
                      {item.progress && item.progress.duration_seconds > 0 && (
                        <div className="absolute bottom-0 inset-x-0 h-1.5 bg-zinc-700/80">
                          <div
                            className="h-full bg-[#E50914] transition-all"
                            style={{ width: `${Math.min(100, Math.round((item.progress.position_seconds / item.progress.duration_seconds) * 100))}%` }}
                          />
                        </div>
                      )}
                    </button>
                    <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between">
                      <div>
                        <button
                          type="button"
                          onClick={() => void openDetails(item)}
                          className="media-card-title w-full text-left font-bold text-xs sm:text-sm text-white line-clamp-1 hover:text-[#E50914] cursor-pointer py-0.5 tap-highlight"
                        >
                          {item.title}
                        </button>
                        <div className="text-[10px] sm:text-[11px] text-zinc-400 mt-0.5 flex flex-wrap items-center gap-1.5 sm:gap-2">
                          <span className="text-[#46D369] font-semibold">
                            Nota {item.rating.toFixed(1)}/10
                          </span>
                          <span>{item.release_year}</span>
                          <span>{item.runtime_minutes}m</span>
                        </div>
                      </div>
                      <button
                        onClick={() => void openDetails(item)}
                        aria-label={`Áudio, legendas e detalhes de ${item.title}`}
                        className="mt-2.5 sm:mt-3 w-full bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 py-2 rounded flex items-center justify-center gap-1.5 cursor-pointer touch-target-sm tap-highlight"
                      >
                        <Info className="w-3.5 h-3.5 shrink-0" />
                        <span className="hidden sm:inline truncate">Áudio & Legendas</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {filteredGridItems.length > visibleCount && (
            <button
              className="block mx-auto mt-8 px-6 py-3 rounded bg-zinc-800 hover:bg-zinc-700 text-sm font-semibold cursor-pointer touch-target tap-highlight"
              onClick={() => setVisibleCount(count => count + 48)}
            >
              Mostrar mais títulos
            </button>
          )}
        </main>
      ) : (
        <main className="flex-1 pb-12 sm:pb-20">
          {/* Fullscreen Netflix Hero Billboard */}
          <HeroBillboard
            featuredItems={featuredItems}
            onPlay={(item) => void openPlayer(item)}
            onMoreInfo={(item) => void openDetails(item)}
            onToggleMyList={handleToggleMyList}
          />

          {/* Horizontal Netflix Carousels pulled slightly over the bottom of the Hero */}
          <div className="relative z-20 -mt-4 sm:-mt-12 md:-mt-24 space-y-1 sm:space-y-2 md:space-y-4">
            {continueWatchingItems.length > 0 && (
              <MediaRow
                title={`Continuar assistindo como ${activeProfile.name}`}
                subtitle="Retome exatamente do segundo em que parou com sua faixa de áudio e legenda salvas"
                items={[...continueWatchingItems].sort((a,b) => Date.parse(b.progress!.updated_at) - Date.parse(a.progress!.updated_at))}
                onExplore={() => explore('movies')}
                onRemoveProgress={handleRemoveProgress}
                onPlay={(item) => void openPlayer(item)}
                onMoreInfo={(item) => void openDetails(item)}
                onToggleMyList={handleToggleMyList}
              />
            )}

            <MediaRow
              title="Adicionados Recentemente"
              subtitle="Últimos títulos adicionados ao catálogo"
              items={recentItems}
              onExplore={() => explore('movies')}
              onPlay={(item) => void openPlayer(item)}
              onMoreInfo={(item) => void openDetails(item)}
              onToggleMyList={handleToggleMyList}
            />

            {dcHeroItems.length > 0 && (
              <MediaRow
                title="Ação, Aventura & Universo DC"
                items={dcHeroItems}
                onExplore={() => explore('dc')}
                onPlay={(item) => void openPlayer(item)}
                onMoreInfo={(item) => void openDetails(item)}
                onToggleMyList={handleToggleMyList}
              />
            )}

            {familyAnimationItems.length > 0 && (
              <MediaRow
                title="Animação & Família"
                items={familyAnimationItems}
                onExplore={() => explore('kids')}
                onPlay={(item) => void openPlayer(item)}
                onMoreInfo={(item) => void openDetails(item)}
                onToggleMyList={handleToggleMyList}
              />
            )}

            {uhd4kItems.length > 0 && (
              <MediaRow
                title="Experiência Cinema — 4K Ultra HD"
                items={uhd4kItems}
                onExplore={() => explore('4k')}
                onPlay={(item) => void openPlayer(item)}
                onMoreInfo={(item) => void openDetails(item)}
                onToggleMyList={handleToggleMyList}
              />
            )}

            {myListItems.length > 0 && (
              <MediaRow
                title="Minha Lista"
                items={myListItems}
                onExplore={() => explore('mylist')}
                onPlay={(item) => void openPlayer(item)}
                onMoreInfo={(item) => void openDetails(item)}
                onToggleMyList={handleToggleMyList}
              />
            )}
            <MediaRow title="10 títulos com maior nota" items={topRatedItems} isTop10 onExplore={() => { explore('movies'); setFilters(previous => ({ ...previous, sort: 'rating' })); }} onPlay={item => void openPlayer(item)} onMoreInfo={item => void openDetails(item)} onToggleMyList={handleToggleMyList} />
          </div>
        </main>
      )}

      {/* Netflix Style Footer */}
      <footer className="border-t border-zinc-900 bg-[#141414] pt-8 pb-24 sm:py-10 px-4 md:px-12 text-xs text-zinc-500 safe-left safe-right safe-bottom">
        <div className="max-w-[1800px] mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-5 sm:gap-6">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-netflix-logo text-2xl text-[#E50914] tracking-wider">
                MINATTOFLIX V2
              </span>
              <span className="hidden sm:inline text-zinc-600">•</span>
              <span className="text-zinc-400 font-medium">
                Streaming em Alta Definição • Dual Áudio 5.1 & Legendas
              </span>
            </div>
            <p className="leading-relaxed">
              Suporte completo a Dual Áudio (faixas embutidas no .MKV via EBML/Mediabunny ou arquivos separados)
              e Legendas (.SRT / .VTT / .ASS).
            </p>
          </div>

          <div className="hidden sm:flex sm:flex-row items-center gap-3 w-full md:w-auto">
            <button
              onClick={() => setShowCloudStudio(true)}
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 px-4 py-2.5 rounded flex items-center justify-center gap-2 transition cursor-pointer touch-target tap-highlight"
            >
              <Cloud className="w-4 h-4 text-[#E50914] shrink-0" />
              <span>Gerenciar Catálogo</span>
            </button>
            <button
              onClick={() => void handleSyncCloudNow().catch(() => {})}
              disabled={isSyncing}
              className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 px-4 py-2.5 rounded flex items-center justify-center gap-2 transition cursor-pointer touch-target tap-highlight"
            >
              <RefreshCw className={`w-4 h-4 text-[#E50914] shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>Sincronizar Catálogo</span>
            </button>
          </div>
        </div>
      </footer>

      {errorBanner}
      {detailLoading && <div role="status" className="fixed bottom-20 sm:bottom-4 right-4 z-[60] bg-zinc-900 border border-zinc-700 rounded p-4 shadow-xl text-sm">Carregando detalhes… <button className="ml-3 underline" onClick={() => { detailRequestRef.current++; setDetailLoading(false); }}>Cancelar</button></div>}

      {/* Title Details Modal */}
      {detailItem && (
        <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-[60] bg-zinc-900 p-4 rounded">Abrindo…</div>}>
          <DetailModal
            item={detailItem}
            onClose={() => setDetailItemId(null)}
            onPlay={(item, audioId, subId, episode) => void openPlayer(item, audioId, subId, episode)}
            onToggleMyList={handleToggleMyList}
            onRefreshCatalog={async () => {
              const data = await requestJson<BootstrapResponse>(`/api/media/${detailItem.id}/details?profileId=${encodeURIComponent(activeProfile.id)}`);
              const refreshed = data.catalog[0];
              if (refreshed) setCatalog(previous => previous.map(media => media.id === refreshed.id ? refreshed : media));
            }}
          />
        </Suspense>
      )}

      {/* Cloud Storage & Software Engineering Studio Modal */}
      {showCloudStudio && (
        <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-[60] bg-zinc-900 p-4 rounded">Abrindo…</div>}>
          <CloudManagerModal
            storageSources={storageSources}
            catalog={catalog}
            onClose={() => setShowCloudStudio(false)}
            onSyncNow={handleSyncCloudNow}
            onAddStorageSource={handleAddStorageSource}
            isSyncing={isSyncing}
          />
        </Suspense>
      )}

      {/* Fullscreen Netflix Video Player */}
      {playerState && (
        Capacitor.getPlatform()==='ios' && !playerState.webFallback ?
        <Suspense fallback={<div role="status" className="fixed inset-0 z-[100] bg-black text-white p-8 safe-top">Abrindo player…</div>}>
          <NativePlayback key={`${playerState.item.id}:${playerState.fileId||''}`}
            item={playerState.item} activeProfile={activeProfile} initialFileId={playerState.fileId}
            initialAudioId={playerState.audioId} initialSubtitleId={playerState.subtitleId}
            onClose={()=>setPlayerState(null)} onFallback={()=>setPlayerState(previous=>previous?{...previous,webFallback:true}:null)}
            onSaveProgress={handleSaveProgress}/>
        </Suspense> : <NetflixPlayer
          item={playerState.item}
          activeProfile={activeProfile}
          initialAudioId={playerState.audioId}
          initialSubtitleId={playerState.subtitleId}
          initialFileId={playerState.fileId}
          onClose={() => setPlayerState(null)}
          onSaveProgress={handleSaveProgress}
          onRefreshCatalog={async () => {
            const data = await requestJson<BootstrapResponse>(`/api/media/${playerState.item.id}/details?profileId=${encodeURIComponent(activeProfile.id)}`);
            const refreshed = data.catalog[0];
            if (refreshed) {
              setCatalog(previous => previous.map(media => media.id === refreshed.id ? refreshed : media));
              const fileIds = new Set(playerState.item.files.map(file => file.id));
              setPlayerState(previous => previous ? { ...previous, item: { ...previous.item,
                files: refreshed.files.filter(file => fileIds.has(file.id)),
                audioTracks: refreshed.audioTracks.filter(track => fileIds.has(track.media_file_id)),
                subtitleTracks: refreshed.subtitleTracks.filter(track => fileIds.has(track.media_file_id)) } } : null);
            }
          }}
        />
      )}
    </div>
  );
};
