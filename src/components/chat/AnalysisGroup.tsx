import { useId, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ChatMessage, ToolCall } from "../../stores/agent-store";
import { MemoryRetrievalCard } from "./MemoryRetrievalCard.tsx";
import { ThinkingCard } from "./ThinkingCard.tsx";
import { ToolCallCard } from "./ToolCallCard.tsx";

export function AnalysisGroup({ activities, tools, thinking, running }: {
  activities: ChatMessage[];
  tools: ToolCall[];
  thinking: string;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const renderTool = (tool: ToolCall) => (
    <ToolCallCard key={tool.id} name={tool.name} status={tool.status} args={tool.args} result={tool.result} />
  );
  return (
    <div className={`msg-row msg-row-special analysis-group${open ? " is-open" : ""}${running ? " is-running" : ""}`}>
      <button type="button" className="analysis-group-summary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <span className="analysis-group-icon" aria-hidden="true">
          <Sparkles size={15} className="analysis-group-spark" />
          <ChevronRight size={15} className="analysis-group-chevron" />
        </span>
        <span>{running ? "Nova 正在飞速分析" : "Nova 已完成分析"}</span>
        {running && <span className="analysis-group-dots" aria-hidden="true"><i /><i /><i /></span>}
      </button>
      {open && (
        <div id={panelId} className="analysis-group-panel">
          {activities.map((activity) => {
            if (activity.role === "thinking") {
              return <ThinkingCard key={activity.id} content={activity.content} />;
            }
            if (activity.role === "memory") {
              return <MemoryRetrievalCard key={activity.id} content={activity.content} />;
            }
            return <div key={activity.id}>{activity.toolCalls?.map(renderTool)}</div>;
          })}
          {tools.map(renderTool)}
          {thinking && <ThinkingCard content={thinking} streaming />}
        </div>
      )}
    </div>
  );
}
