import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, renderDemo, renderSora, styles } from './providers.js';
import { createLocalServices } from './local.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(root, 'data');
  const assetDir = path.join(root, 'public', 'images');
  const webDir = options.webDir || path.join(root, 'dist');
  const indexFile = path.join(webDir, 'index.html');
  const key = options.key ?? (process.env.VIDEO_API_KEY || process.env.OPENAI_API_KEY);
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const demoReady = hasFfmpeg(ffmpeg);
  const local = options.local || createLocalServices();
  mkdirSync(dataDir, { recursive: true });
  const storePath = path.join(dataDir, 'jobs.json');
  let jobs = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : [];
  const save = () => {
    writeFileSync(`${storePath}.tmp`, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    renameSync(`${storePath}.tmp`, storePath);
  };
  // A local render cannot survive a restart. Remote jobs can be resumed by their ID.
  for (const job of jobs) {
    if (['queued', 'processing'].includes(job.status)) {
      if (job.remoteId && ((job.provider === 'sora' && key) || job.provider === 'comfyui')) job.status = 'queued';
      else { job.status = 'failed'; job.error = '服务重启导致任务中断，请重新生成。'; }
    }
  }
  save();
  const publicJob = ({ remoteId, ...job }) => ({
    ...job,
    videoUrl: job.status === 'completed' ? `/api/jobs/${job.id}/video` : null,
    posterUrl: job.provider === 'demo' ? `/images/${job.style}.jpg` : null,
  });
  let working = false;
  let stopped = false;
  const work = async () => {
    if (working || stopped) return;
    const job = jobs.findLast(item => item.status === 'queued');
    if (!job) return;
    working = true;
    const update = changes => { Object.assign(job, changes, { updatedAt: new Date().toISOString() }); save(); };
    update({ status: 'processing', progress: 1 });
    try {
      if (job.provider === 'demo') await (options.renderDemo || renderDemo)(job, { dataDir, assetDir, ffmpeg, update });
      else if (job.provider === 'comfyui') await local.render(job, { dataDir, update });
      else await (options.renderSora || renderSora)(job, { key, dataDir, update });
      update({ status: 'completed', progress: 100 });
    } catch (error) {
      // Do not expose request objects, upstream responses, paths or credentials.
      const message = error.message;
      update({ status: 'failed', error: /[\u4e00-\u9fff]/.test(message) ? message : '生成时连接失败，请检查服务网络后重试。' });
    } finally { working = false; queueMicrotask(work); }
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ app: 'frame-ai-video', frontendReady: existsSync(indexFile) }));
  app.get('/api/config', (_req, res) => res.json({ soraReady: Boolean(key), demoReady, model: 'sora-2', maxPromptLength: 2000 }));
  app.get('/api/local/status', async (req, res) => res.json(await local.inspect(req.query.refresh === '1')));
  app.post('/api/prompts/enhance', async (req, res) => {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string' || prompt.trim().length < 2 || prompt.length > 2000) return res.status(400).json({ error: '请输入 2–2000 个字符的创作想法。' });
    if (working || jobs.some(job => ['queued', 'processing'].includes(job.status))) return res.status(409).json({ error: '视频任务运行中，请完成生成后再使用语言模型，避免争用显存。' });
    try { res.json({ prompt: await local.enhance(prompt.trim()), model: local.model }); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/jobs', (_req, res) => res.json(jobs.map(publicJob)));
  app.post('/api/jobs', (req, res) => {
    const { prompt, ratio, seconds, style, provider } = req.body || {};
    if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > 2000) return res.status(400).json({ error: '请用 10–2000 个字符描述你的视频。' });
    if (!['16:9', '9:16'].includes(ratio) || !(provider === 'comfyui' ? [2] : [4, 8, 12]).includes(seconds) || !Object.hasOwn(styles, style) || !['demo', 'sora', 'comfyui'].includes(provider)) return res.status(400).json({ error: '请选择有效的比例、时长、风格和生成模式；本地模式当前使用 2 秒短片。' });
    if (provider === 'sora' && !key) return res.status(503).json({ error: '尚未配置 API 密钥，请先使用演示模式，或在服务器配置密钥。' });
    if (provider === 'demo' && !demoReady) return res.status(503).json({ error: '演示模式需要 FFmpeg，请先安装 FFmpeg。' });
    if (jobs.filter(job => ['queued', 'processing'].includes(job.status)).length >= 5) return res.status(429).json({ error: '最多同时保留 5 个待处理任务，请等待当前任务完成。' });
    if (jobs.length >= 100) return res.status(409).json({ error: '已达到 100 条记录上限，请在作品库删除部分旧作品。' });
    const job = { id: randomUUID(), prompt: prompt.trim(), ratio, seconds, style, provider, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null };
    jobs.unshift(job);
    save();
    res.status(202).json(publicJob(job));
    setImmediate(work);
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在。' });
    res.json(publicJob(job));
  });
  app.get('/api/jobs/:id/video', (req, res, next) => {
    const job = jobs.find(item => item.id === req.params.id);
    if (!job || job.status !== 'completed') return res.status(404).json({ error: '视频尚未生成或已被删除。' });
    const file = path.join(dataDir, `${job.id}.mp4`);
    if (req.query.download === '1') res.download(file, `frame-${job.id.slice(0, 8)}.mp4`, error => error && next(error));
    else res.sendFile(file, error => error && next(error));
  });
  app.delete('/api/jobs/:id', (req, res) => {
    const job = jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在。' });
    if (['queued', 'processing'].includes(job.status)) return res.status(409).json({ error: '请等待任务结束后再删除。' });
    const file = path.join(dataDir, `${job.id}.mp4`);
    if (existsSync(file)) unlinkSync(file);
    jobs = jobs.filter(item => item.id !== job.id);
    save();
    res.status(204).end();
  });
  // Both local development and production serve the same bundled sample assets.
  app.use('/images', express.static(assetDir));
  // Register routes even before a build exists. A build created after startup
  // must become available without requiring another backend restart.
  app.use(express.static(webDir));
  app.get('/{*path}', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || path.extname(req.path)) return next();
    res.set('Cache-Control', 'no-store');
    if (!existsSync(indexFile)) return res.status(503).type('html').send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frame · 需要构建网页</title>
<style>body{font:16px/1.8 system-ui,sans-serif;background:#f7f8fa;color:#29342b;margin:0;padding:10vh 24px}main{max-width:650px;margin:auto;background:white;border:1px solid #e1e7dc;border-radius:12px;padding:32px}h1{font-size:23px}pre{background:#f0f5e9;padding:16px;overflow:auto;border-radius:7px}p{color:#697566}code{font-family:monospace}</style>
<main><h1>后端已启动，网页尚未构建</h1><p>请在包含 package.json 的项目目录打开另一个终端，执行：</p><pre>npm.cmd run build</pre><p>构建成功后刷新此页面。也可以在旧终端按 Ctrl+C 停止服务，再执行：</p><pre>npm.cmd start</pre><p>新版 npm start 会自动构建网页。开发模式请运行 npm.cmd run dev，然后打开 5173 端口。此问题无需重新下载模型。</p></main></html>`);
    res.sendFile(indexFile);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: '请求内容必须是有效 JSON。' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大。' });
    res.status(error.status === 404 || error.code === 'ENOENT' ? 404 : 500).json({ error: '操作失败，请稍后重试。' });
  });
  setImmediate(work);
  return { app, stop: () => { stopped = true; }, isWorking: () => working };
}
