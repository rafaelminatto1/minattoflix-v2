import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
function check(value) {
  assert.equal(value.vars?.COST_MODE, 'restricted', 'COST_MODE precisa permanecer restricted');
  assert.equal(value.observability?.enabled, false, 'Logs persistidos precisam permanecer desativados');
  assert.ok(value.limits?.cpu_ms <= 10000, 'Limite de CPU ausente ou ampliado');
  for (const key of ['ai','kv_namespaces','r2_buckets','hyperdrive','queues','workflows','vectorize','images','containers','analytics_engine_datasets']) {
    assert.ok(!value[key] || Array.isArray(value[key]) && value[key].length === 0, `Binding adicional bloqueado: ${key}`);
  }
  assert.ok(!value.durable_objects?.bindings?.length, 'Durable Objects não devem receber novas chamadas');
}
check(config);
for (const environment of Object.values(config.env || {})) check({ ...config, ...environment });
console.log('Política verificada: nenhum binding de serviço adicional ativo. Isso não limita a fatura de Workers/Neon nem apaga armazenamento antigo.');
