import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
let html = await readFile(path.join(dist, 'index.html'), 'utf8');
const images = {};
for (const style of ['cinematic', 'nature', 'dreamy', 'urban']) {
  images[style] = `data:image/jpeg;base64,${(await readFile(path.join(dist, 'images', `${style}.jpg`))).toString('base64')}`;
}
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)];
if (scripts.length !== 1) throw new Error('Expected one bundled entry script; update the exporter for this build layout.');
const code = await readFile(path.join(dist, scripts[0][1].replace(/^\//, '')), 'utf8');
html = html.replace(scripts[0][0], () => `<script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script>`);
for (const match of [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(path.join(dist, match[1].replace(/^\//, '')), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
const favicon = `data:image/svg+xml;base64,${(await readFile(path.join(dist, 'favicon.svg'))).toString('base64')}`;
html = html.replace('href="/favicon.svg"', `href="${favicon}"`);
html = html.replace('<head>', () => `<head><script>window.__FRAME_PREVIEW_ONLY__=true;window.__FRAME_PREVIEW_ASSETS__=${JSON.stringify(images)};</script>`);
html = html.replace('<title>Frame — AI 视频创作工作台</title>', '<title>Frame — 独立界面预览</title>');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const destination = path.join(root, 'artifacts', 'Frame-preview.html');
await writeFile(destination, html);
console.log(`Standalone interface preview written to ${destination}`);
console.log('Open the HTML file directly in a browser. It contains all assets and makes no API calls. Video generation is disabled.');
