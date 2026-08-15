import { memo } from "react";
import { User, FileText, FileCode, FileJson, FileType, Image as ImageIcon, File } from "lucide-react";
import type { ChatMessage as ChatMessageData } from "../../stores/agent-store";
import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";
import { Markdown } from "./Markdown";
import { ThinkingCard } from "./ThinkingCard";
import { ToolCallCard } from "./ToolCallCard";

function getAttIcon(name: string, mimeType: string): { icon: typeof FileText; color: string } {
  const lower = name.toLowerCase();
  if (mimeType.startsWith("image/")) return { icon: ImageIcon, color: "#ec4899" };
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return { icon: FileText, color: "#ef4444" };
  if (lower.endsWith(".md")) return { icon: FileText, color: "#818cf8" };
  if (lower.endsWith(".json")) return { icon: FileJson, color: "#f59e0b" };
  if (/\.(js|ts|jsx|tsx)$/.test(lower)) return { icon: FileCode, color: "#eab308" };
  if (/\.(py|rb|go|rs|java|c|cpp)$/.test(lower)) return { icon: FileCode, color: "#22c55e" };
  if (/\.(html|css|svg)$/.test(lower)) return { icon: FileCode, color: "#06b6d4" };
  if (/\.(xml|yaml|yml|toml|ini|cfg)$/.test(lower)) return { icon: FileType, color: "#a78bfa" };
  return { icon: File, color: "#6b7280" };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const ChatMessage = memo(function ChatMessage({
  message,
  userLabel = "You",
  avatarId,
}: {
  message: ChatMessageData;
  userLabel?: string;
  avatarId: AgentAvatarId;
}) {
  if (message.role === "thinking") {
    return <div className="msg-row msg-row-special"><ThinkingCard content={message.content} /></div>;
  }
  if (message.role === "tool") {
    return (
      <div className="msg-row msg-row-special">
        {message.toolCalls?.map((tool) => (
          <ToolCallCard key={tool.id} name={tool.name} status={tool.status} args={tool.args} result={tool.result} />
        ))}
      </div>
    );
  }
  const isUser = message.role === "user";
  const MAX_ICONS = 4;

  return (
    <div className={`msg-row ${isUser ? "msg-row-user" : "msg-row-assistant"}`}>
      {!isUser && (
        <div className="msg-avatar msg-avatar-nova">
          <img src={agentAvatarSrc(avatarId)} alt="Nova" />
        </div>
      )}
      <div className="msg-column">
        <div className="msg-meta">
          <span className="msg-author">{isUser ? userLabel : "Nova"}</span>
          <span className="msg-time">{formatTime(message.timestamp)}</span>
        </div>
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {message.attachments.slice(0, MAX_ICONS).map((att, i) => {
              const { icon: Icon, color } = getAttIcon(att.name, att.mimeType);
              return (
                <span
                  key={i}
                  title={att.name}
                  className="msg-attachment-icon"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: `${color}25`,
                    border: `1px solid ${color}40`,
                    color,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} strokeWidth={2} />
                </span>
              );
            })}
            {message.attachments.length > MAX_ICONS && (
              <span
                className="msg-attachment-icon"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  color: "#d1d5db",
                  fontSize: 12,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
                title={`${message.attachments.length - MAX_ICONS} more files`}
              >
                ...
              </span>
            )}
          </div>
        )}
        <div
          className={`msg-bubble ${
            isUser ? "msg-bubble-user" : "msg-bubble-assistant"
          }`}
        >
          {isUser ? message.content : <Markdown content={message.content} />}
        </div>
      </div>
      {isUser && (
        <div className="msg-avatar msg-avatar-user">
          <User size={20} strokeWidth={2.25} />
        </div>
      )}
    </div>
  );
});
