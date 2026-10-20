import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { build } from 'esbuild';

const db = new PGlite();
const migration = await readFile(new URL('../migrations/001_reliability.sql', import.meta.url), 'utf8');
await db.exec(migration);
await db.exec(migration); // Safe to reapply without altering the catalog.
after(() => db.close());
globalThis.__postgresOperations = async (strings, ...values) => {
  const query = strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), '');
  return (await db.query(query, values)).rows;
};
async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'local-postgres', setup(builder) {
      builder.onResolve({ filter: /(^|\/)db$/ }, () => ({ path: 'postgres', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const getDb = () => globalThis.__postgresOperations;' }));
    } }], logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { enqueueTask, runNextTask, cleanupOperationalData } = await load('src/worker/services/task-queue.ts');
const { watchPartyRoutes } = await load('src/worker/routes/watch-party.ts');
const { operationsRoutes, allowOperation } = await load('src/worker/routes/operations.ts');
const env = {};
const roomRequest = (suffix = '', init) => watchPartyRoutes.request(`https://local.test/api/watch-party/TESTROOM${suffix}`, init, env);

test('PostgreSQL: partial unique index deduplicates active tasks, claims do not overlap, retry is bounded', async () => {
  const [first, second] = await Promise.all([enqueueTask(env, 'scan'), enqueueTask(env, 'scan')]);
  assert.equal(first.id, second.id);
  let calls = 0;
  const handler = { scan: async () => { calls++; return { ok: true }; } };
  const runs = await Promise.all([runNextTask(env, handler), runNextTask(env, handler)]);
  assert.equal(calls, 1);
  assert.equal(runs.filter(run => run.processed).length, 1);
  assert.equal((await db.query('SELECT status FROM app_tasks WHERE id=$1', [first.id])).rows[0].status, 'completed');
  const next = await enqueueTask(env, 'scan');
  assert.notEqual(next.id, first.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db.query("UPDATE app_tasks SET available_at=now()-interval '1 minute' WHERE id=$1", [next.id]);
    const run = await runNextTask(env, { scan: async () => { throw new Error('upstream failed'); } });
    assert.equal(run.status, attempt === 3 ? 'failed' : 'queued');
  }
  assert.equal((await db.query('SELECT attempts FROM app_tasks WHERE id=$1', [next.id])).rows[0].attempts, 3);
});

test('PostgreSQL: limiter survives independent requests and resets only after expiration', async () => {
  assert.equal(await allowOperation(env, 'test-limit', 2), true);
  assert.equal(await allowOperation(env, 'test-limit', 2), true);
  assert.equal(await allowOperation(env, 'test-limit', 2), false);
  await db.exec("UPDATE app_rate_limits SET expires_at=now()-interval '1 minute'");
  assert.equal(await allowOperation(env, 'test-limit', 2), true);
});

test('PostgreSQL: room state persists, event cursors are incremental and invalid commands cannot be stored', async () => {
  const send = payload => roomRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'participant-1', ...payload }) });
  assert.equal((await send({ type: 'sync_state', playing: false, currentTime: 42, mediaItemId: 'movie' })).status, 200);
  const initial = await (await roomRequest('?clientId=participant-2')).json();
  assert.equal(initial.state.currentTime, 42);
  assert.deepEqual(initial.events, []);
  assert.equal((await send({ type: 'chat', chatText: 'Olá!' })).status, 200);
  const next = await (await roomRequest(`?clientId=participant-2&cursor=${initial.cursor}`)).json();
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].payload.chatText, 'Olá!');
  const again = await (await roomRequest(`?clientId=participant-2&cursor=${next.cursor}`)).json();
  assert.deepEqual(again.events, []);
  assert.equal((await send({ type: 'remote_command', command: 'arbitrary_command' })).status, 400);
});

test('PostgreSQL: telemetry aggregates in bounded dimensions and maintenance removes expired records', async () => {
  const send = () => operationsRoutes.request('https://local.test/api/player-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'ios', event: 'start', durationMs: 1200 }) }, env);
  assert.equal((await send()).status, 204);
  assert.equal((await send()).status, 204);
  const rows = (await db.query('SELECT count,duration_ms FROM app_player_metrics')).rows;
  assert.equal(Number(rows[0].count), 2);
  assert.equal(Number(rows[0].duration_ms), 2400);
  await db.exec("UPDATE app_player_metrics SET day=current_date-20; UPDATE app_rooms SET updated_at=now()-interval '2 days'");
  await cleanupOperationalData(env);
  assert.equal((await db.query('SELECT * FROM app_player_metrics')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM app_room_events')).rows.length, 0);
});
