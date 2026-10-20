import type { KVNamespaceBinding } from '../db';

export interface CloudDriveEntry {
  id: string;
  parentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isFolder: boolean;
}

export function extractGDriveFolderId(input: string): string {
  const trimmed = input.trim();
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  return trimmed;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Lists files and folders inside a public Google Drive folder using the lightweight
 * `embeddedfolderview` endpoint (7 KB HTML, works 100% on Cloudflare Edge IPs without JS)
 * or the official Google Drive v3 API if an API key is provided.
 */
export async function listGDriveFolderEntries(folderId: string, apiKey?: string): Promise<CloudDriveEntry[]> {
  if (apiKey) {
    const entries: CloudDriveEntry[] = [];
    const visited = new Set<string>();
    let pageToken = '';
    do {
      if (visited.has(pageToken)) throw new Error('Paginação repetida do Google Drive. Tente sincronizar novamente.');
      visited.add(pageToken);
      const apiUrl = new URL('https://www.googleapis.com/drive/v3/files');
      apiUrl.search = new URLSearchParams({ q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size)', pageSize: '200', key: apiKey,
        ...(pageToken ? { pageToken } : {}) }).toString();
      const apiRes = await fetch(apiUrl, { signal: AbortSignal.timeout(30000) });
      if (!apiRes.ok) throw new Error(`Google Drive HTTP ${apiRes.status}. Nenhum arquivo foi removido.`);
      const data = (await apiRes.json()) as {
        nextPageToken?: string;
        files?: Array<{ id: string; name: string; mimeType: string; size?: string }>;
      };
      entries.push(...(data.files || []).map((f) => ({
          id: f.id,
          parentId: folderId,
          name: f.name,
          mimeType: f.mimeType,
          sizeBytes: f.size ? parseInt(f.size, 10) : 0,
          isFolder: f.mimeType === 'application/vnd.google-apps.folder',
        })));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return entries;
  }

  // Primary Zero-Key Edge Scraper: embeddedfolderview
  const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`;
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao acessar pasta do Google Drive (${response.status})`);
  }

  const html = await response.text();
  const entries: CloudDriveEntry[] = [];

  // Split by flip-entry blocks
  const blocks = html.split('<div class="flip-entry"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const idMatch = block.match(/id="entry-([a-zA-Z0-9_-]+)"/);
    const titleMatch = block.match(/<div class="flip-entry-title">([^<]+)<\/div>/);
    if (!idMatch || !titleMatch) continue;

    const id = idMatch[1];
    const name = decodeHtmlEntities(titleMatch[1].trim());
    const isFolder = block.includes('/drive/folders/') || block.includes('aria-label="Folder"');
    const mimeType = isFolder
      ? 'application/vnd.google-apps.folder'
      : name.toLowerCase().endsWith('.mkv')
        ? 'video/x-matroska'
        : 'application/octet-stream';

    entries.push({
      id,
      parentId: folderId,
      name,
      mimeType,
      sizeBytes: 0,
      isFolder,
    });
  }

  return entries;
}

export interface DiscoveredFolderBundle {
  folderId: string;
  folderName: string;
  files: CloudDriveEntry[];
}

export async function scanGDriveRootFolder(rootFolderId: string, apiKey?: string): Promise<DiscoveredFolderBundle[]> {
  const topEntries = await listGDriveFolderEntries(rootFolderId, apiKey);
  const bundles: DiscoveredFolderBundle[] = [];

  const directFiles = topEntries.filter((e) => !e.isFolder);
  for (const df of directFiles) {
    bundles.push({
      folderId: rootFolderId,
      folderName: '',
      files: [df],
    });
  }

  const subfolders = topEntries.filter((e) => e.isFolder);
  const subfolderResults = await Promise.all(
    subfolders.map(async (folder) => {
      try {
        const childEntries = await listGDriveFolderEntries(folder.id, apiKey);
        return {
          folderId: folder.id,
          folderName: folder.name,
          files: childEntries.filter((c) => !c.isFolder),
        };
      } catch (error) {
        throw new Error(`Falha na pasta ${folder.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  for (const res of subfolderResults) {
    bundles.push(res);
  }

  return bundles;
}

export async function fetchGDriveStream(
  fileId: string,
  rangeHeader: string | null | undefined,
  apiKey?: string,
  kv?: KVNamespaceBinding
): Promise<Response> {
  const reqHeaders = new Headers({
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  });
  // Respect bounded ranges (e.g. probe or demuxer) up to 4 MB, and bound open-ended ranges to 2 MB chunks
  const byteRange = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  const start = byteRange ? Number(byteRange[1]) : 0;
  const maxChunkEnd = start + (byteRange?.[2] ? 4 * 1024 * 1024 : 2 * 1024 * 1024) - 1;
  const end = byteRange?.[2] ? Math.min(Number(byteRange[2]), maxChunkEnd) : maxChunkEnd;
  reqHeaders.set('Range', !rangeHeader || byteRange ? `bytes=${start}-${end}` : rangeHeader);

  const kvKey = `gdrive:dl:${fileId}`;
  if (kv) {
    try {
      const cachedUrl = await kv.get(kvKey);
      if (cachedUrl) {
        const fastRes = await fetch(cachedUrl, {
          headers: reqHeaders,
          redirect: 'follow',
        });
        const ct = fastRes.headers.get('content-type') || '';
        if ((fastRes.ok || fastRes.status === 206) && !ct.includes('text/html')) {
          return fastRes;
        }
      }
    } catch {
      // Proceed to fresh resolution
    }
  }

  if (apiKey) {
    const apiMediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?alt=media&acknowledgeAbuse=true&key=${encodeURIComponent(apiKey)}`;
    const apiRes = await fetch(apiMediaUrl, {
      headers: reqHeaders,
      redirect: 'follow',
    });
    const apiCt = apiRes.headers.get('content-type') || '';
    if ((apiRes.ok || apiRes.status === 206) && !apiCt.includes('text/html')) {
      return apiRes;
    }
  }

  const directUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&authuser=0&confirm=t`;

  const response = await fetch(directUrl, {
    headers: reqHeaders,
    redirect: 'follow',
  });

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/html')) {
    const html = await response.text();
    const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
    const idMatch = html.match(/name="id"\s+value="([^"]+)"/);
    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
    const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/);
    const atMatch = html.match(/name="at"\s+value="([^"]+)"/);

    const confirmedUrl = new URL(actionMatch?.[1] || 'https://drive.usercontent.google.com/download');
    confirmedUrl.searchParams.set('id', idMatch ? idMatch[1] : fileId);
    confirmedUrl.searchParams.set('export', 'download');
    confirmedUrl.searchParams.set('confirm', confirmMatch ? confirmMatch[1] : 't');
    if (uuidMatch) confirmedUrl.searchParams.set('uuid', uuidMatch[1]);
    if (atMatch) confirmedUrl.searchParams.set('at', atMatch[1]);

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookiePairs = setCookie
        .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
      if (cookiePairs) reqHeaders.set('Cookie', cookiePairs);
    }

    const finalUrlStr = confirmedUrl.toString();
    const confirmedResponse = await fetch(finalUrlStr, {
      headers: reqHeaders,
      redirect: 'follow',
    });
    if (!confirmedResponse.ok || (confirmedResponse.headers.get('content-type') || '').includes('text/html')) {
      await confirmedResponse.body?.cancel();
      throw new Error('Google Drive não disponibilizou os bytes da mídia. Tente a fonte OneDrive.');
    }
    if (kv) {
      kv.put(kvKey, finalUrlStr, { expirationTtl: 1500 }).catch(() => {});
    }
    return confirmedResponse;
  }

  if (!response.ok && response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`Google Drive retornou status ${response.status}.`);
  }

  if (kv && (response.ok || response.status === 206)) {
    kv.put(kvKey, response.url || directUrl, { expirationTtl: 1500 }).catch(() => {});
  }

  return response;
}
