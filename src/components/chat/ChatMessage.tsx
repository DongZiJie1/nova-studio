import { User } from "lucide-react";
import type { ChatMessage as ChatMessageData } from "../../stores/agent-store";
import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";
import { Markdown } from "./Markdown";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatMessage({
  message,
  userLabel = "You",
  avatarId,
}: {
  message: ChatMessageData;
  userLabel?: string;
  avatarId: AgentAvatarId;
}) {
  const isUser = message.role === "user";

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
}
