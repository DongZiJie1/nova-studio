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
  /**
   * Model id the edit started from. When it differs from `modelId` the original
   * entry is replaced rather than a second one being appended.
   */
  previousModelId?: string;
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

export interface UserMemorySection {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

export interface UserMemoryState {
  version: number;
  enabled: boolean;
  sections: UserMemorySection[];
}

export async function getUserMemory(): Promise<UserMemoryState> {
  return invoke<UserMemoryState>("get_user_memory");
}

export async function saveUserMemory(input: { sectionId?: string; title: string; content: string }): Promise<UserMemoryState> {
  return invoke<UserMemoryState>("save_user_memory", { input });
}

export async function deleteUserMemory(id: string): Promise<UserMemoryState> {
  return invoke<UserMemoryState>("delete_user_memory", { id });
}

export async function setUserMemoryEnabled(enabled: boolean): Promise<UserMemoryState> {
  return invoke<UserMemoryState>("set_user_memory_enabled", { enabled });
}

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";

export interface TodoHistoryEntry {
  type: "due_at_changed" | "status_changed";
  from: string | null;
  to: string | null;
  changedAt: string;
}

/** One checkpoint on a todo's completion timeline (git-commit-like). */
export interface ProgressEntry {
  id: string;
  at: string;
  content: string;
  source: "user" | "agent";
  /** Omitted when unset; may arrive as null from Rust Option. */
  percent?: number | null;
  editedAt?: string | null;
}

export interface TodoItem {
  topic?: string;
  id: string;
  title: string;
  description: string;
  progress: ProgressEntry[];
  tags: string[];
  status: TodoStatus;
  priority: TodoPriority;
  projectPath?: string;
  dueAt?: string;
  source: "user" | "agent";
  agentId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  history: TodoHistoryEntry[];
  order: number;
}

export interface TodoState {
  version: number;
  items: TodoItem[];
}

export interface CreateTodoInput {
  topic?: string;
  title: string;
  description: string;
  tags?: string[];
  priority: TodoPriority;
  projectPath?: string;
  dueAt?: string;
}

export type UpdateTodoInput = Partial<Pick<TodoItem, "topic" | "title" | "description" | "tags" | "status" | "priority" | "projectPath" | "dueAt" | "agentId" | "sessionId">> & { id: string };

export interface AppendTodoProgressInput {
  id: string;
  content: string;
  percent?: number;
  source?: "user" | "agent";
}

export interface EditTodoProgressInput {
  id: string;
  entryId: string;
  content: string;
  percent?: number;
}

export interface DeleteTodoProgressInput {
  id: string;
  entryId: string;
}

export async function listTodos(): Promise<TodoState> {
  return invoke<TodoState>("list_todos");
}

export async function createTodo(input: CreateTodoInput): Promise<TodoState> {
  return invoke<TodoState>("create_todo", { input });
}

export async function updateTodo(input: UpdateTodoInput): Promise<TodoState> {
  return invoke<TodoState>("update_todo", { input });
}

export async function deleteTodo(id: string): Promise<TodoState> {
  return invoke<TodoState>("delete_todo", { id });
}

export async function appendTodoProgress(input: AppendTodoProgressInput): Promise<TodoState> {
  return invoke<TodoState>("append_todo_progress", { input });
}

export async function editTodoProgress(input: EditTodoProgressInput): Promise<TodoState> {
  return invoke<TodoState>("edit_todo_progress", { input });
}

export async function deleteTodoProgress(input: DeleteTodoProgressInput): Promise<TodoState> {
  return invoke<TodoState>("delete_todo_progress", { input });
}

// ─── Scheduled tasks (定时任务) ───

export type ScheduleKind = "once" | "recurring";
export type RecurrenceKind = "daily" | "weekly" | "monthly" | "cron";
export type ScheduleRunStatus = "running" | "completed" | "error" | "missed" | "skipped";
export type AutomationPermissionMode = "ask" | "edits" | "allow";
export type AutomationSessionMode = "fresh" | "reuse";

export interface ScheduleRule {
  kind: ScheduleKind;
  runAt?: string;
  recurrence?: RecurrenceKind;
  timeOfDay?: string;
  weekdays?: number[];
  monthDays?: number[];
  cron?: string;
  timezone?: string;
}

export interface ScheduledRun {
  id: string;
  taskId: string;
  startedAt: string;
  finishedAt?: string;
  status: ScheduleRunStatus;
  agentId?: string;
  sessionId?: string;
  error?: string;
  summary?: string;
  catchUp?: boolean;
}

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  description?: string;
  projectPath: string;
  enabled: boolean;
  schedule: ScheduleRule;
  permissionMode: AutomationPermissionMode;
  model?: string;
  provider?: string;
  sessionMode: AutomationSessionMode;
  sessionFile?: string;
  worktreeEnabled?: boolean;
  lastRunAt?: string;
  lastRunStatus?: ScheduleRunStatus;
  lastAgentId?: string;
  lastSessionId?: string;
  nextRunAt?: string;
  missedCount?: number;
  runs: ScheduledRun[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ScheduledTaskState {
  version: number;
  items: ScheduledTask[];
}

export interface CreateScheduledTaskInput {
  title: string;
  prompt: string;
  description?: string;
  projectPath: string;
  schedule: ScheduleRule;
  permissionMode?: AutomationPermissionMode;
  model?: string;
  provider?: string;
  sessionMode?: AutomationSessionMode;
  worktreeEnabled?: boolean;
  enabled?: boolean;
}

export type UpdateScheduledTaskInput = Partial<
  Pick<
    ScheduledTask,
    | "title"
    | "prompt"
    | "description"
    | "projectPath"
    | "schedule"
    | "permissionMode"
    | "model"
    | "provider"
    | "sessionMode"
    | "worktreeEnabled"
    | "enabled"
  >
> & { id: string };

export interface ScheduledTaskFiredPayload {
  taskId: string;
  runId: string;
  title: string;
  agentId: string;
  sessionId: string;
  catchUp: boolean;
  nextRunAt?: string;
}

export interface ScheduledTaskRunUpdatedPayload {
  taskId: string;
  runId: string;
  status: ScheduleRunStatus;
  agentId?: string;
  error?: string;
}

export async function listScheduledTasks(): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("list_scheduled_tasks");
}

export async function createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("create_scheduled_task", { input });
}

export async function updateScheduledTask(input: UpdateScheduledTaskInput): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("update_scheduled_task", { input });
}

export async function deleteScheduledTask(id: string): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("delete_scheduled_task", { id });
}

export async function runScheduledTaskNow(id: string): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("run_scheduled_task_now", { id });
}

export async function setScheduledTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("set_scheduled_task_enabled", { id, enabled });
}

export async function recordScheduledRunResult(input: {
  taskId: string;
  runId: string;
  status: ScheduleRunStatus;
  error?: string;
  summary?: string;
}): Promise<ScheduledTaskState> {
  return invoke<ScheduledTaskState>("record_scheduled_run_result", { input });
}

export async function onScheduledTaskFired(
  handler: (payload: ScheduledTaskFiredPayload) => void,
): Promise<UnlistenFn> {
  return listen<ScheduledTaskFiredPayload>("scheduled-task-fired", (event) => handler(event.payload));
}

export async function onScheduledTaskRunUpdated(
  handler: (payload: ScheduledTaskRunUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listen<ScheduledTaskRunUpdatedPayload>("scheduled-task-run-updated", (event) => handler(event.payload));
}

export async function onScheduledTasksChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("scheduled-tasks-changed", () => handler());
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
