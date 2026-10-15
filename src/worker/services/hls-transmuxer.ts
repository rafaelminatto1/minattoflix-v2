import { Transmuxer } from 'mux.js';
import type { KVNamespaceBinding } from '../db';

/**
 * HLS Transmuxer Service for iOS Safari Compatibility
 * 
 * Transmuxes MKV/WebM streams to fMP4 segments for HLS delivery
 * Works on Cloudflare Workers with streaming support
 */

export interface HlsStreamOptions {
  videoCodec?: string;      // e.g., 'hev1', 'avc1'
  audioCodec?: string;      // e.g., 'ec-3', 'mp4a'
  segmentDuration?: number; // seconds, default 6
  maxSegments?: number;     // for live window, default 10
}

export interface HlsSegment {
  number: number;
  data: Uint8Array;
  duration: number;
  isKeyframe: boolean;
}

export interface HlsPlaylist {
  version: number;
  targetDuration: number;
  mediaSequence: number;
  segments: HlsSegment[];
  isEndOfStream: boolean;
}

class WorkerTransmuxer {
  private transmuxer: Transmuxer;
  private videoTrack: any = null;
  private audioTrack: any = null;
  private segmentNumber = 0;
  private initSegment: Uint8Array | null = null;
  private pendingSegments: HlsSegment[] = [];
  private isFirstSegment = true;
  private options: Required<HlsStreamOptions>;
  private onSegment: (segment: HlsSegment) => Promise<void>;
  private onInitSegment: (initSegment: Uint8Array) => Promise<void>;
  private closed = false;

  constructor(
    options: HlsStreamOptions,
    onSegment: (segment: HlsSegment) => Promise<void>,
    onInitSegment: (initSegment: Uint8Array) => Promise<void>
  ) {
    this.options = {
      videoCodec: options.videoCodec || 'avc1',
      audioCodec: options.audioCodec || 'mp4a',
      segmentDuration: options.segmentDuration || 6,
      maxSegments: options.maxSegments || 10,
    };

    this.onSegment = onSegment;
    this.onInitSegment = onInitSegment;

    this.transmuxer = new Transmuxer({
      remux: true,
      keepOriginalTimestamps: true,
      gopCache: true,
    });

    this.setupTransmuxerEvents();
  }

  private setupTransmuxerEvents() {
    this.transmuxer.on('data', (segment: any) => {
      if (this.closed) return;

      if (segment.type === 'init') {
        this.initSegment = new Uint8Array(segment.data);
        this.onInitSegment(this.initSegment).catch(console.error);
        return;
      }

      if (segment.type === 'video' || segment.type === 'audio') {
        const trackData = segment.track;
        const segmentData = new Uint8Array(segment.data);
        const duration = segment.duration || this.options.segmentDuration;

        const hlsSegment: HlsSegment = {
          number: this.segmentNumber++,
          data: segmentData,
          duration,
          isKeyframe: trackData.isKeyframe || false,
        };

        this.pendingSegments.push(hlsSegment);

        // Trim old segments if exceeding max window
        if (this.pendingSegments.length > this.options.maxSegments) {
          this.pendingSegments.shift();
        }

        this.onSegment(hlsSegment).catch(console.error);
      }
    });

    this.transmuxer.on('done', () => {
      // Flush any remaining data
      this.transmuxer.flush();
    });
  }

  push(data: Uint8Array) {
    if (this.closed) return;
    this.transmuxer.push(data);
  }

  flush() {
    if (this.closed) return;
    this.transmuxer.flush();
  }

  close() {
    this.closed = true;
    this.transmuxer = null as any;
  }

  getInitSegment(): Uint8Array | null {
    return this.initSegment;
  }

  getSegments(): HlsSegment[] {
    return [...this.pendingSegments];
  }

  getMediaSequence(): number {
    return this.pendingSegments.length > 0 ? this.pendingSegments[0].number : this.segmentNumber;
  }
}

/**
 * Creates an HLS master playlist (.m3u8)
 */
export function generateMasterPlaylist(
  streamUrl: string,
  videoCodecs: string[] = ['avc1'],
  audioCodecs: string[] = ['mp4a', 'ec-3']
): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '',
  ];

  for (const vCodec of videoCodecs) {
    for (const aCodec of audioCodecs) {
      const codecStr = `${vCodec},${aCodec}`;
      const bandwidth = vCodec.startsWith('hev1') ? 8000000 : 5000000;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecStr}",RESOLUTION=1920x1080`,
        `${streamUrl}/playlist.m3u8?vcodec=${vCodec}&acodec=${aCodec}`,
        ''
      );
    }
  }

  return lines.join('\n');
}

/**
 * Generates a media playlist (.m3u8) for a specific quality
 */
export function generateMediaPlaylist(playlist: HlsPlaylist): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${playlist.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`,
    '',
  ];

  for (const segment of playlist.segments) {
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    lines.push(`segment/${segment.number}.m4s`);
    lines.push('');
  }

  if (playlist.isEndOfStream) {
    lines.push('#EXT-X-ENDLIST');
  }

  return lines.join('\n');
}

/**
 * Streaming HLS transmuxer that pipes from upstream (GDrive/OneDrive) to HLS segments
 */
export class HlsStreamingTransmuxer {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private transmuxer: WorkerTransmuxer | null = null;
  private upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private initSegmentSent = false;
  private segmentQueue: Uint8Array[] = [];
  private isProcessing = false;
  private options: Required<HlsStreamOptions>;
  private videoCodec: string;
  private audioCodec: string;

  constructor(options: HlsStreamOptions = {}) {
    this.options = {
      videoCodec: options.videoCodec || 'avc1',
      audioCodec: options.audioCodec || 'mp4a',
      segmentDuration: options.segmentDuration || 6,
      maxSegments: options.maxSegments || 10,
    };
    this.videoCodec = this.options.videoCodec;
    this.audioCodec = this.options.audioCodec;
  }

  /**
   * Creates a readable stream that outputs HLS segments
   */
  createSegmentStream(upstreamResponse: Response): ReadableStream<Uint8Array> {
    const upstreamBody = upstreamResponse.body;
    if (!upstreamBody) {
      throw new Error('Upstream response has no body');
    }

    this.upstreamReader = upstreamBody.getReader();

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.initializeTransmuxer();
        this.processUpstream();
      },
      pull: () => {
        // Backpressure handled by segment queue
      },
      cancel: () => {
        this.cleanup();
      },
    });
  }

  private initializeTransmuxer() {
    this.transmuxer = new WorkerTransmuxer(
      this.options,
      async (segment) => {
        this.segmentQueue.push(segment.data);
        this.drainQueue();
      },
      async (initSegment) => {
        if (!this.initSegmentSent && this.controller) {
          this.controller.enqueue(initSegment);
          this.initSegmentSent = true;
        }
      }
    );
  }

  private async processUpstream() {
    if (!this.upstreamReader || this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        const { done, value } = await this.upstreamReader.read();
        if (done) break;

        if (this.transmuxer && value) {
          this.transmuxer.push(value);
        }
      }

      // Flush remaining
      if (this.transmuxer) {
        this.transmuxer.flush();
      }
    } catch (error) {
      console.error('HLS transmuxer upstream error:', error);
      if (this.controller) {
        this.controller.error(error);
      }
    } finally {
      this.isProcessing = false;
      if (this.controller) {
        this.controller.close();
      }
    }
  }

  private drainQueue() {
    if (!this.controller || this.segmentQueue.length === 0) return;

    while (this.segmentQueue.length > 0) {
      const segment = this.segmentQueue.shift()!;
      if (this.controller.desiredSize !== null && this.controller.desiredSize <= 0) {
        // Backpressure - wait for pull
        this.segmentQueue.unshift(segment);
        break;
      }
      this.controller.enqueue(segment);
    }
  }

  public cleanup() {
    if (this.upstreamReader) {
      this.upstreamReader.cancel().catch(() => {});
      this.upstreamReader = null;
    }
    if (this.transmuxer) {
      this.transmuxer.close();
      this.transmuxer = null;
    }
  }
}

/**
 * Simplified HLS endpoint handler for Cloudflare Workers
 * Serves HLS manifest and segments on-demand
 */
export class HlsEndpointHandler {
  private segments: Map<number, Uint8Array> = new Map();
  private initSegment: Uint8Array | null = null;
  private mediaSequence = 0;
  private targetDuration = 6;
  private isEndOfStream = false;
  private transmuxer: HlsStreamingTransmuxer | null = null;
  private upstreamResponse: Response | null = null;
  private segmentStream: ReadableStream<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private consuming = false;

  async initialize(
    upstreamResponse: Response,
    options: HlsStreamOptions = {}
  ) {
    this.upstreamResponse = upstreamResponse;
    this.transmuxer = new HlsStreamingTransmuxer(options);
    
    // Create segment stream and start consuming it
    this.segmentStream = this.transmuxer.createSegmentStream(upstreamResponse);
    this.reader = this.segmentStream.getReader();
    this.consuming = true;
    this.consumeSegments();
  }

  private async consumeSegments() {
    if (!this.reader || !this.consuming) return;
    
    try {
      while (this.consuming) {
        const { done, value } = await this.reader.read();
        if (done) {
          this.isEndOfStream = true;
          break;
        }
        if (value) {
          // The value from HlsStreamingTransmuxer is the raw segment data
          // We need to parse it to extract init segment and media segments
          // For now, store raw - the transmuxer outputs fMP4 segments
          const segmentNum = this.segments.size;
          this.segments.set(segmentNum, value);
        }
      }
    } catch (err) {
      console.error('HLS segment consumption error:', err);
      this.isEndOfStream = true;
    }
  }

  getInitSegment(): Uint8Array | null {
    return this.initSegment;
  }

  getSegment(number: number): Uint8Array | null {
    return this.segments.get(number) || null;
  }

  generatePlaylist(): string {
    const segments: HlsSegment[] = [];
    for (let i = this.mediaSequence; i < this.mediaSequence + this.segments.size; i++) {
      const data = this.segments.get(i);
      if (data) {
        segments.push({ number: i, data, duration: this.targetDuration, isKeyframe: true });
      }
    }

    return generateMediaPlaylist({
      version: 6,
      targetDuration: this.targetDuration,
      mediaSequence: this.mediaSequence,
      segments,
      isEndOfStream: this.isEndOfStream,
    });
  }

  close() {
    this.consuming = false;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.segmentStream = null;
    this.transmuxer?.cleanup();
    this.transmuxer = null;
  }
}

/**
 * Detects if the client is iOS Safari and needs HLS
 * Note: This should be called on the client side where window is available
 */
export function needsHlsTransmuxing(userAgent: string, isClientSide = false): boolean {
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) && (!isClientSide || !(window as any).MSStream);
  const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);
  return isIOS || (isSafari && /Macintosh/.test(userAgent));
}

/**
 * Detects video codec from container/stream info
 */
export function detectVideoCodec(container: string, videoCodec: string): string {
  const codec = videoCodec.toLowerCase();
  if (codec.includes('hevc') || codec.includes('h265') || codec.includes('hev1')) {
    return 'hev1.1.6.L93.90'; // HEVC Main 10, Level 5.1
  }
  if (codec.includes('avc') || codec.includes('h264') || codec.includes('avc1')) {
    return 'avc1.640028'; // H.264 High Profile Level 4.1
  }
  if (codec.includes('vp9') || codec.includes('vp09')) {
    return 'vp09.00.10.08'; // VP9 Profile 0
  }
  if (codec.includes('av1') || codec.includes('av01')) {
    return 'av01.0.05M.08'; // AV1 Main Profile
  }
  // Default based on container
  if (container === 'mkv' || container === 'webm') {
    return 'avc1.640028';
  }
  return 'avc1.640028';
}

/**
 * Detects audio codec
 */
export function detectAudioCodec(audioCodec: string): string {
  const codec = audioCodec.toLowerCase();
  if (codec.includes('eac3') || codec.includes('ec-3') || codec.includes('ddp')) {
    return 'ec-3'; // Dolby Digital Plus (E-AC-3)
  }
  if (codec.includes('ac3') || codec.includes('ac-3') || codec.includes('dd')) {
    return 'ac-3'; // Dolby Digital (AC-3)
  }
  if (codec.includes('aac') || codec.includes('mp4a')) {
    return 'mp4a.40.2'; // AAC-LC
  }
  if (codec.includes('opus')) {
    return 'opus';
  }
  if (codec.includes('flac')) {
    return 'flac';
  }
  return 'mp4a.40.2'; // Default AAC
}