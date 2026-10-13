import { neon } from '@neondatabase/serverless';

export interface KVNamespaceBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectBodyBinding {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream;
}

export interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBodyBinding | null>;
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

export interface Env {
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
}

export function getDb(env?: Partial<Env>) {
  const connectionString = env?.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL não configurada.');
  return neon(connectionString);
}
