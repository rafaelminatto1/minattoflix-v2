import React, { useEffect, useState, useRef } from 'react';
import { Cloud, Search, X, RefreshCw, ChevronDown, Home, Film, Sparkles, Bookmark, Shield, Baby } from 'lucide-react';
import type { Profile } from '../types';

export type NavSection = 'home' | 'movies' | '4k' | 'dc' | 'kids' | 'mylist';

interface NavbarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activeProfile: Profile;
  onSwitchProfile: () => void;
  onOpenCloudStudio: () => void;
  onQuickSync: () => Promise<void>;
  isSyncing: boolean;
  totalMovies: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeSection,
  onSelectSection,
  searchQuery,
  onSearchChange,
  activeProfile,
  onSwitchProfile,
  onOpenCloudStudio,
  onQuickSync,
  isSyncing,
  totalMovies,
}) => {
  const headerRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Keyboard shortcut (Cmd/Ctrl + K or /) to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName))) {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      setIsScrolled(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--app-header-height');
    const update = () => root.style.setProperty('--app-header-height', header.offsetHeight + 'px');
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (previous) root.style.setProperty('--app-header-height', previous);
      else root.style.removeProperty('--app-header-height');
    };
  }, []);

  const navItems: Array<{ id: NavSection; label: string }> = [
    { id: 'home', label: 'Início' },
    { id: 'movies', label: 'Filmes' },
    { id: '4k', label: 'Em 4K' },
    { id: 'dc', label: 'Heróis & DC' },
    { id: 'kids', label: 'Família & Animação' },
    { id: 'mylist', label: 'Minha Lista' },
  ];

  return (
    <>
      <header
        ref={headerRef}
        className={`app-header fixed top-0 inset-x-0 z-40 transition-colors duration-500 safe-top safe-left safe-right ${
          isScrolled || searchOpen || Boolean(searchQuery)
            ? 'bg-[#141414]/95 backdrop-blur-md shadow-[0_6px_25px_rgba(0,0,0,0.75)]'
            : 'bg-gradient-to-b from-black/95 via-black/60 to-transparent'
        }`}
      >
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4 md:px-12 h-14 sm:h-16 md:h-[68px] flex items-center justify-between gap-2 sm:gap-4">
          {/* Left: Netflix Logo + Links */}
          <div className="flex items-center gap-3 xl:gap-8 min-w-0">
            <button
              onClick={() => {
                onSelectSection('home');
                onSearchChange('');
              }}
              className="flex items-center gap-2 cursor-pointer touch-target-sm tap-highlight shrink-0"
              aria-label="Ir para o Início"
            >
              <span className="font-netflix-logo text-2xl sm:text-2xl lg:text-3xl text-[#E50914] tracking-wider drop-shadow-[0_2px_10px_rgba(229,9,20,0.4)]">
                MINATTOFLIX
              </span>
            </button>

            <nav className="hidden xl:flex items-center gap-4 text-sm whitespace-nowrap">
              {navItems.map((item) => {
                const active = activeSection === item.id && !searchQuery;
                return (
                  <button
                    aria-current={active ? 'page' : undefined}
                    key={item.id}
                    onClick={() => {
                      onSelectSection(item.id);
                      onSearchChange('');
                    }}
                    className={`transition-colors cursor-pointer touch-target-inline px-1 tap-highlight ${
                      active ? 'text-white font-semibold' : 'text-zinc-300 hover:text-zinc-100 font-normal'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right: Search, Cloud Sync Studio, Profile */}
          <div className="flex items-center gap-1.5 min-[380px]:gap-2.5 md:gap-4 shrink-0">
            {/* Expandable Netflix Search Box */}
            <div
              className={`flex items-center transition-all duration-300 ${
                searchOpen || searchQuery
                  ? 'w-11 justify-center sm:justify-start sm:bg-black/85 sm:border sm:border-white/80 sm:px-3 sm:py-1.5 rounded-sm sm:w-64'
                  : 'w-11 justify-center'
              }`}
            >
              <button
                type="button"
                onClick={() => setSearchOpen((prev) => !prev)}
                className="text-white hover:text-zinc-300 flex items-center justify-center cursor-pointer touch-target-sm tap-highlight"
                aria-label="Buscar no catálogo"
                aria-expanded={searchOpen || Boolean(searchQuery)}
                title="Buscar filmes, atores, 4K, Dual Áudio..."
              >
                <Search className="w-5 h-5" />
              </button>
              {(searchOpen || searchQuery) && (
                <>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder="Títulos, 4K, Dual Áudio..."
                    className="hidden sm:block bg-transparent text-sm text-white placeholder-zinc-400 ml-2.5 w-full outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => onSearchChange('')}
                      aria-label="Limpar busca"
                      className="hidden sm:block text-zinc-400 hover:text-white cursor-pointer touch-target-sm tap-highlight"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Quick Sync Button */}
            <button
              onClick={onQuickSync}
              disabled={isSyncing}
              aria-label="Sincronizar nuvem"
              title="Sincronizar catálogo agora"
              className="flex items-center justify-center gap-1.5 text-xs font-medium bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 px-2.5 lg:px-3 py-1.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-[#E50914] ${isSyncing ? 'animate-spin' : ''}`} />
              <span className="hidden lg:inline">{isSyncing ? 'Sincronizando...' : 'Atualizar'}</span>
            </button>

            {/* Cloud Studio Button */}
            <button
              onClick={onOpenCloudStudio}
              aria-label="Gerenciar catálogo"
              className="flex items-center gap-1.5 text-xs font-semibold bg-[#E50914]/15 hover:bg-[#E50914]/25 border border-[#E50914]/50 text-white px-2.5 sm:px-3 py-1.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
              title="Gerenciar catálogo, Dual Áudio e Legendas"
            >
              <Cloud className="w-4 h-4 text-[#E50914] shrink-0" />
              <span className="hidden lg:inline">Catálogo</span>
              <span className="bg-[#E50914] text-white text-[10px] font-bold px-1.5 py-0.5 leading-none rounded-full">
                {totalMovies}
              </span>
            </button>

            {/* Profile Switcher */}
            <button
              onClick={onSwitchProfile}
              className="flex items-center gap-1.5 group cursor-pointer focus:outline-none touch-target-sm tap-highlight"
              title={`Perfil ativo: ${activeProfile.name} (Clique para trocar)`}
            >
              <img
                src={activeProfile.avatar_url}
                alt={activeProfile.name}
                className="w-8 h-8 rounded object-cover ring-1 ring-white/20 group-hover:ring-white transition"
              />
              <ChevronDown className="hidden sm:block w-4 h-4 text-white group-hover:rotate-180 transition-transform duration-200" />
            </button>
          </div>
        </div>

        {(searchOpen || searchQuery) && (
          <div className="sm:hidden px-3 pb-2.5">
            <label className="flex items-center gap-2 bg-black/95 border border-zinc-600 focus-within:border-white rounded-md px-3 py-2 shadow-lg">
              <Search className="w-4 h-4 text-zinc-400 shrink-0" />
              <input
                aria-label="Buscar títulos, atores e idiomas"
                autoFocus
                value={searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Buscar no catálogo…"
                className="min-w-0 w-full bg-transparent outline-none text-sm text-white placeholder-zinc-400"
              />
              <button
                type="button"
                aria-label="Fechar busca"
                onClick={() => {
                  onSearchChange('');
                  setSearchOpen(false);
                }}
                className="flex items-center justify-center text-zinc-400 hover:text-white touch-target-sm tap-highlight -mr-1"
              >
                <X className="w-4 h-4" />
              </button>
            </label>
          </div>
        )}

        {/* Mobile/Tablet horizontal category pills bar */}
        <div className="hidden sm:flex xl:hidden items-center gap-2 overflow-x-auto no-scrollbar px-3 sm:px-4 pb-2.5 pt-0.5 text-xs">
          {navItems.map((item) => {
            const isActive = activeSection === item.id && !searchQuery;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectSection(item.id);
                  onSearchChange('');
                }}
                className={`touch-target-inline shrink-0 flex items-center justify-center whitespace-nowrap px-3.5 py-1.5 rounded-full border transition cursor-pointer tap-highlight ${
                  isActive
                    ? 'bg-white text-black border-white font-semibold shadow-sm'
                    : 'border-zinc-700/90 text-zinc-200 bg-black/55 backdrop-blur-xs hover:border-zinc-500'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Mobile Fixed Bottom App Navigation Bar */}
      <nav
        aria-label="Navegação rápida móvel"
        className="mobile-navigation sm:hidden fixed bottom-0 inset-x-0 z-40 bg-[#121212]/95 backdrop-blur-lg border-t border-zinc-800/90 safe-bottom safe-left safe-right"
      >
        <div className="grid grid-cols-6 h-16">
          {navItems.map((item) => {
            const Icon = { home: Home, movies: Film, '4k': Sparkles, dc: Shield, kids: Baby, mylist: Bookmark }[item.id];
            const active = activeSection === item.id && !searchQuery;
            return (
              <button key={item.id} type="button" aria-label={item.label} title={item.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => { onSelectSection(item.id); onSearchChange(''); }}
                className={`flex flex-col gap-1 items-center justify-center touch-target tap-highlight transition ${active ? 'text-[#E50914] bg-white/5' : 'text-zinc-300 hover:text-white'}`}>
                <Icon className="w-5 h-5" aria-hidden="true" />
                <span className="text-[10px] leading-tight font-medium">{{home:'Início',movies:'Filmes','4k':'4K',dc:'Heróis',kids:'Família',mylist:'Minha lista'}[item.id]}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
};

