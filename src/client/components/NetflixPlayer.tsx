import { isPlayerFullscreen, togglePlayerFullscreen, type FullscreenVideo } from '../services/fullscreen';
import { apiUrl, requestResponse } from '../services/catalog';
import { useDialog } from '../hooks/useDialog';
import React, { useEffect, useRef, useState, useCallback } from 'react';
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
} from 'lucide-react';
import type { AudioTrack, MediaFile, MediaItem, Profile, SubtitleTrack } from '../types';
import {
  HybridAudioSyncController,
  MkvWebCodecsCanvasPlayer,
  ensureDolbyDecoder,
  inspectStreamWithMediabunny,
  isIosWebKit,
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
  };
  ErrorTypes: {
    NETWORK_ERROR: string;
    MEDIA_ERROR: string;
  };
}

interface HlsConfig {
  enableWorker?: boolean;
  lowLatencyMode?: boolean;
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
 * Detects if the browser needs HLS (disabled by default since edge worker uses HTTP 206 Range streaming)
 */
function needsHlsPlayback(): boolean {
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
  const wsRef = useRef<WebSocket | null>(null);
  const suppressSyncBroadcastRef = useRef<boolean>(false);

  // Prefer the mirror that supports sustained ranged playback; Drive may
  // return a download confirmation page for large public media requests.
  const initialSelectedFile = (isIosWebKit() && item.files.find((file) =>
    /^(mp4|m4v)$/i.test(file.container || '') || /\.(mp4|m4v)$/i.test(file.filename || '')))
    || item.files.find((file) => file.provider === 'onedrive') || item.files[0];
  const [selectedFile, setSelectedFile] = useState<MediaFile | undefined>(initialSelectedFile);
  const [customStreamUrl, setCustomStreamUrl] = useState<string | null>(null);
  const effectiveStreamUrl = customStreamUrl || selectedFile?.streamUrl || '';
  const isMkvFile =
    (selectedFile?.container || '').toLowerCase() === 'mkv' ||
    (selectedFile?.filename || '').toLowerCase().endsWith('.mkv');
  const [useWebCodecsCanvas, setUseWebCodecsCanvas] = useState<boolean>(() => isIosWebKit() && isMkvFile);

  const [playing, setPlaying] = useState(() => !isIosWebKit());
  const [currentTime, setCurrentTime] = useState(item.progress?.is_completed ? 0 : item.progress?.position_seconds || 0);
  const [duration, setDuration] = useState(item.progress?.duration_seconds || item.runtime_minutes * 60);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expandedPlayer, setExpandedPlayer] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [introDismissed, setIntroDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isBuffering, setIsBuffering] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  const introEligible = playing && currentTime >= 4 && currentTime <= 88;
  useEffect(() => {
    if (!introEligible || introDismissed) return;
    const timer = window.setTimeout(() => setIntroDismissed(true), 3000);
    return () => window.clearTimeout(timer);
  }, [introEligible, introDismissed]);
  useEffect(() => { setIntroDismissed(false); }, [effectiveStreamUrl]);

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

  // Audio & Subtitle Menu State
  const [showAudioSubMenu, setShowAudioSubMenu] = useState(false);
  const [activeAudioId, setActiveAudioId] = useState<string>(
    (initialAudioId && candidateAudioTracks.find((a) => a.id === initialAudioId)?.id) ||
      (item.progress?.selected_audio_id && candidateAudioTracks.find((a) => a.id === item.progress?.selected_audio_id)?.id) ||
      candidateAudioTracks.find((a) => a.language_code === activeProfile.preferred_audio_lang)?.id ||
      candidateAudioTracks[0]?.id ||
      ''
  );
  const [activeSubtitleId, setActiveSubtitleId] = useState<string>(
    (initialSubtitleId && candidateSubTracks.find((s) => s.id === initialSubtitleId)?.id) ||
      (item.progress?.selected_subtitle_id && candidateSubTracks.find((s) => s.id === item.progress?.selected_subtitle_id)?.id) ||
      (activeProfile.preferred_subtitle_lang !== 'off'
        ? candidateSubTracks.find((s) => s.language_code === activeProfile.preferred_subtitle_lang)?.id || 'off'
        : candidateSubTracks.find((s) => s.is_forced)?.id || 'off')
  );

  const [audioStatusNote, setAudioStatusNote] = useState<string>('Preparando áudio…');
  const [mediabunnyTracks, setMediabunnyTracks] = useState<MediabunnyTrackSummary[]>([]);
  const [aiGeneratingSub, setAiGeneratingSub] = useState(false);
  const [dialogueBoost, setDialogueBoost] = useState(false);
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

  // Custom Subtitle Renderer State
  const [subtitleCues, setSubtitleCues] = useState<VttCueItem[]>([]);
  const [subtitleOffsetSec, setSubtitleOffsetSec] = useState<number>(0);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>('md');
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

  useEffect(() => {
    const syncFullscreenState = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(isPlayerFullscreen(doc, videoRef.current as FullscreenVideo | null));
    };
    const video = videoRef.current;
    const onNativeEnter = () => { setIsFullscreen(true); setFullscreenError(''); };
    const onNativeExit = () => setIsFullscreen(false);
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
  }, [effectiveStreamUrl]);

  const hlsMasterUrl = selectedFile ? getHlsMasterUrl(selectedFile.id) : '';

  // Determine if we should use HLS (iOS Safari)
  const shouldUseHls = !useWebCodecsCanvas && !hlsError && (useHls || (needsHlsPlayback() && hlsMasterUrl && effectiveStreamUrl));

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
    const ctrl = new HybridAudioSyncController(videoRef.current, setAudioStatusNote);
    audioControllerRef.current = ctrl;
    // Initialize audio graph early to set audioSession.type = 'playback' for iOS silent mode support
    ctrl.resumeAudioContext();
    const video = videoRef.current;
    const diagnosticsTimer = window.setInterval(() => {
      for (const [key, value] of Object.entries(ctrl.getAudioDiagnostics())) {
        video.dataset[key] = String(value);
      }
    }, 1000);
    return () => {
      window.clearInterval(diagnosticsTimer);
      ctrl.destroy();
    };
  }, []);

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
        if (!active) return;
        clearLoadTimer();
        setIsBuffering(false);
        setStreamError(null);
      },
      onReadyToPlay: () => {
        if (!active) return;
        clearLoadTimer();
        setIsBuffering(false);
        setStreamError(null);
        setShowControls(true);
      },
      onWaiting: () => {
        if (!active) return;
        setIsBuffering(true);
        armLoadTimer();
      },
      onError: failPlayback,
    });
    canvasPlayerRef.current = player;

    audioControllerRef.current?.setClockOverride(
      {
        getCurrentTime: () => player.getCurrentTime(),
        isPaused: () => player.isPaused(),
        getPlaybackRate: () => player.getPlaybackRate(),
      },
      true
    );

    setIsBuffering(true);
    setStreamError(null);
    armLoadTimer();
    void player.open(effectiveStreamUrl, startAt, !isIosWebKit());
    if (isIosWebKit()) setPlaying(false);

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
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
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
            }
          });

          hls.on(HlsClass.Events.ERROR, (_event: unknown, data: unknown) => {
            if (!mounted) return;
            const errorData = data as { fatal: boolean; type: string } | undefined;
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
                hls?.destroy();
                setHlsError('Erro ao carregar stream HLS. Tentando stream direto...');
                setUseHls(false);
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

    const wsUrl = new URL(apiUrl(`/api/watch-party/${encodeURIComponent(cleanCode)}`), window.location.href);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl);
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
          if (videoRef.current) {
            suppressSyncBroadcastRef.current = true;
            if (Math.abs(videoRef.current.currentTime - Number(p.currentTime || 0)) > 2) {
              videoRef.current.currentTime = Number(p.currentTime || 0);
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
    if (controlsTimerRef.current) {
      window.clearTimeout(controlsTimerRef.current);
    }
    if (!showAudioSubMenu && !showWatchParty) {
      controlsTimerRef.current = window.setTimeout(() => {
        const isPausedNow = useWebCodecsCanvas
          ? canvasPlayerRef.current?.isPaused() ?? !playing
          : videoRef.current?.paused ?? !playing;
        if (!isPausedNow && (isMobile || !isHoveringControlsRef.current)) {
          setShowControls(false);
        }
      }, 3200);
    }
  }, [playing, showAudioSubMenu, showWatchParty, useWebCodecsCanvas, isMobile]);

  useEffect(() => {
    if (!fullscreenError || !expandedPlayer) return;
    const timer = window.setTimeout(() => setFullscreenError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [fullscreenError, expandedPlayer]);

  useEffect(() => () => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
  }, []);

  useEffect(() => {
    if (!playing) {
      setShowControls(true);
      if (controlsTimerRef.current) {
        window.clearTimeout(controlsTimerRef.current);
      }
    } else {
      resetControlsTimer();
    }
  }, [playing, resetControlsTimer]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
      if (e.key === ' ' && e.target instanceof HTMLButtonElement) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        skipSeconds(10);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        skipSeconds(-10);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'Escape') {
        if (showAudioSubMenu) setShowAudioSubMenu(false);
        else if (showWatchParty) setShowWatchParty(false);
        else handleExitPlayer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

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

  const skipSeconds = (delta: number) => {
    audioControllerRef.current?.resumeAudioContext();
    resetControlsTimer();
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      const next = Math.max(0, Math.min(duration || 7200, canvasPlayerRef.current.getCurrentTime() + delta));
      canvasPlayerRef.current.seek(next);
      audioControllerRef.current?.notifyClockSeek(next);
      setCurrentTime(next);
      broadcastPartySync(!canvasPlayerRef.current.isPaused(), next);
      return;
    }
    if (!videoRef.current) return;
    const next = Math.max(0, Math.min(duration || 7200, videoRef.current.currentTime + delta));
    videoRef.current.currentTime = next;
    setCurrentTime(next);
    broadcastPartySync(!videoRef.current.paused, next);
  };

  const restartPlayback = () => {
    const player = useWebCodecsCanvas ? canvasPlayerRef.current : videoRef.current;
    if (!player) return;
    audioControllerRef.current?.resumeAudioContext();
    resetControlsTimer();
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
  };

  const handleVolumeSlider = (val: number) => {
    if (!videoRef.current) return;
    audioControllerRef.current?.setOutputVolume(val, val === 0);
    setVolume(val);
    setMuted(val === 0);
  };

  const toggleFullscreen = async () => {
    setFullscreenError('');
    if (expandedPlayer) {
      setExpandedPlayer(false);
      setIsFullscreen(false);
      const orientation = (screen as Screen & { orientation?: { unlock?: () => void } }).orientation;
      orientation?.unlock?.();
      return;
    }
    // Lock to landscape immediately within the user gesture (required for iOS)
    const orientation = (screen as Screen & { orientation?: { lock?: (mode: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (isMobile) {
      try {
        await orientation?.lock?.('landscape');
      } catch {
        // Ignore if orientation lock fails
      }
    }

    // On iOS, use native video fullscreen (webkitEnterFullscreen) for true fullscreen
    // (hides address bar, clock, battery). Only use expandedPlayer for WebCodecs canvas mode.
    if (isIosWebKit() && useWebCodecsCanvas) {
      // WebCodecs canvas mode: no <video> element, use CSS fullscreen fallback
      setExpandedPlayer(true);
      setIsFullscreen(true);
      return;
    }
    try {
      await togglePlayerFullscreen(document, containerRef.current || document.documentElement,
        useWebCodecsCanvas ? null : videoRef.current as FullscreenVideo | null, isIosWebKit() && !useWebCodecsCanvas);
      const active = isPlayerFullscreen(document, videoRef.current as FullscreenVideo | null);
      setIsFullscreen(active);
      if (!active) orientation?.unlock?.();
    } catch {
      if (isIosWebKit() && useWebCodecsCanvas) {
        setExpandedPlayer(true);
        setIsFullscreen(true);
        setFullscreenError('Modo ampliado ativado. Gire o iPhone para assistir na horizontal.');
      } else {
        setFullscreenError('Não foi possível abrir a tela cheia. Inicie o vídeo e tente novamente.');
      }
      orientation?.unlock?.();
    }
  };

  const togglePip = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
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

  const handleCyclePlaybackRate = () => {
    const rates = [0.75, 1, 1.25, 1.5, 2];
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIdx];
    setPlaybackRate(nextRate);
    if (useWebCodecsCanvas && canvasPlayerRef.current) {
      canvasPlayerRef.current.setPlaybackRate(nextRate);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = nextRate;
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
    onClose();
  };

  const activeAudioObj = item.audioTracks.find((a) => a.id === activeAudioId) || item.audioTracks[0];
  const activeSubObj = item.subtitleTracks.find((s) => s.id === activeSubtitleId);
  const controlsVisible = showControls || !playing || showAudioSubMenu || showWatchParty;

  return (
    <div
      ref={containerRef}
      role="dialog" aria-modal="true" aria-label={`Reproduzindo ${item.title}`} tabIndex={-1}
      onMouseMove={resetControlsTimer}
      onPointerMove={resetControlsTimer}
      onMouseEnter={resetControlsTimer}
      onTouchStart={() => {
        audioControllerRef.current?.resumeAudioContext();
        resetControlsTimer();
      }}
      className={`player-shell fixed inset-0 bg-black flex flex-col justify-between select-none overflow-hidden safe-top safe-bottom ${expandedPlayer ? 'player-landscape z-[100]' : 'z-50'}`}
    >
      {fullscreenError && <div role="status" className="absolute top-20 left-4 right-4 z-[60] rounded bg-black/90 p-3 text-center text-sm text-white">{fullscreenError}</div>}
      {/* HTML5 Video Element or iOS/Safari WebCodecs MKV Canvas Engine */}
      {effectiveStreamUrl ? (
        <>
          <canvas
            ref={canvasRef}
            onMouseMove={resetControlsTimer}
            onPointerMove={resetControlsTimer}
            onClick={() => {
              if (showAudioSubMenu) setShowAudioSubMenu(false);
              else if (showWatchParty) setShowWatchParty(false);
              else if (isMobile && playing) resetControlsTimer();
              else togglePlay();
            }}
            className={`absolute inset-0 w-full h-full object-contain bg-black cursor-pointer ${
              useWebCodecsCanvas ? 'block' : 'hidden'
            }`}
          />
          <video
            ref={videoRef}
            src={useWebCodecsCanvas || shouldUseHls ? undefined : effectiveStreamUrl}
            preload="auto"
            autoPlay={!useWebCodecsCanvas && !isIosWebKit()}
            playsInline
            crossOrigin="anonymous"
            onMouseMove={resetControlsTimer}
            onPointerMove={resetControlsTimer}
            onClick={() => {
              if (showAudioSubMenu) setShowAudioSubMenu(false);
              else if (showWatchParty) setShowWatchParty(false);
              else if (isMobile && playing) resetControlsTimer();
              else togglePlay();
            }}
            onPlay={() => { if (!useWebCodecsCanvas) setPlaying(true); }}
            onPause={() => {
              if (useWebCodecsCanvas) return;
              setPlaying(false);
              setShowControls(true);
            }}
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
              if (v.paused && !isIosWebKit()) {
                v.play().catch(() => { setPlaying(false); setShowControls(true); });
              }
            }}
            onWaiting={() => {
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
            }}
            onError={() => {
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
              // Fallback to WebCodecs + WASM MKV Canvas Engine (for iOS Chrome/Safari & macOS Safari!)
              if (typeof window !== 'undefined' && 'VideoDecoder' in window) {
                setUseWebCodecsCanvas(true);
                setAudioStatusNote('Motor WebCodecs + WASM MKV ativado (Compatibilidade iOS / Safari)');
                return;
              }
              setIsBuffering(false);
              setStreamError(
                'O arquivo .MKV usa codec HEVC/Dolby exclusivo ou está concluindo sincronização.'
              );
            }}
            className={`absolute inset-0 w-full h-full object-contain bg-black cursor-pointer ${
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
            className={`bg-black/75 text-white font-semibold text-center px-3 sm:px-4 py-1 sm:py-1.5 rounded shadow-[0_4px_16px_rgba(0,0,0,0.95)] whitespace-pre-line leading-snug ${
              subtitleSize === 'sm'
                ? 'text-xs sm:text-sm md:text-base'
                : subtitleSize === 'lg'
                  ? 'text-lg sm:text-xl md:text-3xl'
                  : 'text-sm sm:text-base md:text-2xl'
            }`}
          >
            {activeCueText}
          </div>
        </div>
      )}

      {/* Netflix Authentic "Pular Abertura" (Skip Intro) Floating Button */}
      {introEligible && !introDismissed && !showAudioSubMenu && !showWatchParty && (
        <div className="player-skip-intro absolute bottom-24 sm:bottom-28 right-4 md:right-12 z-30 animate-fadeIn safe-right safe-bottom">
          <button
            onClick={() => skipSeconds(88 - currentTime)}
            className="bg-black/75 hover:bg-white hover:text-black text-white border-2 border-white/80 font-bold text-xs md:text-sm px-4 sm:px-5 py-2 sm:py-2.5 rounded shadow-2xl transition tracking-wide uppercase cursor-pointer touch-target tap-highlight"
          >
            Pular Abertura
          </button>
        </div>
      )}

      {/* Netflix Authentic Pause Screen Overlay ("Você está assistindo...") */}
      {!playing && !isBuffering && !showAudioSubMenu && !showWatchParty && !streamError && (
        <div
          onClick={togglePlay}
          className="player-pause-overlay absolute inset-0 bg-black/55 z-20 flex flex-col justify-center px-4 sm:px-12 md:px-16 lg:px-20 py-16 cursor-pointer animate-fadeIn safe-top safe-bottom safe-left safe-right"
        >
          <div className="player-pause-content max-w-xl space-y-2 sm:space-y-3">
            <span className="text-[10px] sm:text-xs font-bold tracking-widest uppercase text-zinc-400">
              Você está assistindo
            </span>
            <h2 className="font-netflix-logo text-2xl sm:text-4xl md:text-6xl text-white tracking-wide line-clamp-2">
              {item.title}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-zinc-300">
              <span className="text-[#46D369]">Nota {item.rating.toFixed(1)}/10</span>
              <span>{item.release_year}</span>
              <span className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-600 rounded">
                {item.age_rating === 'L' ? 'LIVRE' : `${item.age_rating}+`}
              </span>
              <span>{selectedFile?.resolution || '1080p'}</span>
            </div>
            {item.tagline && (
              <p className="hidden sm:block text-sm italic text-zinc-200 font-medium">"{item.tagline}"</p>
            )}
            <p className="text-xs md:text-sm text-zinc-300 line-clamp-2 sm:line-clamp-3 leading-relaxed">
              {item.overview}
            </p>

            {/* Quick Action Buttons on Pause Screen */}
            <div
              onClick={(e) => e.stopPropagation()}
              className="player-pause-actions pt-3 sm:pt-4 flex flex-wrap items-center gap-2 sm:gap-3"
            >
              <button
                type="button"
                onClick={togglePlay}
                className="flex items-center gap-2 bg-white hover:bg-zinc-200 text-black font-bold text-xs sm:text-sm px-4 sm:px-5 py-2.5 rounded shadow-lg transition cursor-pointer touch-target-sm tap-highlight"
              >
                <Play className="w-4 h-4 fill-black shrink-0" />
                <span>Continuar</span>
              </button>

              <button
                type="button"
                onClick={restartPlayback}
                className="flex items-center gap-2 bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white font-semibold text-xs sm:text-sm px-4 sm:px-5 py-2.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
              >
                <SkipBack className="w-4 h-4 shrink-0" />
                <span>Iniciar do começo</span>
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="flex items-center gap-2 bg-[#E50914] hover:bg-[#b80710] text-white font-bold text-xs sm:text-sm px-4 sm:px-5 py-2.5 rounded shadow-lg transition cursor-pointer touch-target-sm tap-highlight"
              >
                {isFullscreen ? (
                  <>
                    <Minimize className="w-4 h-4 shrink-0" />
                    <span>Sair da Tela Cheia</span>
                  </>
                ) : (
                  <>
                    <Maximize className="w-4 h-4 shrink-0" />
                    <span>Tela Cheia</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => skipSeconds(-10)}
                className="flex items-center gap-1.5 bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white font-semibold text-xs sm:text-sm px-3.5 py-2.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
              >
                <RotateCcw className="w-4 h-4 shrink-0" />
                <span>-10s</span>
              </button>

              <button
                type="button"
                onClick={() => skipSeconds(10)}
                className="flex items-center gap-1.5 bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white font-semibold text-xs sm:text-sm px-3.5 py-2.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
              >
                <RotateCw className="w-4 h-4 shrink-0" />
                <span>+10s</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowAudioSubMenu(true);
                  setShowWatchParty(false);
                }}
                className="flex items-center gap-1.5 bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-600 text-white font-semibold text-xs sm:text-sm px-3.5 py-2.5 rounded transition cursor-pointer touch-target-sm tap-highlight"
              >
                <Subtitles className="w-4 h-4 shrink-0" />
                <span>Áudio e Legendas</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Netflix Red Loading Spinner */}
      {isBuffering && effectiveStreamUrl && !streamError && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/30 z-20 px-4 text-center safe-top safe-bottom">
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
          setShowControls(true);
        }}
        onPointerLeave={() => {
          isHoveringControlsRef.current = false;
          resetControlsTimer();
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
        <div className="flex items-center gap-1.5 sm:gap-2 text-xs shrink-0">
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
            <Subtitles className="w-4 h-4 shrink-0" />
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
        </div>
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
                  Powered by Cloudflare Durable Objects (WebSockets na Edge)
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
                    <button
                      onClick={handleAiTranslateSubtitle}
                      disabled={aiGeneratingSub}
                      className="text-[11px] bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500 text-purple-200 font-semibold px-2.5 py-1 rounded flex items-center gap-1 cursor-pointer"
                      title="Gera ou traduz legenda para Português (Brasil) usando Cloudflare Workers AI e salva no R2"
                    >
                      <Sparkles className={`w-3 h-3 ${aiGeneratingSub ? 'animate-spin' : ''}`} />
                      <span>{aiGeneratingSub ? 'Traduzindo IA...' : 'Legenda IA'}</span>
                    </button>

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

              {/* Subtitle Delay Offset & Font Size Controls */}
              <div className="mt-3 sm:mt-4 pt-3 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300">
                <div className="flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-[#E50914] shrink-0" />
                  <span>Sincronia:</span>
                  <button
                    onClick={() => setSubtitleOffsetSec((s) => Number((s - 0.5).toFixed(1)))}
                    className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded cursor-pointer"
                  >
                    -0.5s
                  </button>
                  <span className="font-mono text-white w-10 text-center">
                    {subtitleOffsetSec > 0 ? `+${subtitleOffsetSec}s` : `${subtitleOffsetSec}s`}
                  </span>
                  <button
                    onClick={() => setSubtitleOffsetSec((s) => Number((s + 0.5).toFixed(1)))}
                    className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded cursor-pointer"
                  >
                    +0.5s
                  </button>
                </div>

                <div className="flex items-center gap-1">
                  {(['sm', 'md', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      onClick={() => setSubtitleSize(sz)}
                      className={`px-2.5 py-1 rounded uppercase text-[10px] font-bold cursor-pointer ${
                        subtitleSize === sz ? 'bg-[#E50914] text-white' : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {sz === 'sm' ? 'P' : sz === 'md' ? 'M' : 'G'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Netflix Player Controls Bar */}
      <div
        onPointerEnter={(event) => {
          isHoveringControlsRef.current = event.pointerType === 'mouse' && !isMobile;
          setShowControls(true);
        }}
        onPointerLeave={() => {
          isHoveringControlsRef.current = false;
          resetControlsTimer();
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
                setCurrentTime(next);
                if (useWebCodecsCanvas && canvasPlayerRef.current) {
                  canvasPlayerRef.current.seek(next);
                  audioControllerRef.current?.notifyClockSeek(next);
                } else if (videoRef.current) {
                  videoRef.current.currentTime = next;
                }
                broadcastPartySync(playing, next);
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
              className="text-white hover:text-[#E50914] flex items-center justify-center transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
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
              onClick={handleCyclePlaybackRate}
              className="inline-flex items-center justify-center px-2 py-1 rounded bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-[11px] sm:text-xs font-mono font-bold text-zinc-200 cursor-pointer touch-target-sm tap-highlight"
              title="Velocidade de reprodução"
            >
              {playbackRate}x
            </button>
          </div>

          <div className="player-secondary-actions flex items-center gap-1.5 sm:gap-3 md:gap-5">
            {/* Official Netflix Audio & Subtitles Trigger */}
            <button
              aria-label="Áudio e Legendas"
              onClick={() => {
                setShowAudioSubMenu((s) => !s);
                setShowWatchParty(false);
              }}
              className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-1.5 rounded text-xs md:text-sm font-semibold transition cursor-pointer touch-target-sm sm:touch-target tap-highlight ${
                showAudioSubMenu
                  ? 'bg-[#E50914] text-white'
                  : 'bg-zinc-800/90 hover:bg-zinc-700 text-white border border-zinc-600'
              }`}
            >
              <Subtitles className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
              <span className="hidden min-[420px]:inline">Áudio e Legendas</span>
              <span className="min-[420px]:hidden">Idiomas</span>
            </button>

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

            <button
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
              className="flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded bg-zinc-800/90 hover:bg-[#E50914] border border-zinc-600 hover:border-[#E50914] text-white text-xs font-semibold transition cursor-pointer touch-target-sm sm:touch-target tap-highlight"
              title="Tela cheia (F)"
            >
              {isFullscreen ? <Minimize className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" /> : <Maximize className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />}
              <span className="hidden md:inline">{isFullscreen ? 'Sair' : 'Tela Cheia'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

