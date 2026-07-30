/**
 * Event parser — classifies AgentMessage events from the Rust backend
 * into discrete categories for the store layer.
 */

import type { AgentMessage, StreamEvent } from "./rpc-types";

// ─── Parsed event categories ───

export interface ParsedStreamDelta {
  kind: "stream_delta";
  /** "text" | "thinking" | "toolcall" */
  streamType: string;
  delta: string;
  contentIndex?: number;
}

export interface ParsedToolExecution {
  kind: "tool_execution";
  /** "start" | "update" | "end" */
  phase: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface ParsedMessageLifecycle {
  kind: "message_lifecycle";
  /** "start" | "update" | "end" */
  phase: string;
  message?: Record<string, unknown>;
}

export interface ParsedAgentStatus {
  kind: "agent_status";
  /** "settled" | "start" | "end" */
  status: string;
}

export interface ParsedTurnLifecycle {
  kind: "turn_lifecycle";
  /** "start" | "end" */
  phase: string;
}

export interface ParsedResponse {
  kind: "response";
  command?: string;
  success: boolean;
  data?: Record<string, unknown>;
}

export interface ParsedSystemEvent {
  kind: "system_event";
  eventType: string;
  data?: Record<string, unknown>;
}

export type ParsedEvent =
  | ParsedStreamDelta
  | ParsedToolExecution
  | ParsedMessageLifecycle
  | ParsedAgentStatus
  | ParsedTurnLifecycle
  | ParsedResponse
  | ParsedSystemEvent;

// ─── Parser ───

export function parseAgentEvent(msg: AgentMessage): ParsedEvent {
  switch (msg.type) {
    case "message_update": {
      const evt = msg.assistantMessageEvent;
      if (evt) {
        return parseStreamEvent(evt);
      }
      return {
        kind: "message_lifecycle",
        phase: "update",
        message: msg.message,
      };
    }

    case "message_start":
      return {
        kind: "message_lifecycle",
        phase: "start",
        message: msg.message,
      };

    case "message_end":
      return {
        kind: "message_lifecycle",
        phase: "end",
        message: msg.message,
      };

    case "tool_execution_start":
      return {
        kind: "tool_execution",
        phase: "start",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        args: msg.args,
      };

    case "tool_execution_update":
      return {
        kind: "tool_execution",
        phase: "update",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        args: msg.args,
        result: msg.partialResult,
      };

    case "tool_execution_end":
      return {
        kind: "tool_execution",
        phase: "end",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        result: msg.result,
        isError: msg.isError,
      };

    case "agent_settled":
      return { kind: "agent_status", status: "settled" };

    case "agent_start":
      return { kind: "agent_status", status: "start" };

    case "agent_end":
      return { kind: "agent_status", status: "end" };

    case "turn_start":
      return { kind: "turn_lifecycle", phase: "start" };

    case "turn_end":
      return { kind: "turn_lifecycle", phase: "end" };

    case "response":
      return {
        kind: "response",
        command: msg.command,
        success: msg.success,
        data: msg.data,
      };

    default:
      return {
        kind: "system_event",
        eventType: (msg as { type: string }).type,
        data: msg as unknown as Record<string, unknown>,
      };
  }
}

// ─── Stream event parser ───

function parseStreamEvent(evt: StreamEvent): ParsedStreamDelta {
  return {
    kind: "stream_delta",
    streamType: evt.type.replace(/_(start|delta|end)$/, ""),
    delta: evt.delta ?? "",
    contentIndex: evt.contentIndex,
  };
}

// ─── Extract assistant text from message_end ───

export function extractAssistantText(message?: Record<string, unknown>): string | null {
  if (!message) return null;

  const content = message.content;
  if (typeof content === "string") return content;

  // content may be an array of { type, text } blocks
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block: unknown) => (block as Record<string, unknown>).text as string);

    return textParts.length > 0 ? textParts.join("") : null;
  }

  return null;
}
