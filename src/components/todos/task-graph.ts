import type { TodoItem } from "../../lib/tauri-bridge";

export const topicOf = (todo: TodoItem): string => todo.topic || todo.tags?.[0] || "未分类";

export type TaskState = "completed" | "in_progress" | "ready";

/** Todos are a flat list inside a topic, so the stored status is the whole state. */
export function taskState(todo: TodoItem): TaskState {
  if (todo.status === "completed") return "completed";
  return todo.status === "in_progress" ? "in_progress" : "ready";
}

export const STATE_LABEL: Record<TaskState, string> = {
  completed: "已完成",
  in_progress: "进行中",
  ready: "可开始",
};

export interface GraphNode {
  todo: TodoItem;
  x: number;
  y: number;
  height: number;
}

const CARD_WIDTH = 236;
const CARD_GAP = 20;
const CARD_HEIGHT = 126;
const ROW_GAP = 44;

/** Cards wrap two per row in list order; width never grows with task count. */
export function layoutTopic(items: TodoItem[]) {
  const ordered = [...items].sort((a, b) => a.order - b.order);
  const columns = Math.min(2, Math.max(1, ordered.length));
  const width = columns * CARD_WIDTH + (columns - 1) * CARD_GAP + 32;
  const nodes: GraphNode[] = [];
  let y = 16;
  for (let offset = 0; offset < ordered.length; offset += columns) {
    const chunk = ordered.slice(offset, offset + columns);
    chunk.forEach((todo, index) => {
      nodes.push({
        todo,
        height: CARD_HEIGHT,
        x: (width - chunk.length * CARD_WIDTH - (chunk.length - 1) * CARD_GAP) / 2 + index * (CARD_WIDTH + CARD_GAP),
        y,
      });
    });
    y += CARD_HEIGHT + ROW_GAP;
  }
  return { nodes, width, height: Math.max(158, y - 20) };
}
