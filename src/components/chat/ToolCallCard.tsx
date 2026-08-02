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

  return (
    <div className={`tool-card tool-card-${status}`}>
      <button className="tool-card-row" onClick={() => setOpen((o) => !o)}>
        <span className="tool-card-icon">
          <Icon size={13} />
        </span>
        <span className="tool-card-name">{name}</span>
        <span className="tool-card-status">
          {status === "running" ? (
            <Loader2 size={13} className="tool-spin" />
          ) : status === "done" ? (
            <CheckCircle2 size={13} />
          ) : status === "error" ? (
            <XCircle size={13} />
          ) : (
            <CheckCircle2 size={13} />
          )}
        </span>
        {hasDetail && (
          <span className="tool-card-chevron">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="tool-card-detail">
          {args !== undefined && (
            <>
              <div className="tool-card-detail-label">args</div>
              <pre className="tool-card-detail-pre">{prettyJson(args)}</pre>
            </>
          )}
          {result !== undefined && (
            <>
              <div className="tool-card-detail-label">result</div>
              <pre className="tool-card-detail-pre">{prettyJson(result)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
