import { spawn } from 'node:child_process';
import { resolve, extname, dirname } from 'node:path';
import { stat, mkdir } from 'node:fs/promises';

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error('Uso: node scripts/prepare-local.mjs "original.mkv" "copia-iphone.mp4"');
  process.exit(1);
}
const input = resolve(inputArg), output = resolve(outputArg);
if (input.toLowerCase() === output.toLowerCase() || extname(output).toLowerCase() !== '.mp4') throw new Error('Escolha um novo arquivo de saída .mp4.');
if (!(await stat(input)).isFile()) throw new Error('A origem precisa ser um arquivo local.');
await mkdir(dirname(output), { recursive: true });
// No shell, no overwrite, no cloud runner. All audio tracks become AAC; text subtitles can be uploaded separately.
const args = ['-nostdin','-n','-i',input,'-map','0:v:0','-map','0:a?','-map_metadata','0',
  '-c:v','libx264','-preset','medium','-crf','22','-pix_fmt','yuv420p',
  '-vf',"scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
  '-c:a','aac','-b:a','192k','-ac','2','-sn','-movflags','+faststart',output];
const child = spawn('ffmpeg', args, { stdio: 'inherit', shell: false, windowsHide: true });
child.on('error', () => { console.error('Instale FFmpeg no computador e disponibilize-o no PATH.'); process.exitCode = 1; });
child.on('exit', code => {
  process.exitCode = code === 0 ? 0 : 1;
  if (code === 0) console.log('Cópia MP4 pronta. Envie à pasta da mídia no OneDrive/Drive e solicite a sincronização. O original foi preservado.');
});
