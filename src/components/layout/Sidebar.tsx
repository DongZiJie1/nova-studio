import { Settings, Plus } from "lucide-react";
import { useAgentStore } from "../../stores/agent-store";

interface SidebarProps {
  onCreateAgent: () => void;
  onOpenSettings: () => void;
}

export function Sidebar({ onCreateAgent, onOpenSettings }: SidebarProps) {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const setActive = useAgentStore((s) => s.setActiveAgent);

  return (
    <aside className="glass-panel w-64 flex-shrink-0 p-5 flex flex-col">
      {/* Brand */}
      <div className="mb-8">
        <h1 className="text-xl font-bold text-text-primary tracking-tight">
          Nova <span className="gradient-text">Studio</span>
        </h1>
        <p className="mt-1 text-xs text-text-muted">AI Coding Agent</p>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3 px-1">
          Agents
        </p>

        <div className="space-y-1 mb-3">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setActive(agent.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
                activeId === agent.id
                  ? "bg-amber-50 text-amber-700 font-medium"
                  : "text-text-secondary hover:bg-gray-50 hover:text-text-primary"
              }`}
            >
              {/* Status dot */}
              <span
                className={`h-2 w-2 rounded-full flex-shrink-0 ${
                  agent.status === "idle"
                    ? "bg-success"
                    : agent.status === "streaming"
                      ? "bg-accent-start animate-pulse"
                      : agent.status === "error"
                        ? "bg-error"
                        : "bg-text-muted"
                }`}
              />
              <span className="truncate">{agent.name ?? agent.id}</span>
            </button>
          ))}
        </div>

        {/* New agent button */}
        <button
          onClick={onCreateAgent}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-secondary transition-all hover:bg-amber-50 hover:text-amber-700 border border-dashed border-border-glass hover:border-amber-200"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-50 text-xs font-medium text-amber-700">
            <Plus className="w-3.5 h-3.5" />
          </span>
          New Agent
        </button>
      </div>

      {/* Settings */}
      <div className="pt-4 border-t border-border-glass">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <Settings className="w-4 h-4" />
          Settings
        </button>
      </div>
    </aside>
  );
}
