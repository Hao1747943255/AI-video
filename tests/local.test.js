import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalServices, localUrl, MODEL_NAMES } from '../server/local.js';
import { downloadVerified } from '../scripts/download-models.mjs';
import { createApp } from '../server/app.js';

const payload = { id: 'local-test', prompt: '小狐狸在森林中缓慢行走，清晨柔和阳光，镜头平稳跟随。', style: 'nature', provider: 'comfyui', seconds: 2, ratio: '16:9' };
function nodeInfo(modern = false) {
  const info = Object.fromEntries(['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyHunyuanLatentVideo', 'ModelSamplingSD3', 'KSampler', 'VAEDecode', 'CreateVideo', 'SaveVideo'].map(name => [name, {}]));
  info.UNETLoader.input = { required: { unet_name: [[MODEL_NAMES.unet]] } };
  info.CLIPLoader.input = { required: { clip_name: [[MODEL_NAMES.clip]] } };
  info.VAELoader.input = { required: { vae_name: [[MODEL_NAMES.vae]] } };
  info.SaveVideo.input = { required: { format: [modern ? 'COMFY_DYNAMICCOMBO_V3' : ['auto', 'mp4', 'webm']] } };
  return info;
}

test('local endpoints accept only loopback HTTP, not remote services or redirects via URL input', () => {
  assert.equal(localUrl(undefined, 8188), 'http://127.0.0.1:8188');
  for (const value of ['https://example.com', 'http://192.168.1.1:8188', 'http://localhost:8188/path', 'http://user:password@localhost:8188', 'http://localhost:8188?target=remote']) {
    assert.throws(() => localUrl(value, 8188));
  }
});

test('checks actual named models, enhances via Ollama and unloads LLM after completion', async () => {
  const requests = [];
  const services = createLocalServices({ request: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3:4b' }] });
    if (url.endsWith('/object_info')) return Response.json(nodeInfo());
    if (url.endsWith('/free')) return Response.json({});
    if (url.endsWith('/api/chat')) return Response.json({ message: { content: '清晨，小狐狸穿过薄雾笼罩的森林，镜头平稳跟随它的脚步，柔和阳光照亮苔藓。' } });
    throw new Error('Unexpected endpoint');
  } });
  const status = await services.inspect();
  assert.equal(status.language.ready, true);
  assert.equal(status.video.ready, true);
  assert.match(await services.enhance(payload.prompt), /小狐狸/);
  const chatIndex = requests.findIndex(item => item.url.endsWith('/api/chat'));
  assert.ok(requests.findIndex(item => item.url.endsWith('/free')) < chatIndex);
  const body = JSON.parse(requests[chatIndex].options.body);
  assert.equal(body.keep_alive, 0);
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(body.messages[1].content, payload.prompt);
});

test('missing model files are reported as not ready, with no task submission', async () => {
  const services = createLocalServices({ request: async url => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [] });
    if (url.endsWith('/object_info')) { const info = nodeInfo(); info.UNETLoader.input.required.unet_name[0] = []; return Response.json(info); }
    throw new Error('Must not submit');
  } });
  const status = await services.inspect();
  assert.equal(status.language.ready, false);
  assert.equal(status.video.ready, false);
  assert.match(status.video.message, /wan2.1_t2v_1.3B/);
  await assert.rejects(services.render(payload, { dataDir: '/tmp', update() {} }), /缺少模型文件/);
});

for (const modern of [false, true]) test(`submits native Wan workflow, polls history and saves MP4 (${modern ? 'modern' : 'legacy'} SaveVideo schema)`, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-local-'));
  let submitted;
  let polls = 0;
  const updates = [];
  const services = createLocalServices({ pollMs: 1, request: async (url, options) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [] });
    if (url.endsWith('/object_info')) return Response.json(nodeInfo(modern));
    if (url.endsWith('/prompt')) { submitted = JSON.parse(options.body); return Response.json({ prompt_id: 'comfy-test', node_errors: {} }); }
    if (url.endsWith('/history/comfy-test')) {
      polls++;
      return Response.json(polls < 2 ? {} : { 'comfy-test': { status: { completed: true, status_str: 'success' }, outputs: { '11': { images: [{ filename: 'test.mp4', subfolder: 'frame', type: 'output' }] } } } });
    }
    if (url.includes('/view?')) return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } });
    throw new Error('Unexpected request');
  } });
  try {
    await services.render(payload, { dataDir, update: value => updates.push(value) });
    assert.equal(submitted.prompt['1'].inputs.unet_name, MODEL_NAMES.unet);
    assert.equal(submitted.prompt['2'].inputs.device, 'cpu');
    const latent = submitted.prompt['6'].inputs;
    assert.equal(latent.length % 4, 1);
    assert.equal(latent.width, 512);
    assert.equal(latent.height, 288);
    assert.equal(latent.length / submitted.prompt['10'].inputs.fps, payload.seconds);
    assert.equal(submitted.prompt['8'].inputs.sampler_name, 'uni_pc');
    assert.ok(Number.isSafeInteger(submitted.prompt['8'].inputs.seed));
    assert.deepEqual(submitted.prompt['11'].inputs.format, modern ? { format: 'mp4', codec: { codec: 'h264' } } : 'mp4');
    assert.equal(polls, 2);
    assert.ok(updates.some(update => update.remoteId === 'comfy-test'));
    assert.equal((await readFile(path.join(dataDir, `${payload.id}.mp4`))).length, 4);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('ComfyUI GPU failure is surfaced without marking a video completed or switching provider', async () => {
  const services = createLocalServices({ request: async url => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [] });
    if (url.endsWith('/object_info')) return Response.json(nodeInfo());
    return Response.json({ remote: { status: { completed: false, status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } });
  } });
  await assert.rejects(services.render({ ...payload, remoteId: 'remote' }, { dataDir: '/tmp', update() {} }), /显存或内存不足/);
});

test('model downloads resume from partial data, verify SHA-256 and reject tampered content', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-download-'));
  const destination = path.join(dataDir, 'model.safetensors');
  const bytes = Buffer.from('verified model test bytes');
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    await writeFile(`${destination}.part`, bytes.subarray(0, 5));
    const result = await downloadVerified('https://example.test/model', destination, expected, async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=5-');
      return new Response(bytes.subarray(5), { status: 206, headers: { 'Content-Range': `bytes 5-${bytes.length - 1}/${bytes.length}` } });
    });
    assert.equal(result, 'downloaded and SHA-256 verified');
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(await downloadVerified('https://example.test/model', destination, expected, () => { throw new Error('Must not redownload'); }), 'already verified');
    await rm(destination);
    await assert.rejects(downloadVerified('https://example.test/model', destination, expected, async () => new Response(Buffer.alloc(bytes.length))), /SHA-256/);
    await assert.rejects(readFile(destination));
    await assert.rejects(readFile(`${destination}.part`));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP accepts 2-second local jobs, runs the local provider and validates prompt enhancement', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-local-api-'));
  let renderCount = 0;
  const local = {
    model: 'qwen3:4b',
    inspect: async () => ({ language: { ready: true }, video: { ready: true } }),
    enhance: async prompt => `${prompt}，柔和光线，镜头平稳向前。`,
    render: async job => { renderCount++; assert.equal(job.provider, 'comfyui'); await writeFile(path.join(dataDir, `${job.id}.mp4`), new Uint8Array([0, 1, 2])); },
  };
  const service = createApp({ dataDir, key: '', local });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { service.stop(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (endpoint, body) => fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/prompts/enhance', { prompt: '短' })).status, 400);
  const enhanced = await (await post('/api/prompts/enhance', { prompt: payload.prompt })).json();
  assert.match(enhanced.prompt, /柔和光线/);
  assert.equal((await post('/api/jobs', { ...payload, seconds: 8 })).status, 400);
  const response = await post('/api/jobs', payload);
  assert.equal(response.status, 202);
  const created = await response.json();
  await new Promise(resolve => setTimeout(resolve, 40));
  const job = await (await fetch(`${base}/api/jobs/${created.id}`)).json();
  assert.equal(job.status, 'completed');
  assert.equal(job.provider, 'comfyui');
  assert.equal(renderCount, 1);
});
