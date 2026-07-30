import { create } from "zustand";
import type { AgentStatus, AgentEventPayload } from "../lib/rpc-types";
import {
  parseAgentEvent,
  extractAssistantText,
  type ParsedEvent,
} from "../lib/event-parser";

// ─── Frontend-side types ───

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  status: "pending" | "running" | "done" | "error";
  result?: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

export interface AgentState {
  id: string;
  name: string | null;
  status: AgentStatus;
  cwd: string;
  model: string | null;
  messages: ChatMessage[];
  createdAt: string;
  /** Accumulated streaming text for the current assistant turn */
  streamingText: string;
  /** Active tool calls in the current turn */
  activeToolCalls: Map<string, ToolCall>;
}

// ─── Store ───

interface AgentStoreState {
  agents: AgentState[];
  activeAgentId: string | null;

  // Agent CRUD
  addAgent: (agent: AgentState) => void;
  removeAgent: (id: string) => void;
  setActiveAgent: (id: string | null) => void;
  updateAgent: (id: string, update: Partial<AgentState>) => void;
  getAgent: (id: string) => AgentState | undefined;

  // Message management
  addUserMessage: (agentId: string, content: string) => void;
  finalizeAssistantMessage: (agentId: string, content: string) => void;

  // Status
  updateStatus: (id: string, status: AgentStatus) => void;

  // Event dispatch — call this from the global event listener
  handleAgentEvent: (payload: AgentEventPayload) => void;
}

let messageCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export const useAgentStore = create<AgentStoreState>()((set, get) => ({
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
      activeAgentId:
        s.activeAgentId === id ? (s.agents[0]?.id ?? null) : s.activeAgentId,
    })),

  setActiveAgent: (id) => set({ activeAgentId: id }),

  updateAgent: (id, update) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...update } : a)),
    })),

  getAgent: (id) => get().agents.find((a) => a.id === id),

  addUserMessage: (agentId, content) => {
    const msg: ChatMessage = {
      id: nextId(),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === agentId ? { ...a, messages: [...a.messages, msg] } : a,
      ),
    }));
  },

  finalizeAssistantMessage: (agentId, content) => {
    if (!content) return;
    const msg: ChatMessage = {
      id: nextId(),
      role: "assistant",
      content,
      timestamp: Date.now(),
    };
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              messages: [...a.messages, msg],
              streamingText: "",
              activeToolCalls: new Map(),
            }
          : a,
      ),
    }));
  },

  updateStatus: (id, status) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, status } : a)),
    })),

  handleAgentEvent: (payload) => {
    const { agentId, event } = payload;
    const parsed = parseAgentEvent(event);

    set((s) => ({
      agents: s.agents.map((agent) => {
        if (agent.id !== agentId) return agent;
        return applyEvent(agent, parsed);
      }),
    }));
  },
}));

// ─── Pure reducer for applying a parsed event to an agent ───

function applyEvent(agent: AgentState, event: ParsedEvent): AgentState {
  switch (event.kind) {
    case "stream_delta": {
      if (event.streamType === "text" && event.delta) {
        return { ...agent, streamingText: agent.streamingText + event.delta };
      }
      return agent;
    }

    case "message_lifecycle": {
      if (event.phase === "start") {
        return { ...agent, status: "streaming" as const };
      }
      if (event.phase === "end") {
        const text = extractAssistantText(event.message);
        if (text) {
          return {
            ...agent,
            messages: [
              ...agent.messages,
              {
                id: nextId(),
                role: "assistant",
                content: text,
                timestamp: Date.now(),
              },
            ],
            streamingText: "",
          };
        }
        return { ...agent, streamingText: "" };
      }
      return agent;
    }

    case "tool_execution": {
      const calls = new Map(agent.activeToolCalls);
      if (event.phase === "start") {
        calls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: "running",
        });
        return { ...agent, activeToolCalls: calls };
      }
      if (event.phase === "end") {
        const existing = calls.get(event.toolCallId);
        if (existing) {
          calls.set(event.toolCallId, {
            ...existing,
            status: event.isError ? "error" : "done",
            result: event.result,
          });
        }
        return { ...agent, activeToolCalls: calls };
      }
      return agent;
    }

    case "agent_status": {
      if (event.status === "settled") {
        // Flush any remaining streaming text
        if (agent.streamingText) {
          return {
            ...agent,
            status: "idle" as const,
            messages: [
              ...agent.messages,
              {
                id: nextId(),
                role: "assistant",
                content: agent.streamingText,
                timestamp: Date.now(),
              },
            ],
            streamingText: "",
            activeToolCalls: new Map(),
          };
        }
        return {
          ...agent,
          status: "idle" as const,
          streamingText: "",
          activeToolCalls: new Map(),
        };
      }
      return agent;
    }

    case "turn_lifecycle": {
      if (event.phase === "end") {
        return { ...agent, activeToolCalls: new Map() };
      }
      return agent;
    }

    case "response": {
      if (!event.success) {
        return { ...agent, status: "error" as const };
      }
      return agent;
    }

    default:
      return agent;
  }
}
