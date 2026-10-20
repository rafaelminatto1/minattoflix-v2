import { useEffect } from 'react';

export interface TvNavigationCallbacks {
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onSelect?: () => void;
  onBack?: () => void;
  onPlayPause?: () => void;
  onRewind?: () => void;
  onFastForward?: () => void;
  enabled?: boolean;
}

/**
  * Hook de navegação espacial D-Pad e escuta de eventos de controle remoto
  * compatível com Android TV, Google TV, Apple TV e navegadores.
  */
export function useTvNavigation({
  onUp,
  onDown,
  onLeft,
  onRight,
  onSelect,
  onBack,
  onPlayPause,
  onRewind,
  onFastForward,
  enabled = true,
}: TvNavigationCallbacks) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignorar inputs de texto
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      const key = e.key;
      const keyCode = e.keyCode;

      // D-Pad / Setas
      if (key === 'ArrowUp' || keyCode === 19) {
        if (onUp) {
          e.preventDefault();
          onUp();
        }
      } else if (key === 'ArrowDown' || keyCode === 20) {
        if (onDown) {
          e.preventDefault();
          onDown();
        }
      } else if (key === 'ArrowLeft' || keyCode === 21) {
        if (onLeft) {
          e.preventDefault();
          onLeft();
        }
      } else if (key === 'ArrowRight' || keyCode === 22) {
        if (onRight) {
          e.preventDefault();
          onRight();
        }
      }
      // Select / Enter / D-Pad Center
      else if (key === 'Enter' || key === 'Select' || keyCode === 23 || keyCode === 66) {
        if (onSelect) {
          e.preventDefault();
          onSelect();
        }
      }
      // Voltar / Back / Escape
      else if (key === 'Escape' || key === 'Backspace' || key === 'GoBack' || keyCode === 4 || keyCode === 27) {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
      }
      // Teclas de Mídia (Play/Pause)
      else if (
        key === 'MediaPlayPause' ||
        key === 'MediaPlay' ||
        key === 'MediaPause' ||
        keyCode === 85 ||
        keyCode === 126 ||
        keyCode === 127
      ) {
        if (onPlayPause) {
          e.preventDefault();
          onPlayPause();
        }
      }
      // Rewind / FastForward
      else if (key === 'MediaRewind' || keyCode === 89 || keyCode === 228) {
        if (onRewind) {
          e.preventDefault();
          onRewind();
        }
      } else if (key === 'MediaFastForward' || keyCode === 90 || keyCode === 227) {
        if (onFastForward) {
          e.preventDefault();
          onFastForward();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, onUp, onDown, onLeft, onRight, onSelect, onBack, onPlayPause, onRewind, onFastForward]);
}
