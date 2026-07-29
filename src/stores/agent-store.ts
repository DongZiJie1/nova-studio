import { create } from "zustand";

export interface AgentState {
  id: string;
  name: string | null;
  status: "starting" | "idle" | "streaming" | "error" | "stopped";
  cwd: string;
  model: string | null;
  messages: AgentMessage[];
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  result?: string;
}

interface AgentStoreState {
  agents: AgentState[];
  activeAgentId: string | null;

  addAgent: (agent: AgentState) => void;
  removeAgent: (id: string) => void;
  setActiveAgent: (id: string | null) => void;
  updateAgent: (id: string, update: Partial<AgentState>) => void;
  addMessage: (agentId: string, message: AgentMessage) => void;
  updateStatus: (id: string, status: AgentState["status"]) => void;
}

export const useAgentStore = create<AgentStoreState>()((set) => ({
  agents: [],
  activeAgentId: null,

  addAgent: (agent) =>
    set((s) => ({
      agents: [...s.agents, agent],
      activeAgentId: s.activeAgentId ?? agent.id,
    })),

  removeAgent: (id) =>
    set((s) => ({
      agents: s.agents.filter((a) => a.id !== id),
      activeAgentId: s.activeAgentId === id ? (s.agents[0]?.id ?? null) : s.activeAgentId,
    })),

  setActiveAgent: (id) => set({ activeAgentId: id }),

  updateAgent: (id, update) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...update } : a)),
    })),

  addMessage: (agentId, message) =>
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === agentId ? { ...a, messages: [...a.messages, message] } : a,
      ),
    })),

  updateStatus: (id, status) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, status } : a)),
    })),
}));
