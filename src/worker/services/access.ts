import type { Env } from '../db';

export interface Session { role: 'viewer' | 'admin'; exp: number; }
export const publicViewingEnabled = (env: Env): boolean => env.PUBLIC_VIEWING_ENABLED === 'true';
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function sameSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  let difference = 0;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_CODE && env.ADMIN_CODE && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);
}

async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueSession(env: Env, role: Session['role']): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 86400 })));
  const signature = await crypto.subtle.sign('HMAC', await key(env.SESSION_SECRET!), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  if (!accessConfigured(env)) return null;
  const url = new URL(request.url);
  // Media elements cannot set Authorization. Query tokens are accepted only for read-only media.
  const media = request.method === 'GET' || request.method === 'HEAD';
  const queryAllowed = media && /^\/api\/(stream|subtitles|prepared)\//.test(url.pathname);
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') || (queryAllowed ? url.searchParams.get('session') : null);
  if (!token || token.length > 1024) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    if (!await crypto.subtle.verify('HMAC', await key(env.SESSION_SECRET!), decode(signature), encoder.encode(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(decode(payload))) as Session;
    return (session.role === 'viewer' || session.role === 'admin') && Number.isFinite(session.exp) && session.exp > Date.now() / 1000 ? session : null;
  } catch { return null; }
}

export function needsAdmin(path: string, method: string): boolean {
  if (path.startsWith('/api/admin/') || path.startsWith('/api/cloudflare/') || path.startsWith('/api/downloads') || path.startsWith('/api/metrics/')) return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  return !['/api/progress', '/api/my-list/toggle', '/api/player-events'].includes(path) && !path.startsWith('/api/watch-party/');
}
