import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_TEMPLATES = 20;
export const TEMPLATE_PROFILE_FIELDS = Object.freeze(['summary', 'scene', 'characters', 'objects', 'style', 'camera', 'actions']);
const types = {
  'image/jpeg': { extension: 'jpg', kind: 'image', codec: 'mjpeg' },
  'image/png': { extension: 'png', kind: 'image', codec: 'png' },
  'image/webp': { extension: 'webp', kind: 'image', codec: 'webp' },
  'video/mp4': { extension: 'mp4', kind: 'video', demuxer: 'mov' },
  'video/quicktime': { extension: 'mov', kind: 'video', demuxer: 'mov' },
  'video/webm': { extension: 'webm', kind: 'video', demuxer: 'matroska' },
};
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fault = (message, status = 400) => Object.assign(new Error(message), { status, framePublic: true });

export function validateTemplateProfile(profile) {
  if (!profile || Array.isArray(profile) || typeof profile !== 'object' ||
      Object.keys(profile).length !== TEMPLATE_PROFILE_FIELDS.length ||
      TEMPLATE_PROFILE_FIELDS.some(field => typeof profile[field] !== 'string')) {
    throw fault('模板描述格式无效，请提供摘要、场景、人物、物体、风格、镜头和动作。');
  }
  const result = Object.fromEntries(TEMPLATE_PROFILE_FIELDS.map(field => [field, profile[field].trim()]));
  if (result.summary.length < 10 || Object.values(result).some(value => value.length > 500) ||
      Object.values(result).reduce((total, value) => total + value.length, 0) > 2500) {
    throw fault('模板摘要至少需要 10 个字符，每项最多 500 个字符，合计最多 2500 个字符。');
  }
  return result;
}

function sniffType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(?:iso[0-9a-z]|mp4[12]|avc1|M4V |MSNV|dash|cmf[cs]|F4V )$/.test(brand)) return 'video/mp4';
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const header = buffer.subarray(0, Math.min(buffer.length, 4096));
    // Read EBML DocType rather than accepting any Matroska file with a .webm suffix.
    for (let index = 4; index + 3 < header.length; index++) {
      if (header[index] !== 0x42 || header[index + 1] !== 0x82) continue;
      const sizeByte = header[index + 2];
      if (sizeByte === 0x84 && header.toString('ascii', index + 3, index + 7) === 'webm') return 'video/webm';
    }
  }
  throw fault('素材格式不支持或文件内容无效，请上传 JPEG、PNG、WebP 图片或 MP4、MOV、WebM 视频。');
}

const defaultProbe = ffmpeg => /[/\\]/.test(ffmpeg)
  ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe';
const displayName = name => path.posix.basename(path.win32.basename(String(name || '参考素材')))
  .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || '参考素材';

async function mediaCommand(binary, args) {
  try {
    return (await execute(binary, args, { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw fault('模板处理需要 FFmpeg 和 FFprobe，请先完成本机工具安装。', 503);
    throw fault('无法读取或处理素材，请确认文件完整、格式受支持且大小与分辨率符合限制。');
  }
}

function inputArgs(file, type) {
  const args = ['-protocol_whitelist', 'file,pipe'];
  if (type.demuxer) args.push('-f', type.demuxer);
  if (type.demuxer === 'mov') args.push('-enable_drefs', '0', '-use_absolute_path', '0');
  return [...args, '-i', file];
}

export function createTemplateStore({ dataDir, ffmpeg = 'ffmpeg', ffprobe = defaultProbe(ffmpeg) }) {
  if (!dataDir) throw fault('模板存储位置尚未配置。', 500);
  const base = path.join(path.resolve(dataDir), 'templates');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const items = new Map();
  let pendingUploads = 0;
  const directory = id => {
    if (typeof id !== 'string' || !idPattern.test(id)) throw fault('模板不存在。', 404);
    return path.join(base, id);
  };
  const persist = item => {
    const meta = path.join(directory(item.id), 'metadata.json');
    writeFileSync(`${meta}.tmp`, JSON.stringify(item, null, 2), { mode: 0o600 });
    renameSync(`${meta}.tmp`, meta);
  };
  const find = id => {
    directory(id);
    const item = items.get(id);
    if (!item) throw fault('模板不存在。', 404);
    return item;
  };
  const filePath = item => path.join(directory(item.id), `media.${types[item.mime].extension}`);
  const framePaths = item => Array.from({ length: item.frameCount }, (_, index) => path.join(directory(item.id), `frame-${index + 1}.jpg`));
  const toPublic = item => {
    if (typeof item === 'string') item = find(item);
    const { id, name, kind, mime, bytes, width, height, duration, frameCount, status, profile, error, createdAt, updatedAt } = item;
    return {
      id, name, kind, mime, bytes, width, height, duration, frameCount, status,
      profile: profile ? structuredClone(profile) : null, error, createdAt, updatedAt,
      thumbnailUrl: `/api/templates/${id}/thumbnail`, mediaUrl: `/api/templates/${id}/media`,
    };
  };

  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const meta = path.join(base, entry.name, 'metadata.json');
    try {
      if (statSync(meta).size > 100_000) continue;
      const item = JSON.parse(readFileSync(meta, 'utf8'));
      if (item.id !== entry.name || !Object.hasOwn(types, item.mime) || !Number.isInteger(item.frameCount) || item.frameCount < 1 || item.frameCount > 6) continue;
      if (item.profile) item.profile = validateTemplateProfile(item.profile);
      if (item.status === 'analyzing') {
        item.status = 'failed'; item.error = '上次模板分析因服务重启而中断，可以重新分析。';
        item.updatedAt = new Date().toISOString(); persist(item);
      }
      items.set(item.id, item);
    } catch { /* Preserve incomplete/corrupted uploads on disk without exposing them as valid templates. */ }
  }

  return {
    toPublic,
    list: () => [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toPublic),
    get: id => { const item = find(id); return { ...structuredClone(item), framePaths: framePaths(item), filePath: filePath(item) }; },
    mediaPath: id => filePath(find(id)),
    thumbnailPath: id => framePaths(find(id))[0],
    async add(buffer, { name } = {}) {
      if (!(buffer instanceof Uint8Array) || !buffer.byteLength) throw fault('请选择包含内容的图片或视频文件。');
      if (buffer.byteLength > MAX_UPLOAD_BYTES) throw fault('单个模板最多支持 100 MiB。', 413);
      if (items.size + pendingUploads >= MAX_TEMPLATES) throw fault('最多保存 20 个模板，请先删除不需要的模板。', 409);
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const mime = sniffType(bytes);
      const type = types[mime];
      const id = randomUUID();
      const dir = directory(id);
      pendingUploads++;
      try {
        await mkdir(dir, { mode: 0o700 });
        const source = path.join(dir, `media.${type.extension}`);
        await writeFile(source, bytes, { mode: 0o600 });
        const probe = JSON.parse(await mediaCommand(ffprobe, ['-v', 'error', ...inputArgs(source, type),
          '-show_entries', 'stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=format_name,duration', '-of', 'json']));
        const stream = probe.streams?.find(value => value.codec_type === 'video' && !value.disposition?.attached_pic);
        const width = stream?.width, height = stream?.height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 40_000_000) {
          throw fault('素材画面无效或过大，最大边长为 8192 像素，最多 4000 万像素。');
        }
        if (type.kind === 'image' && stream.codec_name !== type.codec) throw fault('图片内容与支持的图片格式不符。');
        const duration = type.kind === 'video' ? Number(probe.format?.duration || stream.duration) : null;
        if (type.kind === 'video' && (!Number.isFinite(duration) || duration <= 0 || duration > 300)) throw fault('模板视频时长必须大于 0 且不超过 300 秒。');
        const frameCount = type.kind === 'image' ? 1 : Math.min(6, Math.max(1, Math.ceil(duration)));
        for (let index = 0; index < frameCount; index++) {
          const seek = type.kind === 'video' ? ['-ss', ((index + 0.5) * duration / frameCount).toFixed(6)] : [];
          const target = path.join(dir, `frame-${index + 1}.jpg`);
          await mediaCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...seek, ...inputArgs(source, type),
            '-map', '0:v:0', '-frames:v', '1', '-vf', "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease", '-an', '-threads', '1', '-q:v', '4', '-f', 'image2', target]);
          if (!existsSync(target) || statSync(target).size === 0) throw fault('未能提取素材画面，请使用可正常播放的文件。');
        }
        const now = new Date().toISOString();
        const item = { id, name: displayName(name), kind: type.kind, mime, bytes: bytes.length, width, height, duration, frameCount,
          status: 'uploaded', profile: null, error: null, createdAt: now, updatedAt: now };
        persist(item); items.set(id, item);
        return toPublic(item);
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        if (error.status) throw error;
        throw fault('模板上传处理失败，请检查素材是否完整并重试。');
      } finally { pendingUploads--; }
    },
    async analyze(id, analyzer) {
      const item = find(id);
      if (item.status === 'analyzing') throw fault('这个模板正在分析，请稍候。', 409);
      if (typeof analyzer !== 'function') throw fault('模板视觉分析服务尚未配置。', 503);
      item.status = 'analyzing'; item.error = null; item.updatedAt = new Date().toISOString(); persist(item);
      try {
        const images = await Promise.all(framePaths(item).map(async file => (await readFile(file)).toString('base64')));
        const profile = validateTemplateProfile(await analyzer(images, { kind: item.kind, duration: item.duration, frameCount: item.frameCount }));
        item.profile = profile; item.status = 'ready'; item.error = null; item.updatedAt = new Date().toISOString(); persist(item);
        return toPublic(item);
      } catch {
        item.status = 'failed'; item.error = '模板分析失败，请检查本机视觉模型后重试。原素材与已有描述已保留。';
        item.updatedAt = new Date().toISOString(); persist(item);
        throw fault(item.error, 503);
      }
    },
    async updateProfile(id, profile) {
      const item = find(id);
      if (item.status === 'analyzing') throw fault('这个模板正在分析，请稍候再编辑。', 409);
      item.profile = validateTemplateProfile(profile); item.status = 'ready'; item.error = null;
      item.updatedAt = new Date().toISOString(); persist(item);
      return toPublic(item);
    },
    async remove(id) {
      const item = find(id);
      if (item.status === 'analyzing') throw fault('请等待模板分析结束后再删除。', 409);
      await rm(directory(id), { recursive: true, force: true }); items.delete(id);
    },
  };
}
