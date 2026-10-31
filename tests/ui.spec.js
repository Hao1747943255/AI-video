import { test, expect } from '@playwright/test';

test('creates, plays, downloads, restores and deletes a demo video from the UI', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  await page.getByRole('button', { name: '生成演示视频', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('至少输入 10 个字符');
  await page.getByRole('button', { name: /森林来信/ }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(/清晨的古老森林/);
  const runPrompt = `清晨的古老森林，薄雾在高耸的树木之间流动，镜头缓慢向前推进。测试 ${Date.now()}`;
  await page.getByLabel('描述你的画面').fill(runPrompt);
  await page.getByRole('radio', { name: '9:16' }).check();
  await page.getByRole('button', { name: '生成演示视频', exact: true }).click();
  const downloadLink = page.getByRole('link', { name: '下载视频', exact: true });
  await expect(downloadLink).toBeVisible({ timeout: 60_000 });
  const video = page.getByLabel('生成视频预览');
  await expect(video).toBeVisible();
  await expect.poll(async () => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  expect(await video.evaluate(element => element.videoWidth)).toBe(720);
  expect(await video.evaluate(element => element.videoHeight)).toBe(1280);
  expect(await video.evaluate(element => element.duration)).toBe(4);
  const downloadPromise = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^frame-.*\.mp4$/);
  expect(await download.failure()).toBeNull();
  await page.reload();
  await page.getByRole('button', { name: /我的作品/ }).click();
  const ownWork = page.locator('.work-card').filter({ hasText: runPrompt });
  await expect(ownWork).toBeVisible();
  await page.getByLabel('搜索作品').fill('不存在的关键词');
  await expect(page.getByText('没有找到对应作品')).toBeVisible();
  await page.getByLabel('搜索作品').fill('');
  await ownWork.getByRole('button', { name: `预览：${runPrompt}`, exact: true }).click();
  await expect(page.getByLabel('生成视频预览')).toBeVisible();
  await page.getByRole('button', { name: /我的作品/ }).click();
  await ownWork.getByRole('button', { name: '删除作品', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(ownWork).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile layout, inspirations and help dialog are functional', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '灵感库', exact: true }).click();
  await expect(page.getByText('找到你的下一束灵感')).toBeVisible();
  await page.getByRole('button', { name: /夜色漫游/ }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(/夜幕下的都市/);
  await page.getByRole('button', { name: '查看生成设置' }).click();
  await expect(page.getByRole('dialog', { name: '生成设置' })).toBeVisible();
  await expect(page.getByText('OpenAI Sora 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '打开使用指南' }).click();
  await expect(page.getByRole('dialog', { name: '让灵感顺利成片' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开使用指南' })).toBeFocused();
});

test('local mode uses 2-second low-memory settings and local LLM prompt enhancement', async ({ page }) => {
  let job;
  const enhanced = '清晨的小狐狸在苔藓覆盖的森林中缓慢行走，柔和光线穿过树叶，镜头平稳跟随。';
  await page.route('**/api/local/status*', route => route.fulfill({ json: { language: { ready: true, model: 'qwen3:4b', message: '语言模型已就绪' }, video: { ready: true, message: '视频文件与节点已就绪' } } }));
  await page.route('**/api/prompts/enhance', async route => {
    expect(route.request().postDataJSON().prompt).toContain('小狐狸');
    await route.fulfill({ json: { prompt: enhanced, model: 'qwen3:4b' } });
  });
  await page.route('**/api/jobs', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.provider).toBe('comfyui');
      expect(body.seconds).toBe(2);
      expect(body.prompt).toBe(enhanced);
      job = { ...body, id: 'local-ui-job', status: 'processing', progress: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 202, json: job });
    } else await route.fulfill({ json: job ? [job] : [] });
  });
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  await page.getByLabel('描述你的画面').fill('小狐狸在森林中行走');
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(enhanced);
  await page.getByLabel('生成模式', { exact: true }).selectOption('comfyui');
  await expect(page.getByLabel('视频时长')).toHaveValue('2');
  await expect(page.getByText('288P', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '本地生成视频 · 无需 Token', exact: true }).click();
  await expect(page.getByText('模型处理中 · 非百分比进度', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载视频', exact: true })).toHaveCount(0);
});
