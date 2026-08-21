import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTheme = "midnight" | "arctic-dawn";
const DEFAULT_BACKGROUND_URL = "/images/arctic-dawn-journey.jpg";

interface UiState {
  theme: AppTheme;
  bgPreset: string;
  customBgUrl: string | null;
  backgroundBlur: number;
  sidebarCollapsed: boolean;

  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
  setBgPreset: (preset: string) => void;
  setCustomBgUrl: (url: string | null) => void;
  setBackgroundBlur: (blur: number) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "arctic-dawn",
      bgPreset: "mesh-amber",
      customBgUrl: DEFAULT_BACKGROUND_URL,
      backgroundBlur: 0,
      sidebarCollapsed: false,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({
        theme: state.theme === "midnight" ? "arctic-dawn" : "midnight",
      })),
      setBgPreset: (preset) => set({ bgPreset: preset }),
      setCustomBgUrl: (url) => set({ customBgUrl: url }),
      setBackgroundBlur: (blur) => set({ backgroundBlur: Math.min(18, Math.max(0, blur)) }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: "nova-ui",
      version: 2,
      migrate: (persistedState, version) => {
        let state = persistedState as Partial<UiState>;
        if (version === 0 && !state.customBgUrl) {
          state = { ...state, customBgUrl: DEFAULT_BACKGROUND_URL };
        }
        return { ...state, backgroundBlur: state.backgroundBlur ?? 0 } as UiState;
      },
    },
  ),
);
