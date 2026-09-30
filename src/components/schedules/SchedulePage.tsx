import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ExternalLink,
  LoaderCircle,
  Play,
  Plus,
  Power,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteScheduledTask,
  listScheduledTasks,
  onScheduledTasksChanged,
  runScheduledTaskNow,
  setScheduledTaskEnabled,
  type ScheduledTask,
  type ScheduledTaskState,
} from "../../lib/tauri-bridge";
import { useScheduleStore } from "../../stores/schedule-store";
import {
  PERMISSION_LABELS,
  RUN_STATUS_LABELS,
  formatDateTime,
  formatRuleSummary,
} from "./schedule-rule";
import { CreateScheduleModal } from "./CreateScheduleModal";
import { ScheduleDetail } from "./ScheduleDetail";
import "./schedules.css";
import "../todos/task-trees.css";

interface SchedulePageProps {
  projects: Array<{ path: string; name: string }>;
  onOpenSession: (task: ScheduledTask) => void;
}

export function SchedulePage({ projects, onOpenSession }: SchedulePageProps) {
  const [state, setState] = useState<ScheduledTaskState>({ version: 1, items: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const revision = useScheduleStore((s) => s.revision);
  const markSchedulesChanged = useScheduleStore((s) => s.markSchedulesChanged);

  const refresh = useCallback(async () => {
    try {
      setState(await listScheduledTasks());
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    let unlisten: (() => void) | undefined;
    void onScheduledTasksChanged(() => markSchedulesChanged()).then((fn) => {
      unlisten = fn;
    });
    return () => {
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [refresh, markSchedulesChanged]);

  const mutate = async (action: () => Promise<ScheduledTaskState>) => {
    setBusy(true);
    try {
      setState(await action());
      markSchedulesChanged();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selected = useMemo(
    () => state.items.find((item) => item.id === selectedId) ?? null,
    [state.items, selectedId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return state.items.filter((item) => {
      if (!q) return true;
      return (
        item.title.toLocaleLowerCase().includes(q) ||
        item.prompt.toLocaleLowerCase().includes(q) ||
        (item.description ?? "").toLocaleLowerCase().includes(q)
      );
    });
  }, [state.items, query]);

  const enabledCount = state.items.filter((item) => item.enabled).length;

  return (
    <section className="todo-page task-page">
      <header className="task-page-header">
        <div>
          <span className="todo-eyebrow">NOVA SCHEDULES</span>
          <h1>
            定时任务 <small>{state.items.length}</small>
          </h1>
          <p>到点自动 spawn Nova 执行；独立权限与运行状态，应用关闭期间暂停触发。</p>
        </div>
        {state.items.length > 0 ? (
          <button className="todo-primary-button" disabled={busy || loading} onClick={() => setCreating(true)}>
            <Plus size={16} />
            新建定时任务
          </button>
        ) : null}
      </header>

      <div className="task-toolbar">
        <label className="todo-search">
          <Search size={16} />
          <input
            aria-label="搜索定时任务"
            placeholder="搜索定时任务…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button aria-label="清空搜索" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          ) : null}
        </label>
        <span className="task-summary">
          {enabledCount} 个启用中 · 共 {state.items.length} 个
        </span>
      </div>

      {error ? (
        <div className="schedule-error-banner" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="todo-empty">
          <LoaderCircle className="todo-spinner" />
          正在读取定时任务…
        </div>
      ) : filtered.length === 0 ? (
        <div className="todo-empty">
          <CalendarClock size={28} />
          {state.items.length === 0 ? (
            <>
              <strong>还没有定时任务</strong>
              <p>创建一个到点自动执行的 Nova 自动化，例如每日行业调研。</p>
              <button className="todo-primary-button" onClick={() => setCreating(true)}>
                <Plus size={16} />
                创建第一个定时任务
              </button>
            </>
          ) : (
            <strong>没有匹配的定时任务</strong>
          )}
        </div>
      ) : (
        <ul className="schedule-list">
          {filtered.map((task) => (
            <li key={task.id} className={`schedule-row${task.enabled ? "" : " schedule-row-disabled"}`}>
              <button
                type="button"
                className="schedule-row-main"
                onClick={() => setSelectedId(task.id)}
                aria-label={`查看 ${task.title}`}
              >
                <div className="schedule-row-title">
                  <strong>{task.title}</strong>
                  <span className={`schedule-chip schedule-chip-${task.lastRunStatus ?? "idle"}`}>
                    {task.lastRunStatus
                      ? RUN_STATUS_LABELS[task.lastRunStatus]
                      : task.enabled
                        ? "待触发"
                        : "已停用"}
                  </span>
                  <span className="schedule-chip schedule-chip-permission">
                    {PERMISSION_LABELS[task.permissionMode]}
                  </span>
                </div>
                <div className="schedule-row-meta">
                  <span>{formatRuleSummary(task.schedule)}</span>
                  <span>下次 {formatDateTime(task.nextRunAt)}</span>
                  <span title={task.projectPath}>{task.projectPath}</span>
                </div>
              </button>
              <div className="schedule-row-actions">
                <button
                  type="button"
                  className="task-toolbar-button"
                  disabled={busy}
                  title="立即执行"
                  onClick={() => void mutate(() => runScheduledTaskNow(task.id))}
                >
                  <Play size={14} />
                </button>
                <button
                  type="button"
                  className="task-toolbar-button"
                  disabled={busy}
                  title={task.enabled ? "停用" : "启用"}
                  onClick={() => void mutate(() => setScheduledTaskEnabled(task.id, !task.enabled))}
                >
                  <Power size={14} />
                </button>
                {task.lastAgentId ? (
                  <button
                    type="button"
                    className="task-toolbar-button"
                    title="打开会话"
                    onClick={() => onOpenSession(task)}
                  >
                    <ExternalLink size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="task-toolbar-button schedule-danger"
                  disabled={busy}
                  title="删除"
                  onClick={() => {
                    if (!window.confirm(`删除定时任务「${task.title}」？此操作不可恢复。`)) return;
                    void mutate(() => deleteScheduledTask(task.id));
                    if (selectedId === task.id) setSelectedId(null);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating || editing ? (
        <CreateScheduleModal
          editing={editing}
          projects={projects}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(next) => {
            setState(next);
            markSchedulesChanged();
            setCreating(false);
            setEditing(null);
          }}
          onError={setError}
        />
      ) : null}

      {selected ? (
        <ScheduleDetail
          task={selected}
          busy={busy}
          onClose={() => setSelectedId(null)}
          onEdit={() => setEditing(selected)}
          onRunNow={() => void mutate(() => runScheduledTaskNow(selected.id))}
          onToggle={() => void mutate(() => setScheduledTaskEnabled(selected.id, !selected.enabled))}
          onDelete={() => {
            if (!window.confirm(`删除定时任务「${selected.title}」？此操作不可恢复。`)) return;
            void mutate(() => deleteScheduledTask(selected.id));
            setSelectedId(null);
          }}
          onOpenSession={() => onOpenSession(selected)}
        />
      ) : null}
    </section>
  );
}
