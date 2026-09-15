import { useEffect } from "react";
import "./App.css";
import { AppShell } from "./components/layout/AppShell";
import { ExtensionUIPrompt } from "./components/ExtensionUIPrompt";
import { listAgents, onAgentEvent, requestMessages } from "./lib/tauri-bridge";
import type { AgentEventPayload } from "./lib/rpc-types";
import { useAgentStore } from "./stores/agent-store";
import { useUiStore } from "./stores/ui-store";

const STREAM_FLUSH_INTERVAL_MS = 50;

/**
 * 这些增量每秒可能来几十次，而 UI 最多也就渲染 20 次/秒
 * （聊天区的 StreamingText 自己还按 100ms 节流）。不合并的话，每一个增量
 * 都会写一次 store，进而让整个 AppShell 重渲染一次。
 */
const COALESCED_DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface PendingStreamDelta {
  agentId: string;
  payload: AgentEventPayload;
  delta: string;
}

function isSuccessfulNovaSessionDeletion(payload: AgentEventPayload): boolean {
  if (
    payload.event.type !== "tool_execution_end" ||
    payload.event.toolName !== "nova_data" ||
    payload.event.isError
  ) {
    return false;
  }
  const result = payload.event.result;
  if (!result || typeof result !== "object") return false;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return false;
  const mutation = details as Record<string, unknown>;
  return mutation.action === "delete_session" && mutation.status === "ok";
}

function App() {
  const handleAgentEvent = useAgentStore((s) => s.handleAgentEvent);
  const syncAgents = useAgentStore((s) => s.syncAgents);
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "arctic-dawn" ? "light" : "dark";
  }, [theme]);

  useEffect(() => {
    // 按 `agentId + 增量类型` 累积，每个 agent 一个定时器，到点一次性提交所有缓冲。
    // 同一次提交里的多次 handleAgentEvent 会被 React 自动批处理成一次渲染。
    const pendingDeltas = new Map<string, PendingStreamDelta>();
    const flushTimers = new Map<string, number>();

    const flushDeltas = (agentId: string) => {
      const timer = flushTimers.get(agentId);
      if (timer !== undefined) window.clearTimeout(timer);
      flushTimers.delete(agentId);

      for (const [key, pending] of pendingDeltas) {
        if (pending.agentId !== agentId) continue;
        pendingDeltas.delete(key);
        if (pending.payload.event.type !== "message_update") continue;
        const streamEvent = pending.payload.event.assistantMessageEvent;
        if (!streamEvent) continue;
        handleAgentEvent({
          ...pending.payload,
          event: {
            ...pending.payload.event,
            assistantMessageEvent: { ...streamEvent, delta: pending.delta },
          },
        });
      }
    };

    const unlisten = onAgentEvent((payload) => {
      const streamEvent = payload.event.type === "message_update"
        ? payload.event.assistantMessageEvent
        : undefined;
      if (streamEvent?.type && COALESCED_DELTA_TYPES.has(streamEvent.type) && streamEvent.delta) {
        const key = `${payload.agentId}\u0000${streamEvent.type}`;
        const pending = pendingDeltas.get(key);
        pendingDeltas.set(key, {
          agentId: payload.agentId,
          payload,
          delta: (pending?.delta ?? "") + streamEvent.delta,
        });
        if (!flushTimers.has(payload.agentId)) {
          flushTimers.set(
            payload.agentId,
            window.setTimeout(() => flushDeltas(payload.agentId), STREAM_FLUSH_INTERVAL_MS),
          );
        }
        return;
      }

      // Preserve event order: a message_end must never overtake buffered deltas.
      flushDeltas(payload.agentId);
      handleAgentEvent(payload);
      if (payload.event.type === "agent_settled") {
        void requestMessages(payload.agentId).catch((error) => console.error("Failed to refresh message entries:", error));
      }
      if (isSuccessfulNovaSessionDeletion(payload)) {
        void listAgents()
          .then(syncAgents)
          .catch((error) => console.error("Failed to refresh sessions after deletion:", error));
      }
    });

    // Reconcile with the backend after registering the event listener. This
    // picks up agents created through the Hub before the frontend was ready.
    void listAgents()
      .then(syncAgents)
      .catch((error) => console.error("Failed to sync agents:", error));

    return () => {
      unlisten();
      for (const timer of flushTimers.values()) window.clearTimeout(timer);
      flushTimers.clear();
      pendingDeltas.clear();
    };
  }, [handleAgentEvent, syncAgents]);

  return (
    <>
      <AppShell />
      <ExtensionUIPrompt />
    </>
  );
}

export default App;
