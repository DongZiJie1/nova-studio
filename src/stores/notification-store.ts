import { create } from "zustand";

export type AgentNotificationStatus = "completed" | "error" | "stopped" | "orphaned";

export interface AgentNotification {
  id: string;
  agentId: string;
  agentName: string;
  status: AgentNotificationStatus;
  detail: string;
}

interface NotificationState {
  notifications: AgentNotification[];
  push: (notification: Omit<AgentNotification, "id">) => void;
  dismiss: (id: string) => void;
}

const MAX_NOTIFICATIONS = 4;
const AUTO_DISMISS_MS = 8000;

/**
 * Non-intrusive completion toasts for background child agents. Notifications
 * never steal focus; clicking one jumps to the agent's conversation.
 */
export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  push: (notification) => {
    const id = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      notifications: [...s.notifications.slice(-(MAX_NOTIFICATIONS - 1)), { ...notification, id }],
    }));
    setTimeout(() => {
      useNotificationStore.getState().dismiss(id);
    }, AUTO_DISMISS_MS);
  },
  dismiss: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
}));
