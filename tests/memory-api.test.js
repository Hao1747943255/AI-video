import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.js';
import { createMemoryStore } from '../server/memory.js';

const original = '白色诊疗室内，操作人员手持皮秒激光治疗头沿前臂纹身区域缓慢移动，固定近景。';
const resolved = '夜晚的诊疗室内，同一位操作人员手持皮秒激光治疗头沿前臂纹身区域缓慢移动，固定近景。';
const parameters = { provider: 'comfyui', ratio: '16:9', style: 'cinematic', seconds: 2, durationMode: 'manual' };

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-memory-api-'));
  const calls = [];
  const renders = [];
  let enhance = async prompt => prompt.length >= 10 ? prompt : resolved;
  const service = createApp({ dataDir, key: '',
    vision: { model: 'test-vision', inspect: async () => ({ ready: false, model: 'test-vision', message: '测试不调用视觉模型。' }) },
    local: {
      model: 'test-text',
      inspect: async () => ({ language: { ready: true }, video: { ready: true } }),
      enhance: async (prompt, options = {}) => {
        calls.push({ prompt, ...structuredClone(options) });
        return enhance(prompt, options);
      },
      render: async job => {
        renders.push(structuredClone(job));
        await writeFile(path.join(dataDir, `${job.id}.mp4`), Buffer.from('memory API test output'));
      },
    },
  });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    service.stop();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(`${base}${endpoint}`, { method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const state = await request('/api/memory');
  assert.equal(state.status, 200, 'memory routes must be installed before running these integration tests');
  const conversationId = state.data.sessions[0].id;
  const enhanceRequest = (prompt, id = conversationId, extra = {}) => request('/api/prompts/enhance', 'POST', { prompt, useMemory: true, conversationId: id, ...extra });
  const session = (id = conversationId) => request(`/api/memory/sessions/${id}`);
  const generate = (prompt, extra = {}) => request('/api/jobs', 'POST', { ...parameters, prompt, useMemory: true, conversationId, ...extra });
  const completed = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/api/jobs/${id}`);
      if (['completed', 'failed'].includes(result.data?.status)) return result.data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('mock generation did not finish');
  };
  return { request, session, conversationId, enhanceRequest, generate, completed, calls, renders,
    setEnhance: handler => { enhance = handler; } };
}

test('successive enhancement receives only its creation session history', async t => {
  const api = await fixture(t);
  const first = await api.enhanceRequest(original);
  assert.equal(first.status, 200);
  assert.equal(first.data.memory.sessionId, api.conversationId);
  assert.ok(first.data.memory.turnId);
  api.setEnhance(async prompt => prompt === '改成夜景' ? resolved : '森林中的小狐狸缓慢穿过苔藓，柔和日光照亮树叶，镜头平稳跟随。');
  const second = await api.enhanceRequest('改成夜景');
  assert.equal(second.status, 200);
  const context = api.calls.at(-1).context;
  assert.equal(context.sessionId, api.conversationId);
  assert.ok(context.recentTurns.some(turn => turn.input === original && turn.prompt === original));
  const history = await api.session();
  assert.deepEqual(history.data.turns.map(turn => turn.kind), ['enhance', 'enhance']);
  assert.equal(history.data.turns[1].input, '改成夜景');
  assert.equal(history.data.turns[1].prompt, resolved);

  const created = await api.request('/api/memory/sessions', 'POST', { title: '森林新主题' });
  assert.equal(created.status, 201);
  const other = await api.enhanceRequest('小狐狸在森林的苔藓上缓慢行走，镜头平稳跟随。', created.data.session.id);
  assert.equal(other.status, 200);
  assert.equal(api.calls.at(-1).context?.recentTurns?.length || 0, 0);
  assert.doesNotMatch(JSON.stringify(api.calls.at(-1).context || {}), /皮秒|诊疗室/);
  assert.equal((await api.session()).data.turns.length, 2);
});

test('editable long-term preferences are available while disabled or bypassed memory is not injected or recorded', async t => {
  const api = await fixture(t);
  const preferences = '长期偏好：真实写实画面，固定近景，主体是皮秒设备，不添加风景。';
  assert.equal((await api.request('/api/memory', 'PATCH', { preferences })).status, 200);
  assert.equal((await api.enhanceRequest(original)).status, 200);
  assert.equal(api.calls.at(-1).context.preferences, preferences);
  const turns = (await api.session()).data.turns.length;
  assert.equal((await api.request('/api/memory', 'PATCH', { enabled: false })).status, 200);
  assert.equal((await api.enhanceRequest(original)).status, 200);
  assert.ok(!api.calls.at(-1).context);
  assert.equal((await api.session()).data.turns.length, turns);
  assert.equal((await api.request('/api/memory', 'PATCH', { enabled: true })).status, 200);
  assert.equal((await api.enhanceRequest(original, api.conversationId, { useMemory: false })).status, 200);
  assert.ok(!api.calls.at(-1).context);
  assert.equal((await api.session()).data.turns.length, turns);
});

test('model failures neither teach memory nor create an accepted video job', async t => {
  const api = await fixture(t);
  assert.equal((await api.enhanceRequest(original)).status, 200);
  const before = (await api.session()).data.turns.length;
  api.setEnhance(async () => { throw new Error('模拟上下文模型连接失败，请稍后重试。'); });
  assert.equal((await api.enhanceRequest('改成夜景')).status, 503);
  assert.equal((await api.generate('改成夜景')).status, 503);
  assert.equal((await api.session()).data.turns.length, before);
  assert.deepEqual((await api.request('/api/jobs')).data, []);
  assert.equal(api.renders.length, 0);
});

test('clear, delete, rename and preference changes prevent late enhancement from restoring old context', async t => {
  for (const mutation of ['clear', 'delete', 'rename', 'preferences']) await t.test(mutation, async t => {
    const api = await fixture(t);
    await api.enhanceRequest(original);
    let release, notifyStarted;
    const pending = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { notifyStarted = resolve; });
    api.setEnhance(async () => { notifyStarted(); await pending; return resolved; });
    const response = api.enhanceRequest('改成夜景');
    try {
      await Promise.race([started, response.then(result => { throw new Error(`model was not called: HTTP ${result.status}`); })]);
      let changed;
      if (mutation === 'clear') changed = await api.request(`/api/memory/sessions/${api.conversationId}/clear`, 'POST', {});
      if (mutation === 'delete') changed = await api.request(`/api/memory/sessions/${api.conversationId}`, 'DELETE');
      if (mutation === 'rename') changed = await api.request(`/api/memory/sessions/${api.conversationId}`, 'PATCH', { title: '修改后的会话' });
      if (mutation === 'preferences') changed = await api.request('/api/memory', 'PATCH', { preferences: '改为明亮日间场景，不沿用夜景。' });
      assert.equal(changed.status, 200);
    } finally { release(); }
    const result = await response;
    assert.equal(result.status, 409);
    assert.equal(result.data.prompt, undefined);
    const session = await api.session();
    if (mutation === 'delete') assert.equal(session.status, 404);
    else assert.equal(session.data.turns.length, mutation === 'clear' ? 0 : 1);
    const state = (await api.request('/api/memory')).data;
    assert.equal(state.sessions.length, 1);
    if (mutation === 'delete') assert.notEqual(state.sessions[0].id, api.conversationId);
  });
});

test('a short follow-up is expanded for real generation and the accepted job is remembered once', async t => {
  const api = await fixture(t);
  await api.enhanceRequest(original);
  api.setEnhance(async (input, options) => {
    assert.equal(input, '改成夜景');
    assert.ok(options.context.recentTurns.some(turn => turn.prompt === original));
    return resolved;
  });
  const accepted = await api.generate('改成夜景');
  assert.equal(accepted.status, 202);
  assert.equal(accepted.data.prompt, '改成夜景');
  assert.equal(accepted.data.resolvedPrompt, resolved);
  assert.equal(accepted.data.memorySessionId, api.conversationId);
  const job = await api.completed(accepted.data.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.generationPrompt, undefined);
  assert.match(api.renders[0].prompt, /夜晚.*皮秒/);
  const history = (await api.session()).data.turns;
  assert.equal(history.length, 2);
  assert.equal(history[1].kind, 'generate');
  assert.equal(history[1].jobId, job.id);
  assert.equal(history[1].status, 'completed');
});

test('prompt-controlled follow-ups can retain the duration from the same session', async t => {
  const api = await fixture(t);
  const first = await api.generate(`总时长8秒。${original}`, { durationMode: 'prompt' });
  assert.equal(first.status, 202);
  assert.equal(first.data.seconds, 8);
  await api.completed(first.data.id);
  api.setEnhance(async (input, options) => {
    assert.equal(input, '保持时长，改成夜景');
    assert.equal(options.context.lastSettings.seconds, 8);
    return `总时长8秒。${resolved}`;
  });
  const second = await api.generate('保持时长，改成夜景', { durationMode: 'prompt' });
  assert.equal(second.status, 202);
  assert.equal(second.data.seconds, 8);
  assert.equal((await api.completed(second.data.id)).status, 'completed');
});

test('forgetting all memory creates an empty session and preserves existing works', async t => {
  const api = await fixture(t);
  await api.request('/api/memory', 'PATCH', { preferences: '优先固定近景与自然光。' });
  api.setEnhance(async () => original);
  const created = await api.generate(original);
  assert.equal(created.status, 202);
  await api.completed(created.data.id);
  const forgotten = await api.request('/api/memory', 'DELETE');
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.data.preferences, '');
  assert.equal(forgotten.data.sessions.length, 1);
  assert.equal(forgotten.data.sessions[0].turnCount, 0);
  assert.notEqual(forgotten.data.sessions[0].id, api.conversationId);
  assert.equal((await api.session()).status, 404);
  const works = (await api.request('/api/jobs')).data;
  assert.ok(works.some(job => job.id === created.data.id && job.status === 'completed'));
});

test('clearing context while a follow-up is being resolved prevents a stale generation job', async t => {
  const api = await fixture(t);
  await api.enhanceRequest(original);
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  api.setEnhance(async () => { started(); await pending; return resolved; });
  const creating = api.generate('改成夜景');
  await running;
  assert.equal((await api.request(`/api/memory/sessions/${api.conversationId}/clear`, 'POST', {})).status, 200);
  release();
  assert.equal((await creating).status, 409);
  assert.deepEqual((await api.request('/api/jobs')).data, []);
  assert.deepEqual((await api.session()).data.turns, []);
});

test('restart reconciles terminal job statuses in saved memory without recreating cleared turns', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-memory-restart-'));
  let service, server;
  t.after(async () => {
    service?.stop();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const memory = createMemoryStore({ dataDir });
  const rememberedId = memory.state().sessions[0].id;
  const clearedId = memory.createSession({ title: '已清空的会话' }).id;
  const append = (id, jobId) => memory.appendTurn(id, {
    kind: 'generate', input: original, prompt: original, settings: parameters, jobId,
  }, memory.context(id).stamp);
  append(rememberedId, 'restart-interrupted');
  append(rememberedId, 'restart-completed');
  append(clearedId, 'restart-cleared');
  memory.clearSession(clearedId);
  const savedJobs = [
    ['restart-interrupted', 'processing'], ['restart-completed', 'completed'], ['restart-cleared', 'queued'],
  ].map(([id, status]) => ({ id, status, ...parameters, prompt: original,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: status === 'completed' ? 100 : 1 }));
  await writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify(savedJobs));
  service = createApp({ dataDir, key: '',
    vision: { model: 'test-vision', inspect: async () => ({ ready: false }) },
    local: { render: async () => assert.fail('interrupted jobs without remote IDs must not be resubmitted') },
  });
  server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(jobs.find(job => job.id === 'restart-interrupted').status, 'failed');
  assert.match(jobs.find(job => job.id === 'restart-interrupted').error, /重启/);
  assert.equal(jobs.find(job => job.id === 'restart-cleared').status, 'failed');
  const remembered = await (await fetch(`${base}/api/memory/sessions/${rememberedId}`)).json();
  assert.deepEqual(remembered.turns.map(turn => [turn.jobId, turn.status]), [
    ['restart-interrupted', 'failed'], ['restart-completed', 'completed'],
  ]);
  const cleared = await (await fetch(`${base}/api/memory/sessions/${clearedId}`)).json();
  assert.deepEqual(cleared.turns, []);
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'memory.json'), 'utf8'));
  assert.deepEqual(persisted.sessions.find(session => session.id === rememberedId).turns.map(turn => turn.status), ['failed', 'completed']);
  assert.deepEqual(persisted.sessions.find(session => session.id === clearedId).turns, []);
});
