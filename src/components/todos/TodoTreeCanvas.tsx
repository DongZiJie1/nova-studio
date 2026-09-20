import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, CircleDot, FolderKanban, Hourglass, Plus } from "lucide-react";
import type { TodoItem, CreateTodoInput } from "../../lib/tauri-bridge";
import { blockersOf, layoutTopic, STATE_LABEL, taskState, topicOf } from "./task-graph";

export function TaskStatusIcon({ state }: { state: ReturnType<typeof taskState> }) {
  const Icon =
    state === "completed" ? Check : state === "in_progress" ? CircleDot : state === "blocked" ? Hourglass : Circle;
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
    return [...map].filter(
      ([, group]) =>
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
          <p>把一个目标拆成步骤，连接下一步，也可以并行推进。</p>
          <button className="todo-primary-button" onClick={() => onCreate({})}>
            <Plus size={16} />
            新建主题与首个任务
          </button>
        </div>
      ) : (
        <div className="task-forest" style={{ zoom }}>
          {groups.map(([key, group]) => (
            <TopicTree
              key={key}
              label={group.label}
              items={group.items}
              allItems={items}
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
  allItems,
  collapsed,
  onCollapse,
  onOpen,
  onCreate,
  onToggle,
  busy,
}: {
  label: string;
  items: TodoItem[];
  allItems: TodoItem[];
  collapsed: boolean;
  onCollapse: () => void;
  onOpen: Props["onOpen"];
  onCreate: Props["onCreate"];
  onToggle: Props["onToggle"];
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const markerId = `arrow-${useId().replace(/:/g, "")}`;
  const graph = useMemo(() => layoutTopic(items, expanded), [items, expanded]);
  const completed = items.filter((todo) => todo.status === "completed").length;
  return (
    <section
      className={`task-topic ${collapsed ? "task-topic-collapsed" : ""}`}
      style={{ width: collapsed ? 260 : graph.width + 24 }}
    >
      <header className="task-topic-header">
        <FolderKanban size={21} />
        <div>
          <h2>{label}</h2>
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
            <svg className="task-edges" width={graph.width} height={graph.height} aria-hidden="true">
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const from = graph.nodes.find((node) => node.todo.id === edge.from)!;
                const to = graph.nodes.find((node) => node.todo.id === edge.to)!;
                const x1 = from.x + 118;
                const y1 = from.y + from.height;
                const x2 = to.x + 118;
                const y2 = to.y - 6;
                // For edges skipping a level, route in the outside gutter instead of through cards.
                const skipsRow = graph.nodes.some((node) => node.y > from.y && node.y < to.y);
                const rowBottom = Math.max(
                  ...graph.nodes.filter((node) => node.y === from.y).map((node) => node.y + node.height),
                );
                const route = skipsRow
                  ? `M ${x1} ${y1} V ${y1 + 18} H 7 V ${y2 - 18} H ${x2} V ${y2}`
                  : `M ${x1} ${y1} V ${(rowBottom + y2) / 2} H ${x2} V ${y2}`;
                return <path key={`${edge.from}-${edge.to}`} d={route} markerEnd={`url(#${markerId})`} />;
              })}
            </svg>
            {graph.nodes.map(({ todo, x, y, height, children }) => {
              const state = taskState(todo, allItems);
              const blockers = blockersOf(todo, allItems);
              const external = (todo.dependsOn ?? [])
                .map((id) => allItems.find((item) => item.id === id))
                .filter(
                  (item) => item && (item.parentId || topicOf(item).toLocaleLowerCase() !== label.toLocaleLowerCase()),
                );
              return (
                <article
                  className={`task-node task-node-${state}`}
                  style={{ left: x, top: y, height }}
                  key={todo.id}
                  data-todo-id={todo.id}
                >
                  <div className="task-node-heading">
                    <button
                      className={`task-status task-status-${state}`}
                      disabled={busy || (todo.status !== "completed" && blockersOf(todo, allItems, true).length > 0)}
                      aria-label={`${todo.status === "completed" ? "重新打开" : "完成"}：${todo.title}`}
                      onClick={() => onToggle(todo)}
                    >
                      <TaskStatusIcon state={state} />
                    </button>
                    <button className="task-node-title" title={todo.title} onClick={() => onOpen(todo.id)}>
                      {todo.title}
                    </button>
                  </div>
                  <button
                    className="task-node-state"
                    title={blockers.map((item) => item.title).join("、")}
                    onClick={() => onOpen(todo.id)}
                  >
                    {STATE_LABEL[state]}
                    {blockers.length ? ` · ${blockers.length} 项` : ""}
                  </button>
                  <div className="task-node-meta">
                    {external.length
                      ? `关联前置：${external.map((item) => item!.title).join("、")}`
                      : todo.dueAt
                        ? `截止 ${todo.dueAt.slice(0, 10)}`
                        : children.length
                          ? `${children.filter((item) => item.status === "completed").length}/${children.length} 子任务完成`
                          : "点击标题查看详情与依赖"}
                  </div>
                  {children.length > 0 && (
                    <>
                      <button
                        className="task-children-toggle"
                        aria-expanded={expanded.has(todo.id)}
                        onClick={() =>
                          setExpanded((previous) => {
                            const next = new Set(previous);
                            if (next.has(todo.id)) next.delete(todo.id);
                            else next.add(todo.id);
                            return next;
                          })
                        }
                      >
                        {expanded.has(todo.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}子任务 ·{" "}
                        {children.length}
                      </button>
                      {expanded.has(todo.id) && (
                        <div className="task-children">
                          {children.map((child) => (
                            <button
                              key={child.id}
                              title={`${child.title} · ${STATE_LABEL[taskState(child, allItems)]}`}
                              onClick={() => onOpen(child.id)}
                            >
                              <TaskStatusIcon state={taskState(child, allItems)} />
                              <span>
                                {child.parentId !== todo.id ? "↳ " : ""}
                                {child.title}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <footer>
                    <button
                      disabled={busy}
                      onClick={() =>
                        onCreate({ topic: label, tags: todo.tags, dependsOn: [todo.id], parentId: todo.parentId })
                      }
                    >
                      <Plus size={12} />
                      下一步
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => onCreate({ topic: label, tags: todo.tags, parentId: todo.id })}
                    >
                      子任务
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        onCreate({
                          topic: label,
                          tags: todo.tags,
                          dependsOn: todo.dependsOn ?? [],
                          parentId: todo.parentId,
                        })
                      }
                    >
                      并行
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
