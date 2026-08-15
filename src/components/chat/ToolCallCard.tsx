import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderSearch,
  Loader2,
  PenLine,
  Search,
  Terminal,
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

function ToolDetail({ name, args, result }: { name: string; args?: unknown; result?: unknown }) {
  const normalizedName = name.toLowerCase();

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
  const summary = toolSummary(name, args) || (status === "running" ? "Running…" : "Completed");

  return (
    <div className={`activity-item tool-card-${status}${open ? " activity-item-open" : ""}`}>
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
          ) : status === "error" ? (
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
