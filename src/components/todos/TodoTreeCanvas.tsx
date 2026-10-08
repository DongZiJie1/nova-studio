import { useMemo } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  FolderKanban,
  Plus,
} from "lucide-react";
import type { TodoItem, CreateTodoInput } from "../../lib/tauri-bridge";
import {
  deadlineDeltaDays,
  deadlineTone,
  sortTopicsByUrgency,
  layoutTopic,
  STATE_LABEL,
  taskState,
  topicOf,
} from "./task-graph";

export function TodoDeadline({ dueAt, completed = false }: { dueAt?: string; completed?: boolean }) {
  if (!dueAt) return null;
  const date = dueAt.slice(0, 10);
  const tone = deadlineTone(dueAt, completed);
  const overdue = tone === "overdue";
  const lateDays = overdue ? deadlineDeltaDays(dueAt, completed) : null;
  return (
    <span
      className={`task-deadline task-deadline-${tone}`}
      title={overdue ? `截止日期 ${date}，已逾期 ${lateDays ?? 0} 天` : `截止日期 ${date}`}
    >
      {overdue ? <AlertTriangle size={14} aria-hidden="true" /> : <CalendarDays size={14} aria-hidden="true" />}
      {overdue ? (
        <span>
          已逾期{lateDays && lateDays > 0 ? ` ${lateDays} 天` : ""} · <time dateTime={date}>{date}</time>
        </span>
      ) : (
        <span>
          截止 <time dateTime={date}>{date}</time>
        </span>
      )}
    </span>
  );
}

export function TaskStatusIcon({ state }: { state: ReturnType<typeof taskState> }) {
  const Icon = state === "completed" ? Check : state === "in_progress" ? CircleDot : Circle;
  return <Icon size={18} aria-hidden="true" />;
}

interface Props {
  items: TodoItem[];
  query: string;
  zoom: number;
  collapsed: Set<string>;
  onCollapse: (topic: string) => void;
  onOpen: (id: string) => void;
  onCreate: (seed: Partial<CreateTodoInput>) => void;
  onToggle: (todo: TodoItem) => void;
  busy: boolean;
}

export function TodoTreeCanvas({ items, query, zoom, collapsed, onCollapse, onOpen, onCreate, onToggle, busy }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: TodoItem[] }>();
    for (const todo of items) {
      const label = topicOf(todo);
      const key = label.toLocaleLowerCase();
      const group = map.get(key) ?? { label, items: [] };
      group.items.push(todo);
      map.set(key, group);
    }
    const normalized = query.trim().toLocaleLowerCase();
    return sortTopicsByUrgency([...map].map(([key, group]) => ({ key, ...group }))).filter(
      (group) =>
        !normalized ||
        `${group.label} ${group.items.map((todo) => `${todo.title} ${todo.description} ${todo.tags.join(" ")}`).join(" ")}`
          .toLocaleLowerCase()
          .includes(normalized),
    );
  }, [items, query]);
  return (
    <div className="task-canvas-scroll">
      {groups.length === 0 ? (
        <div className="todo-empty">
          <FolderKanban size={32} />
          <h3>{query ? "没有匹配的主题或任务" : "从第一个主题开始"}</h3>
          <p>按主题整理任务，一条线索就能看清进度。</p>
          <button className="todo-primary-button" onClick={() => onCreate({})}>
            <Plus size={16} />
            新建主题与首个任务
          </button>
        </div>
      ) : (
        <div className="task-forest" style={{ zoom }}>
          {groups.map(({ key, ...group }) => (
            <TopicTree
              key={key}
              label={group.label}
              items={group.items}
              collapsed={collapsed.has(key)}
              onCollapse={() => onCollapse(key)}
              onOpen={onOpen}
              onCreate={onCreate}
              onToggle={onToggle}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TopicTree({
  label,
  items,
  collapsed,
  onCollapse,
  onOpen,
  onCreate,
  onToggle,
  busy,
}: {
  label: string;
  items: TodoItem[];
  collapsed: boolean;
  onCollapse: () => void;
  onOpen: Props["onOpen"];
  onCreate: Props["onCreate"];
  onToggle: Props["onToggle"];
  busy: boolean;
}) {
  const graph = useMemo(() => layoutTopic(items), [items]);
  const completed = items.filter((todo) => todo.status === "completed").length;
  const now = new Date();
  const overdueCount = items.filter((todo) =>
    deadlineTone(todo.dueAt, todo.status === "completed", now) === "overdue",
  ).length;
  const warningCount = items.filter((todo) =>
    deadlineTone(todo.dueAt, todo.status === "completed", now) === "warning",
  ).length;
  return (
    <section
      className={`task-topic ${collapsed ? "task-topic-collapsed" : ""}`}
      style={{ width: collapsed ? 260 : graph.width + 24 }}
    >
      <header className="task-topic-header">
        <FolderKanban size={21} />
        <div>
          <h2 className="task-topic-title">
            {label}
            {overdueCount > 0 && (
              <span
                className="task-topic-warning-count task-topic-overdue-count"
                role="status"
                aria-label={`${label}：${overdueCount} 个已逾期待办`}
                title={`${overdueCount} 个未完成待办已过截止日期`}
              >
                {overdueCount} 逾期
              </span>
            )}
            <span
              className={`task-topic-warning-count ${warningCount > 0 ? "task-topic-warning-active" : ""}`}
              role="status"
              aria-label={`${label}：${warningCount} 个警告待办`}
              title={`${warningCount} 个未完成待办将在 10 天内截止`}
            >
              {warningCount} 警告
            </span>
          </h2>
          <span>
            {completed} / {items.length} 已完成
          </span>
        </div>
        <button aria-label={`${collapsed ? "展开" : "折叠"}${label}`} aria-expanded={!collapsed} onClick={onCollapse}>
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>
      </header>
      <div className="task-topic-progress">
        <i style={{ width: `${(completed / items.length) * 100}%` }} />
      </div>
      {!collapsed && (
        <>
          <div className="task-graph" style={{ width: graph.width, height: graph.height }}>
            {graph.nodes.map(({ todo, x, y, height }) => {
              const state = taskState(todo);
              const overdue = deadlineTone(todo.dueAt, todo.status === "completed", now) === "overdue";
              return (
                <article
                  className={`task-node task-node-${state}${overdue ? " task-node-overdue" : ""}`}
                  style={{ left: x, top: y, height }}
                  key={todo.id}
                  data-todo-id={todo.id}
                >
                  <div className="task-node-heading">
                    <button
                      className={`task-status task-status-${state}`}
                      disabled={busy}
                      aria-label={`${todo.status === "completed" ? "重新打开" : "完成"}：${todo.title}`}
                      onClick={() => onToggle(todo)}
                    >
                      <TaskStatusIcon state={state} />
                    </button>
                    <button className="task-node-title" title={todo.title} onClick={() => onOpen(todo.id)}>
                      {todo.title}
                    </button>
                  </div>
                  <button className="task-node-state" onClick={() => onOpen(todo.id)}>
                    {STATE_LABEL[state]}
                  </button>
                  <div className="task-node-meta">
                    {(() => {
                      const latest = todo.progress?.[todo.progress.length - 1];
                      const percent = [...(todo.progress ?? [])].reverse().find((entry) => typeof entry.percent === "number")?.percent;
                      if (!latest && !todo.dueAt) return "点击标题查看详情";
                      return (
                        <>
                          {typeof percent === "number" && (
                            <>
                              <i className="task-node-progress" style={{ width: `${percent}%` }} />
                              <span className="task-node-progress-label">
                                {percent}% · {latest?.source === "agent" ? "Nova" : "我"}
                              </span>
                            </>
                          )}
                          {latest && (
                            <span className="task-node-latest" title={latest.content}>
                              {latest.content.slice(0, 18)}
                            </span>
                          )}
                          {todo.dueAt && <TodoDeadline dueAt={todo.dueAt} completed={todo.status === "completed"} />}
                        </>
                      );
                    })()}
                  </div>
                  <footer>
                    <button disabled={busy} onClick={() => onCreate({ topic: label, tags: todo.tags })}>
                      <Plus size={12} />
                      添加任务
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
          <button
            className="task-add"
            disabled={busy}
            onClick={() => onCreate({ topic: label, tags: label === "未分类" ? [] : [label] })}
          >
            <Plus size={15} />
            添加任务
          </button>
        </>
      )}
    </section>
  );
}
