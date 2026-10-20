import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
const local=parseEnv(await readFile(new URL('../.dev.vars',import.meta.url),'utf8'));
const values={};
for(const name of ['ACCESS_CODE','ADMIN_CODE','SESSION_SECRET']) {
 if(!local[name] || local[name].length<16)throw new Error(`Credencial ${name} ausente ou inválida. Execute setup:access.`);
 values[name]=local[name];
}
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk'],{
 cwd:new URL('..',import.meta.url),input:JSON.stringify(values),encoding:'utf8',windowsHide:true,
 env:{...process.env,WRANGLER_LOG_PATH:new URL('../build-logs/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')}
});
// Wrangler reports names and counts; never print input or credential values.
if(result.status!==0) {console.error('Não foi possível publicar os segredos de acesso. Os valores não foram impressos.');process.exit(1);}
console.log('Os três segredos de acesso foram publicados na Cloudflare. DATABASE_URL e demais segredos foram preservados.');
