import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/memory', route => route.fulfill({ json: { enabled: false, preferences: '', revision: 0, sessions: [] } }));
});

test('creates, plays, downloads, restores and deletes a demo video from the UI', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  await page.getByLabel('生成模式', { exact: true }).selectOption('demo');
  await page.getByLabel('视频时长').selectOption('4');
  await page.getByRole('button', { name: '生成演示视频', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('至少输入 10 个字符');
  await page.getByRole('button', { name: /森林来信/ }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(/清晨的古老森林/);
  const runPrompt = `清晨的古老森林，薄雾在高耸的树木之间流动，镜头缓慢向前推进。测试 ${Date.now()}`;
  await page.getByLabel('描述你的画面').fill(runPrompt);
  await page.getByRole('radio', { name: '9:16' }).check();
  const submitted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') submitted.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: '生成演示视频', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '生成内置素材演示？' });
  await expect(confirmation).toContainText('提示词');
  expect(submitted).toEqual([]);
  await confirmation.getByRole('button', { name: '返回创作', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(submitted).toEqual([]);
  await page.getByRole('button', { name: '生成演示视频', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认生成演示样片', exact: true }).click();
  const downloadLink = page.getByRole('link', { name: '下载视频', exact: true });
  await expect(downloadLink).toBeVisible({ timeout: 60_000 });
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ provider: 'demo', prompt: runPrompt, seconds: 4, ratio: '9:16' });
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
  const original = '小狐狸在森林中缓慢行走，镜头平稳跟随';
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
  await expect(page.getByLabel('生成模式', { exact: true })).toHaveValue('comfyui');
  await expect(page.getByLabel('视频时长')).toHaveValue('2');
  await page.getByLabel('描述你的画面').fill(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(enhanced);
  await page.getByRole('button', { name: '撤销润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(original);
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(enhanced);
  await expect(page.getByLabel('视频时长')).toHaveValue('2');
  await expect(page.locator('.preview-quality')).toContainText('288P');
  await page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true }).click();
  await expect(page.getByText('模型处理中 · 非百分比进度', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载视频', exact: true })).toHaveCount(0);
});

test('defaults to real local AI and never switches an unavailable model to demo', async ({ page }) => {
  let ready = false;
  const submitted = [];
  await page.route('**/api/local/status*', route => route.fulfill({ json: {
    language: { ready: true, model: 'qwen3:4b', message: '语言模型已就绪' },
    video: { ready, message: ready ? '视频文件与节点已就绪' : '测试：ComfyUI 尚未连接' },
  } }));
  await page.route('**/api/jobs', async route => {
    if (route.request().method() === 'POST') {
      submitted.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, json: { error: 'No generation should be submitted by this test.' } });
    } else await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  await expect(page.getByLabel('生成模式', { exact: true })).toHaveValue('comfyui');
  await expect(page.getByLabel('视频时长')).toHaveValue('2');
  await page.getByLabel('描述你的画面').fill('皮秒激光设备的治疗头在前臂纹身区域缓慢移动，镜头固定近景。');
  await expect(page.getByText('本地 Wan 尚未就绪', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成 AI 视频 · 本地 Wan', exact: true })).toBeDisabled();
  expect(submitted).toEqual([]);

  // A readiness refresh must not override the user's deliberate mode choice.
  await page.getByLabel('生成模式', { exact: true }).selectOption('demo');
  await expect(page.getByLabel('视频时长')).toHaveValue('4');
  ready = true;
  await page.getByRole('button', { name: '查看生成设置', exact: true }).click();
  await page.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '生成设置' })).toContainText('视频文件与节点已就绪');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(page.getByLabel('生成模式', { exact: true })).toHaveValue('demo');
  await expect(page.getByRole('button', { name: '生成演示视频', exact: true })).toBeEnabled();
  expect(submitted).toEqual([]);
});

test('finishing prompt enhancement preserves text edited while the request was pending', async ({ page }) => {
  let complete;
  let started;
  const pending = new Promise(resolve => { complete = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/local/status*', route => route.fulfill({ json: {
    language: { ready: true, model: 'qwen3:4b', message: '语言模型已就绪' },
    video: { ready: true, message: '视频文件与节点已就绪' },
  } }));
  await page.route('**/api/jobs', route => route.fulfill({ json: [] }));
  await page.route('**/api/prompts/enhance', async route => {
    started();
    await pending;
    await route.fulfill({ json: { prompt: '洁净诊疗室内，治疗师将皮秒激光治疗头平稳移过前臂纹身区域，固定近景。', model: 'qwen3:4b' } });
  });
  await page.goto('/');
  await expect(page.getByText('创作空间已就绪')).toBeVisible();
  await page.getByLabel('描述你的画面').fill('皮秒设备正在进行纹身去除操作，固定镜头');
  await page.getByRole('button', { name: '本地 AI 润色', exact: true }).click();
  await requested;
  const edited = '我修改了要求：只展示皮秒设备和治疗头的外观，镜头缓慢推近。';
  await page.getByLabel('描述你的画面').fill(edited);
  complete();
  await expect(page.getByRole('status')).toContainText('已保留你刚修改的提示词');
  await expect(page.getByLabel('描述你的画面')).toHaveValue(edited);
  await expect(page.getByRole('button', { name: '撤销润色', exact: true })).toHaveCount(0);
});
