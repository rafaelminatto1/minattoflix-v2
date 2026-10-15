export type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenTarget = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function isPlayerFullscreen(doc: FullscreenDocument, video: FullscreenVideo | null) {
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || video?.webkitDisplayingFullscreen);
}

export async function exitPlayerFullscreen(doc: FullscreenDocument, video: FullscreenVideo | null) {
  if (video?.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
    video.webkitExitFullscreen();
    return;
  }
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
  }
}

export async function enterPlayerFullscreen(doc: FullscreenDocument, target: FullscreenTarget, video: FullscreenVideo | null, preferNativeVideo: boolean) {
  if (isPlayerFullscreen(doc, video)) {
    return;
  }
  // Call native iOS video fullscreen during the tap, before any await consumes the gesture.
  if (preferNativeVideo && video?.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
    return;
  }
  try {
    if (target.requestFullscreen) await target.requestFullscreen();
    else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    else if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else throw new Error('Fullscreen unavailable');
  } catch (error) {
    if (video?.webkitEnterFullscreen && (typeof target.requestFullscreen === 'function' || typeof target.webkitRequestFullscreen === 'function')) {
      video.webkitEnterFullscreen();
    } else throw error;
  }
}

export async function togglePlayerFullscreen(doc: FullscreenDocument, target: FullscreenTarget, video: FullscreenVideo | null, preferNativeVideo: boolean) {
  if (isPlayerFullscreen(doc, video)) {
    await exitPlayerFullscreen(doc, video);
    return;
  }
  await enterPlayerFullscreen(doc, target, video, preferNativeVideo);
}

