import { useEffect } from "react";
import "./App.css";
import { AppShell } from "./components/layout/AppShell";
import { ExtensionUIPrompt } from "./components/ExtensionUIPrompt";
import { listAgents, onAgentEvent } from "./lib/tauri-bridge";
import type { AgentEventPayload } from "./lib/rpc-types";
import { useAgentStore } from "./stores/agent-store";
import { useUiStore } from "./stores/ui-store";

const STREAM_FLUSH_INTERVAL_MS = 50;

interface PendingTextDelta {
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
    const pendingTextDeltas = new Map<string, PendingTextDelta>();
    const flushTimers = new Map<string, number>();

    const flushTextDelta = (agentId: string) => {
      const pending = pendingTextDeltas.get(agentId);
      pendingTextDeltas.delete(agentId);
      const timer = flushTimers.get(agentId);
      if (timer !== undefined) window.clearTimeout(timer);
      flushTimers.delete(agentId);
      if (!pending || pending.payload.event.type !== "message_update") return;

      const streamEvent = pending.payload.event.assistantMessageEvent;
      if (!streamEvent) return;
      handleAgentEvent({
        ...pending.payload,
        event: {
          ...pending.payload.event,
          assistantMessageEvent: { ...streamEvent, delta: pending.delta },
        },
      });
    };

    const unlisten = onAgentEvent((payload) => {
      const streamEvent = payload.event.type === "message_update"
        ? payload.event.assistantMessageEvent
        : undefined;
      if (streamEvent?.type === "text_delta" && streamEvent.delta) {
        const pending = pendingTextDeltas.get(payload.agentId);
        pendingTextDeltas.set(payload.agentId, {
          payload,
          delta: (pending?.delta ?? "") + streamEvent.delta,
        });
        if (!flushTimers.has(payload.agentId)) {
          flushTimers.set(
            payload.agentId,
            window.setTimeout(() => flushTextDelta(payload.agentId), STREAM_FLUSH_INTERVAL_MS),
          );
        }
        return;
      }

      // Preserve event order: a message_end must never overtake buffered text.
      flushTextDelta(payload.agentId);
      handleAgentEvent(payload);
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
      pendingTextDeltas.clear();
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
