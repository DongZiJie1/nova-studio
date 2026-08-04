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

export type RpcCommand =
  | { type: "prompt"; id?: string; message: string; images?: ImageContent[] }
  | { type: "abort"; id?: string }
  | { type: "set_model"; id?: string; provider: string; modelId: string }
  | { type: "get_state"; id?: string }
  | { type: "get_messages"; id?: string }
  | { type: "get_session_stats"; id?: string }
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

export interface PersistedRpcMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  timestamp?: number | string;
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
