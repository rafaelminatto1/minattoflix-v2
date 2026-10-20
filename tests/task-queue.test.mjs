import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const queries = [];
let claimed = [];
globalThis.__taskSql = async (strings, ...values) => {
  const query = strings.join('?'); queries.push({ query, values });
  if (query.includes('RETURNING id, kind, attempts')) return claimed;
  if (query.includes('RETURNING id, kind, status')) return [{ id: 'existing', status: 'queued' }];
  return [];
};
const result = await build({ entryPoints: ['src/worker/services/task-queue.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'test-db', setup(builder) {
    builder.onResolve({ filter: /\/db$/ }, () => ({ path: 'db', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const getDb = () => globalThis.__taskSql;' }));
  } }] });
const { enqueueTask, runNextTask, cleanupOperationalData } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('enqueue uses the active-key constraint to deduplicate concurrent requests', async () => {
  queries.length = 0;
  assert.equal((await enqueueTask({}, 'scan')).id, 'existing');
  assert.match(queries[0].query, /ON CONFLICT.*dedupe_key/s);
  assert.deepEqual(queries[0].values, ['scan', 'scan']);
});

test('an empty claim never invokes a task handler', async () => {
  claimed = [];
  assert.deepEqual(await runNextTask({}, { scan() { throw new Error('Must not run'); } }), { processed: false });
});

test('success stores a bounded summary, and completion is fenced by the claim token', async () => {
  queries.length = 0; claimed = [{ id: 'job', kind: 'scan', attempts: 1 }];
  const output = await runNextTask({}, { scan: async () => ({ logs: ['https://private.test/?token=secret'] }) });
  assert.equal(output.status, 'completed');
  const claim = queries[0], completion = queries.at(-1);
  assert.match(claim.query, /FOR UPDATE SKIP LOCKED/);
  assert.match(completion.query, /lease_token =/);
  assert.equal(completion.values.at(-1), claim.values[0]);
  assert.equal(JSON.stringify(completion.values).includes('secret'), false);
  assert.doesNotThrow(() => JSON.parse(completion.values[0]));
});

test('errors retry with delay and become terminal after the third attempt', async () => {
  for (const attempts of [1, 3]) {
    queries.length = 0; claimed = [{ id: 'job', kind: 'scan', attempts }];
    const output = await runNextTask({}, { scan: async () => { throw new Error('postgres://private'); } });
    assert.equal(output.status, attempts === 3 ? 'failed' : 'queued');
    assert.match(queries.at(-1).query, /interval '15 minutes'/);
    assert.match(queries.at(-1).query, /lease_token =/);
    assert.equal(JSON.stringify(queries).includes('postgres://private'), false);
  }
});

test('maintenance expires operational records and stranded last-attempt leases', async () => {
  queries.length = 0;
  await cleanupOperationalData({});
  assert.ok(queries.some(({ query }) => query.includes('attempts >= 3')));
  assert.ok(queries.some(({ query }) => query.includes("interval '7 days'")));
  assert.equal(queries.some(({ query }) => /DELETE FROM (media_files|media_items|profiles|watch_progress)/.test(query)), false);
});
