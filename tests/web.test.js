import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

test('missing frontend gives actionable instructions; a later build becomes available without restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frame-web-'));
  const webDir = path.join(directory, 'dist');
  const service = createApp({ dataDir: path.join(directory, 'data'), webDir, key: '' });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.stop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const missing = await fetch(base);
  assert.equal(missing.status, 503);
  const instructions = await missing.text();
  assert.match(instructions, /npm\.cmd run build/);
  assert.match(instructions, /5173/);
  assert.doesNotMatch(instructions, /Cannot GET/);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'frame-ai-video', frontendReady: false });
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);

  await mkdir(path.join(webDir, 'assets'), { recursive: true });
  const html = '<!doctype html><html><head><title>Frame test build</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
  await writeFile(path.join(webDir, 'index.html'), html);
  await writeFile(path.join(webDir, 'assets', 'app.js'), 'console.log("Frame test bundle");');
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  assert.equal(await homepage.text(), html);
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  const navigation = await fetch(`${base}/works`);
  assert.equal(navigation.status, 200);
  assert.equal(await navigation.text(), html);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'frame-ai-video', frontendReady: true });
});
