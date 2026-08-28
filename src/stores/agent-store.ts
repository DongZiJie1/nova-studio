import { create } from "zustand";
import type {
  AgentStatus,
  AgentEventPayload,
  AgentInfo,
  ContextUsage,
  ContextSnapshot,
  ExecutionTrace,
  ModelMeta,
  PersistedRpcMessage,
  SessionUsage,
} from "../lib/rpc-types";
import {
  parseAgentEvent,
  extractAssistantText,
  type ParsedEvent,
  type TurnUsage,
} from "../lib/event-parser";
import {
  getOrAssignAgentAvatar,
  type AgentAvatarId,
} from "../lib/agent-avatars";
import { requestSessionStats } from "../lib/tauri-bridge";
import { recordTokenUsage, recordUserInteraction } from "../lib/activity-tracker";

// ─── Frontend-side types ───

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  status: "pending" | "running" | "done" | "error";
  result?: unknown;
}

export interface MessageAttachment {
  name: string;
  mimeType: string;
  isImage: boolean;
}

export interface ChatMessage {
  id: string;
  entryId?: string;
  feedback?: "up" | "down";
  role: "user" | "assistant" | "thinking" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  attachments?: MessageAttachment[];
  sourceAgentId?: string;
}

export interface AgentState {
  id: string;
  parentAgentId: string | null;
  name: string | null;
  avatarId: AgentAvatarId;
  status: AgentStatus;
  cwd: string;
  model: string | null;
  messages: ChatMessage[];
  createdAt: string;
  messageCount: number;
  /** Accumulated streaming text for the current assistant turn */
  streamingText: string;
  /** Accumulated reasoning for the current assistant turn */
  streamingThinking: string;
  /** Active tool calls in the current turn */
  activeToolCalls: Map<string, ToolCall>;
  /** Model metadata from get_state */
  modelMeta: ModelMeta | null;
  /** Context window usage from get_session_stats */
  contextUsage: ContextUsage | null;
  /** Token usage for the last completed turn */
  lastTurnUsage: TurnUsage | null;
  /** Cumulative token/cost totals across the session (from get_session_stats) */
  sessionUsage: SessionUsage | null;
  /** Persisted execution timing for turns, model calls, and tool calls. */
  executionTraces: ExecutionTrace[];
  /** Effective model context before conversation messages. */
  contextSnapshot: ContextSnapshot | null;
  /** Auto-compaction enabled (from get_state) */
  autoCompactionEnabled: boolean;
  /** Live usage of the in-flight turn, streamed from message_update events */
  liveUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** Accumulated output tokens since the last user message */
  outputSinceLastUserInput: number;
}

// ─── Store ───

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
}

interface AgentStoreState {
  agents: AgentState[];
  activeAgentId: string | null;
  availableModels: AvailableModel[];

  // Agent CRUD
  addAgent: (agent: AgentState) => void;
  syncAgents: (agents: AgentInfo[]) => void;
  removeAgent: (id: string) => void;
  setActiveAgent: (id: string | null) => void;
  updateAgent: (id: string, update: Partial<AgentState>) => void;
  getAgent: (id: string) => AgentState | undefined;
  setAvailableModels: (models: AvailableModel[]) => void;

  // Message management
  addUserMessage: (agentId: string, content: string, attachments?: MessageAttachment[]) => void;
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
    avatarId: getOrAssignAgentAvatar(info.id),
    status: info.status,
    cwd: info.cwd,
    model: info.model,
    messages: [],
    createdAt: info.created_at,
    messageCount: info.message_count,
    streamingText: "",
    streamingThinking: "",
    activeToolCalls: new Map(),
    modelMeta: null,
    contextUsage: null,
    lastTurnUsage: null,
    sessionUsage: null,
    executionTraces: [],
    contextSnapshot: null,
    autoCompactionEnabled: true,
    liveUsage: null,
    outputSinceLastUserInput: 0,
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

/** Guess MIME type from file extension */
function guessMimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    pdf: "application/pdf",
    json: "application/json", xml: "application/xml",
    txt: "text/plain", md: "text/markdown", csv: "text/csv",
    js: "text/javascript", ts: "text/typescript", jsx: "text/javascript", tsx: "text/typescript",
    py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
    html: "text/html", css: "text/css", sh: "text/x-shellscript",
  };
  return map[ext] || "application/octet-stream";
}

/** Parse attached file names from message content (sent as "--- Attached file: xxx ---") */
function parseAttachmentsFromContent(content: string): { attachments: MessageAttachment[] | undefined; cleanContent: string } {
  const attachments: MessageAttachment[] = [];
  // Attached file bodies are appended after the user's visible prompt. Extract
  // their metadata, then keep the entire appended context out of the chat UI.
  const regex = /\r?\n\r?\n--- Attached file: ([^\r\n]+?) ---\r?\n/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const fileName = match[1].trim();
    if (fileName) {
      attachments.push({
        name: fileName,
        mimeType: guessMimeType(fileName),
        isImage: guessMimeType(fileName).startsWith("image/"),
      });
    }
  }
  const attachmentContextStart = content.search(/\r?\n\r?\n--- Attached file: [^\r\n]+? ---\r?\n/);
  const cleanContent = attachmentContextStart >= 0
    ? content.slice(0, attachmentContextStart)
    : content;
  return { attachments: attachments.length > 0 ? attachments : undefined, cleanContent };
}

function hydrateMessages(messages: PersistedRpcMessage[], feedback: Record<string, "up" | "down"> = {}): ChatMessage[] {
  const hydrated: ChatMessage[] = [];
  const pendingToolCalls = new Map<string, ToolCall>();
  let pendingSourceAgentId: string | undefined;

  for (const message of messages) {
    const parsedTimestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(message.timestamp ?? "");
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();

    if (message.role === "custom" && message.customType === "agent_collaboration_context") {
      const details = message.details && typeof message.details === "object"
        ? message.details as Record<string, unknown>
        : {};
      pendingSourceAgentId = typeof details.sourceAgentId === "string" ? details.sourceAgentId : undefined;
      continue;
    }

    if (message.role === "user") {
      const rawContent = messageText(message);
      if (!rawContent) continue;
      const { cleanContent, attachments } = parseAttachmentsFromContent(rawContent);
      hydrated.push({
        id: nextId(),
        entryId: message.entryId,
        role: "user",
        content: cleanContent,
        timestamp,
        attachments,
        sourceAgentId: pendingSourceAgentId,
      });
      pendingSourceAgentId = undefined;
      continue;
    }

    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        const content = messageText(message);
        if (content) hydrated.push({ id: nextId(), entryId: message.entryId, feedback: message.entryId ? feedback[message.entryId] : undefined, role: "assistant", content, timestamp });
        continue;
      }

      let text = "";
      const flushText = () => {
        if (!text) return;
        hydrated.push({ id: nextId(), entryId: message.entryId, feedback: message.entryId ? feedback[message.entryId] : undefined, role: "assistant", content: text, timestamp });
        text = "";
      };
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          flushText();
          hydrated.push({ id: nextId(), entryId: message.entryId, role: "thinking", content: block.thinking, timestamp });
        } else if (
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          flushText();
          pendingToolCalls.set(block.id, {
            id: block.id,
            name: block.name,
            args: block.arguments,
            status: "pending",
          });
        }
      }
      flushText();
      continue;
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const pending = pendingToolCalls.get(message.toolCallId);
      const completed: ToolCall = {
        id: message.toolCallId,
        name: message.toolName ?? pending?.name ?? "tool",
        args: pending?.args,
        status: message.isError ? "error" : "done",
        result: { content: message.content, details: message.details },
      };
      pendingToolCalls.delete(message.toolCallId);
      hydrated.push({
        id: nextId(),
        role: "tool",
        content: "",
        timestamp,
        toolCalls: [completed],
      });
    }
  }

  for (const pending of pendingToolCalls.values()) {
    hydrated.push({
      id: nextId(),
      role: "tool",
      content: "",
      timestamp: Date.now(),
      toolCalls: [{ ...pending, status: "error" }],
    });
  }
  return hydrated;
}

export const useAgentStore = create<AgentStoreState>()((set, get) => ({
  agents: [],
  activeAgentId: null,
  availableModels: [],

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

  setAvailableModels: (models) => set({ availableModels: models }),

  updateAgent: (id, update) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...update } : a)),
    })),

  getAgent: (id) => get().agents.find((a) => a.id === id),

  addUserMessage: (agentId, content, attachments) => {
    const msg: ChatMessage = {
      id: nextId(),
      role: "user",
      content,
      timestamp: Date.now(),
      attachments: attachments?.length ? attachments : undefined,
    };
    recordUserInteraction(msg.timestamp);
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              messages: [...a.messages, msg],
              messageCount: Math.max(a.messageCount, a.messages.length + 1),
              outputSinceLastUserInput: 0,
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

    if (event.type === "agent_delegated_task") {
      set((s) => ({
        agents: s.agents.map((agent) => agent.id === agentId
          ? {
              ...agent,
              messages: [...agent.messages, {
                id: nextId(),
                role: "user",
                content: event.task,
                timestamp: Date.now(),
                sourceAgentId: event.sourceAgentId,
              }],
              messageCount: Math.max(agent.messageCount, agent.messages.length + 1),
            }
          : agent),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_execution_traces" &&
      event.success &&
      Array.isArray(event.data?.traces)
    ) {
      const executionTraces = event.data.traces as ExecutionTrace[];
      set((s) => ({
        agents: s.agents.map((agent) => agent.id === agentId ? { ...agent, executionTraces } : agent),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_context_snapshot" &&
      event.success &&
      event.data &&
      typeof event.data.systemPrompt === "string"
    ) {
      const contextSnapshot = event.data as unknown as ContextSnapshot;
      set((s) => ({
        agents: s.agents.map((agent) => agent.id === agentId ? { ...agent, contextSnapshot } : agent),
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
      const feedback = event.data?.feedback && typeof event.data.feedback === "object"
        ? event.data.feedback as Record<string, "up" | "down">
        : {};
      set((s) => ({
        agents: s.agents.map((agent) => {
          if (agent.id !== agentId) return agent;
          // A newly spawned agent asks for history before its first prompt.
          // That empty response can arrive after the optimistic user message,
          // so never replace messages already rendered.
          if (messages.length === 0 && agent.messages.length > 0) return agent;
          const hydrated = hydrateMessages(messages, feedback);
          return {
            ...agent,
            messages: hydrated,
            messageCount: Math.max(agent.messageCount, hydrated.length),
          };
        }),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_state" &&
      event.success &&
      event.data?.model
    ) {
      const m = event.data.model as Record<string, unknown>;
      const meta: ModelMeta = {
        id: String(m.id ?? ""),
        name: String(m.name ?? ""),
        contextWindow: Number(m.contextWindow ?? 0),
        maxTokens: Number(m.maxTokens ?? 0),
        reasoning: Boolean(m.reasoning),
        images: Array.isArray(m.input) ? (m.input as string[]).includes("image") : Boolean(m.images),
      };
      const autoCompactionEnabled = Boolean(event.data.autoCompactionEnabled ?? true);
      set((s) => ({
        agents: s.agents.map((agent) =>
          agent.id === agentId ? { ...agent, modelMeta: meta, autoCompactionEnabled } : agent,
        ),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_session_stats" &&
      event.success &&
      event.data
    ) {
      const d = event.data as Record<string, unknown>;
      const cu = d.contextUsage as Record<string, unknown> | undefined;
      const tokens = (d.tokens ?? {}) as Record<string, unknown>;
      const sessionUsage: SessionUsage | null =
        typeof tokens.input === "number" ||
        typeof tokens.output === "number" ||
        typeof tokens.cacheRead === "number" ||
        typeof tokens.cacheWrite === "number"
          ? {
              input: Number(tokens.input ?? 0),
              output: Number(tokens.output ?? 0),
              cacheRead: Number(tokens.cacheRead ?? 0),
              cacheWrite: Number(tokens.cacheWrite ?? 0),
              total: Number(tokens.total ?? 0),
              cost: Number(d.cost ?? 0),
            }
          : null;
      set((s) => ({
        agents: s.agents.map((agent) => {
          if (agent.id !== agentId) return agent;
          if (!cu) return { ...agent, contextUsage: null, sessionUsage, liveUsage: null };
          const totalTokens = cu.tokens != null ? Number(cu.tokens) : null;
          const contextWindow = Number(cu.contextWindow ?? 0);
          const percent = cu.percent != null ? Number(cu.percent) : null;
          // Calculate tool result tokens from messages
          let toolResultTokens = 0;
          let visibleMessageTokens = 0;
          for (const msg of agent.messages) {
            const est = Math.ceil(msg.content.length / 4);
            visibleMessageTokens += est;
            if (msg.role === "tool") toolResultTokens += est;
          }
          // System prompt + skills = total input - visible messages
          const systemPromptTokens = totalTokens != null
            ? Math.max(0, totalTokens - visibleMessageTokens)
            : 0;
          return {
            ...agent,
            contextUsage: { tokens: totalTokens, contextWindow, percent, toolResultTokens, systemPromptTokens },
            sessionUsage,
            liveUsage: null,
          };
        }),
      }));
      return;
    }

    if (
      event.type === "response" &&
      event.command === "get_available_models" &&
      event.success &&
      Array.isArray(event.data?.models)
    ) {
      const models: AvailableModel[] = (event.data.models as Record<string, unknown>[]).map((m) => ({
        id: String(m.id ?? ""),
        name: String(m.name ?? ""),
        provider: String(m.provider ?? ""),
        contextWindow: Number(m.contextWindow ?? 0),
        maxTokens: Number(m.maxTokens ?? 0),
        reasoning: Boolean(m.reasoning),
        images: Boolean(m.images),
      }));
      set((state) => {
        const merged = new Map(
          state.availableModels.map((model) => [`${model.provider}:${model.id}`, model]),
        );
        for (const model of models) {
          merged.set(`${model.provider}:${model.id}`, model);
        }
        return { availableModels: Array.from(merged.values()) };
      });
      return;
    }

    const parsed = parseAgentEvent(event);
    if (parsed.kind === "turn_lifecycle" && parsed.phase === "end" && parsed.usage) {
      recordTokenUsage(parsed.usage);
    }
    set((s) => ({
      agents: s.agents.map((agent) => {
        if (agent.id !== agentId) return agent;
        let next = applyEvent(agent, parsed);
        // Live token usage streamed during the current turn
        if (event.type === "message_update") {
          const msg = event.message as Record<string, unknown> | undefined;
          const usage = (msg?.usage ?? {}) as Record<string, unknown>;
          if (typeof usage.input === "number" || typeof usage.output === "number") {
            next = {
              ...next,
              liveUsage: {
                input: Number(usage.input ?? 0),
                output: Number(usage.output ?? 0),
                cacheRead: Number(usage.cacheRead ?? 0),
                cacheWrite: Number(usage.cacheWrite ?? 0),
              },
            };
          }
        }
        return next;
      }),
    }));

    // Refresh context usage after each turn completes
    if (event.type === "turn_end" || event.type === "agent_settled") {
      void requestSessionStats(agentId);
    }
  },
}));

// ─── Pure reducer for applying a parsed event to an agent ───

function applyEvent(agent: AgentState, event: ParsedEvent): AgentState {
  switch (event.kind) {
    case "stream_delta": {
      if (event.streamType === "text" && event.delta) {
        return { ...agent, streamingText: agent.streamingText + event.delta };
      }
      if (event.streamType === "thinking") {
        if (event.phase === "start") return { ...agent, streamingThinking: "" };
        if (event.delta) {
          return { ...agent, streamingThinking: agent.streamingThinking + event.delta };
        }
        if (event.phase === "end" && agent.streamingThinking) {
          return {
            ...agent,
            messages: [...agent.messages, {
              id: nextId(),
              role: "thinking",
              content: agent.streamingThinking,
              timestamp: Date.now(),
            }],
            streamingThinking: "",
          };
        }
      }
      return agent;
    }

    case "message_lifecycle": {
      if (event.phase === "start") {
        return { ...agent, status: "streaming" as const };
      }
      if (event.phase === "end") {
        const text = extractAssistantText(event.message);

        // Check for provider error (e.g. 400 from model API)
        const msg = event.message;
        const stopReason = msg ? (msg as Record<string, unknown>).stopReason : undefined;
        const errorMessage = msg ? (msg as Record<string, unknown>).errorMessage : undefined;
        const isError = stopReason === "error" && errorMessage;

        const displayText = text || (isError ? `Error: ${errorMessage}` : null);

        if (displayText) {
          // Deduplicate: agent may send message_end twice with the same content.
          // If the last message already has identical content, skip adding.
          const lastMsg = agent.messages[agent.messages.length - 1];
          const isDuplicate =
            lastMsg?.role === "assistant" && lastMsg.content === displayText;
          if (isDuplicate) {
            return { ...agent, streamingText: "" };
          }
          return {
            ...agent,
            messages: [
              ...agent.messages,
              {
                id: nextId(),
                role: "assistant",
                content: displayText,
                timestamp: Date.now(),
              },
            ],
            messageCount: Math.max(agent.messageCount, agent.messages.length + 1),
            streamingText: "",
            status: isError ? ("error" as const) : agent.status,
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
          const completed: ToolCall = {
            ...existing,
            status: event.isError ? "error" : "done",
            result: event.result,
          };
          calls.delete(event.toolCallId);
          return {
            ...agent,
            activeToolCalls: calls,
            messages: [...agent.messages, {
              id: nextId(),
              role: "tool",
              content: "",
              timestamp: Date.now(),
              toolCalls: [completed],
            }],
          };
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
        const turnOutput = event.usage?.output ?? 0;
        return {
          ...agent,
          activeToolCalls: new Map(),
          lastTurnUsage: event.usage ?? null,
          outputSinceLastUserInput: agent.outputSinceLastUserInput + turnOutput,
        };
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
