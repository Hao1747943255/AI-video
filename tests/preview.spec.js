import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test.beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root });
  execFileSync(process.execPath, [path.join(root, 'scripts/export-preview.mjs')], { cwd: root });
});

test('standalone HTML works offline with embedded images, navigation and disabled model actions', async ({ page, context }) => {
  const errors = [];
  const networkRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await context.setOffline(true);
  // The managed cloud browser blocks file:// navigation. Render the exact exported
  // HTML bytes in an offline blank page without changing browser policy.
  await page.setContent(await readFile(path.join(root, 'artifacts/Frame-preview.html'), 'utf8'));
  await expect(page.getByText('独立界面预览', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '界面预览 · 生成需本地服务', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '本地 AI 润色', exact: true })).toBeDisabled();
  await expect.poll(() => page.locator('.preview-stage>img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: path.join(root, 'artifacts/Frame-preview.png'), fullPage: true });
  await page.getByRole('button', { name: '灵感库', exact: true }).click();
  await page.getByRole('button', { name: /森林来信/ }).click();
  await expect(page.getByLabel('描述你的画面')).toHaveValue(/清晨的古老森林/);
  await page.getByRole('radio', { name: '9:16' }).check();
  await expect(page.getByRole('radio', { name: '9:16' })).toBeChecked();
  await page.getByRole('button', { name: '查看生成设置' }).click();
  await expect(page.getByRole('dialog', { name: '生成设置' })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: /我的作品/ }).click();
  await expect(page.getByText('你的第一部作品，从这里开始')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(networkRequests).toEqual([]);
  expect(errors).toEqual([]);
});
