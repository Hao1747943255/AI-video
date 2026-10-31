import 'dotenv/config';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createLocalServices } from '../server/local.js';

console.log(`System: ${os.platform()} ${os.arch()}; RAM: ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB; Node: ${process.version}`);
const gpu = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8' });
console.log(`NVIDIA GPU: ${gpu.status === 0 ? gpu.stdout.trim() : 'not detected (run this on your own computer)'}`);
for (const [name, args] of [['ffmpeg', ['-version']], ['ollama', ['--version']], ['git', ['--version']]]) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  console.log(`${name}: ${result.status === 0 ? 'installed' : 'not found on PATH'}`);
}
try {
  const status = await createLocalServices().inspect(true);
  console.log(`Language model: ${status.language.ready ? 'READY' : 'NOT READY'} — ${status.language.message}`);
  console.log(`Video model: ${status.video.ready ? 'READY' : 'NOT READY'} — ${status.video.message}`);
  if (!status.language.ready || !status.video.ready) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
