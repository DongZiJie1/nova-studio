import { memo } from "react";
import { useNotificationStore, type AgentNotificationStatus } from "../../stores/notification-store";
import { useAgentStore } from "../../stores/agent-store";

const STATUS_LABELS: Record<AgentNotificationStatus, string> = {
  completed: "已完成",
  error: "失败",
  stopped: "已停止",
  orphaned: "已中断",
};

/**
 * Bottom-right toast stack for background agent results. Clicking a toast
 * activates the agent's conversation; toasts auto-dismiss after a few
 * seconds and never steal focus from the current conversation.
 */
export const NotificationToasts = memo(function NotificationToasts() {
  const notifications = useNotificationStore((s) => s.notifications);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  if (notifications.length === 0) return null;

  const activate = (id: string, agentId: string) => {
    setActiveAgent(agentId);
    dismiss(id);
  };

  return (
    <div className="notification-stack">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          role="button"
          tabIndex={0}
          className={`notification-toast notification-${notification.status}`}
          onClick={() => activate(notification.id, notification.agentId)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              activate(notification.id, notification.agentId);
            }
          }}
        >
          <div className="notification-toast-header">
            <span className={`notification-status-chip status-${notification.status}`}>
              {STATUS_LABELS[notification.status] ?? notification.status}
            </span>
            <span className="notification-agent-name">{notification.agentName}</span>
            <button
              type="button"
              className="notification-close"
              aria-label="关闭通知"
              onClick={(event) => {
                event.stopPropagation();
                dismiss(notification.id);
              }}
            >
              ×
            </button>
          </div>
          {notification.detail && (
            <div className="notification-detail">{notification.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
});
