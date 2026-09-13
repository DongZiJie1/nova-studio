import { memo, useState } from "react";
import { User, FileText, FileCode, FileJson, FileType, Image as ImageIcon, File, ChevronRight, Wrench, Copy, Check, ThumbsUp, ThumbsDown, GitFork, MessageCircle, Route, RotateCcw } from "lucide-react";
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
  patches?: string[];
  created?: boolean;
  revertible?: boolean;
}

function FileChangesCard({ changes, onRevert, onReview }: { changes: TurnFileChange[]; onRevert?: (change: TurnFileChange) => Promise<void>; onReview?: (path: string) => void }) {
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkFailures, setBulkFailures] = useState<string[]>([]);
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const patchableChanges = changes.filter((change) => (change.patches?.length ?? 0) > 0);
  const visibleChanges = changes.length > 4 ? changes.slice(0, 3) : changes;
  const hiddenChanges = changes.length > 4 ? changes.slice(3) : [];

  // Undo every file this turn touched. A file whose content changed after the agent wrote
  // it refuses to revert, so failures are collected and reported instead of stopping halfway.
  const revertAll = async () => {
    if (!onRevert) return;
    setBulkPending(true);
    setBulkFailures([]);
    const failures: string[] = [];
    for (const change of [...patchableChanges].reverse()) {
      try {
        await onRevert(change);
      } catch (error) {
        failures.push(`${change.path}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setBulkFailures(failures);
    setBulkPending(false);
    setConfirmBulk(false);
  };

  return (
    <div className="turn-file-change">
      <div className="turn-file-change-summary">
        <span className="turn-file-change-icon"><FileCode size={18} /></span>
        <span className="turn-file-change-copy"><strong>{changes.length === 1 ? "已编辑 1 个文件" : `已编辑 ${changes.length} 个文件`}</strong><span className="turn-file-change-stats"><b>+{additions}</b><i>-{deletions}</i></span></span>
        {patchableChanges.length > 1 && onRevert && (
          <button
            type="button"
            className="turn-file-change-review"
            disabled={bulkPending}
            onClick={() => (confirmBulk ? void revertAll() : setConfirmBulk(true))}
            onBlur={() => setConfirmBulk(false)}
          >
            <RotateCcw size={12} />
            {bulkPending ? "撤回中…" : confirmBulk ? `确认撤回 ${patchableChanges.length} 个？` : "撤回本轮全部"}
          </button>
        )}
        {patchableChanges.length > 0 && <button type="button" className="turn-file-change-review" onClick={() => onReview?.(patchableChanges[0].path)}>审核<ChevronRight size={14} /></button>}
      </div>
      {bulkFailures.length > 0 && (
        <div className="turn-file-change-bulk-error">
          有 {bulkFailures.length} 个文件没能撤回（文件在 Agent 编辑后又被改动过）：
          <pre>{bulkFailures.join("\n")}</pre>
        </div>
      )}
      <div className="turn-file-change-list">
        {visibleChanges.map((change) => <div className="turn-file-change-row" key={change.path}><button type="button" className="turn-file-change-row-main" onClick={() => onReview?.(change.path)}><span title={change.path}>{change.path}</span><span className="turn-file-change-stats"><b>+{change.additions}</b><i>-{change.deletions}</i></span></button>{onRevert && change.revertible !== false && (change.patches?.length ?? 0) > 0 && <button type="button" className="turn-file-change-revert" disabled={pendingPath === change.path} onClick={() => { setPendingPath(change.path); void onRevert(change).catch(() => {}).finally(() => setPendingPath(null)); }}><RotateCcw size={12} />{pendingPath === change.path ? "撤回中" : "撤回"}</button>}</div>)}
        {hiddenChanges.length > 0 && (
          <div className="turn-file-change-overflow" tabIndex={0}>
            <span>…</span><span>还有 {hiddenChanges.length} 个文件</span>
            <div className="turn-file-change-tooltip" role="tooltip">
              {hiddenChanges.map((change) => <div key={change.path}><span>{change.path}</span><span className="turn-file-change-stats"><b>+{change.additions}</b><i>-{change.deletions}</i></span></div>)}
            </div>
          </div>
        )}
      </div>
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
  onOpenAgent,
  onRevertFileChange,
  onReviewFileChange,
  fileChanges = [],
}: {
  message: ChatMessageData;
  userLabel?: string;
  avatarId: AgentAvatarId;
  showActions?: boolean;
  onFeedback?: (message: ChatMessageData, rating: "up" | "down" | null) => void;
  onFork?: (message: ChatMessageData) => void;
  onOpenAgent?: (agentId: string, view: "chat" | "trajectory") => void;
  onRevertFileChange?: (change: TurnFileChange) => Promise<void>;
  onReviewFileChange?: (path: string) => void;
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
          <span className="msg-author">{isUser ? userLabel : (message.authorLabel ?? "Nova")}</span>
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
        {message.role === "agent_result" && message.sourceAgentId && (
          <div className="agent-result-links" aria-label="子 Agent 结果操作">
            <button type="button" onClick={() => onOpenAgent?.(message.sourceAgentId!, "chat")}><MessageCircle size={13} />查看会话 / Diff</button>
            <button type="button" onClick={() => onOpenAgent?.(message.sourceAgentId!, "trajectory")}><Route size={13} />查看工具轨迹</button>
          </div>
        )}
        {!isUser && showActions && fileChanges.length > 0 && (
          <div className="turn-file-changes" aria-label="本轮文件改动">
            <FileChangesCard changes={fileChanges} onRevert={onRevertFileChange} onReview={onReviewFileChange} />
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
