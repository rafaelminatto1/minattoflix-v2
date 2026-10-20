import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';

const local = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8').catch(() => ''));
const secrets = ['DATABASE_URL','ACCESS_CODE','ADMIN_CODE','SESSION_SECRET','GITHUB_TOKEN','MINATTO_WEBHOOK_SECRET','MINATTO_ADMIN_PASSWORD']
  .map(name => local[name] || process.env[name]).filter(value => value && value.length >= 8);
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else {
      const bytes = await readFile(path);
      if (secrets.some(value => bytes.includes(Buffer.from(value)))) throw new Error('Um segredo do servidor foi encontrado no bundle cliente. Publicação bloqueada.');
    }
  }
}
for (const directory of process.argv.slice(2)) await inspect(resolve(directory));
console.log(secrets.length ? 'Bundle cliente verificado: nenhum segredo do servidor presente.' : 'Nenhum segredo local disponível para comparação com o bundle cliente.');
