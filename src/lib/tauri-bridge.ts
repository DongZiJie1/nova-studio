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
  FileReference,
  ImageContent,
  ToolPermissionMode,
  WorktreeMergeOutcome,
  WorktreeStatus,
} from "./rpc-types";

// ─── Tauri Commands (frontend → Rust) ───

export async function spawnAgent(
  cwd: string,
  model?: string,
  provider?: string,
  worktreeEnabled?: boolean,
): Promise<AgentInfo> {
  return invoke<AgentInfo>("spawn_agent", { cwd, model, provider, worktreeEnabled });
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
  backgroundAgentIds?: string[],
): Promise<void> {
  return invoke("send_prompt", { agentId, message, images, fileReferences, backgroundAgentIds });
}

/** Run a one-off question against a transient, tool-less session. The parent
 * session is used only as context provenance; no message is appended to that
 * session. Streaming text arrives via onTemporaryAnswerChunk. */
export async function askTemporary(
  agentId: string,
  question: string,
  requestId: string,
): Promise<string> {
  return invoke<string>("ask_temporary", { agentId, question, requestId });
}

export interface TemporaryAnswerChunk {
  requestId: string;
  text: string;
}

/** Subscribe to streaming updates for temporary questions. Each payload
 * carries the full assistant text so far (replace, don't append). */
export async function onTemporaryAnswerChunk(
  handler: (chunk: TemporaryAnswerChunk) => void,
): Promise<UnlistenFn> {
  return listen<TemporaryAnswerChunk>("temporary-answer-chunk", (event) => handler(event.payload));
}

export async function abortAgent(agentId: string): Promise<void> {
  return invoke("abort_agent", { agentId });
}

export async function steerAgent(agentId: string, message: string): Promise<void> {
  return invoke("steer_agent", { agentId, message });
}

export async function cancelAgent(agentId: string, reason?: string): Promise<void> {
  return invoke("cancel_agent", { agentId, reason });
}

export async function forceStopAgent(agentId: string, reason?: string, timedOut = false): Promise<void> {
  return invoke("force_stop_agent", { agentId, reason, timedOut });
}

export async function retryAgent(agentId: string, message?: string): Promise<void> {
  return invoke("retry_agent", { agentId, message });
}

export async function revertFileChange(
  agentId: string,
  path: string,
  patches: string[],
  created?: boolean,
): Promise<void> {
  return invoke("revert_file_change", { agentId, path, patches, created });
}

// ─── Worktree isolation ───

/** Whether a project directory can host worktree-isolated agents (i.e. is a git repo). */
export async function checkWorktreeAvailable(cwd: string): Promise<boolean> {
  return invoke<boolean>("check_worktree_available", { cwd });
}

export async function getWorktreeStatus(agentId: string): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("get_worktree_status", { agentId });
}

export async function getWorktreeDiff(agentId: string, path: string): Promise<string> {
  return invoke<string>("get_worktree_diff", { agentId, path });
}

/** Squash-merge the agent's work into the project. Reports conflicts, never forces them. */
export async function acceptWorktree(agentId: string): Promise<WorktreeMergeOutcome> {
  return invoke<WorktreeMergeOutcome>("accept_worktree", { agentId });
}

export async function rejectWorktree(agentId: string): Promise<void> {
  return invoke("reject_worktree", { agentId });
}

// ─── Delegated Task Registry (hub task panel) ───

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "stopped"
  | "orphaned";

export type AgentBatchStatus = "open" | "running" | "completed" | "error" | "stopped";

export interface AgentTaskInfo {
  taskId: string;
  batchId: string;
  agentId: string;
  status: AgentTaskStatus;
  parentAgentId: string;
  delegatedTask: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt: string;
  summary?: string;
  changedFiles?: string[];
  verification?: string[];
  remainingRisks?: string[];
  finalText?: string;
  error?: string;
}

export interface AgentBatchInfo {
  batchId: string;
  parentAgentId: string;
  taskIds: string[];
  sealed: boolean;
  resumeTriggered: boolean;
  status: AgentBatchStatus;
  tokenBudget: number;
  costBudgetMicroUsd: number;
}

export interface AgentTaskSnapshot {
  tasks: AgentTaskInfo[];
  batches: AgentBatchInfo[];
}

export async function listAgentTasks(): Promise<AgentTaskSnapshot> {
  return invoke("list_agent_tasks");
}

/**
 * Re-run a finished (failed/stopped/orphaned) delegated task against the
 * same child agent with the original task text and timeout.
 */
export async function retryTask(taskId: string): Promise<AgentTaskInfo> {
  return invoke<AgentTaskInfo>("retry_task", { taskId });
}

export async function cancelTask(taskId: string, reason?: string): Promise<AgentTaskInfo> {
  return invoke<AgentTaskInfo>("cancel_task", { taskId, reason });
}

export async function startNewSession(agentId: string): Promise<void> {
  return invoke("new_session", { agentId });
}

export async function requestMessages(agentId: string): Promise<void> {
  return invoke("request_messages", { agentId });
}

export async function forkSession(agentId: string, entryId: string): Promise<void> {
  return invoke("fork_session", { agentId, entryId });
}

export async function setMessageFeedback(agentId: string, entryId: string, rating: "up" | "down" | null): Promise<void> {
  return invoke("set_message_feedback", { agentId, entryId, rating });
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

export async function requestExecutionTraces(agentId: string): Promise<void> {
  return invoke("request_execution_traces", { agentId });
}

export async function requestContextSnapshot(agentId: string): Promise<void> {
  return invoke("request_context_snapshot", { agentId });
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

export interface ModelCatalogProvider {
  provider: string;
  name: string;
  api?: string;
  baseUrl?: string;
  auth: { configured: boolean; source?: string };
  models: ModelCatalogModel[];
}

/** Provider/model directory from models.json — the single source of truth. */
export interface ModelCatalog {
  providers: ModelCatalogProvider[];
}

export async function getModelCatalog(): Promise<ModelCatalog> {
  return invoke<ModelCatalog>("get_model_catalog");
}

export interface ModelConfigurationInput {
  providerId: string;
  /** When empty, only the provider API key is saved (no models.json entry). */
  modelId?: string;
  displayName?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
}

export async function saveModelConfiguration(input: ModelConfigurationInput): Promise<void> {
  return invoke("save_model_configuration", { input });
}

export interface ProviderConfiguration {
  providerId: string;
  baseUrl?: string;
  api?: string;
  /** Plaintext API key — masking/reveal is handled in the frontend only. */
  apiKey?: string;
  /** Where the key was found: "auth" (auth.json) or "models" (models.json). */
  apiKeySource?: "auth" | "models";
}

export async function getModelConfigurations(): Promise<ProviderConfiguration[]> {
  return invoke<ProviderConfiguration[]>("get_model_configurations");
}

export async function deleteModelConfiguration(providerId: string, modelId: string): Promise<void> {
  return invoke("delete_model_configuration", { providerId, modelId });
}

export async function deleteProviderConfiguration(providerId: string): Promise<void> {
  return invoke("delete_provider_configuration", { providerId });
}

export async function setModel(agentId: string, provider: string, modelId: string): Promise<void> {
  return invoke("set_model", { agentId, provider, modelId });
}

export async function setToolPermissionMode(agentId: string, mode: ToolPermissionMode): Promise<void> {
  return invoke("set_tool_permission_mode", { agentId, mode });
}

export async function respondToolPermission(
  agentId: string,
  toolCallId: string,
  allowed: boolean,
): Promise<boolean> {
  return invoke<boolean>("respond_tool_permission", { agentId, toolCallId, allowed });
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
