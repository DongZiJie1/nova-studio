import { recordScheduledRunResult, type ScheduleRunStatus } from "../lib/tauri-bridge";
import { useScheduleStore } from "./schedule-store";

type RunRef = { taskId: string; runId: string };

/** agentId → the scheduled run that spawned it (only while status is running). */
const byAgent = new Map<string, RunRef>();

export function trackScheduledRun(agentId: string, taskId: string, runId: string): void {
  byAgent.set(agentId, { taskId, runId });
}

/** Stamp a terminal status on a tracked run when its agent finishes. */
export async function settleScheduledRun(
  agentId: string,
  status: Extract<ScheduleRunStatus, "completed" | "error">,
  summary?: string,
): Promise<void> {
  const ref = byAgent.get(agentId);
  if (!ref) return;
  byAgent.delete(agentId);
  try {
    await recordScheduledRunResult({
      taskId: ref.taskId,
      runId: ref.runId,
      status,
      summary,
    });
    useScheduleStore.getState().markSchedulesChanged();
  } catch (error) {
    console.error("Failed to record scheduled run result:", error);
  }
}
