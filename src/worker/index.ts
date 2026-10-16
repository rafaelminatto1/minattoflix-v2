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
import { downloadsRoutes } from './routes/downloads';

// Structured logging utility
function createLogger(c: Context) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();
  
  return {
    info: (event: string, data?: Record<string, unknown>) => {
      console.log(JSON.stringify({
        level: 'info',
        event,
        requestId,
        path: c.req.path,
        method: c.req.method,
        durationMs: Date.now() - startTime,
        ...data,
      }));
    },
    warn: (event: string, data?: Record<string, unknown>) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event,
        requestId,
        path: c.req.path,
        method: c.req.method,
        durationMs: Date.now() - startTime,
        ...data,
      }));
    },
    error: (event: string, error: Error | unknown, data?: Record<string, unknown>) => {
      console.error(JSON.stringify({
        level: 'error',
        event,
        requestId,
        path: c.req.path,
        method: c.req.method,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...data,
      }));
    },
  };
}

// Health check endpoint
const app = new Hono<{ Bindings: Env }>();

// Health check - must be before CORS for monitoring
app.get('/api/health', async (c) => {
  const logger = createLogger(c);
  const startTime = Date.now();
  
  try {
    // Check KV
    if (c.env.MINATTO_KV) await c.env.MINATTO_KV.get('health-check');
    const kvLatency = Date.now() - startTime;
    
    // Check R2
    const r2Start = Date.now();
    if (c.env.MEDIA_BUCKET) await c.env.MEDIA_BUCKET.get('health-check');
    const r2Latency = Date.now() - r2Start;
    
    // Check Hyperdrive (DB)
    const dbStart = Date.now();
    const db = getDb(c.env);
    await db`SELECT 1`;
    const dbLatency = Date.now() - dbStart;
    
    const totalLatency = Date.now() - startTime;
    
    logger.info('health_check', { kvLatency, r2Latency, dbLatency, totalLatency });
    
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      latency: {
        kv: kvLatency,
        r2: r2Latency,
        db: dbLatency,
        total: totalLatency,
      },
    });
  } catch (error) {
    logger.error('health_check_failed', error as Error);
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, 503);
  }
});

// Logging middleware
app.use('/api/*', async (c, next) => {
  const logger = createLogger(c);
  const startTime = Date.now();
  
  logger.info('request_start', {
    userAgent: c.req.header('User-Agent'),
    cfRay: c.req.header('CF-Ray'),
    country: c.req.header('CF-IPCountry'),
  });
  
  try {
    await next();
    const duration = Date.now() - startTime;
    const status = c.res.status;
    
    logger.info('request_complete', { status, durationMs: duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('request_error', error as Error, { durationMs: duration });
    throw error;
  }
});

app.onError((error, c) => {
  const logger = createLogger(c);
  logger.error('unhandled_error', error as Error);
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
app.route('/', downloadsRoutes);

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