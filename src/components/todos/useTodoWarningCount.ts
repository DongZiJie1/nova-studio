import { useEffect, useState } from "react";
import { listTodos } from "../../lib/tauri-bridge";
import { useTodoStore } from "../../stores/todo-store";
import { deadlineTone } from "./task-graph";

/** Keep the navigation count available even when the todo page is closed. */
export function useTodoWarningCount() {
  const revision = useTodoStore((store) => store.revision);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const state = await listTodos();
        if (cancelled || current !== generation) return;
        const now = new Date();
        setCount(state.items.filter((todo) => {
          const tone = deadlineTone(todo.dueAt, todo.status === "completed", now);
          return tone === "overdue" || tone === "warning";
        }).length);
      } catch {
        // Retain the last known count if the backend is temporarily unavailable.
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [revision]);
  return count;
}
