import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('a duplicate backend fails clearly without logging startup success or stopping the existing service', { timeout: 15000 }, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frame-startup-'));
  await cp(path.join(root, 'server'), path.join(directory, 'server'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  const existing = createServer((_req, res) => res.end('existing backend'));
  existing.listen(0, '127.0.0.1');
  await new Promise(resolve => existing.once('listening', resolve));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    await new Promise(resolve => existing.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const port = existing.address().port;
  child = spawn(process.execPath, [path.join(directory, 'server/index.js')], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(code, 1);
  assert.match(stderr, /已被占用/);
  assert.doesNotMatch(stdout, /Frame server listening/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing backend');
});
