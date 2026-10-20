import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../.dev.vars', import.meta.url);
let content = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
for (const name of ['ACCESS_CODE','ADMIN_CODE','SESSION_SECRET']) {
  if (!new RegExp(`^${name}=`, 'm').test(content)) content += `\n${name}=${randomBytes(name === 'SESSION_SECRET' ? 32 : 12).toString('hex')}\n`;
}
await writeFile(path, content, { mode: 0o600 });
console.log('Credenciais criadas/preservadas em .dev.vars (ignorado pelo Git). Abra o arquivo localmente para consultar os códigos. Nunca coloque esses valores no app ou no repositório.');
