import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { neon } from '@neondatabase/serverless';

const migration = await readFile(new URL('../migrations/001_reliability.sql', import.meta.url), 'utf8');
if (!process.argv.includes('--apply')) {
  console.log('Migração aditiva pronta. Para aplicar no Neon existente: npm run migrate:operations -- --apply. Nenhum banco ou branch é criado.');
  process.exit(0);
}
try {
  const local = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8').catch(() => ''));
  const connection = process.env.DATABASE_URL || local.DATABASE_URL;
  if (!connection) throw new Error('missing-connection');
  const target = new URL(connection);
  // Neon uses the same credentials for its direct endpoint. DDL does not use the pooler.
  target.hostname = target.hostname.replace('-pooler.', '.');
  const sql = neon(target.toString());
  const statements = migration.replace(/^--.*$/gm, '').split(';').map(statement => statement.trim()).filter(Boolean);
  await sql.transaction(statements.map(statement => sql.query(statement)));
  console.log('Migração aplicada em transação no banco configurado. Catálogo, perfis e progresso preservados.');
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,30}$/.test(error.code) ? error.code : 'sem código';
  console.error(`Não foi possível aplicar a migração (${code}). Verifique a conexão e as permissões do banco; nenhum segredo foi impresso.`);
  process.exitCode = 1;
}
