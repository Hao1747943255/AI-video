import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localUrl } from '../server/local.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exitCode = 0; });
function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.push(child);
  child.on('error', () => { console.error(`Cannot start ${path.basename(command)}. Check the local deployment guide.`); stop(); process.exitCode = 1; });
  return child;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reachable(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }); await response.body?.cancel(); return response.ok; } catch { return false; }
}
async function waitFor(url, label) {
  for (let i = 0; i < 120 && !stopping; i++) {
    if (await reachable(url)) return;
    await wait(1000);
  }
  throw new Error(`${label} did not start. Check the service terminal output.`);
}
try {
  const ollama = localUrl(process.env.OLLAMA_URL, 11434);
  const comfy = localUrl(process.env.COMFYUI_URL, 8188);
  if (!await reachable(`${ollama}/api/tags`)) {
    console.log('Starting Ollama…');
    run('ollama', ['serve'], { env: { ...process.env, OLLAMA_HOST: new URL(ollama).host } });
    await waitFor(`${ollama}/api/tags`, 'Ollama');
  }
  if (!await reachable(`${comfy}/system_stats`)) {
    const comfyDir = process.env.COMFYUI_DIR;
    const python = process.env.COMFYUI_PYTHON;
    if (!comfyDir || !python || !existsSync(path.join(comfyDir, 'main.py')) || !existsSync(python)) throw new Error('Set absolute COMFYUI_DIR and COMFYUI_PYTHON paths in .env, or start ComfyUI manually first.');
    console.log('Starting ComfyUI in low VRAM mode…');
    run(python, ['main.py', '--listen', new URL(comfy).hostname.replace(/^\[|\]$/g, ''), '--port', new URL(comfy).port || '8188', '--lowvram'], { cwd: comfyDir });
    await waitFor(`${comfy}/system_stats`, 'ComfyUI');
  }
  const build = run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root });
  const code = await new Promise(resolve => { build.once('exit', resolve); build.once('error', () => resolve(1)); });
  if (code !== 0 || stopping) throw new Error('Web build failed or startup was interrupted.');
  console.log(`Open http://127.0.0.1:${process.env.PORT || 3001} in your browser. Check local model status in Generation Settings.`);
  const web = run(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env: { ...process.env, HOST: '127.0.0.1' } });
  web.once('exit', code => { stop(); process.exitCode = code || 0; });
} catch (error) { console.error(error.message); stop(); process.exitCode = 1; }
