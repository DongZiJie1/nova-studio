import { useEffect, useState } from "react";
import { listScheduledTasks } from "../../lib/tauri-bridge";
import { useScheduleStore } from "../../stores/schedule-store";

/** Keep the navigation count available even when the schedule page is closed. */
export function useScheduleCount() {
  const revision = useScheduleStore((store) => store.revision);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const state = await listScheduledTasks();
        if (cancelled || current !== generation) return;
        setCount(state.items.length);
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
