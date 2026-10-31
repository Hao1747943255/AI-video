import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fetch, EnvHttpProxyAgent } from 'undici';

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadVerified(url, destination, expected, request = fetch) {
  await mkdir(path.dirname(destination), { recursive: true });
  const valid = async file => {
    try { return (await stat(file)).size === expected.size && await sha256(file) === expected.sha256; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (await valid(destination)) return 'already verified';
  try { await stat(destination); throw new Error(`Existing model has an unexpected checksum. Preserve it and move it manually before retrying: ${path.basename(destination)}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${destination}.part`;
  let offset = 0;
  try { offset = (await stat(partial)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (offset === expected.size && await valid(partial)) { await rename(partial, destination); return 'verified partial'; }
  if (offset >= expected.size) { await rm(partial); offset = 0; }
  const response = await request(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(4 * 60 * 60_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Model download failed (HTTP ${response.status}). Check connectivity to Hugging Face; no paid token is required for these public files.`); }
  if (response.status === 206) {
    if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) { await response.body.cancel(); throw new Error('Invalid partial download response; existing partial file was preserved.'); }
  } else if (response.status === 200) offset = 0;
  else { await response.body.cancel(); throw new Error('Unexpected download response.'); }
  let received = offset;
  let nextReport = Math.floor(received / expected.size * 10) + 1;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > expected.size) return callback(new Error('Downloaded file exceeds expected size.'));
    if (received / expected.size * 10 >= nextReport) { console.log(`${path.basename(destination)}: ${Math.floor(received / expected.size * 100)}%`); nextReport++; }
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
  if (!await valid(partial)) { await rm(partial); throw new Error('Model SHA-256 verification failed. The unverified download was removed; retry from the official source.'); }
  await rename(partial, destination);
  return 'downloaded and SHA-256 verified';
}

async function main() {
  const args = process.argv.slice(2);
  const comfyDir = args.find(arg => !arg.startsWith('--'));
  if (!comfyDir) throw new Error('Usage: npm run models:download -- "C:/AI/ComfyUI" [--dry-run]');
  if (!(await stat(path.join(comfyDir, 'main.py')).catch(() => null))?.isFile()) throw new Error('Choose the ComfyUI directory that contains main.py (not the portable package parent).');
  const manifest = JSON.parse(await readFile(new URL('../local/models.json', import.meta.url), 'utf8'));
  console.log(`Public Wan 2.1 models: ${(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9).toFixed(2)} GB total. Keep at least 25 GB free for models, runtime, partial files and videos.`);
  if (args.includes('--dry-run')) { manifest.files.forEach(file => console.log(`${file.path}  ${file.sha256}`)); return; }
  const dispatcher = new EnvHttpProxyAgent();
  try {
    for (const file of manifest.files) {
      const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/split_files/${file.path}`;
      console.log(`${file.path}: ${await downloadVerified(url, path.join(comfyDir, 'models', file.path), file, (address, options) => fetch(address, { ...options, dispatcher }))}`);
    }
  } finally { await dispatcher.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message.startsWith('fetch') ? 'Network download failed. Partial files were preserved; rerun to resume.' : error.message); process.exitCode = 1; });
}
