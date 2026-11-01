import test from 'node:test';
import assert from 'node:assert/strict';
import { DURATION_OPTIONS, resolveDuration } from '../shared/duration.js';

const resolvePrompt = (prompt, provider = 'comfyui') => resolveDuration({ provider, prompt, durationMode: 'prompt' });

test('manual duration preserves selected seconds for local and demo jobs without reading action timestamps', () => {
  assert.deepEqual(DURATION_OPTIONS, [2, 4, 6, 8, 12, 20, 30, 60]);
  for (const provider of ['comfyui', 'demo']) {
    for (const seconds of [2, 3, 4, 8, 12, 59, 60]) {
      assert.equal(resolveDuration({ provider, seconds, prompt: '生成一段 20 秒的视频。' }), seconds);
    }
  }
  assert.equal(resolveDuration({ provider: 'sora', seconds: 8 }), 8);
});

test('duration limits and provider restrictions are enforced without numeric coercion', () => {
  for (const seconds of [undefined, null, '8', NaN, Infinity, 0, 1, -8, 8.5, 61, [8]]) {
    assert.throws(() => resolveDuration({ provider: 'comfyui', seconds }), /2–60 秒的整数/);
  }
  for (const seconds of [2, 6, 20, 60]) {
    assert.throws(() => resolveDuration({ provider: 'sora', seconds }), /Sora 2/);
  }
  assert.throws(() => resolveDuration({ provider: 'other', seconds: 8 }), /生成模式/);
  assert.throws(() => resolveDuration({ provider: 'comfyui', seconds: 8, durationMode: 'auto' }), /识别时长/);
});

test('prompt duration recognizes explicit Chinese and English target lengths and minute units', () => {
  for (const [prompt, seconds] of [
    ['生成一个8秒的视频，皮秒设备治疗头缓慢移动。', 8],
    ['小狐狸穿过森林，生成二十秒短片。', 20],
    ['请制作两秒短片。', 2],
    ['总时长：十二秒，镜头平稳移动。', 12],
    ['视频时长设为六十秒。', 60],
    ['时长: 一分钟', 60],
    ['总时长 0.5 分钟。', 30],
    ['半分钟的视频，固定近景。', 30],
    ['A 12-second video of a quiet forest.', 12],
    ['Duration: 8 seconds. Follow the fox.', 8],
    ['video length = 0.5 min', 30],
    ['时长８秒', 8],
  ]) assert.equal(resolvePrompt(prompt), seconds, prompt);
});

test('total duration takes precedence over per-shot timing and source-template metadata', () => {
  assert.equal(resolvePrompt('每2秒换镜，总时长12秒。'), 12);
  assert.equal(resolvePrompt('每个镜头时长2秒，视频总时长20秒。'), 20);
  assert.equal(resolvePrompt('原模板时长8秒，目标视频时长12秒。'), 12);
  assert.equal(resolvePrompt('参考视频时长4秒，成片时长20秒。'), 20);
  assert.equal(resolvePrompt('时长8秒，时长8秒。'), 8);
  assert.equal(resolvePrompt('时长0.5分钟或30秒。'), 30);
});

test('prompt mode rejects ambiguous or absent targets instead of falling back to two seconds', () => {
  for (const prompt of [
    '皮秒设备治疗头缓慢移动，固定近景。',
    '2秒后镜头推近，再慢慢拉远。',
    '每2秒换镜，记录设备操作。',
    '每个镜头时长2秒。',
    '模板时长8秒。',
    '', null,
  ]) assert.throws(() => resolvePrompt(prompt), /时长/);
  for (const prompt of [
    '时长8秒，时长12秒。',
    '总时长8秒，视频时长12秒。',
    '时长8秒或12秒。',
    '时长8或12秒。',
    '制作8秒或12秒视频。',
    '时长8到12秒。',
    '总时长1分钟30秒。',
  ]) assert.throws(() => resolvePrompt(prompt), /时长|歧义/, prompt);
});

test('inferred duration still obeys integer range and selected provider capabilities', () => {
  for (const prompt of ['时长1秒。', '时长61秒。', '时长1.5秒。', '时长二分钟。', '时长一百秒。']) {
    assert.throws(() => resolvePrompt(prompt), /2–60 秒的整数/);
  }
  assert.equal(resolvePrompt('时长8秒。', 'sora'), 8);
  assert.throws(() => resolvePrompt('时长20秒。', 'sora'), /Sora 2/);
});
