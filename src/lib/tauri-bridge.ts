/**
 * Tauri bridge — typed wrappers around invoke() and listen().
 *
 * All agent communication goes through this layer:
 *   frontend → invoke("command", args) → Rust backend → agent process
 *   agent process → Rust backend → emit("agent-event", payload) → frontend listen
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Command } from "@tauri-apps/plugin-shell";
import type {
  AgentEventPayload,
  AgentInfo,
  ExtensionUIResponse,
  FileReference,
  ImageContent,
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

export async function activateAgent(agentId: string): Promise<AgentInfo> {
  return invoke<AgentInfo>("activate_agent", { agentId });
}

export async function sendPrompt(
  agentId: string,
  message: string,
  images?: ImageContent[],
  fileReferences?: FileReference[],
): Promise<void> {
  return invoke("send_prompt", { agentId, message, images, fileReferences });
}

export async function abortAgent(agentId: string): Promise<void> {
  return invoke("abort_agent", { agentId });
}

export async function startNewSession(agentId: string): Promise<void> {
  return invoke("new_session", { agentId });
}

export async function compactSession(agentId: string, instructions?: string): Promise<void> {
  return invoke("compact_session", { agentId, instructions });
}

export async function setSessionName(agentId: string, name: string): Promise<void> {
  return invoke("set_session_name", { agentId, name });
}

export async function requestSessionStats(agentId: string): Promise<void> {
  return invoke("request_session_stats", { agentId });
}

export async function requestAvailableModels(agentId: string): Promise<void> {
  return invoke("request_available_models", { agentId });
}

export async function listAllModels(): Promise<Record<string, unknown>[]> {
  return invoke<Record<string, unknown>[]>("list_all_models");
}

/**
 * Fetch available models by running `nova --list-models` via the shell plugin.
 * Uses `sh -c` to ensure the user's shell environment (PATH, etc.) is available.
 */
export async function fetchModelsViaShell(): Promise<Record<string, unknown>[]> {
  const cmd = Command.create("sh", ["-c", "nova --list-models"]);
  const output = await cmd.execute();
  if (output.code !== 0) {
    throw new Error(`nova --list-models failed (exit ${output.code}): ${output.stderr}`);
  }
  const lines = output.stdout.split("\n").filter((l) => l.trim());
  // Skip header line
  const models: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length >= 4) {
      const provider = parts[0];
      const modelId = parts[1];
      const ctxRaw = parts[2];
      const maxRaw = parts[3];
      const thinking = parts[4] === "yes";
      const images = parts[5] === "yes";
      const ctxNum = ctxRaw.endsWith("M")
        ? parseFloat(ctxRaw) * 1_000_000
        : ctxRaw.endsWith("K")
          ? parseFloat(ctxRaw) * 1_000
          : parseFloat(ctxRaw) || 0;
      const maxNum = maxRaw.endsWith("K")
        ? parseFloat(maxRaw) * 1_000
        : parseFloat(maxRaw) || 0;
      models.push({
        id: modelId,
        name: modelId,
        provider,
        contextWindow: Math.round(ctxNum),
        maxTokens: Math.round(maxNum),
        reasoning: thinking,
        images,
      });
    }
  }
  return models;
}

export async function setModel(agentId: string, provider: string, modelId: string): Promise<void> {
  return invoke("set_model", { agentId, provider, modelId });
}

export async function listProjectFiles(
  cwd: string,
  query: string,
  limit = 80,
): Promise<string[]> {
  return invoke<string[]>("list_project_files", { cwd, query, limit });
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
