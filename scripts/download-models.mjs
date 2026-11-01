import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fetch, EnvHttpProxyAgent } from 'undici';

class DownloadError extends Error {
  constructor(message, code, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function valid(file, expected) {
  try { return (await stat(file)).size === expected.size && await sha256(file) === expected.sha256; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function alreadyInstalled(destination, expected) {
  if (await valid(destination, expected)) return true;
  try {
    await stat(destination);
    throw new DownloadError(`已有模型校验不匹配，请保留并手动移走后再试：${path.basename(destination)}`, 'CHECKSUM_MISMATCH');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

function classify(error) {
  if (error instanceof DownloadError) return error;
  let current = error;
  let code;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    if (typeof current.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(current.code)) code = current.code;
  }
  code ||= error?.name === 'TimeoutError' ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_NETWORK_ERROR';
  if (['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(code)) return new DownloadError(`写入模型失败（${code}），请检查磁盘空间和目录权限。已有文件已保留。`, code);
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return new DownloadError(`TLS 证书校验失败（${code}）。请检查系统受信任证书及代理证书，保留 TLS 校验。`, code);
  return new DownloadError(`下载连接失败（${code}）。已保留分片，可重试、选择其他 HTTPS 端点或手动导入。`, code, true);
}

export function describeDownloadError(error) { return classify(error).message; }

export function normalizeEndpoint(value = 'https://huggingface.co') {
  let url;
  try { url = new URL(value); } catch { throw new Error('下载端点必须是有效的 HTTPS 站点地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('下载端点必须是 HTTPS 站点根地址，且不能包含凭据、查询参数或片段。');
  return url.origin;
}

export function parseModelArgs(args) {
  const options = { comfyDir: null, endpoint: process.env.HF_ENDPOINT || 'https://huggingface.co', fromDir: null, dryRun: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--endpoint' || arg === '--from-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('下载端点或导入目录参数缺少取值。');
      options[arg === '--endpoint' ? 'endpoint' : 'fromDir'] = value;
    } else if (arg.startsWith('--') || options.comfyDir) throw new Error('参数无效，请使用 --help 查看模型下载命令。');
    else options.comfyDir = arg;
  }
  options.endpoint = normalizeEndpoint(options.endpoint);
  return options;
}

export async function downloadVerified(url, destination, expected, request = fetch, {
  attempts = 3, delayMs = 1500, report = console.log,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('下载尝试次数必须在 1–10 之间。');
  await mkdir(path.dirname(destination), { recursive: true });
  if (await alreadyInstalled(destination, expected)) return 'already verified';
  const partial = `${destination}.part`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let offset = 0;
      try { offset = (await stat(partial)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (offset === expected.size && await valid(partial, expected)) { await rename(partial, destination); return 'verified partial'; }
      if (offset >= expected.size) { await rm(partial); offset = 0; }
      report(`${path.basename(destination)}：第 ${attempt}/${attempts} 次下载，从 ${(offset / 1e6).toFixed(1)} MB 继续。`);
      const response = await request(url, { headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: AbortSignal.timeout(4 * 60 * 60_000) });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new DownloadError(`模型下载返回 HTTP ${response.status}。请检查该端点及模型文件访问情况。`, `HTTP_${response.status}`, [408, 429, 500, 502, 503, 504].includes(response.status));
      }
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= expected.size || Number(range[3]) !== expected.size) {
          await response.body.cancel();
          throw new DownloadError('断点续传响应无效，已有分片已保留。请检查下载端点。', 'INVALID_RANGE');
        }
      } else if (response.status === 200) offset = 0;
      else { await response.body.cancel(); throw new DownloadError('下载端点返回了不支持的响应。', 'INVALID_RESPONSE'); }
      let received = offset;
      let nextReport = Math.floor(received / expected.size * 10) + 1;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > expected.size) return callback(new DownloadError('下载内容超过模型清单中的预期大小。', 'INVALID_SIZE'));
        if (received / expected.size * 10 >= nextReport) { report(`${path.basename(destination)}: ${Math.floor(received / expected.size * 100)}%`); nextReport = Math.floor(received / expected.size * 10) + 1; }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
      if (received < expected.size) throw new DownloadError('模型内容尚未传完，分片已保留。', 'INCOMPLETE_DOWNLOAD', true);
      if (!await valid(partial, expected)) { await rm(partial); throw new DownloadError('模型 SHA-256 或大小校验失败。未校验通过的下载已删除，请核对来源。', 'CHECKSUM_MISMATCH'); }
      await rename(partial, destination);
      return 'downloaded and SHA-256 verified';
    } catch (error) {
      const failure = classify(error);
      if (!failure.retryable || attempt === attempts) throw failure;
      report(`${failure.message} 即将尝试断点续传。`);
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export async function importVerified(source, destination, expected) {
  await mkdir(path.dirname(destination), { recursive: true });
  if (await alreadyInstalled(destination, expected)) return 'already verified';
  if (!await valid(source, expected)) throw new DownloadError(`导入模型的大小或 SHA-256 不匹配：${path.basename(source)}。原文件已保留。`, 'CHECKSUM_MISMATCH');
  const temporary = `${destination}.import-${randomUUID()}.part`;
  try {
    await copyFile(source, temporary);
    if (!await valid(temporary, expected)) throw new DownloadError('模型副本 SHA-256 校验失败，原文件与旧分片已保留。', 'CHECKSUM_MISMATCH');
    await rename(temporary, destination);
    await rm(`${destination}.part`, { force: true });
    return 'imported and SHA-256 verified';
  } finally { await rm(temporary, { force: true }); }
}

async function main() {
  const { comfyDir, endpoint, fromDir, dryRun, help } = parseModelArgs(process.argv.slice(2));
  if (help) { console.log('Usage: npm run models:download -- "C:/AI/ComfyUI" [--endpoint https://huggingface.co] [--from-dir "C:/Downloads/Wan"] [--dry-run]'); return; }
  if (!comfyDir || !(await stat(path.join(comfyDir, 'main.py')).catch(() => null))?.isFile()) throw new Error('请选择包含 main.py 的 ComfyUI 目录。');
  const manifest = JSON.parse(await readFile(new URL('../local/models.json', import.meta.url), 'utf8'));
  console.log(`公开 Wan 2.1 模型共 ${(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9).toFixed(2)} GB。请至少保留 25 GB 空间。`);
  if (dryRun) { manifest.files.forEach(file => console.log(`${file.path}  ${file.sha256}`)); return; }
  console.log(fromDir ? '导入本地模型，不发起下载请求。' : `下载端点：${new URL(endpoint).hostname}；固定版本与 SHA-256 校验保持不变。`);
  const dispatcher = fromDir ? null : new EnvHttpProxyAgent({ connectTimeout: 30000, headersTimeout: 120000, bodyTimeout: 120000 });
  try {
    for (const file of manifest.files) {
      const destination = path.join(comfyDir, 'models', file.path);
      let result;
      if (fromDir) {
        let source = path.join(fromDir, file.path);
        if (!(await stat(source).catch(() => null))?.isFile()) source = path.join(fromDir, path.basename(file.path));
        result = await importVerified(source, destination, file);
      } else {
        const url = `${endpoint}/${manifest.repo}/resolve/${manifest.revision}/split_files/${file.path}`;
        result = await downloadVerified(url, destination, file, (address, options) => fetch(address, { ...options, dispatcher }));
      }
      console.log(`${file.path}: ${result}`);
    }
  } finally { await dispatcher?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof DownloadError ? describeDownloadError(error) : error.message); process.exitCode = 1; });
}
