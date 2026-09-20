import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { deleteUserMemory, getUserMemory, saveUserMemory, setUserMemoryEnabled, type UserMemorySection, type UserMemoryState } from "../../lib/tauri-bridge";

const EMPTY: UserMemoryState = { version: 3, enabled: true, sections: [] };

export function PersonalizationSettings() {
  const [state, setState] = useState(EMPTY);
  const [editing, setEditing] = useState<UserMemorySection | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastUpdated = useMemo(() => state.sections.reduce<string | null>((latest, section) => !latest || section.updatedAt > latest ? section.updatedAt : latest, null), [state.sections]);
  const refresh = useCallback(async () => { try { setState(await getUserMemory()); setError(null); } catch (reason) { setError(String(reason)); } finally { setLoading(false); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!editing) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) cancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editing, saving]);
  const beginEdit = (section: UserMemorySection | "new") => { setEditing(section); setTitle(section === "new" ? "" : section.title); setContent(section === "new" ? "" : section.content); };
  const cancel = () => { setEditing(null); setTitle(""); setContent(""); };
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!title.trim() || !content.trim()) return; setSaving(true); try { setState(await saveUserMemory({ sectionId: editing === "new" ? undefined : editing?.id, title, content })); cancel(); setError(null); } catch (reason) { setError(String(reason)); } finally { setSaving(false); } };

  return <>
    <header className="settings-page-header"><h1>记忆摘要</h1><p>{lastUpdated ? `更新于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastUpdated))}` : "初始为空 · 标题和内容均可自定义"}</p></header>
    <div className="settings-card personalization-status-card"><div className="settings-card-copy"><h2>使用记忆</h2><p>{state.enabled ? "Nova 会在每次新会话开始前读取这份用户档案。" : "记忆已停用，不会读取或更新用户档案。"}</p></div><button type="button" className={`personalization-toggle ${state.enabled ? "personalization-toggle-on" : ""}`} disabled={loading || saving} onClick={() => void setUserMemoryEnabled(!state.enabled).then(setState).catch((reason) => setError(String(reason)))}><span />{state.enabled ? "已开启" : "已停用"}</button></div>
    <section className="settings-card personalization-list-card memory-summary-card">
      <div className="personalization-list-header"><div className="settings-card-copy"><h2>用户档案</h2><p>Section 会根据你的身份和偏好自然生长，不使用固定分类。</p></div><button type="button" className="personalization-save" disabled={!state.enabled} onClick={() => beginEdit("new")}><Plus size={15} />新建 Section</button></div>
      {loading ? <div className="personalization-loading"><LoaderCircle size={16} /> 正在读取…</div> : state.sections.length === 0 ? <p className="personalization-empty">暂无 Section。你可以手动创建，Nova 也会在对话中遇到值得长期保留的信息时创建或更新。</p> : state.sections.map((section) => <section className="memory-summary-section" key={section.id}><div className="memory-summary-heading"><h3>{section.title}</h3><div className="personalization-actions"><button type="button" disabled={!state.enabled} onClick={() => beginEdit(section)} aria-label={`编辑${section.title}`}><Pencil size={14} /></button><button type="button" onClick={() => void deleteUserMemory(section.id).then(setState).catch((reason) => setError(String(reason)))} aria-label={`删除${section.title}`}><Trash2 size={14} /></button></div></div><p>{section.content}</p></section>)}
    </section>
    {editing && createPortal(<div className="personalization-modal-backdrop" onMouseDown={() => { if (!saving) cancel(); }}><form className="personalization-form personalization-modal" role="dialog" aria-modal="true" aria-labelledby="personalization-modal-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}><div className="personalization-modal-header"><span className="personalization-modal-icon"><Sparkles size={17} /></span><div><h2 id="personalization-modal-title">{editing === "new" ? "添加一条记忆" : "编辑记忆"}</h2><p>Nova 会在之后的对话中记住这些信息</p></div><button type="button" className="personalization-modal-close" disabled={saving} onClick={cancel} aria-label="关闭"><X size={16} /></button></div><div className="personalization-modal-fields"><label><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：我的工作偏好" maxLength={80} autoFocus /></label><label><span>内容 <small>{content.length}/4000</small></span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="写下希望 Nova 长期记住的信息…" rows={5} maxLength={4000} /></label></div>{error && <p className="personalization-error">{error}</p>}<div className="personalization-modal-actions"><button type="button" className="personalization-cancel" disabled={saving} onClick={cancel}>取消</button><button className="personalization-save" type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving ? <LoaderCircle size={15} /> : <Plus size={15} />}{editing === "new" ? "添加记忆" : "保存更改"}</button></div></form></div>, document.body)}
    {!editing && error && <p className="personalization-error">{error}</p>}
  </>;
}
