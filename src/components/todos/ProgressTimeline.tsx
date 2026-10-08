import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProgressEntry, TodoItem } from "../../lib/tauri-bridge";

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

function sourceLabel(source: ProgressEntry["source"]): string {
  return source === "agent" ? "Nova" : "我";
}

/** Tauri/Rust Option serializes missing numbers as null — treat both as unset. */
function hasPercent(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function latestProgress(todo: TodoItem): ProgressEntry | undefined {
  return todo.progress?.[todo.progress.length - 1];
}

export function progressPercent(todo: TodoItem): number | undefined {
  for (let index = (todo.progress?.length ?? 0) - 1; index >= 0; index -= 1) {
    const percent = todo.progress[index].percent;
    if (hasPercent(percent)) return percent;
  }
  return undefined;
}

function ProgressBadge({ entry }: { entry: ProgressEntry }) {
  return (
    <span className={`todo-progress-badges todo-progress-badges-${entry.source}`}>
      {hasPercent(entry.percent) && <span className="todo-progress-percent">{entry.percent}%</span>}
      <span className="todo-progress-source">{sourceLabel(entry.source)}</span>
    </span>
  );
}

/**
 * Always-on percent slider. New checkpoints start at least at the previous
 * value (default previous+10) so the third entry cannot begin from 0 again.
 */
function PercentField({
  value,
  min,
  defaultStep = 10,
  onChange,
  label = "进度",
}: {
  value: number;
  min: number;
  defaultStep?: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Thumb and fill use absolute 0–100 track positions so they stay aligned.
  const position = Math.max(0, Math.min(100, value));

  const clampToTrack = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
      const next = Math.round(ratio * 100);
      onChange(Math.max(min, Math.min(100, next)));
    },
    [min, onChange],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      event.preventDefault();
      clampToTrack(event.clientX);
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, clampToTrack]);

  return (
    <div className="todo-percent">
      <div className="todo-percent-head">
        <span className="todo-percent-label">{label}</span>
        <div className="todo-percent-readout">
          <span className="todo-percent-value">{value}</span>
          <span className="todo-percent-unit">%</span>
        </div>
      </div>
      <div
        ref={trackRef}
        className={`todo-percent-track${dragging ? " is-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={100}
        aria-valuenow={value}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
          clampToTrack(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onChange(Math.min(100, value + 1));
          } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onChange(Math.max(min, value - 1));
          } else if (event.key === "Home") {
            event.preventDefault();
            onChange(min);
          } else if (event.key === "End") {
            event.preventDefault();
            onChange(100);
          }
        }}
      >
        <div className="todo-percent-rail">
          {min > 0 && <div className="todo-percent-locked" style={{ width: `${min}%` }} />}
          <div className="todo-percent-fill" style={{ width: `${position}%` }} />
        </div>
        <div className="todo-percent-thumb" style={{ left: `${position}%` }} />
      </div>
      <div className="todo-percent-foot">
        <span>{min > 0 ? `起点 ${min}%` : "起点 0%"}</span>
        <button
          type="button"
          className="todo-percent-bump"
          disabled={value >= 100}
          onClick={() => onChange(Math.min(100, value + defaultStep))}
        >
          +{defaultStep}%
        </button>
      </div>
    </div>
  );
}

function ProgressComposer({
  busy,
  previousPercent,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  previousPercent: number;
  onCancel: () => void;
  onSubmit: (content: string, percent: number) => Promise<void>;
}) {
  // Follow the timeline upward: open at previous+10 (or previous when already high).
  const [content, setContent] = useState("");
  const [percent, setPercent] = useState(() => Math.min(100, previousPercent === 0 ? 0 : previousPercent + 10));
  const [submitting, setSubmitting] = useState(false);
  const trimmed = content.trim();

  return (
    <div className="todo-progress-composer">
      <div className="todo-progress-composer-head">
        <strong>记录一次进展</strong>
        <span>追加，不覆盖历史</span>
      </div>
      <PercentField value={percent} min={previousPercent} onChange={setPercent} defaultStep={10} />
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
  onEdit: (content: string, percent: number) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const [percent, setPercent] = useState(() => (hasPercent(entry.percent) ? entry.percent : 0));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setContent(entry.content);
    setPercent(hasPercent(entry.percent) ? entry.percent : 0);
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
          <PercentField value={percent} min={0} onChange={setPercent} defaultStep={5} />
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
  onAppend: (content: string, percent: number) => Promise<void>;
  onEdit: (entryId: string, content: string, percent: number) => Promise<void>;
  onDelete: (entryId: string) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const entries = [...(todo.progress ?? [])].reverse();
  const percent = progressPercent(todo) ?? 0;
  const latest = latestProgress(todo);
  const visible = expanded ? entries : entries.slice(0, 5);

  return (
    <section className="todo-detail-section todo-detail-content-section todo-progress-section">
      <div className="todo-progress-heading">
        <span className="todo-detail-section-title">完成情况</span>
        <span className="todo-progress-count">{entries.length} 条进展</span>
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

      {percent > 0 && (
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
          previousPercent={percent}
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
          <p>每完成一段工作就记一笔，按时间留下推进过程。</p>
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
