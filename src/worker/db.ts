import { neon } from '@neondatabase/serverless';

export interface KVNamespaceBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectBodyBinding {
  size?: number;
  etag?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream;
}

export interface R2BucketBinding {
  get(key: string, options?: {range?: {offset:number;length:number}}): Promise<R2ObjectBodyBinding | null>;
  head?(key:string): Promise<{size:number} | null>;
  createMultipartUpload?(key: string, options?: {httpMetadata?:{contentType?:string}}): Promise<{uploadId:string}>;
  resumeMultipartUpload?(key: string, uploadId:string): {
    uploadPart(number:number, body:ReadableStream):Promise<{partNumber:number;etag:string}>;
    complete(parts:Array<{partNumber:number;etag:string}>):Promise<{size:number}>;
    abort():Promise<void>;
  };
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>;
}

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface DurableObjectStubBinding {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceBinding {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubBinding;
}

export interface Env extends Omit<CloudflareBindings, 'ASSETS' | 'COST_MODE' | 'AUTO_SCAN_ENABLED' | 'ALLOWED_ORIGINS' | 'GDRIVE_API_KEY' | 'TMDB_API_KEY' | 'ACCESS_CODE' | 'ADMIN_CODE' | 'SESSION_SECRET'> {
  COST_MODE?: string;
  ACCESS_CODE?: string;
  PUBLIC_VIEWING_ENABLED?: string;
  ADMIN_CODE?: string;
  SESSION_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  AUTO_SCAN_ENABLED?: string;
  DATABASE_URL: string;
  DEFAULT_GDRIVE_FOLDER_ID: string;
  DEFAULT_ONEDRIVE_SHARE_URL: string;
  TMDB_API_KEY?: string;
  GDRIVE_API_KEY?: string;
  ASSETS?: { fetch: typeof fetch };
  MINATTO_KV?: KVNamespaceBinding;
  MEDIA_BUCKET?: R2BucketBinding;
  HYPERDRIVE?: { connectionString: string };
  AI?: AiBinding;
  WATCH_PARTY?: DurableObjectNamespaceBinding;
  GITHUB_TOKEN?: string;
  MINATTO_WEBHOOK_SECRET?: string;
}

export function getDb(env?: Partial<Env>) {
  const connectionString = env?.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL não configurada.');
  return neon(connectionString);
}
