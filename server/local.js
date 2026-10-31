import { randomInt } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { styles } from './providers.js';

export const MODEL_NAMES = {
  unet: 'wan2.1_t2v_1.3B_fp16.safetensors',
  clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  vae: 'wan_2.1_vae.safetensors',
};

// Only talk directly to local services, never route them through an Internet proxy.
export function localUrl(value, port) {
  const url = new URL(value || `http://127.0.0.1:${port}`);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('本地模型地址必须是本机 HTTP 地址，例如 http://127.0.0.1:8188。');
  }
  return url.origin;
}

export function wanWorkflow(job, { modernVideo = false } = {}) {
  const [width, height] = job.ratio === '16:9' ? [512, 288] : [288, 512];
  const frames = job.seconds * 16 + 1;
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_NAMES.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_NAMES.clip, type: 'wan', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: MODEL_NAMES.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: `${job.prompt}\n${styles[job.style]}` } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'blurry, still image, subtitles, watermark, distorted anatomy, low quality, excessive camera shake' } },
    '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } },
    '7': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    '8': { class_type: 'KSampler', inputs: { model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: randomInt(2 ** 48 - 1), steps: 20, cfg: 6, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: frames / job.seconds } },
    '11': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: `frame/${job.id}`, format: 'mp4', codec: 'h264' } },
  };
  // Recent ComfyUI releases serialize video format/codec as dynamic combo objects.
  if (modernVideo) graph['11'].inputs = { video: ['10', 0], filename_prefix: `frame/${job.id}`, format: { format: 'mp4', codec: { codec: 'h264' } } };
  return graph;
}

export function createLocalServices({
  ollamaUrl = process.env.OLLAMA_URL, comfyUrl = process.env.COMFYUI_URL,
  ollamaModel = process.env.OLLAMA_MODEL || 'qwen3:4b',
  request = globalThis.fetch, pollMs = 2000, timeoutMs = 2 * 60 * 60_000,
} = {}) {
  const ollama = localUrl(ollamaUrl, 11434);
  const comfy = localUrl(comfyUrl, 8188);
  const call = async (base, endpoint, options = {}, timeout = 5000) => {
    try {
      const response = await request(`${base}${endpoint}`, { ...options, signal: AbortSignal.timeout(timeout), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      return response;
    } catch {
      throw new Error(base === ollama ? '无法连接本机 Ollama，请确认服务已启动且模型已下载。' : '无法连接本机 ComfyUI，请确认服务已启动、节点版本兼容且模型已安装。');
    }
  };
  let cached;
  let expires = 0;
  let inFlight;
  let modernVideo = false;
  const inspect = async (force = false) => {
    if (!force && cached && expires > Date.now()) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const [language, video] = await Promise.allSettled([
        (async () => {
          const data = await (await call(ollama, '/api/tags')).json();
          const ready = data.models?.some(item => item.name === ollamaModel || item.model === ollamaModel);
          return { ready: Boolean(ready), model: ollamaModel, message: ready ? '语言模型已就绪' : `请先运行 ollama pull ${ollamaModel}` };
        })(),
        (async () => {
          const info = await (await call(comfy, '/object_info', {}, 10_000)).json();
          const classes = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyHunyuanLatentVideo', 'ModelSamplingSD3', 'KSampler', 'VAEDecode', 'CreateVideo', 'SaveVideo'];
          const missingNodes = classes.filter(type => !info[type]);
          if (missingNodes.length) return { ready: false, model: 'Wan 2.1 1.3B', message: `ComfyUI 缺少原生节点：${missingNodes.join(', ')}，请更新 ComfyUI。` };
          modernVideo = info.SaveVideo.input?.required?.format?.[0] === 'COMFY_DYNAMICCOMBO_V3';
          const models = [
            ['UNETLoader', 'unet_name', MODEL_NAMES.unet],
            ['CLIPLoader', 'clip_name', MODEL_NAMES.clip],
            ['VAELoader', 'vae_name', MODEL_NAMES.vae],
          ];
          const missing = models.filter(([node, input, name]) => !info[node].input?.required?.[input]?.[0]?.includes(name)).map(([, , name]) => name);
          return { ready: missing.length === 0, model: 'Wan 2.1 1.3B', message: missing.length ? `缺少模型文件：${missing.join('、')}` : '视频模型文件与节点已就绪；首次运行仍需验证显存是否足够' };
        })(),
      ]);
      cached = {
        language: language.status === 'fulfilled' ? language.value : { ready: false, model: ollamaModel, message: language.reason.message },
        video: video.status === 'fulfilled' ? video.value : { ready: false, model: 'Wan 2.1 1.3B', message: video.reason.message },
      };
      expires = Date.now() + 15_000;
      return cached;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };

  let enhancing = false;
  const enhance = async prompt => {
    if (enhancing) throw new Error('语言模型正在处理上一个请求，请稍候。');
    enhancing = true;
    try {
      const status = await inspect();
      if (!status.language.ready) throw new Error(status.language.message);
      // ComfyUI caches models after generation; release them before Ollama uses VRAM.
      if (status.video.ready) await call(comfy, '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }, 30_000);
      const response = await call(ollama, '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel, stream: false, think: false, keep_alive: 0,
          messages: [
            { role: 'system', content: '你是视频提示词编辑。保留用户的主体与意图，补充具体动作、场景、光线和单一平稳镜头，写成适合文生视频的中文提示词。仅返回一段不超过400字的提示词，不要解释、标题或思考过程。' },
            { role: 'user', content: prompt },
          ],
          options: { temperature: 0.6, num_predict: 600, num_ctx: 4096 },
        }),
      }, 180_000);
      const data = await response.json();
      const text = data.message?.content?.trim();
      if (!text || text.length > 2000) throw new Error('语言模型没有返回有效提示词，请缩短输入后重试。');
      return text;
    } finally { enhancing = false; }
  };

  const render = async (job, { dataDir, update }) => {
    if (enhancing) throw new Error('请等待语言模型完成润色，再启动视频生成。');
    const status = await inspect();
    if (!status.video.ready) throw new Error(status.video.message);
    let remoteId = job.remoteId;
    if (!remoteId) {
      const response = await call(comfy, '/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wanWorkflow(job, { modernVideo }), client_id: job.id }),
      }, 30_000);
      const result = await response.json();
      if (!result.prompt_id || Object.keys(result.node_errors || {}).length) throw new Error('ComfyUI 拒绝了工作流，请检查节点版本、模型名称与控制台错误。');
      remoteId = result.prompt_id;
      update({ remoteId, progress: 2 });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await (await call(comfy, `/history/${encodeURIComponent(remoteId)}`, {}, 10_000)).json();
      const item = history[remoteId];
      if (item?.status?.status_str === 'error' || item?.status?.messages?.some(([name]) => name === 'execution_error' || name === 'execution_interrupted')) {
        throw new Error('本地视频生成失败，请检查 ComfyUI 控制台；常见原因是显存或内存不足。');
      }
      if (item?.status?.completed) {
        const output = item.outputs?.['11'];
        const file = [...(output?.images || []), ...(output?.videos || []), ...(output?.gifs || [])].find(entry => entry.filename?.toLowerCase().endsWith('.mp4'));
        if (!file || file.type !== 'output') throw new Error('工作流已结束，但没有返回 MP4 输出，请检查 SaveVideo 节点。');
        const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: 'output' });
        const response = await call(comfy, `/view?${params}`, {}, 180_000);
        const temporary = path.join(dataDir, `${job.id}.mp4.part`);
        try {
          await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
          await rename(temporary, path.join(dataDir, `${job.id}.mp4`));
        } catch (error) { await rm(temporary, { force: true }); throw error; }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error('本地生成等待超过两小时。ComfyUI 中的任务可能仍在运行，请先查看其控制台，避免重复提交。');
  };
  return { inspect, enhance, render, model: ollamaModel };
}
