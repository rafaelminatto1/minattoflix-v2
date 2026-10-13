/**
 * Binary EBML / Matroska (.mkv / .webm) Track Header Inspector, Cluster Subtitle Extractor & WebVTT Converter.
 * 1. Reads the first 256KB of a Matroska file via HTTP Range Request to parse Segment -> Tracks -> TrackEntry (0x1654AE6B).
 * 2. Scans Matroska Clusters (0x1F43B675) -> SimpleBlock (0xA3) / BlockGroup (0xA0) to extract real embedded
 *    text subtitle cues (S_TEXT/UTF8 & S_TEXT/ASS) directly from the .MKV stream!
 */

export interface ProbedMkvTrack {
  trackNumber: number;
  trackType: 'video' | 'audio' | 'subtitle' | 'other';
  codecId: string;
  language: string;
  name: string;
  isDefault: boolean;
  isForced: boolean;
  channels?: number;
  samplingFrequency?: number;
}

const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_FLAG_DEFAULT = 0x88;
const ID_FLAG_FORCED = 0x55aa;
const ID_NAME = 0x536e;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_IETF = 0x22b59d;
const ID_CODEC_ID = 0x86;
const ID_AUDIO = 0xe1;
const ID_CHANNELS = 0x9f;
const ID_SAMPLING_FREQ = 0xb5;

// Cluster & Block IDs for embedded subtitle extraction
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

function readVint(buf: Uint8Array, offset: number, maskLength = true): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || offset + length > buf.length) return null;

  let value = maskLength ? first & (mask - 1) : first;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[offset + i];
  }
  return { value, length };
}

function readUint(buf: Uint8Array, offset: number, len: number): number {
  let val = 0;
  for (let i = 0; i < len && offset + i < buf.length; i++) {
    val = val * 256 + buf[offset + i];
  }
  return val;
}

function readUtf8(buf: Uint8Array, offset: number, len: number): string {
  const slice = buf.subarray(offset, Math.min(buf.length, offset + len));
  return new TextDecoder('utf-8').decode(slice).replace(/\0+$/, '').trim();
}

function parseTrackEntry(buf: Uint8Array, start: number, end: number): ProbedMkvTrack {
  let pos = start;
  let trackNumber = 1;
  let trackTypeNum = 0;
  let codecId = '';
  let language = 'und';
  let languageIetf = '';
  let name = '';
  let isDefault = true;
  let isForced = false;
  let channels: number | undefined;
  let samplingFrequency: number | undefined;

  while (pos < end) {
    const idObj = readVint(buf, pos, false);
    if (!idObj) break;
    pos += idObj.length;

    const sizeObj = readVint(buf, pos, true);
    if (!sizeObj) break;
    pos += sizeObj.length;

    const dataEnd = Math.min(end, pos + sizeObj.value);
    const id = idObj.value;

    if (id === ID_TRACK_NUMBER) {
      trackNumber = readUint(buf, pos, sizeObj.value);
    } else if (id === ID_TRACK_TYPE) {
      trackTypeNum = readUint(buf, pos, sizeObj.value);
    } else if (id === ID_FLAG_DEFAULT) {
      isDefault = readUint(buf, pos, sizeObj.value) !== 0;
    } else if (id === ID_FLAG_FORCED) {
      isForced = readUint(buf, pos, sizeObj.value) !== 0;
    } else if (id === ID_NAME) {
      name = readUtf8(buf, pos, sizeObj.value);
    } else if (id === ID_LANGUAGE) {
      language = readUtf8(buf, pos, sizeObj.value);
    } else if (id === ID_LANGUAGE_IETF) {
      languageIetf = readUtf8(buf, pos, sizeObj.value);
    } else if (id === ID_CODEC_ID) {
      codecId = readUtf8(buf, pos, sizeObj.value);
    } else if (id === ID_AUDIO) {
      let aPos = pos;
      while (aPos < dataEnd) {
        const aId = readVint(buf, aPos, false);
        if (!aId) break;
        aPos += aId.length;
        const aSize = readVint(buf, aPos, true);
        if (!aSize) break;
        aPos += aSize.length;
        if (aId.value === ID_CHANNELS) {
          channels = readUint(buf, aPos, aSize.value);
        } else if (aId.value === ID_SAMPLING_FREQ && aSize.value === 4) {
          const view = new DataView(buf.buffer, buf.byteOffset + aPos, 4);
          samplingFrequency = Math.round(view.getFloat32(0, false));
        }
        aPos += aSize.value;
      }
    }

    pos = dataEnd;
  }

  const trackType: ProbedMkvTrack['trackType'] =
    trackTypeNum === 1 ? 'video' : trackTypeNum === 2 ? 'audio' : trackTypeNum === 17 ? 'subtitle' : 'other';

  const normalizedLang = normalizeLanguageCode(languageIetf || language, name);

  return {
    trackNumber,
    trackType,
    codecId,
    language: normalizedLang,
    name,
    isDefault,
    isForced,
    channels,
    samplingFrequency,
  };
}

export function normalizeLanguageCode(rawLang: string, trackName = ''): string {
  const l = (rawLang || '').toLowerCase();
  const n = (trackName || '').toLowerCase();
  if (l.startsWith('pt') || l === 'por' || l === 'pb' || n.includes('portug') || n.includes('dublado') || n.includes('pt-br')) {
    return 'pt-BR';
  }
  if (l.startsWith('en') || l === 'eng' || n.includes('english') || n.includes('ingl')) {
    return 'en-US';
  }
  if (l.startsWith('es') || l === 'spa' || n.includes('espan') || n.includes('spanish')) {
    return 'es-ES';
  }
  if (l.startsWith('ja') || l === 'jpn' || n.includes('japan') || n.includes('japon')) {
    return 'ja-JP';
  }
  if (l.startsWith('fr') || l === 'fre' || l === 'fra') {
    return 'fr-FR';
  }
  return rawLang && rawLang !== 'und' ? rawLang : 'pt-BR';
}

export function formatTrackLabel(track: ProbedMkvTrack, indexWithinType: number): string {
  const langMap: Record<string, string> = {
    'pt-BR': 'Português (Brasil)',
    'en-US': 'Inglês (Original)',
    'es-ES': 'Espanhol',
    'ja-JP': 'Japonês (Original)',
    'fr-FR': 'Francês',
  };
  const baseLang = langMap[track.language] || track.language || `Faixa ${indexWithinType + 1}`;
  const chLabel = track.channels ? (track.channels >= 6 ? '5.1' : track.channels === 2 ? '2.0' : `${track.channels}ch`) : '';
  const codecClean = track.codecId
    .replace(/^A_/, '')
    .replace(/^S_TEXT\//, '')
    .replace('UTF8', 'SRT');

  if (track.trackType === 'audio') {
    const customName = track.name ? ` — ${track.name}` : indexWithinType === 0 ? ' [Dublado]' : '';
    const tech = [chLabel, codecClean].filter(Boolean).join(' ');
    return `${baseLang}${customName}${tech ? ` (${tech})` : ''}`;
  }

  if (track.trackType === 'subtitle') {
    const forcedTag = track.isForced || /for[cç]ad/i.test(track.name) ? ' [Forçada]' : ' [Completa]';
    const customName = track.name && !/for[cç]ad/i.test(track.name) ? ` (${track.name})` : '';
    return `${baseLang}${customName}${forcedTag}`;
  }

  return track.name || baseLang;
}

export function parseMkvTracksFromBuffer(buf: Uint8Array): ProbedMkvTrack[] {
  const tracks: ProbedMkvTrack[] = [];

  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0x16 && buf[i + 1] === 0x54 && buf[i + 2] === 0xae && buf[i + 3] === 0x6b) {
      let pos = i + 4;
      const sizeObj = readVint(buf, pos, true);
      if (!sizeObj) continue;
      pos += sizeObj.length;
      const tracksEnd = Math.min(buf.length, pos + sizeObj.value);

      while (pos < tracksEnd) {
        const entryId = readVint(buf, pos, false);
        if (!entryId) break;
        pos += entryId.length;
        const entrySize = readVint(buf, pos, true);
        if (!entrySize) break;
        pos += entrySize.length;

        const entryEnd = Math.min(tracksEnd, pos + entrySize.value);
        if (entryId.value === ID_TRACK_ENTRY) {
          const parsed = parseTrackEntry(buf, pos, entryEnd);
          if (parsed.trackType !== 'other') {
            tracks.push(parsed);
          }
        }
        pos = entryEnd;
      }

      if (tracks.length > 0) break;
    }
  }

  return tracks;
}

function formatMsToVttTime(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
    2,
    '0'
  )}.${String(millis).padStart(3, '0')}`;
}

/**
 * Scans Matroska Clusters (0x1F 0x43 0xB6 0x75) inside a binary buffer to extract real embedded
 * subtitle blocks (BlockGroup / SimpleBlock) for a given subtitle TrackNumber.
 */
export function extractEmbeddedSubtitlesFromMkvBuffer(
  buf: Uint8Array,
  targetTrackNumbers: Set<number>
): Array<{ startMs: number; endMs: number; text: string }> {
  const cues: Array<{ startMs: number; endMs: number; text: string }> = [];

  for (let i = 0; i < buf.length - 8; i++) {
    // Look for Cluster ID: 0x1F 0x43 0xB6 0x75
    if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
      let pos = i + 4;
      const clusterSize = readVint(buf, pos, true);
      if (!clusterSize) continue;
      pos += clusterSize.length;
      const clusterEnd = Math.min(buf.length, pos + clusterSize.value);

      let clusterTimestamp = 0;

      while (pos < clusterEnd - 2) {
        const elId = readVint(buf, pos, false);
        if (!elId) break;
        pos += elId.length;
        const elSize = readVint(buf, pos, true);
        if (!elSize) break;
        pos += elSize.length;

        const elEnd = Math.min(clusterEnd, pos + elSize.value);

        if (elId.value === ID_CLUSTER_TIMESTAMP) {
          clusterTimestamp = readUint(buf, pos, elSize.value);
        } else if (elId.value === ID_SIMPLE_BLOCK) {
          const trackVint = readVint(buf, pos, true);
          if (trackVint && targetTrackNumbers.has(trackVint.value) && pos + trackVint.length + 3 < elEnd) {
            const relTimeOffset = pos + trackVint.length;
            const relTime = (buf[relTimeOffset] << 8) | buf[relTimeOffset + 1];
            const signedRel = relTime >= 0x8000 ? relTime - 0x10000 : relTime;
            const payloadStart = relTimeOffset + 3;
            const rawText = readUtf8(buf, payloadStart, elEnd - payloadStart)
              .replace(/\{[^}]*\}/g, '')
              .replace(/\\N/g, '\n')
              .trim();
            if (rawText.length > 0) {
              const startMs = clusterTimestamp + signedRel;
              cues.push({ startMs, endMs: startMs + 3500, text: rawText });
            }
          }
        } else if (elId.value === ID_BLOCK_GROUP) {
          let bgPos = pos;
          let blockTrack = -1;
          let blockRelTime = 0;
          let blockDuration = 3200;
          let blockText = '';

          while (bgPos < elEnd - 2) {
            const bId = readVint(buf, bgPos, false);
            if (!bId) break;
            bgPos += bId.length;
            const bSize = readVint(buf, bgPos, true);
            if (!bSize) break;
            bgPos += bSize.length;
            const bEnd = Math.min(elEnd, bgPos + bSize.value);

            if (bId.value === ID_BLOCK) {
              const tv = readVint(buf, bgPos, true);
              if (tv && targetTrackNumbers.has(tv.value) && bgPos + tv.length + 3 <= bEnd) {
                blockTrack = tv.value;
                const rtOff = bgPos + tv.length;
                const rt = (buf[rtOff] << 8) | buf[rtOff + 1];
                blockRelTime = rt >= 0x8000 ? rt - 0x10000 : rt;
                const pStart = rtOff + 3;
                blockText = readUtf8(buf, pStart, bEnd - pStart)
                  .replace(/\{[^}]*\}/g, '')
                  .replace(/\\N/g, '\n')
                  .trim();
              }
            } else if (bId.value === ID_BLOCK_DURATION) {
              blockDuration = readUint(buf, bgPos, bSize.value);
            }
            bgPos = bEnd;
          }

          if (blockTrack !== -1 && blockText.length > 0) {
            const startMs = clusterTimestamp + blockRelTime;
            cues.push({
              startMs,
              endMs: startMs + Math.max(800, blockDuration),
              text: blockText,
            });
          }
        }

        pos = elEnd;
      }

      i = Math.max(i, clusterEnd - 1);
    }
  }

  return cues;
}

export function cuesToWebVtt(cues: Array<{ startMs: number; endMs: number; text: string }>): string {
  const lines = ['WEBVTT', ''];
  cues.forEach((c, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${formatMsToVttTime(c.startMs)} --> ${formatMsToVttTime(c.endMs)}`);
    lines.push(c.text);
    lines.push('');
  });
  return lines.join('\n');
}

export function convertToWebVtt(rawContent: string, formatHint = 'srt'): string {
  const trimmed = rawContent.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('WEBVTT')) {
    return trimmed;
  }

  if (formatHint === 'ass' || formatHint === 'ssa' || trimmed.includes('[Events]')) {
    const lines = trimmed.split(/\r?\n/);
    const vttLines = ['WEBVTT', ''];
    let idx = 1;
    for (const line of lines) {
      if (line.startsWith('Dialogue:')) {
        const parts = line.slice(9).split(',');
        if (parts.length >= 10) {
          const start = parts[1].trim();
          const end = parts[2].trim();
          const text = parts
            .slice(9)
            .join(',')
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\N/g, '\n')
            .replace(/\\n/g, '\n')
            .trim();
          if (text) {
            const padTime = (t: string) => {
              const segs = t.split(':');
              if (segs.length === 3) {
                const h = segs[0].padStart(2, '0');
                const m = segs[1].padStart(2, '0');
                const [s, cs = '00'] = segs[2].split('.');
                return `${h}:${m}:${s.padStart(2, '0')}.${cs.padEnd(3, '0').slice(0, 3)}`;
              }
              return t;
            };
            vttLines.push(`${idx++}`);
            vttLines.push(`${padTime(start)} --> ${padTime(end)}`);
            vttLines.push(text);
            vttLines.push('');
          }
        }
      }
    }
    return vttLines.join('\n');
  }

  const normalized = trimmed
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

  return `WEBVTT\n\n${normalized}\n`;
}
