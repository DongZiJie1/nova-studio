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
const CARD_HEIGHT = 140;
const ROW_GAP = 44;

export type DeadlineTone = "overdue" | "warning" | "reminder" | "gentle" | "neutral";

/**
 * Use local calendar days, avoiding timezone offsets and daylight-saving hour changes.
 * Past-due open items get their own "overdue" tone so they never blend into the
 * "due within 10 days" warning bucket.
 */
export function deadlineTone(dueAt: string | undefined, completed: boolean, now = new Date()): DeadlineTone {
  if (!dueAt || completed) return "neutral";
  const date = dueAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "neutral";
  const dueDay = Date.parse(`${date}T00:00:00Z`);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = (dueDay - today) / 86_400_000;
  if (!Number.isFinite(days)) return "neutral";
  if (days < 0) return "overdue";
  if (days <= 10) return "warning";
  if (days <= 30) return "reminder";
  return "gentle";
}

/** Calendar days late (positive) or until due (negative/zero); null when undated or completed. */
export function deadlineDeltaDays(dueAt: string | undefined, completed: boolean, now = new Date()): number | null {
  const tone = deadlineTone(dueAt, completed, now);
  if (tone === "neutral" || !dueAt) return null;
  const dueDay = Date.parse(`${dueAt.slice(0, 10)}T00:00:00Z`);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - dueDay) / 86_400_000);
}

/** Lower rank = more urgent. Drives both item and topic ordering. */
const TONE_RANK: Record<DeadlineTone, number> = {
  overdue: 0,
  warning: 1,
  reminder: 2,
  gentle: 3,
  neutral: 4,
};

/**
 * Open tasks first, then by deadline urgency (overdue → warning → reminder →
 * gentle → undated), then by calendar date, then original order.
 */
export function compareTodoDeadline(a: TodoItem, b: TodoItem, now = new Date()): number {
  const completedOrder = Number(a.status === "completed") - Number(b.status === "completed");
  if (completedOrder) return completedOrder;
  const toneOrder =
    TONE_RANK[deadlineTone(a.dueAt, a.status === "completed", now)] -
    TONE_RANK[deadlineTone(b.dueAt, b.status === "completed", now)];
  if (toneOrder) return toneOrder;
  const aDate = a.dueAt?.slice(0, 10) || "9999-99-99";
  const bDate = b.dueAt?.slice(0, 10) || "9999-99-99";
  return aDate.localeCompare(bDate) || a.order - b.order;
}

/** Cards stack in one column by deadline; width never grows with task count. */
export function layoutTopic(items: TodoItem[]) {
  const ordered = [...items].sort(compareTodoDeadline);
  const columns = 1;
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

/** Rank topics by open-task urgency counts, preserving input order for ties. */
export function sortTopicsByUrgency<T extends { items: TodoItem[] }>(topics: T[], now = new Date()): T[] {
  return topics.map((topic) => {
    const counts = { overdue: 0, warning: 0, reminder: 0, gentle: 0, neutral: 0 };
    for (const todo of topic.items) {
      counts[deadlineTone(todo.dueAt, todo.status === "completed", now)]++;
    }
    return { topic, counts };
  }).sort((a, b) =>
    b.counts.overdue - a.counts.overdue ||
    b.counts.warning - a.counts.warning ||
    b.counts.reminder - a.counts.reminder ||
    b.counts.gentle - a.counts.gentle,
  ).map(({ topic }) => topic);
}
