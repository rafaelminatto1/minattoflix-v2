import type {AudioTrack, MediaFile} from '../types';

export function isPortugueseAudio(track: Pick<AudioTrack, 'language_code' | 'label'>): boolean {
  const language = (track.language_code || '').toLowerCase().replaceAll('_', '-');
  return /^(pt(?:-|$)|por$|pob$)/.test(language)
    || ((!language || language === 'und') && /portugu[eê]s|pt[- ]?br|dublado/i.test(track.label || ''));
}

export function portugueseAudio(tracks: AudioTrack[]): AudioTrack | undefined {
  return tracks.find(track => /^(pt[-_]br|pob)$/i.test(track.language_code || ''))
    || tracks.find(isPortugueseAudio);
}

// Returning to the foreground never resumes playback without a new Play gesture.
export function watchPlaybackVisibility(doc: Document, target: Window, pause: () => void): () => void {
  const onVisibility = () => { if (doc.visibilityState !== 'visible') pause(); };
  doc.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('pagehide', pause);
  onVisibility();
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('pagehide', pause);
  };
}

export function portugueseFile(files: MediaFile[], tracks: AudioTrack[], fallback?: MediaFile): MediaFile | undefined {
  const hasPortuguese = (file: MediaFile) => Boolean(portugueseAudio([
    ...tracks.filter(track => track.media_file_id === file.id), ...(file.audioTracks || []),
  ]));
  if (fallback && hasPortuguese(fallback)) return fallback;
  const dubbed = files.filter(hasPortuguese);
  return dubbed.find(file => /^(mp4|m4v)$/i.test(file.container || ''))
    || dubbed.find(file => file.provider === 'onedrive') || dubbed[0] || fallback;
}
