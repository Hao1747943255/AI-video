import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadVerified, importVerified, describeDownloadError, normalizeEndpoint, parseModelArgs } from '../scripts/download-models.mjs';

const quiet = { delayMs: 0, report() {} };
function expectedFor(bytes) { return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frame-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, destination: path.join(directory, 'model.safetensors') };
}

test('network reset preserves the existing partial and retries with the correct Range', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.from('complete verified model content');
  await writeFile(`${destination}.part`, bytes.subarray(0, 8));
  let calls = 0;
  await downloadVerified('https://example.test/file', destination, expectedFor(bytes), async (_url, options) => {
    calls++;
    assert.equal(options.headers.Range, 'bytes=8-');
    if (calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private proxy details'), { code: 'ECONNRESET' }) });
    return new Response(bytes.subarray(8), { status: 206, headers: { 'Content-Range': `bytes 8-${bytes.length - 1}/${bytes.length}` } });
  }, quiet);
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(destination), bytes);
});

test('a short response is retained and the next attempt resumes its received bytes', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.from('segmented download content');
  let calls = 0;
  await downloadVerified('https://example.test/file', destination, expectedFor(bytes), async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(bytes.subarray(0, 7));
    assert.equal(options.headers.Range, 'bytes=7-');
    return new Response(bytes.subarray(7), { status: 206, headers: { 'Content-Range': `bytes 7-${bytes.length - 1}/${bytes.length}` } });
  }, quiet);
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(destination), bytes);
});

test('connection loss during a response body resumes bytes already written to disk', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.alloc(4096, 0x51);
  let calls = 0;
  await downloadVerified('https://example.test/file', destination, expectedFor(bytes), async (_url, options) => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2048));
      void (async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await stat(`${destination}.part`).catch(() => null))?.size === 2048) break;
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        controller.error(Object.assign(new Error('connection interrupted'), { code: 'ECONNRESET' }));
      })();
    } }));
    assert.equal(options.headers.Range, 'bytes=2048-');
    return new Response(bytes.subarray(2048), { status: 206, headers: { 'Content-Range': 'bytes 2048-4095/4096' } });
  }, quiet);
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(destination), bytes);
});

test('temporary HTTP failures retry, while authentication failures stop immediately', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.from('model');
  let calls = 0;
  await downloadVerified('https://example.test/file', destination, expectedFor(bytes), async () => {
    calls++;
    return calls === 1 ? new Response('unavailable', { status: 503 }) : new Response(bytes);
  }, quiet);
  assert.equal(calls, 2);
  let deniedCalls = 0;
  await assert.rejects(downloadVerified('https://example.test/file', `${destination}-denied`, expectedFor(bytes), async () => {
    deniedCalls++; return new Response('denied', { status: 403 });
  }, quiet), /HTTP 403/);
  assert.equal(deniedCalls, 1);
});

test('invalid Range responses preserve partial data and do not retry blindly', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.from('expected model');
  const partial = bytes.subarray(0, 4);
  await writeFile(`${destination}.part`, partial);
  let calls = 0;
  await assert.rejects(downloadVerified('https://example.test/file', destination, expectedFor(bytes), async () => {
    calls++;
    return new Response(bytes.subarray(4), { status: 206, headers: { 'Content-Range': 'bytes 0-9/9999' } });
  }, quiet), /断点续传响应无效/);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(`${destination}.part`), partial);
});

test('retry limit preserves partial content and reports a sanitized underlying error code', async t => {
  const { destination } = await fixture(t);
  const bytes = Buffer.from('correct content');
  await writeFile(`${destination}.part`, bytes.subarray(0, 3));
  let calls = 0;
  const error = new TypeError('https://user:password@example.test/?token=secret', { cause: Object.assign(new Error('private details'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  await assert.rejects(downloadVerified('https://example.test/file', destination, expectedFor(bytes), async () => { calls++; throw error; }, quiet), /UND_ERR_CONNECT_TIMEOUT/);
  assert.equal(calls, 3);
  assert.deepEqual(await readFile(`${destination}.part`), bytes.subarray(0, 3));
  const message = describeDownloadError(error);
  assert.doesNotMatch(message, /password|secret|private/);
  assert.match(describeDownloadError(Object.assign(new Error('sensitive detail'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), /TLS/);
});

test('offline import verifies a complete file, preserves its source and rejects existing mismatched files', async t => {
  const { directory, destination } = await fixture(t);
  const bytes = Buffer.from('offline complete model');
  const source = path.join(directory, 'source.safetensors');
  await writeFile(source, bytes);
  await writeFile(`${destination}.part`, bytes.subarray(0, 2));
  assert.equal(await importVerified(source, destination, expectedFor(bytes)), 'imported and SHA-256 verified');
  assert.deepEqual(await readFile(source), bytes);
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(readFile(`${destination}.part`));
  await writeFile(destination, 'existing different model');
  await assert.rejects(importVerified(source, destination, expectedFor(bytes)), /已有模型校验不匹配/);
  assert.equal(await readFile(destination, 'utf8'), 'existing different model');
});

test('model source options accept explicit HTTPS mirrors and local imports without leaking credentials', () => {
  const args = parseModelArgs(['--endpoint', 'https://hf-mirror.com/', 'D:/Comfy UI', '--from-dir', 'D:/Downloads/Wan', '--dry-run']);
  assert.equal(args.comfyDir, 'D:/Comfy UI');
  assert.equal(args.endpoint, 'https://hf-mirror.com');
  assert.equal(args.fromDir, 'D:/Downloads/Wan');
  assert.equal(args.dryRun, true);
  for (const url of ['http://example.test', 'https://user:password@example.test', 'https://example.test/?token=secret', 'https://example.test/path']) assert.throws(() => normalizeEndpoint(url), /HTTPS/);
  assert.throws(() => parseModelArgs(['D:/ComfyUI', '--endpoint']), /缺少/);
  assert.throws(() => parseModelArgs(['D:/ComfyUI', '--unknown']), /参数无效/);
});
