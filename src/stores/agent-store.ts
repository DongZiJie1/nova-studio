import { create } from "zustand";
import type {
  AgentStatus,
  AgentEventPayload,
  AgentInfo,
  PersistedRpcMessage,
} from "../lib/rpc-types";
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
  parentAgentId: string | null;
  name: string | null;
  status: AgentStatus;
  cwd: string;
  model: string | null;
  messages: ChatMessage[];
  createdAt: string;
  messageCount: number;
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
  syncAgents: (agents: AgentInfo[]) => void;
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

function agentStateFromInfo(info: AgentInfo): AgentState {
  return {
    id: info.id,
    parentAgentId: info.parent_agent_id,
    name: info.name ?? "Nova",
    status: info.status,
    cwd: info.cwd,
    model: info.model,
    messages: [],
    createdAt: info.created_at,
    messageCount: info.message_count,
    streamingText: "",
    activeToolCalls: new Map(),
  };
}

function mergeAgentInfo(agent: AgentState, info: AgentInfo): AgentState {
  return {
    ...agent,
    parentAgentId: info.parent_agent_id,
    name: info.name ?? agent.name,
    status: info.status,
    cwd: info.cwd,
    model: info.model,
    createdAt: info.created_at,
    messageCount: Math.max(agent.messageCount, info.message_count),
  };
}

function sortAgentsByCreatedAt(agents: AgentState[]): AgentState[] {
  return [...agents].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function messageText(message: PersistedRpcMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function hydrateMessages(messages: PersistedRpcMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = messageText(message);
    if (!content) return [];
    const parsedTimestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(message.timestamp ?? "");
    return [{
      id: nextId(),
      role: message.role,
      content,
      timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    }];
  });
}

export const useAgentStore = create<AgentStoreState>()((set, get) => ({
  agents: [],
  activeAgentId: null,

  addAgent: (agent) =>
    set((s) => {
      const nextAgents = s.agents.some((existing) => existing.id === agent.id)
        ? s.agents.map((existing) =>
            existing.id === agent.id ? { ...existing, ...agent } : existing,
          )
        : [...s.agents, agent];
      return {
        agents: sortAgentsByCreatedAt(nextAgents),
        activeAgentId: s.activeAgentId ?? agent.id,
      };
    }),

  syncAgents: (infos) =>
    set((s) => {
      const currentById = new Map(s.agents.map((agent) => [agent.id, agent]));
      const agents = sortAgentsByCreatedAt(infos.map((info) => {
        const current = currentById.get(info.id);
        return current
          ? mergeAgentInfo(current, info)
          : agentStateFromInfo(info);
      }));
      return {
        agents,
        activeAgentId:
          s.activeAgentId && agents.some((agent) => agent.id === s.activeAgentId)
            ? s.activeAgentId
            : null,
      };
    }),

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
        a.id === agentId
          ? {
              ...a,
              messages: [...a.messages, msg],
              messageCount: Math.max(a.messageCount, a.messages.length + 1),
            }
          : a,
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
              messageCount: Math.max(a.messageCount, a.messages.length + 1),
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

    if (event.type === "agent_created") {
      set((s) => {
        const existing = s.agents.find((agent) => agent.id === agentId);
        const nextAgent = existing
          ? mergeAgentInfo(existing, event.info)
          : agentStateFromInfo(event.info);
        return {
          agents: sortAgentsByCreatedAt(
            existing
              ? s.agents.map((agent) =>
                  agent.id === agentId ? nextAgent : agent,
                )
              : [...s.agents, nextAgent],
          ),
          activeAgentId: s.activeAgentId ?? agentId,
        };
      });
      return;
    }

    if (event.type === "agent_removed") {
      set((s) => {
        const agents = s.agents.filter((agent) => agent.id !== agentId);
        return {
          agents,
          activeAgentId:
            s.activeAgentId === agentId
              ? (agents[0]?.id ?? null)
              : s.activeAgentId,
        };
      });
      return;
    }

    if (event.type === "agent_name_update") {
      set((s) => ({
        agents: s.agents.map((agent) =>
          agent.id === agentId ? { ...agent, name: event.name } : agent,
        ),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_messages" &&
      event.success
    ) {
      const messages = Array.isArray(event.data?.messages)
        ? (event.data.messages as PersistedRpcMessage[])
        : [];
      set((s) => ({
        agents: s.agents.map((agent) => {
          if (agent.id !== agentId) return agent;
          // A newly spawned agent asks for history before its first prompt.
          // That empty response can arrive after the optimistic user message,
          // so never replace messages already rendered.
          const hydrated = agent.messages.length > 0
            ? agent.messages
            : hydrateMessages(messages);
          return {
            ...agent,
            messages: hydrated,
            messageCount: Math.max(agent.messageCount, hydrated.length),
          };
        }),
      }));
      return;
    }

    const parsed = parseAgentEvent(event);
    console.log(`[event] agent=${agentId} type=${event.type} → kind=${parsed.kind}`);

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
        console.log("[message_end] full message:", JSON.stringify(event.message));
        const text = extractAssistantText(event.message);
        console.log("[message_end] extracted text:", text?.substring(0, 200));
        console.log("[message_end] current streamingText length:", agent.streamingText.length);
        console.log("[message_end] current messages count:", agent.messages.length);
        if (text) {
          // Deduplicate: agent may send message_end twice with the same content.
          // If the last message already has identical content, skip adding.
          const lastMsg = agent.messages[agent.messages.length - 1];
          const isDuplicate =
            lastMsg?.role === "assistant" && lastMsg.content === text;
          if (isDuplicate) {
            console.log("[message_end] duplicate detected, skipping");
            return { ...agent, streamingText: "" };
          }
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
            messageCount: Math.max(agent.messageCount, agent.messages.length + 1),
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
        console.log("[agent_settled] streamingText length:", agent.streamingText.length);
        console.log("[agent_settled] messages count:", agent.messages.length);
        // Flush any remaining streaming text
        if (agent.streamingText) {
          console.log("[agent_settled] flushing streamingText as assistant message");
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
            messageCount: Math.max(agent.messageCount, agent.messages.length + 1),
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
