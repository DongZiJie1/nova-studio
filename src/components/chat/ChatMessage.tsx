import { memo, useState } from "react";
import { User, FileText, FileCode, FileJson, FileType, Image as ImageIcon, File, ChevronRight, Wrench, Copy, Check, ThumbsUp, ThumbsDown, GitFork } from "lucide-react";
import type { ChatMessage as ChatMessageData, ToolCall } from "../../stores/agent-store";
import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";
import { Markdown } from "./Markdown";
import { ThinkingCard } from "./ThinkingCard";
import { ToolCallCard } from "./ToolCallCard";

export interface TurnFileChange {
  path: string;
  kind: "edit" | "write";
  additions: number;
  deletions: number;
  patch?: string;
}

function FileChangesCard({ changes }: { changes: TurnFileChange[] }) {
  const [open, setOpen] = useState(false);
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const patches = changes.filter((change) => change.patch);
  const visibleChanges = changes.length > 4 ? changes.slice(0, 3) : changes;
  const hiddenChanges = changes.length > 4 ? changes.slice(3) : [];
  return (
    <div className={`turn-file-change ${open ? "turn-file-change-open" : ""}`}>
      <div className="turn-file-change-summary">
        <span className="turn-file-change-icon"><FileCode size={18} /></span>
        <span className="turn-file-change-copy"><strong>{changes.length === 1 ? "已编辑 1 个文件" : `已编辑 ${changes.length} 个文件`}</strong><span className="turn-file-change-stats"><b>+{additions}</b><i>-{deletions}</i></span></span>
        {patches.length > 0 && <button type="button" className="turn-file-change-review" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "审核"}<ChevronRight size={14} /></button>}
      </div>
      <div className="turn-file-change-list">
        {visibleChanges.map((change) => <div className="turn-file-change-row" key={change.path}><span title={change.path}>{change.path}</span><span className="turn-file-change-stats"><b>+{change.additions}</b><i>-{change.deletions}</i></span></div>)}
        {hiddenChanges.length > 0 && (
          <div className="turn-file-change-overflow" tabIndex={0}>
            <span>…</span><span>还有 {hiddenChanges.length} 个文件</span>
            <div className="turn-file-change-tooltip" role="tooltip">
              {hiddenChanges.map((change) => <div key={change.path}><span>{change.path}</span><span className="turn-file-change-stats"><b>+{change.additions}</b><i>-{change.deletions}</i></span></div>)}
            </div>
          </div>
        )}
      </div>
      {open && patches.length > 0 && <div className="turn-file-change-patches">{patches.map((change) => <section key={change.path}><strong>{change.path}</strong><pre>{change.patch}</pre></section>)}</div>}
    </div>
  );
}

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

export function ToolCallList({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length <= 4) {
    return tools.map((tool) => (
      <ToolCallCard key={tool.id} name={tool.name} status={tool.status} args={tool.args} result={tool.result} />
    ));
  }

  const runningCount = tools.filter((tool) => tool.status === "running" || tool.status === "pending").length;
  const errorCount = tools.filter((tool) => tool.status === "error").length;
  const names = [...new Set(tools.map((tool) => tool.name))];
  return (
    <div className={`tool-call-group ${expanded ? "tool-call-group-expanded" : ""}`}>
      <button type="button" className="tool-call-group-summary" onClick={() => setExpanded((value) => !value)}>
        <ChevronRight size={15} className="tool-call-group-chevron" />
        <Wrench size={14} />
        <strong>{tools.length} 个工具调用</strong>
        <span className="tool-call-group-names">{names.slice(0, 3).join("、")}{names.length > 3 ? ` 等 ${names.length} 种工具` : ""}</span>
        <span className={`tool-call-group-status ${errorCount ? "tool-call-group-status-error" : runningCount ? "tool-call-group-status-running" : ""}`}>
          {errorCount ? `${errorCount} 个失败` : runningCount ? `${runningCount} 个执行中` : "已完成"}
        </span>
      </button>
      {expanded && (
        <div className="tool-call-group-items">
          {tools.map((tool) => (
            <ToolCallCard key={tool.id} name={tool.name} status={tool.status} args={tool.args} result={tool.result} />
          ))}
        </div>
      )}
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  userLabel = "You",
  avatarId,
  showActions = false,
  onFeedback,
  onFork,
  fileChanges = [],
}: {
  message: ChatMessageData;
  userLabel?: string;
  avatarId: AgentAvatarId;
  showActions?: boolean;
  onFeedback?: (message: ChatMessageData, rating: "up" | "down" | null) => void;
  onFork?: (message: ChatMessageData) => void;
  fileChanges?: TurnFileChange[];
}) {
  const [copied, setCopied] = useState(false);
  if (message.role === "thinking") {
    return <div className="msg-row msg-row-special"><ThinkingCard content={message.content} /></div>;
  }
  if (message.role === "tool") {
    return (
      <div className="msg-row msg-row-special">
        <ToolCallList tools={message.toolCalls ?? []} />
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
        {!isUser && showActions && fileChanges.length > 0 && (
          <div className="turn-file-changes" aria-label="本轮文件改动">
            <FileChangesCard changes={fileChanges} />
          </div>
        )}
        {!isUser && showActions && (
          <div className={`message-response-actions ${message.feedback ? "message-response-actions-selected" : ""}`} aria-label="回复操作">
            <button type="button" title="复制回复" aria-label="复制回复" onClick={() => {
              void navigator.clipboard.writeText(message.content).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            <button type="button" className={message.feedback === "up" ? "message-response-action-active message-response-action-up" : ""} title="有帮助" aria-label="有帮助" aria-pressed={message.feedback === "up"} onClick={() => onFeedback?.(message, message.feedback === "up" ? null : "up")}><ThumbsUp size={14} />{message.feedback === "up" && <span>已赞</span>}</button>
            <button type="button" className={message.feedback === "down" ? "message-response-action-active message-response-action-down" : ""} title="没有帮助" aria-label="没有帮助" aria-pressed={message.feedback === "down"} onClick={() => onFeedback?.(message, message.feedback === "down" ? null : "down")}><ThumbsDown size={14} />{message.feedback === "down" && <span>已踩</span>}</button>
            <button type="button" title="从此回复分叉会话" aria-label="从此回复分叉会话" disabled={!message.entryId} onClick={() => onFork?.(message)}><GitFork size={14} /></button>
          </div>
        )}
      </div>
      {isUser && (
        <div className="msg-avatar msg-avatar-user">
          <User size={20} strokeWidth={2.25} />
        </div>
      )}
    </div>
  );
});
