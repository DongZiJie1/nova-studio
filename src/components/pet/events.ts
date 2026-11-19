export const PET_WINDOW = "desktop-pet";
export const PET_ACTION = "nova-pet-action";
export const PET_STATUS = "nova-pet-status";

export type PetAction = "ready" | "open" | "hide";

export interface PetStatus {
  kind: "idle" | "running" | "waiting" | "completed" | "error" | "stopped";
  session?: string;
  running?: number;
}
