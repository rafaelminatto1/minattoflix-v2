export interface ParsedReleaseInfo {
  cleanTitle: string;
  slug: string;
  year: number | null;
  type: 'movie' | 'series';
  seasonNumber: number | null;
  episodeNumber: number | null;
  resolution: '2160p' | '1080p' | '720p' | '480p';
  videoCodec: 'x265' | 'x264' | 'AV1';
  dynamicRange: 'HDR10+' | 'HDR10' | 'DV' | 'SDR';
  audioChannels: '7.1' | '5.1' | '2.0';
  isDualAudio: boolean;
  fileRole: 'primary_video' | 'dub_video' | 'sub_video' | 'external_audio' | 'external_subtitle' | 'ignored';
  languageHint: string;
  isForcedSubtitle: boolean;
  container: string;
}

const IGNORED_EXTENSIONS = new Set(['url', 'txt', 'nfo', 'jpg', 'jpeg', 'png', 'exe', 'bat', 'html', 'htm', 'ds_store', 'ini']);
const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'webm', 'avi', 'm4v', 'mov', 'ts']);
const AUDIO_EXTENSIONS = new Set(['mka', 'aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus', 'ogg', 'wav', 'm4a']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub']);

export function parseReleaseName(filename: string, folderName?: string): ParsedReleaseInfo {
  const extMatch = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const lowerName = filename.toLowerCase();

  let fileRole: ParsedReleaseInfo['fileRole'] = 'ignored';
  if (IGNORED_EXTENSIONS.has(ext) || lowerName.includes('baixar filmes') || lowerName.includes('leia-me')) {
    fileRole = 'ignored';
  } else if (VIDEO_EXTENSIONS.has(ext)) {
    if (/\b(legendado|leg|subbed)\b/i.test(filename) && !/\bdual\b/i.test(filename)) {
      fileRole = 'sub_video';
    } else if (/\b(dublado|dub|pt-?br)\b/i.test(filename) && !/\bdual\b/i.test(filename)) {
      fileRole = 'dub_video';
    } else {
      fileRole = 'primary_video';
    }
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    fileRole = 'external_audio';
  } else if (SUBTITLE_EXTENSIONS.has(ext)) {
    fileRole = 'external_subtitle';
  }

  // Detect language hints for external audio/subtitle files
  let languageHint = 'pt-BR';
  if (/\b(en|eng|english|ingles|inglês|original)\b/i.test(filename)) {
    languageHint = 'en-US';
  } else if (/\b(es|esp|spanish|espanhol)\b/i.test(filename)) {
    languageHint = 'es-ES';
  } else if (/\b(ja|jpn|japanese|japones)\b/i.test(filename)) {
    languageHint = 'ja-JP';
  }

  const isForcedSubtitle = /\b(forced|forcada|forçada)\b/i.test(filename);

  let sourceString = folderName && folderName.length > 3 ? folderName : filename.replace(/\.[a-z0-9]+$/i, '');
  // Clean website advertising prefixes e.g. www UIndex org:
  sourceString = sourceString.replace(/^www[\.\s_-]\w+[\.\s_-](?:org|com|net|to|me|info)[:\s_-]*/i, '');

  // Check series pattern S01E01, S01EP01, or S104
  const seriesMatch =
    sourceString.match(/\bS(\d{1,2})(?:E|EP)(\d{1,3})\b/i) ||
    sourceString.match(/\bS(\d{1})(\d{2})\b/i) ||
    filename.match(/\bS(\d{1,2})(?:E|EP)(\d{1,3})\b/i) ||
    filename.match(/\bS(\d{1})(\d{2})\b/i);

  const isSeriesFolder = /\b(\d+ª?\s+temporada|temporada\s+\d+|season\s+\d+)\b/i.test(sourceString);
  const type: 'movie' | 'series' = seriesMatch || isSeriesFolder ? 'series' : 'movie';
  let seasonNumber = seriesMatch ? parseInt(seriesMatch[1], 10) : null;
  const episodeNumber = seriesMatch ? parseInt(seriesMatch[2], 10) : null;
  if (!seasonNumber && isSeriesFolder) {
    const sMatch = sourceString.match(/\b(?:(\d+)ª?\s+temporada|temporada\s+(\d+)|season\s+(\d+))\b/i);
    if (sMatch) {
      seasonNumber = parseInt(sMatch[1] || sMatch[2] || sMatch[3], 10);
    }
  }

  // Resolution
  let resolution: ParsedReleaseInfo['resolution'] = '1080p';
  if (/\b(2160p|4k|uhd)\b/i.test(sourceString)) resolution = '2160p';
  else if (/\b720p\b/i.test(sourceString)) resolution = '720p';
  else if (/\b480p\b/i.test(sourceString)) resolution = '480p';

  // Video Codec
  let videoCodec: ParsedReleaseInfo['videoCodec'] = 'x264';
  if (/\b(x265|h\.?265|hevc)\b/i.test(sourceString)) videoCodec = 'x265';
  else if (/\bav1\b/i.test(sourceString)) videoCodec = 'AV1';

  // Dynamic Range
  let dynamicRange: ParsedReleaseInfo['dynamicRange'] = 'SDR';
  if (/hdr10\+/i.test(sourceString)) dynamicRange = 'HDR10+';
  else if (/\b(dv|dolby\.?vision)\b/i.test(sourceString)) dynamicRange = 'DV';
  else if (/\bhdr(10)?\b/i.test(sourceString)) dynamicRange = 'HDR10';

  // Audio Channels
  let audioChannels: ParsedReleaseInfo['audioChannels'] = '5.1';
  if (/\b7\.1\b/.test(sourceString)) audioChannels = '7.1';
  else if (/\b2\.0\b/.test(sourceString)) audioChannels = '2.0';

  const isDualAudio = /\b(dual|multi)\b/i.test(sourceString);

  // Extract Year (1950 - 2030)
  const normalizedForWordBoundary = sourceString.replace(/_/g, ' ');
  const yearMatch = normalizedForWordBoundary.match(/\b(19\d{2}|20[0-3]\d)\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Extract clean title up to the year or technical tag
  let rawTitle = normalizedForWordBoundary;
  const stopPattern = /\b(19\d{2}|20[0-3]\d|2160p|1080p|720p|480p|WEB-?DL|WEBRip|BluRay|BDRip|HDRip|x264|x265|HEVC|DUAL|DUB|LEG|S\d{1,2}(?:E|EP)?\d{1,3}|\d+ª?\s+temporada|temporada\s+\d+|season\s+\d+)\b/i;
  const stopMatch = rawTitle.match(stopPattern);
  if (stopMatch && stopMatch.index && stopMatch.index > 1) {
    rawTitle = rawTitle.slice(0, stopMatch.index);
  }

  const cleanTitle = rawTitle
    .replace(/\./g, ' ')
    .replace(/\s+-\s+/g, ': ')
    .replace(/[\(\[\{]/g, ' ')
    .replace(/[\)\]\}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[-:.\s]+$/, '')
    .trim();

  const slugBase = cleanTitle
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const slug = year ? `${slugBase}-${year}` : slugBase;

  return {
    cleanTitle: cleanTitle || filename,
    slug: slug || 'media-item',
    year,
    type,
    seasonNumber,
    episodeNumber,
    resolution,
    videoCodec,
    dynamicRange,
    audioChannels,
    isDualAudio,
    fileRole,
    languageHint,
    isForcedSubtitle,
    container: ext || 'mkv',
  };
}
