import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { Check, ImagePlus, RotateCcw, Trash2, UserRound, X } from "lucide-react";
import { useSettingsStore } from "../../stores/settings-store";

const VIEW_SIZE = 280;
const OUTPUT_SIZE = 256;
type SourceImage = { url: string; width: number; height: number; name: string };
type Position = { x: number; y: number };

function dimensions(source: SourceImage, zoom: number) {
  const scale = Math.max(VIEW_SIZE / source.width, VIEW_SIZE / source.height) * zoom;
  return { width: source.width * scale, height: source.height * scale, scale };
}

function clamp(position: Position, source: SourceImage, zoom: number): Position {
  const { width, height } = dimensions(source, zoom);
  return {
    x: Math.max((VIEW_SIZE - width) / 2, Math.min((width - VIEW_SIZE) / 2, position.x)),
    y: Math.max((VIEW_SIZE - height) / 2, Math.min((height - VIEW_SIZE) / 2, position.y)),
  };
}

async function crop(source: SourceImage, zoom: number, position: Position): Promise<string> {
  const image = new Image();
  image.src = source.url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理图片");
  const { scale } = dimensions(source, zoom);
  const size = VIEW_SIZE / scale;
  context.drawImage(image, (source.width - size) / 2 - position.x / scale, (source.height - size) / 2 - position.y / scale, size, size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return canvas.toDataURL("image/webp", 0.85);
}

export function AvatarSettings({ kind }: { kind: "user" | "nova" }) {
  const userAvatar = useSettingsStore((state) => state.userAvatar);
  const novaAvatar = useSettingsStore((state) => state.novaAvatar);
  const setUserAvatar = useSettingsStore((state) => state.setUserAvatar);
  const setNovaAvatar = useSettingsStore((state) => state.setNovaAvatar);
  const avatar = kind === "user" ? userAvatar : novaAvatar;
  const setAvatar = kind === "user" ? setUserAvatar : setNovaAvatar;
  const isNova = kind === "nova";
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; start: Position } | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("请选择 JPG、PNG 或 WebP 图片"); return; }
    if (file.size > 10 * 1024 * 1024) { setError("图片不能超过 10 MB"); return; }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法读取图片");
      setSource({ url, width: image.naturalWidth, height: image.naturalHeight, name: file.name });
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setError(null);
    } catch (reason) {
      URL.revokeObjectURL(url);
      setError(reason instanceof Error ? reason.message : "无法读取图片");
    }
  };

  const save = async () => {
    if (!source) return;
    setSaving(true);
    try {
      setAvatar(await crop(source, zoom, position));
      setSource(null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "头像保存失败");
    } finally {
      setSaving(false);
    }
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!source) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, start: position };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!source || !dragRef.current) return;
    setPosition(clamp({ x: dragRef.current.start.x + event.clientX - dragRef.current.x, y: dragRef.current.start.y + event.clientY - dragRef.current.y }, source, zoom));
  };
  const changeZoom = (next: number) => {
    if (!source) return;
    setZoom(next);
    setPosition((current) => clamp(current, source, next));
  };
  const metrics = source ? dimensions(source, zoom) : null;
  const left = metrics ? (VIEW_SIZE - metrics.width) / 2 + position.x : 0;
  const top = metrics ? (VIEW_SIZE - metrics.height) / 2 + position.y : 0;

  return <div className="avatar-settings">
    <section className={`avatar-profile-card ${isNova ? "avatar-profile-card-nova" : ""}`}>
      <div className="avatar-profile-visual"><div className="avatar-profile-current">{avatar ? <img src={avatar} alt={isNova ? "当前 Nova 头像" : "当前用户头像"} /> : isNova ? <img src="/images/nova-avatar-dark.jpg" alt="默认 Nova 头像" /> : <UserRound size={54} />}</div><span className="avatar-profile-badge">{isNova ? "NOVA 助手" : "我的头像"}</span></div>
      <div className="avatar-profile-content"><span className="avatar-profile-eyebrow">{isNova ? "助手形象" : "个人形象"}</span><h2>{isNova ? "设计 Nova 的头像" : "设置你的头像"}</h2><p>{isNova ? "为 Nova 选择一张图片，调整展示位置。保存后，对话和侧栏中的助手头像会同步更新。" : "上传一张照片，调整它在头像框里的位置。保存后，聊天中的用户头像会立即更新。"}</p><div className="avatar-profile-actions"><input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="avatar-settings-input" onChange={(event) => void choose(event)} aria-label={isNova ? "选择 Nova 头像图片" : "选择用户头像图片"} /><button type="button" className="avatar-settings-upload" onClick={() => inputRef.current?.click()}><ImagePlus size={17} />{avatar ? "更换图片" : "上传图片"}</button>{avatar && <button type="button" className="avatar-settings-remove" onClick={() => { setAvatar(null); setError(null); }}><Trash2 size={15} />恢复默认</button>}</div><small>支持 JPG、PNG、WebP，最大 10 MB · 仅保存在这台设备</small></div>
    </section>
    {source && metrics && <section className="avatar-editor-card" aria-label={isNova ? "调整 Nova 头像" : "调整用户头像"}>
      <div className="avatar-editor-heading"><div><span className="avatar-profile-eyebrow">调整头像</span><h2>拖动图片，选好头像位置</h2><p title={source.name}>{source.name}</p></div><button type="button" className="avatar-editor-close" onClick={() => setSource(null)} aria-label="取消调整"><X size={18} /></button></div>
      <div className="avatar-editor-body"><div className="avatar-editor-workspace"><div className="avatar-editor-viewport" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} aria-label="拖动图片调整头像位置"><img src={source.url} alt="待调整的头像" draggable={false} style={{ width: metrics.width, height: metrics.height, left, top }} /><div className="avatar-editor-frame" /></div><span>拖动图片，将想展示的部分放入头像框</span></div><div className="avatar-editor-tools"><label htmlFor="avatar-zoom">缩放 <strong>{Math.round(zoom * 100)}%</strong></label><input id="avatar-zoom" type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))} /><div className="avatar-editor-zoom-labels"><span>缩小</span><span>放大</span></div><button type="button" className="avatar-editor-reset" onClick={() => { setZoom(1); setPosition({ x: 0, y: 0 }); }}><RotateCcw size={14} />重置位置</button><div className="avatar-editor-preview"><span>头像框预览</span><div className="avatar-editor-preview-image"><img src={source.url} alt="头像预览" draggable={false} style={{ width: metrics.width * 0.22, height: metrics.height * 0.22, left: left * 0.22, top: top * 0.22 }} /></div></div></div></div>
      <div className="avatar-editor-footer"><button type="button" className="avatar-editor-cancel" onClick={() => setSource(null)}>取消</button><button type="button" className="avatar-editor-save" onClick={() => void save()} disabled={saving}><Check size={16} />{saving ? "保存中…" : "保存头像"}</button></div>
    </section>}
    {error && <p className="avatar-settings-error" role="alert">{error}</p>}
  </div>;
}
