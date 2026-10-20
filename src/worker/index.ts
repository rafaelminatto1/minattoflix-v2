import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { getDb, type Env } from './db';
import { applyCostPolicy, restrictedCosts } from './services/cost-policy';
import { accessConfigured, readSession, needsAdmin, publicViewingEnabled } from './services/access';
import { operationsRoutes, allowOperation } from './routes/operations';
import { cleanupOperationalData, enqueueTask, runNextTask } from './services/task-queue';
import { WatchPartyRoom } from './durable-watch-party';

export { WatchPartyRoom };

// Import route modules
import { bootstrapRoutes } from './routes/bootstrap';
import { streamRoutes } from './routes/stream';
import { subtitlesRoutes } from './routes/subtitles';
import { scannerRoutes, executeCloudScannerSync, healMissingMediaCovers } from './routes/scanner';
import { profilesRoutes } from './routes/profiles';
import { storageRoutes } from './routes/storage';
import { watchPartyRoutes } from './routes/watch-party';
import { mediaRoutes } from './routes/media';
import { downloadsRoutes } from './routes/downloads';
import {preparationRoutes} from './routes/preparation';
import {verifyPreparationRunner} from './services/github-identity';

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
        error: error instanceof Error ? error.name : 'UnknownError',
        ...data,
      }));
    },
  };
}

// Health check endpoint
const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  await next();
  // Route-specific streaming responses must not override the authentication/cache policy.
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  const origin = c.req.header('Origin');
  const allowed = [new URL(c.req.url).origin, 'capacitor://localhost', 'http://localhost',
    ...(c.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)];
  c.header('Access-Control-Allow-Origin', origin && allowed.includes(origin) ? origin : undefined);
});

app.use('/api/*', cors({
  origin: (origin, c: Context<{ Bindings: Env }>) => {
    const allowed = [new URL(c.req.url).origin, 'capacitor://localhost', 'http://localhost',
      ...(c.env.ALLOWED_ORIGINS || '').split(',').map((value: string) => value.trim()).filter(Boolean)];
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowHeaders: ['Content-Type', 'Range', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type', 'Retry-After'],
}));
app.use('/api/*', async (c, next) => {
  const runner=c.req.path.startsWith('/api/preparation/jobs/');
  if(runner) {
    if(restrictedCosts(c.env))return c.json({error:'Preparação na nuvem desativada pelo controle de custos.'},409);
    if(!await verifyPreparationRunner(c.req.header('Authorization')))return c.json({error:'Executor não autorizado.'},401);
  }
  const maximum=runner && c.req.method==='PUT'?32*1024*1024:c.req.path==='/api/subtitles/upload'?2*1024*1024:65536;
  return bodyLimit({maxSize:maximum,onError:context=>context.json({error:'Solicitação muito grande.'},413)})(c,next);
});
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.method === 'OPTIONS' || ['/api/session', '/api/health'].includes(c.req.path)) return next();
  if (c.req.path === '/api/downloads/webhook') return next();
  // The dedicated preparation middleware already authenticated the OIDC runner.
  if (c.req.path.startsWith('/api/preparation/jobs/')) return next();
  if (!accessConfigured(c.env)) return c.json({ error: 'Acesso ainda não configurado no servidor.' }, 503);
  const session = await readSession(c.req.raw, c.env);
  if (!session && publicViewingEnabled(c.env) && !needsAdmin(c.req.path, c.req.method)) return next();
  if (!session) return c.json({ error: 'Entre novamente para continuar.' }, 401);
  if (needsAdmin(c.req.path, c.req.method) && session.role !== 'admin') return c.json({ error: 'Acesso de administrador necessário.' }, 403);
  if (!['GET','HEAD'].includes(c.req.method) && needsAdmin(c.req.path, c.req.method)
    && !await allowOperation(c.env, `admin:${c.req.header('CF-Connecting-IP') || 'local'}`, 10)) {
    c.header('Retry-After', '60');
    return c.json({ error: 'Aguarde antes de iniciar outra tarefa.' }, 429);
  }
  await next();
});
app.route('/', operationsRoutes);

// Health check - must be before CORS for monitoring
app.get('/api/health', async (c) => {
  if (c.req.query('deep') !== 'true') return c.json({ status: 'alive', apiVersion: 1 });
  const session = await readSession(c.req.raw, c.env);
  if (session?.role !== 'admin') return c.json({ error: 'Não autorizado.' }, 401);
  const logger = createLogger(c);
  const startTime = Date.now();
  
  try {
    // Check KV
    if (c.env.MINATTO_KV) await c.env.MINATTO_KV.get('health-check');
    const kvLatency = c.env.MINATTO_KV ? Date.now() - startTime : null;
    
    // Check R2
    const r2Start = Date.now();
    if (c.env.MEDIA_BUCKET) await c.env.MEDIA_BUCKET.get('health-check');
    const r2Latency = c.env.MEDIA_BUCKET ? Date.now() - r2Start : null;
    
    // Test the actual Neon HTTP connection; Hyperdrive is not used by getDb().
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
      error: 'Falha ao consultar dependências.',
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

// Mount all route modules. All user/admin sessions are verified above.
app.route('/',preparationRoutes);
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
export { app };
export default {
  fetch(request: Request, env: Env, ctx: Parameters<typeof app.fetch>[2]) {
    return app.fetch(request, applyCostPolicy(env), ctx);
  },
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    ctx.waitUntil(
      (async () => {
        const safeEnv = applyCostPolicy(env);
        await cleanupOperationalData(safeEnv);
        if (safeEnv.AUTO_SCAN_ENABLED === 'true') await enqueueTask(safeEnv, 'scan');
        await runNextTask(safeEnv, {
          scan: () => executeCloudScannerSync(safeEnv),
          covers: () => healMissingMediaCovers(safeEnv, 20),
        });
      })()
    );
  },
};
