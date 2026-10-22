import { Input, UrlSource, AudioBufferSink, MATROSKA, MP4, WEBM } from 'mediabunny';
import type { CanvasSink } from 'mediabunny';
import type { AudioTrack } from '../types';

// sideEffects: true via package.json in services directory
export function isIosWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
}

export function isTvOrAndroidNative(): boolean {
  if (typeof window === 'undefined') return false;
  if (isCapacitorNative() && !isIosWebKit()) return true;
  const ua = navigator.userAgent || '';
  return /GoogleTV|AndroidTV|SmartTV|TCL|Appletv|HbbTV|CrKey|NetCast/i.test(ua);
}

// Download the Dolby decoder only when an actual Dolby track needs it.
let decoderRegistration: Promise<void> | undefined;
export function ensureDolbyDecoder() {
  decoderRegistration ??= import('@mediabunny/ac3').then(({ registerAc3Decoder }) => {
    registerAc3Decoder();
  }).catch(error => { decoderRegistration = undefined; throw error; });
  return decoderRegistration;
}

export interface MediabunnyTrackSummary {
  index: number;
  languageCode: string;
  codec: string | null;
  channels: number;
  sampleRate: number;
  canDecodeWasm: boolean;
}

/**
 * Uses Mediabunny + @mediabunny/ac3 in the browser via HTTP Range requests to inspect embedded audio tracks
 * inside .mkv, .webm, or .mp4 containers directly from the Cloudflare Worker stream URL.
 */
export async function inspectStreamWithMediabunny(streamUrl: string): Promise<MediabunnyTrackSummary[]> {
  if (isTvOrAndroidNative()) return [];
  let input: Input | null = null;
  try {
    const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : `${window.location.origin}${streamUrl}`;
    input = new Input({
      source: new UrlSource(absoluteUrl),
      formats: [MATROSKA, WEBM, MP4],
    });

    const audioTracks = await input.getAudioTracks();
    const summaries: MediabunnyTrackSummary[] = [];

    for (let i = 0; i < audioTracks.length; i++) {
      const t = audioTracks[i];
      const lang = await t.getLanguageCode();
      if (/ac3/i.test(String(t.codec || '').replace(/[^a-z0-9]/gi, ''))) await ensureDolbyDecoder();
      const decodable = await t.canDecode().catch(() => false);
      summaries.push({
        index: i,
        languageCode: lang || 'und',
        codec: t.codec ? String(t.codec) : null,
        channels: t.numberOfChannels || 0,
        sampleRate: t.sampleRate || 0,
        canDecodeWasm: decodable,
      });
    }

    return summaries;
  } catch {
    return [];
  } finally {
    input?.dispose();
  }
}

/**
 * Hybrid Audio Controller supporting 4 modes:
 * 1. WebAssembly Multi-Track MKV Demuxer & AC-3/E-AC-3 Decoder (`mediabunny` + `@mediabunny/ac3` + `AudioBufferSink`)
 *    Allows switching between Track #1 (Dublado PT-BR 5.1 EAC3) and Track #2 (Original EN 5.1 EAC3) in ANY browser!
 * 2. Native HTMLMediaElement.audioTracks when available
 * 3. Separate External Audio Files (.mka, .mp3, .aac) synchronized with the primary <video> clock
 * 4. Separate Alternate Video Files (Dublado.mkv vs Legendado.mkv) switching while preserving currentTime
 */
export class HybridAudioSyncController {
  private videoEl: HTMLVideoElement;
  private externalAudioEl: HTMLAudioElement | null = null;
  private syncInterval: number | null = null;

  // Web Audio API + WebAssembly AC3/EAC3 Decoder pipeline
  private audioCtx: AudioContext | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private voiceBoostFilter: BiquadFilterNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private dialogueBoostActive = false;

  // Mediabunny WASM Demuxer state
  private wasmInput: Input | null = null;
  private wasmSink: AudioBufferSink | null = null;
  private wasmActive = false;
  private wasmAbortId = 0;
  private activeSourceNodes: Set<AudioBufferSourceNode> = new Set();
  private userVolume = 1;
  private userMuted = false;
  private suppressNativeAudio = false;
  private nativeTrackIndex = 0;
  private selectionId = 0;
  private outputAnalyser: AnalyserNode | null = null;
  private outputSamples = new Float32Array(256);
  private scheduledBuffers = 0;
  private clockOverride: {
    getCurrentTime: () => number;
    isPaused: () => boolean;
    getPlaybackRate: () => number;
  } | null = null;
  private forceWasmMode = false;
  private is4KMode = false;

  public setIs4KMode(val: boolean) {
    this.is4KMode = val;
  }

  constructor(videoEl: HTMLVideoElement, private onStatus?: (status: string) => void, private getAudioOffset?: () => number) {
    this.videoEl = videoEl;
    this.bindVideoEvents();
  }

  public setClockOverride(
    override: {
      getCurrentTime: () => number;
      isPaused: () => boolean;
      getPlaybackRate: () => number;
    } | null,
    forceWasm = false
  ) {
    this.clockOverride = override;
    this.forceWasmMode = forceWasm;
  }

  private getMediaTime(): number {
    const baseTime = this.clockOverride ? this.clockOverride.getCurrentTime() : this.videoEl.currentTime;
    const offset = this.getAudioOffset?.() || 0;
    return baseTime + offset;
  }

  private isMediaPaused(): boolean {
    return this.clockOverride ? this.clockOverride.isPaused() : this.videoEl.paused;
  }

  private getMediaRate(): number {
    return (this.clockOverride ? this.clockOverride.getPlaybackRate() : this.videoEl.playbackRate) || 1;
  }

  public notifyClockPlay() {
    if (this.isMediaPaused()) return;
    this.handlePlay();
    this.handlePlaying();
  }

  public notifyClockPause() {
    this.handlePause();
  }

  public notifyClockSeek(newTimeSec: number) {
    if (this.externalAudioEl) {
      this.externalAudioEl.currentTime = newTimeSec;
    }
    if (this.wasmActive && this.wasmSink) {
      this.stopActiveBufferNodes();
      if (!this.isMediaPaused()) {
        void this.startWasmPumpFrom(newTimeSec);
      }
    }
  }

  public resumeAudioContext() {
    // Create the graph during the tap, before asynchronous track inspection.
    // iOS cannot unlock a context first created after user activation expires.
    if (this.audioCtx?.state === 'closed') {
      this.stopActiveBufferNodes();
      this.audioCtx = null;
    }
    const ctx = this.ensureAudioGraph();
    // Start a source inside the gesture as well as resuming the context.
    // WebKit can keep the audio output locked until a source starts on a tap.
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      const unlock = ctx.createBufferSource();
      unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      unlock.connect(ctx.destination);
      unlock.onended = () => unlock.disconnect();
      unlock.start();
      // iOS can leave a context interrupted after screen lock. Once resumed,
      // discard old scheduling anchors and restart against the current clock.
      void ctx.resume().then(() => {
        if (ctx !== this.audioCtx || this.isMediaPaused()) return;
        this.notifyClockSeek(this.getMediaTime());
      }).catch(() => {});
    }
  }

  private ensureAudioGraph(): AudioContext {
    // Media playback must remain audible with the iPhone silent switch on.
    if (typeof navigator !== 'undefined') {
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      try { if (session) session.type = 'playback'; } catch { /* Older WebKit */ }
    }
    if (!this.audioCtx) {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextClass();

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.userMuted ? 0 : this.userVolume;

      // Peaking filter at 2.2 kHz (+7.5 dB) to lift center-channel voice clarity in 5.1 stereo downmixes
      this.voiceBoostFilter = this.audioCtx.createBiquadFilter();
      this.voiceBoostFilter.type = 'peaking';
      this.voiceBoostFilter.frequency.value = 2200;
      this.voiceBoostFilter.Q.value = 1.1;
      this.voiceBoostFilter.gain.value = this.dialogueBoostActive ? 7.5 : 0;

      // Dynamic compressor to tame loud explosions while keeping dialogue audible
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.compressorNode.threshold.value = -24;
      this.compressorNode.knee.value = 30;
      this.compressorNode.ratio.value = this.dialogueBoostActive ? 8 : 1;
      this.compressorNode.attack.value = 0.003;
      this.compressorNode.release.value = 0.25;

      this.voiceBoostFilter.connect(this.compressorNode);
      this.compressorNode.connect(this.gainNode);
      this.outputAnalyser = this.audioCtx.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.gainNode.connect(this.outputAnalyser);
      this.outputAnalyser.connect(this.audioCtx.destination);
    }

    if (this.audioCtx.state !== 'running' && this.audioCtx.state !== 'closed') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  private bindVideoEvents() {
    this.videoEl.addEventListener('play', this.handlePlay);
    this.videoEl.addEventListener('pause', this.handlePause);
    this.videoEl.addEventListener('seeking', this.handleSeek);
    this.videoEl.addEventListener('seeked', this.handleSeeked);
    this.videoEl.addEventListener('waiting', this.handleWaiting);
    this.videoEl.addEventListener('playing', this.handlePlaying);
    this.videoEl.addEventListener('ratechange', this.handleRateChange);
    this.videoEl.addEventListener('volumechange', this.handleVolumeChange);
    this.videoEl.addEventListener('loadedmetadata', this.applyNativeAudioPolicy);
  }

  private handlePlay = (event?: Event) => {
    if (event && this.clockOverride) return;
    this.applyNativeAudioPolicy();
    if (this.externalAudioEl) {
      this.externalAudioEl.currentTime = this.getMediaTime();
      this.externalAudioEl.play().catch(() => {});
    }
    if (this.wasmActive && this.wasmSink) {
      if (this.audioCtx && this.audioCtx.state !== 'running' && this.audioCtx.state !== 'closed') {
        this.audioCtx.resume().catch(() => {});
      }
    }
  };

  private handlePause = (event?: Event) => {
    if (event && this.clockOverride) return;
    if (this.externalAudioEl) {
      this.externalAudioEl.pause();
    }
    if (this.wasmActive) {
      this.stopActiveBufferNodes();
    }
  };

  private handleSeek = (event?: Event) => {
    if (event && this.clockOverride) return;
    if (this.externalAudioEl) {
      this.externalAudioEl.currentTime = this.getMediaTime();
    }
    if (this.wasmActive) this.stopActiveBufferNodes();
  };

  private handleWaiting = (event?: Event) => {
    if (event && this.clockOverride) return;
    if (this.wasmActive) this.stopActiveBufferNodes();
  };

  private handlePlaying = (event?: Event) => {
    if (event && this.clockOverride) return;
    this.applyNativeAudioPolicy();
    if (this.wasmActive && this.wasmSink && !this.isMediaPaused()) {
      void this.startWasmPumpFrom(this.getMediaTime());
    }
  };

  private handleSeeked = (event?: Event) => {
    if (event && this.clockOverride) return;
    if (this.videoEl.readyState >= 3) this.handlePlaying();
  };

  private handleRateChange = (event?: Event) => {
    if (event && this.clockOverride) return;
    if (this.externalAudioEl) {
      this.externalAudioEl.playbackRate = this.getMediaRate();
    }
    if (this.wasmActive && !this.isMediaPaused()) {
      void this.startWasmPumpFrom(this.getMediaTime());
    }
  };

  private handleVolumeChange = () => {
    if (this.suppressNativeAudio) {
      this.applyNativeAudioPolicy();
      return;
    }
    if (!this.wasmActive && !this.externalAudioEl) {
      this.userVolume = this.videoEl.volume;
      this.userMuted = this.videoEl.muted;
    }
    if (this.externalAudioEl) {
      this.externalAudioEl.volume = this.userVolume;
      this.externalAudioEl.muted = this.userMuted;
    }
  };

  private applyNativeAudioPolicy = () => {
    const tracks = (this.videoEl as HTMLVideoElement & {
      audioTracks?: { length: number; [index: number]: { enabled: boolean } };
    }).audioTracks;
    if (tracks) {
      const selected = Math.min(this.nativeTrackIndex, tracks.length - 1);
      for (let i = 0; i < tracks.length; i++) {
        const enabled = !this.suppressNativeAudio && i === selected;
        if (tracks[i].enabled !== enabled) tracks[i].enabled = enabled;
      }
    }
    const muted = this.suppressNativeAudio || this.userMuted;
    if (this.videoEl.muted !== muted) this.videoEl.muted = muted;
  };

  public setOutputVolume(volume: number, muted: boolean) {
    this.userVolume = Math.max(0, Math.min(1, volume));
    this.userMuted = muted;
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setValueAtTime(muted ? 0 : this.userVolume, this.audioCtx.currentTime);
    }
    if (!this.suppressNativeAudio && !this.wasmActive && !this.externalAudioEl) {
      this.videoEl.volume = this.userVolume;
      this.videoEl.muted = this.userMuted;
    }
    this.applyNativeAudioPolicy();
    if (this.externalAudioEl) {
      this.externalAudioEl.volume = this.userVolume;
      this.externalAudioEl.muted = this.userMuted;
    }
  }

  /** Playback diagnostics distinguish actual WASM output from unsupported native audio. */
  public getAudioDiagnostics() {
    this.outputAnalyser?.getFloatTimeDomainData(this.outputSamples);
    let peak = 0;
    for (const value of this.outputSamples) peak = Math.max(peak, Math.abs(value));
    return {
      wasmActive: this.wasmActive,
      nativeAudioSuppressed: this.suppressNativeAudio,
      audioContextState: this.audioCtx?.state || 'uninitialized',
      wasmScheduledBuffers: this.scheduledBuffers,
      audioOutputGain: this.gainNode?.gain.value ?? 0,
      audioOutputPeak: peak,
    };
  }

  private stopActiveBufferNodes() {
    this.wasmAbortId++;
    for (const node of this.activeSourceNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // Ignore already stopped nodes
      }
    }
    this.activeSourceNodes.clear();
  }

  /**
   * Pumps decoded AudioBuffers from Mediabunny + @mediabunny/ac3 (WASM libavcodec)
   * synchronized with the HTML5 <video> or WebCodecs Canvas clock.
   */
  private async startWasmPumpFrom(
    startTimeSec: number,
    initialPacket?: { buffer: AudioBuffer; timestamp: number; duration: number }
  ) {
    if (!this.wasmSink) return;
    this.stopActiveBufferNodes();
    const currentRunId = this.wasmAbortId;
    const ctx = this.ensureAudioGraph();

    let baseWallClock = ctx.currentTime;
    let baseMediaTime = Math.max(0, startTimeSec);
    let anchored = false;

    const schedulePacket = (item: { buffer: AudioBuffer; timestamp: number; duration: number }): number => {
      const audioBuf: AudioBuffer = item.buffer;
      const samplePts: number = item.timestamp;
      if (!anchored) {
        baseWallClock = ctx.currentTime;
        baseMediaTime = this.getMediaTime();
        anchored = true;
      }

      const rate = this.getMediaRate();
      const mediaDelta = (samplePts - baseMediaTime) / rate;
      const targetContextTime = baseWallClock + mediaDelta;

      if (targetContextTime + item.duration < ctx.currentTime - 0.12) {
        return targetContextTime;
      }

      const srcNode = ctx.createBufferSource();
      srcNode.buffer = audioBuf;
      srcNode.playbackRate.value = rate;
      srcNode.connect(this.voiceBoostFilter || ctx.destination);

      this.activeSourceNodes.add(srcNode);
      srcNode.onended = () => {
        this.activeSourceNodes.delete(srcNode);
        srcNode.disconnect();
      };

      const scheduleAt = Math.max(ctx.currentTime, targetContextTime);
      const offset = Math.max(0, (ctx.currentTime - targetContextTime) * srcNode.playbackRate.value);
      if (offset >= audioBuf.duration) {
        this.activeSourceNodes.delete(srcNode);
        srcNode.disconnect();
        return targetContextTime;
      }
      srcNode.start(scheduleAt, offset);
      this.scheduledBuffers++;
      return targetContextTime;
    };

    try {
      // Do not consume packets against a frozen audio clock. On iOS resume
      // may stay pending until the next tap; re-anchor to the video afterward.
      if (ctx.state !== 'running') await ctx.resume();
      if (currentRunId !== this.wasmAbortId || !this.wasmActive || this.isMediaPaused()) return;
      baseWallClock = ctx.currentTime;
      baseMediaTime = this.getMediaTime();
      let pumpStartTime = baseMediaTime;
      if (initialPacket && !this.isMediaPaused()) {
        schedulePacket(initialPacket);
        pumpStartTime = Math.max(baseMediaTime, initialPacket.timestamp + initialPacket.duration);
      }

      for await (const item of this.wasmSink.buffers(pumpStartTime)) {
        if (currentRunId !== this.wasmAbortId || !this.wasmActive || this.isMediaPaused()) {
          break;
        }

        const targetContextTime = schedulePacket(item);

        // Pre-buffering adaptativo: 14 segundos para mídias no geral e 22 segundos para 4K,
        // garantindo que streams com alto bitrate ou oscilações de rede não sofram esgotamento do buffer de áudio.
        const maxAhead = this.is4KMode ? 22.0 : 14.0;
        const bufferedAhead = targetContextTime - ctx.currentTime;
        if (bufferedAhead > maxAhead) {
          await new Promise((r) => setTimeout(r, Math.min(1200, (bufferedAhead - (maxAhead - 3.5)) * 1000)));
        }
      }
    } catch (error) {
      if (currentRunId !== this.wasmAbortId) return;
      console.error('Audio decoding failed', error);
      this.stopWasmAudio();
      this.onStatus?.('Áudio indisponível: falha ao decodificar a faixa. Tente outra faixa ou abra no VLC.');
    }
  }

  /**
   * Switches the active audio track seamlessly in any of the 4 modes
   */
  public async selectAudioTrack(
    track: AudioTrack,
    onSwitchVideoUrl?: (newVideoUrl: string, resumeTime: number) => void,
    currentStreamUrl?: string
  ): Promise<{ mode: string; statusText: string }> {
    const selectionId = ++this.selectionId;
    // Silence the container before asynchronous inspection/decoding, including
    // track switches and failures. Only the selected output may become audible.
    this.suppressNativeAudio = true;
    this.applyNativeAudioPolicy();
    this.scheduledBuffers = 0;
    this.stopExternalAudio();
    this.stopWasmAudio();

    // MODE 1: Separate External Audio File (.mka, .aac, .mp3) synced to the primary video
    if (track.source_type === 'external_file' && track.externalStreamUrl) {
      const audio = new Audio(track.externalStreamUrl);
      audio.crossOrigin = 'anonymous';
      audio.currentTime = this.getMediaTime();
      audio.playbackRate = this.getMediaRate();
      audio.volume = this.userVolume;
      audio.muted = this.userMuted;
      this.videoEl.muted = true;

      this.externalAudioEl = audio;
      if (!this.isMediaPaused()) {
        await audio.play().catch(() => {});
      }

      this.syncInterval = window.setInterval(() => {
        if (this.externalAudioEl && !this.isMediaPaused()) {
          const drift = Math.abs(this.externalAudioEl.currentTime - this.getMediaTime());
          if (drift > 0.08) {
            this.externalAudioEl.currentTime = this.getMediaTime();
          }
        }
      }, 1000);

      return {
        mode: 'external_file',
        statusText: `Sincronizando arquivo de áudio externo (${track.label})`,
      };
    }

    // MODE 2: Separate Alternate Video File (e.g. Dublado vs Legendado video file)
    if (track.source_type === 'alternate_video' && track.externalStreamUrl && onSwitchVideoUrl) {
      this.suppressNativeAudio = false;
      this.nativeTrackIndex = 0;
      this.applyNativeAudioPolicy();
      const resumeAt = this.getMediaTime();
      onSwitchVideoUrl(track.externalStreamUrl, resumeAt);
      return {
        mode: 'alternate_video',
        statusText: `Alternando stream de vídeo para ${track.label}`,
      };
    }

    // MODE 3: Native HTMLMediaElement.audioTracks if supported by browser (Safari / Edge / Chrome Flag)
    const anyVideo = this.videoEl as HTMLVideoElement & {
      audioTracks?: {
        length: number;
        [index: number]: { enabled: boolean; language?: string; label?: string };
      };
    };

    const codecUpper = (track.codec || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const isDolbyAc3 = codecUpper.includes('AC3') || codecUpper.includes('EC3');

    if (!this.forceWasmMode && anyVideo.audioTracks && anyVideo.audioTracks.length > 1 && !isDolbyAc3) {
      const targetIdx = Math.min(track.track_index, anyVideo.audioTracks.length - 1);
      this.nativeTrackIndex = targetIdx;
      this.suppressNativeAudio = false;
      this.applyNativeAudioPolicy();
      return {
        mode: 'embedded_native',
        statusText: `Faixa nativa #${targetIdx + 1} ativada (${track.label})`,
      };
    }

    // MODE 4: WebAssembly Demuxer + @mediabunny/ac3 (libavcodec WASM) for Multi-Track MKV & Dolby EAC3/AC3!
    const streamToOpen = currentStreamUrl || this.videoEl.currentSrc || this.videoEl.src;
    if (streamToOpen && (this.forceWasmMode || track.track_index > 0 || isDolbyAc3)) {
      let input: Input | null = null;
      try {
        this.ensureAudioGraph();
        if (isDolbyAc3) await ensureDolbyDecoder();
        const absoluteUrl = streamToOpen.startsWith('http')
          ? streamToOpen
          : `${window.location.origin}${streamToOpen}`;
        input = new Input({
          source: new UrlSource(absoluteUrl),
          formats: [MATROSKA, WEBM, MP4],
        });
        const mTracks = await input.getAudioTracks();
        if (mTracks.length > 0) {
          const targetIdx = Math.min(track.track_index, mTracks.length - 1);
          let chosenTrack = mTracks[targetIdx];
          // The file's codec can differ from incomplete catalog metadata.
          if (/ac3|ec3/i.test(String(chosenTrack.codec || '').replace(/[^a-z0-9]/gi, ''))) {
            await ensureDolbyDecoder();
          }
          let canDec = await chosenTrack.canDecode().catch(() => false);
          let activeIdx = targetIdx;

          // Se a faixa solicitada não puder decodificar, tenta outras faixas de áudio embutidas no arquivo
          if (!canDec) {
            for (let i = 0; i < mTracks.length; i++) {
              if (i === targetIdx) continue;
              const altTrack = mTracks[i];
              if (/ac3|ec3/i.test(String(altTrack.codec || '').replace(/[^a-z0-9]/gi, ''))) {
                await ensureDolbyDecoder();
              }
              const altCanDec = await altTrack.canDecode().catch(() => false);
              if (altCanDec) {
                chosenTrack = altTrack;
                activeIdx = i;
                canDec = true;
                break;
              }
            }
          }

          if (canDec) {
            const sink = new AudioBufferSink(chosenTrack);
            // canDecode only checks registration/configuration; decode a real packet to verify WASM startup.
            const curT = this.getMediaTime() || 0;
            const probePoints = [curT, Math.max(0, curT - 0.1), curT + 0.1, curT + 0.25, curT + 0.5, curT + 1.0, 0];
            let firstBuffer: { buffer: AudioBuffer; timestamp: number; duration: number } | null = null;
            for (const pt of probePoints) {
              try {
                firstBuffer = await sink.getBuffer(pt);
                if (firstBuffer) break;
              } catch {}
            }

            // Em streams 4K ou alta latência, aguarda com tolerância se os dados do cluster inicial ainda estiverem baixando
            if (!firstBuffer) {
              for (let r = 1; r <= 3; r++) {
                await new Promise((res) => setTimeout(res, r * 300));
                try {
                  firstBuffer = (await sink.getBuffer(this.getMediaTime() || 0)) || (await sink.getBuffer(0));
                  if (firstBuffer) break;
                } catch {}
              }
            }

            if (!firstBuffer) throw new Error('No decoded audio packet at the current position');
            if (selectionId !== this.selectionId) return { mode: 'cancelled', statusText: '' };
            this.wasmInput = input;
            input = null;
            this.wasmSink = sink;
            this.wasmActive = true;
            this.videoEl.muted = true; // Mute native element while WASM decodes chosen MKV track!

            if (!this.isMediaPaused()) {
              this.startWasmPumpFrom(this.getMediaTime(), firstBuffer);
            }

            const fallbackNote = activeIdx !== targetIdx ? ' (Alternativa compatível)' : '';
            return {
              mode: 'wasm_ac3_mediabunny',
              statusText: `WASM Dolby/MKV Decoder Ativo: Faixa #${activeIdx + 1} (${track.label})${fallbackNote}`,
            };
          }
        }
        throw new Error('Selected audio track cannot be decoded');
      } catch (error) {
        if (selectionId !== this.selectionId) return { mode: 'cancelled', statusText: '' };
        console.error('Audio track selection failed', error);
        return {
          mode: 'audio_error',
          statusText: 'Áudio indisponível: não foi possível decodificar esta faixa. Tente outra faixa ou abra no VLC.',
        };
      } finally {
        input?.dispose();
      }
    }

    if (isDolbyAc3) return { mode: 'audio_error', statusText: 'Áudio indisponível: stream Dolby não encontrado.' };

    this.nativeTrackIndex = track.track_index;
    this.suppressNativeAudio = false;
    this.applyNativeAudioPolicy();
    return {
      mode: 'embedded_container',
      statusText: `Faixa do container ativa: ${track.label}`,
    };
  }

  public toggleDialogueBoost(enable?: boolean): boolean {
    const nextState = enable !== undefined ? enable : !this.dialogueBoostActive;
    try {
      const ctx = this.ensureAudioGraph();
      if (!this.wasmActive && !this.mediaElementSource) {
        try {
          this.mediaElementSource = ctx.createMediaElementSource(this.videoEl);
          this.mediaElementSource.connect(this.voiceBoostFilter!);
        } catch {
          // Element already connected
        }
      }

      if (this.voiceBoostFilter && this.compressorNode) {
        this.voiceBoostFilter.gain.value = nextState ? 7.5 : 0;
        this.compressorNode.ratio.value = nextState ? 8 : 1;
      }

      this.dialogueBoostActive = nextState;
      return this.dialogueBoostActive;
    } catch {
      this.dialogueBoostActive = false;
      return false;
    }
  }

  public stopWasmAudio() {
    this.wasmActive = false;
    this.stopActiveBufferNodes();
    this.wasmSink = null;
    if (this.wasmInput) {
      try {
        this.wasmInput.dispose();
      } catch {
        // Ignore
      }
      this.wasmInput = null;
    }
    this.applyNativeAudioPolicy();
  }

  public stopExternalAudio() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.externalAudioEl) {
      this.externalAudioEl.pause();
      this.externalAudioEl.src = '';
      this.externalAudioEl = null;
      this.applyNativeAudioPolicy();
    }
  }

  public destroy() {
    this.selectionId++;
    this.stopExternalAudio();
    this.stopWasmAudio();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.videoEl.removeEventListener('play', this.handlePlay);
    this.videoEl.removeEventListener('pause', this.handlePause);
    this.videoEl.removeEventListener('seeking', this.handleSeek);
    this.videoEl.removeEventListener('seeked', this.handleSeeked);
    this.videoEl.removeEventListener('waiting', this.handleWaiting);
    this.videoEl.removeEventListener('playing', this.handlePlaying);
    this.videoEl.removeEventListener('ratechange', this.handleRateChange);
    this.videoEl.removeEventListener('volumechange', this.handleVolumeChange);
    this.videoEl.removeEventListener('loadedmetadata', this.applyNativeAudioPolicy);
  }
}

/**
 * WebCodecs + WASM Matroska (.MKV) Canvas Video Player for iOS Chrome (CriOS), iOS Safari, and macOS Safari.
 * Since Apple's WebKit <video> element does not natively demux .mkv containers, this engine uses Mediabunny's
 * Matroska demuxer + CanvasSink (powered by iOS 16.4+ hardware VideoDecoder WebCodecs) to decode H.264/HEVC frames
 * directly onto an HTML5 <canvas>, synchronized with HybridAudioSyncController.
 */
export class MkvWebCodecsCanvasPlayer {
  private input: Input | null = null;
  private canvasSink: CanvasSink | null = null;
  private abortId = 0;
  private paused = false;
  private currentTime = 0;
  private playbackRate = 1;
  private destroyed = false;
  private waitingForFrame = true;
  private frameWaitTimer: ReturnType<typeof setTimeout> | undefined;

  public isWaitingForFrame(): boolean {
    return this.waitingForFrame;
  }

  constructor(
    private canvasEl: HTMLCanvasElement,
    private callbacks: {
      onLoadedMetadata: (durationSec: number) => void;
      onTimeUpdate: (currentTimeSec: number, bufferedEndSec: number) => void;
      onCanPlay: () => void;
      onReadyToPlay?: () => void;
      onWaiting: () => void;
      onError: (reason: string) => void;
    }
  ) {}

  public getCurrentTime(): number {
    return this.currentTime;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public async open(streamUrl: string, initialTimeSec = 0, autoplay = true): Promise<boolean> {
    this.abortId++;
    const runId = this.abortId;
    this.input?.dispose();
    this.input = null;
    this.canvasSink = null;
    this.currentTime = Math.max(0, initialTimeSec);
    this.paused = !autoplay;

    try {
      const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : `${window.location.origin}${streamUrl}`;
      const input = new Input({
        source: new UrlSource(absoluteUrl),
        formats: [MATROSKA, WEBM, MP4],
      });
      this.input = input;

      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error('Nenhuma faixa de vídeo encontrada no container MKV');

      const canDec = await videoTrack.canDecode().catch(() => false);
      if (!canDec) {
        throw new Error('Codec de vídeo não suportado via WebCodecs neste dispositivo');
      }

      const dur = await input.getDurationFromMetadata().catch(() => null);
      if (runId !== this.abortId || this.destroyed) return false;

      const displayW = (await videoTrack.getDisplayWidth().catch(() => 1920)) || 1920;
      const displayH = (await videoTrack.getDisplayHeight().catch(() => 1080)) || 1080;
      const scale = displayW > 1920 ? 1920 / displayW : 1;
      const targetW = Math.round(displayW * scale);
      const targetH = Math.round(displayH * scale);

      this.canvasEl.width = targetW;
      this.canvasEl.height = targetH;

      const { CanvasSink: CanvasSinkClass } = await import('mediabunny');
      this.canvasSink = new CanvasSinkClass(videoTrack, {
        width: targetW,
        height: targetH,
        fit: 'contain',
        poolSize: 3,
        decoderOptions: {
          hardwareAcceleration: 'prefer-hardware',
          optimizeForLatency: false,
        },
      });

      if (dur && Number.isFinite(dur) && dur > 0) {
        this.callbacks.onLoadedMetadata(dur);
      }

      if (!this.paused) {
        void this.pumpFramesFrom(this.currentTime);
      } else {
        // Do not wait for a decoded preview before offering the start button.
        // On iOS decoding may only begin after the user's playback gesture.
        this.callbacks.onReadyToPlay?.();
      }
      return true;
    } catch (err) {
      if (runId !== this.abortId || this.destroyed) return false;
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private async pumpFramesFrom(startTimeSec: number) {
    if (!this.canvasSink || this.destroyed) return;
    this.abortId++;
    const runId = this.abortId;
    const ctx2d = this.canvasEl.getContext('2d');
    if (!ctx2d) return;

    this.waitingForFrame = true;
    clearTimeout(this.frameWaitTimer);
    this.callbacks.onWaiting();
    let lastUiUpdateSec = -Infinity;
    let anchored = false;
    let baseWallMs = performance.now();
    let baseMediaSec = Math.max(0, startTimeSec);

    try {
      for await (const wrapped of this.canvasSink.canvases(baseMediaSec)) {
        clearTimeout(this.frameWaitTimer);
        if (runId !== this.abortId || this.paused || this.destroyed) break;

        if (!anchored || this.waitingForFrame) {
          anchored = true;
          baseWallMs = performance.now();
          baseMediaSec = wrapped.timestamp;
        }

        const rate = this.playbackRate || 1;
        const targetWallMs = baseWallMs + ((wrapped.timestamp - baseMediaSec) / rate) * 1000;
        const waitMs = targetWallMs - performance.now();

        if (waitMs > 4) {
          while (targetWallMs - performance.now() > 4) {
            await new Promise((r) => setTimeout(r, Math.min(targetWallMs - performance.now(), 100)));
            if (runId !== this.abortId || this.paused || this.destroyed) return;
          }
          if (runId !== this.abortId || this.paused || this.destroyed) break;
        } else if (waitMs < -180) {
          this.waitingForFrame = true;
          this.callbacks.onWaiting();
          // Slow devices must still display decoded frames. Re-anchor rather
          // than dropping every frame and leaving a black canvas with audio.
          baseWallMs = performance.now();
          baseMediaSec = wrapped.timestamp;
        }

        ctx2d.drawImage(wrapped.canvas, 0, 0, this.canvasEl.width, this.canvasEl.height);
        this.canvasEl.dataset.presentedFrames = String(Number(this.canvasEl.dataset.presentedFrames || 0) + 1);
        this.currentTime = wrapped.timestamp;
        if (this.waitingForFrame) {
          this.waitingForFrame = false;
          this.callbacks.onCanPlay();
        }
        // Keep the audio clock frame-accurate without rerendering React at 24–60 fps.
        if (wrapped.timestamp - lastUiUpdateSec >= 0.25) {
          lastUiUpdateSec = wrapped.timestamp;
          this.callbacks.onTimeUpdate(wrapped.timestamp, wrapped.timestamp + 4);
        }
        // Silence queued audio while waiting for another decoded frame, not
        // only after that delayed frame finally arrives.
        this.frameWaitTimer = setTimeout(() => {
          if (runId !== this.abortId || this.paused || this.destroyed) return;
          this.waitingForFrame = true;
          this.callbacks.onWaiting();
        }, 250);
      }
      if (runId === this.abortId) clearTimeout(this.frameWaitTimer);
    } catch (err) {
      if (runId !== this.abortId || this.destroyed) return;
      clearTimeout(this.frameWaitTimer);
      console.warn('WebCodecs MKV frame pump error:', err);
      this.paused = true;
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }

  public play() {
    if (!this.paused && this.canvasSink) return;
    this.paused = false;
    void this.pumpFramesFrom(this.currentTime);
  }

  public pause() {
    clearTimeout(this.frameWaitTimer);
    this.paused = true;
    this.abortId++;
  }

  public seek(timeSec: number) {
    this.currentTime = Math.max(0, timeSec);
    this.abortId++;
    if (!this.paused) {
      void this.pumpFramesFrom(this.currentTime);
    }
  }

  public setPlaybackRate(rate: number) {
    this.playbackRate = rate || 1;
    if (!this.paused) {
      void this.pumpFramesFrom(this.currentTime);
    }
  }

  public destroy() {
    clearTimeout(this.frameWaitTimer);
    this.destroyed = true;
    this.abortId++;
    this.canvasSink = null;
    try {
      this.input?.dispose();
    } catch {
      // Ignore
    }
    this.input = null;
  }
}

export interface VttCueItem {
  start: number;
  end: number;
  text: string;
}

function parseVttTimestamp(ts: string): number {
  const parts = ts.trim().split(':');
  if (parts.length === 3) {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2].replace(',', '.'));
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const m = parseFloat(parts[0]);
    const s = parseFloat(parts[1].replace(',', '.'));
    return m * 60 + s;
  }
  return 0;
}

/**
 * Parses a WebVTT or SRT string into an array of timed cues so our custom Netflix overlay
 * can render subtitles with adjustable font size, delay offset (±0.5s), and custom styling.
 */
export function parseWebVttCues(vttText: string): VttCueItem[] {
  const cues: VttCueItem[] = [];
  const blocks = vttText.replace(/\r\n/g, '\n').split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const arrowLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowLineIdx === -1) continue;

    const timeLine = lines[arrowLineIdx];
    const [startRaw, endRaw] = timeLine.split('-->');
    if (!startRaw || !endRaw) continue;

    const start = parseVttTimestamp(startRaw.trim().split(' ')[0]);
    const end = parseVttTimestamp(endRaw.trim().split(' ')[0]);
    const text = lines
      .slice(arrowLineIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (text && end > start) {
      cues.push({ start, end, text });
    }
  }

  return cues;
}
