import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/memory', route => route.fulfill({ json: { enabled: false, preferences: '', revision: 0, sessions: [] } }));
});

const profile = { summary: '明亮诊疗室中展示皮秒设备与治疗头，固定近景画面。', scene: '白色诊疗室', characters: '戴护目镜的操作人员', objects: '皮秒设备与治疗头', style: '写实柔和光线', camera: '固定近景', actions: '治疗头平稳移动' };
const status = { language: { ready: true }, video: { ready: true }, vision: { ready: true, model: 'mock-vision', message: '视觉模型已就绪' } };

test('uploads, analyzes, edits and selects a reference template for a prompt-controlled long video', async ({ page }) => {
  let id, job, submitted;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/local/status*', route => route.fulfill({ json: status }));
  // Substitute only model inference. Upload, media decoding and profile persistence use the real API.
  await page.route('**/api/templates/*/analyze', async route => {
    const response = await route.fetch({ url: route.request().url().replace(/\/analyze$/, ''), method: 'PATCH', headers: { 'Content-Type': 'application/json' }, postData: JSON.stringify({ profile }) });
    await route.fulfill({ response });
  });
  await page.route('**/api/jobs', async route => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      job = { ...submitted, id: 'template-ui-job', status: 'processing', progress: 0, totalSegments: 6, completedSegments: 0, stage: '正在生成片段 1/6', createdAt: new Date().toISOString() };
      await route.fulfill({ status: 202, json: job });
    } else await route.fulfill({ json: job ? [job] : [] });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /^参考模板/ }).click();
    const image = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=160x90', '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/templates' && response.request().method() === 'POST');
    await page.getByLabel('上传参考模板').setInputFiles({ name: `ui-template-${Date.now()}.jpg`, mimeType: 'image/jpeg', buffer: image });
    const item = await (await uploaded).json(); id = item.id;
    await expect(page.getByRole('img', { name: '模板图片预览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '分析模板', exact: true }).click();
    await expect(page.getByLabel('模板摘要')).toHaveValue(profile.summary);
    await page.getByLabel('模板场景').fill('柔和自然光的白色治疗室');
    await expect(page.getByRole('button', { name: '用于创作', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '保存参考描述', exact: true }).click();
    await expect(page.getByRole('button', { name: '用于创作', exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'artifacts/Frame-template-library.png', fullPage: true });
    await page.getByRole('button', { name: '用于创作', exact: true }).click();
    await expect(page.getByLabel('参考模板', { exact: true })).toHaveValue(id);
    await page.getByLabel('描述你的画面').fill('总时长十二秒，展示皮秒设备与治疗头在诊疗室中缓慢移动，固定近景。');
    await page.getByLabel('视频时长').selectOption('prompt');
    await expect(page.getByText('已识别视频总时长：12 秒')).toBeVisible();
    await page.getByRole('checkbox', { name: '人物外观', exact: true }).uncheck();
    await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
    await expect(page.getByText(/已完成 0\/6 段/)).toBeVisible();
    expect(submitted).toMatchObject({ seconds: 12, durationMode: 'prompt', provider: 'comfyui', templateId: id });
    expect(submitted.referenceAspects).toContain('scene');
    expect(submitted.referenceAspects).not.toContain('characters');
    expect(errors).toEqual([]);
  } finally { if (id) await page.request.delete(`/api/templates/${id}`); }
});

test('prompt-controlled duration survives enhancement and unclear timing cannot create a job', async ({ page }) => {
  let posted = false;
  await page.route('**/api/local/status*', route => route.fulfill({ json: status }));
  await page.route('**/api/templates', route => route.fulfill({ json: [] }));
  await page.route('**/api/prompts/enhance', route => route.fulfill({ json: { prompt: '明亮诊疗室中，皮秒设备的治疗头沿前臂纹身区域平稳移动，固定近景。' } }));
  await page.route('**/api/jobs', route => {
    if (route.request().method() === 'POST') posted = true;
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByLabel('视频时长').selectOption('prompt');
  await page.getByLabel('描述你的画面').fill('总时长8秒，皮秒治疗头沿前臂纹身区域缓慢移动，固定近景。');
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(/^总时长 8 秒。/);
  await expect(page.getByText('已识别视频总时长：8 秒')).toBeVisible();
  await page.getByLabel('描述你的画面').fill('皮秒设备的治疗头在前臂纹身区域缓慢移动，镜头固定。');
  await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('未识别到目标视频时长');
  expect(posted).toBe(false);
});
