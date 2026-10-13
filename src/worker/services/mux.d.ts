declare module 'mux.js' {
  export interface TransmuxerOptions {
    remux?: boolean;
    keepOriginalTimestamps?: boolean;
    gopCache?: boolean;
  }

  export class Transmuxer {
    constructor(options?: TransmuxerOptions);
    on(event: 'data', callback: (segment: TransmuxerSegment) => void): void;
    on(event: 'done', callback: () => void): void;
    push(data: Uint8Array): void;
    flush(): void;
  }

  export interface TransmuxerSegment {
    type: 'init' | 'video' | 'audio';
    data: ArrayBuffer;
    track: {
      isKeyframe?: boolean;
    };
    duration?: number;
  }
}