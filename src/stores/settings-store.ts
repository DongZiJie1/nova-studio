import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  apiKey: string;
  defaultModel: string;
  defaultProvider: string;
  defaultCwd: string;
  thinkingLevel: string;

  setApiKey: (key: string) => void;
  setDefaultModel: (model: string) => void;
  setDefaultProvider: (provider: string) => void;
  setDefaultCwd: (cwd: string) => void;
  setThinkingLevel: (level: string) => void;
  resetSettings: () => void;
}

const defaults = {
  apiKey: "",
  defaultModel: "",
  defaultProvider: "",
  defaultCwd: "",
  thinkingLevel: "high",
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
      resetSettings: () => set(defaults),
    }),
    { name: "nova-settings" },
  ),
);
