import React, { useEffect, useRef, useState } from 'react';
import { Brain, Check, LoaderCircle, Plus, RotateCcw, Settings2, Trash2 } from 'lucide-react';

const safeDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未记录' : new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
};
const recordLabel = turn => turn.kind === 'enhance' ? '润色建议' : ({
  submitted: '生成请求已提交', completed: '生成任务已完成', failed: '生成任务失败',
}[turn.status] || '生成请求');
const settingsText = settings => {
  if (!settings) return '';
  const mode = { comfyui: '本地 Wan', demo: '演示样片', sora: 'Sora 2' }[settings.provider];
  const style = { cinematic: '电影质感', nature: '自然纪实', dreamy: '梦幻氛围', urban: '都市夜景' }[settings.style];
  return [mode, style, settings.ratio, typeof settings.seconds === 'number' ? `${settings.seconds} 秒` : '',
    settings.templateName ? `模板：${settings.templateName}` : ''].filter(Boolean).join(' · ');
};

export function MemoryControls({ state, activeId, onSelect, onSettings, onManage, onCreate, disabled, previewOnly }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocked = disabled || busy || previewOnly || !state;
  const invoke = async operation => {
    if (blocked) return;
    setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { setError(failure.message || '记忆设置暂时无法保存。'); }
    finally { setBusy(false); }
  };
  return <section className="memory-controls" aria-label="上下文记忆设置">
    <div className="memory-controls-heading"><label className="memory-switch"><input type="checkbox" aria-label="使用上下文记忆" checked={Boolean(state?.enabled)} disabled={blocked} onChange={event => invoke(() => onSettings({ enabled: event.target.checked }))} /><Brain size={14} /><span>使用上下文记忆</span></label><button type="button" className="text-button" onClick={onManage}><Settings2 size={12} />管理记忆</button></div>
    <div className="memory-context-picker"><select aria-label="当前创作会话" value={activeId || ''} disabled={blocked} onChange={event => invoke(() => onSelect(event.target.value))}>{!state?.sessions?.length && <option value="">{previewOnly ? '预览不读取本机记忆' : '正在读取会话…'}</option>}{state?.sessions?.map(session => <option key={session.id} value={session.id}>{session.title} · {session.turnCount} 条</option>)}</select><button type="button" className="text-button" disabled={blocked} onClick={() => invoke(onCreate)}><Plus size={13} />新会话</button></div>
    <p>{previewOnly ? '记忆保存在运行完整服务的本机，独立预览不读取或保存记忆。' : state?.enabled ? '可继续说“把背景换成夜景”，沿用当前会话的主体与场景。新主题请新建会话。' : '已关闭自动记忆：润色和生成不读取或新增会话记录，已有内容仍可管理。'}</p>
    {busy && <span className="memory-inline-status" role="status"><LoaderCircle size={12} className="spin" />正在更新记忆设置…</span>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

export default function MemoryPanel({ api, state, activeId, onSelect, onCreate, onState, onMutateContext, previewOnly }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preferences, setPreferences] = useState(state?.preferences || '');
  const preferencesDirty = useRef(false);
  const [title, setTitle] = useState('');
  const titleDirty = useRef(false);
  const titleSession = useRef('');
  const requestVersion = useRef(0);
  const [confirmation, setConfirmation] = useState(null);
  const meta = state?.sessions?.find(item => item.id === activeId);
  const visibleSession = session?.id === activeId ? session : null;
  const blocked = Boolean(busy) || previewOnly || !state;

  useEffect(() => {
    if (!preferencesDirty.current) setPreferences(state?.preferences || '');
  }, [state?.preferences]);

  useEffect(() => {
    let alive = true;
    const version = ++requestVersion.current;
    setConfirmation(null); setError('');
    if (titleSession.current !== activeId) {
      titleSession.current = activeId;
      titleDirty.current = false;
      setTitle(meta?.title || '');
      setSession(null);
    }
    if (previewOnly || !activeId || !meta) { setSession(null); setLoading(false); return () => { alive = false; }; }
    setLoading(true);
    api(`/api/memory/sessions/${encodeURIComponent(activeId)}`).then(result => {
      if (!alive || version !== requestVersion.current) return;
      setSession(result);
      if (!titleDirty.current) setTitle(result.title);
    }).catch(failure => {
      if (alive && version === requestVersion.current) setError(failure.message || '无法读取当前会话记忆。');
    }).finally(() => {
      if (alive && version === requestVersion.current) setLoading(false);
    });
    return () => { alive = false; };
  }, [activeId, meta?.revision, meta?.updatedAt, previewOnly, api]);

  const mutate = async (operation, label, after) => {
    if (blocked) return;
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await operation();
      requestVersion.current += 1;
      onMutateContext();
      onState(result.state || result);
      if (result.session?.id === activeId) setSession(result.session);
      if (after) await after(result);
      setConfirmation(null); setNotice(label.replace(/^正在/, '').replace(/…$/, '') + '完成');
    } catch (failure) { setError(failure.message || '记忆操作失败，请稍后重试。'); }
    finally { setBusy(''); }
  };
  const create = () => mutate(onCreate, '正在新建会话…');
  const select = async id => {
    if (blocked) return;
    setError(''); setNotice('');
    try { await onSelect(id); }
    catch (failure) { setError(failure.message || '无法切换创作会话。'); }
  };
  const confirmAction = () => {
    if (!confirmation || blocked) return;
    const target = `/api/memory/sessions/${encodeURIComponent(confirmation.sessionId || activeId)}`;
    if (confirmation.type === 'all') {
      mutate(() => api('/api/memory', { method: 'DELETE' }), '正在清除全部记忆…', async result => {
        preferencesDirty.current = false; setPreferences(result.preferences || '');
        await onSelect(result.sessions[0].id);
      });
    } else if (confirmation.type === 'clear') {
      mutate(() => api(`${target}/clear`, { method: 'POST', body: '{}' }), '正在清空当前会话记录…');
    } else if (confirmation.type === 'delete') {
      mutate(() => api(target, { method: 'DELETE' }), '正在删除会话…', result => onSelect(result.sessions[0].id));
    } else if (confirmation.type === 'turn') {
      mutate(() => api(`${target}/turns/${encodeURIComponent(confirmation.turnId)}`, { method: 'DELETE' }), '正在删除这条记录…');
    }
  };
  const confirmationText = {
    all: '将清除全部会话记录和已保存的长期偏好，并新建一个空会话。已有作品与已提交任务的描述记录仍保留。',
    clear: '将清空当前会话中的描述与历史。长期偏好仍保留，已有作品与已提交任务不变。',
    delete: '将删除这个创作会话及其历史，已有作品不变。删除最后一个会话时会新建空会话。',
    turn: '将从当前会话中删除这条记忆，后续请求不会再读取它；已有作品和已提交任务不变。',
  };
  const confirmationLabel = { all: '确认清除全部记忆', clear: '确认清空当前会话', delete: '确认删除会话', turn: '确认删除这条记录' };

  return <section className="memory-page">
    <div className="section-heading"><div><h2>创作记忆</h2><p>按会话联系上下文，长期偏好由你编辑和确认。</p></div><button type="button" className="primary-small" disabled={blocked} onClick={create}><Plus size={15} />新建会话</button></div>
    <div className="memory-explanation"><Brain size={19} /><div><strong>描述、创作参数和偏好保存在本机</strong><p>会话彼此分开；模型仅使用当前会话中最近的有限上下文。每个会话最多保留 30 条记录，最多 20 个会话。记忆记录的是你的要求和整理后的描述，并不表示 AI 已观看生成的视频，也不会训练模型权重。</p></div></div>
    <div className="memory-settings panel"><div className="memory-setting-title"><h3>长期创作偏好</h3><label className="memory-switch"><input type="checkbox" aria-label="使用上下文记忆" checked={Boolean(state?.enabled)} disabled={blocked} onChange={event => mutate(() => api('/api/memory', { method: 'PATCH', body: JSON.stringify({ enabled: event.target.checked }) }), '正在更新记忆开关…')} />使用上下文记忆</label></div><p className="mode-hint">适用于所有会话，例如喜欢的风格和表达方式。当前请求中的明确要求优先。</p><textarea aria-label="长期创作偏好" maxLength={1000} value={preferences} disabled={blocked} onChange={event => { setPreferences(event.target.value); preferencesDirty.current = event.target.value !== (state?.preferences || ''); }} placeholder="例如：画面偏写实，优先保持主体与动作，少用夸张运镜。" /><div className="memory-editor-footer"><span>{preferences.length} / 1000{preferencesDirty.current ? ' · 有未保存修改' : ''}</span><button type="button" className="light-button" disabled={blocked || !preferencesDirty.current} onClick={() => mutate(() => api('/api/memory', { method: 'PATCH', body: JSON.stringify({ preferences }) }), '正在保存长期偏好…', result => { preferencesDirty.current = false; setPreferences(result.preferences); })}><Check size={13} />保存长期偏好</button></div></div>
    {busy && <p className="memory-operation" role="status"><LoaderCircle size={15} className="spin" />{busy}</p>}
    {notice && <p className="memory-operation" role="status"><Check size={14} />{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {confirmation && <div className="memory-confirm" role="alertdialog" aria-label="确认清除记忆"><p>{confirmationText[confirmation.type]}</p><div><button type="button" className="light-button" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="primary-small" disabled={Boolean(busy)} onClick={confirmAction}>{confirmationLabel[confirmation.type]}</button></div></div>}
    <div className="memory-layout"><aside className="memory-session-list" aria-label="创作会话列表">{state?.sessions?.map(item => <button type="button" key={item.id} disabled={blocked} className={item.id === activeId ? 'selected' : ''} onClick={() => select(item.id)}><strong>{item.title}</strong><span>{item.turnCount} 条记录 · {safeDate(item.updatedAt)}</span></button>)}{!state?.sessions?.length && <p className="memory-empty">{previewOnly ? '独立预览不读取本机记忆。' : '正在读取创作会话…'}</p>}</aside>
      <div className="memory-session-content panel"><div className="memory-session-heading"><h3>{meta?.title || '当前会话'}</h3>{loading && <span className="memory-inline-status" role="status"><LoaderCircle size={13} className="spin" />读取会话中…</span>}</div>
        {visibleSession && <><div className="memory-title-editor"><label htmlFor="memory-session-title">会话名称</label><div><input id="memory-session-title" aria-label="会话名称" maxLength={60} value={title} disabled={blocked} onChange={event => { setTitle(event.target.value); titleDirty.current = event.target.value !== visibleSession.title; }} /><button type="button" className="light-button" disabled={blocked || !title.trim() || title.trim() === visibleSession.title} onClick={() => mutate(() => api(`/api/memory/sessions/${encodeURIComponent(activeId)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) }), '正在重命名会话…', result => { titleDirty.current = false; setTitle(result.session.title); })}>保存会话名称</button></div></div>
          <div className="memory-session-actions"><button type="button" className="text-button" disabled={blocked || !visibleSession.turns.length} onClick={() => setConfirmation({ type: 'clear', sessionId: activeId })}><RotateCcw size={13} />清空当前会话记录</button><button type="button" className="text-button danger" disabled={blocked} onClick={() => setConfirmation({ type: 'delete', sessionId: activeId })}><Trash2 size={13} />删除会话</button></div>
          {visibleSession.turns.length ? <div className="memory-turns">{[...visibleSession.turns].reverse().map(turn => <details className="memory-turn" key={turn.id}><summary><span>{recordLabel(turn)}</span><strong>{turn.input}</strong><time>{safeDate(turn.createdAt)}</time></summary><div className="memory-turn-body"><h4>本次要求</h4><p>{turn.input}</p><h4>整理后的画面描述</h4><p>{turn.prompt}</p>{settingsText(turn.settings) && <p className="memory-turn-settings">{settingsText(turn.settings)}</p>}<button type="button" className="text-button danger" disabled={blocked} onClick={() => setConfirmation({ type: 'turn', sessionId: activeId, turnId: turn.id })}><Trash2 size={12} />删除这条记录</button></div></details>)}</div> : <p className="memory-empty">这个会话还没有记忆。开启记忆后，成功返回的润色建议和已提交的生成要求会记录在这里。</p>}</>}
        {previewOnly && <p className="memory-empty">记忆管理需要启动完整的本地服务。</p>}
      </div>
    </div>
    <div className="memory-danger-zone"><p>清除记忆会影响之后的上下文，不删除已有作品或已提交任务中的描述快照。</p><button type="button" className="text-button danger" disabled={blocked} onClick={() => setConfirmation({ type: 'all' })}><Trash2 size={13} />清除全部记忆（含偏好）</button></div>
  </section>;
}
