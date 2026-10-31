import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { renderSora } from '../server/providers.js';

const payload = { prompt: '清晨的森林里，阳光透过树叶，镜头缓缓前进。', provider: 'demo', style: 'nature', seconds: 4, ratio: '16:9' };
async function start(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-test-'));
  const service = createApp({ dataDir, key: '', ...options });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.stop(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, body, method = 'POST') => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, dataDir, request };
}

test('validates input, reports credentials safely and never falls back to demo for AI requests', async t => {
  const { base, request } = await start(t);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.soraReady, false);
  assert.equal(config.demoReady, true);
  for (const invalid of [{ ...payload, prompt: '短' }, { ...payload, seconds: 5 }, { ...payload, ratio: '1:1' }, { ...payload, style: '__proto__' }, { ...payload, provider: 'other' }]) {
    assert.equal((await request('/api/jobs', invalid)).status, 400);
  }
  assert.equal((await request('/api/jobs', { ...payload, provider: 'sora' })).status, 503);
  assert.equal((await fetch(`${base}/api/jobs/not-found/video`)).status, 404);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  const malformed = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await (await fetch(`${base}/api/jobs`)).json(), []);
});

test('renders real landscape and portrait MP4s, persists jobs, supports ranges and deletes files', { timeout: 120_000 }, async t => {
  const { base, dataDir, request } = await start(t);
  for (const ratio of ['16:9', '9:16']) {
    const response = await request('/api/jobs', { ...payload, ratio });
    assert.equal(response.status, 202);
    const created = await response.json();
    let job;
    for (let attempt = 0; attempt < 200; attempt++) {
      job = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
      if (['completed', 'failed'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.progress, 100);
    const video = await fetch(`${base}${job.videoUrl}`);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.ok((await video.arrayBuffer()).byteLength > 1000);
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(dataDir, `${job.id}.mp4`)], { encoding: 'utf8' }));
    assert.equal(metadata.streams[0].codec_name, 'h264');
    assert.equal(metadata.streams[0].width, ratio === '16:9' ? 1280 : 720);
    assert.equal(metadata.streams[0].height, ratio === '16:9' ? 720 : 1280);
    assert.equal(Number(metadata.format.duration), 4);
    const range = await fetch(`${base}${job.videoUrl}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
    const download = await fetch(`${base}${job.videoUrl}?download=1`);
    assert.match(download.headers.get('content-disposition'), /attachment; filename="?frame-[a-f0-9]{8}\.mp4"?$/);
    await download.arrayBuffer();
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'jobs.json'), 'utf8')).find(item => item.id === job.id).status, 'completed');
    assert.equal((await request(`/api/jobs/${job.id}`, undefined, 'DELETE')).status, 204);
    assert.equal((await fetch(`${base}${job.videoUrl}`)).status, 404);
    await assert.rejects(readFile(path.join(dataDir, `${job.id}.mp4`)));
  }
});

test('failed renders show an actionable error and do not claim completion', async t => {
  const { base, request } = await start(t, { renderDemo: async () => { throw new Error('模拟渲染失败'); } });
  const created = await (await request('/api/jobs', payload)).json();
  await new Promise(resolve => setTimeout(resolve, 40));
  const job = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
  assert.equal(job.status, 'failed');
  assert.equal(job.videoUrl, null);
  assert.equal(job.error, '模拟渲染失败');
});

test('Sora adapter sends documented multipart parameters, polls and stores completed content', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-sora-'));
  const calls = [];
  let pollCount = 0;
  const updates = [];
  const job = { ...payload, id: 'mock-job', provider: 'sora', ratio: '9:16', seconds: 8 };
  try {
    await renderSora(job, {
      key: 'test-only-key', dataDir, pollMs: 1, update: changes => updates.push(changes),
      request: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/content')) return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } });
        if (options.method === 'POST') return Response.json({ id: 'video_test' });
        pollCount++;
        return Response.json(pollCount === 1 ? { status: 'in_progress', progress: 50 } : { status: 'completed', progress: 100 });
      },
    });
    const form = calls[0].options.body;
    assert.equal(form.get('model'), 'sora-2');
    assert.equal(form.get('seconds'), '8');
    assert.equal(form.get('size'), '720x1280');
    assert.ok(form.get('prompt').startsWith(payload.prompt));
    assert.equal(pollCount, 2);
    assert.ok(updates.some(update => update.remoteId === 'video_test'));
    assert.ok(updates.some(update => update.progress === 50));
    assert.equal((await readFile(path.join(dataDir, 'mock-job.mp4'))).length, 4);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('Sora authentication failure is handled without leaking upstream response or credentials', async () => {
  await assert.rejects(renderSora({ ...payload }, {
    key: 'must-not-leak', dataDir: '/tmp', update: () => {},
    request: async () => new Response('secret upstream detail must-not-leak', { status: 401 }),
  }), { message: 'API 密钥无效或已过期，请检查服务器配置。' });
});

test('restart keeps completed work and marks interrupted demo jobs as failed', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frame-restart-'));
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify([
    { ...payload, id: 'interrupted', status: 'processing' },
    { ...payload, id: 'completed', status: 'completed' },
  ]));
  const { app, stop } = createApp({ dataDir, key: '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const jobs = await (await fetch(`http://127.0.0.1:${server.address().port}/api/jobs`)).json();
  assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[1].status, 'completed');
});
