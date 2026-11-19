import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { onAgentEvent } from "../../lib/tauri-bridge";
import { useAgentStore } from "../../stores/agent-store";
import { useUiStore } from "../../stores/ui-store";
import { PET_ACTION, PET_STATUS, PET_WINDOW, type PetAction, type PetStatus } from "./events";

export function DesktopPetController({ promptAgentId }: { promptAgentId: string | null }) {
  const pendingPrompt = useRef(promptAgentId);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let previous = "";
    let latest: { id: string; kind: "completed" | "error" | "stopped" } | undefined;
    const activeRuns = new Set<string>();
    const outcomes = new Map<string, "error" | "stopped">();
    const pet = Window.getByLabel(PET_WINDOW).catch((error) => {
      console.error("Failed to find desktop pet window:", error);
      return null;
    });

    const publish = () => {
      const { agents, activeAgentId } = useAgentStore.getState();
      const waiting = agents.find((agent) => agent.pendingPermission);
      const running = agents.filter((agent) => agent.status === "streaming" || agent.status === "starting"
        || (agent.status === "idle" && activeRuns.has(agent.id)));
      const runningAgent = running.find((agent) => agent.id === activeAgentId) ?? running[0];
      const recent = agents.find((agent) => agent.id === latest?.id);
      const error = agents.find((agent) => agent.id === activeAgentId && agent.status === "error");
      const promptAgent = agents.find((agent) => agent.id === pendingPrompt.current);
      let status: PetStatus = { kind: "idle" };

      if (pendingPrompt.current || waiting) {
        status = { kind: "waiting", session: promptAgent?.name ?? waiting?.name ?? undefined };
      } else if (runningAgent) {
        status = { kind: "running", session: runningAgent.name ?? undefined, running: running.length };
      } else if (recent && latest) {
        status = { kind: latest.kind, session: recent.name ?? undefined };
      } else if (error) {
        status = { kind: "error", session: error.name ?? undefined };
      }

      const serialized = JSON.stringify(status);
      if (serialized === previous) return;
      previous = serialized;
      void emitTo(PET_WINDOW, PET_STATUS, status).catch((error) => {
        console.error("Failed to send desktop pet status:", error);
      });
    };
    refresh.current = publish;

    // Serialize show/hide requests so rapid preference changes end in the latest state.
    let visibility = Promise.resolve();
    const updateVisibility = () => {
      visibility = visibility.then(async () => {
        const window = await pet;
        if (!window || disposed) return;
        if (useUiStore.getState().desktopPetVisible) {
          await window.show();
        } else {
          await window.hide();
        }
      }).catch((error) => console.error("Failed to update desktop pet visibility:", error));
    };
    const unsubscribeUi = useUiStore.subscribe((state, previousState) => {
      if (state.desktopPetVisible !== previousState.desktopPetVisible) updateVisibility();
    });
    const unsubscribeAgents = useAgentStore.subscribe((state, previousState) => {
      if (state.agents !== previousState.agents || state.activeAgentId !== previousState.activeAgentId) publish();
    });
    const unsubscribeEvents = onAgentEvent(({ agentId, event }) => {
      if (event.type === "agent_start" || event.type === "turn_start") {
        activeRuns.add(agentId);
        outcomes.delete(agentId);
        if (latest?.id === agentId) latest = undefined;
        publish();
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const reason = event.message.stopReason;
        if (reason === "error" || reason === "aborted") {
          outcomes.set(agentId, reason === "error" ? "error" : "stopped");
        }
      } else if (event.type === "agent_settled") {
        activeRuns.delete(agentId);
        latest = { id: agentId, kind: outcomes.get(agentId) ?? "completed" };
        outcomes.delete(agentId);
        publish();
      } else if (event.type === "response" && event.command === "abort" && event.success) {
        activeRuns.delete(agentId);
        latest = { id: agentId, kind: "stopped" };
        outcomes.set(agentId, "stopped");
        publish();
      }
    });

    const listening = listen<PetAction>(PET_ACTION, ({ payload }) => {
      if (payload === "ready") {
        previous = "";
        publish();
      } else if (payload === "hide") {
        useUiStore.getState().setDesktopPetVisible(false);
      } else if (payload === "open") {
        const main = getCurrentWindow();
        void main.show().then(() => main.unminimize()).then(() => main.setFocus())
          .catch((error) => console.error("Failed to open Nova Studio:", error));
      }
    }, { target: "main" });
    void listening.then(() => {
      if (disposed) return;
      publish();
      updateVisibility();
    }).catch((error) => console.error("Failed to listen to desktop pet actions:", error));

    return () => {
      disposed = true;
      refresh.current = () => {};
      unsubscribeUi();
      unsubscribeAgents();
      unsubscribeEvents();
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    pendingPrompt.current = promptAgentId;
    refresh.current();
  }, [promptAgentId]);

  return null;
}
