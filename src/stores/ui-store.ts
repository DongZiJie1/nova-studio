import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTheme = "midnight" | "arctic-dawn";
const DEFAULT_BACKGROUND_URL = "/images/arctic-dawn-journey.jpg";

interface UiState {
  theme: AppTheme;
  bgPreset: string;
  customBgUrl: string | null;
  sidebarCollapsed: boolean;

  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  setBgPreset: (preset: string) => void;
  setCustomBgUrl: (url: string | null) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "arctic-dawn",
      bgPreset: "mesh-amber",
      customBgUrl: DEFAULT_BACKGROUND_URL,
      sidebarCollapsed: false,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({
        theme: state.theme === "midnight" ? "arctic-dawn" : "midnight",
      })),
      setBgPreset: (preset) => set({ bgPreset: preset }),
      setCustomBgUrl: (url) => set({ customBgUrl: url }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: "nova-ui",
      version: 1,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<UiState>;
        if (version === 0 && !state.customBgUrl) {
          return { ...state, customBgUrl: DEFAULT_BACKGROUND_URL } as UiState;
        }
        return state as UiState;
      },
    },
  ),
);
