import { isPlayerFullscreen, togglePlayerFullscreen, enterPlayerFullscreen, exitPlayerFullscreen, type FullscreenVideo } from '../services/fullscreen';
import { Capacitor } from '@capacitor/core';
import { apiUrl, requestResponse } from '../services/catalog';
import { RoomTransport } from '../services/roomTransport';
import { createPlayerMetrics } from '../services/playerMetrics';
import { useDialog } from '../hooks/useDialog';
import React, { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  SkipBack,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Subtitles,
  Languages,
  Check,
  Upload,
  Cpu,
  HardDrive,
  AlertTriangle,
  Sliders,
  Users,
  Sparkles,
  PictureInPicture2,
  Tv,
  Send,
  Smartphone,
  X,
  Settings,
  RotateCcw as RefreshCw,
  WifiOff,
} from 'lucide-react';
import type { AudioTrack, MediaFile, MediaItem, Profile, SubtitleTrack } from '../types';
import {
  HybridAudioSyncController,
  MkvWebCodecsCanvasPlayer,
  ensureDolbyDecoder,
  inspectStreamWithMediabunny,
  isIosWebKit,
  isTvOrAndroidNative,
  parseWebVttCues,
  type MediabunnyTrackSummary,
  type VttCueItem,
} from '../services/mkvAudioController';

const subtitleCueCache = new Map<string, VttCueItem[]>();
const MAX_SUBTITLE_CACHE_SIZE = 20;

// LRU cache helper for subtitle cues
function getCachedCues(url: string): VttCueItem[] | undefined {
  const cues = subtitleCueCache.get(url);
  if (cues) {
    // Move to end (most recently used)
    subtitleCueCache.delete(url);
    subtitleCueCache.set(url, cues);
  }
  return cues;
}

function setCachedCues(url: string, cues: VttCueItem[]): void {
  if (subtitleCueCache.has(url)) {
    subtitleCueCache.delete(url);
  } else if (subtitleCueCache.size >= MAX_SUBTITLE_CACHE_SIZE) {
    // Remove least recently used (first entry)
    const firstKey = subtitleCueCache.keys().next().value;
    if (firstKey) subtitleCueCache.delete(firstKey);
  }
  subtitleCueCache.set(url, cues);
}

// HLS.js for iOS Safari fallback (when native HLS not available)
interface HlsStatic {
  new (config?: HlsConfig): HlsInstance;
  isSupported(): boolean;
  Events: {
    MANIFEST_PARSED: string;
    ERROR: string;
    LEVEL_SWITCHED?: string;
    [key: string]: string | undefined;
  };
  ErrorTypes: {
    NETWORK_ERROR: string;
    MEDIA_ERROR: string;
  };
}

interface HlsConfig {
  enableWorker?: boolean;
  lowLatencyMode?: boolean;
  backBufferLength?: number;
  capLevelToPlayerSize?: boolean;
  maxBufferLength?: number;
  maxMaxBufferLength?: number;
  maxBufferSize?: number;
  maxBufferHole?: number;
  highBufferWatchdogPeriod?: number;
  nudgeOffset?: number;
  nudgeMaxRetry?: number;
  nudgeDelay?: number;
}

interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  destroy(): void;
  startLoad(): void;
  recoverMediaError(): void;
  levels?: Array<{ height: number; width: number; bitrate: number; name?: string }>;
  currentLevel?: number;
}

let Hls: HlsStatic | null = null;
const loadHlsJs = async (): Promise<HlsStatic | null> => {
  if (!Hls && typeof window !== 'undefined') {
    try {
      const module = await import('hls.js');
      Hls = module.default as HlsStatic;
    } catch (e) {
      console.warn('HLS.js failed to load:', e);
    }
  }
  return Hls;
};

/**
 * Shared Master Clock Context
 * Provides a single source of truth for playback time across video and audio pipelines
 * Prevents clock drift between WebCodecs Canvas (performance.now()) and Web Audio API (AudioContext.currentTime)
 */
interface MasterClock {
  getCurrentTime: () => number;
  isPaused: () => boolean;
  getPlaybackRate: () => number;
  // For VideoDecoder/Canvas pipeline
  getPerformanceTime: () => number;
}

const MasterClockContext = createContext<MasterClock | null>(null);

export function useMasterClock(): MasterClock {
  const ctx = useContext(MasterClockContext);
  if (!ctx) {
    throw new Error('useMasterClock must be used within MasterClockProvider');
  }
  return ctx;
}

function MasterClockProvider({
  children,
  clock,
}: {
  children: React.ReactNode;
  clock: MasterClock;
}) {
  return (
    <MasterClockContext.Provider value={clock}>
      {children}
    </MasterClockContext.Provider>
  );
}

/**
 * Detects if the browser needs HLS
 * Enable for iOS WebKit with MKV files to bypass WebCodecs canvas player
 * which can have audio sync issues on Firefox iOS / some Safari versions
 */
function needsHlsPlayback(): boolean {
  // Do not force HLS for cloud files on iOS WebKit; mux.js cannot transmux MKV on Cloudflare Workers
  return false;
}

/**
 * Generates HLS master playlist URL for a file
 */
function getHlsMasterUrl(fileId: string): string {
  return apiUrl(`/api/stream/hls/${fileId}/master.m3u8`);
}

interface NetflixPlayerProps {
  item: MediaItem;
  activeProfile: Profile;
  initialAudioId?: string;
  initialSubtitleId?: string;
  initialFileId?: string;
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

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const NetflixPlayer: React.FC<NetflixPlayerProps> = ({
  item,
  activeProfile,
  initialAudioId,
  initialSubtitleId,
  initialFileId,
  onClose,
  onSaveProgress,
  onRefreshCatalog,
}) => {
  const containerRef = useDialog();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasPlayerRef = useRef<MkvWebCodecsCanvasPlayer | null>(null);
  const canvasResumeTimeRef = useRef<number | null>(null);
  const audioControllerRef = useRef<HybridAudioSyncController | null>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const failedFilesRef = useRef(new Set<string>());
  const wsRef = useRef<RoomTransport | null>(null);
  const metricsRef = useRef<ReturnType<typeof createPlayerMetrics> | null>(null);
  useEffect(() => { metricsRef.current = createPlayerMetrics(); }, [item.id]);
  const suppressSyncBroadcastRef = useRef<boolean>(false);

  // Prefer the mirror that supports sustained ranged playback; Drive may
  // return a download confirmation page for large public media requests.
  const initialSelectedFile = item.files.find(file => file.id === initialFileId) || (isIosWebKit() && item.files.find((file) =>
    /^(mp4|m4v)$/i.test(file.container || '') || /\.(mp4|m4v)$/i.test(file.filename || '')))
    || item.files.find((file) => file.provider === 'onedrive') || item.files[0];
  const [selectedFile, setSelectedFile] = useState<MediaFile | undefined>(initialSelectedFile);
  const [customStreamUrl, setCustomStreamUrl] = useState<string | null>(null);
  const effectiveStreamUrl = customStreamUrl || selectedFile?.streamUrl || '';
  const isMkvFile =
    (selectedFile?.container || '').toLowerCase() === 'mkv' ||
    (selectedFile?.filename || '').toLowerCase().endsWith('.mkv');
  const is4KMedia = Boolean(
    (selectedFile?.resolution || '').includes('2160') ||
    (selectedFile?.resolution || '').toLowerCase().includes('4k') ||
    (selectedFile?.filename || '').toLowerCase().includes('2160p') ||
    (selectedFile?.size_bytes ? Number(selectedFile.size_bytes) > 8 * 1024 * 1024 * 1024 : false)
  );
  // On iOS WebKit, native <video> cannot play MKV containers and worker cannot transmux MKV to HLS.
  // Directly initialize WebCodecs canvas player for MKV files on iOS to ensure immediate playback.
  const [useWebCodecsCanvas, setUseWebCodecsCanvas] = useState<boolean>(() => {
    return isIosWebKit() && Boolean(
      (initialSelectedFile?.container || '').toLowerCase() === 'mkv' ||
      (initialSelectedFile?.filename || '').toLowerCase().endsWith('.mkv')
    );
  });

  const nativeIos = Capacitor.getPlatform() === 'ios';
  const [playing, setPlaying] = useState(() => nativeIos || !isIosWebKit());
  const [currentTime, setCurrentTime] = useState(item.progress?.is_completed ? 0 : item.progress?.position_seconds || 0);
  const [duration, setDuration] = useState(item.progress?.duration_seconds || item.runtime_minutes * 60);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('minattoflix_volume')) || 1);
  const [muted, setMuted] = useState(() => localStorage.getItem('minattoflix_muted') === 'true');
  const [playbackRate, setPlaybackRate] = useState(() => Number(localStorage.getItem('minattoflix_playbackRate')) || 1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expandedPlayer, setExpandedPlayer] = useState(nativeIos);
  const [fullscreenError, setFullscreenError] = useState('');
  const [introDismissed, setIntroDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showControls, setShowControls] = useState(!nativeIos);
  const [isBuffering, setIsBuffering] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Persisted user preferences
  const [audioOffsetSec, setAudioOffsetSec] = useState(() => Number(localStorage.getItem('minattoflix_audioOffset')) || 0);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>(() => (localStorage.getItem('minattoflix_subtitleSize') as 'sm' | 'md' | 'lg') || 'md');
  const [subtitleOffsetSec, setSubtitleOffsetSec] = useState(() => Number(localStorage.getItem('minattoflix_subtitleOffset')) || 0);
  const [dialogueBoost, setDialogueBoost] = useState(() => localStorage.getItem('minattoflix_dialogueBoost') === 'true');
  const [preferredQuality, setPreferredQuality] = useState<string>(() => localStorage.getItem('minattoflix_quality') || 'auto');
  const [subtitleStyle, setSubtitleStyle] = useState<'netflix' | 'disney' | 'crunchyroll' | 'custom'>(() => (localStorage.getItem('minattoflix_subtitleStyle') as 'netflix' | 'disney' | 'crunchyroll' | 'custom') || 'netflix');
  const [subtitleFont, setSubtitleFont] = useState<'inter' | 'roboto' | 'system'>(() => (localStorage.getItem('minattoflix_subtitleFont') as 'inter' | 'roboto' | 'system') || 'inter');
  const [subtitleBackground, setSubtitleBackground] = useState<'none' | 'semi' | 'full'>(() => (localStorage.getItem('minattoflix_subtitleBackground') as 'none' | 'semi' | 'full') || 'semi');
  const [subtitleEdge, setSubtitleEdge] = useState<'none' | 'outline' | 'shadow'>(() => (localStorage.getItem('minattoflix_subtitleEdge') as 'none' | 'outline' | 'shadow') || 'outline');
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showQualityDashboard, setShowQualityDashboard] = useState(false);
  const [osdMessage, setOsdMessage] = useState<{ text: string; icon?: 'forward' | 'backward' | 'volume' | 'caption' | 'speed' | 'play' | 'pause'; id: number } | null>(null);
  const [videoFitMode, setVideoFitMode] = useState<'cover' | 'contain'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('minattoflix_videoFit');
      if (saved === 'cover' || saved === 'contain') return saved;
    }
    return 'contain';
  });
  const osdTimerRef = useRef<number | null>(null);
  const clickTimeoutRef = useRef<number | null>(null);

  const showOsdFeedback = useCallback((text: string, icon?: 'forward' | 'backward' | 'volume' | 'caption' | 'speed' | 'play' | 'pause') => {
    if (osdTimerRef.current) window.clearTimeout(osdTimerRef.current);
    setOsdMessage({ text, icon, id: Date.now() });
    osdTimerRef.current = window.setTimeout(() => {
      setOsdMessage(null);
    }, 1200);
  }, []);

  const toggleFitMode = useCallback(() => {
    setVideoFitMode((prev) => {
      const next = prev === 'cover' ? 'contain' : 'cover';
      try {
        localStorage.setItem('minattoflix_videoFit', next);
      } catch {}
      showOsdFeedback(next === 'cover' ? 'Preencher tela inteira' : 'Ajustar à tela original');
      return next;
    });
  }, [showOsdFeedback]);

  // Persist preferences to localStorage
  useEffect(() => { localStorage.setItem('minattoflix_volume', String(volume)); }, [volume]);
  useEffect(() => { localStorage.setItem('minattoflix_muted', String(muted)); }, [muted]);
  useEffect(() => { localStorage.setItem('minattoflix_playbackRate', String(playbackRate)); }, [playbackRate]);
  useEffect(() => { localStorage.setItem('minattoflix_audioOffset', String(audioOffsetSec)); }, [audioOffsetSec]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleSize', subtitleSize); }, [subtitleSize]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleOffset', String(subtitleOffsetSec)); }, [subtitleOffsetSec]);
  useEffect(() => { localStorage.setItem('minattoflix_dialogueBoost', String(dialogueBoost)); }, [dialogueBoost]);
  useEffect(() => { localStorage.setItem('minattoflix_quality', preferredQuality); }, [preferredQuality]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleStyle', subtitleStyle); }, [subtitleStyle]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleFont', subtitleFont); }, [subtitleFont]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleBackground', subtitleBackground); }, [subtitleBackground]);
  useEffect(() => { localStorage.setItem('minattoflix_subtitleEdge', subtitleEdge); }, [subtitleEdge]);

  // Shared Master Clock - single source of truth for playback time
  // Prevents drift between WebCodecs Canvas (performance.now()) and Web Audio API (AudioContext.currentTime)
  const masterClockRef = useRef<MasterClock>({
    getCurrentTime: () => {
      if (useWebCodecsCanvas && canvasPlayerRef.current) {
        return canvasPlayerRef.current.getCurrentTime();
      }
      return videoRef.current?.currentTime || 0;
    },
    isPaused: () => {
      if (useWebCodecsCanvas && canvasPlayerRef.current) {
        return canvasPlayerRef.current.isPaused();
      }
      return videoRef.current?.paused ?? true;
    },
    getPlaybackRate: () => {
      if (useWebCodecsCanvas && canvasPlayerRef.current) {
        return canvasPlayerRef.current.getPlaybackRate();
      }
      return videoRef.current?.playbackRate || 1;
    },
    getPerformanceTime: () => performance.now(),
  });

  const introEnd = item.intro_end_seconds;
  const introEligible = playing && typeof introEnd === 'number' && Number.isFinite(introEnd)
    && introEnd > (item.intro_start_seconds || 0) && introEnd < duration
    && currentTime >= (item.intro_start_seconds || 0) && currentTime < introEnd;

  // Intro skip timer - hide "Pular abertura" after 3 seconds of eligibility
  useEffect(() => {
    if (!introEligible || introDismissed) return;
    const timer = window.setTimeout(() => setIntroDismissed(true), 3000);
    return () => window.clearTimeout(timer);
  }, [introEligible, introDismissed]);
  useEffect(() => { setIntroDismissed(false); }, [effectiveStreamUrl]);

  // Keep screen awake during playback (Wake Lock API)
  useEffect(() => {
    if (!playing || streamError) return;
    let disposed = false;
    let pending = false;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (disposed || pending || lock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (disposed) { await next.release(); return; }
        lock = next;
        next.addEventListener('release', () => { if (lock === next) lock = null; });
      } catch { /* Browser or battery policy can deny the request. */ }
      finally { pending = false; }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, [playing, streamError]);

  // Resume audio context on visibility change (iOS Safari may suspend audio context when tab is hidden)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        audioControllerRef.current?.resumeAudioContext();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Playback telemetry uses bounded events; there is no periodic metrics upload.

  // Lock orientation to landscape when entering fullscreen on mobile
  // This must be called within a user gesture to work on iOS

  const initialFileAudioTracks = initialSelectedFile
    ? item.audioTracks.filter((a) => a.media_file_id === initialSelectedFile.id || a.source_type !== 'embedded')
    : item.audioTracks;
  const candidateAudioTracks = initialFileAudioTracks.length > 0 ? initialFileAudioTracks : item.audioTracks;

  const initialFileSubTracks = initialSelectedFile
    ? item.subtitleTracks.filter((s) => s.media_file_id === initialSelectedFile.id || s.source_type !== 'embedded')
    : item.subtitleTracks;
  const candidateSubTracks = initialFileSubTracks.length > 0 ? initialFileSubTracks : item.subtitleTracks;

  // Resolve initial playing audio track
  const initialResolvedAudio =
    (initialAudioId && candidateAudioTracks.find((a) => a.id === initialAudioId)) ||
    (item.progress?.selected_audio_id && candidateAudioTracks.find((a) => a.id === item.progress?.selected_audio_id)) ||
    candidateAudioTracks.find((a) => a.language_code === activeProfile.preferred_audio_lang) ||
    candidateAudioTracks.find((a) => ['pt-br', 'pt', 'por', 'pob'].includes((a.language_code || '').toLowerCase())) ||
    candidateAudioTracks[0];

  const isAudioPortuguese = Boolean(
    initialResolvedAudio &&
    ['pt-br', 'pt', 'por', 'pob'].includes((initialResolvedAudio.language_code || '').toLowerCase())
  );

  const isMoviePortuguese = Boolean(
    ['pt-br', 'pt', 'por', 'pob'].includes(((item as unknown as { original_language?: string }).original_language || '').toLowerCase()) || isAudioPortuguese
  );

  // Audio & Subtitle Menu State
  const [showAudioSubMenu, setShowAudioSubMenu] = useState(false);
  const [activeAudioId, setActiveAudioId] = useState<string>(initialResolvedAudio?.id || '');

  const [activeSubtitleId, setActiveSubtitleId] = useState<string>(() => {
    // 1. Explicit initial selection from caller
    if (initialSubtitleId) {
      if (initialSubtitleId === 'off') return 'off';
      const match = candidateSubTracks.find((s) => s.id === initialSubtitleId);
      if (match) return match.id;
    }

    // 2. Saved user progress for this specific title
    const savedSubId = item.progress?.selected_subtitle_id;
    if (savedSubId) {
      if (savedSubId === 'off') return 'off';
      const match = candidateSubTracks.find((s) => s.id === savedSubId);
      if (match) return match.id;
    }

    // 3. User requirement: "mas em filme postugues deixes por padrão desativada quando reproduzido"
    // In Portuguese movies or when playing in Portuguese, subtitles are OFF by default!
    if (isMoviePortuguese || isAudioPortuguese) {
      const forcedSub = candidateSubTracks.find((s) => s.is_forced);
      return forcedSub ? forcedSub.id : 'off';
    }

    // 4. Foreign movie (e.g. Odyssey with English audio):
    // Brazilian users need PT-BR subtitles enabled by default!
    const ptSub = candidateSubTracks.find((s) =>
      ['pt-br', 'pt', 'por', 'pob'].includes((s.language_code || '').toLowerCase())
    );
    if (ptSub) return ptSub.id;

    // 5. Default track if configured, else off
    const defaultSub = candidateSubTracks.find((s) => s.is_default);
    if (defaultSub) return defaultSub.id;

    return 'off';
  });

  const [audioStatusNote, setAudioStatusNote] = useState<string>('Preparando áudio…');
  const [mediabunnyTracks, setMediabunnyTracks] = useState<MediabunnyTrackSummary[]>([]);
  const [aiGeneratingSub, setAiGeneratingSub] = useState(false);
  const [copiedStreamUrl, setCopiedStreamUrl] = useState(false);

  // Mobile detection & Auto-Fullscreen on mobile
  useEffect(() => {
    const checkMobile = () =>
      setIsMobile(
        window.innerWidth < 768 ||
          window.matchMedia?.('(pointer: coarse)').matches ||
          /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      );
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);



  // HLS State for iOS Safari
  const [hlsInstance, setHlsInstance] = useState<HlsInstance | 'native' | null>(null);
  const [useHls, setUseHls] = useState(false);
  const [hlsError, setHlsError] = useState<string | null>(null);
  const [hlsLevels, setHlsLevels] = useState<Array<{ height: number; bitrate: number; width: number; index?: number; name?: string }>>([]);
  const [currentQuality, setCurrentQuality] = useState<string>(() => localStorage.getItem('minattoflix_quality') || 'auto');
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 3;

  // Auto-Next Episode State
  const [showNextEpisodeCountdown, setShowNextEpisodeCountdown] = useState(false);
  const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState(10);
  const [nextEpisodeItem, setNextEpisodeItem] = useState<MediaItem | null>(null);

  // Custom Subtitle Renderer State
  const [subtitleCues, setSubtitleCues] = useState<VttCueItem[]>([]);

  const [activeCueText, setActiveCueText] = useState<string>('');

  // Cloudflare Durable Object Watch Party & TV Remote State
  const [showWatchParty, setShowWatchParty] = useState(false);
  const [roomCode, setRoomCode] = useState('MINA');
  const [wsConnected, setWsConnected] = useState(false);
  const [partyParticipants, setPartyParticipants] = useState(1);
  const [chatMessages, setChatMessages] = useState<
    Array<{ senderName: string; chatText: string; timestamp: string }>
  >([]);
  const [chatInput, setChatInput] = useState('');

  const enterFullscreen = useCallback(async () => {
    setFullscreenError('');
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (isPlayerFullscreen(doc, videoRef.current as FullscreenVideo | null) || expandedPlayer) {
      setIsFullscreen(true);
      return;
    }
    // Lock to landscape immediately within the user gesture (required for mobile/iOS)
    const orientation = (screen as Screen & { orientation?: { lock?: (mode: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (isMobile) {
      try {
        await orientation?.lock?.('landscape');
      } catch {
        // Ignore if orientation lock fails
      }
    }

    // On iOS Safari/WebKit, use MinattoFlix immersive expanded fullscreen
    // to preserve all custom controls, audio/subtitles selection and edge-to-edge fill
    if (isIosWebKit()) {
      setExpandedPlayer(true);
      setIsFullscreen(true);
      return;
    }

    try {
      await enterPlayerFullscreen(
        document,
        containerRef.current || document.documentElement,
        useWebCodecsCanvas ? null : (videoRef.current as FullscreenVideo | null),
        false
      );
      const active = isPlayerFullscreen(document, videoRef.current as FullscreenVideo | null);
      setIsFullscreen(active);
    } catch {
      setExpandedPlayer(true);
      setIsFullscreen(true);
    }
  }, [isMobile, useWebCodecsCanvas, expandedPlayer]);

  const toggleFullscreen = useCallback(async () => {
    if (isMobile || nativeIos) { await enterFullscreen(); return; }
    setFullscreenError('');
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const currentIsFs = isPlayerFullscreen(doc, videoRef.current as FullscreenVideo | null) || expandedPlayer;
    const orientation = (screen as Screen & { orientation?: { lock?: (mode: string) => Promise<void>; unlock?: () => void } }).orientation;

    if (currentIsFs) {
      try {
        setExpandedPlayer(false);
        await exitPlayerFullscreen(document, videoRef.current as FullscreenVideo | null);
        setIsFullscreen(false);
        orientation?.unlock?.();
      } catch {
        // Ignore exit errors
      }
      return;
    }

    await enterFullscreen();
  }, [enterFullscreen, expandedPlayer, isMobile, nativeIos]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(isPlayerFullscreen(doc, videoRef.current as FullscreenVideo | null) || expandedPlayer);
    };
    const video = videoRef.current;
    const onNativeEnter = () => { setIsFullscreen(true); setFullscreenError(''); };
    const onNativeExit = () => { setIsFullscreen(false); setExpandedPlayer(false); };
    video?.addEventListener('webkitbeginfullscreen', onNativeEnter);
    video?.addEventListener('webkitendfullscreen', onNativeExit);
    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);

    return () => {
      video?.removeEventListener('webkitbeginfullscreen', onNativeEnter);
      video?.removeEventListener('webkitendfullscreen', onNativeExit);
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
    };
  }, [effectiveStreamUrl, enterFullscreen]);

  const hlsMasterUrl = selectedFile ? getHlsMasterUrl(selectedFile.id) : '';

  // Determine if we should use HLS (always prefer HLS for MKV or on TV/Native to leverage hardware decoders)
  const isDirectHlsStream = Boolean(effectiveStreamUrl && /\.m3u8(\?|$)/i.test(effectiveStreamUrl));
  const shouldUseHls = !useWebCodecsCanvas && !hlsError && (useHls || isDirectHlsStream);

  // Filter embedded tracks to the currently active cloud file (GDrive or OneDrive) + any external tracks
  const visibleAudioTracks = React.useMemo(() => {
    if (!selectedFile) return item.audioTracks;
    const forFile = item.audioTracks.filter(
      (a) => a.media_file_id === selectedFile.id || a.source_type !== 'embedded'
    );
    return forFile.length > 0 ? forFile : item.audioTracks;
  }, [item.audioTracks, selectedFile]);

  const visibleSubtitleTracks = React.useMemo(() => {
    if (!selectedFile) return item.subtitleTracks;
    const forFile = item.subtitleTracks.filter(
      (s) => s.media_file_id === selectedFile.id || s.source_type !== 'embedded'
    );
    return forFile.length > 0 ? forFile : item.subtitleTracks;
  }, [item.subtitleTracks, selectedFile]);

  const previousAudioTrack = item.audioTracks.find((a) => a.id === activeAudioId);
  const resolvedAudioTrack = visibleAudioTracks.find((a) => a.id === activeAudioId)
    || visibleAudioTracks.find((a) => a.language_code === previousAudioTrack?.language_code)
    || visibleAudioTracks.find((a) => a.is_default) || visibleAudioTracks[0];

  useEffect(() => {
    if (!videoRef.current) return;
    const ctrl = new HybridAudioSyncController(videoRef.current, setAudioStatusNote, () => audioOffsetSec);
    ctrl.setIs4KMode(is4KMedia);
    audioControllerRef.current = ctrl;
    // Initialize audio graph early to set audioSession.type = 'playback' for iOS silent mode support
    ctrl.resumeAudioContext();
    const video = videoRef.current;
    const diagnosticsTimer = window.setInterval(() => {
      for (const [key, value] of Object.entries(ctrl.getAudioDiagnostics())) {
        video.dataset[key] = String(value);
      }
    }, 1000);
    
    // Debug: Log audio/video clock drift every 5 seconds
    const driftTimer = window.setInterval(() => {
      if (useWebCodecsCanvas && canvasPlayerRef.current && audioControllerRef.current) {
        const videoTime = canvasPlayerRef.current.getCurrentTime();
        const audioDiag = ctrl.getAudioDiagnostics();
        const audioCtxTime = audioDiag.audioContextState === 'running' ? audioDiag.audioContextState : 'N/A';
        console.debug('[Sync Debug] Video:', videoTime.toFixed(3), '| AudioCtx:', audioCtxTime, '| WASM Active:', audioDiag.wasmActive, '| Scheduled:', audioDiag.wasmScheduledBuffers, '| Peak:', audioDiag.audioOutputPeak?.toFixed(4));
      } else if (videoRef.current && audioControllerRef.current) {
        const videoTime = videoRef.current.currentTime;
        const audioDiag = ctrl.getAudioDiagnostics();
        console.debug('[Sync Debug] Video:', videoTime.toFixed(3), '| AudioCtx:', audioDiag.audioContextState, '| WASM Active:', audioDiag.wasmActive, '| Scheduled:', audioDiag.wasmScheduledBuffers, '| Peak:', audioDiag.audioOutputPeak?.toFixed(4));
      }
    }, 5000);
    return () => {
      window.clearInterval(diagnosticsTimer);
      window.clearInterval(driftTimer);
      ctrl.destroy();
    };
  }, [audioOffsetSec]);

  useEffect(() => {
    if (!useWebCodecsCanvas || !effectiveStreamUrl || !canvasRef.current) {
      if (canvasPlayerRef.current) {
        canvasPlayerRef.current.destroy();
        canvasPlayerRef.current = null;
      }
      audioControllerRef.current?.setClockOverride(null, false);
      return;
    }

    const startAt = canvasResumeTimeRef.current ?? (!item.progress?.is_completed && item.progress?.position_seconds && item.progress.position_seconds > 5
      ? item.progress.position_seconds
      : 0);
    canvasResumeTimeRef.current = null;

    let active = true;
    let loadTimer: number | undefined;
    const clearLoadTimer = () => window.clearTimeout(loadTimer);
    const failPlayback = (reason: string) => {
      if (!active) return;
      clearLoadTimer();
      player.pause();
      audioControllerRef.current?.notifyClockPause();
      if (selectedFile && !customStreamUrl) {
        failedFilesRef.current.add(selectedFile.id);
        const alternate = item.files.find((file) => !failedFilesRef.current.has(file.id));
        if (alternate) {
          setSelectedFile(alternate);
          setUseWebCodecsCanvas(isIosWebKit() &&
            (/^mkv$/i.test(alternate.container || '') || /\.mkv$/i.test(alternate.filename || '')));
          setAudioStatusNote('Tentando outra fonte de vídeo…');
          return;
        }
      }
      setPlaying(false);
      setIsBuffering(false);
      setStreamError(`Não foi possível iniciar este vídeo (${reason}). Tente outra fonte ou abra no VLC.`);
    };
    const armLoadTimer = () => {
      clearLoadTimer();
      loadTimer = window.setTimeout(() => {
        player.destroy();
        failPlayback('a fonte ou o decodificador não respondeu em 30 segundos');
      }, 30_000);
    };
    const player = new MkvWebCodecsCanvasPlayer(canvasRef.current, {
      onLoadedMetadata: (dur) => {
        setDuration(dur);
      },
      onTimeUpdate: (cur, bufEnd) => {
        setCurrentTime(cur);
        setBufferedEnd(bufEnd);
      },
      onCanPlay: () => {
        metricsRef.current?.('start');
        if (!active) return;
        clearLoadTimer();
        setIsBuffering(false);
        setStreamError(null);
        // Start/re-anchor audio only after the canvas has presented a frame.
        audioControllerRef.current?.notifyClockPlay();
      },
      onReadyToPlay: () => {
        if (!active) return;
        clearLoadTimer();
        setIsBuffering(false);
        setStreamError(null);
        setShowControls(!nativeIos);
        // On desktop/Android, auto-fullscreen when ready; on iOS, wait for user play tap to preserve gesture
        if (!isFullscreen && !isIosWebKit()) {
          void enterFullscreen();
        }
      },
      onWaiting: () => {
        metricsRef.current?.('waiting');
        if (!active) return;
        audioControllerRef.current?.notifyClockPause();
        setIsBuffering(true);
        armLoadTimer();
      },
      onError: reason => { metricsRef.current?.('error'); failPlayback(reason); },
    });
    canvasPlayerRef.current = player;

    audioControllerRef.current?.setClockOverride(
      {
        getCurrentTime: () => player.getCurrentTime(),
        isPaused: () => player.isPaused() || player.isWaitingForFrame(),
        getPlaybackRate: () => player.getPlaybackRate(),
      },
      true
    );

    setIsBuffering(true);
    setStreamError(null);
    armLoadTimer();
    void player.open(effectiveStreamUrl, startAt, nativeIos || !isIosWebKit());
    if (isIosWebKit() && !nativeIos) setPlaying(false);

    return () => {
      active = false;
      clearLoadTimer();
      player.destroy();
      if (canvasPlayerRef.current === player) {
        canvasPlayerRef.current = null;
      }
      audioControllerRef.current?.setClockOverride(null, false);
    };
  }, [useWebCodecsCanvas, effectiveStreamUrl]);

  // Some browsers play the MKV audio clock without reporting a video error.
  // Verify actual frame presentation before accepting native playback.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || useWebCodecsCanvas || !isMkvFile || !effectiveStreamUrl) return;
    let stopped = false;
    let frameId = 0;
    let presented = false;
    let playingSince = 0;
    video.dataset.nativePresentedFrames = '0';
    const observeFrame = () => {
      presented = true;
      video.dataset.nativePresentedFrames = String(Number(video.dataset.nativePresentedFrames || 0) + 1);
      if (!stopped) frameId = video.requestVideoFrameCallback(observeFrame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameId = video.requestVideoFrameCallback(observeFrame);
    }
    const timer = window.setInterval(() => {
      if (video.paused || video.seeking || video.readyState < 2) {
        playingSince = 0;
        return;
      }
      playingSince ||= performance.now();
      const quality = video.getVideoPlaybackQuality?.();
      const missingFrames = typeof video.requestVideoFrameCallback === 'function'
        ? !presented : quality ? quality.totalVideoFrames === 0 : video.videoWidth === 0;
      if (performance.now() - playingSince < 8000 || !missingFrames) return;
      window.clearInterval(timer);
      canvasResumeTimeRef.current = video.currentTime;
      video.pause();
      audioControllerRef.current?.notifyClockPause();
      if ('VideoDecoder' in window) {
        setUseHls(false);
        setUseWebCodecsCanvas(true);
        setPlaying(true);
      } else {
        setPlaying(false);
        setIsBuffering(false);
        setStreamError('O navegador reproduz o áudio, mas não decodifica o vídeo deste arquivo. Abra no VLC ou tente outro navegador.');
      }
    }, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (frameId) video.cancelVideoFrameCallback(frameId);
    };
  }, [effectiveStreamUrl, useWebCodecsCanvas, isMkvFile]);

  useEffect(() => {
    if (!effectiveStreamUrl || !audioControllerRef.current) return;
    const track: AudioTrack | undefined = resolvedAudioTrack || (useWebCodecsCanvas && selectedFile ? {
      id: `auto-audio-${selectedFile.id}`, media_file_id: selectedFile.id,
      source_type: 'embedded', track_index: 0, language_code: 'und',
      label: 'Áudio do arquivo', codec: '', channels: '', is_default: true,
    } : undefined);
    if (!track || track.source_type !== 'embedded') return;
    if (track.id !== activeAudioId) {
      setActiveAudioId(track.id);
      return;
    }
    let cancelled = false;
    setAudioStatusNote('Preparando áudio…');
    audioControllerRef.current.selectAudioTrack(track, undefined, effectiveStreamUrl).then((result) => {
      if (!cancelled && result.mode !== 'cancelled') setAudioStatusNote(result.statusText);
    });
    return () => { cancelled = true; };
    // Catalog/progress refreshes recreate track objects; only a real selection change should restart audio.
  }, [effectiveStreamUrl, useWebCodecsCanvas, activeAudioId, resolvedAudioTrack?.id, resolvedAudioTrack?.codec,
    resolvedAudioTrack?.source_type, resolvedAudioTrack?.track_index]);

  useEffect(() => {
    if (!effectiveStreamUrl || !showAudioSubMenu) return;
    inspectStreamWithMediabunny(effectiveStreamUrl).then((tracks) => {
      if (tracks.length > 0) {
        setMediabunnyTracks(tracks);
      }
    });
  }, [effectiveStreamUrl, showAudioSubMenu]);

  // HLS initialization for iOS Safari
  useEffect(() => {
    if (!shouldUseHls || !hlsMasterUrl) {
      setUseHls(false);
      setHlsInstance(null);
      return;
    }

    let mounted = true;
    let hls: HlsInstance | null = null;

    const initHls = async () => {
      try {
        const video = videoRef.current;
        if (!video) return;
        // Prefer the built-in HLS engine on iOS; it requires an actual playlist src.
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = hlsMasterUrl;
          setUseHls(true);
          setHlsInstance('native');
          return;
        }
        const HlsClass = await loadHlsJs();
        if (!HlsClass || !mounted) return;

        if (HlsClass.isSupported()) {
          hls = new HlsClass({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 60,
            capLevelToPlayerSize: true,
            maxBufferLength: is4KMedia ? 60 : 30,
            maxMaxBufferLength: is4KMedia ? 120 : 60,
            maxBufferSize: is4KMedia ? 120 * 1000 * 1000 : 60 * 1000 * 1000,
            maxBufferHole: 0.5,
            highBufferWatchdogPeriod: 3,
            nudgeOffset: 0.1,
            nudgeMaxRetry: 3,
            nudgeDelay: 100,
          });

          hls.loadSource(hlsMasterUrl);
          hls.attachMedia(videoRef.current!);
          
          hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
            if (mounted) {
              setHlsInstance(hls);
              setHlsError(null);
              // Capture available quality levels
              const levels = (hls?.levels || []).map((l, i) => ({
                height: l.height,
                width: l.width,
                bitrate: l.bitrate,
                name: l.name || `${l.height}p`,
                index: i,
              }));
              setHlsLevels(levels);
            }
          });

          // Handle level switching for manual quality selection
          if (HlsClass.Events.LEVEL_SWITCHED) {
            hls.on(HlsClass.Events.LEVEL_SWITCHED, (_event: unknown, data: unknown) => {
              if (!mounted) return;
              const levelData = data as { level: number } | undefined;
              if (levelData && hls?.levels) {
                const level = hls.levels[levelData.level];
                if (level) {
                  setCurrentQuality(`${level.height}p`);
                }
              }
            });
          }

          hls.on(HlsClass.Events.ERROR, (_event: unknown, data: unknown) => {
            if (!mounted) return;
            const errorData = data as { fatal: boolean; type: string; details?: string } | undefined;
            if (!errorData?.fatal) return;
            
            switch (errorData.type) {
              case HlsClass.ErrorTypes.NETWORK_ERROR:
                console.warn('HLS network error, attempting recovery...');
                hls?.startLoad();
                break;
              case HlsClass.ErrorTypes.MEDIA_ERROR:
                console.warn('HLS media error, attempting recovery...');
                hls?.recoverMediaError();
                break;
              default:
                if (retryCount < maxRetries) {
                  console.warn(`HLS error, retry ${retryCount + 1}/${maxRetries}`);
                  setRetryCount(c => c + 1);
                  setTimeout(() => {
                    if (hls && mounted) {
                      hls.startLoad();
                    }
                  }, 1000 * (retryCount + 1));
                } else {
                  hls?.destroy();
                  setHlsError('Erro ao carregar stream HLS. Tentando stream direto...');
                  setUseHls(false);
                }
                break;
            }
          });

          if (mounted) {
            setUseHls(true);
          }
        } else if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS support (iOS Safari)
          if (mounted) {
            setUseHls(true);
            setHlsInstance('native');
          }
        } else {
          // No HLS support
          if (mounted) {
            setHlsError('HLS não suportado neste navegador');
            setUseHls(false);
          }
        }
      } catch (error) {
        console.error('HLS initialization failed:', error);
        if (mounted) {
          setHlsError('Falha ao inicializar HLS');
          setUseHls(false);
        }
      }
    };

    initHls();

    return () => {
      mounted = false;
      if (hls && hls.destroy) {
        hls.destroy();
      }
      setHlsInstance(null);
    };
  }, [shouldUseHls, hlsMasterUrl]);

  useEffect(() => {
    const hasDolbyTrack = item.audioTracks.some((a) => /ac3|ec3/i.test((a.codec || '').replace(/[^a-z0-9]/gi, '')));
    if (hasDolbyTrack) {
      void ensureDolbyDecoder().catch(() => {});
    }
  }, [item.audioTracks]);

  useEffect(() => {
    if (!activeSubtitleId || activeSubtitleId === 'off') {
      setSubtitleCues([]);
      setActiveCueText('');
      return;
    }

    const sub = item.subtitleTracks.find((s) => s.id === activeSubtitleId);
    if (!sub) return;

    const cached = getCachedCues(sub.vttUrl);
    if (cached) {
      setSubtitleCues(cached);
      return;
    }

    fetch(sub.vttUrl)
      .then((r) => r.text())
      .then((vttText) => {
        const parsed = parseWebVttCues(vttText);
        setCachedCues(sub.vttUrl, parsed);
        setSubtitleCues(parsed);
      })
      .catch(() => {
        setSubtitleCues([]);
      });
  }, [activeSubtitleId, item.subtitleTracks]);

  // Background prefetch of remaining subtitle tracks 2.5s after video starts so switching subtitles is 0ms
  useEffect(() => {
    if (isBuffering || visibleSubtitleTracks.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const sub of visibleSubtitleTracks.slice(0, 3)) {
        if (!sub.vttUrl || getCachedCues(sub.vttUrl)) continue;
        fetch(sub.vttUrl)
          .then((r) => (r.ok ? r.text() : ''))
          .then((vttText) => {
            if (vttText) {
              setCachedCues(sub.vttUrl, parseWebVttCues(vttText));
            }
          })
          .catch(() => {});
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [isBuffering, visibleSubtitleTracks]);

  useEffect(() => {
    if (subtitleCues.length === 0 || activeSubtitleId === 'off') {
      setActiveCueText('');
      return;
    }
    const adjustedTime = currentTime - subtitleOffsetSec;
    const matching = subtitleCues.filter((c) => adjustedTime >= c.start && adjustedTime <= c.end);
    setActiveCueText(matching.map((m) => m.text).join('\n'));
  }, [currentTime, subtitleCues, subtitleOffsetSec, activeSubtitleId]);

  // Connect to Cloudflare Durable Object WebSocket Room when Watch Party / Remote is opened
  const connectWatchPartyRoom = (codeToJoin: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const cleanCode = codeToJoin.trim().toUpperCase() || 'MINA';
    setRoomCode(cleanCode);

    const ws = new RoomTransport(cleanCode);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(
        JSON.stringify({
          type: 'sync_state',
          roomCode: cleanCode,
          mediaItemId: item.id,
          mediaTitle: item.title,
          playing: videoRef.current ? !videoRef.current.paused : true,
          currentTime: videoRef.current ? videoRef.current.currentTime : 0,
          selectedAudioId: activeAudioId,
          selectedSubtitleId: activeSubtitleId,
          senderName: activeProfile.name,
        })
      );
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data.type === 'participants_update') {
          setPartyParticipants(Number(data.participants || 1));
        } else if (data.type === 'sync_state' && data.payload) {
          const p = data.payload;
          setPartyParticipants(Number(p.participants || 1));
          if (videoRef.current && (!p.mediaItemId || p.mediaItemId === item.id)) {
            suppressSyncBroadcastRef.current = true;
            const elapsed = p.playing && Number.isFinite(p.updatedAt) ? Math.max(0, (Date.now() - p.updatedAt) / 1000) : 0;
            const target = Math.min(Number.isFinite(videoRef.current.duration) ? videoRef.current.duration : 604800, Number(p.currentTime || 0) + elapsed);
            if (Math.abs(videoRef.current.currentTime - target) > 2) {
              videoRef.current.currentTime = target;
            }
            if (p.playing && videoRef.current.paused) {
              videoRef.current.play().catch(() => {});
              setPlaying(true);
            } else if (!p.playing && !videoRef.current.paused) {
              videoRef.current.pause();
              setPlaying(false);
            }
            window.setTimeout(() => {
              suppressSyncBroadcastRef.current = false;
            }, 350);
          }
        } else if (data.type === 'remote_command') {
          if (data.command === 'toggle_play') togglePlay();
          else if (data.command === 'skip_forward') skipSeconds(10);
          else if (data.command === 'skip_back') skipSeconds(-10);
          else if (data.command === 'set_subtitle' && typeof data.value === 'string') {
            setActiveSubtitleId(data.value);
          } else if (data.command === 'set_audio' && typeof data.value === 'string') {
            const tr = item.audioTracks.find((a) => a.id === data.value);
            if (tr) handleSelectAudioTrack(tr);
          }
        } else if (data.type === 'chat') {
          setChatMessages((prev) => [
            ...prev,
            {
              senderName: String(data.senderName || 'Convidado'),
              chatText: String(data.chatText || ''),
              timestamp: String(data.timestamp || ''),
            },
          ]);
        }
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
    };
  };

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const broadcastPartySync = (nextPlaying: boolean, nextTime: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || suppressSyncBroadcastRef.current) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: 'sync_state',
        roomCode,
        mediaItemId: item.id,
        mediaTitle: item.title,
        playing: nextPlaying,
        currentTime: nextTime,
        selectedAudioId: activeAudioId,
        selectedSubtitleId: activeSubtitleId,
        senderName: activeProfile.name,
      })
    );
  };

  const sendRemoteCommand = (command: string, value?: unknown) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'remote_command',
        command,
        value,
        senderName: activeProfile.name,
      })
    );
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'chat',
        senderName: activeProfile.name,
        chatText: chatInput.trim(),
      })
    );
    setChatInput('');
  };

  const isHoveringControlsRef = useRef(false);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (containerRef.current) {
      containerRef.current.classList.remove('hide-cursor');
    }
    if (controlsTimerRef.current) {
      window.clearTimeout(controlsTimerRef.current);
    }
    if (!showAudioSubMenu && !showWatchParty && !showShortcutsHelp && !showQualityDashboard && !showQualityMenu) {
      controlsTimerRef.current = window.setTimeout(() => {
        const isPausedNow = useWebCodecsCanvas
          ? canvasPlayerRef.current?.isPaused() ?? !playing
          : videoRef.current?.paused ?? !playing;
        if ((isMobile || nativeIos || !isPausedNow) && (isMobile || nativeIos || !isHoveringControlsRef.current)) {
          setShowControls(false);
          if (containerRef.current) {
            containerRef.current.classList.add('hide-cursor');
          }
        }
      }, isMobile || nativeIos ? 2000 : 3200);
    }
  }, [playing, showAudioSubMenu, showWatchParty, showShortcutsHelp, showQualityDashboard, showQualityMenu, useWebCodecsCanvas, isMobile, nativeIos]);

  useEffect(() => {
    if (!fullscreenError || !expandedPlayer) return;
    const timer = window.setTimeout(() => setFullscreenError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [fullscreenError, expandedPlayer]);

  useEffect(() => () => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
  }, []);

  useEffect(() => {
    if (!playing && (isMobile || nativeIos)) {
      resetControlsTimer();
    } else if (!playing) {
      setShowControls(true);
      if (containerRef.current) {
        containerRef.current.classList.remove('hide-cursor');
      }
      if (controlsTimerRef.current) {
        window.clearTimeout(controlsTimerRef.current);
      }
    } else if (nativeIos) {
      setShowControls(false);
    } else {
      resetControlsTimer();
    }
  }, [playing, resetControlsTimer]);

  // Mouse and pointer movements immediately reveal controls and cursor (YouTube behavior)
  useEffect(() => {
    const onActivity = () => {
      if(isMobile||nativeIos)return;
      resetControlsTimer();
    };
    window.addEventListener('mousemove', onActivity, { passive: true });
    const onPointerActivity=(event:PointerEvent)=>{if(event.pointerType==='mouse')onActivity();};
    window.addEventListener('pointermove', onPointerActivity, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('pointermove', onPointerActivity);
    };
  }, [resetControlsTimer]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) return;

      const key = e.key.toLowerCase();
      const keyCode = e.keyCode;

      // Smart TV & Remote Control Keycodes (Play/Pause, DPadCenter, Media keys)
      if (
        e.key === ' ' ||
        key === 'k' ||
        key === 'mediaplaypause' ||
        key === 'mediaplay' ||
        key === 'mediapause' ||
        keyCode === 85 ||
        keyCode === 126 ||
        keyCode === 127
      ) {
        e.preventDefault();
        togglePlay();
        showOsdFeedback(!playing ? 'Reproduzindo' : 'Pausado', !playing ? 'play' : 'pause');
      } else if (e.key === 'ArrowRight' || key === 'l' || key === 'mediafastforward' || keyCode === 90 || keyCode === 227) {
        e.preventDefault();
        skipSeconds(10);
      } else if (e.key === 'ArrowLeft' || key === 'j' || key === 'mediarewind' || keyCode === 89 || keyCode === 228) {
        e.preventDefault();
        skipSeconds(-10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        resetControlsTimer();
        const nextVol = Math.min(1, Math.round((volume + 0.05) * 100) / 100);
        handleVolumeSlider(nextVol);
        showOsdFeedback(`Volume: ${Math.round(nextVol * 100)}%`, 'volume');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        resetControlsTimer();
        const nextVol = Math.max(0, Math.round((volume - 0.05) * 100) / 100);
        handleVolumeSlider(nextVol);
        showOsdFeedback(`Volume: ${Math.round(nextVol * 100)}%`, 'volume');
      } else if (key === 'm') {
        e.preventDefault();
        resetControlsTimer();
        toggleMute();
      } else if (key === 'f') {
        e.preventDefault();
        resetControlsTimer();
        void toggleFullscreen();
      } else if (key === 'c') {
        e.preventDefault();
        resetControlsTimer();
        toggleCaptions();
      } else if (key === 'i' || key === 'p') {
        e.preventDefault();
        resetControlsTimer();
        void togglePip();
      } else if (key >= '0' && key <= '9') {
        e.preventDefault();
        resetControlsTimer();
        const fraction = parseInt(key, 10) / 10;
        const target = (duration || 0) * fraction;
        handleSeek(target);
        showOsdFeedback(`${fraction * 100}%`, 'forward');
      } else if (e.key === '>' || (e.shiftKey && e.key === '.')) {
        e.preventDefault();
        resetControlsTimer();
        handleCyclePlaybackRate(1);
      } else if (e.key === '<' || (e.shiftKey && e.key === ',')) {
        e.preventDefault();
        resetControlsTimer();
        handleCyclePlaybackRate(-1);
      } else if (key === 's') {
        e.preventDefault();
        resetControlsTimer();
        setShowAudioSubMenu((s) => !s);
      } else if (key === '?' || key === 'h') {
        e.preventDefault();
        setShowShortcutsHelp((s) => !s);
      } else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack' || keyCode === 4) {
        if (showShortcutsHelp) setShowShortcutsHelp(false);
        else if (showAudioSubMenu) setShowAudioSubMenu(false);
        else if (showWatchParty) setShowWatchParty(false);
        else handleExitPlayer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Media Session API: lock screen, hardware keys, Bluetooth headphones, notifications
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof window === 'undefined') return;

    try {
      const artwork = [];
      if (item.poster_url) {
        artwork.push({ src: item.poster_url, sizes: '512x512', type: 'image/jpeg' });
      }
      if (item.backdrop_url) {
        artwork.push({ src: item.backdrop_url, sizes: '1280x720', type: 'image/jpeg' });
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title,
        artist: item.type === 'series' ? 'Série MinattoFlix' : 'MinattoFlix',
        album: 'MinattoFlix',
        artwork,
      });

      navigator.mediaSession.setActionHandler('play', () => {
        if (!playing) togglePlay();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (playing) togglePlay();
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        skipSeconds(-(details?.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        skipSeconds(details?.seekOffset || 10);
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details?.seekTime !== undefined && details.seekTime !== null) {
          handleSeek(details.seekTime);
        }
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        handleExitPlayer();
      });
    } catch (err) {
      console.warn('MediaSession setup failed:', err);
    }

    return () => {
      try {
        if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
          navigator.mediaSession.setActionHandler('play', null);
          navigator.mediaSession.setActionHandler('pause', null);
          navigator.mediaSession.setActionHandler('seekbackward', null);
          navigator.mediaSession.setActionHandler('seekforward', null);
          navigator.mediaSession.setActionHandler('seekto', null);
          navigator.mediaSession.setActionHandler('stop', null);
        }
      } catch {
        // Ignore
      }
    };
  }, [item.title, item.poster_url, item.backdrop_url, item.type, playing]);

  // Synchronize playback state and position with Media Session API
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      if (duration && Number.isFinite(duration) && duration > 0) {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: playbackRate || 1,
          position: Math.min(Math.max(0, currentTime), duration),
        });
      }
    } catch {
      // Ignore browsers that don't support setPositionState
    }
  }, [playing, currentTime, duration, playbackRate]);

  // Immediate progress persistence when tabbing away, locking screen, or closing tab
  useEffect(() => {
    const saveCurrentProgress = () => {
      const curPos = useWebCodecsCanvas
        ? canvasPlayerRef.current?.getCurrentTime() || 0
        : videoRef.current?.currentTime || 0;
      if (curPos > 3) {
        onSaveProgress({
          mediaItemId: item.id,
          positionSeconds: curPos,
          durationSeconds: videoRef.current?.duration || duration,
          selectedAudioId: activeAudioId,
          selectedSubtitleId: activeSubtitleId,
        }).catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentProgress();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', saveCurrentProgress);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', saveCurrentProgress);
    };
  }, [item.id, activeAudioId, activeSubtitleId, duration, useWebCodecsCanvas, onSaveProgress]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const curPos = useWebCodecsCanvas
        ? canvasPlayerRef.current?.getCurrentTime() || 0
        : videoRef.current?.currentTime || 0;
      const isPausedNow = useWebCodecsCanvas
        ? canvasPlayerRef.current?.isPaused() ?? true
        : videoRef.current?.paused ?? true;
      if (!isPausedNow && curPos > 3) {
        onSaveProgress({
          mediaItemId: item.id,
          positionSeconds: curPos,
          durationSeconds: videoRef.current?.duration || duration,
          selectedAudioId: activeAudioId,
          selectedSubtitleId: activeSubtitleId,
        });
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [item.id, activeAudioId, activeSubtitleId, duration, useWebCodecsCanvas]);

  const togglePlay = () => {
    audioControllerRef.current?.resumeAudioContext();
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      if (canvasPlayerRef.current.isPaused()) {
        canvasPlayerRef.current.play();
        audioControllerRef.current?.notifyClockPlay();
        setPlaying(true);
        broadcastPartySync(true, canvasPlayerRef.current.getCurrentTime());
        // Auto-fullscreen em computadores e celulares ao iniciar reprodução
        if (!isFullscreen) {
          void enterFullscreen();
        }
      } else {
        canvasPlayerRef.current.pause();
        audioControllerRef.current?.notifyClockPause();
        setPlaying(false);
        setShowControls(true);
        broadcastPartySync(false, canvasPlayerRef.current.getCurrentTime());
      }
      return;
    }
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => {
        setPlaying(true);
        broadcastPartySync(true, videoRef.current!.currentTime);
        // Auto-fullscreen em computadores e celulares ao iniciar reprodução
        if (!isFullscreen) {
          void enterFullscreen();
        }
      }).catch(() => {
        setPlaying(false);
        setIsBuffering(false);
        setShowControls(true);
      });
    } else {
      videoRef.current.pause();
      setPlaying(false);
      setShowControls(true);
      broadcastPartySync(false, videoRef.current.currentTime);
    }
  };

  const handleSeek = (next: number) => {
    const target = Math.max(0, Math.min(duration || 7200, next));
    audioControllerRef.current?.resumeAudioContext();
    resetControlsTimer();
    setCurrentTime(target);
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      canvasPlayerRef.current.seek(target);
      audioControllerRef.current?.notifyClockSeek(target);
    } else if (videoRef.current) {
      const v = videoRef.current as HTMLVideoElement & { fastSeek?: (time: number) => void };
      if (typeof v.fastSeek === 'function') {
        try {
          v.fastSeek(target);
        } catch {
          v.currentTime = target;
        }
      } else {
        v.currentTime = target;
      }
    }
    broadcastPartySync(playing, target);
  };

  const skipSeconds = (delta: number) => {
    audioControllerRef.current?.resumeAudioContext();
    resetControlsTimer();
    const cur = useWebCodecsCanvas && canvasPlayerRef.current
      ? canvasPlayerRef.current.getCurrentTime()
      : (videoRef.current?.currentTime || currentTime);
    const next = Math.max(0, Math.min(duration || 7200, cur + delta));
    handleSeek(next);
    showOsdFeedback(delta > 0 ? `+${delta}s` : `${delta}s`, delta > 0 ? 'forward' : 'backward');
  };

  const restartPlayback = () => {
    const player = useWebCodecsCanvas ? canvasPlayerRef.current : videoRef.current;
    if (!player) return;
    audioControllerRef.current?.resumeAudioContext();
    resetControlsTimer();
    if (!isFullscreen) {
      void enterFullscreen();
    }
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      canvasPlayerRef.current.seek(0);
      audioControllerRef.current?.notifyClockSeek(0);
      canvasPlayerRef.current.play();
      audioControllerRef.current?.notifyClockPlay();
      setPlaying(true);
      broadcastPartySync(true, 0);
    } else if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().then(() => {
        setPlaying(true);
        broadcastPartySync(true, 0);
      }).catch(() => {});
    }
    setCurrentTime(0);
    showOsdFeedback('Reiniciando vídeo', 'backward');
    onSaveProgress({
      mediaItemId: item.id,
      positionSeconds: 0,
      durationSeconds: duration,
      selectedAudioId: activeAudioId,
      selectedSubtitleId: activeSubtitleId,
    }).catch((error) => console.warn('Falha ao salvar o reinício do vídeo:', error));
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const nextMuted = !muted;
    audioControllerRef.current?.setOutputVolume(volume, nextMuted);
    setMuted(nextMuted);
    localStorage.setItem('minattoflix_muted', String(nextMuted));
    showOsdFeedback(nextMuted ? 'Mudo ativado' : `Volume: ${Math.round(volume * 100)}%`, 'volume');
  };

  const handleVolumeSlider = (val: number) => {
    if (!videoRef.current) return;
    const clamped = Math.max(0, Math.min(1, val));
    audioControllerRef.current?.setOutputVolume(clamped, clamped === 0);
    setVolume(clamped);
    setMuted(clamped === 0);
    localStorage.setItem('minattoflix_volume', String(clamped));
    localStorage.setItem('minattoflix_muted', String(clamped === 0));
  };

  const toggleCaptions = () => {
    if (activeSubtitleId !== 'off') {
      setActiveSubtitleId('off');
      localStorage.setItem('minattoflix_subtitleId', 'off');
      showOsdFeedback('Legendas desativadas', 'caption');
    } else {
      const firstSub = item.subtitleTracks.find((s) => s.id !== 'off') || item.subtitleTracks[0];
      const targetId = firstSub ? firstSub.id : 'pt';
      setActiveSubtitleId(targetId);
      localStorage.setItem('minattoflix_subtitleId', targetId);
      showOsdFeedback(`Legendas: ${firstSub?.label || 'Ativadas'}`, 'caption');
    }
  };

  const handleVideoClick = (event: React.MouseEvent) => {
    if (isMobile || nativeIos) {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds && (event.clientX < bounds.left + 28 || event.clientX > bounds.right - 28 || event.clientY < bounds.top + 28 || event.clientY > bounds.bottom - 28)) return;
    }
    if (showAudioSubMenu) { setShowAudioSubMenu(false); return; }
    if (showWatchParty) { setShowWatchParty(false); return; }
    if (isMobile || nativeIos) {
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
      if (showControls) setShowControls(false);
      else resetControlsTimer();
      return;
    }

    if (!isMobile) {
      if (clickTimeoutRef.current) {
        window.clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
        void toggleFullscreen();
        return;
      }
      clickTimeoutRef.current = window.setTimeout(() => {
        clickTimeoutRef.current = null;
        togglePlay();
      }, 220);
    } else {
      togglePlay();
    }
  };

  const handleVideoDoubleClick = (e: React.MouseEvent) => {
    if (isMobile || nativeIos) return;
    e.stopPropagation();
    e.preventDefault();
    if (clickTimeoutRef.current) {
      window.clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    void toggleFullscreen();
  };

  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        showOsdFeedback('Picture-in-Picture desativado');
      } else {
        await videoRef.current.requestPictureInPicture();
        showOsdFeedback('Picture-in-Picture ativado');
      }
    } catch {
      // Ignore if PiP unsupported
    }
  };

  const triggerCastOrAirplay = () => {
    const v = videoRef.current as HTMLVideoElement & {
      remote?: { prompt?: () => Promise<void> };
      webkitShowPlaybackTargetPicker?: () => void;
    };
    if (!v) return;
    if (v.remote?.prompt) {
      v.remote.prompt().catch(() => {});
    } else if (v.webkitShowPlaybackTargetPicker) {
      v.webkitShowPlaybackTargetPicker();
    }
  };

  const handleSelectAudioTrack = async (track: AudioTrack) => {
    setActiveAudioId(track.id);

    // "mas em filme postugues deixes por padrão desativada quando reproduzido"
    const isPt = ['pt-br', 'pt', 'por', 'pob'].includes((track.language_code || '').toLowerCase());
    if (isPt) {
      setActiveSubtitleId('off');
    } else {
      const ptSub = candidateSubTracks.find((s) =>
        ['pt-br', 'pt', 'por', 'pob'].includes((s.language_code || '').toLowerCase())
      );
      if (ptSub && activeSubtitleId === 'off') {
        setActiveSubtitleId(ptSub.id);
      }
    }

    if (!audioControllerRef.current) return;
    if (track.source_type === 'embedded' && track.id !== activeAudioId) return;
    setAudioStatusNote('Preparando áudio…');

    const result = await audioControllerRef.current.selectAudioTrack(
      track,
      (newVideoUrl, resumeTime) => {
        setCustomStreamUrl(newVideoUrl);
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.currentTime = resumeTime;
            videoRef.current.play().catch(() => {});
          }
        }, 250);
      },
      effectiveStreamUrl
    );

    if (result.mode !== 'cancelled') setAudioStatusNote(result.statusText);
  };

  const handleAiTranslateSubtitle = async () => {
    if (!selectedFile) return;
    setAiGeneratingSub(true);
    try {
      const res = await requestResponse('/api/ai/translate-subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaFileId: selectedFile.id,
          movieTitle: item.title,
          overview: item.overview,
          sourceSubtitleId: activeSubtitleId !== 'off' ? activeSubtitleId : undefined,
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as SubtitleTrack;
        await onRefreshCatalog();
        setActiveSubtitleId(created.id);
      }
    } catch (error) {
      setAudioStatusNote(error instanceof Error ? error.message : 'Falha ao traduzir legenda.');
    } finally {
      setAiGeneratingSub(false);
    }
  };

  const handleLocalSubtitleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
    const text = await file.text();

    const converted = text.startsWith('WEBVTT')
      ? text
      : `WEBVTT\n\n${text.replace(/\r\n/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
    const parsedCues = parseWebVttCues(converted);
    setSubtitleCues(parsedCues);

    if (selectedFile) {
      const res = await requestResponse('/api/subtitles/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaFileId: selectedFile.id,
          label: `Legenda Enviada — ${file.name}`,
          languageCode: 'pt-BR',
          format: file.name.split('.').pop() || 'srt',
          rawContent: text,
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as SubtitleTrack;
        await onRefreshCatalog();
        setActiveSubtitleId(created.id);
      }
    }
    } catch (error) { setAudioStatusNote(error instanceof Error ? error.message : 'Falha ao enviar legenda.'); }
    finally { e.target.value = ''; }
  };

  const handleToggleDialogueBoost = () => {
    if (!audioControllerRef.current) return;
    const active = audioControllerRef.current.toggleDialogueBoost();
    setDialogueBoost(active);
    setAudioStatusNote(
      active
        ? 'Boost de Diálogo 5.1 (Modo Noturno WebAudio +7.5dB) Ativo'
        : 'Equalização Original Surround 5.1 Ativa'
    );
  };

  const handleCyclePlaybackRate = (step: number = 1) => {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const curIdx = rates.indexOf(playbackRate);
    const nextIdx = curIdx === -1
      ? 2
      : Math.max(0, Math.min(rates.length - 1, (curIdx + step + rates.length) % rates.length));
    const nextRate = rates[nextIdx];
    setPlaybackRate(nextRate);
    localStorage.setItem('minattoflix_playbackRate', String(nextRate));
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      canvasPlayerRef.current.setPlaybackRate(nextRate);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = nextRate;
    }
    showOsdFeedback(`Velocidade: ${nextRate}x`, 'speed');
  };

  const setHlsQuality = (quality: string) => {
    if (!hlsInstance || hlsInstance === 'native' || !Hls?.isSupported()) return;
    const hls = hlsInstance as HlsInstance;
    if (quality === 'auto') {
      if (hls) hls.currentLevel = -1;
      setCurrentQuality('auto');
      return;
    }
    const levelIdx = (hls.levels || []).findIndex(l => `${l.height}p` === quality);
    if (levelIdx >= 0) {
      hls.currentLevel = levelIdx;
      setCurrentQuality(quality);
    }
  };

  const handleRetryStream = () => {
    setRetryCount(0);
    setHlsError(null);
    setStreamError(null);
    if (useWebCodecsCanvas) {
      // Retry WebCodecs
      if (canvasPlayerRef.current) {
        canvasPlayerRef.current.destroy();
        canvasPlayerRef.current = null;
      }
      setUseWebCodecsCanvas(false);
      setTimeout(() => setUseWebCodecsCanvas(true), 50);
    } else if (shouldUseHls) {
      // Retry HLS
      setUseHls(false);
      setTimeout(() => setUseHls(true), 100);
    } else {
      // Retry direct stream
      if (videoRef.current) {
        videoRef.current.load();
        videoRef.current.play().catch(() => {});
      }
    }
  };

  const handleCopyDirectStreamUrl = () => {
    if (!effectiveStreamUrl) return;
    const fullUrl = effectiveStreamUrl.startsWith('http')
      ? effectiveStreamUrl
      : `${window.location.origin}${effectiveStreamUrl}`;
    navigator.clipboard?.writeText(fullUrl).catch(() => {});
    setCopiedStreamUrl(true);
    window.setTimeout(() => setCopiedStreamUrl(false), 2500);
  };

  const handleExitPlayer = () => {
    const pos = useWebCodecsCanvas
      ? canvasPlayerRef.current?.getCurrentTime() || 0
      : videoRef.current?.currentTime || 0;
    if (pos > 2) {
      onSaveProgress({
        mediaItemId: item.id,
        positionSeconds: pos,
        durationSeconds: videoRef.current?.duration || duration,
        selectedAudioId: activeAudioId,
        selectedSubtitleId: activeSubtitleId,
      });
    }
    // Clean up WebSocket if connected
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const nativeVideo = videoRef.current as FullscreenVideo | null;
    if (nativeVideo?.webkitDisplayingFullscreen) nativeVideo.webkitExitFullscreen?.();
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) {
        doc.exitFullscreen().catch(() => {});
      } else if (doc.webkitExitFullscreen) {
        try {
          doc.webkitExitFullscreen();
        } catch {
          // Ignore
        }
      }
    }
    const orientation = (screen as Screen & { orientation?: { unlock?: () => void } }).orientation;
    orientation?.unlock?.();
    setExpandedPlayer(false);
    setIsFullscreen(false);
    onClose();
  };

  const activeAudioObj = item.audioTracks.find((a) => a.id === activeAudioId) || item.audioTracks[0];
  const activeSubObj = item.subtitleTracks.find((s) => s.id === activeSubtitleId);
  const controlsVisible = showControls || showAudioSubMenu || showWatchParty || showShortcutsHelp || showQualityDashboard || showQualityMenu;
  const hideCursor = !controlsVisible;
  const isCover = videoFitMode === 'cover';
  const videoFitClass = isCover ? 'object-cover' : 'object-contain';

  return (
    <MasterClockProvider clock={masterClockRef.current}>
      <div
        ref={containerRef}
        role="dialog" aria-modal="true" aria-label={`Reproduzindo ${item.title}`} tabIndex={-1}
        onMouseMove={()=>{if(!isMobile&&!nativeIos)resetControlsTimer();}}
        onPointerMove={event=>{if(event.pointerType==='mouse'&&!isMobile&&!nativeIos)resetControlsTimer();}}
        onMouseEnter={()=>{if(!isMobile&&!nativeIos)resetControlsTimer();}}
        onTouchStart={() => {
          audioControllerRef.current?.resumeAudioContext();
        }}
        className={`player-shell fixed inset-0 w-full h-full bg-black flex flex-col justify-between select-none overflow-hidden ${hideCursor ? 'hide-cursor cursor-none' : ''} ${expandedPlayer ? 'player-landscape z-[100]' : 'z-50'}`}
      >
      {fullscreenError && <div role="status" className="absolute top-20 left-4 right-4 z-[60] rounded bg-black/90 p-3 text-center text-sm text-white">{fullscreenError}</div>}
      {streamError && <div role="alert" className="absolute inset-0 z-[80] bg-black/95 flex items-center justify-center p-6"><div className="max-w-md text-center space-y-4"><h2 className="text-xl font-bold">Não foi possível reproduzir este filme</h2><p className="text-zinc-300">Confira sua conexão e tente novamente. Se o problema continuar, escolha outra versão do filme.</p><button className="bg-white text-black rounded-lg px-5 py-3 font-semibold" onClick={handleRetryStream}>Tentar novamente</button>{item.files.filter(file=>file.id!==selectedFile?.id).map((file,index)=><button key={file.id} className="block w-full rounded-lg bg-zinc-800 p-3" onClick={()=>{setSelectedFile(file);setStreamError(null);setIsBuffering(true);}}>Tentar versão {index+1}</button>)}<button className="block w-full p-3" onClick={handleExitPlayer}>Voltar ao catálogo</button><details className="text-sm text-zinc-400"><summary>Detalhes do problema</summary><p className="mt-2 break-words">{streamError}</p></details></div></div>}

      {/* On-Screen Display (OSD) feedback badge */}
      {osdMessage && (
        <div
          key={osdMessage.id}
          className="pointer-events-none absolute inset-0 flex items-center justify-center z-40 animate-fadeIn"
        >
          <div className="bg-black/85 backdrop-blur-md border border-zinc-700/70 text-white px-5 py-3 rounded-2xl flex items-center gap-3 shadow-[0_12px_40px_rgba(0,0,0,0.85)] text-sm sm:text-base md:text-lg font-bold tracking-wide">
            {osdMessage.icon === 'forward' && <RotateCw className="w-5 h-5 sm:w-6 sm:h-6 text-[#E50914]" />}
            {osdMessage.icon === 'backward' && <RotateCcw className="w-5 h-5 sm:w-6 sm:h-6 text-[#E50914]" />}
            {osdMessage.icon === 'volume' && <Volume2 className="w-5 h-5 sm:w-6 sm:h-6 text-white" />}
            {osdMessage.icon === 'caption' && <Subtitles className="w-5 h-5 sm:w-6 sm:h-6 text-white" />}
            {osdMessage.icon === 'play' && <Play className="w-5 h-5 sm:w-6 sm:h-6 fill-white" />}
            {osdMessage.icon === 'pause' && <Pause className="w-5 h-5 sm:w-6 sm:h-6 fill-white" />}
            <span>{osdMessage.text}</span>
          </div>
        </div>
      )}

      {/* HTML5 Video Element or iOS/Safari WebCodecs MKV Canvas Engine */}
      {effectiveStreamUrl ? (
        <>
          <canvas
            ref={canvasRef}
            onMouseMove={()=>{if(!isMobile&&!nativeIos)resetControlsTimer();}}
            onPointerMove={event=>{if(event.pointerType==='mouse'&&!isMobile&&!nativeIos)resetControlsTimer();}}
            onClick={handleVideoClick}
            onDoubleClick={handleVideoDoubleClick}
            className={`absolute inset-0 w-full h-full ${videoFitClass} bg-black ${hideCursor ? 'cursor-none' : 'cursor-pointer'} ${
              useWebCodecsCanvas ? 'block' : 'hidden'
            }`}
          />
          <video
            ref={videoRef}
            src={useWebCodecsCanvas || shouldUseHls ? undefined : effectiveStreamUrl}
            preload="auto"
            autoPlay={!useWebCodecsCanvas && (nativeIos || !isIosWebKit())}
            playsInline
            crossOrigin="anonymous"
            onMouseMove={()=>{if(!isMobile&&!nativeIos)resetControlsTimer();}}
            onPointerMove={event=>{if(event.pointerType==='mouse'&&!isMobile&&!nativeIos)resetControlsTimer();}}
            onClick={handleVideoClick}
            onDoubleClick={handleVideoDoubleClick}
            onPlay={() => {
              if (!useWebCodecsCanvas) setPlaying(true);
              if (!isFullscreen) {
                void enterFullscreen();
              }
            }}
            onPause={() => {
              if (useWebCodecsCanvas) return;
              setPlaying(false);
              setShowControls(true);
            }}
            onPlaying={() => { metricsRef.current?.('start'); }}
            onLoadedMetadata={(e) => {
              if (useWebCodecsCanvas) return;
              const v = e.currentTarget;
              if (v.duration && Number.isFinite(v.duration)) {
                setDuration(v.duration);
              }
              if (!item.progress?.is_completed && item.progress?.position_seconds && item.progress.position_seconds > 5 && v.currentTime < 3) {
                v.currentTime = item.progress.position_seconds;
              }
              setIsBuffering(false);
              if (v.paused && (nativeIos || !isIosWebKit())) {
                v.play().catch(() => { setPlaying(false); setShowControls(true); });
              }
              // Auto-fullscreen em computadores e celulares quando o vídeo inicia
              if (!isFullscreen && !v.paused) {
                void enterFullscreen();
              }
            }}
            onWaiting={() => {
              metricsRef.current?.('waiting');
              if (!useWebCodecsCanvas) setIsBuffering(true);
            }}
            onCanPlay={() => {
              if (!useWebCodecsCanvas) {
                setIsBuffering(false);
                setStreamError(null);
              }
            }}
            onTimeUpdate={(e) => {
              if (useWebCodecsCanvas) return;
              const v = e.currentTarget;
              setCurrentTime(v.currentTime);
              if (v.buffered.length > 0) {
                setBufferedEnd(v.buffered.end(v.buffered.length - 1));
              }
              // Auto-next episode: trigger countdown 30s before end
              const episodeId = (item as unknown as { episode_id?: string }).episode_id;
              if (v.duration && v.currentTime >= v.duration - 30 && !showNextEpisodeCountdown && episodeId) {
                // Fetch next episode
                fetch(apiUrl(`/api/media/next-episode/${episodeId}`))
                  .then(r => r.ok ? r.json() : null)
                  .then(next => {
                    if (next) {
                      setNextEpisodeItem(next);
                      setShowNextEpisodeCountdown(true);
                      let count = 10;
                      setNextEpisodeCountdown(count);
                      const interval = setInterval(() => {
                        count--;
                        setNextEpisodeCountdown(count);
                        if (count <= 0) {
                          clearInterval(interval);
                          setShowNextEpisodeCountdown(false);
                          // Navigate to next episode
                          window.location.href = `/?play=${next.id}`;
                        }
                      }, 1000);
                    }
                  })
                  .catch(() => {});
              }
            }}
            onEnded={() => {
              metricsRef.current?.('ended');
              if (useWebCodecsCanvas) return;
              // If we have a next episode queued, navigate immediately
              if (nextEpisodeItem) {
                window.location.href = `/?play=${nextEpisodeItem.id}`;
              }
            }}
            onError={() => {
              metricsRef.current?.('error');
              if (useWebCodecsCanvas) return;
              // If using HLS and it fails, try direct stream
              if (shouldUseHls && !hlsError) {
                setHlsError('HLS falhou');
                setUseHls(false);
                setAudioStatusNote('HLS falhou, tentando stream direto...');
                return;
              }
              // Automatic Failover: switch to alternate mirror automatically in the background
              if (selectedFile) failedFilesRef.current.add(selectedFile.id);
              const alternateMirror = item.files.find((f) => !failedFilesRef.current.has(f.id));
              if (alternateMirror && !customStreamUrl) {
                setSelectedFile(alternateMirror);
                setUseWebCodecsCanvas(isIosWebKit() &&
                  (/^mkv$/i.test(alternateMirror.container || '') || /\.mkv$/i.test(alternateMirror.filename || '')));
                setAudioStatusNote('Reconectando stream automaticamente...');
                return;
              }
              // Fallback to WebCodecs + WASM MKV Canvas Engine (for iOS Chrome/Safari & macOS Safari, NOT Smart TV)
              if (!isTvOrAndroidNative() && typeof window !== 'undefined' && 'VideoDecoder' in window) {
                setUseWebCodecsCanvas(true);
                setAudioStatusNote('Motor WebCodecs + WASM MKV ativado (Compatibilidade iOS / Safari)');
                return;
              }
              setIsBuffering(false);
              setStreamError(
                'O arquivo .MKV usa codec HEVC/Dolby exclusivo ou está concluindo sincronização.'
              );
            }}
            className={`absolute inset-0 w-full h-full ${videoFitClass} bg-black ${hideCursor ? 'cursor-none' : 'cursor-pointer'} ${
              useWebCodecsCanvas ? 'hidden' : 'block'
            }`}
          />
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center safe-top safe-bottom">
          <AlertTriangle className="w-14 h-14 text-amber-400 mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">
            Arquivo de vídeo ainda sendo sincronizado
          </h2>
          <p className="text-sm text-zinc-400 max-w-md mb-6">
            O título <strong>{item.title}</strong> já foi detectado e será publicado automaticamente assim que o
            processamento do arquivo concluir!
          </p>
          <button
            onClick={handleExitPlayer}
            className="bg-[#E50914] text-white font-bold px-6 py-2.5 rounded cursor-pointer touch-target tap-highlight"
          >
            Voltar ao Catálogo
          </button>
        </div>
      )}

      {audioStatusNote.startsWith('Áudio indisponível') && (
        <div role="alert" className="absolute top-24 inset-x-6 z-30 bg-amber-950/90 text-amber-100 rounded px-4 py-3 text-sm safe-top">
          {audioStatusNote}
        </div>
      )}

      {/* Custom Netflix Subtitle Overlay */}
      {activeCueText && activeSubtitleId !== 'off' && (
        <div className="player-subtitles pointer-events-none absolute inset-x-0 bottom-24 sm:bottom-28 md:bottom-32 flex justify-center px-4 sm:px-6 z-20 safe-left safe-right">
          <div
            className={`
              whitespace-pre-line leading-snug
              ${subtitleFont === 'inter' ? 'font-inter' : subtitleFont === 'roboto' ? 'font-roboto' : ''}
              ${subtitleStyle === 'netflix' ? 'bg-black/75 text-white px-3 sm:px-4 py-1 sm:py-1.5 rounded shadow-[0_4px_16px_rgba(0,0,0,0.95)]' : ''}
              ${subtitleStyle === 'disney' ? 'bg-black/85 text-white px-4 py-2 rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.95)]' : ''}
              ${subtitleStyle === 'crunchyroll' ? 'bg-amber-900/95 text-amber-50 px-4 py-2 rounded-xl shadow-[0_8px_24px_rgba(217,119,6,0.5)] font-medium' : ''}
              ${subtitleStyle === 'custom' ? `
                ${subtitleBackground === 'none' ? 'bg-transparent' : subtitleBackground === 'semi' ? 'bg-black/75' : 'bg-black'}
                ${subtitleEdge === 'none' ? '' : subtitleEdge === 'outline' ? 'outline outline-2 outline-white' : 'drop-shadow-[0_0_4px_rgba(0,0,0,1)] drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]'}
                px-3 sm:px-4 py-1 sm:py-1.5 rounded
              ` : ''}
              ${subtitleSize === 'sm' ? 'text-xs sm:text-sm md:text-base' : ''}
              ${subtitleSize === 'md' ? 'text-sm sm:text-base md:text-2xl' : ''}
              ${subtitleSize === 'lg' ? 'text-lg sm:text-xl md:text-3xl' : ''}
            `}
          >
            {activeCueText}
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Help Overlay */}
      {showShortcutsHelp && (
        <div className="absolute inset-0 z-40 bg-black/95 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-zinc-900/95 border border-zinc-700 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.95)] max-w-2xl w-full max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-zinc-700">
              <h2 className="text-lg font-bold text-white">Atalhos do Teclado</h2>
              <button
                onClick={() => setShowShortcutsHelp(false)}
                className="text-zinc-400 hover:text-white transition"
                aria-label="Fechar ajuda"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">Espaço / K</kbd>
                  <span className="text-zinc-300">Play / Pausa</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">← / → / J / L</kbd>
                  <span className="text-zinc-300">Voltar / Avançar 10s</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">F / 2x Clique</kbd>
                  <span className="text-zinc-300">Tela Cheia</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">M</kbd>
                  <span className="text-zinc-300">Mudo</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">↑ / ↓</kbd>
                  <span className="text-zinc-300">Volume (±5%)</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">0 - 9</kbd>
                  <span className="text-zinc-300">Pular para 0% - 90%</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">&lt; / &gt;</kbd>
                  <span className="text-zinc-300">Velocidade (0.5x - 2x)</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">C</kbd>
                  <span className="text-zinc-300">Legendas On/Off</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">I / P</kbd>
                  <span className="text-zinc-300">Picture-in-Picture</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">S</kbd>
                  <span className="text-zinc-300">Áudio e Legendas</span>
                </div>
                <div className="flex items-center gap-3 p-2 bg-zinc-800/50 rounded">
                  <kbd className="px-2 py-1 bg-zinc-700 rounded text-xs font-mono text-white min-w-[60px] text-center">?</kbd>
                  <span className="text-zinc-300">Esta Ajuda</span>
                </div>
              </div>
              <div className="pt-2 border-t border-zinc-700">
                <p className="text-xs text-zinc-500 text-center">
                  Dica: Duplo clique no vídeo alterna tela cheia. Media Session ativo para teclas de mídia e fones Bluetooth.<br />
                  No mobile: Toque duplo para avançar/voltar 10s, deslize na direita para volume e esquerda para brilho.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Next Episode Countdown Overlay */}
      {showNextEpisodeCountdown && nextEpisodeItem && (
        <div className="absolute bottom-20 left-4 right-4 md:left-auto md:right-4 md:w-96 z-30 animate-fadeIn safe-bottom">
          <div className="bg-black/95 border border-[#E50914] rounded-xl shadow-2xl p-4 sm:p-6 flex flex-col items-center text-center">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-[#E50914] uppercase tracking-wide">Próximo Episódio</span>
              <span className="text-xs text-zinc-400">inicia em</span>
            </div>
            <div className="text-4xl sm:text-5xl font-bold font-mono text-white mb-2">
              {nextEpisodeCountdown}s
            </div>
            <h3 className="text-sm sm:text-base font-semibold text-white truncate max-w-full mb-1">
              {nextEpisodeItem.title}
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Ep. {(nextEpisodeItem as unknown as { episode_number?: number }).episode_number || '?'} • {(nextEpisodeItem as unknown as { season_number?: number }).season_number ? `Temporada ${(nextEpisodeItem as unknown as { season_number?: number }).season_number}` : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  window.location.href = `/?play=${nextEpisodeItem.id}`;
                }}
                className="flex-1 bg-[#E50914] text-white font-bold py-2 px-4 rounded transition hover:bg-[#b80710]"
              >
                Assistir Agora
              </button>
              <button
                onClick={() => setShowNextEpisodeCountdown(false)}
                className="flex-1 bg-zinc-800 text-zinc-300 font-bold py-2 px-4 rounded transition hover:bg-zinc-700"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Netflix Authentic "Pular Abertura" (Skip Intro) Floating Button */}
      {introEligible && !introDismissed && !showAudioSubMenu && !showWatchParty && (
        <div className="player-skip-intro absolute bottom-24 sm:bottom-28 right-4 md:right-12 z-30 animate-fadeIn safe-right safe-bottom">
          <button
            onClick={() => {
              if (typeof introEnd === 'number') handleSeek(introEnd);
            }}
            className="bg-black/75 hover:bg-white hover:text-black text-white border-2 border-white/80 font-bold text-xs md:text-sm px-4 sm:px-5 py-2 sm:py-2.5 rounded shadow-2xl transition tracking-wide uppercase cursor-pointer touch-target tap-highlight"
          >
            Pular Abertura
          </button>
        </div>
      )}

      {/* Skip Outro Button (appears near end) */}
      {playing && !showAudioSubMenu && !showWatchParty && typeof item.credits_start_seconds === 'number'
        && item.credits_start_seconds > currentTime && item.credits_start_seconds < duration
        && currentTime >= item.credits_start_seconds - 10 && (
        <div className="player-skip-outro absolute bottom-24 sm:bottom-28 left-4 md:left-12 z-30 animate-fadeIn safe-left safe-bottom">
          <button
            onClick={() => {
              if (typeof item.credits_start_seconds === 'number') handleSeek(item.credits_start_seconds);
            }}
            className="bg-black/75 hover:bg-white hover:text-black text-white border-2 border-white/80 font-bold text-xs md:text-sm px-4 sm:px-5 py-2 sm:py-2.5 rounded shadow-2xl transition tracking-wide uppercase cursor-pointer touch-target tap-highlight"
          >
            Pular Créditos
          </button>
        </div>
      )}

      {controlsVisible && !isBuffering && !streamError && <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-8">
        <button aria-label="Voltar dez segundos" onClick={()=>skipSeconds(-10)} className="pointer-events-auto rounded-full bg-black/50 w-14 h-14 flex items-center justify-center"><RotateCcw size={28}/><span className="sr-only">Voltar 10 segundos</span></button>
        <button aria-label={playing?'Pausar':'Reproduzir'} onClick={togglePlay} className="pointer-events-auto rounded-full bg-black/50 w-20 h-20 flex items-center justify-center">{playing?<Pause size={40}/>:<Play size={40}/>}</button>
        <button aria-label="Avançar dez segundos" onClick={()=>skipSeconds(10)} className="pointer-events-auto rounded-full bg-black/50 w-14 h-14 flex items-center justify-center"><RotateCw size={28}/></button>
      </div>}

      {/* Netflix Red Loading Spinner */}
      {isBuffering && effectiveStreamUrl && !streamError && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center z-20 px-4 text-center safe-top safe-bottom">
          <div className="w-12 h-12 sm:w-16 sm:h-16 border-4 border-[#E50914] border-t-transparent rounded-full animate-spin" />
          <span className="mt-3 text-[11px] sm:text-xs font-semibold tracking-wider text-zinc-300 uppercase">
            Carregando transmissão em alta definição...
          </span>
        </div>
      )}

      {/* Top Overlay Bar */}
      <div
        onPointerEnter={(event) => {
          isHoveringControlsRef.current = event.pointerType === 'mouse' && !isMobile;
          if(event.pointerType==='mouse'&&!isMobile&&!nativeIos)setShowControls(true);
        }}
        onPointerLeave={() => {
          isHoveringControlsRef.current = false;
          if(!isMobile&&!nativeIos)resetControlsTimer();
        }}
        className={`player-top-bar absolute top-0 inset-x-0 z-30 bg-gradient-to-b from-black/90 via-black/40 to-transparent p-3 sm:p-4 md:p-8 flex items-center justify-between gap-2 sm:gap-4 transition-opacity duration-300 safe-top safe-left safe-right ${
          controlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-2.5 sm:gap-4 min-w-0 flex-1">
          <button
            onClick={handleExitPlayer}
            className="w-10 h-10 sm:w-11 sm:h-11 shrink-0 rounded-full bg-black/50 hover:bg-white/20 flex items-center justify-center text-white transition cursor-pointer touch-target-sm tap-highlight"
            title="Voltar ao catálogo (Esc)"
          >
            <ArrowLeft className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-lg md:text-2xl font-bold text-white truncate">{item.title}</h1>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] sm:text-xs text-zinc-300 line-clamp-1">
              <span>{selectedFile?.resolution || '1080p'}</span>
              <span>•</span>
              <span className="text-[#46D369] font-semibold truncate max-w-[160px] sm:max-w-none">
                {activeAudioObj?.label || 'Áudio a verificar'}
              </span>
              {activeSubObj && activeSubtitleId !== 'off' && (
                <span className="hidden sm:inline">
                  • Legenda: {activeSubObj.label}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right Top: Quick Player Actions (Fullscreen & Audio/Subtitles) */}
        {!isMobile && !nativeIos && <div className="flex items-center gap-1.5 sm:gap-2 text-xs shrink-0">
          {wsConnected && (
            <span className="hidden md:flex bg-[#E50914]/25 border border-[#E50914] text-white px-2.5 py-1 rounded items-center gap-1.5 font-semibold">
              <Users className="w-3.5 h-3.5 text-[#E50914]" />
              Sala {roomCode} ({partyParticipants})
            </span>
          )}

          <button
            type="button"
            onClick={() => {
              setShowAudioSubMenu((s) => !s);
              setShowWatchParty(false);
            }}
            className="bg-black/60 hover:bg-zinc-800 border border-zinc-600 text-white px-2.5 sm:px-3 py-1.5 rounded flex items-center gap-1.5 font-semibold transition cursor-pointer touch-target-sm tap-highlight"
            aria-label="Áudio e Legendas"
            aria-expanded={showAudioSubMenu}
            title="Opções de Áudio e Legendas"
          >
            <Languages className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline">Áudio e Legendas</span>
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="bg-black/60 hover:bg-[#E50914] border border-zinc-600 hover:border-[#E50914] text-white px-2.5 sm:px-3 py-1.5 rounded flex items-center gap-1.5 font-semibold transition cursor-pointer touch-target-sm tap-highlight"
            aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            title="Alternar Tela Cheia (F)"
          >
            {isFullscreen ? (
              <>
                <Minimize className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">Sair da Tela Cheia</span>
              </>
            ) : (
              <>
                <Maximize className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">Tela Cheia</span>
              </>
            )}
          </button>
        </div>}
      </div>

      {/* Cloudflare Durable Objects Watch Party & Smartphone TV Remote Drawer */}
      {showWatchParty && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="player-options absolute bottom-20 sm:bottom-24 left-3 right-3 sm:left-auto sm:right-4 md:right-12 z-40 sm:w-[92vw] max-w-md max-h-[calc(100dvh-6.5rem)] overflow-y-auto bg-[#181818]/98 border border-zinc-700 rounded-xl shadow-2xl p-4 sm:p-5 text-white space-y-4 animate-fadeIn mx-auto sm:mx-0"
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-3">
            <div className="flex items-center gap-2 min-w-0">
              <Users className="w-5 h-5 text-[#E50914] shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold truncate">Watch Party & Controle Remoto TV</h3>
                <p className="text-[11px] text-zinc-400 truncate">
                  Sala compartilhada · atualizações a cada 5 segundos
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  wsConnected ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                {wsConnected ? `● Sala ${roomCode} (${partyParticipants})` : 'Off'}
              </span>
              <button
                type="button"
                aria-label="Fechar Watch Party"
                onClick={() => setShowWatchParty(false)}
                className="touch-target w-11 h-11 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-zinc-300 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Join / Create Room */}
          <div className="flex items-center gap-2 text-xs">
            <input
              type="text"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="Código da Sala (Ex: MINA)"
              maxLength={8}
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-white font-mono uppercase w-28 sm:w-36 outline-none"
            />
            <button
              onClick={() => connectWatchPartyRoom(roomCode)}
              className="flex-1 bg-[#E50914] hover:bg-[#b80710] text-white font-bold py-2.5 px-3 rounded transition cursor-pointer"
            >
              {wsConnected ? 'Reconectar Sala' : 'Conectar Sala / TV'}
            </button>
          </div>

          {/* TV Remote Quick Buttons (Control TV from Phone) */}
          {wsConnected && (
            <div className="bg-zinc-900/90 border border-zinc-800 rounded-lg p-3 space-y-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-300">
                <Smartphone className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                <span>Comandos Remotos Sincronizados (TV & Celular)</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button
                  onClick={() => sendRemoteCommand('skip_back')}
                  className="bg-zinc-800 hover:bg-zinc-700 py-2 rounded font-semibold cursor-pointer"
                >
                  ⏪ -10s TV
                </button>
                <button
                  onClick={() => sendRemoteCommand('toggle_play')}
                  className="bg-[#E50914] hover:bg-[#b80710] py-2 rounded font-bold cursor-pointer"
                >
                  ⏯ Play/Pause
                </button>
                <button
                  onClick={() => sendRemoteCommand('skip_forward')}
                  className="bg-zinc-800 hover:bg-zinc-700 py-2 rounded font-semibold cursor-pointer"
                >
                  ⏩ +10s TV
                </button>
              </div>
            </div>
          )}

          {/* Live Chat */}
          {wsConnected && (
            <div className="space-y-2">
              <div className="h-24 sm:h-28 overflow-y-auto bg-black/50 border border-zinc-800 rounded p-2.5 text-xs space-y-1.5">
                {chatMessages.length === 0 ? (
                  <p className="text-zinc-500 text-center py-4 sm:py-6">
                    Abra a mesma sala <strong>{roomCode}</strong> em outro dispositivo para assistir junto
                    ou controlar a TV!
                  </p>
                ) : (
                  chatMessages.map((m, i) => (
                    <div key={i}>
                      <span className="font-bold text-[#E50914]">{m.senderName}: </span>
                      <span className="text-zinc-200">{m.chatText}</span>
                      <span className="text-[10px] text-zinc-500 ml-1.5">{m.timestamp}</span>
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={handleSendChat} className="flex items-center gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Enviar mensagem na sala..."
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-white outline-none"
                />
                <button
                  type="submit"
                  className="bg-zinc-800 hover:bg-zinc-700 p-2.5 rounded text-white cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Netflix 2-Column Audio & Subtitles Popover Menu */}
      {showAudioSubMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="player-options absolute bottom-20 sm:bottom-24 left-3 right-3 sm:left-auto sm:right-4 md:right-12 z-40 sm:w-[92vw] max-w-2xl max-h-[calc(100dvh-6.5rem)] overflow-y-auto bg-[#181818]/98 border border-zinc-700 rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.95)] p-4 sm:p-6 text-white animate-fadeIn mx-auto sm:mx-0"
        >
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 sm:hidden">
            <span className="text-sm font-bold text-white">Opções de Áudio e Legendas</span>
            <button
              type="button"
              aria-label="Fechar menu de áudio e legendas"
              onClick={() => setShowAudioSubMenu(false)}
              className="touch-target w-11 h-11 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-zinc-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6">
            {/* Column 1: Áudio */}
            <div className="flex flex-col justify-between">
              <div>
                <h3 className="text-sm sm:text-base font-bold text-white mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span>Áudio</span>
                  <button
                    onClick={handleToggleDialogueBoost}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded border transition cursor-pointer ${
                      dialogueBoost
                        ? 'bg-emerald-600/30 border-emerald-500 text-emerald-200'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:text-white'
                    }`}
                    title="Realça frequências de voz (2.2 kHz +7.5dB) e comprime explosões para áudio 5.1 em caixas estéreo"
                  >
                    {dialogueBoost ? '🔊 Boost Voz 5.1: ON' : '🔈 Boost Voz 5.1: OFF'}
                  </button>
                </h3>
                <p className="text-[11px] text-zinc-400 mb-2.5">{audioStatusNote}</p>

                {/* Audio Sync Offset Slider */}
                <div className="mb-2.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-300 mb-1">
                    <span>Sincronia de Áudio</span>
                    <span className="font-mono text-white">
                      {audioOffsetSec >= 0 ? '+' : ''}{audioOffsetSec.toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-0.5"
                    max="0.5"
                    step="0.05"
                    value={audioOffsetSec}
                    onChange={(e) => setAudioOffsetSec(Number(e.target.value))}
                    className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-[#E50914]"
                    title="Ajuste fino de sincronização de áudio (±500ms). Positivo = áudio adiantado, Negativo = áudio atrasado"
                  />
                </div>

                <div className="space-y-1.5 max-h-40 sm:max-h-48 overflow-y-auto pr-1">
                  {visibleAudioTracks.map((track) => {
                    const isSelected = activeAudioId === track.id;
                    return (
                      <button
                        key={track.id}
                        onClick={() => {
                          handleSelectAudioTrack(track);
                          sendRemoteCommand('set_audio', track.id);
                        }}
                        className={`w-full text-left px-3 py-2 rounded flex items-center justify-between text-xs sm:text-sm transition cursor-pointer ${
                          isSelected
                            ? 'bg-white/15 text-white font-bold'
                            : 'text-zinc-300 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isSelected ? (
                            <Check className="w-4 h-4 text-[#E50914] shrink-0" />
                          ) : (
                            <span className="w-4 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate">{track.label}</div>
                            <div className="text-[10px] text-zinc-400 truncate">
                              {track.source_type === 'embedded'
                                ? `Faixa Embutida no .MKV (#${track.track_index + 1} • ${track.codec || 'EAC3'})`
                                : track.source_type === 'alternate_video'
                                  ? 'Stream de Vídeo Separado'
                                  : 'Arquivo de Áudio Separado'}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Direct Hardware Stream for VLC / PotPlayer / Smart TV (Dolby EAC3 5.1 Passthrough) */}
              {effectiveStreamUrl && (
                <div className="mt-3 sm:mt-4 pt-3 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <a
                    href={(() => {
                      const fullUrl = effectiveStreamUrl.startsWith('http')
                        ? effectiveStreamUrl
                        : `${window.location.origin}${effectiveStreamUrl}`;
                      return isIosWebKit()
                        ? `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(fullUrl)}`
                        : `vlc://${fullUrl.replace(/^https?:\/\//i, '')}`;
                    })()}
                    onClick={() => handleCopyDirectStreamUrl()}
                    className="flex-1 bg-amber-600/25 hover:bg-amber-600/40 border border-amber-500/60 text-amber-200 font-semibold py-2 px-2.5 rounded text-center transition whitespace-nowrap"
                    title="Abre o stream HTTP 206 direto no VLC (e copia a URL para a área de transferência)"
                  >
                    🎬 Abrir no VLC (5.1)
                  </a>
                  <button
                    onClick={handleCopyDirectStreamUrl}
                    className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold py-2 px-2.5 rounded transition cursor-pointer whitespace-nowrap"
                    title="Copia o link direto HTTP 206 Range para colar na Smart TV, IINA, PotPlayer ou Kodi"
                  >
                    {copiedStreamUrl ? '✓ Link Copiado!' : 'Copiar URL Stream'}
                  </button>
                </div>
              )}
            </div>

            {/* Column 2: Legendas + Cloudflare Workers AI + R2 */}
            <div className="border-t sm:border-t-0 sm:border-l border-zinc-800 pt-4 sm:pt-0 sm:pl-6 flex flex-col justify-between">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                  <h3 className="text-sm sm:text-base font-bold text-white">Legendas</h3>
                  <div className="flex items-center gap-1.5">


                    <label className="text-[11px] bg-[#E50914] hover:bg-[#b80710] text-white font-semibold px-2.5 py-1 rounded flex items-center gap-1 cursor-pointer">
                      <Upload className="w-3 h-3" />
                      <span>.SRT/.VTT</span>
                      <input
                        type="file"
                        accept=".srt,.vtt,.ass,.ssa"
                        onChange={handleLocalSubtitleUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-36 sm:max-h-44 overflow-y-auto pr-1">
                  <button
                    onClick={() => {
                      setActiveSubtitleId('off');
                      sendRemoteCommand('set_subtitle', 'off');
                    }}
                    className={`w-full text-left px-3 py-2 rounded flex items-center gap-2.5 text-xs sm:text-sm transition cursor-pointer ${
                      activeSubtitleId === 'off'
                        ? 'bg-white/15 text-white font-bold'
                        : 'text-zinc-300 hover:bg-white/5'
                    }`}
                  >
                    {activeSubtitleId === 'off' ? (
                      <Check className="w-4 h-4 text-[#E50914] shrink-0" />
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span>Desativada</span>
                  </button>

                  {visibleSubtitleTracks.map((sub) => {
                    const isSelected = activeSubtitleId === sub.id;
                    return (
                      <button
                        key={sub.id}
                        onClick={() => {
                          setActiveSubtitleId(sub.id);
                          sendRemoteCommand('set_subtitle', sub.id);
                        }}
                        className={`w-full text-left px-3 py-2 rounded flex items-center gap-2.5 text-xs sm:text-sm transition cursor-pointer ${
                          isSelected
                            ? 'bg-white/15 text-white font-bold'
                            : 'text-zinc-300 hover:bg-white/5'
                        }`}
                      >
                        {isSelected ? (
                          <Check className="w-4 h-4 text-[#E50914] shrink-0" />
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate">{sub.label}</div>
                          <div className="text-[10px] text-zinc-400 truncate">
                            {sub.source_type === 'embedded'
                              ? 'Extraída do .MKV (Cloudflare R2 Cache)'
                              : 'WebVTT (Cloudflare R2 + Neon)'}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Subtitle Styling Presets */}
              <div className="mt-3 sm:mt-4 pt-3 border-t border-zinc-800">
                <div className="flex items-center gap-2 mb-2">
                  <Sliders className="w-4 h-4 text-[#E50914] shrink-0" />
                  <span className="text-xs font-semibold text-zinc-300">Estilo da Legenda</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(['netflix', 'disney', 'crunchyroll', 'custom'] as const).map((style) => (
                    <button
                      key={style}
                      onClick={() => setSubtitleStyle(style)}
                      className={`px-2.5 py-1.5 rounded text-[10px] font-bold cursor-pointer transition ${
                        subtitleStyle === style ? 'bg-[#E50914] text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                      }`}
                    >
                      {style.charAt(0).toUpperCase() + style.slice(1)}
                    </button>
                  ))}
                </div>
                
                {subtitleStyle === 'custom' && (
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-zinc-400 w-16 shrink-0">Fonte:</span>
                      {(['inter', 'roboto', 'system'] as const).map((font) => (
                        <button
                          key={font}
                          onClick={() => setSubtitleFont(font)}
                          className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                            subtitleFont === font ? 'bg-[#E50914] text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                          }`}
                        >
                          {font.charAt(0).toUpperCase() + font.slice(1)}
                        </button>
                      ))}
                    </div>
                    
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-zinc-400 w-16 shrink-0">Fundo:</span>
                      {(['none', 'semi', 'full'] as const).map((bg) => (
                        <button
                          key={bg}
                          onClick={() => setSubtitleBackground(bg)}
                          className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                            subtitleBackground === bg ? 'bg-[#E50914] text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                          }`}
                        >
                          {bg === 'none' ? 'Sem' : bg === 'semi' ? 'Semi' : 'Total'}
                        </button>
                      ))}
                    </div>
                    
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-zinc-400 w-16 shrink-0">Borda:</span>
                      {(['none', 'outline', 'shadow'] as const).map((edge) => (
                        <button
                          key={edge}
                          onClick={() => setSubtitleEdge(edge)}
                          className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                            subtitleEdge === edge ? 'bg-[#E50914] text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                          }`}
                        >
                          {edge === 'none' ? 'Sem' : edge === 'outline' ? 'Contorno' : 'Sombra'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Netflix Player Controls Bar */}
      <div
        onPointerEnter={(event) => {
          isHoveringControlsRef.current = event.pointerType === 'mouse' && !isMobile;
          if(event.pointerType==='mouse'&&!isMobile&&!nativeIos)setShowControls(true);
        }}
        onPointerLeave={() => {
          isHoveringControlsRef.current = false;
          if(!isMobile&&!nativeIos)resetControlsTimer();
        }}
        className={`player-bottom-bar absolute bottom-0 inset-x-0 z-30 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 sm:px-4 md:px-10 pt-6 sm:pt-8 pb-4 sm:pb-5 transition-opacity duration-300 safe-bottom safe-left safe-right ${
          controlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Netflix Red Progress Scrubber */}
        <div className="mb-3 sm:mb-4 flex items-center gap-2.5 sm:gap-3">
          <div className="relative flex-1 h-11 -my-2 group/scrub cursor-pointer flex items-center">
            <div className="relative w-full h-1.5 bg-zinc-700/80 rounded-full overflow-hidden">
              <div
                className="absolute left-0 top-0 bottom-0 bg-zinc-500/60 rounded-full"
                style={{
                  width: `${duration > 0 ? Math.min(100, (bufferedEnd / duration) * 100) : 0}%`,
                }}
              />
              <div
                className="absolute left-0 top-0 bottom-0 bg-[#E50914] rounded-full"
                style={{
                  width: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                }}
              />
            </div>
            <input
              type="range"
              aria-label="Progresso do vídeo"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={(e) => {
                const next = parseFloat(e.target.value);
                handleSeek(next);
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <span className="text-[11px] sm:text-xs font-mono text-zinc-300 shrink-0">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        {/* Controls Icons Row */}
        <div className="player-toolbar flex items-center justify-between gap-2">
          <div className="player-primary-actions flex items-center gap-1 sm:gap-4 md:gap-6">
            <button
              onClick={togglePlay}
              className="hidden sm:flex text-white hover:text-[#E50914] items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title={playing ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)'}
            >
              {playing ? <Pause className="w-6 h-6 sm:w-7 sm:h-7 fill-white" /> : <Play className="w-6 h-6 sm:w-7 sm:h-7 fill-white" />}
            </button>

            <button
              type="button"
              onClick={restartPlayback}
              className="text-zinc-200 hover:text-white transition flex items-center justify-center cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Iniciar do começo"
              aria-label="Iniciar do começo"
            >
              <SkipBack className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>

            <button
              onClick={() => skipSeconds(-10)}
              className="text-zinc-200 hover:text-white transition flex items-center justify-center gap-1 cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Retroceder 10 segundos (←)"
            >
              <RotateCcw className="w-5 h-5 sm:w-6 sm:h-6" />
              <span className="text-xs font-bold hidden sm:inline">10s</span>
            </button>

            <button
              onClick={() => skipSeconds(10)}
              className="text-zinc-200 hover:text-white transition flex items-center justify-center gap-1 cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Avançar 10 segundos (→)"
            >
              <RotateCw className="w-5 h-5 sm:w-6 sm:h-6" />
              <span className="text-xs font-bold hidden sm:inline">10s</span>
            </button>

            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={toggleMute}
                className="text-zinc-200 hover:text-white flex items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
                title="Mudo (M)"
              >
                {muted || volume === 0 ? <VolumeX className="w-5 h-5 sm:w-6 sm:h-6" /> : <Volume2 className="w-5 h-5 sm:w-6 sm:h-6" />}
              </button>
              <input
                type="range"
                aria-label="Volume"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => handleVolumeSlider(parseFloat(e.target.value))}
                className="hidden sm:block w-20 accent-[#E50914] cursor-pointer"
              />
            </div>

            <button
              onClick={() => handleCyclePlaybackRate()}
              className="inline-flex items-center justify-center px-2 py-1 rounded bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-[11px] sm:text-xs font-mono font-bold text-zinc-200 cursor-pointer touch-target-sm tap-highlight"
              title="Velocidade de reprodução"
            >
              {playbackRate}x
            </button>

            {/* Official Netflix Audio & Subtitles Trigger (Icon Only, on same line as play/pause) */}
            <button
              type="button"
              aria-label="Idiomas e Legendas"
              title="Idiomas e Legendas"
              onClick={() => {
                setShowAudioSubMenu((s) => !s);
                setShowWatchParty(false);
              }}
              className={`flex items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight p-1.5 sm:p-2 rounded ${
                showAudioSubMenu
                  ? 'bg-[#E50914] text-white shadow-lg'
                  : 'text-zinc-200 hover:text-white hover:bg-zinc-800'
              }`}
            >
              <Languages className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            </button>
          </div>

          <div className="player-secondary-actions flex items-center gap-1.5 sm:gap-3 md:gap-5">
            {/* Aspect Ratio / Fit Screen Toggle */}
            <button
              type="button"
              onClick={toggleFitMode}
              className={`flex items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight p-1.5 rounded ${
                isCover ? 'text-[#E50914]' : 'text-zinc-200 hover:text-white'
              }`}
              title={isCover ? 'Ajustar à tela original' : 'Preencher tela inteira'}
              aria-label={isCover ? 'Ajustar à tela original' : 'Preencher tela inteira'}
            >
              <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>

            {/* Fullscreen Toggle */}
            {!isMobile && !nativeIos && <button
              type="button"
              onClick={toggleFullscreen}
              className="text-zinc-200 hover:text-white flex items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight p-1.5 rounded"
              title={isFullscreen ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'}
              aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            >
              {isFullscreen ? <Minimize className="w-4 h-4 sm:w-5 sm:h-5" /> : <Maximize className="w-4 h-4 sm:w-5 sm:h-5" />}
            </button>}

            {/* Cast / AirPlay */}
            <button
              onClick={triggerCastOrAirplay}
              className="hidden sm:flex items-center justify-center text-zinc-200 hover:text-white transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Transmitir para Smart TV (Chromecast / AirPlay)"
            >
              <Tv className="w-5 h-5" />
            </button>

            {/* Picture in Picture */}
            <button
              onClick={togglePip}
              className="hidden sm:flex items-center justify-center text-zinc-200 hover:text-white transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Picture-in-Picture"
            >
              <PictureInPicture2 className="w-5 h-5" />
            </button>

            {/* Quality Selector (HLS) */}
            {(useHls || shouldUseHls) && hlsLevels.length > 0 && (
              <div className="relative hidden sm:block">
                <button
                  onClick={() => setShowQualityMenu(!showQualityMenu)}
                  className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white text-xs font-semibold transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
                  title="Qualidade de vídeo"
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  <span>{currentQuality}</span>
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 z-30 bg-zinc-900/95 border border-zinc-700 rounded-lg shadow-xl overflow-hidden min-w-[120px] animate-fadeIn">
                    <button
                      onClick={() => { setHlsQuality('auto'); setShowQualityMenu(false); }}
                      className={`w-full text-left px-3 py-2 text-xs font-medium transition ${
                        currentQuality === 'auto' ? 'bg-[#E50914] text-white' : 'text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      Auto
                    </button>
                    {hlsLevels
                      .filter(l => l.height)
                      .sort((a, b) => b.height - a.height)
                      .map(level => (
                        <button
                          key={level.index}
                          onClick={() => { setHlsQuality(`${level.height}p`); setShowQualityMenu(false); }}
                          className={`w-full text-left px-3 py-2 text-xs font-medium transition ${
                            currentQuality === `${level.height}p` ? 'bg-[#E50914] text-white' : 'text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {level.height}p
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* Retry / Recovery Button */}
            {(streamError || hlsError) && (
              <button
                onClick={handleRetryStream}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-amber-600/20 hover:bg-amber-600/40 border border-amber-500/60 text-amber-200 font-semibold text-xs transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
                title="Tentar reconectar stream"
              >
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Tentar novamente</span>
              </button>
            )}

            {/* Offline Indicator */}
            {!navigator.onLine && (
              <button className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-zinc-800/90 border border-zinc-600 text-zinc-400 text-xs font-semibold cursor-pointer touch-target-sm sm:touch-target" disabled>
                <WifiOff className="w-4 h-4" />
                <span>Offline</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    </MasterClockProvider>
  );
};

