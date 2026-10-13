import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getDb, type Env } from './db';
import { WatchPartyRoom } from './durable-watch-party';

export { WatchPartyRoom };

// Import route modules
import { bootstrapRoutes } from './routes/bootstrap';
import { streamRoutes } from './routes/stream';
import { subtitlesRoutes } from './routes/subtitles';
import { scannerRoutes, executeCloudScannerSync, warmAllMovieHeadChunks } from './routes/scanner';
import { profilesRoutes } from './routes/profiles';
import { storageRoutes } from './routes/storage';
import { watchPartyRoutes } from './routes/watch-party';
import { mediaRoutes } from './routes/media';

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    path: c.req.path,
    method: c.req.method,
  }));
  return c.json({ error: 'Não foi possível concluir a operação. Tente novamente.' }, 500);
});

// CORS for API routes
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowHeaders: ['Content-Type', 'Range', 'Authorization'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type', 'X-Cloud-Provider', 'X-KV-Cache'],
  })
);

// Mount all route modules
app.route('/', bootstrapRoutes);
app.route('/', streamRoutes);
app.route('/', subtitlesRoutes);
app.route('/', scannerRoutes);
app.route('/', profilesRoutes);
app.route('/', storageRoutes);
app.route('/', watchPartyRoutes);
app.route('/', mediaRoutes);

// Cron trigger handler
export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil(
      (async () => {
        await executeCloudScannerSync(env);
        await warmAllMovieHeadChunks(env, 12).catch(() => {});
      })()
    );
  },
};