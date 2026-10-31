import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fetch, EnvHttpProxyAgent } from 'undici';

const proxy = new EnvHttpProxyAgent();
export const styles = {
  cinematic: 'Cinematic film look, natural light, slow camera movement, rich color grading.',
  nature: 'Nature documentary, realistic textures, soft daylight, gentle camera movement.',
  dreamy: 'Dreamlike atmosphere, ethereal light, soft colors, poetic cinematic movement.',
  urban: 'Urban night photography, neon reflections, cinematic contrast, smooth tracking shot.',
};

export function hasFfmpeg(binary = 'ffmpeg') {
  return spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0;
}

export async function renderDemo(job, { dataDir, assetDir, ffmpeg = 'ffmpeg', update }) {
  const [width, height] = job.ratio === '16:9' ? [1280, 720] : [720, 1280];
  const target = path.join(dataDir, `${job.id}.mp4`);
  const frames = job.seconds * 24;
  const canvas = job.ratio === '16:9' ? '2400:1350' : '1350:2400';
  // Demonstration only: animate a bundled photograph. No model or prompt understanding.
  const filter = `scale=${canvas}:force_original_aspect_ratio=increase,crop=${canvas},zoompan=z='1.12+0.10*on/${frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${frames}:s=${width}x${height}:fps=24,setsar=1,fade=t=in:st=0:d=0.4,fade=t=out:st=${job.seconds - 0.4}:d=0.4`;
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', path.join(assetDir, `${job.style}.jpg`),
      '-vf', filter, '-frames:v', String(frames), '-an',
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
      '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-progress', 'pipe:1', target,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/out_time_us=(\d+)/);
      if (match) update({ progress: Math.min(96, Math.round(Number(match[1]) / (job.seconds * 1e6) * 100)) });
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 FFmpeg，请检查安装和 FFMPEG_PATH。')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`演示视频渲染失败，请检查 FFmpeg 和素材文件。${errors.includes('No such file') ? ' 素材或路径不存在。' : ''}`));
    });
  }).catch(async error => { await rm(target, { force: true }); throw error; });
}

export async function renderSora(job, {
  key, dataDir, update, baseUrl = 'https://api.openai.com/v1', pollMs = 5000,
  request = (url, options) => fetch(url, { ...options, dispatcher: proxy }),
}) {
  const headers = { Authorization: `Bearer ${key}` };
  const call = async (endpoint, options = {}) => {
    const response = await request(`${baseUrl}${endpoint}`, {
      ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const messages = {
        401: 'API 密钥无效或已过期，请检查服务器配置。',
        403: '当前账号没有视频生成权限，或所在地区不受支持。',
        429: 'API 额度不足或请求过于频繁，请检查账户后重试。',
        400: '生成服务拒绝了参数或提示词，请修改内容后重试。',
      };
      throw new Error(messages[response.status] || `视频生成服务暂时不可用（HTTP ${response.status}）。`);
    }
    return response;
  };
  let remoteId = job.remoteId;
  if (!remoteId) {
    const form = new FormData();
    form.set('prompt', `${job.prompt}\n\nVisual direction: ${styles[job.style]}`);
    form.set('model', 'sora-2');
    form.set('seconds', String(job.seconds));
    form.set('size', job.ratio === '16:9' ? '1280x720' : '720x1280');
    const created = await (await call('/videos', { method: 'POST', body: form })).json();
    if (typeof created.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(created.id)) throw new Error('生成服务返回了无效的任务编号。');
    remoteId = created.id;
    update({ remoteId, progress: 2 });
  }
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const remote = await (await call(`/videos/${remoteId}`)).json();
    if (remote.status === 'failed') {
      throw new Error('AI 视频生成失败，可能是内容限制或服务异常。请调整提示词重试。');
    }
    if (remote.status === 'completed') {
      update({ progress: 97 });
      const response = await request(`${baseUrl}/videos/${remoteId}/content`, { headers, signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('视频已生成，但下载失败，请稍后重试。'); }
      const temporary = path.join(dataDir, `${job.id}.mp4.part`);
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
        const { rename } = await import('node:fs/promises');
        await rename(temporary, path.join(dataDir, `${job.id}.mp4`));
      } catch (error) { await rm(temporary, { force: true }); throw error; }
      return;
    }
    update({ progress: Math.max(2, Math.min(95, Number(remote.progress) || 2)) });
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error('等待生成结果超时。任务可能仍在服务端运行，可稍后查询 OpenAI 控制台。');
}
