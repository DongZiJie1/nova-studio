import { create } from "zustand";

interface TodoState {
  /**
   * Bumped whenever something outside the 待办 page changes the todo store —
   * today that is the agent's `todo` tool. The page re-reads `todos.json` on
   * every change so agent-created items show up without a manual reload.
   */
  revision: number;
  markTodosChanged: () => void;
}

export const useTodoStore = create<TodoState>((set) => ({
  revision: 0,
  markTodosChanged: () => set((state) => ({ revision: state.revision + 1 })),
}));
