import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Markdown } from "./Markdown";

export function ThinkingCard({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = content.replace(/\s+/g, " ").trim() || "Thinking…";

  return (
    <div className={`activity-item${open ? " activity-item-open" : ""}`}>
      <button className="activity-row" onClick={() => setOpen((value) => !value)}>
        <span className="activity-toggle-icon">
          <Brain className="activity-kind-icon" size={14} />
          {open ? <ChevronDown className="activity-chevron" size={14} /> : <ChevronRight className="activity-chevron" size={14} />}
        </span>
        <span className="activity-kind">Think</span>
        <span className="activity-separator">·</span>
        <span className="activity-summary">{summary}</span>
        {streaming && <Loader2 size={12} className="tool-spin activity-spinner" />}
      </button>
      {open && content && (
        <div className="activity-detail thinking-message">
          <Markdown content={content} highlightCode={false} />
        </div>
      )}
    </div>
  );
}
