import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ToolPermissionMode } from "../lib/rpc-types";

interface SettingsState {
  apiKey: string;
  defaultModel: string;
  defaultProvider: string;
  defaultCwd: string;
  thinkingLevel: string;
  /** Tool policy to apply when the homepage creates a new agent session. */
  defaultToolPermissionMode: ToolPermissionMode;
  /** Run new agents in their own git worktree. Off unless the user turns it on. */
  worktreeEnabled: boolean;

  setApiKey: (key: string) => void;
  setDefaultModel: (model: string) => void;
  setDefaultProvider: (provider: string) => void;
  setDefaultCwd: (cwd: string) => void;
  setThinkingLevel: (level: string) => void;
  setDefaultToolPermissionMode: (mode: ToolPermissionMode) => void;
  setWorktreeEnabled: (enabled: boolean) => void;
  resetSettings: () => void;
}

const defaults = {
  apiKey: "",
  defaultModel: "",
  defaultProvider: "",
  defaultCwd: "",
  thinkingLevel: "high",
  defaultToolPermissionMode: "ask" as ToolPermissionMode,
  worktreeEnabled: false,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,

      setApiKey: (key) => set({ apiKey: key }),
      setDefaultModel: (model) => set({ defaultModel: model }),
      setDefaultProvider: (provider) => set({ defaultProvider: provider }),
      setDefaultCwd: (cwd) => set({ defaultCwd: cwd }),
      setThinkingLevel: (level) => set({ thinkingLevel: level }),
      setDefaultToolPermissionMode: (mode) => set({ defaultToolPermissionMode: mode }),
      setWorktreeEnabled: (enabled) => set({ worktreeEnabled: enabled }),
      resetSettings: () => set(defaults),
    }),
    { name: "nova-settings" },
  ),
);
