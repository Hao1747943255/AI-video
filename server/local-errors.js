const refusedCodes = new Set(['ECONNREFUSED']);
const interruptedCodes = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const connectionCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const allowedCodes = new Set([...refusedCodes, ...interruptedCodes, ...timeoutCodes, ...connectionCodes]);

function read(value, key) {
  try { return value[key]; } catch { return undefined; }
}

function transportFailure(cause) {
  const queue = [{ value: cause, depth: 0 }];
  const seen = new Set();
  // Native fetch errors may wrap an AggregateError. Never traverse an unbounded
  // error graph or stringify an upstream error, URL, stack or response body.
  for (let visited = 0; queue.length && visited < 16; visited++) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const code = read(value, 'code');
    if (allowedCodes.has(code)) return code;
    if (['TimeoutError', 'AbortError'].includes(read(value, 'name'))) return 'TIMEOUT';
    if (depth >= 4) continue;
    queue.push({ value: read(value, 'cause'), depth: depth + 1 });
    const errors = read(value, 'errors');
    if (Array.isArray(errors)) {
      for (let index = 0; index < Math.min(errors.length, 6); index++) {
        queue.push({ value: read(errors, index), depth: depth + 1 });
      }
    }
  }
  return undefined;
}

function requestStage(endpoint) {
  const stages = {
    '/api/tags': '检查语言模型',
    '/api/chat': '润色提示词',
    '/object_info': '检查视频节点与模型',
    '/prompt': '提交生成任务',
    '/free': '释放模型缓存',
  };
  if (typeof endpoint !== 'string') return '请求本机服务';
  if (Object.hasOwn(stages, endpoint)) return stages[endpoint];
  if (/^\/history\/[^/?#]+(?:[?#].*)?$/.test(endpoint)) return '查询生成进度';
  if (/^\/view(?:\?|$)/.test(endpoint)) return '下载生成视频';
  return '请求本机服务';
}

export function localRequestError({ service = 'ComfyUI', endpoint, method = 'GET', timeout, cause, status } = {}) {
  const target = service === 'Ollama' ? 'Ollama' : 'ComfyUI';
  const stage = requestStage(endpoint);
  const verb = method === 'POST' ? 'POST' : 'GET';
  const context = `${verb} · ${stage}`;
  let category;
  let code;
  let message;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    category = 'http';
    code = `HTTP_${status}`;
    if (target === 'ComfyUI' && endpoint === '/prompt' && status === 400) {
      message = `ComfyUI 拒绝了工作流（HTTP 400，${context}）。请查看 ComfyUI 控制台中的节点参数校验错误。`;
    } else if (status >= 500) {
      message = `本机 ${target} 返回服务错误（HTTP ${status}，${context}）。请查看 ${target} 控制台中的具体错误。`;
    } else {
      message = `本机 ${target} 返回 HTTP ${status}（${context}），请求未成功。请检查服务版本、配置与控制台输出。`;
    }
  } else {
    code = transportFailure(cause);
    const detail = code ? `${code}，${context}` : context;
    const exitedHint = `请查看 ${target} 控制台；若终端已回到 PowerShell 提示符，请先查看该进程的退出码。`;
    if (refusedCodes.has(code)) {
      category = 'refused';
      message = `本机 ${target} 连接被拒绝（${detail}）。请确认服务仍在运行。${exitedHint}`;
    } else if (interruptedCodes.has(code)) {
      category = 'interrupted';
      message = `本机 ${target} 连接中断（${detail}）。${exitedHint}`;
    } else if (code === 'TIMEOUT' || timeoutCodes.has(code)) {
      category = 'timeout';
      const seconds = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 && timeout <= 86_400_000
        ? `，${Math.ceil(timeout / 1000)} 秒` : '';
      message = `本机 ${target} 请求超时（${detail}${seconds}）。服务可能仍在处理，请先查看控制台，避免重复提交生成任务。`;
    } else {
      category = 'connection';
      message = `请求本机 ${target} 失败（${detail}）。请检查本机服务地址与控制台输出。`;
    }
  }
  // Do not attach the original cause: callers may serialize this error.
  const error = new Error(message);
  error.category = category;
  if (code) error.code = code;
  return error;
}
