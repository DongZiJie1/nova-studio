import { useState } from "react";
import { Columns2, Eye, FileText, Pencil } from "lucide-react";
import { Markdown } from "../chat/Markdown";

export function AgentInstructionsEditor({
  content,
  disabled,
  onChange,
}: {
  content: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<"edit" | "preview" | "split">("split");
  return (
    <section className="agent-document">
      <div className="agent-config-section-heading">
        <span className="agent-section-icon">
          <FileText size={18} />
        </span>
        <div>
          <h3>AGENTS.md</h3>
          <p>定义身份、工作方式与输出要求，预览随编辑实时更新。</p>
        </div>
      </div>
      <div className="agent-document-frame">
        <div className="agent-document-toolbar">
          <span>
            <FileText size={14} />
            AGENTS.md
          </span>
          <div
            className="agent-document-modes"
            role="group"
            aria-label="Markdown 显示模式"
          >
            <button
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
            >
              <Pencil size={14} />
              编辑
            </button>
            <button
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              <Eye size={14} />
              预览
            </button>
            <button
              aria-pressed={mode === "split"}
              onClick={() => setMode("split")}
            >
              <Columns2 size={14} />
              分栏
            </button>
          </div>
        </div>
        <div className={`agent-document-panes agent-document-${mode}`}>
          {mode !== "preview" && (
            <div className="agent-document-source">
              <span className="agent-pane-label">MARKDOWN</span>
              <textarea
                aria-label="AGENTS.md"
                disabled={disabled}
                spellCheck={false}
                value={content}
                placeholder="# Agent\n\n写下它的职责和工作方式…"
                onChange={(event) => onChange(event.target.value)}
              />
            </div>
          )}
          {mode !== "edit" && (
            <div
              className="agent-document-preview"
              role="region"
              aria-label="AGENTS.md Markdown 预览"
            >
              <span className="agent-pane-label">PREVIEW</span>
              {content.trim() ? (
                <Markdown content={content} />
              ) : (
                <p className="agent-document-placeholder">
                  开始编写身份指令，这里将显示 Markdown 预览。
                </p>
              )}
            </div>
          )}
        </div>
        <div className="agent-document-status">
          <span>Markdown</span>
          <span>{content.length.toLocaleString()} 字符</span>
        </div>
      </div>
    </section>
  );
}
