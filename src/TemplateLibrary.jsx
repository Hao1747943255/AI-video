import React, { useState } from 'react';
import { Upload, ScanEye, Trash2, Check, LoaderCircle } from 'lucide-react';

export const REFERENCE_FIELDS = { scene: '场景', characters: '人物外观', objects: '物体与设备', style: '画面风格', camera: '镜头', actions: '动作' };
const labels = { summary: '摘要', ...REFERENCE_FIELDS };
const emptyProfile = () => Object.fromEntries(Object.keys(labels).map(key => [key, '']));
const statuses = { uploaded: '待分析', analyzing: '分析中', ready: '参考描述就绪', failed: '分析失败，可重试' };

export default function TemplateLibrary({ items, onChange, onUse, api, disabled, previewOnly, vision, onBusyChange }) {
  const [selected, setSelected] = useState(null);
  const [profile, setProfile] = useState(emptyProfile);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const item = items.find(entry => entry.id === selected);
  const dirty = item && JSON.stringify(profile) !== JSON.stringify(item.profile || emptyProfile());
  const choose = entry => { setSelected(entry.id); setProfile(entry.profile || emptyProfile()); setError(''); };
  const perform = async (operation, label) => {
    if (disabled || busy || previewOnly) return;
    setBusy(label); onBusyChange(true); setError('');
    try {
      const changed = await operation();
      onChange(await api('/api/templates'));
      if (changed?.id) choose(changed);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); onBusyChange(false); }
  };
  const upload = event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) { setError('单个模板最多支持 100 MiB。'); return; }
    perform(async () => {
      const response = await fetch(`/api/templates?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        signal: AbortSignal.timeout(600000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '模板上传失败。');
      return result;
    }, '正在处理上传素材…');
  };
  const blocked = disabled || Boolean(busy) || previewOnly;
  return <section className="template-page">
    <div className="section-heading"><div><h2>参考模板</h2><p>上传图片或视频，提取并保存可编辑的画面描述。</p></div><label className={`template-upload ${blocked ? 'disabled' : ''}`}><Upload size={16} />上传模板<input aria-label="上传参考模板" type="file" accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.webm" disabled={blocked} onChange={upload} /></label></div>
    <div className="template-explanation"><strong>学习人物、场景、风格和镜头的参考描述</strong><p>图片分析一个画面；视频均匀抽取最多 6 帧，不分析声音。生成时使用这些文字要点，不训练模型权重，不能锁定同一个人物或精确复现模板。</p><p>支持 JPEG、PNG、WebP、MP4、MOV、WebM；单个文件最多 100 MiB，视频最多 5 分钟，最多保存 20 个模板。</p></div>
    {!vision?.ready && <div className="generation-notice"><ScanEye size={18} /><div><strong>模板分析需要本机视觉模型</strong><p>{vision?.message || '文字模型 Qwen3 无法读取图片；请安装视觉模型后重新检测。'}</p><code>ollama pull {vision?.model || 'qwen2.5vl:3b'}</code><p>也可以先手动填写并保存参考描述。视觉模型分析结束后会释放显存。</p></div></div>}
    {busy && <p className="template-operation" role="status"><LoaderCircle size={16} className="spin" />{busy}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="template-layout"><div className="template-grid">{items.length ? items.map(entry => <button className={`template-card ${entry.id === selected ? 'selected' : ''}`} key={entry.id} onClick={() => choose(entry)} disabled={Boolean(busy)}><img src={entry.thumbnailUrl} alt={`${entry.name} 缩略图`} /><strong>{entry.name}</strong><span>{entry.kind === 'video' ? `${entry.duration.toFixed(1)} 秒视频 · ${entry.frameCount} 帧` : '图片模板'}</span><span>{statuses[entry.status] || entry.status}</span></button>) : <div className="template-empty">还没有模板。上传一张图片或一个视频开始。</div>}</div>
      {item && <div className="template-editor panel"><h3>{item.name}</h3>{item.kind === 'video' ? <video controls src={item.mediaUrl} aria-label="模板视频预览" /> : <img className="template-media" src={item.mediaUrl} alt="模板图片预览" />}<div className="template-buttons"><button className="light-button" disabled={blocked || item.status === 'analyzing' || !vision?.ready} onClick={() => perform(() => api(`/api/templates/${item.id}/analyze`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(600000) }), '正在分析模板，首次加载视觉模型可能较慢…')}><ScanEye size={14} />{item.profile ? '重新分析模板' : '分析模板'}</button><button className="text-button danger" disabled={blocked || item.status === 'analyzing'} onClick={() => perform(async () => { await api(`/api/templates/${item.id}`, { method: 'DELETE' }); setSelected(null); }, '正在删除模板…')}><Trash2 size={14} />删除模板</button></div>{item.error && <p className="form-error">{item.error}</p>}
        <p className="mode-hint">检查或修改以下描述后保存，再选择用于创作。未知的细节可以留空。</p>
        {Object.entries(labels).map(([key, label]) => <label className="template-profile-field" key={key}>{label}<textarea aria-label={`模板${label}`} maxLength={500} value={profile[key]} disabled={blocked || item.status === 'analyzing'} onChange={event => setProfile(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        {dirty && <p className="mode-hint">描述有未保存的修改，请先保存后再用于创作。</p>}<div className="template-buttons"><button className="light-button" disabled={blocked || item.status === 'analyzing'} onClick={() => perform(() => api(`/api/templates/${item.id}`, { method: 'PATCH', body: JSON.stringify({ profile }) }), '正在保存描述…')}>保存参考描述</button><button className="primary-small" disabled={blocked || dirty || item.status !== 'ready' || !item.profile} onClick={() => onUse(item)}><Check size={14} />用于创作</button></div>
      </div>}
    </div>
  </section>;
}
