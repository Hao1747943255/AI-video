import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemplateVision } from '../server/template-vision.js';

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]).toString('base64');
const profile = {
  summary: '洁净诊室内，设备治疗头靠近前臂纹身区域。', scene: '白色墙壁，明亮诊室',
  characters: '画面中可见一只前臂和操作人员的手', objects: '设备与治疗头', style: '柔和均匀光照',
  camera: '固定近景构图，无法仅凭静帧判断运动', actions: '治疗头靠近纹身区域',
};

function fixture(overrides = {}) {
  const calls = [];
  let chat = { message: { thinking: 'private reasoning', content: JSON.stringify(profile) } };
  const request = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    if (overrides.request) {
      const result = await overrides.request(url, options, body);
      if (result !== undefined) return result;
    }
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3:4b' }, { name: 'qwen2.5vl:3b' }] });
    if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'vision'] });
    if (url.endsWith('/api/generate') || url.endsWith('/free')) return Response.json({});
    if (url.endsWith('/api/chat')) return Response.json(chat);
    throw new Error('Unexpected endpoint');
  };
  return { calls, setChat: value => { chat = value; }, service: createTemplateVision({ request, ...overrides.options }) };
}

test('vision analysis sends actual images, constrains its schema and releases cached GPU models', async () => {
  const f = fixture();
  assert.equal((await f.service.inspect()).ready, true);
  const result = await f.service.analyze([image, image], { kind: 'video', duration: 12, filename: 'never-send-private-path' });
  assert.deepEqual(result, profile);
  const chat = f.calls.find(call => call.url.endsWith('/api/chat'));
  assert.deepEqual(chat.body.messages[1].images, [image, image]);
  assert.match(chat.body.messages[1].content, /"kind":"video"/);
  assert.match(chat.body.messages[1].content, /"duration":12/);
  assert.doesNotMatch(chat.body.messages[1].content, /never-send-private-path/);
  assert.equal(chat.body.think, false);
  assert.equal(chat.body.keep_alive, 0);
  assert.equal(chat.body.stream, false);
  assert.equal(chat.body.options.num_ctx, 8192);
  assert.deepEqual(chat.body.format.required, Object.keys(profile));
  assert.equal(chat.body.format.additionalProperties, false);
  const chatIndex = f.calls.indexOf(chat);
  assert.ok(f.calls.findIndex(call => call.url.endsWith('/free')) < chatIndex);
  assert.ok(f.calls.findIndex(call => call.url.endsWith('/api/generate') && call.body.model === 'qwen3:4b') < chatIndex);
  assert.equal(f.calls.at(-1).body.model, 'qwen2.5vl:3b');
  assert.equal(f.calls.at(-1).body.keep_alive, 0);
});

test('ordinary text models and missing vision models are never presented as usable template analysis', async () => {
  const missing = fixture({ request: async url => url.endsWith('/api/tags') ? Response.json({ models: [{ name: 'qwen3:4b' }] }) : undefined });
  assert.match((await missing.service.inspect()).message, /ollama pull qwen2\.5vl:3b/);
  await assert.rejects(missing.service.analyze([image]), /视觉模型/);
  assert.equal(missing.calls.some(call => call.url.endsWith('/api/chat')), false);
  const text = fixture({ request: async url => url.endsWith('/api/show') ? Response.json({ capabilities: ['completion'], model_info: { 'general.architecture': 'qwen2vl' } }) : undefined });
  assert.equal((await text.service.inspect()).ready, false);
  await assert.rejects(text.service.analyze([image]), /视觉能力/);
  assert.equal(text.calls.some(call => call.url.endsWith('/api/chat')), false);
});

test('older model metadata is accepted only for known visual architectures', async () => {
  const vision = fixture({ request: async url => url.endsWith('/api/show') ? Response.json({ model_info: { 'general.architecture': 'qwen2vl' } }) : undefined });
  assert.equal((await vision.service.inspect()).ready, true);
  const text = fixture({ request: async url => url.endsWith('/api/show') ? Response.json({ model_info: { 'general.architecture': 'qwen3' } }) : undefined });
  assert.equal((await text.service.inspect()).ready, false);
});

test('invalid, reasoning, truncated and oversized profile outputs fail without inventing descriptions', async () => {
  const f = fixture();
  for (const result of [
    { message: { content: '首先，用户想要一个分析，我需要先理解。' } },
    { message: { content: `<think>reasoning</think>${JSON.stringify(profile)}` } },
    { done_reason: 'length', message: { content: JSON.stringify(profile) } },
    { message: { content: JSON.stringify({ ...profile, summary: '短' }) } },
    { message: { content: JSON.stringify({ ...profile, objects: '物'.repeat(501) }) } },
    { message: { content: JSON.stringify({ ...profile, actions: '<think>这是模型分析</think>' }) } },
    { message: { content: JSON.stringify({ ...profile, extra: 'forbidden' }) } },
    { message: { content: JSON.stringify(Object.fromEntries(Object.keys(profile).map(key => [key, '字'.repeat(400)]))) } },
  ]) {
    f.setChat(result);
    await assert.rejects(f.service.analyze([image]), /模板|视觉模型/);
    assert.equal(f.calls.at(-1).body.model, 'qwen2.5vl:3b');
    assert.equal(f.calls.at(-1).body.keep_alive, 0);
  }
  f.setChat({ message: { content: JSON.stringify(profile) } });
  assert.deepEqual(await f.service.analyze([image]), profile);
});

test('connection failures and HTTP errors never expose service secrets or response contents', async () => {
  const privateText = 'SECRET_private_path_and_token';
  const unreachable = fixture({ request: async url => {
    if (url.endsWith('/api/tags')) throw new TypeError(privateText, { cause: { code: 'ECONNREFUSED' } });
  } });
  const status = await unreachable.service.inspect();
  assert.equal(status.ready, false);
  assert.match(status.message, /ECONNREFUSED/);
  assert.doesNotMatch(status.message, new RegExp(privateText));
  const failed = fixture({ request: async url => url.endsWith('/api/chat') ? new Response(privateText, { status: 500 }) : undefined });
  await assert.rejects(failed.service.analyze([image]), error => {
    assert.match(error.message, /HTTP 500/);
    assert.doesNotMatch(error.message, new RegExp(privateText));
    return true;
  });
  assert.equal(failed.calls.at(-1).body.model, 'qwen2.5vl:3b');
});

test('analysis can run when ComfyUI is not listening but refuses uncertain cache release failures', async () => {
  const absent = fixture({ request: async url => {
    if (url.endsWith('/free')) throw new TypeError('unused private error', { cause: { code: 'ECONNREFUSED' } });
  } });
  assert.deepEqual(await absent.service.analyze([image]), profile);
  const serverError = fixture({ request: async url => url.endsWith('/free') ? new Response('private', { status: 500 }) : undefined });
  await assert.rejects(serverError.service.analyze([image]), /ComfyUI.*HTTP 500/);
  assert.equal(serverError.calls.some(call => call.url.endsWith('/api/chat')), false);
});

test('cache release accepts successful empty bodies from ComfyUI and Ollama', async () => {
  const f = fixture({ request: async url => url.endsWith('/free') || url.endsWith('/api/generate')
    ? new Response(null, { status: 200 }) : undefined });
  assert.deepEqual(await f.service.analyze([image]), profile);
});

test('bad image inputs, remote URLs and unsafe model settings are rejected before analysis', async () => {
  const f = fixture();
  for (const images of [[], Array(7).fill(image), ['not-a-jpeg'], [Buffer.from('not jpeg contents').toString('base64')], ['data:image/jpeg;base64,' + image]]) {
    await assert.rejects(f.service.analyze(images), /参考图片/);
  }
  assert.equal(f.calls.length, 0);
  for (const url of ['https://127.0.0.1:11434', 'http://example.com', 'http://127.0.0.1:11434/path', 'http://user:secret@localhost:11434']) {
    assert.throws(() => createTemplateVision({ ollamaUrl: url }), /本机/);
  }
  assert.throws(() => createTemplateVision({ model: 'private name; command' }), /模型名称/);
  assert.throws(() => createTemplateVision({ timeoutMs: Infinity }), /超时/);
});

test('successful analysis is not reported as ready if vision model release fails', async () => {
  const f = fixture({ request: async (url, _options, body) => url.endsWith('/api/generate') && body.model === 'qwen2.5vl:3b'
    ? new Response('private details', { status: 500 }) : undefined });
  await assert.rejects(f.service.analyze([image]), /视觉模型释放未确认/);
});
