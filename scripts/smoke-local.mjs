import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const origin = new URL(process.argv[2] || 'http://127.0.0.1:5178');
const production=process.argv.includes('--production');
assert.ok(production ? origin.origin==='https://minattoflix-v2.rafalegollas.workers.dev' : ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.protocol === 'http:', 'Destino de validação não autorizado.');
const local = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
const login = async code => {
  const response = await fetch(new URL('/api/session', origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(response.status, 200, 'Login local falhou');
  return (await response.json()).token;
};
const token = await login(local.ADMIN_CODE);
const headers = { Authorization: `Bearer ${token}` };
const state = await (await fetch(new URL('/api/session', origin), { headers })).json();
assert.equal(state.authenticated, true);
assert.equal(state.role, 'admin');
const health = await fetch(new URL('/api/health?deep=true', origin), { headers });
assert.equal(health.status, 200, 'Conexão do runtime local com Neon falhou');
const status = await (await fetch(new URL('/api/cloudflare/status', origin), { headers })).json();
for (const field of ['r2Connected','kvConnected','workersAiConnected','durableObjectsConnected','hyperdriveConnected']) assert.equal(status[field], false);
const diagnostics = await fetch(new URL('/api/admin/diagnostics', origin), { headers });
assert.equal(diagnostics.status, 200, 'Migração operacional indisponível');
const viewer = await login(local.ACCESS_CODE);
assert.equal((await fetch(new URL('/api/admin/diagnostics', origin), { headers: { Authorization: `Bearer ${viewer}` } })).status, 403);
console.log(`Runtime ${production?'de produção':'local'} validado com Neon existente: login, sessão, privilégios, diagnóstico profundo e bloqueio de bindings adicionais. Nenhum segredo impresso.`);
