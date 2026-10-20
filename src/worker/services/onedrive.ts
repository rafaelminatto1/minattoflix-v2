import type { KVNamespaceBinding } from '../db';
import type { CloudDriveEntry, DiscoveredFolderBundle } from './gdrive';

/**
 * Encodes a OneDrive sharing URL (e.g. https://1drv.ms/f/c/...) into a Microsoft OneDrive API sharing token (u!base64url)
 */
export function encodeOneDriveShareToken(shareUrl: string): string {
  const bytes = new TextEncoder().encode(shareUrl.trim());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${base64}`;
}

// Isolate-level memory caches (0ms lookup, zero cost)
let memoryBadgerToken: string | null = null;
let memoryBadgerExpiresAt = 0;
const memoryRedeemedShares = new Set<string>();
const memoryDownloadUrls = new Map<string, { url: string; expiresAt: number }>();

function cacheDownloadUrl(itemId: string, url: string, kv?: KVNamespaceBinding) {
  memoryDownloadUrls.set(itemId, { url, expiresAt: Date.now() + 25 * 60 * 1000 });
  if (kv) {
    kv.put(`onedrive:dl:${itemId}`, url, { expirationTtl: 1500 }).catch(() => {});
  }
}

/**
 * Acquires a Microsoft OneDrive Personal "Badger" token (cached in memory + Cloudflare KV for 50 minutes)
 * which allows anonymous read/stream access to any public 1drv.ms shared folder.
 */
async function getOneDriveBadgerToken(kv?: KVNamespaceBinding): Promise<string> {
  if (memoryBadgerToken && Date.now() < memoryBadgerExpiresAt) {
    return memoryBadgerToken;
  }

  const kvKey = 'onedrive:badger:token';
  if (kv) {
    try {
      const cached = await kv.get(kvKey);
      if (cached) {
        memoryBadgerToken = cached;
        memoryBadgerExpiresAt = Date.now() + 45 * 60 * 1000;
        return cached;
      }
    } catch {
      // Proceed to fetch
    }
  }

  const res = await fetch('https://api-badgerp.svc.ms/v1.0/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AppId: '1141147648',
    },
    body: JSON.stringify({
      appId: '5cbed6ac-a083-4e14-b191-b4ba07653de2',
    }),
  });

  if (!res.ok) {
    throw new Error(`Falha ao obter Badger Token do OneDrive (${res.status})`);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('Badger Token vazio na resposta do OneDrive');
  }

  memoryBadgerToken = data.token;
  memoryBadgerExpiresAt = Date.now() + 45 * 60 * 1000;
  memoryRedeemedShares.clear();

  if (kv) {
    kv.put(kvKey, data.token, { expirationTtl: 3000 }).catch(() => {});
  }

  return data.token;
}

interface OneDriveV2Item {
  id: string;
  name: string;
  size?: number;
  parentReference?: { driveId?: string; id?: string };
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  '@content.downloadUrl'?: string;
}

/**
 * Scans a shared OneDrive folder (and all 1st-level movie subfolders) using the Microsoft Personal Content v2.0 API
 * with Badger authentication and `Prefer: autoredeem`.
 */
export async function scanOneDriveSharedFolder(
  shareUrl: string,
  kv?: KVNamespaceBinding
): Promise<DiscoveredFolderBundle[]> {
  const badgerToken = await getOneDriveBadgerToken(kv);
  const shareToken = encodeOneDriveShareToken(shareUrl);

  const authHeaders: Record<string, string> = {
    Authorization: `Badger ${badgerToken}`,
    Prefer: 'autoredeem',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  };

  const listPages = async (firstUrl: string, initialItems: OneDriveV2Item[] = []) => {
    const items = [...initialItems];
    const visited = new Set<string>();
    let nextUrl = firstUrl;
    while (nextUrl) {
      const parsed = new URL(nextUrl);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'my.microsoftpersonalcontent.com') {
        throw new Error('Origem de paginação OneDrive inválida.');
      }
      if (visited.has(nextUrl)) throw new Error('Paginação repetida do OneDrive.');
      visited.add(nextUrl);
      const response = await fetch(nextUrl, { headers: authHeaders, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`OneDrive listagem HTTP ${response.status}`);
      const data = await response.json() as { value?: OneDriveV2Item[]; '@odata.nextLink'?: string };
      items.push(...(data.value || []));
      nextUrl = data['@odata.nextLink'] || '';
    }
    return items;
  };

  const rootUrl = `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${shareToken}/driveItem?$expand=children`;
  const rootRes = await fetch(rootUrl, { headers: authHeaders });
  if (!rootRes.ok) {
    throw new Error(`OneDrive root folder HTTP ${rootRes.status}`);
  }
  memoryRedeemedShares.add(`${badgerToken}:${shareToken}`);

  const rootData = (await rootRes.json()) as {
    id?: string;
    name?: string;
    parentReference?: { driveId?: string };
    children?: OneDriveV2Item[];
    'children@odata.nextLink'?: string;
  };

  const children = await listPages(rootData['children@odata.nextLink'] || '', rootData.children || []);
  const bundles: DiscoveredFolderBundle[] = [];
  const directFiles: CloudDriveEntry[] = [];

  for (const child of children) {
    const driveId = child.parentReference?.driveId || rootData.parentReference?.driveId || '';
    if (!child.folder) {
      if (child['@content.downloadUrl']) {
        cacheDownloadUrl(child.id, child['@content.downloadUrl'], kv);
      }
      directFiles.push({
        id: child.id,
        parentId: rootData.id || 'onedrive-root',
        name: child.name,
        mimeType: child.file?.mimeType || 'video/x-matroska',
        sizeBytes: child.size || 0,
        isFolder: false,
      });
    } else if (driveId) {
      // It's a movie subfolder — fetch its children in parallel below
    }
  }

  for (const df of directFiles) {
    bundles.push({
      folderId: rootData.id || 'onedrive-root',
      folderName: '',
      files: [df],
    });
  }

  const subfolders = children.filter((c) => Boolean(c.folder));
  const subResults = await Promise.all(
    subfolders.map(async (folder) => {
      const driveId = folder.parentReference?.driveId || rootData.parentReference?.driveId || '91785C84C5B944AF';
      const subUrl = `https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodeURIComponent(
        driveId
      )}/items/${encodeURIComponent(folder.id)}/children`;

      try {
        const subItems = await listPages(subUrl);
        const files: CloudDriveEntry[] = [];

        for (const sf of subItems) {
          if (sf.folder) continue;
          if (sf['@content.downloadUrl']) {
            cacheDownloadUrl(sf.id, sf['@content.downloadUrl'], kv);
          }
          files.push({
            id: sf.id,
            parentId: folder.id,
            name: sf.name,
            mimeType: sf.file?.mimeType || 'video/x-matroska',
            sizeBytes: sf.size || 0,
            isFolder: false,
          });
        }

        return {
          folderId: folder.id,
          folderName: folder.name,
          files,
        };
      } catch (error) {
        throw new Error(`Falha na pasta ${folder.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  for (const sr of subResults) {
    bundles.push(sr);
  }

  return bundles;
}

/**
 * Resolves and caches the direct `@content.downloadUrl` for a OneDrive item ID
 * using 0ms in-memory cache -> Cloudflare KV -> single-redemption Badger API.
 */
export async function resolveOneDriveDownloadUrl(
  externalFileId: string,
  shareUrl: string,
  kv?: KVNamespaceBinding,
  forceRefresh = false
): Promise<string> {
  const cleanItemId = externalFileId.includes(':::') ? externalFileId.split(':::')[1] : externalFileId;
  const kvDlKey = `onedrive:dl:${cleanItemId}`;

  if (!forceRefresh) {
    const memCached = memoryDownloadUrls.get(cleanItemId);
    if (memCached && Date.now() < memCached.expiresAt) {
      return memCached.url;
    }

    if (kv) {
      try {
        const cachedDownloadUrl = await kv.get(kvDlKey);
        if (cachedDownloadUrl) {
          memoryDownloadUrls.set(cleanItemId, { url: cachedDownloadUrl, expiresAt: Date.now() + 25 * 60 * 1000 });
          return cachedDownloadUrl;
        }
      } catch {
        // Proceed to fresh resolution
      }
    }
  }

  const badgerToken = await getOneDriveBadgerToken(kv);
  const shareToken = encodeOneDriveShareToken(shareUrl);
  const driveId = cleanItemId.includes('!') ? cleanItemId.split('!')[0] : '91785C84C5B944AF';
  const redeemKey = `${badgerToken}:${shareToken}`;

  const authHeaders: Record<string, string> = {
    Authorization: `Badger ${badgerToken}`,
    Prefer: 'autoredeem',
    Accept: 'application/json',
  };

  const itemUrl = `https://my.microsoftpersonalcontent.com/_api/v2.0/drives/${encodeURIComponent(
    driveId
  )}/items/${encodeURIComponent(cleanItemId)}?select=id,@content.downloadUrl`;

  // Only call /shares/{shareToken}/driveItem once per Badger token (saves ~1300ms on subsequent movies!)
  if (!memoryRedeemedShares.has(redeemKey)) {
    await fetch(`https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${shareToken}/driveItem?select=id`, {
      headers: authHeaders,
    });
    memoryRedeemedShares.add(redeemKey);
  }

  let itemRes = await fetch(itemUrl, { headers: authHeaders });
  if (itemRes.status === 401 || itemRes.status === 403 || itemRes.status === 404) {
    // Share session expired in another isolate or token rotated — redeem once and retry
    await fetch(`https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${shareToken}/driveItem?select=id`, {
      headers: authHeaders,
    });
    memoryRedeemedShares.add(redeemKey);
    itemRes = await fetch(itemUrl, { headers: authHeaders });
  }

  if (!itemRes.ok) {
    throw new Error(`Falha ao resolver downloadUrl no OneDrive (${itemRes.status})`);
  }

  const itemData = (await itemRes.json()) as OneDriveV2Item;
  const downloadUrl = itemData['@content.downloadUrl'];
  if (!downloadUrl) {
    throw new Error('OneDrive não retornou @content.downloadUrl para este arquivo');
  }

  cacheDownloadUrl(cleanItemId, downloadUrl, kv);
  return downloadUrl;
}

/**
 * Resolves the direct `@content.downloadUrl` for a OneDrive item ID (using Memory + Cloudflare KV cache)
 * and streams it with full HTTP Range (206 Partial Content) support!
 */
export async function fetchOneDriveStream(
  externalFileId: string,
  shareUrl: string,
  rangeHeader: string | null | undefined,
  kv?: KVNamespaceBinding
): Promise<Response> {
  const reqHeaders = new Headers({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  });

  // Bound open-ended ranges (e.g., bytes=0-) to 8 MB chunks for fast Time-To-First-Frame and solid buffer, while preserving explicit ranges
  const openEndedMatch = rangeHeader?.match(/^bytes=(\d+)-$/);
  if (openEndedMatch) {
    const start = Number(openEndedMatch[1]);
    const end = start + 8 * 1024 * 1024 - 1;
    reqHeaders.set('Range', `bytes=${start}-${end}`);
  } else if (rangeHeader) {
    reqHeaders.set('Range', rangeHeader);
  }

  try {
    const cachedUrl = await resolveOneDriveDownloadUrl(externalFileId, shareUrl, kv, false);
    const fastRes = await fetch(cachedUrl, { headers: reqHeaders, redirect: 'follow' });
    if (fastRes.ok || fastRes.status === 206) {
      return fastRes;
    }
  } catch {
    // Fallback to forced refresh below
  }

  const freshUrl = await resolveOneDriveDownloadUrl(externalFileId, shareUrl, kv, true);
  return fetch(freshUrl, {
    headers: reqHeaders,
    redirect: 'follow',
  });
}
