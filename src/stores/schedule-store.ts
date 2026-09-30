import { create } from "zustand";

interface ScheduleState {
  /**
   * Bumped when the schedule store changes outside the 定时任务 page —
   * scheduler fires, agent run results, or another surface mutating tasks.
   */
  revision: number;
  markSchedulesChanged: () => void;
}

export const useScheduleStore = create<ScheduleState>((set) => ({
  revision: 0,
  markSchedulesChanged: () => set((state) => ({ revision: state.revision + 1 })),
}));
