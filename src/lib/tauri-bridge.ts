/**
 * Tauri bridge — typed wrappers around invoke() and listen().
 *
 * All agent communication goes through this layer:
 *   frontend → invoke("command", args) → Rust backend → agent process
 *   agent process → Rust backend → emit("agent-event", payload) → frontend listen
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEventPayload,
  AgentInfo,
  ExtensionUIResponse,
} from "./rpc-types";

// ─── Tauri Commands (frontend → Rust) ───

export async function spawnAgent(
  cwd: string,
  model?: string,
  provider?: string,
): Promise<AgentInfo> {
  return invoke<AgentInfo>("spawn_agent", { cwd, model, provider });
}

export async function stopAgent(agentId: string): Promise<void> {
  return invoke("stop_agent", { agentId });
}

export async function listAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>("list_agents");
}

export async function getAgentInfo(agentId: string): Promise<AgentInfo> {
  return invoke<AgentInfo>("get_agent_info", { agentId });
}

export async function sendPrompt(
  agentId: string,
  message: string,
  images?: string[],
): Promise<void> {
  return invoke("send_prompt", { agentId, message, images });
}

export async function abortAgent(agentId: string): Promise<void> {
  return invoke("abort_agent", { agentId });
}

export async function sendExtensionUIResponse(
  agentId: string,
  response: ExtensionUIResponse,
): Promise<void> {
  return invoke("send_extension_ui_response", {
    agentId,
    id: response.id,
    value: response.value,
    confirmed: response.confirmed,
    cancelled: response.cancelled,
  });
}

// ─── Event Listener (Rust → frontend) ───

export function onAgentEvent(
  callback: (payload: AgentEventPayload) => void,
): UnlistenFn {
  let cleanedUp = false;
  let unlistenFn: UnlistenFn | null = null;

  listen<AgentEventPayload>("agent-event", (event) => {
    callback(event.payload);
  }).then((fn) => {
    if (cleanedUp) {
      // Effect already cleaned up before listener was ready — remove immediately
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    cleanedUp = true;
    unlistenFn?.();
  };
}
