import test from 'node:test';
import assert from 'node:assert/strict';
import { localRequestError } from '../server/local-errors.js';

test('local request errors distinguish connection refusal and interruption from timeouts', () => {
  for (const [code, category, text] of [
    ['ECONNREFUSED', 'refused', '连接被拒绝'],
    ['ECONNRESET', 'interrupted', '连接中断'],
    ['UND_ERR_SOCKET', 'interrupted', '连接中断'],
    ['EPIPE', 'interrupted', '连接中断'],
    ['ETIMEDOUT', 'timeout', '请求超时'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', '请求超时'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout', '请求超时'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout', '请求超时'],
    ['ENOTFOUND', 'connection', '失败'],
  ]) {
    const error = localRequestError({ endpoint: '/history/job-123', timeout: 10_000, cause: { code } });
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(text));
    assert.match(error.message, /查询生成进度/);
    if (category === 'timeout') {
      assert.match(error.message, /10 秒/);
      assert.match(error.message, /可能仍在处理/);
      assert.match(error.message, /避免重复提交/);
      assert.doesNotMatch(error.message, /进程已退出|显存不足/);
    }
    if (category === 'refused' || category === 'interrupted') assert.match(error.message, /退出码/);
  }
});

test('nested native fetch and AggregateError causes retain only known diagnostic codes', () => {
  const cause = new TypeError('fetch failed', {
    cause: new AggregateError([
      new Error('unrecognized transport detail'),
      Object.assign(new Error('private address and headers'), { cause: { code: 'ECONNREFUSED' } }),
    ]),
  });
  const error = localRequestError({ service: 'Ollama', endpoint: '/api/tags', cause });
  assert.equal(error.code, 'ECONNREFUSED');
  assert.match(error.message, /Ollama/);
  assert.match(error.message, /检查语言模型/);
  assert.equal(error.cause, undefined);
  for (const name of ['TimeoutError', 'AbortError']) {
    const timeout = localRequestError({ endpoint: '/api/chat', cause: { name } });
    assert.equal(timeout.category, 'timeout');
    assert.match(timeout.message, /润色提示词/);
  }
});

test('HTTP workflow rejection and server failures report status without being mislabeled as disconnected', () => {
  const rejected = localRequestError({ endpoint: '/prompt', method: 'POST', status: 400, cause: { code: 'ECONNREFUSED' } });
  assert.equal(rejected.category, 'http');
  assert.equal(rejected.code, 'HTTP_400');
  assert.match(rejected.message, /拒绝了工作流/);
  assert.match(rejected.message, /POST · 提交生成任务/);
  assert.doesNotMatch(rejected.message, /无法连接|连接被拒绝/);
  const failed = localRequestError({ endpoint: '/object_info', status: 500 });
  assert.match(failed.message, /HTTP 500/);
  assert.match(failed.message, /控制台/);
  assert.match(failed.message, /检查视频节点与模型/);
  assert.match(localRequestError({ endpoint: '/object_info', status: 404 }).message, /HTTP 404/);
});

test('local error diagnostics never reflect secrets from unknown error fields, routes or service names', () => {
  const secret = 'SENSITIVE_TOKEN_private-path';
  const error = localRequestError({
    service: `https://user:${secret}@example.test`,
    endpoint: `https://example.test/${secret}?token=${secret}`,
    method: secret, timeout: secret,
    cause: { code: secret, name: secret, message: secret, stack: secret, body: secret, cause: { code: 'ECONNRESET' } },
  });
  assert.match(error.message, /ComfyUI/);
  assert.match(error.message, /ECONNRESET/);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  assert.equal(error.cause, undefined);
  const download = localRequestError({ endpoint: `/view?filename=${secret}&token=${secret}`, status: 500 });
  assert.match(download.message, /下载生成视频/);
  assert.doesNotMatch(download.message, new RegExp(secret));
  const history = localRequestError({ endpoint: `/history/${secret}`, cause: { name: 'TimeoutError' } });
  assert.match(history.message, /查询生成进度/);
  assert.doesNotMatch(history.message, new RegExp(secret));
  assert.match(localRequestError({ endpoint: '/free' }).message, /释放模型缓存/);
});

test('cause inspection is bounded for cycles, deep nesting and wide aggregate errors', () => {
  const cyclic = {};
  cyclic.cause = cyclic;
  assert.equal(localRequestError({ cause: cyclic }).category, 'connection');
  let deep = { code: 'ECONNREFUSED' };
  for (let index = 0; index < 20; index++) deep = { cause: deep };
  assert.equal(localRequestError({ cause: deep }).category, 'connection');
  const wide = { errors: [...Array(100).fill({}), { code: 'ECONNREFUSED' }] };
  assert.equal(localRequestError({ cause: wide }).category, 'connection');
  const hostile = {};
  for (const key of ['code', 'name', 'cause', 'errors']) {
    Object.defineProperty(hostile, key, { get() { throw new Error('secret getter'); } });
  }
  assert.equal(localRequestError({ cause: hostile }).category, 'connection');
});
