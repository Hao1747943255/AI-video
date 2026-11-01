import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clapperboard, Clock3, Film, FolderOpen, Grid2X2, Layers3,
  LoaderCircle, Monitor, Play, Plus, Search, Settings2,
  ShieldCheck, Smartphone, Sparkles, Trash2, WandSparkles, X, AlertCircle, RotateCcw,
} from 'lucide-react';
import './styles.css';
import TemplateLibrary, { REFERENCE_FIELDS } from './TemplateLibrary.jsx';
import { DURATION_OPTIONS, resolveDuration } from '../shared/duration.js';
import MemoryPanel, { MemoryControls } from './MemoryPanel.jsx';

const STYLES = [
  { id: 'cinematic', name: '电影质感', en: 'CINEMATIC', title: '向海而生', subtitle: '让镜头追随海浪的呼吸', prompt: '一望无际的蓝色海面上，白色浪花缓缓涌动，阳光在水面闪烁。镜头贴近海面向前推进，电影级光影，宁静而辽阔。' },
  { id: 'nature', name: '自然纪实', en: 'NATURE', title: '森林来信', subtitle: '走进晨雾里的绿色秘境', prompt: '清晨的古老森林，薄雾在高耸的树木之间流动，微风轻轻吹动蕨类植物，柔和阳光穿过枝叶，镜头缓慢向前推进。' },
  { id: 'dreamy', name: '梦幻氛围', en: 'DREAMSCAPE', title: '山川入梦', subtitle: '把远方的片刻变成永恒', prompt: '阿尔卑斯山脚下的静谧湖泊，群山倒映在如镜的水面，粉紫色晚霞慢慢流动。镜头从湖面缓缓升起，梦幻、空灵的氛围。' },
  { id: 'urban', name: '都市夜景', en: 'AFTER HOURS', title: '夜色漫游', subtitle: '捕捉城市不眠的另一面', prompt: '夜幕下的都市天际线，楼宇灯光点亮街道，远处的车流化作流动光线。镜头平稳掠过城市，青蓝色调，电影感夜景。' },
];
const STATUS = { queued: '排队中', processing: '生成中', completed: '已完成', failed: '生成失败' };
const providerName = value => ({ demo: '演示样片', sora: 'Sora 2', comfyui: '本地 Wan 2.1' }[value] || value);
const previewOnly = Boolean(window.__FRAME_PREVIEW_ONLY__);
const imageUrl = style => window.__FRAME_PREVIEW_ASSETS__?.[style] || `/images/${style}.jpg`;
const dateText = value => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

async function api(url, options = {}) {
  if (previewOnly) {
    if (url === '/api/config') return { previewOnly: true, soraReady: false, demoReady: true, maxPromptLength: 2000 };
    if (url === '/api/jobs') return [];
    if (url === '/api/templates') return [];
    if (url === '/api/memory') return { enabled: false, preferences: '', revision: 0, sessions: [] };
    if (url.startsWith('/api/local/status')) return {
      language: { ready: false, model: 'qwen3:4b', message: '独立界面预览不连接模型服务。' },
      video: { ready: false, message: '生成视频需要在本机启动完整服务。' },
    };
    throw new Error('这是独立界面预览。生成视频和 AI 润色需要启动完整的本地服务。');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || '暂时无法连接服务，请稍后重试。');
  if (!data) throw new Error('服务返回异常，请检查后端是否启动。');
  return data;
}

function Modal({ title, children, close, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('button')?.focus();
    const handle = event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const items = [...ref.current.querySelectorAll('button, a[href], input, select, textarea, video[controls]')].filter(item => !item.disabled);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handle); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
    <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭弹窗"><X size={20} /></button></div>
      {children}
    </section>
  </div>;
}

function App() {
  const [view, setView] = useState('create');
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState('cinematic');
  const [ratio, setRatio] = useState('16:9');
  const [seconds, setSeconds] = useState(2);
  const [provider, setProvider] = useState('comfyui');
  const [durationMode, setDurationMode] = useState('manual');
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [referenceAspects, setReferenceAspects] = useState(Object.keys(REFERENCE_FIELDS));
  const [templateBusy, setTemplateBusy] = useState(false);
  const [memoryState, setMemoryState] = useState(null);
  const [conversationId, setConversationId] = useState(() => { try { return localStorage.getItem('frame-memory-session') || ''; } catch { return ''; } });
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [config, setConfig] = useState(null);
  const [localStatus, setLocalStatus] = useState(null);
  const [enhancing, setEnhancing] = useState(false);
  const [promptBeforeEnhance, setPromptBeforeEnhance] = useState(null);
  const [checkingLocal, setCheckingLocal] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [networkError, setNetworkError] = useState('');
  const [formError, setFormError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const promptRef = useRef(null);
  const promptRevision = useRef(0);
  const conversationRef = useRef(conversationId);
  const memoryFetchVersion = useRef(0);
  const memoryHydrated = useRef(false);
  const formTouched = useRef(false);
  const closeModal = React.useCallback(() => setModal(null), []);
  const active = jobs.find(job => job.id === activeId);
  const currentStyle = STYLES.find(item => item.id === (active?.style || style));
  const running = active && ['queued', 'processing'].includes(active.status);
  const selectedTemplate = templates.find(item => item.id === templateId);
  const activeMemory = memoryState?.sessions?.find(item => item.id === conversationId);
  const memoryEnabled = Boolean(memoryState?.enabled && activeMemory);
  const hasMemoryContext = Boolean(memoryEnabled && (activeMemory.turnCount || memoryState.preferences?.trim()));
  const rememberSessionId = id => { conversationRef.current = id; setConversationId(id); try { localStorage.setItem('frame-memory-session', id); } catch {} };
  const mutateMemoryContext = () => { promptRevision.current += 1; memoryFetchVersion.current += 1; };
  const applyMemoryState = React.useCallback(state => {
    memoryFetchVersion.current += 1;
    setMemoryState(state);
    setMemoryError('');
    if (!memoryHydrated.current) {
      memoryHydrated.current = true;
      const saved = (state.sessions.find(item => item.id === conversationRef.current) || state.sessions[0])?.lastSettings;
      if (state.enabled && saved && !formTouched.current) {
        setProvider(saved.provider || 'comfyui'); setStyle(saved.style || 'cinematic'); setRatio(saved.ratio || '16:9');
        setSeconds(saved.seconds || 2); setDurationMode(saved.durationMode || 'manual'); setTemplateId(saved.templateId || '');
        setReferenceAspects(saved.referenceAspects || Object.keys(REFERENCE_FIELDS));
      }
    }
    if (!state.sessions.some(item => item.id === conversationRef.current)) {
      const id = state.sessions[0]?.id || '';
      if (id !== conversationRef.current) { promptRevision.current += 1; rememberSessionId(id); }
    }
  }, []);
  const refreshMemory = React.useCallback(async () => {
    const version = ++memoryFetchVersion.current;
    let state;
    try { state = await api('/api/memory'); }
    catch (error) { if (version === memoryFetchVersion.current) setMemoryError(error.message); throw error; }
    if (version === memoryFetchVersion.current) applyMemoryState(state);
    return state;
  }, [applyMemoryState]);
  const switchConversation = async id => {
    mutateMemoryContext();
    const revision = promptRevision.current;
    setMemoryBusy(true); rememberSessionId(id); setPrompt(''); setPromptBeforeEnhance(null); setFormError(''); setActiveId(null);
    try {
      const session = await api(`/api/memory/sessions/${encodeURIComponent(id)}`);
      if (conversationRef.current !== id || promptRevision.current !== revision) return;
      setPrompt(session.turns.at(-1)?.prompt || '');
      const settings = [...session.turns].reverse().find(turn => turn.settings)?.settings;
      setProvider(settings?.provider || 'comfyui'); setStyle(settings?.style || 'cinematic'); setRatio(settings?.ratio || '16:9');
      setSeconds(settings?.seconds || 2); setDurationMode(settings?.durationMode || 'manual'); setTemplateId(settings?.templateId || '');
      setReferenceAspects(settings?.referenceAspects || Object.keys(REFERENCE_FIELDS));
    } finally { setMemoryBusy(false); }
  };
  const updateMemorySettings = async changes => { mutateMemoryContext(); applyMemoryState(await api('/api/memory', { method: 'PATCH', body: JSON.stringify(changes) })); };
  const newConversation = async () => {
    mutateMemoryContext();
    const revision = promptRevision.current;
    setMemoryBusy(true);
    try {
      const result = await api('/api/memory/sessions', { method: 'POST', body: '{}' });
      applyMemoryState(result.state);
      if (promptRevision.current === revision) await switchConversation(result.session.id);
      else setToast('新会话已创建，可在创作记忆中选择；当前会话和输入已保留。');
      return result;
    } finally { setMemoryBusy(false); }
  };
  const discardMemorySuggestion = async record => {
    if (!record?.sessionId || !record.turnId) return;
    try { await api(`/api/memory/sessions/${record.sessionId}/turns/${record.turnId}`, { method: 'DELETE' }); await refreshMemory(); }
    catch (error) { if (!/不存在|已被删除|已清除/.test(error.message)) setToast('原文已保留；建议记录的移除或刷新尚未确认，请到创作记忆页面检查。'); }
  };
  let durationPreview;
  let durationError = '';
  try { durationPreview = resolveDuration({ provider, prompt, seconds, durationMode }); }
  catch (error) { durationError = error.message; }
  const refreshLocal = React.useCallback(async () => {
    setCheckingLocal(true);
    try { setLocalStatus(await api('/api/local/status?refresh=1')); }
    catch { setLocalStatus({ language: { ready: false, message: '本地服务检测失败，请确认后端已启动。' }, video: { ready: false, message: '本地服务检测失败，请确认后端已启动。' } }); }
    finally { setCheckingLocal(false); }
  }, []);
  useEffect(() => { refreshLocal(); const timer = setInterval(refreshLocal, 15000); return () => clearInterval(timer); }, [refreshLocal]);
  useEffect(() => {
    refreshMemory().catch(() => {});
    const timer = setInterval(() => refreshMemory().catch(() => {}), 5000);
    return () => { clearInterval(timer); memoryFetchVersion.current += 1; };
  }, [refreshMemory]);
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/templates').then(items => { if (alive) setTemplates(items); }).catch(() => {});
    load(); const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer;
    const refresh = async () => {
      try {
        const [settings, list] = await Promise.all([api('/api/config'), api('/api/jobs')]);
        if (alive) { setConfig(settings); setJobs(list); setNetworkError(''); }
      } catch (error) { if (alive) setNetworkError(error.message); }
      if (alive) timer = setTimeout(refresh, 2000);
    };
    refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const useIdea = idea => {
    promptRevision.current += 1;
    setPromptBeforeEnhance(null);
    setPrompt(idea.prompt); setStyle(idea.id); setActiveId(null); setFormError(''); setView('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => promptRef.current?.focus(), 50);
  };
  const reset = () => { promptRevision.current += 1; setPromptBeforeEnhance(null); setActiveId(null); setPrompt(''); setFormError(''); setView('create'); setTimeout(() => promptRef.current?.focus(), 50); };
  const enhancePrompt = async () => {
    if (previewOnly) return;
    if (prompt.trim().length < 2) { setFormError('先写下至少 2 个字符的创作想法。'); promptRef.current?.focus(); return; }
    const original = prompt;
    const revision = promptRevision.current;
    let suggestionRecord;
    setEnhancing(true); setFormError('');
    try {
      const result = await api('/api/prompts/enhance', { method: 'POST', body: JSON.stringify({ prompt, useMemory: memoryEnabled, conversationId: memoryEnabled ? conversationId : undefined, provider, templateId: templateId || undefined, referenceAspects }), signal: AbortSignal.timeout(190000) });
      suggestionRecord = result.memory;
      if (promptRevision.current !== revision) {
        await discardMemorySuggestion(result.memory);
        setToast('润色已完成，已保留你刚修改的提示词');
        return;
      }
      let enhanced = result.prompt;
      if (durationMode === 'prompt') {
        let originalSeconds;
        try { originalSeconds = resolveDuration({ provider, prompt: original, durationMode: 'prompt' }); } catch {}
        if (originalSeconds) {
          let inferred;
          try { inferred = resolveDuration({ provider, prompt: enhanced, durationMode: 'prompt' }); }
          catch (error) {
            if (error.message.startsWith('未识别到')) enhanced = `总时长 ${originalSeconds} 秒。${enhanced}`;
            else throw new Error('润色结果中的时长不明确，已保留原文。请手动调整描述。');
          }
          if (inferred && inferred !== originalSeconds) throw new Error('润色结果改变了原始视频时长，已保留原文。');
        }
      }
      setPromptBeforeEnhance({ original, enhanced, memory: result.memory });
      setPrompt(enhanced); setToast('本地语言模型已润色提示词，可撤销本次修改');
      refreshMemory().catch(() => {});
    } catch (error) { if (suggestionRecord) await discardMemorySuggestion(suggestionRecord); setFormError(error.message); }
    finally { setEnhancing(false); }
  };
  const undoEnhance = () => {
    if (!promptBeforeEnhance || prompt !== promptBeforeEnhance.enhanced) return;
    promptRevision.current += 1;
    setPrompt(promptBeforeEnhance.original); setPromptBeforeEnhance(null); setFormError('');
    discardMemorySuggestion(promptBeforeEnhance.memory);
    setToast('已恢复润色前的提示词');
  };
  const generate = async (values, demoConfirmed = false) => {
    if (previewOnly) { setFormError('此文件仅供查看界面，生成视频需要启动本地服务。'); return; }
    const useContext = values?.useMemory ?? memoryEnabled;
    const payload = { ...(values || { prompt, style, ratio, seconds, provider, durationMode, templateId: templateId || undefined, referenceAspects }), useMemory: useContext, conversationId: useContext ? (values?.conversationId || conversationId) : undefined };
    const contextAvailable = useContext && hasMemoryContext && payload.conversationId === conversationId;
    try { payload.seconds = resolveDuration(payload); }
    catch (error) { if (!contextAvailable || !error.message.startsWith('未识别到')) { setFormError(error.message); return; } }
    const shortFollowUp = contextAvailable && payload.provider !== 'demo';
    if (payload.prompt.trim().length < (shortFollowUp ? 2 : 10)) { setFormError(shortFollowUp ? '请输入至少 2 个字符的本次要求。' : '再多一点细节吧，至少输入 10 个字符。'); promptRef.current?.focus(); return; }
    if (payload.provider === 'comfyui' && !localStatus?.video?.ready) { setFormError(localStatus?.video?.message || '本地 Wan 尚未就绪，请先检查本机模型。'); return; }
    if (templateBusy) { setFormError('模板处理尚未完成，请稍候再生成。'); return; }
    if (payload.templateId && payload.provider === 'demo') { setFormError('演示样片不读取参考模板，请选择本地 Wan，或取消模板选择。'); return; }
    if (payload.provider === 'demo' && !demoConfirmed) { setModal({ type: 'demo', payload }); return; }
    const submittedConversation = conversationRef.current;
    const submittedRevision = promptRevision.current;
    setBusy(true); setFormError('');
    try {
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(190000) });
      setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]);
      if (conversationRef.current === submittedConversation && promptRevision.current === submittedRevision) {
        setActiveId(job.id); setView('create');
        setToast(job.provider === 'demo' ? '演示样片已开始渲染' : 'AI 生成任务已提交');
      } else setToast('原请求已提交，可在作品库查看；当前会话和输入已保留。');
      refreshMemory().catch(() => {});
    } catch (error) { setFormError(error.message); }
    finally { setBusy(false); }
  };
  const retry = job => {
    promptRevision.current += 1;
    setPromptBeforeEnhance(null);
    const originalDescription = job.resolvedPrompt || job.prompt;
    setPrompt(originalDescription); setStyle(job.style); setRatio(job.ratio); setSeconds(job.seconds); setProvider(job.provider);
    setDurationMode('manual'); setTemplateId(job.templateId || ''); setReferenceAspects(job.referenceAspects || Object.keys(REFERENCE_FIELDS));
    setView('create'); setModal(null);
    generate({ prompt: originalDescription, style: job.style, ratio: job.ratio, seconds: job.seconds, provider: job.provider, durationMode: 'manual', templateId: job.templateId, referenceAspects: job.referenceAspects, useMemory: false });
  };
  const remove = async job => {
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
      setJobs(previous => previous.filter(item => item.id !== job.id));
      if (activeId === job.id) setActiveId(null);
      setModal(null); setToast('作品已删除');
    } catch (error) { setToast(error.message); }
    finally { setBusy(false); }
  };
  const showJob = job => { setActiveId(job.id); setView('create'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const completed = jobs.filter(job => job.status === 'completed');
  const displayed = jobs.filter(job => (filter === 'all' || job.status === filter || (filter === 'processing' && job.status === 'queued')) && job.prompt.toLowerCase().includes(search.toLowerCase()));

  const renderInspiration = (full = false) => <section className="inspiration-section">
    <div className="section-heading"><div><h2>{full ? '找到你的下一束灵感' : '从一个灵感开始'}<span className="small-tag">精选</span></h2><p>不必从空白开始，让好想法先走一步。</p></div>{!full && <button className="text-button" onClick={() => setView('ideas')}>探索灵感库 <ArrowUpRight size={15} /></button>}</div>
    <div className="idea-grid">{STYLES.map((idea, index) => <button className="idea-card" key={idea.id} onClick={() => useIdea(idea)}>
      <div className="idea-image"><img src={imageUrl(idea.id)} alt={idea.title} loading="lazy" /><span className="idea-number">0{index + 1}</span><span className="idea-use">使用提示词 <ArrowUpRight size={14} /></span></div>
      <div className="idea-copy"><div><span>{idea.en}</span><h3>{idea.title}</h3></div><ArrowUpRight size={18} /></div>
      <p>{idea.subtitle}</p>
    </button>)}</div>
    {full && <div className="idea-note"><Sparkles size={20} /><p>灵感是起点，不是终点。选一张卡片，把提示词改成你自己的故事。</p></div>}
  </section>;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('create'); }} aria-label="Frame 首页"><span className="brand-mark"><Film size={23} strokeWidth={2.5} /></span><span>frame<span className="brand-dot">.</span></span></a>
      <div className="workspace-switch"><span className="workspace-avatar">F</span><div><strong>我的创作空间</strong><span>PERSONAL WORKSPACE</span></div><span className="workspace-plan">个人</span></div>
      <div className="nav-label">工作空间</div>
      <nav aria-label="主导航">
        <button className={view === 'create' ? 'nav-item active' : 'nav-item'} onClick={() => setView('create')}><WandSparkles size={18} /><span>视频创作</span><span className="nav-new">NEW</span></button>
        <button className={view === 'library' ? 'nav-item active' : 'nav-item'} onClick={() => setView('library')}><FolderOpen size={18} /><span>我的作品</span><span className="nav-count">{jobs.length}</span></button>
        <button className={view === 'ideas' ? 'nav-item active' : 'nav-item'} onClick={() => setView('ideas')}><Grid2X2 size={18} /><span>灵感库</span></button>
        <button className={view === 'templates' ? 'nav-item active' : 'nav-item'} onClick={() => setView('templates')}><Layers3 size={18} /><span>参考模板</span><span className="nav-count">{templates.length}</span></button>
        <button className={view === 'memory' ? 'nav-item active' : 'nav-item'} onClick={() => setView('memory')}><Layers3 size={18} /><span>创作记忆</span></button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="note-orbit"><Sparkles size={18} /></span><h3>好故事，从想象开始。</h3><p>把脑海中的一帧，<br />交给无限可能。</p><button onClick={() => setModal({ type: 'settings' })}>了解生成模式 <ArrowUpRight size={14} /></button></div>
      <div className="sidebar-bottom"><button onClick={() => setModal({ type: 'settings' })}><Settings2 size={17} />生成设置</button><button onClick={() => setModal({ type: 'help' })}><CircleHelp size={17} />使用指南</button></div>
      <div className="profile"><span className="profile-avatar">创</span><div><strong>创作者</strong><span>让灵感自由发生</span></div><span className="online-dot" /></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span><strong>{{ create: '视频创作', library: '我的作品', ideas: '灵感库', templates: '参考模板', memory: '创作记忆' }[view]}</strong></div><div className="topbar-right"><span className={`connection ${networkError ? 'offline' : ''}`}><span />{networkError ? '服务连接中断' : config ? (previewOnly ? '独立界面预览' : '创作空间已就绪') : '正在连接服务'}</span><span className="topbar-divider" /><button className="icon-button" aria-label="打开使用指南" onClick={() => setModal({ type: 'help' })}><CircleHelp size={19} /></button><span className="top-avatar">F</span></div></header>
      <div className="page-content">
        {previewOnly && <div className="preview-notice" role="status"><Monitor size={17} /><span>独立界面预览：可查看页面、风格和参数。视频生成与 AI 润色需要启动本地服务。</span></div>}
        {networkError && <div className="network-banner" role="alert"><AlertCircle size={17} />{networkError} 正在自动重连…</div>}
        <section className="page-heading"><div><div className="eyebrow"><span />MADE OF IMAGINATION</div><h1>{{ create: <>把想象，变成<span>下一帧。</span></>, library: <>每一帧，都是<span>你的创作。</span></>, ideas: <>让好故事，<span>在这里发生。</span></>, templates: <>让参考，<span>成为灵感。</span></>, memory: <>让创作，<span>保持连贯。</span></> }[view]}</h1><p>{{ create: '用文字描绘你的世界，让灵感从这一刻开始流动。', library: '所有灵感都有迹可循。预览、下载，或开启下一次创作。', ideas: '从自然的呼吸到城市的脉搏，发现值得被记录的瞬间。', templates: '分析可见内容，保存参考描述，再结合你的提示词创作。', memory: '在独立会话中延续主体与场景，长期偏好由你编辑。' }[view]}</p></div>{view === 'create' ? <span className="heading-badge"><Clapperboard size={16} />为灵感按下播放键</span> : <button className="primary-small" onClick={reset}><Plus size={17} />新建视频</button>}</section>

        {view === 'create' && <>
          <div className="studio-grid">
            <section className="composer panel">
              <div className="panel-title"><div><span className="panel-icon"><WandSparkles size={17} /></span><h2>开始创作</h2></div><span className="version-tag">TEXT TO VIDEO</span></div>
              <form onChange={() => { formTouched.current = true; }} onSubmit={event => { event.preventDefault(); generate(); }}>
                <MemoryControls state={memoryState} activeId={conversationId} onSelect={switchConversation} onSettings={updateMemorySettings} onManage={() => setView('memory')} onCreate={newConversation} disabled={memoryBusy || busy || previewOnly} previewOnly={previewOnly} />
                {memoryError && <div className="form-error" role="alert">记忆读取失败：{memoryError}<button className="text-button" type="button" onClick={() => refreshMemory().catch(() => {})}>重新读取记忆</button></div>}
                <div className="field-heading"><label htmlFor="prompt">描述你的画面</label><div className="prompt-actions"><button type="button" className="text-button" onClick={enhancePrompt} disabled={previewOnly || enhancing || busy || running || memoryBusy || !memoryState}>{enhancing ? <LoaderCircle size={13} className="spin" /> : <WandSparkles size={13} />}{enhancing ? '润色中…' : '本地 AI 润色'}</button><button type="button" className="text-button muted" onClick={() => useIdea(STYLES[Math.floor(Math.random() * STYLES.length)])} disabled={enhancing}><Sparkles size={13} />试试灵感</button></div></div>
                <div className={`prompt-box ${formError ? 'invalid' : ''}`}><textarea ref={promptRef} id="prompt" disabled={memoryBusy} maxLength={2000} value={prompt} onChange={event => { promptRevision.current += 1; setPrompt(event.target.value); setFormError(''); }} placeholder={'想象这样一个画面：\n日落时分，海浪轻轻拍打沙滩，金色光线洒在水面，镜头缓缓向远方推进…'} aria-describedby="prompt-hint" aria-invalid={Boolean(formError)} /><div className="prompt-footer"><span><Layers3 size={12} />主体 + 场景 + 动作 + 镜头</span><span>{prompt.length}<span> / 2000</span></span></div></div>
                {promptBeforeEnhance && prompt === promptBeforeEnhance.enhanced && <div className="prompt-undo"><span>已保留润色前的描述</span><button type="button" className="text-button" onClick={undoEnhance} disabled={enhancing}><RotateCcw size={12} />撤销润色</button></div>}
                <div className="template-selection"><div className="field-heading"><label htmlFor="template-select">参考模板</label><button className="text-button" type="button" onClick={() => setView('templates')}>上传或管理模板 <ArrowUpRight size={12} /></button></div><select id="template-select" value={templateId} onChange={event => setTemplateId(event.target.value)}><option value="">不使用模板</option>{templateId && !selectedTemplate && <option value={templateId}>模板已删除，请重新选择</option>}{templates.map(item => <option value={item.id} key={item.id} disabled={item.status !== 'ready' || !item.profile}>{item.name}{item.status === 'ready' ? '' : ' · 描述未就绪'}</option>)}</select>{selectedTemplate?.profile && <><p className="mode-hint">{selectedTemplate.profile.summary}</p><div className="reference-aspects">{Object.entries(REFERENCE_FIELDS).map(([key, label]) => <label key={key}><input type="checkbox" checked={referenceAspects.includes(key)} onChange={event => setReferenceAspects(previous => event.target.checked ? [...previous, key] : previous.filter(value => value !== key))} />{label}</label>)}</div><p className="mode-hint">使用模板的文字要点参考，不训练权重，不保证人物外观与原素材一致。</p></>}</div>
                <div className="field-heading style-heading"><label>画面风格</label><span className="optional-label">给灵感一点个性</span></div>
                <div className="style-options" role="radiogroup" aria-label="画面风格">{STYLES.map(item => <label className={`style-option ${style === item.id ? 'selected' : ''}`} key={item.id}><input type="radio" name="style" value={item.id} checked={style === item.id} onChange={() => { setStyle(item.id); if (!running) setActiveId(null); }} /><img src={imageUrl(item.id)} alt="" /><span>{item.name}</span>{style === item.id && <span className="style-check"><Check size={9} strokeWidth={3} /></span>}</label>)}</div>
                <div className="parameter-row"><fieldset><legend>画面比例</legend><div className="ratio-options"><label className={ratio === '16:9' ? 'selected' : ''}><input type="radio" name="ratio" checked={ratio === '16:9'} onChange={() => setRatio('16:9')} /><Monitor size={15} />16:9</label><label className={ratio === '9:16' ? 'selected' : ''}><input type="radio" name="ratio" checked={ratio === '9:16'} onChange={() => setRatio('9:16')} /><Smartphone size={15} />9:16</label></div></fieldset><div className="duration-field"><label htmlFor="seconds">视频时长</label><div className="select-wrapper"><Clock3 size={15} /><select id="seconds" value={durationMode === 'prompt' ? 'prompt' : seconds} onChange={event => { const value = event.target.value; setDurationMode(value === 'prompt' ? 'prompt' : 'manual'); if (value !== 'prompt') setSeconds(Number(value)); setFormError(''); }}>{durationMode === 'manual' && !DURATION_OPTIONS.includes(seconds) && <option value={seconds}>{seconds} 秒 · 自定义</option>}{(provider === 'sora' ? [4, 8, 12] : DURATION_OPTIONS).map(value => <option value={value} key={value}>{value} 秒</option>)}<option value="prompt">根据提示词识别</option></select><ChevronDown size={14} /></div></div></div>
                <div className="mode-row"><label htmlFor="provider"><span className="mode-dot" />生成模式</label><button type="button" className="mode-settings" onClick={() => setModal({ type: 'settings' })} aria-label="查看生成设置"><Settings2 size={12} /></button><div className="select-wrapper mode-select"><select id="provider" value={provider} onChange={event => { setProvider(event.target.value); setSeconds(event.target.value === 'comfyui' ? 2 : 4); setDurationMode('manual'); setFormError(''); }}><option value="comfyui">本地 Wan · 按提示词生成</option><option value="demo">演示样片 · 内置照片运镜</option><option value="sora" disabled={!config?.soraReady}>Sora 2{config?.soraReady ? ' · AI 生成' : ' · 待配置密钥'}</option></select><ChevronDown size={13} /></div></div>
                <p className="mode-hint" id="prompt-hint">{provider === 'demo' ? '仅用于体验播放、下载和作品管理。' : provider === 'comfyui' ? '按提示词生成新画面，2–60 秒、288p、无音轨。超过 2 秒会分段生成后合成，各段人物和动作衔接可能变化；时长越长耗时越多。' : '将提交到 OpenAI Sora 2，按服务商规则计费，通常需等待数分钟。'}</p>
                {durationMode === 'prompt' && <p className={`duration-resolution ${durationError ? 'invalid' : ''}`} role="status">{durationError ? (hasMemoryContext && durationError.startsWith('未识别到') ? '将结合当前会话整理描述并识别总时长。' : durationError) : `已识别视频总时长：${durationPreview} 秒`}</p>}
                {templateBusy && <p className="mode-hint" role="status">模板处理尚未完成，请稍候再生成。</p>}
                {provider === 'demo' && <div className="generation-notice demo-notice" role="note"><AlertCircle size={17} /><div><strong>演示样片使用内置照片</strong><p>只添加运镜，不按提示词生成新画面。要生成你描述的内容，请选择“本地 Wan”。</p></div></div>}
                {provider === 'comfyui' && !previewOnly && !localStatus?.video?.ready && <div className="generation-notice" role="status"><AlertCircle size={17} /><div><strong>{localStatus ? '本地 Wan 尚未就绪' : '正在检测本地 Wan…'}</strong><p>{localStatus?.video?.message || '检测完成并确认模型就绪后，才可生成 AI 视频。'}</p><button type="button" className="text-button" onClick={() => setModal({ type: 'settings' })}>检查本机模型 <ArrowRight size={12} /></button></div></div>}
                {formError && <div className="form-error" role="alert"><AlertCircle size={14} />{formError}</div>}
                <button className="generate-button" type="submit" disabled={previewOnly || busy || running || enhancing || memoryBusy || templateBusy || !memoryState || !config || (provider === 'demo' && !config.demoReady) || (provider === 'comfyui' && !localStatus?.video?.ready) || (provider === 'sora' && !config.soraReady)}>{busy || running ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}<span>{previewOnly ? '界面预览 · 生成需本地服务' : busy ? '正在提交…' : running ? '视频生成中…' : provider === 'demo' ? '生成演示视频' : provider === 'comfyui' ? '生成 AI 视频 · 本地 Wan' : '生成 AI 视频'}</span><ArrowRight size={18} /></button>
                <div className="generate-footnote"><ShieldCheck size={12} />{previewOnly ? '离线界面预览 · 不连接生成服务' : provider === 'demo' ? '无需密钥 · 实际生成可下载 MP4' : provider === 'comfyui' ? '仅调用本机 ComfyUI · 无 API 费用' : '密钥仅保存在服务器 · 不向浏览器暴露'}</div>
                {config && !config.demoReady && provider === 'demo' && <p className="form-error">未检测到 FFmpeg，请查看使用指南完成安装。</p>}
              </form>
            </section>

            <section className="preview-panel panel">
              {active?.memoryUsed && active.resolvedPrompt && <details className="memory-result-context"><summary>本次实际画面描述 · {active.memorySessionTitle || '创作会话'}</summary><p>{active.resolvedPrompt}</p><small>已结合会话上下文；明确参数和本次要求优先。</small></details>}
              <div className="panel-title"><div><span className="panel-icon"><Play size={16} /></span><h2>画面预览</h2></div><span className="preview-quality">{active ? active.ratio : ratio} <span>·</span> {(active?.provider || provider) === 'comfyui' ? '288P' : '720P'}</span></div>
              <div className={`preview-stage ${active?.ratio === '9:16' ? 'portrait' : ''}`}>
                {active?.status === 'completed' ? <video key={active.id} src={active.videoUrl} poster={active.posterUrl || undefined} controls autoPlay muted loop playsInline aria-label="生成视频预览" /> : <><img className={running ? 'rendering-image' : ''} src={imageUrl(currentStyle.id)} alt={`${currentStyle.name}风格参考画面`} /><div className="preview-shade" />{!running && active?.status !== 'failed' && <><span className="preview-label"><span />风格参考 · 非生成结果</span><button className="preview-play" aria-label="了解如何生成视频" onClick={() => { promptRef.current?.focus(); setToast(previewOnly ? '这是风格参考图片。视频预览需要先启动本地生成服务。' : provider === 'demo' ? '当前为内置照片演示；选择本地 Wan 可按提示词生成新画面' : '写下提示词，确认生成模式和模型就绪后，再点击生成 AI 视频'); }}><Play size={26} fill="currentColor" /></button><div className="preview-art-title"><span>A LITTLE IDEA. A BIG WORLD.</span><h3>{currentStyle.title}<span>。</span></h3><p>下一幕，由你想象</p></div><span className="preview-frame">FRAME / 001</span></>}</>}
                {running && <div className="render-overlay" role="status"><span className="render-orbit"><Sparkles size={27} /></span><h3>{active.status === 'queued' ? '灵感已就位，正在排队' : '你的下一帧，正在发生'}</h3><p>{active.provider === 'demo' ? '正在渲染动态演示样片' : active.provider === 'comfyui' ? '本机模型正在处理，请查看 ComfyUI 控制台了解采样进度' : 'Sora 正在把文字变成画面，请耐心等待'}</p><div className={`progress-track ${active.provider === 'comfyui' ? 'indeterminate' : ''}`}><span style={{ width: active.provider === 'comfyui' ? '35%' : `${active.progress}%` }} /></div><span className="progress-number">{active.provider === 'comfyui' ? '模型处理中 · 非百分比进度' : `${active.progress}%`}</span><small>{active.totalSegments > 1 ? `已完成 ${active.completedSegments || 0}/${active.totalSegments} 段 · ${active.stage || '准备分段生成'}` : '你可以离开此页面，任务记录会自动保存'}</small></div>}
                {active?.status === 'failed' && <div className="render-overlay failed-overlay"><AlertCircle size={32} /><h3>这次没能完成生成</h3><p>{active.error}</p><button className="light-button" disabled={busy} onClick={() => retry(active)}><RotateCcw size={15} />重新生成</button></div>}
              </div>
              <div className="preview-caption"><div><span className={`result-indicator ${active?.status || ''}`} /><strong>{active ? STATUS[active.status] : '灵感预览'}</strong><span className="caption-meta">{active ? `${active.seconds} 秒 · ${providerName(active.provider)}` : '给想象一点画面感'}</span></div>{active?.status === 'completed' ? <a className="download-button" href={`${active.videoUrl}?download=1`} download><ArrowDownToLine size={15} />下载视频</a> : <span className="sample-badge">{provider === 'demo' ? 'DEMO MODE' : provider === 'comfyui' ? 'LOCAL AI' : 'SORA 2'}</span>}</div>
              <div className="preview-tip"><span className="tip-icon"><Sparkles size={16} /></span><div><strong>好画面，藏在细节里</strong><p>描述光线、运镜和氛围，能让真实 AI 生成的效果更接近你的想象。</p></div><span className="tip-decor">✳</span></div>
              <div className="preview-bottom"><span><CheckCircle2 size={13} />支持横屏 / 竖屏</span><span><ArrowDownToLine size={13} />MP4 格式导出</span></div>
            </section>
          </div>
          {renderInspiration()}
          {jobs.length > 0 && <section className="recent-section"><div className="section-heading"><div><h2>最近创作<span className="count-label">{jobs.length}</span></h2></div><button className="text-button" onClick={() => setView('library')}>全部作品 <ArrowRight size={15} /></button></div><div className="recent-list">{jobs.slice(0, 3).map(job => <button key={job.id} className="recent-item" onClick={() => showJob(job)}><div className="recent-thumbnail">{job.provider === 'demo' ? <img src={imageUrl(job.style)} alt="" /> : <Film size={24} />}</div><div className="recent-text"><strong>{job.prompt}</strong><span>{dateText(job.createdAt)} · {job.seconds} 秒 · {job.ratio} · {providerName(job.provider)}</span></div><span className={`status-pill ${job.status}`}>{STATUS[job.status]}</span><ArrowUpRight size={16} /></button>)}</div></section>}
        </>}

        {view === 'ideas' && renderInspiration(true)}
        {view === 'memory' && <MemoryPanel api={api} state={memoryState} activeId={conversationId} onSelect={switchConversation} onCreate={newConversation} onState={applyMemoryState} onMutateContext={mutateMemoryContext} previewOnly={previewOnly} />}
        {view === 'templates' && <TemplateLibrary items={templates} onChange={setTemplates} onUse={item => { setTemplateId(item.id); setView('create'); setFormError(''); setToast(`已选择模板：${item.name}`); }} api={api} disabled={enhancing || jobs.some(job => ['queued', 'processing'].includes(job.status))} previewOnly={previewOnly} vision={localStatus?.vision} onBusyChange={setTemplateBusy} />}
        {view === 'library' && <section className="library-section"><div className="library-toolbar"><div className="filter-tabs">{[['all', '全部作品'], ['completed', '已完成'], ['processing', '生成中'], ['failed', '失败']].map(([id, text]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{text}{id === 'all' && <span>{jobs.length}</span>}</button>)}</div><div className="search-box"><Search size={16} /><input aria-label="搜索作品" placeholder="搜索提示词…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>{displayed.length ? <div className="works-grid">{displayed.map(job => <article className="work-card" key={job.id}><button className="work-preview" onClick={() => showJob(job)} aria-label={`预览：${job.prompt}`}>{job.provider === 'demo' ? <img src={imageUrl(job.style)} alt="演示素材" /> : <div className="ai-poster"><Film size={40} /><span>{job.provider === 'comfyui' ? 'LOCAL WAN' : 'SORA 2'}</span></div>}<span className="work-overlay"><Play fill="currentColor" size={26} /></span><span className={`status-pill ${job.status}`}>{STATUS[job.status]}</span><span className="work-duration">{job.seconds}s · {job.ratio}</span></button><div className="work-info"><span className="work-type">{providerName(job.provider)} · {STYLES.find(item => item.id === job.style).name}</span><h3>{job.prompt}</h3><div className="work-footer"><span>{dateText(job.createdAt)}</span><div>{job.status === 'completed' && <a href={`${job.videoUrl}?download=1`} download className="icon-button" aria-label="下载视频"><ArrowDownToLine size={16} /></a>}{job.status === 'failed' && <button className="icon-button" onClick={() => retry(job)} disabled={busy} aria-label="重试生成"><RotateCcw size={16} /></button>}{!['queued', 'processing'].includes(job.status) && <button className="icon-button danger" onClick={() => setModal({ type: 'delete', job })} aria-label="删除作品"><Trash2 size={16} /></button>}</div></div></div></article>)}</div> : <div className="empty-state"><span><FolderOpen size={31} /></span><h2>{jobs.length ? '没有找到对应作品' : '你的第一部作品，从这里开始'}</h2><p>{jobs.length ? '试试其他关键词或筛选条件。' : '把一个灵感写下来，剩下的交给镜头。'}</p>{!jobs.length && <button className="primary-small" onClick={reset}><Plus size={16} />开始创作</button>}</div>}<p className="storage-note">作品保存在当前服务器 · {completed.length} 部已完成 · 最多保留 100 条记录</p></section>}

        <footer className="page-footer"><span>frame<span className="brand-dot">.</span><span className="footer-separator">/</span>让每一个灵感，都有自己的镜头。</span><span>IMAGINE. CREATE. PLAY.</span></footer>
      </div>
    </main>
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={14} /></button></div>}

    {modal?.type === 'settings' && <Modal title="生成设置" close={closeModal}><div className="settings-intro"><Settings2 size={23} /><p>先体验，再连接更多可能。</p></div><div className="settings-option"><div><strong>演示模式</strong><span className={`status-pill ${config?.demoReady ? 'completed' : 'failed'}`}>{config?.demoReady ? '已就绪' : 'FFmpeg 未就绪'}</span></div><p>使用内置风景照片生成有运镜效果的 MP4，支持所选比例和时长。它不会根据提示词生成新画面，也不会调用付费 AI 服务。</p></div><div className="settings-option"><div><strong>本地 AI · 无需 Token</strong><button className="text-button" onClick={refreshLocal} disabled={checkingLocal}>{checkingLocal ? '检测中…' : '重新检测'}</button></div><div className="local-service"><strong>Ollama · {localStatus?.language?.model || 'Qwen3 4B'}</strong><span className={`status-pill ${localStatus?.language?.ready ? 'completed' : 'queued'}`}>{localStatus?.language?.ready ? '已连接' : '待就绪'}</span></div><p>{localStatus?.language?.message || '正在检测本机语言模型…'}</p><div className="local-service"><strong>ComfyUI · Wan 2.1 1.3B</strong><span className={`status-pill ${localStatus?.video?.ready ? 'completed' : 'queued'}`}>{localStatus?.video?.ready ? '文件与节点就绪' : '待就绪'}</span></div><p>{localStatus?.video?.message || '正在检测本机视频模型…'}</p><div className="local-service"><strong>模板视觉 · {localStatus?.vision?.model || config?.visionModel || 'qwen2.5vl:3b'}</strong><span className={`status-pill ${localStatus?.vision?.ready ? 'completed' : 'queued'}`}>{localStatus?.vision?.ready ? '可分析图片' : '待就绪'}</span></div><p>{localStatus?.vision?.message || '模板分析需要本机视觉模型，可在参考模板页面查看安装命令。'}</p><p>推荐 RTX 3060 Ti 8GB 从 2 秒、512×288 起步。先用「本地 AI 润色」优化文字，再选「本地 Wan」生成。语言模型完成后自动卸载，降低显存占用。</p><small>请在你自己的电脑运行本地部署包；云环境无法直接连接你电脑的 localhost。</small></div><div className="settings-option"><div><strong>OpenAI Sora 2</strong><span className={`status-pill ${config?.soraReady ? 'completed' : 'queued'}`}>{config?.soraReady ? '已配置密钥' : '待配置'}</span></div><p>按你的文字描述生成全新的视频。由服务器安全调用，需要拥有视频生成权限的 OpenAI API 账户，可能产生费用。</p><ol><li>在项目根目录创建 <code>.env</code> 文件。</li><li>配置 <code>VIDEO_API_KEY=你的密钥</code>。</li><li>重启服务器，在创作区选择 Sora 2。</li></ol><small>不要把密钥填写在提示词里，或提交到 Git 仓库。</small></div><button className="modal-primary" onClick={closeModal}>开始我的创作 <ArrowRight size={16} /></button></Modal>}
    {modal?.type === 'help' && <Modal title="让灵感顺利成片" close={closeModal}><div className="help-steps">{[['01', '写下你想看到的画面', '至少 10 个字符。加入主体、场景、动作、光线和镜头语言，描述越具体，真实 AI 的结果越可控。'], ['02', '为画面选择合适的表达', '选择风格、16:9 横屏或 9:16 竖屏，本地模式支持 2–60 秒；可从提示词识别总时长，长片分段生成后合成。Sora 支持 4、8、12 秒，演示模式使用内置素材。'], ['03', '生成、预览，然后分享', '点击生成后可查看进度。完成后直接播放或下载 MP4，历史任务保存在「我的作品」中。']].map(([num, title, text]) => <div className="help-step" key={num}><span>{num}</span><div><h3>{title}</h3><p>{text}</p></div></div>)}</div><div className="help-note"><CircleHelp size={18} /><p>演示模式需安装 FFmpeg；本地 AI 需启动 Ollama / ComfyUI，无需付费密钥；Sora 需要 API 密钥。任务在服务器后台运行，刷新页面不会删除已有作品。</p></div><button className="modal-primary" onClick={closeModal}>明白了，开始创作 <ArrowRight size={16} /></button></Modal>}
    {modal?.type === 'demo' && <Modal title="生成内置素材演示？" close={closeModal}><div className="demo-confirm-copy"><AlertCircle size={24} /><p>演示样片只为所选风格的内置照片添加运镜，<strong>不会按提示词生成你描述的主体、场景或动作</strong>。</p><p>如果你希望 AI 生成新画面，请返回创作并选择“本地 Wan”。</p></div><div className="demo-confirm-actions"><button className="light-button" onClick={closeModal}>返回创作</button><button className="modal-primary" onClick={() => { const payload = modal.payload; setModal(null); generate(payload, true); }} disabled={busy}>确认生成演示样片</button></div></Modal>}
    {modal?.type === 'delete' && <Modal title="删除这部作品？" close={closeModal} className="small-modal"><p className="delete-description">视频文件和创作记录将一并删除，删除后无法恢复。</p><div className="delete-actions"><button className="light-button" onClick={closeModal} disabled={busy}>保留作品</button><button className="delete-button" onClick={() => remove(modal.job)} disabled={busy}>{busy ? '正在删除…' : '确认删除'}</button></div></Modal>}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
