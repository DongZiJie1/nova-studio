import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  apiKey: string;
  defaultModel: string;
  defaultProvider: string;
  defaultCwd: string;
  thinkingLevel: string;
  /** Run new agents in their own git worktree. Off unless the user turns it on. */
  worktreeEnabled: boolean;

  setApiKey: (key: string) => void;
  setDefaultModel: (model: string) => void;
  setDefaultProvider: (provider: string) => void;
  setDefaultCwd: (cwd: string) => void;
  setThinkingLevel: (level: string) => void;
  setWorktreeEnabled: (enabled: boolean) => void;
  resetSettings: () => void;
}

const defaults = {
  apiKey: "",
  defaultModel: "",
  defaultProvider: "",
  defaultCwd: "",
  thinkingLevel: "high",
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
      setWorktreeEnabled: (enabled) => set({ worktreeEnabled: enabled }),
      resetSettings: () => set(defaults),
    }),
    { name: "nova-settings" },
  ),
);
