/**
 * RPC protocol TypeScript types — mirrors src-tauri/src/rpc_types.rs
 * and nova's AgentSessionEvent / AssistantMessageEvent.
 */

// ─── Commands (frontend → agent via Rust backend) ───

/** Image content for prompts — mirrors nova's ImageContent (packages/ai/src/types.ts) */
export interface ImageContent {
  type: "image";
  /** base64 encoded image data */
  data: string;
  mimeType: string;
}

export interface FileReference {
  path: string;
}

export type RpcCommand =
  | {
      type: "prompt";
      id?: string;
      message: string;
      images?: ImageContent[];
      fileReferences?: FileReference[];
    }
  | { type: "abort"; id?: string }
  | { type: "set_model"; id?: string; provider: string; modelId: string }
  | { type: "get_state"; id?: string }
  | { type: "get_context_snapshot"; id?: string }
  | { type: "get_messages"; id?: string }
  | { type: "get_session_stats"; id?: string }
  | { type: "get_execution_traces"; id?: string }
  | { type: "new_session"; id?: string }
  | { type: "set_thinking_level"; id?: string; level: string }
  | { type: "compact"; id?: string; customInstructions?: string };

// ─── Spawn / Prompt requests (Tauri command args) ───

export interface SpawnRequest {
  cwd: string;
  model?: string;
  provider?: string;
}

export interface PromptRequest {
  agent_id: string;
  message: string;
  images?: string[];
}

// ─── Streaming events from LLM (AssistantMessageEvent subset) ───

export type StreamEventType =
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "start"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  contentIndex?: number;
  toolCall?: ToolCallInfo;
  [key: string]: unknown;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

// ─── Messages from agent process (stdout JSONL) ───

export type AgentMessage =
  | { type: "agent_created"; info: AgentInfo }
  | { type: "agent_removed" }
  | {
      type: "response";
      id?: string;
      command?: string;
      success: boolean;
      data?: Record<string, unknown>;
    }
  | { type: "message_start"; message?: Record<string, unknown> }
  | {
      type: "message_update";
      message?: Record<string, unknown>;
      assistantMessageEvent?: StreamEvent;
    }
  | { type: "message_end"; message?: Record<string, unknown> }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "agent_settled" }
  | { type: "agent_name_update"; name: string }
  | { type: "agent_delegated_task"; sourceAgentId: string; task: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      timeout?: number;
      [key: string]: unknown;
    }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: Record<string, unknown>; toolResults?: unknown[] }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[]; willRetry?: boolean }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; reason?: string; aborted?: boolean }
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; errorMessage?: string }
  | { type: "auto_retry_end"; success?: boolean; attempt?: number }
  | { type: "bash_execution_update"; id?: string; delta?: string }
  | { type: "unknown"; [key: string]: unknown };

// ─── Extension UI dialogs (agent asks the user for input) ───

export interface ExtensionUIRequest {
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
}

/** One of value / confirmed / cancelled — mirrors nova's RpcExtensionUIResponse */
export interface ExtensionUIResponse {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

// ─── Model metadata (from get_state response) ───

export interface ModelMeta {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  /** Tokens used by tool call results (calculated from messages) */
  toolResultTokens: number;
  /** Tokens used by system prompt + skills (estimated: total input - visible messages) */
  systemPromptTokens: number;
}

/** Cumulative token/cost totals across the whole session (from get_session_stats). */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface ExecutionTraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ExecutionTrace {
  traceId: string;
  category: "turn" | "model" | "thinking" | "tool";
  turnId?: string;
  parentTraceId?: string;
  messageEntryId?: string;
  toolCallId?: string;
  provider?: string;
  model?: string;
  toolName?: string;
  status: "running" | "success" | "error" | "cancelled" | "interrupted";
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: ExecutionTraceUsage;
}

export interface ContextSnapshotTool {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo: Record<string, unknown>;
}

export interface ContextSnapshotSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  sourceInfo: Record<string, unknown>;
}

export interface ContextSnapshot {
  systemPrompt: string;
  tools: ContextSnapshotTool[];
  skills: ContextSnapshotSkill[];
  contextFiles: Array<{ path: string; content: string }>;
}

// ─── Agent status ───

export type AgentStatus = "starting" | "idle" | "streaming" | "error" | "stopped";

// ─── Agent info (from Rust backend) ───

export interface AgentInfo {
  id: string;
  parent_agent_id: string | null;
  name: string | null;
  status: AgentStatus;
  cwd: string;
  model: string | null;
  session_id: string | null;
  created_at: string;
  message_count: number;
  last_error: string | null;
}

export interface PersistedRpcContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export interface PersistedRpcMessage {
  entryId?: string;
  role?: string;
  content?: string | PersistedRpcContentBlock[];
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number | string;
  customType?: string;
}

// ─── Tauri event payload (from Rust backend via emit) ───

export interface AgentEventPayload {
  agentId: string;
  event: AgentMessage;
}

// ─── Settings ───

export interface AppSettings {
  apiKey: string;
  defaultModel: string;
  defaultProvider: string;
  defaultCwd: string;
  thinkingLevel: string;
}
