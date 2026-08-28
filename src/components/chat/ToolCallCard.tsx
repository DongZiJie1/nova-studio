import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Database,
  FolderSearch,
  FolderKanban,
  Loader2,
  PenLine,
  Search,
  Terminal,
  MessagesSquare,
  MessageCircleQuestion,
  Trash2,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  shell: Terminal,
  read: FileText,
  edit: PenLine,
  write: FilePlus2,
  grep: Search,
  glob: FolderSearch,
  ls: FolderSearch,
  nova_data: Database,
  ask_user_question: MessageCircleQuestion,
};

function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function toolSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? args : "";
  const values = args as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = values[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  switch (name.toLowerCase()) {
    case "nova_data": {
      const action = pick("action");
      const sessionIds = Array.isArray(values.session_ids) ? values.session_ids.length : 0;
      if (action === "list_projects") return "查看项目";
      if (action === "list_sessions") return "查看会话";
      if (action === "read_session") return "读取会话内容";
      if (action === "delete_session") return sessionIds > 1 ? `删除 ${sessionIds} 个会话` : "删除会话";
      return "管理 Nova 数据";
    }
    case "ask_user_question":
      return pick("question") || "等待用户选择";
    case "bash":
    case "shell":
      return pick("command", "cmd");
    case "read":
      return pick("file_path", "path");
    case "write":
    case "edit":
      return pick("file_path", "path");
    case "grep":
      return [pick("pattern", "query"), pick("path")].filter(Boolean).join(" in ");
    case "glob":
      return pick("pattern", "glob");
    default:
      return pick("description", "path", "query", "command", "name");
  }
}

function displayToolName(name: string): string {
  if (name.toLowerCase() === "nova_data") return "Nova 数据";
  if (name.toLowerCase() === "ask_user_question") return "询问用户";
  return name ? name[0].toUpperCase() + name.slice(1) : "Tool";
}

function objectString(value: unknown, ...keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          return (item as Record<string, unknown>).text as string;
        }
        return resultText(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.content !== undefined) return resultText(record.content);
    const direct = objectString(record, "output", "stdout", "text");
    if (direct) return direct;
  }
  return value === undefined ? "" : prettyJson(value);
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function hubErrorSummary(name: string, result: unknown): string {
  if (name.toLowerCase() !== "hub_ask_agent") return "";
  const details = objectValue(result, "details");
  const code = objectString(details, "errorCode", "error");
  const message = objectString(details, "error");
  const labels: Record<string, string> = {
    self_ask: "不能询问当前 Agent 自身",
    cycle_detected: "已阻止 Agent 循环调用",
    depth_limit: "已达到 Agent 调用深度上限",
    duplicate_request: "已阻止重复的 Agent 请求",
    rate_limit: "Agent 请求过于频繁",
    timeout: "等待 Agent 回复超时",
  };
  return labels[code] || message;
}

function novaDataResult(result: unknown): unknown {
  const details = objectValue(result, "details");
  const data = objectValue(details, "data");
  if (data !== undefined) return data;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

function NovaDataDetail({ args, result }: { args?: unknown; result?: unknown }) {
  const action = objectString(args, "action");
  const data = novaDataResult(result);
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const actionMeta = action === "list_projects"
    ? { icon: FolderKanban, label: "项目列表" }
    : action === "list_sessions"
      ? { icon: MessagesSquare, label: "会话列表" }
      : action === "read_session"
        ? { icon: MessagesSquare, label: "会话内容" }
        : action === "delete_session"
          ? { icon: Trash2, label: "删除结果" }
          : { icon: Database, label: "Nova 数据" };
  const ActionIcon = actionMeta.icon;
  const projects = Array.isArray(record.projects) ? record.projects : [];
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const deleted = Array.isArray(record.deleted) ? record.deleted : record.deleted ? [record.deleted] : [];
  const hasStructuredContent = projects.length > 0 || sessions.length > 0 || messages.length > 0 || deleted.length > 0;

  return (
    <div className="activity-detail nova-data-detail">
      <div className="nova-data-heading">
        <span className={`nova-data-action nova-data-action-${action || "unknown"}`}><ActionIcon size={13} />{actionMeta.label}</span>
        {typeof record.total === "number" && <span>{record.total} 项</span>}
        {typeof record.deletedCount === "number" && <span>{record.deletedCount} 个会话</span>}
      </div>
      {projects.length > 0 && <div className="nova-data-list">{projects.map((project, index) => (
        <div className="nova-data-item" key={objectString(project, "path") || index}><FolderKanban size={14} /><div><strong>{objectString(project, "path") || "未知项目"}</strong><span>{String(objectValue(project, "sessionCount") ?? 0)} 个会话</span></div></div>
      ))}</div>}
      {sessions.length > 0 && <div className="nova-data-list">{sessions.map((session, index) => (
        <div className="nova-data-item" key={objectString(session, "id") || index}><MessagesSquare size={14} /><div><strong>{objectString(session, "name", "firstMessage", "id") || "未命名会话"}</strong><span>{objectString(session, "projectPath")} · {String(objectValue(session, "messageCount") ?? 0)} 条消息</span></div></div>
      ))}</div>}
      {action === "read_session" && <div className="nova-session-detail">
        <div className="nova-session-meta"><strong>{objectString(record, "name", "id") || "未命名会话"}</strong><span>{objectString(record, "projectPath")}</span></div>
        {messages.map((message, index) => <div className={`nova-session-message nova-session-message-${objectString(message, "role")}`} key={index}><span>{objectString(message, "role") === "user" ? "USER" : "NOVA"}</span><p>{objectString(message, "text")}</p></div>)}
      </div>}
      {deleted.length > 0 && <div className="nova-data-list nova-data-deleted-list">{deleted.map((session, index) => (
        <div className="nova-data-item" key={objectString(session, "id") || index}><CheckCircle2 size={14} /><div><strong>{objectString(session, "name", "id") || "未命名会话"}</strong><span>已移至系统废纸篓 · {objectString(session, "projectPath")}</span></div></div>
      ))}</div>}
      {!hasStructuredContent && <pre className="tool-card-detail-pre">{resultText(result) || prettyJson(args)}</pre>}
    </div>
  );
}

function AskUserQuestionDetail({ args, result }: { args?: unknown; result?: unknown }) {
  const question = objectString(args, "question");
  const optionsValue = objectValue(args, "options");
  const options = Array.isArray(optionsValue) ? optionsValue : [];
  const details = objectValue(result, "details");
  const answerValue = objectValue(details, "answer");
  const answer = typeof answerValue === "string" ? answerValue : "";
  return (
    <div className="activity-detail ask-user-detail">
      <div className="ask-user-question"><MessageCircleQuestion size={16} /><strong>{question || "Nova 需要你的选择"}</strong></div>
      {options.length > 0 && <div className="ask-user-option-list">{options.map((option, index) => {
        const label = objectString(option, "label") || String(option);
        const description = objectString(option, "description");
        const selected = answer === label;
        return <div className={`ask-user-option ${selected ? "ask-user-option-selected" : ""}`} key={`${label}-${index}`}><span>{index + 1}</span><div><strong>{label}</strong>{description && <p>{description}</p>}</div>{selected && <CheckCircle2 size={15} />}</div>;
      })}</div>}
      {answer && <div className="ask-user-answer"><span>你的回答</span><strong>{answer}</strong></div>}
      {!question && options.length === 0 && !answer && <pre className="tool-card-detail-pre">{prettyJson(args)}</pre>}
    </div>
  );
}

function ToolDetail({ name, args, result }: { name: string; args?: unknown; result?: unknown }) {
  const normalizedName = name.toLowerCase();

  if (normalizedName === "nova_data") return <NovaDataDetail args={args} result={result} />;
  if (normalizedName === "ask_user_question") return <AskUserQuestionDetail args={args} result={result} />;

  if (normalizedName === "bash" || normalizedName === "shell") {
    const command = objectString(args, "command", "cmd");
    return (
      <div className="activity-detail bash-detail">
        {command && <div className="bash-command"><span>$</span> {command}</div>}
        {result !== undefined && <pre className="bash-output">{resultText(result) || "(no output)"}</pre>}
      </div>
    );
  }

  if (normalizedName === "read") {
    const path = objectString(args, "file_path", "path");
    return (
      <div className="activity-detail read-detail">
        {path && <div className="read-detail-header"><FileText size={12} />{path}</div>}
        {result !== undefined && <pre className="read-detail-content">{resultText(result)}</pre>}
      </div>
    );
  }

  return (
    <div className="activity-detail tool-card-detail">
      {args !== undefined && (
        <>
          <div className="tool-card-detail-label">args</div>
          <pre className="tool-card-detail-pre">{prettyJson(args)}</pre>
        </>
      )}
      {result !== undefined && (
        <>
          <div className="tool-card-detail-label">result</div>
          <pre className="tool-card-detail-pre">{resultText(result)}</pre>
        </>
      )}
    </div>
  );
}

interface ToolCallCardProps {
  name: string;
  status: "pending" | "running" | "done" | "error";
  args?: unknown;
  result?: unknown;
}

export function ToolCallCard({ name, status, args, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(name);
  const hasDetail = args !== undefined || result !== undefined;
  const collaborationError = hubErrorSummary(name, result);
  const isError = status === "error" || Boolean(collaborationError);
  const summary = collaborationError || toolSummary(name, args) || (status === "running" ? "Running…" : "Completed");

  return (
    <div className={`activity-item tool-card-${isError ? "error" : status}${open ? " activity-item-open" : ""}`}>
      <button className="activity-row" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className="activity-toggle-icon">
          <Icon className="activity-kind-icon" size={14} />
          {hasDetail && (open
            ? <ChevronDown className="activity-chevron" size={14} />
            : <ChevronRight className="activity-chevron" size={14} />)}
        </span>
        <span className="activity-kind">{displayToolName(name)}</span>
        <span className="activity-separator">·</span>
        <span className="activity-summary">{summary}</span>
        <span className="activity-status">
          {status === "running" ? (
            <Loader2 size={12} className="tool-spin" />
          ) : isError ? (
            <XCircle size={12} />
          ) : (
            <CheckCircle2 size={12} />
          )}
        </span>
      </button>
      {open && hasDetail && <ToolDetail name={name} args={args} result={result} />}
    </div>
  );
}
