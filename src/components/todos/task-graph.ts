import type { TodoItem } from "../../lib/tauri-bridge";

export const topicOf = (todo: TodoItem): string => todo.topic || todo.tags?.[0] || "未分类";

export function blockersOf(todo: TodoItem, items: TodoItem[], includeChildren = false): TodoItem[] {
  const ids = new Set(todo.dependsOn ?? []);
  const seen = new Set([todo.id]);
  let parent = items.find((item) => item.id === todo.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    for (const id of parent.dependsOn ?? []) ids.add(id);
    parent = items.find((item) => item.id === parent?.parentId);
  }
  if (includeChildren) for (const child of items) if (child.parentId === todo.id) ids.add(child.id);
  return [...ids].flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item?.status === "completed" ? [] : [item ?? { ...todo, id, title: "前置任务不存在" }];
  });
}

export function taskState(todo: TodoItem, items: TodoItem[]): "completed" | "blocked" | "in_progress" | "ready" {
  if (todo.status === "completed") return "completed";
  if (blockersOf(todo, items).length) return "blocked";
  return todo.status === "in_progress" ? "in_progress" : "ready";
}

export const STATE_LABEL = { completed: "已完成", blocked: "等待前置", in_progress: "进行中", ready: "可开始" };

export interface GraphNode {
  todo: TodoItem;
  x: number;
  y: number;
  height: number;
  children: TodoItem[];
}
export interface GraphEdge {
  from: string;
  to: string;
}

/** Layout real dependency edges, not chronological guesses. Children are nested in their root card. */
export function layoutTopic(items: TodoItem[], expanded: Set<string>) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rootOf = (item: TodoItem): TodoItem => {
    const seen = new Set([item.id]);
    let current = item;
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId)!;
    }
    return current;
  };
  const roots = items.filter((item) => rootOf(item).id === item.id).sort((a, b) => a.order - b.order);
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const item of items) {
    for (const id of item.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (!dependency) continue;
      const from = rootOf(dependency).id;
      const to = rootOf(item).id;
      // A subtask finishing does not mean its whole parent has finished.
      // Keep those precise relations in the node details instead of inventing parent edges.
      if (from !== dependency.id || to !== item.id) continue;
      const key = `${from}:${to}`;
      if (from !== to && !edgeKeys.has(key)) {
        edges.push({ from, to });
        edgeKeys.add(key);
      }
    }
  }
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter((edge) => edge.to === id);
    const level = parents.reduce((max, edge) => Math.max(max, levelOf(edge.from) + 1), 0);
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  for (const root of roots) levelOf(root.id);
  const rows = new Map<number, TodoItem[]>();
  for (const root of roots) {
    const level = levels.get(root.id)!;
    rows.set(level, [...(rows.get(level) ?? []), root]);
  }
  // Independent legacy tasks wrap in two columns; width never grows with task count.
  const columns = Math.min(2, Math.max(1, ...[...rows.values()].map((row) => row.length)));
  const width = columns * 236 + (columns - 1) * 20 + 32;
  const nodes: GraphNode[] = [];
  let y = 16;
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    for (let offset = 0; offset < row.length; offset += columns) {
      const chunk = row.slice(offset, offset + columns);
      let rowHeight = 0;
      chunk.forEach((todo, index) => {
        const children = items
          .filter((item) => item.id !== todo.id && rootOf(item).id === todo.id)
          .sort((a, b) => a.order - b.order);
        const height = 126 + (children.length ? 28 : 0) + (expanded.has(todo.id) ? children.length * 32 : 0);
        rowHeight = Math.max(rowHeight, height);
        nodes.push({
          todo,
          children,
          height,
          x: (width - chunk.length * 236 - (chunk.length - 1) * 20) / 2 + index * 256,
          y,
        });
      });
      y += rowHeight + 44;
    }
  }
  return { nodes, edges, width, height: Math.max(158, y - 20) };
}
