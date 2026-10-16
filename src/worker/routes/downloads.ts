import { Hono } from 'hono';
import { getDb, type Env } from '../db';
import { executeCloudScannerSync } from './scanner';

export const downloadsRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/downloads - List all active and recent download jobs
 */
downloadsRoutes.get('/api/downloads', async (c) => {
  const sql = getDb(c.env);
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100);

  try {
    const jobs = await sql`
      SELECT 
        id,
        title,
        media_type,
        tmdb_id,
        file_name,
        file_size_bytes,
        status,
        progress_percent,
        download_speed,
        github_run_id,
        error_message,
        created_at,
        updated_at
      FROM download_jobs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return c.json({ jobs });
  } catch (err) {
    return c.json({ error: 'Erro ao listar downloads', details: String(err) }, 500);
  }
});

/**
 * POST /api/downloads/request - Submit a new magnet link to be downloaded and ingested
 */
downloadsRoutes.post('/api/downloads/request', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Payload JSON inválido' }, 400);
  }

  const { title, magnetUri, mediaType = 'movie', tmdbId, folderCategory } = body as {
    title?: string;
    magnetUri?: string;
    mediaType?: 'movie' | 'series';
    tmdbId?: number;
    folderCategory?: string;
  };

  if (!title || !title.trim()) {
    return c.json({ error: 'O título da mídia é obrigatório' }, 400);
  }

  if (!magnetUri || !magnetUri.trim().startsWith('magnet:?')) {
    return c.json({ error: 'O magnet link fornecido é inválido (deve começar com magnet:?)' }, 400);
  }

  const cleanTitle = title.trim();
  const cleanCategory = folderCategory?.trim() || (mediaType === 'series' ? 'Séries' : 'Filmes');

  try {
    const rows = await sql`
      INSERT INTO download_jobs (
        title,
        media_type,
        tmdb_id,
        magnet_uri,
        status,
        progress_percent,
        download_speed
      )
      VALUES (
        ${cleanTitle},
        ${mediaType},
        ${tmdbId ? Number(tmdbId) : null},
        ${magnetUri.trim()},
        'queued',
        0,
        'Na fila de processamento'
      )
      RETURNING id, title, status, created_at
    `;

    const job = rows[0] as { id: string; title: string; status: string; created_at: string };
    let dispatched = false;
    let dispatchError: string | null = null;

    // Se houver GITHUB_TOKEN configurado no Worker, dispara automaticamente o GitHub Actions
    if (c.env.GITHUB_TOKEN) {
      try {
        const ghRes = await fetch(
          'https://api.github.com/repos/rafaelminatto1/minattoflix-v2/actions/workflows/ingest-media.yml/dispatches',
          {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.github.v3+json',
              Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
              'User-Agent': 'MinattoFlix-Cloudflare-Worker',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ref: 'main',
              inputs: {
                job_id: job.id,
                title: cleanTitle,
                folder_category: cleanCategory,
                magnet_uri: magnetUri.trim(),
              },
            }),
          }
        );

        if (ghRes.ok || ghRes.status === 204) {
          dispatched = true;
          await sql`
            UPDATE download_jobs
            SET status = 'dispatching',
                download_speed = 'Disparado no GitHub Actions',
                updated_at = NOW()
            WHERE id = ${job.id}
          `;
        } else {
          dispatchError = `GitHub API HTTP ${ghRes.status}: ${await ghRes.text()}`;
        }
      } catch (e) {
        dispatchError = e instanceof Error ? e.message : String(e);
      }
    }

    return c.json({
      success: true,
      job: {
        ...job,
        dispatched,
        dispatchError,
      },
    }, 201);
  } catch (err) {
    return c.json({ error: 'Erro ao registrar job de download', details: String(err) }, 500);
  }
});

/**
 * POST /api/downloads/webhook - Callback from GitHub Actions runner reporting progress & completion
 */
downloadsRoutes.post('/api/downloads/webhook', async (c) => {
  const sql = getDb(c.env);

  // Validação opcional de segurança se MINATTO_WEBHOOK_SECRET estiver configurado
  if (c.env.MINATTO_WEBHOOK_SECRET) {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token !== c.env.MINATTO_WEBHOOK_SECRET) {
      return c.json({ error: 'Não autorizado' }, 401);
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body || !body.jobId) {
    return c.json({ error: 'Payload inválido (jobId é obrigatório)' }, 400);
  }

  const { jobId, status, progress, downloadSpeed, error, fileName, fileSize } = body as {
    jobId: string;
    status: string;
    progress?: number;
    downloadSpeed?: string;
    error?: string;
    fileName?: string;
    fileSize?: number;
  };

  try {
    await sql`
      UPDATE download_jobs
      SET status = ${status},
          progress_percent = COALESCE(${progress !== undefined ? Number(progress) : null}, progress_percent),
          download_speed = COALESCE(${downloadSpeed || null}, download_speed),
          file_name = COALESCE(${fileName || null}, file_name),
          file_size_bytes = COALESCE(${fileSize ? BigInt(fileSize) : null}, file_size_bytes),
          error_message = COALESCE(${error || null}, error_message),
          updated_at = NOW()
      WHERE id = ${jobId}
    `;

    // Se o download foi concluído com sucesso, dispara o scanner do OneDrive em background
    if (status === 'completed') {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await executeCloudScannerSync(c.env);
            console.log(`[downloads/webhook] Scanner executado com sucesso após conclusão do job ${jobId}`);
          } catch (scanErr) {
            console.error(`[downloads/webhook] Erro ao rodar scanner após job ${jobId}:`, scanErr);
          }
        })()
      );
    }

    return c.json({ success: true, jobId, status });
  } catch (err) {
    return c.json({ error: 'Erro ao atualizar job', details: String(err) }, 500);
  }
});

/**
 * DELETE /api/downloads/:id - Cancel or delete a job
 */
downloadsRoutes.delete('/api/downloads/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');

  try {
    await sql`DELETE FROM download_jobs WHERE id = ${id}`;
    return c.json({ success: true, id });
  } catch (err) {
    return c.json({ error: 'Erro ao remover job', details: String(err) }, 500);
  }
});
