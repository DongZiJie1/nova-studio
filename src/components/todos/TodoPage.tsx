import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Minus,
  Network,
  Maximize2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  FileText,
  FolderKanban,
  ListTodo,
  LoaderCircle,
  PenLine,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  appendTodoProgress,
  createTodo,
  deleteTodo,
  deleteTodoProgress,
  editTodoProgress,
  listTodos,
  updateTodo,
  type CreateTodoInput,
  type TodoItem,
  type TodoPriority,
  type TodoState,
  type TodoStatus,
} from "../../lib/tauri-bridge";
import { useTodoStore } from "../../stores/todo-store";
import { TodoTreeCanvas, TaskStatusIcon, TodoDeadline } from "./TodoTreeCanvas";
import { compareTodoDeadline, deadlineTone, STATE_LABEL, taskState, topicOf } from "./task-graph";
import { latestProgress, ProgressTimeline, progressPercent } from "./ProgressTimeline";
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

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function formatDueDisplay(value: string): string {
  const date = parseDateKey(value);
  if (!date) return "选择日期";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * Sun-start weeks covering the month only. Trailing/leading weeks that fall
 * entirely outside the month are dropped so e.g. September never shows Oct 4–10.
 */
function buildMonthDays(year: number, month: number): Array<{ date: Date; inMonth: boolean }> {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const start = new Date(year, month, 1 - first.getDay());
  const end = new Date(year, month, last.getDate() + (6 - last.getDay()));
  const days: Array<{ date: Date; inMonth: boolean }> = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    days.push({ date, inMonth: date.getMonth() === month });
  }
  return days;
}

/** Portals must live inside the themed app root so [data-custom-background] / scene tokens apply. */
function themedPortalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-custom-background]") ?? document.body;
}

/**
 * Shared open/position/outside-dismiss behaviour for property popovers (date
 * calendar, status/project menus). Portals into the themed app root so scene
 * tokens and [data-custom-background] styles apply.
 */
function usePropertyPopover(
  open: boolean,
  setOpen: (value: boolean) => void,
  deps: unknown[],
  preferredWidth = 288,
) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(rect.width, preferredWidth);
      const height = popover?.offsetHeight || 280;
      const top = rect.bottom + 8 + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 8) : rect.bottom + 8;
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      setPosition({ top, left, width });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);

  return { triggerRef, popoverRef, position };
}

interface TodoSelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

/**
 * Theme-matched property menu. Native <select> popups fight Studio chrome the
 * same way input[type=date] does, so status / project share the calendar's
 * glass popover language.
 */
function TodoSelectField({
  value,
  options,
  onChange,
  controlClassName = "",
  placeholder = "未选择",
}: {
  value: string;
  options: TodoSelectOption[];
  onChange: (value: string) => void;
  controlClassName?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const { triggerRef, popoverRef, position } = usePropertyPopover(open, setOpen, [options.length, value], 220);
  const selected = options.find((option) => option.value === value);
  const listId = useId();

  const openMenu = () => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const commit = (option: TodoSelectOption) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="todo-date-field">
      <button
        ref={triggerRef}
        type="button"
        className={`todo-property-control ${controlClassName}${open ? " todo-property-control-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={placeholder}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openMenu();
            return;
          }
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) =>
              event.key === "ArrowDown" ? (index + 1) % options.length : index <= 0 ? options.length - 1 : index - 1,
            );
          } else if (event.key === "Enter" && options[activeIndex]) {
            event.preventDefault();
            commit(options[activeIndex]);
          }
        }}
      >
        {selected?.icon ?? options[0]?.icon}
        <span className={`todo-date-value${selected ? "" : " todo-date-value-empty"}`}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="todo-property-chevron" size={14} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              id={listId}
              className="todo-date-popover todo-select-popover"
              role="listbox"
              aria-label={placeholder}
              style={{ top: position.top, left: position.left, width: position.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`todo-select-option${index === activeIndex ? " todo-select-option-active" : ""}${isSelected ? " todo-select-option-selected" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(option)}
                  >
                    <span className="todo-select-option-label">
                      {option.icon}
                      {option.label}
                    </span>
                    {isSelected ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            themedPortalRoot(),
          )
        : null}
    </div>
  );
}

/**
 * Theme-matched due-date picker. The native input[type=date] calendar fights the
 * Studio chrome (especially inside Tauri), so this renders our own popover with
 * the same soft glass language as the rest of the todo UI.
 */
function TodoDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = parseDateKey(value);
  const today = new Date();
  const todayKey = localDateKey(today);
  const [viewYear, setViewYear] = useState(() => selected?.getFullYear() ?? today.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => selected?.getMonth() ?? today.getMonth());
  const { triggerRef, popoverRef, position } = usePropertyPopover(open, setOpen, [viewYear, viewMonth], 288);

  const openPicker = () => {
    const anchor = selected ?? new Date();
    setViewYear(anchor.getFullYear());
    setViewMonth(anchor.getMonth());
    setOpen(true);
  };

  const days = buildMonthDays(viewYear, viewMonth);
  const selectDate = (date: Date) => {
    onChange(localDateKey(date));
    setOpen(false);
    triggerRef.current?.focus();
  };
  const shiftMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  return (
    <div className="todo-date-field">
      <button
        ref={triggerRef}
        type="button"
        className={`todo-property-control todo-property-date${open ? " todo-property-control-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="截止日期"
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays className="todo-property-leading-icon" size={14} />
        <span className={`todo-date-value${value && selected ? "" : " todo-date-value-empty"}`}>{formatDueDisplay(value)}</span>
        <ChevronDown className="todo-property-chevron" size={14} />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              className="todo-date-popover"
              role="dialog"
              aria-label="选择截止日期"
              style={{ top: position.top, left: position.left, width: position.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="todo-date-header">
                <strong>
                  {viewYear}年 {viewMonth + 1}月
                </strong>
                <div className="todo-date-nav">
                  <button type="button" onClick={() => shiftMonth(-1)} aria-label="上一月">
                    <ChevronLeft size={15} />
                  </button>
                  <button type="button" onClick={() => shiftMonth(1)} aria-label="下一月">
                    <ChevronRight size={15} />
                  </button>
                </div>
              </header>
              <div className="todo-date-weekdays" aria-hidden="true">
                {["日", "一", "二", "三", "四", "五", "六"].map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className="todo-date-grid">
                {days.map(({ date, inMonth }) => {
                  const key = localDateKey(date);
                  const isSelected = Boolean(selected) && key === value;
                  const isToday = key === todayKey;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={[
                        "todo-date-day",
                        inMonth ? "" : "todo-date-day-outside",
                        isToday ? "todo-date-day-today" : "",
                        isSelected ? "todo-date-day-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-pressed={isSelected}
                      aria-label={formatDueDisplay(key)}
                      onClick={() => selectDate(date)}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
              <footer className="todo-date-footer">
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  清除
                </button>
                <button type="button" onClick={() => selectDate(today)}>
                  今天
                </button>
              </footer>
            </div>,
            themedPortalRoot(),
          )
        : null}
    </div>
  );
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
      useTodoStore.getState().markTodosChanged();
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
          : filter === "overdue"
            ? deadlineTone(todo.dueAt, todo.status === "completed") === "overdue"
            : taskState(todo) === filter),
    )
    .sort(compareTodoDeadline);
  return (
    <section ref={pageRef} className="todo-page task-page">
      <header className="task-page-header">
        <div>
          <span className="todo-eyebrow">NOVA TASKS</span>
          <h1>
            待办 <small>{state.items.length}</small>
          </h1>
          <p>未完成在前，已完成在后；按逾期 → 警告 → 临近 → 无日期排序。</p>
        </div>
        {state.items.length > 0 ? (
          <button className="todo-primary-button" disabled={busy || loading} onClick={() => setCreating({})}>
            <Plus size={16} />
            新建主题
          </button>
        ) : null}
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
            分栏
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
            <option value="overdue">已逾期</option>
            <option value="today">今天到期</option>
            <option value="ready">可开始</option>
            <option value="in_progress">进行中</option>
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
                className={`task-status task-status-${taskState(todo)}`}
                disabled={busy}
                aria-label={`切换完成状态：${todo.title}`}
                onClick={() => toggleTodo(todo)}
              >
                <TaskStatusIcon state={taskState(todo)} />
              </button>
              <button className="task-flat-title" onClick={() => setSelectedId(todo.id)}>
                <strong>{todo.title}</strong>
                <span>
                  {topicOf(todo)} · {STATE_LABEL[taskState(todo)]}
                  {progressPercent(todo) !== undefined ? ` · ${progressPercent(todo)}%` : ""}
                  {latestProgress(todo) ? ` · ${latestProgress(todo)?.source === "agent" ? "Nova" : "我"} · ${latestProgress(todo)?.content.slice(0, 24)}` : ""}
                </span>
                {progressPercent(todo) !== undefined && (
                  <i className="task-flat-progress" style={{ width: `${progressPercent(todo)}%` }} />
                )}
                <TodoDeadline dueAt={todo.dueAt} completed={todo.status === "completed"} />
              </button>
            </article>
          ))}
        </div>
      )}
      <footer className="task-canvas-footer">
        <div className="task-legend">
          {(["completed", "in_progress", "ready"] as const).map((status) => (
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
            onSave={(input) =>
              mutate(async () => {
                const next = await updateTodo(input);
                setSelectedId(null);
                return next;
              })
            }
            onDelete={() => {
              if (window.confirm(`删除“${selected.title}”？`))
                void mutate(async () => {
                  const next = await deleteTodo(selected.id);
                  setSelectedId(null);
                  return next;
                });
            }}
            onRun={(input) => {
              // Persist the draft first so Nova always starts from what the panel shows,
              // instead of the last saved snapshot.
              void mutate(async () => {
                const saved = await updateTodo(input);
                const item = saved.items.find((entry) => entry.id === input.id) ?? selected;
                const link = await onRunTodo(item);
                return updateTodo({ id: item.id, status: "in_progress", ...link });
              });
            }}
            onOpenSession={() => onOpenSession(selected)}
            onAppendProgress={(content, percent) =>
              mutate(async () => appendTodoProgress({ id: selected.id, content, percent, source: "user" }))
            }
            onEditProgress={(entryId, content, percent) =>
              mutate(async () => editTodoProgress({ id: selected.id, entryId, content, percent }))
            }
            onDeleteProgress={(entryId) => {
              void mutate(async () => deleteTodoProgress({ id: selected.id, entryId }));
            }}
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

function TopicField({
  items,
  topic,
  onChange,
}: {
  items: TodoItem[];
  topic: string;
  onChange: (topic: string) => void;
}) {
  const listId = useId();
  return (
    <label>
      <span>主题</span>
      <input
        aria-label="主题名称"
        list={listId}
        maxLength={24}
        value={topic}
        onChange={(event) => onChange(event.target.value)}
        placeholder="默认使用第一个标签，无标签则归入未分类"
      />
      <datalist id={listId}>
        {[...new Set(items.map(topicOf))].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </label>
  );
}

/**
 * Compact topic chip shown next to the detail title. Clicking turns it into an
 * inline input so the topic stays editable without a full form section.
 */
function TopicTag({
  items,
  topic,
  onChange,
}: {
  items: TodoItem[];
  topic: string;
  onChange: (topic: string) => void;
}) {
  const listId = useId();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <span className="todo-topic-tag todo-topic-tag-editing">
        <Tag className="todo-topic-tag-icon" size={13} aria-hidden="true" />
        <input
          autoFocus
          aria-label="主题名称"
          list={listId}
          maxLength={24}
          value={topic}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") setEditing(false);
          }}
        />
        <datalist id={listId}>
          {[...new Set(items.map(topicOf))].map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </span>
    );
  }

  return (
    <button type="button" className="todo-topic-tag" title="修改主题" onClick={() => setEditing(true)}>
      {topic || "未分类"}
      <Tag className="todo-topic-tag-icon" size={12} aria-hidden="true" />
      <PenLine className="todo-topic-tag-pen" size={11} aria-hidden="true" />
    </button>
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
              {seed.topic ? "设置任务内容与所属主题。" : "填写主题和第一个任务，开始一栏新的清单。"}
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
              描述 <small>{form.description.length}/50000</small>
            </span>
            <textarea
              value={form.description}
              maxLength={50000}
              rows={4}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="补充背景、目标或验收要求…"
            />
          </label>
          <div className="todo-modal-grid">
            <div className="todo-date-field-label">
              <span>截止日期</span>
              <TodoDateField value={form.dueAt ?? ""} onChange={(dueAt) => setForm({ ...form, dueAt })} />
            </div>
          </div>
          <TopicField
            items={items}
            topic={form.topic || form.tags?.[0] || ""}
            onChange={(topic) => setForm({ ...form, topic })}
          />
          <TodoTagField
            tags={form.tags ?? []}
            suggestions={tagSuggestions}
            onChange={(tags) => setForm({ ...form, tags })}
          />
          <div className="todo-date-field-label">
            <span>所属项目</span>
            <TodoSelectField
              value={form.projectPath ?? ""}
              controlClassName="todo-property-project"
              options={[
                {
                  value: "",
                  label: "不关联项目",
                  icon: <FolderKanban className="todo-property-leading-icon" size={14} />,
                },
                ...projects.map((project) => ({
                  value: project.path,
                  label: project.name,
                  icon: <FolderKanban className="todo-property-leading-icon" size={14} />,
                })),
              ]}
              onChange={(projectPath) => setForm({ ...form, projectPath })}
            />
          </div>
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

/** The editable copy of a todo held by the detail panel. */
interface TodoDraft {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  projectPath: string;
  dueAt: string;
  topic: string;
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
  onAppendProgress,
  onEditProgress,
  onDeleteProgress,
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
  onSave: (input: TodoDraft) => Promise<void>;
  onDelete: () => void;
  onRun: (input: TodoDraft) => void;
  onOpenSession: () => void;
  onAppendProgress: (content: string, percent: number | undefined) => Promise<void>;
  onEditProgress: (entryId: string, content: string, percent: number | undefined) => Promise<void>;
  onDeleteProgress: (entryId: string) => void;
}) {
  useDialogFocus(panelRef);
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(todo.description);
  const [status, setStatus] = useState(todo.status);
  const priority = todo.priority;
  const [topic, setTopic] = useState(topicOf(todo));
  const [tags, setTags] = useState<string[]>(todo.tags ?? []);
  const [projectPath, setProjectPath] = useState(todo.projectPath ?? "");
  const [dueAt, setDueAt] = useState(todo.dueAt?.slice(0, 10) ?? "");
  const [editingDescription, setEditingDescription] = useState(false);

  // Only re-seed the draft when the panel switches to another task. Depending on the
  // whole object also re-ran this on every background refresh (window focus, agent
  // writes), which silently discarded unsaved edits and greyed out the save button.
  useEffect(() => {
    setTitle(todo.title);
    setDescription(todo.description);
    setStatus(todo.status);
    setTopic(topicOf(todo));
    setTags(todo.tags ?? []);
    setProjectPath(todo.projectPath ?? "");
    setDueAt(todo.dueAt?.slice(0, 10) ?? "");
    setEditingDescription(false);
  }, [todo.id]);

  const dirty =
    title !== todo.title ||
    description !== todo.description ||
    status !== todo.status ||
    topic !== topicOf(todo) ||
    tags.join("\u0000") !== (todo.tags ?? []).join("\u0000") ||
    projectPath !== (todo.projectPath ?? "") ||
    dueAt !== (todo.dueAt?.slice(0, 10) ?? "");
  const draft: TodoDraft = { id: todo.id, title, description, status, priority, tags, projectPath, dueAt, topic };

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
            {deadlineTone(todo.dueAt, todo.status === "completed") === "overdue" && (
              <span className="todo-detail-overdue-badge" role="status">
                已逾期
              </span>
            )}
          </div>
          <div className="todo-detail-hero-title">
            <h1>{todo.title}</h1>
            <TopicTag items={items} topic={topic} onChange={setTopic} />
          </div>
        </section>

        <section className="todo-detail-section todo-detail-properties">
          <span className="todo-detail-section-title">任务属性</span>
          <div className="todo-detail-properties-grid">
            <div className="todo-property-field">
              <span>状态</span>
              <TodoSelectField
                value={status}
                controlClassName={`todo-property-status-${status}`}
                options={[
                  { value: "pending", label: "待处理", icon: <Circle className="todo-property-leading-icon" size={14} /> },
                  {
                    value: "in_progress",
                    label: "进行中",
                    icon: <Clock3 className="todo-property-leading-icon" size={14} />,
                  },
                  {
                    value: "completed",
                    label: "已完成",
                    icon: <CheckCircle2 className="todo-property-leading-icon" size={14} />,
                  },
                ]}
                onChange={(next) => setStatus(next as TodoStatus)}
              />
            </div>
            <div className="todo-property-field">
              <span>截止日期</span>
              <TodoDateField value={dueAt} onChange={setDueAt} />
            </div>
            <div className="todo-property-field">
              <span>所属项目</span>
              <TodoSelectField
                value={projectPath}
                controlClassName="todo-property-project"
                options={[
                  {
                    value: "",
                    label: "不关联项目",
                    icon: <FolderKanban className="todo-property-leading-icon" size={14} />,
                  },
                  ...projects.map((project) => ({
                    value: project.path,
                    label: project.name,
                    icon: <FolderKanban className="todo-property-leading-icon" size={14} />,
                  })),
                ]}
                onChange={setProjectPath}
              />
            </div>
            <div className="todo-property-field todo-property-field-wide">
              <TodoTagField tags={tags} suggestions={tagSuggestions} onChange={setTags} />
            </div>
          </div>
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
                <small>{description.length}/50000 · Markdown</small>
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
                  maxLength={50000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="使用 Markdown 补充目标、要求或验收标准…"
                />
                <span>支持标题、列表、引用、链接、表格与代码块</span>
              </div>
            ) : description ? (
              <div className="todo-description-preview">
                <span className="todo-description-preview-tag">
                  <FileText size={11} aria-hidden="true" />
                  Markdown 描述
                </span>
                <Markdown content={description} />
              </div>
            ) : (
              <div className="todo-description-preview todo-description-preview-empty">
                <span className="todo-description-empty-icon" aria-hidden="true">
                  <FileText size={18} />
                </span>
                <strong>还没有描述</strong>
                <p>用 Markdown 记录目标、验收标准或参考资料。</p>
                <button
                  type="button"
                  className="todo-description-empty-cta"
                  onClick={() => setEditingDescription(true)}
                >
                  <PenLine size={12} aria-hidden="true" />
                  添加描述
                </button>
              </div>
            )}
          </div>
        </section>

        <ProgressTimeline
          todo={todo}
          busy={busy}
          onAppend={onAppendProgress}
          onEdit={onEditProgress}
          onDelete={onDeleteProgress}
        />

        <section className="todo-detail-section todo-history-section">
          <span className="todo-detail-section-title">修改记录</span>
          {(todo.history ?? []).length === 0 ? (
            <p className="todo-history-empty">暂无截止日期或状态修改</p>
          ) : (
            <ol className="todo-history-list">
              {[...todo.history].reverse().map((entry, index) => {
                const statusLabel = (value: string | null) => value === "pending" ? "待处理" : value === "in_progress" ? "进行中" : value === "completed" ? "已完成" : "未设置";
                const isDueAt = entry.type === "due_at_changed";
                const from = isDueAt ? (entry.from || "未设置") : statusLabel(entry.from);
                const to = isDueAt ? (entry.to || "未设置") : statusLabel(entry.to);
                return (
                  <li key={`${entry.changedAt}-${index}`}>
                    <time dateTime={entry.changedAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.changedAt))}</time>
                    <span>{isDueAt ? "截止日期" : "状态"}：{from} → {to}</span>
                  </li>
                );
              })}
            </ol>
          )}
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
                disabled={busy || !title.trim()}
                title="交给 Nova 处理（未保存的修改会先保存）"
                onClick={() => onRun(draft)}
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
            onClick={() => void onSave(draft)}
          >
            {busy ? <LoaderCircle className="todo-spinner" size={15} /> : <Check size={15} />}
            保存更改
          </button>
        </div>
      </footer>
    </aside>
  );
}
