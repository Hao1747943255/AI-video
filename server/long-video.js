import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_SECONDS = 60;

function runMedia(binary, args, { cwd, timeout = 120_000, message } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(message));
      else resolve(output);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, timeout);
    child.once('error', () => finish(true));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 256 * 1024) { child.kill('SIGKILL'); finish(true); }
    });
    child.once('close', code => finish(code !== 0));
  });
}

function probeBinary(ffmpeg) {
  if (!path.isAbsolute(ffmpeg)) return 'ffprobe';
  return path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

async function inspectClip(file, seconds, { ffprobe, cwd, expectedSize } = {}) {
  const metadata = await stat(file).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) return null;
  const output = await runMedia(ffprobe, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', file,
  ], { cwd, timeout: 30_000, message: '分段视频校验失败，请确认 FFprobe 可用且片段文件完整。' }).catch(() => null);
  if (!output) return null;
  let info;
  try { info = JSON.parse(output); } catch { return null; }
  const video = info.streams?.[0];
  const duration = Number(info.format?.duration);
  if (!video || !Number.isFinite(duration) || Math.abs(duration - seconds) > 0.08 ||
      video.codec_name !== 'h264' || !(video.width > 0 && video.height > 0) ||
      (expectedSize && (video.width !== expectedSize.width || video.height !== expectedSize.height))) return null;
  return { width: video.width, height: video.height, duration };
}

/** Generate every segment independently; never loop or slow down a previous clip. */
export async function renderLongVideo(job, {
  dataDir, update, ffmpeg = 'ffmpeg', ffprobe = probeBinary(ffmpeg),
}, renderClip) {
  if (!Number.isInteger(job.seconds) || job.seconds < 2 || job.seconds > MAX_SECONDS ||
      typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(job.id) ||
      typeof job.prompt !== 'string' || typeof renderClip !== 'function' || typeof update !== 'function') {
    throw new Error('本地视频参数无效，时长需为 2–60 秒整数，任务编号和描述必须有效。');
  }
  if (job.seconds === 2) return renderClip(job, { dataDir, update });

  const directory = path.join(path.resolve(dataDir), 'segments', job.id);
  await mkdir(directory, { recursive: true });
  const total = Math.ceil(job.seconds / 2);
  const old = job.segments;
  if (old !== undefined && (!Array.isArray(old) || old.length !== total)) {
    throw new Error('已保存的分段记录与本次时长不一致，已有片段已保留。');
  }
  const segments = Array.from({ length: total }, (_, index) => {
    const id = `${job.id}-part-${index + 1}`;
    const seconds = Math.min(2, job.seconds - index * 2);
    const previous = old?.[index];
    if (previous && (previous.id !== id || previous.seconds !== seconds)) {
      throw new Error('已保存的分段编号或时长不一致，已有片段已保留。');
    }
    return { id, seconds, status: previous?.status || 'queued',
      ...(typeof previous?.remoteId === 'string' && previous.remoteId ? { remoteId: previous.remoteId } : {}) };
  });
  const publish = stage => {
    const completedSegments = segments.filter(segment => segment.status === 'completed').length;
    const changes = {
      segments: segments.map(segment => ({ ...segment })), totalSegments: total, completedSegments,
      // This measures completed clips only; model sampling remains indeterminate.
      progress: Math.floor(completedSegments / total * 100), stage,
    };
    Object.assign(job, changes);
    update(changes);
  };
  publish('准备分段生成');
  let expectedSize;
  for (const [index, segment] of segments.entries()) {
    const file = path.join(directory, `${segment.id}.mp4`);
    if (segment.status === 'completed') {
      const existing = await inspectClip(file, segment.seconds, { ffprobe, cwd: directory, expectedSize });
      if (existing) {
        expectedSize ||= existing;
        publish(`已恢复片段 ${index + 1}/${total}`);
        continue;
      }
    }
    segment.status = 'processing';
    publish(`正在生成片段 ${index + 1}/${total}`);
    const childJob = {
      ...job, id: segment.id, seconds: segment.seconds, remoteId: segment.remoteId, segments: undefined,
      prompt: `${job.prompt}\n片段 ${index + 1}/${total}，时间 ${index * 2}–${index * 2 + segment.seconds} 秒。延续同一主体、场景和动作，仅描绘此时间段内自然发生的短暂动作。`,
    };
    try {
      await renderClip(childJob, { dataDir: directory, update: changes => {
        if (typeof changes.remoteId === 'string' && changes.remoteId) segment.remoteId = changes.remoteId;
        publish(`正在生成片段 ${index + 1}/${total}`);
      } });
      const rendered = await inspectClip(file, segment.seconds, { ffprobe, cwd: directory, expectedSize });
      if (!rendered) throw new Error('片段文件不完整、时长不符或画面尺寸不一致，请查看 ComfyUI 输出。');
      expectedSize ||= rendered;
      segment.status = 'completed';
      publish(`已完成片段 ${index + 1}/${total}`);
    } catch (error) {
      segment.status = 'failed';
      publish(`片段 ${index + 1}/${total} 生成失败`);
      const detail = typeof error?.message === 'string' && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message.slice(0, 1200) : '请检查 ComfyUI 控制台及本机服务状态。';
      throw new Error(`第 ${index + 1}/${total} 段生成失败：${detail} 已完成的片段和任务记录已保留。`);
    }
  }

  publish('全部片段完成，正在合成视频');
  const list = path.join(directory, 'concat.txt');
  await writeFile(list, segments.map(segment => `file '${segment.id}.mp4'`).join('\n') + '\n', { mode: 0o600 });
  const output = path.join(path.resolve(dataDir), `${job.id}.mp4`);
  const temporary = `${output}.part`;
  try {
    await runMedia(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe',
      '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-vf', 'fps=16', '-t', String(job.seconds), '-an',
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-f', 'mp4', temporary,
    ], { cwd: directory, message: '分段视频合成失败，请检查 FFmpeg 和可用空间；已有片段及任务记录已保留。' });
    if (!await inspectClip(temporary, job.seconds, { ffprobe, cwd: directory, expectedSize })) {
      throw new Error('合成视频校验失败，已有分段和任务记录已保留。');
    }
    await rename(temporary, output);
    publish('视频合成完成');
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
