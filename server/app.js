import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, renderDemo, renderSora, styles } from './providers.js';
import { createLocalServices, localUrl } from './local.js';
import { resolveDuration, DURATION_OPTIONS } from '../shared/duration.js';
import { createTemplateStore, MAX_UPLOAD_BYTES } from './templates.js';
import { createTemplateVision } from './template-vision.js';
import { createMemoryStore } from './memory.js';

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
  const templates = createTemplateStore({ dataDir, ffmpeg });
  const memory = createMemoryStore({ dataDir });
  const vision = options.vision || createTemplateVision({ ollamaUrl: localUrl(process.env.OLLAMA_URL, 11434), comfyUrl: localUrl(process.env.COMFYUI_URL, 8188), textModel: process.env.OLLAMA_MODEL || 'qwen3:4b' });
  const publicError = (message, status = 400) => Object.assign(new Error(message), { status, framePublic: true });
  const memoryContext = body => {
    if (body.useMemory !== undefined && typeof body.useMemory !== 'boolean') throw publicError('记忆开关必须为布尔值。');
    if (!body.useMemory || !memory.state().enabled) return null;
    if (typeof body.conversationId !== 'string') throw publicError('请选择一个创作会话后使用上下文记忆。');
    return memory.context(body.conversationId);
  };
  const referenceFor = body => {
    if (!body.templateId) return {};
    if (body.provider === 'demo') throw publicError('演示模式不读取模板描述，请选择本地 Wan 或已配置的 Sora。');
    const template = templates.get(body.templateId);
    if (template.status !== 'ready' || !template.profile) throw publicError('请先分析或保存模板描述，再选择它用于生成。');
    const allowed = ['scene', 'characters', 'objects', 'style', 'camera', 'actions'];
    const aspects = body.referenceAspects ?? allowed;
    if (!Array.isArray(aspects) || !aspects.length || aspects.length > 6 || aspects.some(key => !allowed.includes(key)) || new Set(aspects).size !== aspects.length) throw publicError('请选择有效且不重复的模板参考要点。');
    const labels = { scene: '场景', characters: '人物外观', objects: '物体与设备', style: '画面风格', camera: '镜头', actions: '动作' };
    const description = aspects.filter(key => template.profile[key]).map(key => `${labels[key]}：${template.profile[key].slice(0, 250)}`).join('\n');
    if (!description) throw publicError('所选模板要点没有描述，请先补充或选择其他要点。');
    return { templateId: template.id, templateName: template.name, referenceAspects: aspects, referenceSummary: description };
  };
  const checkContext = context => {
    if (!context) return;
    let fresh;
    try { fresh = memory.context(context.sessionId); }
    catch { throw publicError('会话记忆已变化或删除，本次旧上下文结果未采用，请重试。', 409); }
    if (!fresh.enabled || fresh.stamp.global !== context.stamp.global || fresh.stamp.session !== context.stamp.session) throw publicError('会话记忆已变化，本次旧上下文结果未采用，请重试。', 409);
  };
  const storePath = path.join(dataDir, 'jobs.json');
  let jobs = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : [];
  const save = () => {
    writeFileSync(`${storePath}.tmp`, JSON.stringify(jobs, null, 2), { mode: 0o600 });
    renameSync(`${storePath}.tmp`, storePath);
  };
  // A local render cannot survive a restart. Remote jobs can be resumed by their ID.
  for (const job of jobs) {
    if (['queued', 'processing'].includes(job.status)) {
      if ((job.remoteId && ((job.provider === 'sora' && key) || job.provider === 'comfyui')) || (job.provider === 'comfyui' && job.segments?.length)) job.status = 'queued';
      else { job.status = 'failed'; job.error = '服务重启导致任务中断，请重新生成。'; }
    }
    if (['completed', 'failed'].includes(job.status)) {
      try { memory.updateJob(job.id, job.status); }
      catch { console.error('任务状态已恢复，但记忆状态保存失败，请检查本机存储。'); }
    }
  }
  save();
  const publicJob = ({ remoteId, segments, generationPrompt, ...job }) => ({
    ...job,
    videoUrl: job.status === 'completed' ? `/api/jobs/${job.id}/video` : null,
    posterUrl: job.provider === 'demo' ? `/images/${job.style}.jpg` : null,
  });
  let working = false;
  let analyzing = false;
  let stopped = false;
  const work = async () => {
    if (working || analyzing || stopped) return;
    const job = jobs.findLast(item => item.status === 'queued');
    if (!job) return;
    working = true;
    const update = changes => { Object.assign(job, changes, { updatedAt: new Date().toISOString() }); save(); };
    update({ status: 'processing', progress: 1 });
    try {
      const renderJob = job.generationPrompt ? { ...job, prompt: job.generationPrompt } : job;
      if (job.provider === 'demo') await (options.renderDemo || renderDemo)(renderJob, { dataDir, assetDir, ffmpeg, update });
      else if (job.provider === 'comfyui') await local.render(renderJob, { dataDir, update });
      else await (options.renderSora || renderSora)(renderJob, { key, dataDir, update });
      update({ status: 'completed', progress: 100 });
      try { memory.updateJob(job.id, 'completed'); } catch { console.error('作品已完成，但记忆状态保存失败，请检查本机存储。'); }
    } catch (error) {
      // Do not expose request objects, upstream responses, paths or credentials.
      const message = error.message;
      update({ status: 'failed', error: /[\u4e00-\u9fff]/.test(message) ? message : '生成时连接失败，请检查服务网络后重试。' });
      try { memory.updateJob(job.id, 'failed'); } catch { console.error('记忆任务状态保存失败，请检查本机存储。'); }
    } finally { working = false; queueMicrotask(work); }
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => res.json({ app: 'frame-ai-video', frontendReady: existsSync(indexFile) }));
  app.get('/api/memory', (_req, res) => res.json(memory.state()));
  app.patch('/api/memory', (req, res) => res.json(memory.updateSettings(req.body)));
  app.delete('/api/memory', (_req, res) => res.json(memory.clearAll()));
  app.post('/api/memory/sessions', (req, res) => {
    const session = memory.createSession(req.body || {});
    res.status(201).json({ session, state: memory.state() });
  });
  app.get('/api/memory/sessions/:id', (req, res) => res.json(memory.getSession(req.params.id)));
  app.patch('/api/memory/sessions/:id', (req, res) => res.json({ session: memory.updateSession(req.params.id, req.body), state: memory.state() }));
  app.delete('/api/memory/sessions/:id', (req, res) => res.json(memory.deleteSession(req.params.id)));
  app.post('/api/memory/sessions/:id/clear', (req, res) => res.json({ session: memory.clearSession(req.params.id), state: memory.state() }));
  app.delete('/api/memory/sessions/:id/turns/:turnId', (req, res) => res.json({ session: memory.deleteTurn(req.params.id, req.params.turnId), state: memory.state() }));
  app.get('/api/config', (_req, res) => res.json({ soraReady: Boolean(key), demoReady, model: 'sora-2', maxPromptLength: 2000, durationOptions: DURATION_OPTIONS, maxDuration: 60, visionModel: vision.model }));
  app.get('/api/local/status', async (req, res) => {
    const [status, visual] = await Promise.all([local.inspect(req.query.refresh === '1'), vision.inspect()]);
    res.json({ ...status, vision: visual });
  });
  app.get('/api/templates', (_req, res) => res.json(templates.list()));
  app.post('/api/templates', express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    res.status(201).json(await templates.add(req.body, { name: typeof req.query.name === 'string' ? req.query.name : '参考素材' }));
  });
  app.get('/api/templates/:id/thumbnail', (req, res) => res.type('jpg').set('X-Content-Type-Options', 'nosniff').sendFile(templates.thumbnailPath(req.params.id)));
  app.get('/api/templates/:id/media', (req, res) => {
    const item = templates.get(req.params.id);
    res.type(item.mime).set('X-Content-Type-Options', 'nosniff').sendFile(templates.mediaPath(item.id));
  });
  app.post('/api/templates/:id/analyze', async (req, res) => {
    if (analyzing || working || jobs.some(job => ['queued', 'processing'].includes(job.status))) return res.status(409).json({ error: '请等待视频或模板任务结束后再分析，避免模型争用显存。' });
    analyzing = true;
    try {
      const ready = await vision.inspect();
      if (!ready.ready) return res.status(503).json({ error: ready.message });
      res.json(await templates.analyze(req.params.id, (images, metadata) => vision.analyze(images, metadata)));
    } finally { analyzing = false; }
  });
  app.patch('/api/templates/:id', async (req, res) => res.json(await templates.updateProfile(req.params.id, req.body?.profile)));
  app.delete('/api/templates/:id', async (req, res) => { await templates.remove(req.params.id); res.status(204).end(); });
  app.post('/api/prompts/enhance', async (req, res) => {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string' || prompt.trim().length < 2 || prompt.length > 2000) return res.status(400).json({ error: '请输入 2–2000 个字符的创作想法。' });
    if (analyzing || working || jobs.some(job => ['queued', 'processing'].includes(job.status))) return res.status(409).json({ error: '模型任务运行中，请完成任务后再使用语言模型，避免争用显存。' });
    const context = memoryContext(req.body);
    const reference = referenceFor(req.body);
    analyzing = true;
    try {
      const result = await local.enhance(prompt.trim(), { context: context ? { ...context, reference: reference.referenceSummary } : undefined });
      checkContext(context);
      const turn = context ? memory.appendTurn(context.sessionId, { kind: 'enhance', input: prompt.trim(), prompt: result }, context.stamp) : null;
      res.json({ prompt: result, model: local.model, memory: turn ? { sessionId: context.sessionId, turnId: turn.id, used: context.hasContext } : null });
    }
    catch (error) { res.status(error.framePublic ? error.status : 503).json({ error: error.message }); }
    finally { analyzing = false; }
  });
  app.get('/api/jobs', (_req, res) => res.json(jobs.map(publicJob)));
  app.post('/api/jobs', async (req, res) => {
    const { prompt, ratio, style, provider, durationMode = 'manual', templateId } = req.body || {};
    const context = memoryContext(req.body || {});
    const shortFollowUp = context?.hasContext && provider !== 'demo';
    if (typeof prompt !== 'string' || prompt.trim().length < (shortFollowUp ? 2 : 10) || prompt.length > 2000) return res.status(400).json({ error: shortFollowUp ? '请输入 2–2000 个字符的本次创作要求。' : '首次创作请用 10–2000 个字符描述你的视频。' });
    if (!['16:9', '9:16'].includes(ratio) || !Object.hasOwn(styles, style) || !['demo', 'sora', 'comfyui'].includes(provider)) return res.status(400).json({ error: '请选择有效的比例、风格和生成模式。' });
    if (analyzing) return res.status(409).json({ error: '模板分析或提示词润色正在进行，请结束后再生成，避免争用显存。' });
    const reference = referenceFor(req.body);
    if (provider === 'sora' && !key) return res.status(503).json({ error: '尚未配置 API 密钥，请先使用演示模式，或在服务器配置密钥。' });
    if (provider === 'demo' && !demoReady) return res.status(503).json({ error: '演示模式需要 FFmpeg，请先安装 FFmpeg。' });
    if (jobs.filter(job => ['queued', 'processing'].includes(job.status)).length >= 5) return res.status(429).json({ error: '最多同时保留 5 个待处理任务，请等待当前任务完成。' });
    if (jobs.length >= 100) return res.status(409).json({ error: '已达到 100 条记录上限，请在作品库删除部分旧作品。' });
    let resolvedPrompt = prompt.trim();
    const usedMemory = Boolean(context?.hasContext && provider !== 'demo');
    if (usedMemory) {
      if (working || jobs.some(job => ['queued', 'processing'].includes(job.status))) return res.status(409).json({ error: '请等待当前视频任务结束，再结合会话上下文生成，避免争用显存。' });
      analyzing = true;
      try {
        resolvedPrompt = await local.enhance(prompt.trim(), { context: { ...context, reference: reference.referenceSummary,
          currentSettings: { provider, ratio, style, durationMode, ...(durationMode === 'manual' ? { seconds: req.body.seconds } : {}) } } });
        checkContext(context);
      } catch (error) { return res.status(error.framePublic ? error.status : 503).json({ error: error.message }); }
      finally { analyzing = false; }
    }
    let seconds;
    try {
      seconds = resolveDuration({ provider, prompt: resolvedPrompt, seconds: req.body.seconds, durationMode });
      if (durationMode === 'prompt' && usedMemory) {
        let originalSeconds;
        try { originalSeconds = resolveDuration({ provider, prompt, durationMode }); } catch (error) { if (!error.message.startsWith('未识别到')) throw error; }
        if (originalSeconds && originalSeconds !== seconds) throw publicError('上下文整理改变了本次明确的时长，请调整描述后重试。');
      }
    } catch (error) { return res.status(400).json({ error: error.message }); }
    checkContext(context);
    const settings = { ratio, seconds, durationMode, style, provider, ...Object.fromEntries(['templateId', 'templateName', 'referenceAspects'].filter(key => reference[key] !== undefined).map(key => [key, reference[key]])) };
    const job = { id: randomUUID(), prompt: prompt.trim(), resolvedPrompt, ratio, seconds, durationMode, style, provider, ...reference,
      ...(usedMemory || reference.referenceSummary ? { generationPrompt: `${resolvedPrompt}${reference.referenceSummary ? `\n\n参考模板的可见要点（优先遵循上述本次要求）：\n${reference.referenceSummary}` : ''}` } : {}),
      ...(context ? { memorySessionId: context.sessionId, memorySessionTitle: context.title, memoryUsed: usedMemory } : {}),
      status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null };
    const turn = context ? memory.appendTurn(context.sessionId, { kind: 'generate', input: prompt.trim(), prompt: resolvedPrompt, settings, jobId: job.id }, context.stamp) : null;
    jobs.unshift(job);
    try { save(); }
    catch (error) { jobs = jobs.filter(item => item.id !== job.id); if (turn) memory.deleteTurn(context.sessionId, turn.id); throw error; }
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
    rmSync(path.join(dataDir, 'segments', job.id), { recursive: true, force: true });
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
    if (error.framePublic) return res.status(error.status || 400).json({ error: error.message });
    res.status(error.status === 404 || error.code === 'ENOENT' ? 404 : 500).json({ error: '操作失败，请稍后重试。' });
  });
  setImmediate(work);
  return { app, stop: () => { stopped = true; }, isWorking: () => working };
}
