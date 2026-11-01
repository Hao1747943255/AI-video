import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore } from '../server/memory.js';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'frame-memory 测试 '));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createMemoryStore({ dataDir });
  const sessionId = store.state().sessions[0].id;
  return { dataDir, store, sessionId };
}

const baseTurn = {
  kind: 'generate', input: '皮秒设备在诊室里运行，镜头固定近景。',
  prompt: '明亮的诊疗室内，皮秒设备的治疗头沿前臂纹身区域缓慢移动，镜头平稳近景拍摄。',
  settings: { provider: 'comfyui', ratio: '16:9', style: 'cinematic', seconds: 8, durationMode: 'manual' },
  status: 'submitted', jobId: 'memory-job-1',
};

function append(store, sessionId, values = {}) {
  return store.appendTurn(sessionId, { ...baseTurn, ...values }, store.context(sessionId).stamp);
}

function statusError(action, status) {
  assert.throws(action, error => {
    assert.equal(error.status, status);
    assert.equal(error.framePublic, true);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
}

test('memory persists preferences, sessions and complete turns with private file permissions', async t => {
  const { dataDir, store, sessionId } = await fixture(t);
  assert.equal(store.state().enabled, true);
  assert.equal(store.state().preferences, '');
  assert.equal(store.context(sessionId).hasContext, false);
  store.updateSettings({ preferences: '保留专业设备主体，偏好写实自然光。' });
  store.updateSession(sessionId, { title: '皮秒设备创作' });
  const turn = append(store, sessionId);
  assert.match(turn.id, /^[a-f0-9-]{36}$/i);
  assert.equal(store.state().sessions[0].turnCount, 1);
  const restored = createMemoryStore({ dataDir });
  assert.deepEqual(restored.state(), store.state());
  assert.deepEqual(restored.getSession(sessionId), store.getSession(sessionId));
  assert.equal(restored.getSession(sessionId).turns[0].prompt, baseTurn.prompt);
  assert.deepEqual(restored.context(sessionId).lastSettings, baseTurn.settings);
  const saved = await readFile(path.join(dataDir, 'memory.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(saved));
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dataDir, 'memory.json'))).mode & 0o777, 0o600);
});

test('context follows the selected session and never mixes another subject into it', async t => {
  const { store, sessionId } = await fixture(t);
  append(store, sessionId);
  const second = store.createSession({ title: '森林短片' });
  assert.equal(store.context(second.id).hasContext, false);
  append(store, second.id, { input: '小狐狸在晨雾森林行走，保持低机位。', prompt: '晨雾森林里，一只小狐狸缓慢行走，柔和阳光穿过树叶，镜头以低机位平稳跟随。', jobId: 'fox-job' });
  const firstContext = JSON.stringify(store.context(sessionId));
  const secondContext = JSON.stringify(store.context(second.id));
  assert.match(firstContext, /皮秒设备/);
  assert.doesNotMatch(firstContext, /小狐狸|晨雾森林/);
  assert.match(secondContext, /小狐狸/);
  assert.doesNotMatch(secondContext, /皮秒设备|前臂纹身/);
});

test('recent short instructions stay meaningful when the context budget has space', async t => {
  const { store, sessionId } = await fixture(t);
  append(store, sessionId);
  const followup = '把背景换成夜晚，保持人物和设备不变';
  append(store, sessionId, { input: followup, jobId: 'followup-job', prompt: '夜晚的诊疗室里，同一名操作人员手持皮秒治疗头缓慢移动，柔和灯光，固定近景。' });
  append(store, sessionId, { input: '镜头再向治疗头缓慢推进。', jobId: 'latest-followup-job', prompt: '夜晚诊疗室内，同一名操作人员持皮秒治疗头缓慢移动，镜头向治疗头平稳推进。' });
  const context = store.context(sessionId);
  assert.equal(context.recentTurns[0].input, baseTurn.input);
  assert.equal(context.recentTurns[1].input, followup);
});

test('context limits its payload while preserving the latest full description and source history', async t => {
  const { store, sessionId } = await fixture(t);
  store.updateSettings({ preferences: '长期偏好'.repeat(250) });
  for (let index = 0; index < 8; index++) append(store, sessionId, {
    input: `历史第 ${index} 次请求，继续相同主体。`, prompt: `第 ${index} 次画面描述。${'场景细节'.repeat(250)}`, jobId: `budget-job-${index}`,
  });
  const latest = '最新主体。' + '景'.repeat(1995);
  assert.equal(latest.length, 2000);
  append(store, sessionId, { input: '最新请求，保留完整主体。', prompt: latest, jobId: 'budget-latest' });
  const context = store.context(sessionId);
  assert.ok(context.recentTurns.length >= 1 && context.recentTurns.length <= 4);
  const textLength = context.preferences.length + context.recentTurns.reduce((total, turn) => total + turn.input.length + turn.prompt.length, 0);
  assert.ok(textLength <= 2400, `unexpected context length: ${textLength}`);
  assert.equal(context.recentTurns.at(-1).prompt, latest);
  assert.equal(context.truncated, true);
  assert.equal(store.getSession(sessionId).turns.at(-1).prompt, latest);
  assert.equal(store.state().preferences.length, 1000);
});

test('turn history is bounded and returned state cannot mutate the store', async t => {
  const { store, sessionId } = await fixture(t);
  for (let index = 0; index < 35; index++) append(store, sessionId, { input: `第 ${index} 次创作请求，保留主体。`, jobId: `retained-job-${index}` });
  const detail = store.getSession(sessionId);
  assert.equal(detail.turns.length, 30);
  assert.match(detail.turns[0].input, /^第 5 次/);
  assert.match(detail.turns.at(-1).input, /^第 34 次/);
  const state = store.state(); state.enabled = false; state.sessions[0].title = 'forged';
  detail.turns[0].prompt = 'forged'; detail.turns[0].settings.seconds = 60;
  const context = store.context(sessionId); context.recentTurns[0].prompt = 'forged';
  assert.equal(store.state().enabled, true);
  assert.notEqual(store.state().sessions[0].title, 'forged');
  assert.notEqual(store.getSession(sessionId).turns[0].prompt, 'forged');
  assert.equal(store.getSession(sessionId).turns[0].settings.seconds, 8);
});

test('clearing, renaming or changing preferences invalidates pending model writes', async t => {
  const { store, sessionId } = await fixture(t);
  append(store, sessionId);
  let stamp = store.context(sessionId).stamp;
  store.clearSession(sessionId);
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
  assert.equal(store.getSession(sessionId).turns.length, 0);
  stamp = store.context(sessionId).stamp;
  store.updateSession(sessionId, { title: '新的主题名称' });
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
  stamp = store.context(sessionId).stamp;
  store.updateSettings({ preferences: '新的写实风格偏好' });
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
  assert.equal(store.getSession(sessionId).turns.length, 0);
  append(store, sessionId);
  const turn = store.getSession(sessionId).turns[0];
  stamp = store.context(sessionId).stamp;
  store.deleteTurn(sessionId, turn.id);
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
});

test('disabled memory supplies no context and cannot accept new entries', async t => {
  const { store, sessionId } = await fixture(t);
  store.updateSettings({ preferences: '保留诊室和设备。' }); append(store, sessionId);
  const stamp = store.context(sessionId).stamp;
  store.updateSettings({ enabled: false });
  const context = store.context(sessionId);
  assert.equal(context.enabled, false);
  assert.equal(context.hasContext, false);
  assert.equal(context.preferences, '');
  assert.deepEqual(context.recentTurns, []);
  assert.equal(context.lastSettings, undefined);
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
  assert.equal(store.getSession(sessionId).turns.length, 1);
  store.updateSettings({ enabled: true });
  assert.equal(store.context(sessionId).hasContext, true);
});

test('deleting sessions or clearing all memory prevents late results from recreating forgotten content', async t => {
  const { store, sessionId } = await fixture(t);
  append(store, sessionId);
  let stamp = store.context(sessionId).stamp;
  store.deleteSession(sessionId);
  assert.equal(store.state().sessions.length, 1);
  assert.notEqual(store.state().sessions[0].id, sessionId);
  statusError(() => store.getSession(sessionId), 404);
  statusError(() => store.appendTurn(sessionId, baseTurn, stamp), 409);
  const current = store.state().sessions[0].id;
  store.updateSettings({ preferences: '这项偏好需要完全清除。' }); append(store, current);
  stamp = store.context(current).stamp;
  store.updateSettings({ enabled: false });
  store.clearAll();
  assert.equal(store.state().enabled, false);
  assert.equal(store.state().preferences, '');
  assert.equal(store.state().sessions.length, 1);
  assert.equal(store.state().sessions[0].turnCount, 0);
  statusError(() => store.appendTurn(current, baseTurn, stamp), 409);
});

test('job annotations update existing turns without breaking a context stamp or reviving removed turns', async t => {
  const { store, sessionId } = await fixture(t);
  const turn = append(store, sessionId);
  const stamp = store.context(sessionId).stamp;
  assert.equal(store.updateJob(baseTurn.jobId, 'completed'), true);
  assert.equal(store.getSession(sessionId).turns[0].status, 'completed');
  assert.deepEqual(store.context(sessionId).stamp, stamp);
  assert.equal(store.updateJob(baseTurn.jobId, 'completed'), false);
  const { jobId: _jobId, ...enhancement } = baseTurn;
  store.appendTurn(sessionId, { ...enhancement, kind: 'enhance', status: 'suggestion' }, stamp);
  store.deleteTurn(sessionId, turn.id);
  assert.equal(store.updateJob(baseTurn.jobId, 'failed'), false);
  assert.equal(store.getSession(sessionId).turns.length, 1);
  assert.equal(store.updateJob(undefined, 'failed'), false);
});

test('invalid paths, unsupported fields and oversized values fail without changing saved memory', async t => {
  const { dataDir, store, sessionId } = await fixture(t);
  const original = await readFile(path.join(dataDir, 'memory.json'), 'utf8');
  for (const invalid of ['../secret', '/tmp/not-a-session', '', '__proto__']) statusError(() => store.getSession(invalid), 404);
  const invalidOperations = [
    () => store.updateSettings({ preferences: '字'.repeat(1001) }),
    () => store.updateSettings({ enabled: 'true' }),
    () => store.updateSettings({ secret: 'not allowed' }),
    () => store.createSession({ title: '字'.repeat(61) }),
    () => store.updateSession(sessionId, { title: ' ' }),
    () => store.appendTurn(sessionId, { ...baseTurn, input: '短' }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, prompt: '短' }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, prompt: '字'.repeat(2001) }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, kind: 'system' }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, status: 'invented' }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, jobId: '../outside' }, store.context(sessionId).stamp),
    () => store.appendTurn(sessionId, { ...baseTurn, settings: { ...baseTurn.settings, apiKey: 'do not persist' } }, store.context(sessionId).stamp),
  ];
  for (const action of invalidOperations) statusError(action, 400);
  assert.equal(await readFile(path.join(dataDir, 'memory.json'), 'utf8'), original);
});

test('session capacity is explicit and damaged storage is preserved for recovery', async t => {
  const { dataDir, store } = await fixture(t);
  for (let index = 1; index < 20; index++) store.createSession({ title: `会话 ${index}` });
  statusError(() => store.createSession({ title: '超过上限' }), 409);
  assert.equal(store.state().sessions.length, 20);
  const file = path.join(dataDir, 'memory.json');
  const damaged = '{invalid memory content and private details';
  await writeFile(file, damaged);
  assert.throws(() => createMemoryStore({ dataDir }), error => {
    assert.match(error.message, /记忆|损坏|读取/);
    assert.doesNotMatch(error.message, /private details/);
    assert.equal(error.message.includes(dataDir), false);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), damaged);
});
