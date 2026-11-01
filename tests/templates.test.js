import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTemplateStore, validateTemplateProfile } from '../server/templates.js';
import { createApp } from '../server/app.js';

const profile = { summary: '明亮诊疗室内展示皮秒设备、治疗头与操作人员。', scene: '白色诊疗室与治疗台', characters: '戴护目镜的操作人员', objects: '皮秒设备与治疗头', style: '自然光与写实色彩', camera: '固定近景', actions: '治疗头平稳移动' };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frame-template 测试 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, 'source.jpg');
  const video = path.join(root, 'source.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180', '-frames:v', '1', '-threads', '1', image]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=16', '-t', '3', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', video]);
  return { root, image: await readFile(image), video: await readFile(video) };
}

test('template images are decoded, normalized, persisted and removed without exposing local paths', async t => {
  const f = await fixture(t);
  const store = createTemplateStore({ dataDir: f.root });
  const item = await store.add(f.image, { name: '../../private/参考.jpg', mime: 'video/mp4' });
  assert.equal(item.kind, 'image');
  assert.equal(item.mime, 'image/jpeg');
  assert.equal(item.name, '参考.jpg');
  assert.equal(item.frameCount, 1);
  assert.doesNotMatch(JSON.stringify(item), new RegExp(f.root));
  assert.deepEqual(await readFile(store.mediaPath(item.id)), f.image);
  assert.ok((await stat(store.thumbnailPath(item.id))).size > 0);
  const thumbnail = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', store.thumbnailPath(item.id)], { encoding: 'utf8' }));
  assert.equal(thumbnail.streams[0].width, 320);
  assert.equal(thumbnail.streams[0].height, 180);
  assert.deepEqual(createTemplateStore({ dataDir: f.root }).list(), store.list());
  await store.remove(item.id);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.mediaPath('../secret'), /模板不存在/);
});

test('video analysis receives actual sampled frames and preserves previous descriptions on failure', async t => {
  const f = await fixture(t);
  const store = createTemplateStore({ dataDir: f.root });
  const item = await store.add(f.video, { name: '参考.mp4' });
  assert.equal(item.kind, 'video');
  assert.equal(item.duration, 3);
  assert.equal(item.frameCount, 3);
  const ready = await store.analyze(item.id, async (images, metadata) => {
    assert.equal(images.length, 3);
    assert.equal(metadata.kind, 'video');
    assert.equal(metadata.duration, 3);
    assert.ok(images.every(image => Buffer.from(image, 'base64').subarray(0, 3).equals(Buffer.from([255, 216, 255]))));
    assert.ok(new Set(images).size > 1);
    return profile;
  });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.profile, profile);
  await assert.rejects(store.analyze(item.id, () => { throw new Error('private-token-and-path'); }), /原素材与已有描述已保留/);
  const failed = store.get(item.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.profile, profile);
  assert.deepEqual(await readFile(store.mediaPath(item.id)), f.video);
  assert.doesNotMatch(failed.error, /private-token-and-path/);
  assert.equal((await store.updateProfile(item.id, profile)).status, 'ready');
});

test('unsupported or damaged media and invalid profile structures are refused', async t => {
  const f = await fixture(t);
  const store = createTemplateStore({ dataDir: f.root });
  await assert.rejects(store.add(Buffer.from('<svg>not allowed</svg>'), { name: 'image.jpg' }), /格式/);
  await assert.rejects(store.add(Buffer.from([255, 216, 255, 0])), /读取或处理|画面无效/);
  assert.equal(store.list().length, 0);
  for (const invalid of [{}, { ...profile, summary: '短' }, { ...profile, scene: '字'.repeat(501) }, { ...profile, extra: 'wrong' }]) {
    assert.throws(() => validateTemplateProfile(invalid), /模板/);
  }
  const item = await store.add(f.image);
  const metaPath = path.join(f.root, 'templates', item.id, 'metadata.json');
  const saved = JSON.parse(await readFile(metaPath, 'utf8')); saved.status = 'analyzing';
  await writeFile(metaPath, JSON.stringify(saved));
  const restored = createTemplateStore({ dataDir: f.root }).get(item.id);
  assert.equal(restored.status, 'failed');
  assert.match(restored.error, /重启/);
});

async function apiFixture(t, f, visionOverride) {
  let rendered;
  const service = createApp({ dataDir: path.join(f.root, 'app'), key: '',
    vision: visionOverride || { model: 'test-vision', inspect: async () => ({ ready: true, model: 'test-vision' }), analyze: async () => profile },
    local: { model: 'test-text', inspect: async () => ({ language: { ready: true }, video: { ready: true } }), enhance: async value => value,
      render: async job => { rendered = job; await writeFile(path.join(f.root, 'app', `${job.id}.mp4`), Buffer.from('test output')); } },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.stop(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (endpoint, method = 'GET', body) => fetch(`${base}${endpoint}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const upload = () => fetch(`${base}/api/templates?name=example.jpg`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f.image });
  return { request, upload, base, rendered: () => rendered };
}

test('API persists a template reference snapshot and resolves prompt-controlled duration for generation', async t => {
  const f = await fixture(t); const api = await apiFixture(t, f);
  const response = await api.upload(); assert.equal(response.status, 201);
  const item = await response.json();
  assert.equal((await api.request(`/api/templates/${item.id}/analyze`, 'POST', {})).status, 200);
  const media = await fetch(`${api.base}${item.mediaUrl}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 10);
  const created = await api.request('/api/jobs', 'POST', { prompt: '生成7秒的视频，皮秒治疗头沿前臂缓慢移动，固定近景。', seconds: 2, durationMode: 'prompt', provider: 'comfyui', ratio: '16:9', style: 'cinematic', templateId: item.id, referenceAspects: ['scene', 'objects'] });
  assert.equal(created.status, 202); const job = await created.json();
  assert.equal(job.seconds, 7); assert.equal(job.templateId, item.id);
  for (let i = 0; !api.rendered() && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(api.rendered().prompt, /白色诊疗室/);
  assert.match(api.rendered().prompt, /皮秒设备与治疗头/);
  assert.doesNotMatch(api.rendered().prompt, /戴护目镜/);
  const publicJob = await (await api.request(`/api/jobs/${job.id}`)).json();
  assert.equal(publicJob.generationPrompt, undefined);
  assert.equal(publicJob.segments, undefined);
  assert.equal((await api.request(`/api/templates/${item.id}`, 'DELETE')).status, 204);
  assert.equal((await api.request(`/api/templates/${item.id}/media`)).status, 404);
});

test('analysis excludes video generation and prompt enhancement until it completes', async t => {
  const f = await fixture(t);
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const api = await apiFixture(t, f, { model: 'test-vision', inspect: async () => ({ ready: true }), analyze: async () => { started(); await pending; return profile; } });
  const item = await (await api.upload()).json();
  const analyzing = api.request(`/api/templates/${item.id}/analyze`, 'POST', {});
  await running;
  assert.equal((await api.request('/api/jobs', 'POST', { prompt: '皮秒设备沿手臂纹身缓慢移动，固定近景。', provider: 'comfyui', seconds: 8, ratio: '16:9', style: 'cinematic' })).status, 409);
  assert.equal((await api.request('/api/prompts/enhance', 'POST', { prompt: '皮秒设备缓慢移动' })).status, 409);
  assert.equal((await api.request(`/api/templates/${item.id}`, 'DELETE')).status, 409);
  release(); assert.equal((await analyzing).status, 200);
});
