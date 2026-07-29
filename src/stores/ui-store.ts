import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  bgPreset: string;
  customBgUrl: string | null;
  sidebarCollapsed: boolean;

  setBgPreset: (preset: string) => void;
  setCustomBgUrl: (url: string | null) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      bgPreset: "mesh-indigo",
      customBgUrl: null,
      sidebarCollapsed: false,

      setBgPreset: (preset) => set({ bgPreset: preset }),
      setCustomBgUrl: (url) => set({ customBgUrl: url }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: "nova-ui" },
  ),
);
