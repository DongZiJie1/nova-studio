import { Sparkles, User } from "lucide-react";
import type { ChatMessage as ChatMessageData } from "../../stores/agent-store";
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
}: {
  message: ChatMessageData;
  userLabel?: string;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`msg-row ${isUser ? "msg-row-user" : "msg-row-assistant"}`}>
      {!isUser && (
        <div className="msg-avatar msg-avatar-nova">
          <Sparkles size={16} />
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
          <User size={16} />
        </div>
      )}
    </div>
  );
}
