import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SESSIONS = 20;
const MAX_TURNS = 30;
const CONTEXT_BUDGET = 2400;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const jobPattern = /^[a-zA-Z0-9_-]{1,96}$/;
const turnStatuses = ['suggestion', 'submitted', 'completed', 'failed'];
const settingsFields = ['provider', 'ratio', 'style', 'seconds', 'durationMode', 'templateId', 'templateName', 'referenceAspects'];
const aspects = ['scene', 'characters', 'objects', 'style', 'camera', 'actions'];
const fault = (message, status = 400) => Object.assign(new Error(message), { status, framePublic: true });
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function fields(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('记忆参数格式无效，包含不支持的字段。');
}
function text(value, min, max, label) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fault(`${label}格式无效。`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw fault(`${label}需为 ${min}–${max} 个字符。`);
  return result;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw fault('记忆版本无效，请检查本机记忆文件。');
  return value;
}
function settings(value) {
  if (value === undefined) return undefined;
  fields(value, settingsFields);
  const result = {};
  for (const key of settingsFields) {
    const item = value[key];
    if (item === undefined) continue;
    if (key === 'provider' && !['comfyui', 'demo', 'sora'].includes(item) ||
        key === 'ratio' && !['16:9', '9:16'].includes(item) ||
        key === 'style' && !['cinematic', 'nature', 'dreamy', 'urban'].includes(item) ||
        key === 'seconds' && (!Number.isInteger(item) || item < 2 || item > 60) ||
        key === 'durationMode' && !['manual', 'prompt'].includes(item)) throw fault('记忆中的创作参数无效。');
    if (key === 'templateId' && item !== null && item !== '' && (typeof item !== 'string' || !uuidPattern.test(item))) throw fault('记忆中的模板编号无效。');
    if (key === 'templateName') result[key] = text(item, 0, 120, '模板名称');
    else if (key === 'referenceAspects') {
      if (!Array.isArray(item) || item.length > 6 || new Set(item).size !== item.length || item.some(name => !aspects.includes(name))) throw fault('记忆中的模板参考要点无效。');
      result[key] = [...item];
    } else result[key] = item;
  }
  return result;
}
function validTime(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function cleanTurn(value, persisted = false) {
  fields(value, ['kind', 'input', 'prompt', 'settings', 'jobId', 'status', ...(persisted ? ['id', 'createdAt'] : [])]);
  if (!['enhance', 'generate'].includes(value.kind)) throw fault('记忆记录类型无效。');
  const result = { id: persisted ? value.id : randomUUID(), kind: value.kind,
    input: text(value.input, 2, 2000, '用户描述'), prompt: text(value.prompt, 10, 2000, '完整画面描述'),
    status: value.status ?? (value.kind === 'enhance' ? 'suggestion' : 'submitted'), createdAt: persisted ? value.createdAt : now() };
  if (!uuidPattern.test(result.id) || !validTime(result.createdAt) || !turnStatuses.includes(result.status)) throw fault('记忆记录内容无效。');
  const cleanSettings = settings(value.settings);
  if (cleanSettings !== undefined) result.settings = cleanSettings;
  if (value.jobId !== undefined) {
    if (typeof value.jobId !== 'string' || !jobPattern.test(value.jobId)) throw fault('记忆中的任务编号无效。');
    result.jobId = value.jobId;
  }
  return result;
}
function newSession(title = '新创作会话') {
  const timestamp = now();
  return { id: randomUUID(), title: text(title, 1, 60, '会话名称').replace(/\s+/g, ' '), revision: 0,
    turns: [], createdAt: timestamp, updatedAt: timestamp };
}
function validateSaved(value) {
  fields(value, ['schemaVersion', 'enabled', 'preferences', 'revision', 'sessions']);
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.sessions) || value.sessions.length < 1 || value.sessions.length > MAX_SESSIONS) throw fault('记忆文件格式无效。');
  const saved = { schemaVersion: 1, enabled: value.enabled, preferences: text(value.preferences, 0, 1000, '长期偏好'), revision: revision(value.revision), sessions: [] };
  const ids = new Set();
  for (const session of value.sessions) {
    fields(session, ['id', 'title', 'revision', 'turns', 'createdAt', 'updatedAt']);
    if (typeof session.id !== 'string' || !uuidPattern.test(session.id) || ids.has(session.id) || !validTime(session.createdAt) || !validTime(session.updatedAt) || !Array.isArray(session.turns) || session.turns.length > MAX_TURNS) throw fault('记忆文件中的会话无效。');
    ids.add(session.id);
    const turns = session.turns.map(turn => cleanTurn(turn, true));
    if (new Set(turns.map(turn => turn.id)).size !== turns.length) throw fault('记忆记录编号重复。');
    saved.sessions.push({ id: session.id, title: text(session.title, 1, 60, '会话名称'), revision: revision(session.revision),
      turns, createdAt: session.createdAt, updatedAt: session.updatedAt });
  }
  return saved;
}
function lastSettings(session) {
  const turn = session.turns.findLast(item => item.settings && Object.keys(item.settings).length);
  return turn ? copy(turn.settings) : undefined;
}

export function createMemoryStore({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw fault('本机记忆存储位置尚未配置。', 500);
  const file = path.join(path.resolve(dataDir), 'memory.json');
  try { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
  catch { throw fault('无法访问本机记忆目录，请检查目录权限。', 503); }
  const persist = next => {
    const temporary = path.join(path.dirname(file), `.memory-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      try { rmSync(temporary, { force: true }); } catch {}
      throw fault('无法保存本机记忆，现有记忆已保留；请检查可用空间和目录权限。', 503);
    }
  };
  let data;
  if (existsSync(file)) {
    try {
      if (statSync(file).size > 16 * 1024 * 1024) throw new Error();
      data = validateSaved(JSON.parse(readFileSync(file, 'utf8')));
    } catch { throw fault('本机记忆文件损坏或格式不兼容，原文件已保留，请先备份并检查。', 503); }
  } else {
    data = { schemaVersion: 1, enabled: true, preferences: '', revision: 0, sessions: [newSession()] };
    persist(data);
  }
  const find = (id, source = data, status = 404) => {
    if (typeof id !== 'string' || !uuidPattern.test(id)) throw fault('创作会话不存在或已被删除。', status);
    const session = source.sessions.find(item => item.id === id);
    if (!session) throw fault('创作会话不存在或已被删除。', status);
    return session;
  };
  const commit = mutate => {
    const next = copy(data);
    const result = mutate(next);
    persist(next); data = next;
    return copy(result);
  };
  const touch = session => { session.updatedAt = new Date(Math.max(Date.now(), Date.parse(session.updatedAt) + 1)).toISOString(); };
  const bump = session => { session.revision = revision(session.revision + 1); touch(session); };
  const state = () => ({ enabled: data.enabled, preferences: data.preferences, revision: data.revision,
    sessions: data.sessions.map(session => ({ id: session.id, title: session.title, revision: session.revision,
      createdAt: session.createdAt, updatedAt: session.updatedAt, turnCount: session.turns.length,
      ...(lastSettings(session) ? { lastSettings: lastSettings(session) } : {}) })) });
  const assertStamp = (id, stamp) => {
    const session = find(id, data, 409);
    if (!data.enabled || !record(stamp) || stamp.global !== data.revision || stamp.session !== session.revision) {
      throw fault('会话记忆已变化或停用，本次旧上下文结果未写入，请重新尝试。', 409);
    }
    return session;
  };

  return {
    state: () => copy(state()),
    getSession: id => copy(find(id)),
    createSession(value = {}) {
      fields(value, ['title']);
      if (data.sessions.length >= MAX_SESSIONS) throw fault('最多保存 20 个创作会话，请先删除不需要的会话。', 409);
      const session = newSession(value.title ?? `创作会话 ${data.sessions.length + 1}`);
      return commit(next => { next.sessions.unshift(session); return session; });
    },
    updateSession(id, value) {
      fields(value, ['title']);
      const title = text(value.title, 1, 60, '会话名称').replace(/\s+/g, ' ');
      const current = find(id);
      if (current.title === title) return copy(current);
      return commit(next => { const session = find(id, next); session.title = title; bump(session); return session; });
    },
    deleteSession(id) {
      find(id);
      commit(next => { next.sessions = next.sessions.filter(session => session.id !== id); if (!next.sessions.length) next.sessions.push(newSession()); });
      return copy(state());
    },
    clearSession(id) {
      find(id);
      return commit(next => { const session = find(id, next); session.turns = []; bump(session); return session; });
    },
    updateSettings(value) {
      fields(value, ['enabled', 'preferences']);
      if (!Object.keys(value).length) throw fault('请提供需要修改的记忆设置。');
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw fault('记忆开关必须为布尔值。');
      const enabled = value.enabled ?? data.enabled;
      const preferences = value.preferences === undefined ? data.preferences : text(value.preferences, 0, 1000, '长期偏好');
      if (enabled !== data.enabled || preferences !== data.preferences) {
        commit(next => { next.enabled = enabled; next.preferences = preferences; next.revision = revision(next.revision + 1); });
      }
      return copy(state());
    },
    clearAll() {
      commit(next => { next.preferences = ''; next.sessions = [newSession()]; next.revision = revision(next.revision + 1); });
      return copy(state());
    },
    context(id) {
      const session = find(id);
      const result = { sessionId: id, title: session.title, enabled: data.enabled,
        stamp: { global: data.revision, session: session.revision }, preferences: '', recentTurns: [], hasContext: false, truncated: false };
      if (!data.enabled) return result;
      let remaining = CONTEXT_BUDGET;
      const turns = session.turns.slice(-4);
      const newest = turns.at(-1);
      const selected = [];
      const add = (turn, latest = false) => {
        if (remaining < 12) return;
        const inputLimit = latest ? Math.min(turn.input.length, 200, Math.max(2, remaining - turn.prompt.length)) :
          Math.min(turn.input.length, 200, Math.max(2, Math.min(Math.floor(remaining / 3), remaining - 10)));
        const input = turn.input.slice(0, inputLimit);
        const promptLimit = Math.min(turn.prompt.length, latest ? 2000 : 400, remaining - input.length);
        const prompt = turn.prompt.slice(0, promptLimit);
        const truncated = input.length !== turn.input.length || prompt.length !== turn.prompt.length;
        selected.push({ kind: turn.kind, input, prompt, ...(turn.settings ? { settings: copy(turn.settings) } : {}), ...(truncated ? { truncated: true } : {}) });
        remaining -= input.length + prompt.length;
        if (truncated) result.truncated = true;
      };
      if (newest) add(newest, true);
      result.preferences = data.preferences.slice(0, remaining);
      remaining -= result.preferences.length;
      if (result.preferences.length !== data.preferences.length) result.truncated = true;
      for (let index = turns.length - 2; index >= 0; index--) add(turns[index]);
      result.recentTurns = selected.reverse();
      if (selected.length < session.turns.length) result.truncated = true;
      const savedSettings = lastSettings(session);
      if (savedSettings) result.lastSettings = savedSettings;
      result.hasContext = Boolean(result.preferences || result.recentTurns.length);
      return copy(result);
    },
    appendTurn(id, value, stamp) {
      assertStamp(id, stamp);
      const turn = cleanTurn(value);
      return commit(next => {
        const session = find(id, next); session.turns.push(turn); session.turns = session.turns.slice(-MAX_TURNS); bump(session);
        return turn;
      });
    },
    deleteTurn(id, turnId) {
      const current = find(id);
      if (typeof turnId !== 'string' || !uuidPattern.test(turnId) || !current.turns.some(turn => turn.id === turnId)) throw fault('该记忆记录不存在或已被清除。', 404);
      return commit(next => { const session = find(id, next); session.turns = session.turns.filter(turn => turn.id !== turnId); bump(session); return session; });
    },
    updateJob(jobId, status) {
      if (!jobId) return false;
      if (typeof jobId !== 'string' || !jobPattern.test(jobId) || !['submitted', 'completed', 'failed'].includes(status)) throw fault('记忆任务状态无效。');
      if (!data.sessions.some(session => session.turns.some(turn => turn.jobId === jobId && turn.status !== status))) return false;
      commit(next => {
        for (const session of next.sessions) {
          let changed = false;
          for (const turn of session.turns) {
            if (turn.jobId === jobId && turn.status !== status) { turn.status = status; changed = true; }
          }
          if (changed) touch(session);
        }
      });
      return true;
    },
  };
}
