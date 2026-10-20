import type { MediaFile, MediaItem } from '../types';

declare const __API_ORIGIN__: string | undefined;
let memorySession = '';

export function sessionToken(): string {
  try { return typeof localStorage === 'undefined' ? memorySession : localStorage.getItem('minatto-session') || memorySession; }
  catch { return memorySession; }
}

export function saveSession(token: string): void {
  memorySession = token;
  try { token ? localStorage.setItem('minatto-session', token) : localStorage.removeItem('minatto-session'); }
  catch { /* Private browsing may deny persistent storage. */ }
}

/** Cover raw fetch calls too, but never send credentials to external media providers. */
export function installApiAuthentication(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const expected = new URL(apiUrl('/api/session'), window.location.href);
    const ours = target.origin === expected.origin && target.pathname.startsWith('/api/');
    let options = init;
    if (ours && sessionToken()) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${sessionToken()}`);
      options = { ...init, headers };
    }
    const response = await original(input, options);
    if (ours && response.status === 401 && target.pathname !== '/api/session') {
      saveSession('');
      window.dispatchEvent(new Event('minatto-session-expired'));
    }
    return response;
  };
}

/** The website uses same-origin requests; the bundled iOS app uses the hosted API. */
export function apiUrl(url: string): string {
  const origin = typeof __API_ORIGIN__ === 'string' ? __API_ORIGIN__ : '';
  const resolved = origin && url.startsWith('/api/') ? `${origin}${url}` : url;
  const token = sessionToken();
  // <video>, subtitle tracks and media libraries cannot always set headers (notably iOS).
  if (token && /^\/api\/(stream|subtitles|prepared)\//.test(url)) {
    const separator = resolved.includes('?') ? '&' : '?';
    return `${resolved}${separator}session=${encodeURIComponent(token)}`;
  }
  return resolved;
}

function resolveApiUrls(value: unknown): unknown {
  if (typeof value === 'string') return apiUrl(value);
  if (Array.isArray(value)) return value.map(resolveApiUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveApiUrls(item)]));
  }
  return value;
}

export const normalizeSearch = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();

export function preferredFile(item?: { files?: MediaFile[] }): MediaFile | undefined {
  const files = item?.files;
  if (!files || !files.length) return undefined;
  return files.find((f) => f.provider === 'onedrive') || files[0];
}

const prewarmedFileIds = new Set<string>();

export function prewarmStream(item?: { files?: MediaFile[] }, explicitFileId?: string): void {
  const targetId = explicitFileId || preferredFile(item)?.id;
  if (!targetId || prewarmedFileIds.has(targetId) || typeof fetch !== 'function') return;
  prewarmedFileIds.add(targetId);
  fetch(apiUrl(`/api/stream/${encodeURIComponent(targetId)}?prewarm=1`), { method: 'HEAD' }).then(response => {
    if (!response.ok) prewarmedFileIds.delete(targetId);
  }).catch(() => {
    prewarmedFileIds.delete(targetId);
  });
}

// Request deduplication cache
const inflightRequests = new Map<string, Promise<Response>>();

function getRequestKey(url: string, init?: RequestInit): string {
  return `${init?.method || 'GET'}:${url}:${JSON.stringify([...new Headers(init?.headers).entries()].sort())}:${JSON.stringify(init?.body || '')}`;
}

export function qualityLabel(file?: MediaFile): string {
  if (!file) return 'Indisponível';
  const resolution = file.resolution === '2160p' ? '4K' : file.resolution || 'Qualidade desconhecida';
  return file.dynamic_range && file.dynamic_range.toUpperCase() !== 'SDR'
    ? `${resolution} ${file.dynamic_range}` : resolution;
}

export function audioLabel(item: MediaItem): string {
  const primary = preferredFile(item);
  const tracks = primary?.audioTracks?.length ? primary.audioTracks : item.audioTracks;
  const languages = [...new Set(tracks.map(track => track.language_code).filter(Boolean))];
  return languages.length ? languages.map(language => language.toUpperCase()).join(' / ') : 'Áudio a verificar';
}

export function matchesSearch(item: MediaItem, query: string): boolean {
  const text = normalizeSearch([item.title, item.original_title, item.overview,
    ...(item.cast_info || []), ...item.genres.map(genre => genre.name),
    ...item.files.map(file => `${file.filename} ${qualityLabel(file)}`),
    audioLabel(item), ...item.subtitleTracks.map(track => track.language_code)].join(' '));
  return normalizeSearch(query).split(/\s+/).every(term => text.includes(term));
}

export const addedTime = (item: MediaItem) => Date.parse(item.created_at || '') || 0;

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(url, init);
  return resolveApiUrls(await response.json()) as T;
}

export async function requestResponse(url: string, init?: RequestInit): Promise<Response> {
  const key = getRequestKey(url, init);
  
  // Deduplicate GET requests
  if ((!init?.method || init.method === 'GET') && !init?.signal) {
    const existing = inflightRequests.get(key);
    if (existing) {
      return existing.then(r => r.clone());
    }
    
    const promise = fetch(apiUrl(url), { ...init, signal: init?.signal || AbortSignal.timeout(45000) })
      .then(response => {
        inflightRequests.delete(key);
        if (!response.ok) throw new Error(response.status === 403 ? 'Entre com o código de administrador para concluir esta ação.' : `Não foi possível concluir a operação (${response.status}). Tente novamente.`);
        return response;
      })
      .catch(err => {
        inflightRequests.delete(key);
        throw err;
      });
    
    inflightRequests.set(key, promise);
    // Keep the original body untouched so every consumer gets its own stream.
    return promise.then(response => response.clone());
  }
  
  // For non-GET, just fetch normally
  const response = await fetch(apiUrl(url), { ...init, signal: init?.signal || AbortSignal.timeout(45000) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.error === 'string' ? detail.error : `Não foi possível concluir a operação (${response.status}). Tente novamente.`);
  }
  return response;
}

// Clear deduplication cache periodically
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (inflightRequests.size > 50) {
      inflightRequests.clear();
    }
  }, 60000);
}
