import { lazy, Suspense, type ComponentType } from 'react';
import type { MediaItem, Profile } from '../types';

const NetflixPlayer = lazy(() =>
  import('./NetflixPlayer').then((module) => ({ default: module.NetflixPlayer as ComponentType<NetflixPlayerLazyProps> }))
);

interface NetflixPlayerLazyProps {
  item: MediaItem;
  activeProfile: Profile;
  initialAudioId?: string;
  initialSubtitleId?: string;
  onClose: () => void;
  onSaveProgress: (data: {
    mediaItemId: string;
    positionSeconds: number;
    durationSeconds: number;
    selectedAudioId?: string;
    selectedSubtitleId?: string;
  }) => Promise<void>;
  onRefreshCatalog: () => Promise<void>;
}

export function NetflixPlayerLazy(props: NetflixPlayerLazyProps) {
  return (
    <Suspense
      fallback={
        <div className="player-shell fixed inset-0 bg-black flex flex-col justify-between select-none overflow-hidden z-50">
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 border-4 border-[#E50914] border-t-transparent rounded-full animate-spin" />
            <span className="mt-3 text-sm font-semibold tracking-wider text-zinc-300 uppercase">
              Carregando player…
            </span>
          </div>
        </div>
      }
    >
      <NetflixPlayer {...props} />
    </Suspense>
  );
}