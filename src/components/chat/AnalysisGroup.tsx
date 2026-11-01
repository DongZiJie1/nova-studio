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
  const activeTools = [...activities.flatMap(activity => activity.toolCalls ?? []), ...tools]
    .filter(tool => tool.status === "running" || tool.status === "pending");
  const activeTool = activeTools[activeTools.length - 1];
  const busy = running || activeTools.length > 0;
  const actions: Record<string, string> = {
    read: "读取文件", edit: "修改文件", write: "写入文件",
    bash: "执行命令", shell: "执行命令", grep: "搜索代码",
    find: "查找文件", glob: "查找文件", ls: "查看目录",
    nova_data: "查询数据", todo: "更新待办",
    read_memory: "回忆", search_memory: "回忆", retrieve_memory: "回忆",
    write_memory: "整理记忆", write_user_memory: "整理记忆",
    query_scheduled_tasks: "查询计划任务", write_scheduled_task: "更新计划任务",
    ask_user_question: "等待你的回答",
  };
  const latestActivity = activities[activities.length - 1];
  const label = activeTool
    ? `Nova 正在${actions[activeTool.name] ?? `调用 ${activeTool.name}`}`
    : busy
      ? thinking ? "Nova 正在思考"
        : latestActivity?.role === "memory" ? "Nova 正在回忆" : "Nova 正在思考"
      : "Nova 已完成分析";
  const renderTool = (tool: ToolCall) => (
    <ToolCallCard key={tool.id} name={tool.name} status={tool.status} args={tool.args} result={tool.result} />
  );
  return (
    <div className={`msg-row msg-row-special analysis-group${open ? " is-open" : ""}${busy ? " is-running" : ""}`}>
      <button type="button" className="analysis-group-summary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <span className="analysis-group-icon" aria-hidden="true">
          <Sparkles size={15} className="analysis-group-spark" />
          <ChevronRight size={15} className="analysis-group-chevron" />
        </span>
        <span className="analysis-group-label" title={label} aria-live="polite">{label}</span>
        {busy && <span className="analysis-group-dots" aria-hidden="true"><i /><i /><i /></span>}
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
