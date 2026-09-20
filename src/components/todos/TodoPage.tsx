import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Minus,
  Network,
  Maximize2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  FolderKanban,
  ListTodo,
  LoaderCircle,
  PenLine,
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
import { useTodoStore } from "../../stores/todo-store";
import { TodoTreeCanvas, TaskStatusIcon } from "./TodoTreeCanvas";
import { blockersOf, STATE_LABEL, taskState, topicOf } from "./task-graph";
import "./task-trees.css";
import { Markdown } from "../chat/Markdown";

const TODO_TAG_MAX = 24;
const TODO_TAGS_MAX = 5;

/**
 * Mirrors normalizeTodoTags in nova's todo-store.ts so the page never sends a
 * list the agent store would reject.
 */
function normalizeTags(tags: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().split(/\s+/).join(" ");
    if (!tag || [...tag].length > TODO_TAG_MAX) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length === TODO_TAGS_MAX) break;
  }
  return result;
}

/** Accepts “论文, 实验”, “论文、实验” and pasted lists with newlines or tabs. */
function parseTagInput(value: string): string[] {
  return normalizeTags(value.split(/[,，、\n\t]+/));
}

/** Stable per-tag hue so the same tag keeps the same colour everywhere. */
function tagHue(tag: string): number {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

/**
 * Chip editor shared by the create dialog and the detail panel: type a tag and
 * press Enter (or comma) to add it, click the × to drop one. Suggestions come
 * from the tags already in use so the vocabulary stays small.
 */
function TodoTagField({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selected = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  const options = suggestions.filter(
    (tag) =>
      !selected.has(tag.toLocaleLowerCase()) && tag.toLocaleLowerCase().includes(draft.trim().toLocaleLowerCase()),
  );
  const showSuggestions = suggestionsOpen && options.length > 0 && tags.length < TODO_TAGS_MAX;
  const activeOption = showSuggestions ? options[activeIndex] : undefined;

  const commit = (value: string) => {
    if (value.trim()) onChange(normalizeTags([...tags, ...parseTagInput(value)]));
    setDraft("");
    setActiveIndex(-1);
    setSuggestionsOpen(false);
  };

  return (
    <div className="todo-tag-field">
      <span>标签</span>
      <div className="todo-tag-editor">
        {tags.map((tag) => (
          <span
            key={tag}
            className="todo-tag todo-tag-editable"
            style={{ "--todo-tag-hue": tagHue(tag) } as CSSProperties}
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter((item) => item !== tag))}
              aria-label={`移除标签 ${tag}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          onFocus={() => setSuggestionsOpen(true)}
          disabled={tags.length >= TODO_TAGS_MAX}
          placeholder={tags.length >= TODO_TAGS_MAX ? `最多 ${TODO_TAGS_MAX} 个标签` : "添加标签，回车确认"}
          aria-label="添加标签"
          onChange={(event) => {
            setSuggestionsOpen(true);
            setActiveIndex(-1);
            const value = event.target.value;
            if (/[,，、\n]/.test(value)) commit(value);
            else setDraft(value);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
              event.preventDefault();
              setSuggestionsOpen(true);
              setActiveIndex(
                event.key === "ArrowDown"
                  ? (activeIndex + 1) % options.length
                  : activeIndex <= 0
                    ? options.length - 1
                    : activeIndex - 1,
              );
            } else if (event.key === "Escape" && showSuggestions) {
              event.preventDefault();
              event.stopPropagation();
              setSuggestionsOpen(false);
              setActiveIndex(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              commit(activeOption ?? draft);
            } else if (event.key === "Backspace" && !draft && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      {showSuggestions && (
        <div className="todo-tag-suggestions" id={listId} role="listbox" aria-label="已有标签">
          <div className="todo-tag-suggestions-heading" role="presentation">
            已有标签
          </div>
          {options.map((tag, index) => (
            <div
              key={tag}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={activeIndex === index}
              className="todo-tag-suggestion"
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(tag)}
            >
              <span className="todo-tag" style={{ "--todo-tag-hue": tagHue(tag) } as CSSProperties}>
                {tag}
              </span>
              <Plus size={13} aria-hidden="true" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface TodoPageProps {
  projects: Array<{ path: string; name: string }>;
  onRunTodo: (todo: TodoItem) => Promise<{ agentId: string; sessionId: string }>;
  onOpenSession: (todo: TodoItem) => void;
}

function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const selector =
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
    dialog.querySelector<HTMLElement>(selector)?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(selector)].filter(
        (element) => element.getClientRects().length > 0,
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}

export function TodoPage({ projects, onRunTodo, onOpenSession }: TodoPageProps) {
  const [state, setState] = useState<TodoState>({ version: 1, items: [] });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const [filter, setFilter] = useState("all");
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<Partial<CreateTodoInput> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useTodoStore((store) => store.revision);
  const detailRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const readGeneration = useRef(0);
  const mutationLock = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (mutationLock.current) return;
      const generation = ++readGeneration.current;
      void listTodos()
        .then((next) => {
          if (!cancelled && generation === readGeneration.current) setState(next);
        })
        .catch((reason) => {
          if (!cancelled) setError(String(reason));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [revision]);
  const mutate = async (operation: () => Promise<TodoState>) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    ++readGeneration.current;
    setBusy(true);
    try {
      setState(await operation());
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  };
  const selected = state.items.find((todo) => todo.id === selectedId);
  const topics = [...new Map(state.items.map((todo) => [topicOf(todo).toLocaleLowerCase(), topicOf(todo)])).values()];
  const tagSuggestions = [...new Set(state.items.flatMap((todo) => todo.tags ?? []))];
  const completed = state.items.filter((todo) => todo.status === "completed").length;
  const toggleTodo = (todo: TodoItem) =>
    void mutate(() => updateTodo({ id: todo.id, status: todo.status === "completed" ? "pending" : "completed" }));
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setSelectedId(null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [creating]);
  const visible = state.items
    .filter((todo) =>
      `${todo.title} ${todo.description} ${topicOf(todo)} ${todo.tags.join(" ")}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .filter(
      (todo) =>
        filter === "all" ||
        (filter === "today"
          ? todo.dueAt?.slice(0, 10) === localDateKey() && todo.status !== "completed"
          : taskState(todo, state.items) === filter),
    );
  return (
    <section ref={pageRef} className="todo-page task-page">
      <header className="task-page-header">
        <div>
          <span className="todo-eyebrow">NOVA TASKS</span>
          <h1>
            待办 <small>{state.items.length}</small>
          </h1>
          <p>每个主题，一条清晰的推进路径。</p>
        </div>
        <button className="todo-primary-button" disabled={busy || loading} onClick={() => setCreating({})}>
          <Plus size={16} />
          新建主题
        </button>
      </header>
      <div className="task-toolbar">
        <label className="todo-search">
          <Search size={16} />
          <input
            aria-label="搜索主题或任务"
            placeholder="搜索主题或任务…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="清空搜索" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </label>
        <span className="task-summary">
          {topics.length} 个主题 · 已完成 {completed} 项
        </span>
        <div className="task-view-switch">
          <button aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>
            <Network size={15} />
            主题树
          </button>
          <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            <ListTodo size={15} />
            列表
          </button>
        </div>
        {mode === "tree" ? (
          <button
            className="task-toolbar-button"
            onClick={() =>
              setCollapsed(collapsed.size ? new Set() : new Set(topics.map((topic) => topic.toLocaleLowerCase())))
            }
          >
            <Maximize2 size={15} />
            {collapsed.size ? "展开全部" : "折叠全部"}
          </button>
        ) : (
          <select aria-label="任务状态" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="today">今天到期</option>
            <option value="ready">可开始</option>
            <option value="in_progress">进行中</option>
            <option value="blocked">等待前置</option>
            <option value="completed">已完成</option>
          </select>
        )}
      </div>
      {loading ? (
        <div className="todo-empty">
          <LoaderCircle className="todo-spinner" />
          正在读取待办…
        </div>
      ) : mode === "tree" ? (
        <TodoTreeCanvas
          items={state.items}
          query={query}
          zoom={zoom}
          collapsed={collapsed}
          onCollapse={(topic) =>
            setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(topic)) next.delete(topic);
              else next.add(topic);
              return next;
            })
          }
          onOpen={setSelectedId}
          onCreate={setCreating}
          onToggle={toggleTodo}
          busy={busy}
        />
      ) : (
        <div className="task-flat-list">
          {visible.length === 0 && <div className="todo-empty">没有符合条件的任务</div>}
          {visible.map((todo) => (
            <article key={todo.id}>
              <button
                className={`task-status task-status-${taskState(todo, state.items)}`}
                disabled={busy || (todo.status !== "completed" && blockersOf(todo, state.items, true).length > 0)}
                aria-label={`切换完成状态：${todo.title}`}
                onClick={() => toggleTodo(todo)}
              >
                <TaskStatusIcon state={taskState(todo, state.items)} />
              </button>
              <button className="task-flat-title" onClick={() => setSelectedId(todo.id)}>
                <strong>{todo.title}</strong>
                <span>
                  {topicOf(todo)} · {STATE_LABEL[taskState(todo, state.items)]}
                  {todo.dueAt ? ` · ${todo.dueAt.slice(0, 10)}` : ""}
                </span>
              </button>
            </article>
          ))}
        </div>
      )}
      <footer className="task-canvas-footer">
        <div className="task-legend">
          {(["completed", "in_progress", "ready", "blocked"] as const).map((status) => (
            <span className={`task-status-${status}`} key={status}>
              <TaskStatusIcon state={status} />
              {STATE_LABEL[status]}
            </span>
          ))}
        </div>
        {mode === "tree" && (
          <div className="task-zoom">
            <button
              aria-label="适应画布"
              title="适应画布"
              onClick={() => {
                const viewport = pageRef.current?.querySelector<HTMLElement>(".task-canvas-scroll");
                const forest = pageRef.current?.querySelector<HTMLElement>(".task-forest");
                if (viewport && forest)
                  setZoom(
                    Math.max(
                      0.4,
                      Math.min(
                        1,
                        viewport.clientWidth / forest.scrollWidth,
                        viewport.clientHeight / forest.scrollHeight,
                      ),
                    ),
                  );
              }}
            >
              <Maximize2 size={15} />
            </button>
            <button
              aria-label="缩小画布"
              disabled={zoom <= 0.4}
              onClick={() => setZoom((value) => Math.max(0.4, value - 0.1))}
            >
              <Minus size={15} />
            </button>
            <button aria-label="恢复原始大小" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="放大画布"
              disabled={zoom >= 1.4}
              onClick={() => setZoom((value) => Math.min(1.4, value + 0.1))}
            >
              <Plus size={15} />
            </button>
          </div>
        )}
      </footer>
      {selected && (
        <div
          className="task-detail-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setSelectedId(null);
          }}
        >
          <TodoDetail
            panelRef={detailRef}
            todo={selected}
            items={state.items}
            projects={projects}
            tagSuggestions={tagSuggestions}
            busy={busy}
            open
            closing={false}
            onClose={() => setSelectedId(null)}
            onSave={(input) => mutate(() => updateTodo(input))}
            onDelete={() => {
              if (window.confirm(`删除“${selected.title}”？子任务将保留，相关依赖连线将移除。`))
                void mutate(async () => {
                  const next = await deleteTodo(selected.id);
                  setSelectedId(null);
                  return next;
                });
            }}
            onRun={() => {
              if (blockersOf(selected, state.items).length) {
                setError("请先完成前置任务");
                return;
              }
              void mutate(async () => {
                const link = await onRunTodo(selected);
                return updateTodo({ id: selected.id, status: "in_progress", ...link });
              });
            }}
            onOpenSession={() => onOpenSession(selected)}
          />
        </div>
      )}
      {error && (
        <div className="todo-error" role="alert">
          {error}
          <button aria-label="关闭错误提示" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {creating && (
        <CreateTodoModal
          seed={creating}
          items={state.items}
          projects={projects}
          tagSuggestions={tagSuggestions}
          onClose={() => setCreating(null)}
          onCreated={(next) => {
            ++readGeneration.current;
            setState(next);
            setCreating(null);
            setError(null);
          }}
          onError={setError}
        />
      )}
    </section>
  );
}

function TaskRelations({
  items,
  currentId,
  topic,
  parentId,
  dependsOn,
  onChange,
}: {
  items: TodoItem[];
  currentId?: string;
  topic: string;
  parentId: string;
  dependsOn: string[];
  onChange: (values: { topic?: string; parentId?: string; dependsOn?: string[] }) => void;
}) {
  const listId = useId();
  const [search, setSearch] = useState("");
  const candidates = items.filter((item) => item.id !== currentId);
  return (
    <div className="task-relations">
      <label>
        <span>主题</span>
        <input
          aria-label="主题名称"
          list={listId}
          maxLength={24}
          value={topic}
          onChange={(event) => onChange({ topic: event.target.value })}
          placeholder="默认使用第一个标签，无标签则归入未分类"
        />
        <datalist id={listId}>
          {[...new Set(items.map(topicOf))].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <label>
        <span>
          父任务 <small>拆解关系，不代表先后顺序</small>
        </span>
        <select value={parentId} onChange={(event) => onChange({ parentId: event.target.value })}>
          <option value="">独立任务</option>
          {candidates
            .filter(
              (item) =>
                topicOf(item).toLocaleLowerCase() === (topic || "未分类").trim().toLocaleLowerCase() ||
                item.id === parentId,
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
      <fieldset>
        <legend>
          前置任务 <small>全部完成后，才能开始本任务</small>
        </legend>
        <input
          aria-label="筛选前置任务"
          placeholder="搜索可关联的任务…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="task-dependency-options">
          {candidates
            .filter(
              (item) =>
                `${topicOf(item)} ${item.title}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
                dependsOn.includes(item.id),
            )
            .map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={dependsOn.includes(item.id)}
                  onChange={(event) =>
                    onChange({
                      dependsOn: event.target.checked
                        ? [...dependsOn, item.id]
                        : dependsOn.filter((id) => id !== item.id),
                    })
                  }
                />
                <span>
                  {item.title}
                  <small>
                    {topicOf(item)} · {STATE_LABEL[taskState(item, items)]}
                  </small>
                </span>
              </label>
            ))}
          {candidates.length === 0 && <p>暂无可关联的任务；独立任务无需设置前置。</p>}
        </div>
      </fieldset>
    </div>
  );
}

function CreateTodoModal({
  seed,
  items,
  projects,
  tagSuggestions,
  onClose,
  onCreated,
  onError,
}: {
  seed: Partial<CreateTodoInput>;
  items: TodoItem[];
  projects: TodoPageProps["projects"];
  tagSuggestions: string[];
  onClose: () => void;
  onCreated: (state: TodoState) => void;
  onError: (error: string) => void;
}) {
  const modalRef = useRef<HTMLFormElement>(null);
  useDialogFocus(modalRef);
  const [form, setForm] = useState<CreateTodoInput>({
    title: "",
    description: "",
    tags: [],
    priority: "medium",
    projectPath: "",
    dueAt: "",
    topic: "",
    parentId: "",
    dependsOn: [],
    ...seed,
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
          tags: form.tags ?? [],
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
        ref={modalRef}
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
            <h2 id="todo-modal-title">{seed.topic ? "添加任务" : "新建主题与任务"}</h2>
            <p>
              {seed.topic ? "设置任务内容，确认它与其他任务的关系。" : "填写主题和首个任务，开始一条新的推进路径。"}
            </p>
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
              <span>截止日期</span>
              <input
                type="date"
                value={form.dueAt}
                onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
              />
            </label>
          </div>
          <TaskRelations
            items={items}
            topic={form.topic || form.tags?.[0] || ""}
            parentId={form.parentId ?? ""}
            dependsOn={form.dependsOn ?? []}
            onChange={(values) => setForm({ ...form, ...values })}
          />
          <TodoTagField
            tags={form.tags ?? []}
            suggestions={tagSuggestions}
            onChange={(tags) => setForm({ ...form, tags })}
          />
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
  panelRef,
  todo,
  items,
  projects,
  tagSuggestions,
  busy,
  open,
  closing,
  onClose,
  onSave,
  onDelete,
  onRun,
  onOpenSession,
}: {
  panelRef: RefObject<HTMLElement | null>;
  todo: TodoItem;
  items: TodoItem[];
  projects: TodoPageProps["projects"];
  tagSuggestions: string[];
  busy: boolean;
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onSave: (input: {
    id: string;
    title: string;
    description: string;
    status: TodoStatus;
    priority: TodoPriority;
    tags: string[];
    projectPath: string;
    dueAt: string;
    topic: string;
    parentId: string;
    dependsOn: string[];
  }) => Promise<void>;
  onDelete: () => void;
  onRun: () => void;
  onOpenSession: () => void;
}) {
  useDialogFocus(panelRef);
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description);
  const [status, setStatus] = useState(todo.status);
  const priority = todo.priority;
  const [topic, setTopic] = useState(topicOf(todo));
  const [parentId, setParentId] = useState(todo.parentId ?? "");
  const [dependsOn, setDependsOn] = useState(todo.dependsOn ?? []);
  const [tags, setTags] = useState<string[]>(todo.tags ?? []);
  const [projectPath, setProjectPath] = useState(todo.projectPath ?? "");
  const [dueAt, setDueAt] = useState(todo.dueAt?.slice(0, 10) ?? "");
  const [editingDescription, setEditingDescription] = useState(false);

  useEffect(() => {
    setTitle(todo.title);
    setDescription(todo.description);
    setStatus(todo.status);
    setTopic(topicOf(todo));
    setParentId(todo.parentId ?? "");
    setDependsOn(todo.dependsOn ?? []);
    setTags(todo.tags ?? []);
    setProjectPath(todo.projectPath ?? "");
    setDueAt(todo.dueAt?.slice(0, 10) ?? "");
    setEditingDescription(false);
  }, [todo]);

  const dirty =
    title !== todo.title ||
    description !== todo.description ||
    status !== todo.status ||
    topic !== topicOf(todo) ||
    parentId !== (todo.parentId ?? "") ||
    dependsOn.join("\0") !== (todo.dependsOn ?? []).join("\0") ||
    tags.join("\u0000") !== (todo.tags ?? []).join("\u0000") ||
    projectPath !== (todo.projectPath ?? "") ||
    dueAt !== (todo.dueAt?.slice(0, 10) ?? "");
  const DetailStatusIcon = status === "completed" ? CheckCircle2 : status === "in_progress" ? Clock3 : Circle;

  return (
    <aside
      ref={panelRef}
      className={`todo-detail ${open ? "todo-detail-open" : ""} ${closing ? "todo-detail-closing" : ""}`}
      aria-hidden={!open}
      role="dialog"
      aria-modal="true"
      aria-label={todo.title}
    >
      <button type="button" className="todo-icon-button todo-detail-close" onClick={onClose} aria-label="关闭">
        <X size={16} />
      </button>

      <div className="todo-detail-fields" key={todo.id}>
        <section className="todo-detail-hero">
          <div className="todo-detail-hero-meta">
            <span className={`todo-detail-status todo-detail-status-${status}`}>
              {status === "pending" ? "待处理" : status === "in_progress" ? "进行中" : "已完成"}
            </span>
          </div>
          <h1>{todo.title}</h1>
        </section>

        <section className="todo-detail-section todo-detail-properties">
          <span className="todo-detail-section-title">任务属性</span>
          <div className="todo-detail-properties-grid">
            <label className="todo-property-field">
              <span>状态</span>
              <div className={`todo-property-control todo-property-status-${status}`}>
                <DetailStatusIcon className="todo-property-leading-icon" size={14} />
                <select value={status} onChange={(event) => setStatus(event.target.value as TodoStatus)}>
                  <option value="pending">待处理</option>
                  <option value="in_progress">进行中</option>
                  <option value="completed">已完成</option>
                </select>
                <ChevronDown className="todo-property-chevron" size={14} />
              </div>
            </label>
            <label className="todo-property-field">
              <span>截止日期</span>
              <div className="todo-property-control todo-property-date">
                <CalendarDays className="todo-property-leading-icon" size={14} />
                <input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
              </div>
            </label>
            <label className="todo-property-field">
              <span>所属项目</span>
              <div className="todo-property-control todo-property-project">
                <FolderKanban className="todo-property-leading-icon" size={14} />
                <select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
                  <option value="">不关联项目</option>
                  {projects.map((project) => (
                    <option key={project.path} value={project.path}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="todo-property-chevron" size={14} />
              </div>
            </label>
            <div className="todo-property-field todo-property-field-wide">
              <TodoTagField tags={tags} suggestions={tagSuggestions} onChange={setTags} />
            </div>
          </div>
        </section>

        <section className="todo-detail-section">
          <TaskRelations
            items={items}
            currentId={todo.id}
            topic={topic}
            parentId={parentId}
            dependsOn={dependsOn}
            onChange={(values) => {
              if (values.topic !== undefined) setTopic(values.topic);
              if (values.parentId !== undefined) setParentId(values.parentId);
              if (values.dependsOn !== undefined) setDependsOn(values.dependsOn);
            }}
          />
        </section>
        <section className="todo-detail-section todo-detail-content-section">
          <span className="todo-detail-section-title">任务内容</span>
          <label>
            <span>标题</span>
            <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className="todo-description-field">
            <div className="todo-description-heading">
              <span>描述</span>
              <div>
                <small>{description.length}/4000 · Markdown</small>
                <button type="button" onClick={() => setEditingDescription((value) => !value)}>
                  {editingDescription ? <Check size={12} /> : <PenLine size={12} />}
                  {editingDescription ? "完成编辑" : "编辑"}
                </button>
              </div>
            </div>
            {editingDescription ? (
              <div className="todo-description-editor">
                <textarea
                  autoFocus
                  rows={10}
                  maxLength={4000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="使用 Markdown 补充目标、要求或验收标准…"
                />
                <span>支持标题、列表、引用、链接、表格与代码块</span>
              </div>
            ) : (
              <div
                className={`todo-description-preview ${description ? "" : "todo-description-preview-empty"}`}
                role="button"
                tabIndex={0}
                onClick={() => setEditingDescription(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setEditingDescription(true);
                }}
              >
                {description ? (
                  <Markdown content={description} />
                ) : (
                  <span>
                    <PenLine size={15} />
                    点击添加任务描述，支持 Markdown
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="todo-detail-meta">
          <span>
            创建于 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(todo.createdAt))}
          </span>
          <i />
          <span>来源：{todo.source === "agent" ? "Nova" : "手动创建"}</span>
        </div>
      </div>

      <footer>
        <button type="button" className="todo-delete-button" disabled={busy} onClick={onDelete}>
          <Trash2 size={14} />
          删除
        </button>
        <div className="todo-detail-footer-actions">
          {todo.sessionId ? (
            <button type="button" className="todo-nova-button" disabled={busy} onClick={onOpenSession}>
              <Sparkles size={14} />
              Nova 会话
            </button>
          ) : (
            todo.status !== "completed" && (
              <button
                type="button"
                className="todo-nova-button"
                disabled={busy || dirty || blockersOf(todo, items).length > 0}
                title={dirty ? "请先保存当前更改" : "交给 Nova 处理"}
                onClick={onRun}
              >
                <Sparkles size={14} />
                Nova 协作
              </button>
            )
          )}
          <button
            type="button"
            className="todo-primary-button"
            disabled={busy || !dirty || !title.trim()}
            onClick={() =>
              void onSave({
                id: todo.id,
                title,
                description,
                status,
                priority,
                tags,
                projectPath,
                dueAt,
                topic,
                parentId,
                dependsOn,
              })
            }
          >
            {busy ? <LoaderCircle className="todo-spinner" size={15} /> : <Check size={15} />}
            保存更改
          </button>
        </div>
      </footer>
    </aside>
  );
}
