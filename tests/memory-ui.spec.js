import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const original = '明亮诊疗室内，操作人员手持皮秒激光治疗头沿前臂纹身区域缓慢移动，固定近景。';
const night = '夜晚的诊疗室内，同一位操作人员手持皮秒激光治疗头沿前臂纹身区域缓慢移动，固定近景。';
const forest = '清晨森林中的小狐狸缓慢走过苔藓，柔和阳光穿过树叶，镜头平稳跟随。';
let directory, service, server, base, requests, renders, release, pendingStarted;
let delayed = false, failRender = false;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root });
  directory = await mkdtemp(path.join(os.tmpdir(), 'frame-memory-ui-'));
  const bytes = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=160x90:r=16', '-t', '2', '-an', '-c:v', 'libx264', '-threads', '1', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  service = createApp({ dataDir: directory, key: '',
    vision: { model: 'test-vision', inspect: async () => ({ ready: false, message: '测试不调用视觉模型。' }) },
    local: { model: 'test-text', inspect: async () => ({ language: { ready: true }, video: { ready: true } }),
      enhance: async (input, options) => {
        requests.push({ input, ...structuredClone(options) });
        if (delayed) { pendingStarted?.(); await new Promise(resolve => { release = resolve; }); }
        return input.includes('夜景') ? night : input.includes('狐狸') ? forest : input;
      },
      render: async job => { renders.push(structuredClone(job)); if (failRender) throw new Error('模拟生成失败。'); await writeFile(path.join(directory, `${job.id}.mp4`), bytes); },
    },
  });
  server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  requests = []; renders = []; delayed = false; failRender = false; release = undefined; pendingStarted = undefined;
  await fetch(`${base}/api/memory`, { method: 'DELETE' });
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  for (const job of jobs) if (!['queued', 'processing'].includes(job.status)) await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' });
});
test.afterEach(() => { delayed = false; release?.(); });
test.afterAll(async () => { service?.stop(); if (server) await new Promise(resolve => server.close(resolve)); if (directory) await rm(directory, { recursive: true, force: true }); });
const state = () => fetch(`${base}/api/memory`).then(response => response.json());

test('memory persists preferences and turns, undo removes the suggestion and new sessions isolate subjects', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  const firstId = await page.getByLabel('当前创作会话').inputValue();
  await page.getByRole('button', { name: '管理记忆', exact: true }).click();
  await page.getByLabel('长期创作偏好').fill('偏好写实与固定近景，主体清晰。');
  await page.getByRole('button', { name: '保存长期偏好', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存长期偏好', exact: true })).toBeDisabled();
  await page.getByLabel('会话名称', { exact: true }).fill('诊疗设备');
  await page.getByRole('button', { name: '保存会话名称', exact: true }).click();
  await expect(page.getByRole('heading', { name: '诊疗设备', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '视频创作 NEW', exact: true }).click();
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect.poll(async () => (await state()).sessions.find(item => item.id === firstId).turnCount).toBe(1);
  await page.getByLabel('描述你的画面').fill('改成夜景');
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(night);
  expect(requests.at(-1).context.recentTurns.some(turn => turn.prompt === original)).toBe(true);
  await page.getByRole('button', { name: '撤销润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue('改成夜景');
  await expect.poll(async () => (await state()).sessions.find(item => item.id === firstId).turnCount).toBe(1);
  await page.reload();
  await expect(page.getByLabel('当前创作会话')).toHaveValue(firstId);
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue('');
  await expect(page.getByLabel('当前创作会话')).not.toHaveValue(firstId);
  await page.getByLabel('描述你的画面').fill(forest);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(forest);
  expect(requests.at(-1).context.recentTurns).toEqual([]);
  expect(JSON.stringify(requests.at(-1).context)).not.toMatch(/皮秒|诊疗室/);
  await page.getByRole('button', { name: '管理记忆', exact: true }).click();
  await expect(page.getByLabel('长期创作偏好')).toHaveValue('偏好写实与固定近景，主体清晰。');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/Frame-memory.png', fullPage: true });
});

test('clearing a session while the model is pending cannot restore its forgotten history', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toBeVisible();
  delayed = true;
  const started = new Promise(resolve => { pendingStarted = resolve; });
  await page.getByLabel('描述你的画面').fill('改成夜景');
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await started;
  await page.getByRole('button', { name: '管理记忆', exact: true }).click();
  await page.getByRole('button', { name: '清空当前会话记录', exact: true }).click();
  await page.getByRole('button', { name: '确认清空当前会话', exact: true }).click();
  await expect(page.getByText('这个会话还没有记忆。', { exact: false })).toBeVisible();
  delayed = false; release();
  await page.getByRole('button', { name: '视频创作 NEW', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('会话记忆已变化');
  await expect(page.getByLabel('描述你的画面')).toHaveValue('改成夜景');
  expect((await state()).sessions[0].turnCount).toBe(0);
});

test('short generation uses the resolved context and restores saved parameters after a refresh', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toBeVisible();
  await page.getByLabel('描述你的画面').fill('改成夜景');
  await page.getByRole('radio', { name: '9:16' }).check();
  await page.getByLabel('视频时长').selectOption('8');
  await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
  await expect(page.locator('.preview-caption')).toContainText('已完成');
  expect(renders.at(-1).prompt).toContain('夜晚的诊疗室');
  expect(renders.at(-1).prompt).toContain('皮秒激光');
  await page.locator('.memory-result-context summary').click();
  await expect(page.locator('.memory-result-context')).toContainText(night);
  await page.reload();
  await expect(page.getByLabel('视频时长')).toHaveValue('8');
  await expect(page.getByRole('radio', { name: '9:16' })).toBeChecked();
});

test('a late generation response does not switch the user back from a new creation session', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toBeVisible();
  const firstId = await page.getByLabel('当前创作会话').inputValue();
  delayed = true;
  const started = new Promise(resolve => { pendingStarted = resolve; });
  await page.getByLabel('描述你的画面').fill('改成夜景');
  await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
  await started;
  await page.getByRole('button', { name: '创作记忆', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const secondId = (await state()).sessions.find(item => item.id !== firstId).id;
  await expect(page.locator('.memory-session-heading')).toContainText('创作会话 2');
  delayed = false; release();
  await expect.poll(async () => (await (await fetch(`${base}/api/jobs`)).json())[0]?.status).toBe('completed');
  await expect(page.getByRole('heading', { name: '创作记忆', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '视频创作 NEW', exact: true }).click();
  await expect(page.getByLabel('当前创作会话')).toHaveValue(secondId);
  await expect(page.getByLabel('描述你的画面')).toHaveValue('');
  expect((await state()).sessions.find(item => item.id === secondId).turnCount).toBe(0);
});

test('new-session creation protects the input while waiting from either memory entry', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  for (const fromPanel of [false, true]) {
    const oldId = await page.getByLabel('当前创作会话').inputValue();
    await page.getByLabel('描述你的画面').fill(original);
    let unblock, notifyStarted;
    const pending = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const handler = async route => {
      if (route.request().method() === 'POST') { notifyStarted(); await pending; }
      await route.continue();
    };
    await page.route('**/api/memory/sessions', handler);
    if (fromPanel) await page.getByRole('button', { name: '管理记忆', exact: true }).click();
    try {
      await page.getByRole('button', { name: fromPanel ? '新建会话' : '新会话', exact: true }).click();
      await started;
      if (fromPanel) await page.getByRole('button', { name: '视频创作 NEW', exact: true }).click();
      await expect(page.getByLabel('描述你的画面')).toBeDisabled();
      await expect(page.getByLabel('描述你的画面')).toHaveValue(original);
    } finally { unblock(); }
    await expect(page.getByLabel('当前创作会话')).not.toHaveValue(oldId);
    await expect(page.getByLabel('描述你的画面')).toBeEnabled();
    await expect(page.getByLabel('描述你的画面')).toHaveValue('');
    await page.unroute('**/api/memory/sessions', handler);
  }
});

test('a late new-session response preserves a different session selected while waiting', async ({ page }) => {
  await fetch(`${base}/api/memory/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '诊疗创作' }) });
  const other = (await state()).sessions.find(item => item.title !== '诊疗创作');
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  let unblock, notifyStarted;
  const pending = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  await page.route('**/api/memory/sessions', async route => {
    if (route.request().method() === 'POST') { notifyStarted(); await pending; }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await started;
    await page.getByRole('button', { name: '管理记忆', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(other.title) }).click();
    await page.getByRole('button', { name: '视频创作 NEW', exact: true }).click();
    await expect(page.getByLabel('当前创作会话')).toHaveValue(other.id);
    await page.getByLabel('描述你的画面').fill(forest);
  } finally { unblock(); }
  await expect.poll(async () => (await state()).sessions.length).toBe(3);
  await expect(page.getByText('新会话已创建，可在创作记忆中选择；当前会话和输入已保留。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('当前创作会话')).toHaveValue(other.id);
  await expect(page.getByLabel('描述你的画面')).toHaveValue(forest);
});

test('retrying a failed historical video reuses its resolved description without mixing another session', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('checkbox', { name: '使用上下文记忆' })).toBeChecked();
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toBeVisible();
  failRender = true;
  await page.getByLabel('描述你的画面').fill('改成夜景');
  await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
  await expect(page.getByText('这次没能完成生成', { exact: true })).toBeVisible();
  failRender = false;
  const oldId = await page.getByLabel('当前创作会话').inputValue();
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect(page.getByLabel('当前创作会话')).not.toHaveValue(oldId);
  const newId = await page.getByLabel('当前创作会话').inputValue();
  await page.getByLabel('描述你的画面').fill(forest);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^我的作品/ }).click();
  const work = page.locator('.work-card').filter({ hasText: '改成夜景' });
  await work.getByRole('button', { name: '重试生成', exact: true }).click();
  await expect.poll(async () => (await (await fetch(`${base}/api/jobs`)).json())[0]?.status).toBe('completed');
  expect(renders.at(-1).prompt).toBe(night);
  expect(renders.at(-1).prompt).not.toContain('狐狸');
  expect((await state()).sessions.find(item => item.id === newId).turnCount).toBe(1);
});
