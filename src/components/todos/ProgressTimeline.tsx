import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProgressEntry, TodoItem } from "../../lib/tauri-bridge";

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

function sourceLabel(source: ProgressEntry["source"]): string {
  return source === "agent" ? "Nova" : "我";
}

export function latestProgress(todo: TodoItem): ProgressEntry | undefined {
  return todo.progress?.[todo.progress.length - 1];
}

export function progressPercent(todo: TodoItem): number | undefined {
  for (let index = (todo.progress?.length ?? 0) - 1; index >= 0; index -= 1) {
    const percent = todo.progress[index].percent;
    if (percent !== undefined) return percent;
  }
  return undefined;
}

function ProgressBadge({ entry }: { entry: ProgressEntry }) {
  return (
    <span className={`todo-progress-badges todo-progress-badges-${entry.source}`}>
      {entry.percent !== undefined && <span className="todo-progress-percent">{entry.percent}%</span>}
      <span className="todo-progress-source">{sourceLabel(entry.source)}</span>
    </span>
  );
}

function ProgressComposer({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (content: string, percent: number | undefined) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [percent, setPercent] = useState<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = content.trim();

  return (
    <div className="todo-progress-composer">
      <div className="todo-progress-composer-head">
        <strong>记录一次进展</strong>
        <span>追加，不覆盖历史</span>
      </div>
      <label className="todo-progress-percent-field">
        <span>进度</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent ?? 0}
          onChange={(event) => setPercent(Number(event.target.value))}
        />
        <button
          type="button"
          className={percent === undefined ? "todo-progress-percent-toggle" : "todo-progress-percent-toggle active"}
          onClick={() => setPercent(percent === undefined ? 0 : undefined)}
        >
          {percent === undefined ? "未设置" : `${percent}%`}
        </button>
      </label>
      <textarea
        rows={3}
        maxLength={5000}
        value={content}
        autoFocus
        onChange={(event) => setContent(event.target.value)}
        placeholder="这次完成了什么？支持 Markdown…"
      />
      <div className="todo-progress-composer-actions">
        <button type="button" disabled={submitting} onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="todo-progress-composer-submit"
          disabled={busy || submitting || !trimmed}
          onClick={() => {
            void (async () => {
              setSubmitting(true);
              try {
                await onSubmit(trimmed, percent);
                setContent("");
                setPercent(undefined);
              } finally {
                setSubmitting(false);
              }
            })();
          }}
        >
          {submitting ? <LoaderCircle className="todo-spinner" size={13} /> : <Plus size={13} />}
          追加记录
        </button>
      </div>
    </div>
  );
}

function ProgressEntryCard({
  entry,
  busy,
  onEdit,
  onDelete,
}: {
  entry: ProgressEntry;
  busy: boolean;
  onEdit: (content: string, percent: number | undefined) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const [percent, setPercent] = useState<number | undefined>(entry.percent);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setContent(entry.content);
    setPercent(entry.percent);
    setEditing(false);
  }, [entry]);

  return (
    <article className={`todo-progress-entry todo-progress-entry-${entry.source}`}>
      <header>
        <time dateTime={entry.at}>{TIME_FORMAT.format(new Date(entry.at))}</time>
        <ProgressBadge entry={{ ...entry, percent }} />
        {entry.editedAt && (
          <span className="todo-progress-edited" title={`修改于 ${TIME_FORMAT.format(new Date(entry.editedAt))}`}>
            已编辑
          </span>
        )}
        <span className="todo-progress-entry-actions">
          <button type="button" disabled={busy || submitting} onClick={() => setEditing((value) => !value)} aria-label="编辑进展">
            {editing ? <X size={12} /> : <Pencil size={12} />}
          </button>
          <button
            type="button"
            disabled={busy || submitting}
            onClick={() => {
              if (window.confirm("删除这条进展记录？")) onDelete();
            }}
            aria-label="删除进展"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </header>
      {editing ? (
        <div className="todo-progress-entry-editor">
          <textarea
            rows={3}
            maxLength={5000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            autoFocus
          />
          <label className="todo-progress-percent-field">
            <span>进度</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent ?? 0}
              onChange={(event) => setPercent(Number(event.target.value))}
            />
            <button
              type="button"
              className={percent === undefined ? "todo-progress-percent-toggle" : "todo-progress-percent-toggle active"}
              onClick={() => setPercent(percent === undefined ? (entry.percent ?? 0) : undefined)}
            >
              {percent === undefined ? "未设置" : `${percent}%`}
            </button>
          </label>
          <div className="todo-progress-composer-actions">
            <button type="button" disabled={submitting} onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="button"
              className="todo-progress-composer-submit"
              disabled={busy || submitting || !content.trim()}
              onClick={() => {
                void (async () => {
                  setSubmitting(true);
                  try {
                    await onEdit(content.trim(), percent);
                    setEditing(false);
                  } finally {
                    setSubmitting(false);
                  }
                })();
              }}
            >
              {submitting ? <LoaderCircle className="todo-spinner" size={13} /> : <Check size={13} />}
              保存这条
            </button>
          </div>
        </div>
      ) : (
        <div className="todo-progress-entry-content">{entry.content}</div>
      )}
    </article>
  );
}

export function ProgressTimeline({
  todo,
  busy,
  onAppend,
  onEdit,
  onDelete,
}: {
  todo: TodoItem;
  busy: boolean;
  onAppend: (content: string, percent: number | undefined) => Promise<void>;
  onEdit: (entryId: string, content: string, percent: number | undefined) => Promise<void>;
  onDelete: (entryId: string) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const entries = [...(todo.progress ?? [])].reverse();
  const percent = progressPercent(todo);
  const latest = latestProgress(todo);
  const visible = expanded ? entries : entries.slice(0, 5);

  return (
    <section className="todo-detail-section todo-detail-content-section todo-progress-section">
      <div className="todo-progress-heading">
        <span className="todo-detail-section-title">完成情况</span>
        <span className="todo-progress-count">
          {entries.length} 条进展 · 类似 commit 时间线
        </span>
        <button
          type="button"
          className="todo-progress-append-button"
          disabled={busy}
          onClick={() => setComposing(true)}
        >
          <Plus size={13} />
          记录进展
        </button>
      </div>

      {percent !== undefined && (
        <div className="todo-progress-bar-wrap">
          <div className="todo-progress-bar">
            <i style={{ width: `${percent}%` }} />
          </div>
          <div className="todo-progress-bar-meta">
            <span>
              最近更新 {latest ? TIME_FORMAT.format(new Date(latest.at)) : "—"}
              {latest ? ` · ${sourceLabel(latest.source)}` : ""}
            </span>
            <strong>{percent}%</strong>
          </div>
        </div>
      )}

      {composing && (
        <ProgressComposer
          busy={busy}
          onCancel={() => setComposing(false)}
          onSubmit={async (content, nextPercent) => {
            await onAppend(content, nextPercent);
            setComposing(false);
          }}
        />
      )}

      {entries.length === 0 ? (
        <div className="todo-progress-empty">
          <p>还没有进展记录。</p>
          <p>每完成一段工作就记一笔，像 git commit 一样留下时间线。</p>
        </div>
      ) : (
        <ol className="todo-progress-timeline">
          {visible.map((entry) => (
            <li key={entry.id}>
              <ProgressEntryCard
                entry={entry}
                busy={busy}
                onEdit={(content, nextPercent) => onEdit(entry.id, content, nextPercent)}
                onDelete={() => onDelete(entry.id)}
              />
            </li>
          ))}
        </ol>
      )}

      {entries.length > 5 && (
        <button type="button" className="todo-progress-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "收起" : `展开全部 ${entries.length} 条`}
        </button>
      )}
    </section>
  );
}
