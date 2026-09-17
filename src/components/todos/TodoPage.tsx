import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Inbox,
  ListTodo,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
  type CreateTodoInput,
  type TodoItem,
  type TodoPriority,
  type TodoState,
  type TodoStatus,
} from "../../lib/tauri-bridge";

type TodoView = "today" | "in_progress" | "pending" | "completed";

const EMPTY_STATE: TodoState = { version: 1, items: [] };

const VIEW_META: Array<{ id: TodoView; label: string; description: string; icon: typeof CalendarDays }> = [
  { id: "today", label: "今天", description: "今天到期的任务会集中在这里。", icon: CalendarDays },
  { id: "in_progress", label: "进行中", description: "Nova 正在推进的任务。", icon: Clock3 },
  { id: "pending", label: "待处理", description: "记录工作，并让 Nova 持续推进。", icon: Inbox },
  { id: "completed", label: "已完成", description: "完成的任务会归档在这里。", icon: CheckCircle2 },
];

const PRIORITY_LABEL: Record<TodoPriority, string> = { low: "低", medium: "中", high: "高" };
const PRIORITY_FILTERS: Array<{ value: TodoPriority | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "high", label: "高优先级" },
  { value: "medium", label: "中优先级" },
  { value: "low", label: "低优先级" },
];

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todoMatchesView(todo: TodoItem, view: TodoView): boolean {
  if (view === "today") return todo.status !== "completed" && todo.dueAt?.slice(0, 10) === localDateKey();
  return todo.status === view;
}

function dueLabel(value?: string): string | null {
  if (!value) return null;
  const key = value.slice(0, 10);
  if (key === localDateKey()) return "今天";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === localDateKey(tomorrow)) return "明天";
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

interface TodoPageProps {
  projects: Array<{ path: string; name: string }>;
  onRunTodo: (todo: TodoItem) => Promise<{ agentId: string; sessionId: string }>;
  onOpenSession: (todo: TodoItem) => void;
}

export function TodoPage({ projects, onRunTodo, onOpenSession }: TodoPageProps) {
  const [state, setState] = useState<TodoState>(EMPTY_STATE);
  const [view, setView] = useState<TodoView>("pending");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState<TodoPriority | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listTodos()
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        VIEW_META.map(({ id }) => [id, state.items.filter((todo) => todoMatchesView(todo, id)).length]),
      ) as Record<TodoView, number>,
    [state.items],
  );

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return state.items
      .filter((todo) => todoMatchesView(todo, view))
      .filter((todo) => priority === "all" || todo.priority === priority)
      .filter(
        (todo) =>
          !normalizedQuery ||
          `${todo.title}\n${todo.description}`.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
  }, [priority, query, state.items, view]);

  const selected = state.items.find((todo) => todo.id === selectedId) ?? null;
  const currentView = VIEW_META.find((item) => item.id === view) ?? VIEW_META[2];
  const completedCount = counts.completed;
  const completionRatio = state.items.length ? completedCount / state.items.length : 0;
  const filtered = Boolean(query.trim()) || priority !== "all";

  const runUpdate = async (input: Parameters<typeof updateTodo>[0]) => {
    setBusyId(input.id);
    try {
      setState(await updateTodo(input));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const removeTodo = async (todo: TodoItem) => {
    if (!window.confirm(`删除待办“${todo.title}”？此操作无法撤销。`)) return;
    setBusyId(todo.id);
    try {
      setState(await deleteTodo(todo.id));
      setSelectedId(null);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const runWithNova = async (todo: TodoItem) => {
    setBusyId(todo.id);
    try {
      const link = await onRunTodo(todo);
      setState(
        await updateTodo({
          id: todo.id,
          status: "in_progress",
          agentId: link.agentId,
          sessionId: link.sessionId,
        }),
      );
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="todo-page">
      <div className="todo-layout">
        <aside className="todo-rail">
          <header className="todo-rail-header">
            <span className="todo-eyebrow">NOVA TASKS</span>
            <h2>待办</h2>
          </header>

          <nav className="todo-views" aria-label="待办状态">
            {VIEW_META.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={view === id ? "todo-view-active" : ""}
                onClick={() => setView(id)}
              >
                <Icon size={15} />
                <span>{label}</span>
                <small>{counts[id]}</small>
              </button>
            ))}
          </nav>

          <div className="todo-rail-summary">
            <div className="todo-rail-summary-row">
              <strong>{state.items.length}</strong>
              <span>项任务 · 已完成 {completedCount}</span>
            </div>
            <div className="todo-rail-progress" role="presentation">
              <i style={{ width: `${Math.round(completionRatio * 100)}%` }} />
            </div>
          </div>
        </aside>

        <div className="todo-content">
          <div className="todo-content-inner">
            <header className="todo-page-header">
              <div className="todo-page-header-copy">
                <h1>
                  {currentView.label}
                  <span className="todo-header-count">{visibleItems.length}</span>
                </h1>
                <p>{currentView.description}</p>
              </div>
              <button type="button" className="todo-primary-button" onClick={() => setCreating(true)}>
                <Plus size={16} />
                新建待办
              </button>
            </header>

            <div className="todo-toolbar">
              <label className="todo-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索待办…"
                />
                {query && (
                  <button
                    type="button"
                    className="todo-search-clear"
                    onClick={() => setQuery("")}
                    aria-label="清空搜索"
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
              <div className="todo-priority-filter" role="group" aria-label="优先级筛选">
                {PRIORITY_FILTERS.map(({ value, label }) => (
                  <button
                    type="button"
                    key={value}
                    className={priority === value ? "todo-filter-active" : ""}
                    onClick={() => setPriority(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="todo-empty">
                <LoaderCircle className="todo-spinner" size={22} />
                <p>正在读取待办…</p>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="todo-empty">
                <span className="todo-empty-icon">
                  {filtered ? <Search size={22} /> : <ListTodo size={22} />}
                </span>
                <h3>{filtered ? "没有符合条件的待办" : "这里还没有待办"}</h3>
                <p>
                  {filtered
                    ? "换个关键词或优先级再试试。"
                    : view === "completed"
                      ? "完成的任务会归档到这里。"
                      : "创建一项工作，稍后也可以交给 Nova 处理。"}
                </p>
                {!filtered && view !== "completed" && (
                  <button type="button" className="todo-ghost-button" onClick={() => setCreating(true)}>
                    <Plus size={14} />
                    创建待办
                  </button>
                )}
              </div>
            ) : (
              <div className="todo-list">
                {visibleItems.map((todo) => {
                  const due = dueLabel(todo.dueAt);
                  const overdue =
                    Boolean(todo.dueAt) &&
                    (todo.dueAt as string).slice(0, 10) < localDateKey() &&
                    todo.status !== "completed";
                  const projectName =
                    projects.find((project) => project.path === todo.projectPath)?.name ??
                    todo.projectPath?.split(/[\\/]/).filter(Boolean).pop();
                  return (
                    <article
                      key={todo.id}
                      className={`todo-card ${selectedId === todo.id ? "todo-card-selected" : ""}`}
                      onClick={() => setSelectedId(todo.id)}
                    >
                      <button
                        type="button"
                        className={`todo-check todo-check-${todo.status}`}
                        disabled={busyId === todo.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void runUpdate({
                            id: todo.id,
                            status: todo.status === "completed" ? "pending" : "completed",
                          });
                        }}
                        aria-label={todo.status === "completed" ? "重新打开" : "标记完成"}
                      >
                        {todo.status === "completed" ? (
                          <Check size={13} />
                        ) : todo.status === "in_progress" ? (
                          <Clock3 size={12} />
                        ) : (
                          <Circle size={12} />
                        )}
                      </button>

                      <div className="todo-card-content">
                        <div className="todo-card-title-row">
                          <h3>{todo.title}</h3>
                          <span className={`todo-priority todo-priority-${todo.priority}`}>
                            {PRIORITY_LABEL[todo.priority]}
                          </span>
                        </div>
                        {todo.description && <p>{todo.description}</p>}
                        <div className="todo-card-meta">
                          {projectName && <span>{projectName}</span>}
                          {due && (
                            <span className={overdue ? "todo-overdue" : ""}>
                              <CalendarDays size={11} />
                              {overdue ? `已逾期 · ${due}` : due}
                            </span>
                          )}
                          {todo.status === "in_progress" && (
                            <span className="todo-running">
                              <Clock3 size={11} />
                              Nova 处理中
                            </span>
                          )}
                        </div>
                      </div>

                      <ChevronRight size={15} className="todo-card-arrow" />
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {selected && (
          <TodoDetail
            key={selected.id}
            todo={selected}
            projects={projects}
            busy={busyId === selected.id}
            onClose={() => setSelectedId(null)}
            onSave={(input) => runUpdate(input)}
            onDelete={() => void removeTodo(selected)}
            onRun={() => void runWithNova(selected)}
            onOpenSession={() => onOpenSession(selected)}
          />
        )}
      </div>

      {error && (
        <div className="todo-error">
          {error}
          <button type="button" onClick={() => setError(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {creating && (
        <CreateTodoModal
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={(next) => {
            setState(next);
            setCreating(false);
            setView("pending");
          }}
          onError={setError}
        />
      )}
    </section>
  );
}

function CreateTodoModal({
  projects,
  onClose,
  onCreated,
  onError,
}: {
  projects: TodoPageProps["projects"];
  onClose: () => void;
  onCreated: (state: TodoState) => void;
  onError: (error: string) => void;
}) {
  const [form, setForm] = useState<CreateTodoInput>({
    title: "",
    description: "",
    priority: "medium",
    projectPath: "",
    dueAt: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      onCreated(
        await createTodo({
          ...form,
          projectPath: form.projectPath || undefined,
          dueAt: form.dueAt || undefined,
        }),
      );
    } catch (reason) {
      onError(String(reason));
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="todo-modal-backdrop"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="todo-modal"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-modal-title"
      >
        <header>
          <span className="todo-modal-icon">
            <Plus size={16} />
          </span>
          <div>
            <h2 id="todo-modal-title">新建待办</h2>
            <p>记录下一件需要推进的工作。</p>
          </div>
          <button type="button" className="todo-icon-button" disabled={saving} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="todo-modal-fields">
          <label>
            <span>标题</span>
            <input
              autoFocus
              value={form.title}
              maxLength={120}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="需要完成什么？"
            />
          </label>
          <label>
            <span>
              描述 <small>{form.description.length}/4000</small>
            </span>
            <textarea
              value={form.description}
              maxLength={4000}
              rows={4}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="补充背景、目标或验收要求…"
            />
          </label>
          <div className="todo-modal-grid">
            <label>
              <span>优先级</span>
              <select
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value as TodoPriority })}
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
            <label>
              <span>截止日期</span>
              <input
                type="date"
                value={form.dueAt}
                onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
              />
            </label>
          </div>
          <label>
            <span>所属项目</span>
            <select
              value={form.projectPath}
              onChange={(event) => setForm({ ...form, projectPath: event.target.value })}
            >
              <option value="">不关联项目</option>
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <footer>
          <button type="button" className="todo-secondary-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="todo-primary-button" disabled={saving || !form.title.trim()}>
            {saving ? <LoaderCircle className="todo-spinner" size={15} /> : <Plus size={15} />}
            创建待办
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function TodoDetail({
  todo,
  projects,
  busy,
  onClose,
  onSave,
  onDelete,
  onRun,
  onOpenSession,
}: {
  todo: TodoItem;
  projects: TodoPageProps["projects"];
  busy: boolean;
  onClose: () => void;
  onSave: (input: {
    id: string;
    title: string;
    description: string;
    status: TodoStatus;
    priority: TodoPriority;
    projectPath: string;
    dueAt: string;
  }) => Promise<void>;
  onDelete: () => void;
  onRun: () => void;
  onOpenSession: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description);
  const [status, setStatus] = useState(todo.status);
  const [priority, setPriority] = useState(todo.priority);
  const [projectPath, setProjectPath] = useState(todo.projectPath ?? "");
  const [dueAt, setDueAt] = useState(todo.dueAt?.slice(0, 10) ?? "");

  const dirty =
    title !== todo.title ||
    description !== todo.description ||
    status !== todo.status ||
    priority !== todo.priority ||
    projectPath !== (todo.projectPath ?? "") ||
    dueAt !== (todo.dueAt?.slice(0, 10) ?? "");

  return (
    <aside className="todo-detail">
      <header>
        <div>
          <span className="todo-eyebrow">TASK DETAIL</span>
          <h2>待办详情</h2>
        </div>
        <button type="button" className="todo-icon-button" onClick={onClose} aria-label="关闭">
          <X size={16} />
        </button>
      </header>

      <div className="todo-detail-fields">
        <label>
          <span>标题</span>
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>描述</span>
          <textarea
            rows={4}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="暂无描述"
          />
        </label>
        <div className="todo-detail-grid">
          <label>
            <span>状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as TodoStatus)}>
              <option value="pending">待处理</option>
              <option value="in_progress">进行中</option>
              <option value="completed">已完成</option>
            </select>
          </label>
          <label>
            <span>优先级</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value as TodoPriority)}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
        <div className="todo-detail-grid">
          <label>
            <span>截止日期</span>
            <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
          </label>
          <label>
            <span>所属项目</span>
            <select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
              <option value="">不关联项目</option>
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

      </div>

      {/* Pinned above the footer so handing the task to Nova never hides below the fold. */}
      <div className="todo-detail-actions">
        {todo.sessionId ? (
          <button type="button" className="todo-agent-link" onClick={onOpenSession}>
            <Sparkles size={15} />
            <div>
              <strong>打开 Nova 会话</strong>
              <span>查看处理过程与结果</span>
            </div>
            <ChevronRight size={15} />
          </button>
        ) : (
          todo.status !== "completed" && (
            <button type="button" className="todo-run-button" disabled={busy || dirty} onClick={onRun}>
              <Sparkles size={15} />
              让 Nova 处理
            </button>
          )
        )}
        <div className="todo-detail-meta">
          <span>
            创建于 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(todo.createdAt))}
          </span>
          <span>来源：{todo.source === "agent" ? "Nova" : "手动创建"}</span>
        </div>
      </div>

      <footer>
        <button type="button" className="todo-delete-button" disabled={busy} onClick={onDelete}>
          <Trash2 size={14} />
          删除
        </button>
        <button
          type="button"
          className="todo-primary-button"
          disabled={busy || !dirty || !title.trim()}
          onClick={() => void onSave({ id: todo.id, title, description, status, priority, projectPath, dueAt })}
        >
          {busy ? <LoaderCircle className="todo-spinner" size={15} /> : <Check size={15} />}
          保存更改
        </button>
      </footer>
    </aside>
  );
}
