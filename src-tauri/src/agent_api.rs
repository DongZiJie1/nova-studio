use crate::agent_manager::AgentManager;
use crate::rpc_types::{
    AgentInfo, CollaborationContext, FileReference, ImageContent, SpawnRequest,
};
use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock, Semaphore};

const MAX_REQUEST_DEPTH: u64 = 2;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(10);
const DUPLICATE_REQUEST_LIMIT: usize = 3;
const SOURCE_WINDOW: Duration = Duration::from_secs(60);
const SOURCE_REQUEST_LIMIT: usize = 30;
const MAX_GLOBAL_RUNNING_TASKS: usize = 8;
const MAX_PARENT_RUNNING_TASKS: usize = 4;
const MAX_BATCH_RUNNING_TASKS: usize = 4;
const MAX_QUEUED_TASKS: usize = 64;
const MAX_TASK_TOKEN_BUDGET: u64 = 100_000;
const MAX_BATCH_TOKEN_BUDGET: u64 = 300_000;
const MAX_TASK_COST_BUDGET_MICRO_USD: u64 = 5_000_000;
const MAX_BATCH_COST_BUDGET_MICRO_USD: u64 = 20_000_000;

#[derive(Clone)]
struct AppState {
    manager: Arc<AgentManager>,
    request_tracker: Arc<Mutex<RequestTracker>>,
    tasks: Arc<RwLock<HashMap<String, AgentTask>>>,
    task_batches: Arc<RwLock<HashMap<String, AgentTaskBatch>>>,
    registry: TaskRegistry,
    task_slots: Arc<Semaphore>,
    queue_slots: Arc<Semaphore>,
}

/// Delegated task and batch state shared between the hub HTTP API (agent
/// tools) and the Tauri commands the Studio task panel reads from. The
/// registry persists to a JSON snapshot beside agents.json so batches and
/// their sealed/resumed markers survive Studio restarts.
#[derive(Clone, Default)]
pub struct TaskRegistry {
    pub tasks: Arc<RwLock<HashMap<String, AgentTask>>>,
    pub task_batches: Arc<RwLock<HashMap<String, AgentTaskBatch>>>,
    state_path: Arc<RwLock<Option<std::path::PathBuf>>>,
    persistence_lock: Arc<Mutex<()>>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedTaskState {
    tasks: HashMap<String, AgentTask>,
    task_batches: HashMap<String, AgentTaskBatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub tasks: Vec<AgentTask>,
    pub batches: Vec<AgentTaskBatch>,
}

impl TaskRegistry {
    /// Point the registry at its persistence file (called once at startup,
    /// before restore).
    pub async fn set_state_path(&self, path: std::path::PathBuf) {
        *self.state_path.write().await = Some(path);
    }

    pub async fn snapshot(&self) -> TaskSnapshot {
        TaskSnapshot {
            tasks: self.tasks.read().await.values().cloned().collect(),
            batches: self.task_batches.read().await.values().cloned().collect(),
        }
    }

    /// Load the persisted snapshot. Tasks that were not finished when the
    /// previous Studio session ended are marked `orphaned` so they are never
    /// mistaken for work still running, and non-terminal batches are closed
    /// out as stopped. Sealed/resumed markers load as-is, which prevents a
    /// restarted Studio from re-summarizing a batch that already resumed.
    pub async fn restore(&self) -> Result<(), String> {
        let Some(path) = self.state_path.read().await.clone() else {
            return Ok(());
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Ok(());
        };
        let persisted: PersistedTaskState = serde_json::from_str(&text)
            .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
        let mut tasks = self.tasks.write().await;
        let mut batches = self.task_batches.write().await;
        for (task_id, mut task) in persisted.tasks {
            if !task.status.is_terminal() {
                task.status = TaskStatus::Orphaned;
                task.error = Some("Studio restarted before this task finished".to_string());
                task.completed_at = Some(chrono::Utc::now().to_rfc3339());
            }
            tasks.insert(task_id, task);
        }
        for (batch_id, mut batch) in persisted.task_batches {
            if !matches!(
                batch.status,
                BatchStatus::Completed | BatchStatus::Error | BatchStatus::Stopped
            ) {
                batch.status = BatchStatus::Stopped;
            }
            batches.insert(batch_id, batch);
        }
        Ok(())
    }

    /// Write the current snapshot to disk. Callers hold the persistence lock
    /// only to serialize writers; a failure is logged, never fatal.
    pub async fn persist(&self) {
        let Some(path) = self.state_path.read().await.clone() else {
            return;
        };
        let _guard = self.persistence_lock.lock().await;
        let persisted = PersistedTaskState {
            tasks: self.tasks.read().await.clone(),
            task_batches: self.task_batches.read().await.clone(),
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&persisted) {
            Ok(text) => {
                if let Err(error) = std::fs::write(&path, text) {
                    log::warn!("Failed to persist task registry: {error}");
                }
            }
            Err(error) => log::warn!("Failed to serialize task registry: {error}"),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTaskBatch {
    batch_id: String,
    parent_agent_id: String,
    task_ids: Vec<String>,
    sealed: bool,
    resume_triggered: bool,
    status: BatchStatus,
    token_budget: u64,
    cost_budget_micro_usd: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BatchStatus {
    #[default]
    Open,
    Running,
    Completed,
    Error,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Queued,
    Running,
    Completed,
    Error,
    Stopped,
    Orphaned,
}

impl TaskStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Error | Self::Stopped | Self::Orphaned
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    task_id: String,
    batch_id: String,
    agent_id: String,
    status: TaskStatus,
    parent_agent_id: String,
    delegated_task: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    last_activity_at: String,
    token_budget: u64,
    cost_budget_micro_usd: u64,
    #[serde(default = "default_ask_timeout")]
    timeout_secs: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    summary: String,
    #[serde(default)]
    changed_files: Vec<String>,
    #[serde(default)]
    verification: Vec<String>,
    #[serde(default)]
    remaining_risks: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    final_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedTaskSummary {
    summary: String,
    #[serde(default)]
    changed_files: Vec<String>,
    #[serde(default)]
    verification: Vec<String>,
    #[serde(default)]
    remaining_risks: Vec<String>,
}

#[derive(Default)]
struct RequestTracker {
    duplicate_requests: HashMap<String, VecDeque<Instant>>,
    source_requests: HashMap<String, VecDeque<Instant>>,
}

impl RequestTracker {
    fn check(&mut self, source: &str, target: &str, question: &str) -> Result<(), &'static str> {
        let now = Instant::now();
        let source_entries = self.source_requests.entry(source.to_string()).or_default();
        source_entries.retain(|seen| now.duration_since(*seen) <= SOURCE_WINDOW);
        if source_entries.len() >= SOURCE_REQUEST_LIMIT {
            return Err("rate_limit");
        }

        let mut hasher = DefaultHasher::new();
        source.hash(&mut hasher);
        target.hash(&mut hasher);
        question.hash(&mut hasher);
        let duplicate_key = hasher.finish().to_string();
        let duplicate_entries = self.duplicate_requests.entry(duplicate_key).or_default();
        duplicate_entries.retain(|seen| now.duration_since(*seen) <= DUPLICATE_WINDOW);
        if duplicate_entries.len() >= DUPLICATE_REQUEST_LIMIT {
            return Err("duplicate_request");
        }

        source_entries.push_back(now);
        duplicate_entries.push_back(now);
        Ok(())
    }
}

/// Auth middleware: hub callers must present the manager's hub token.
/// Agents receive it at spawn time via the NOVA_HUB_TOKEN env var.
async fn require_hub_token(
    AxumState(state): AxumState<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let ok = headers
        .get("x-nova-token")
        .and_then(|v| v.to_str().ok())
        .map(|t| t == state.manager.hub_token)
        .unwrap_or(false);
    if ok {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(Deserialize)]
struct SpawnBody {
    cwd: String,
    /// Agent that initiated this delegation. Root agents have no parent.
    #[serde(default)]
    parent_agent_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    task: Option<String>,
    /// Collaboration depth for the new agent; callers that are themselves
    /// agents send their own depth + 1.
    #[serde(default)]
    depth: u64,
}

#[derive(Serialize)]
struct SpawnResponse {
    agent_id: String,
    info: AgentInfo,
}

#[derive(Deserialize)]
struct PromptBody {
    message: String,
    #[serde(default)]
    images: Option<Vec<ImageContent>>,
    #[serde(default)]
    file_references: Option<Vec<FileReference>>,
}

#[derive(Deserialize)]
struct AgentIdBody {
    agent_id: String,
}

#[derive(Deserialize)]
struct AskBody {
    question: String,
    #[serde(default = "default_ask_timeout")]
    timeout_secs: u64,
    #[serde(default)]
    source_agent_id: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    request_depth: u64,
    #[serde(default)]
    visited_agent_ids: Vec<String>,
}

fn default_ask_timeout() -> u64 {
    300
}

#[derive(Serialize)]
struct AskResponse {
    reply: String,
}

#[derive(Deserialize)]
struct DelegateBody {
    task: String,
    #[serde(default)]
    batch_id: String,
    #[serde(default)]
    agent_id: Option<String>,
    cwd: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    depth: u64,
    #[serde(default = "default_ask_timeout")]
    timeout_secs: u64,
    #[serde(default)]
    source_agent_id: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    request_depth: u64,
    #[serde(default)]
    visited_agent_ids: Vec<String>,
    #[serde(default = "default_task_token_budget")]
    token_budget: u64,
    #[serde(default = "default_task_cost_budget")]
    cost_budget_micro_usd: u64,
}

fn default_task_token_budget() -> u64 {
    MAX_TASK_TOKEN_BUDGET
}

fn default_task_cost_budget() -> u64 {
    MAX_TASK_COST_BUDGET_MICRO_USD
}

#[derive(Serialize)]
struct DelegateResponse {
    task_id: String,
    batch_id: String,
    agent_id: String,
    created_agent: bool,
    status: String,
}

#[derive(Deserialize)]
struct SealBatchBody {
    source_agent_id: String,
}

#[derive(Deserialize)]
struct TaskControlBody {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

async fn get_task(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<AgentTask>, (StatusCode, Json<ApiError>)> {
    state
        .tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "Agent task not found",
                None,
            )
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskQuery {
    batch_id: Option<String>,
    status: Option<String>,
    agent_id: Option<String>,
    parent_agent_id: Option<String>,
}

/// Query delegated tasks with optional batch/status/agent filters. Powers
/// "list this batch's tasks" and "list all running tasks" style checks.
async fn list_tasks(
    AxumState(state): AxumState<AppState>,
    axum::extract::Query(query): axum::extract::Query<TaskQuery>,
) -> Result<Json<TaskSnapshot>, (StatusCode, Json<ApiError>)> {
    let status_filter = match &query.status {
        None => None,
        Some(raw) => Some(serde_json::from_value::<TaskStatus>(serde_json::Value::String(
            raw.clone(),
        ))
        .map_err(|_| {
            api_error(
                StatusCode::BAD_REQUEST,
                "invalid_status_filter",
                format!("Unknown task status filter: {raw}"),
                None,
            )
        })?),
    };
    let tasks = state
        .tasks
        .read()
        .await
        .values()
        .filter(|task| {
            query
                .batch_id
                .as_ref()
                .is_none_or(|batch_id| &task.batch_id == batch_id)
                && status_filter.is_none_or(|status| task.status == status)
                && query
                    .agent_id
                    .as_ref()
                    .is_none_or(|agent_id| &task.agent_id == agent_id)
                && query
                    .parent_agent_id
                    .as_ref()
                    .is_none_or(|parent_id| &task.parent_agent_id == parent_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(Json(TaskSnapshot { tasks, batches: Vec::new() }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchDetail {
    batch: AgentTaskBatch,
    tasks: Vec<AgentTask>,
}

/// Full detail for one batch: its sealed/resume state plus every task in it.
async fn get_task_batch(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(batch_id): axum::extract::Path<String>,
) -> Result<Json<BatchDetail>, (StatusCode, Json<ApiError>)> {
    let batches = state.task_batches.read().await;
    let Some(batch) = batches.get(&batch_id).cloned() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "batch_not_found",
            "Agent task batch not found",
            None,
        ));
    };
    let tasks = {
        let tasks = state.tasks.read().await;
        batch
            .task_ids
            .iter()
            .filter_map(|task_id| tasks.get(task_id).cloned())
            .collect::<Vec<_>>()
    };
    Ok(Json(BatchDetail { batch, tasks }))
}

/// The parent of an agent, or null for a root agent.
async fn get_parent_agent(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Result<Json<Option<AgentInfo>>, (StatusCode, Json<ApiError>)> {
    let agents = state.manager.list().await;
    let agent = agents
        .iter()
        .find(|candidate| candidate.id == agent_id)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "agent_not_found",
                "Agent not found",
                None,
            )
        })?;
    let parent = agent
        .parent_agent_id
        .as_ref()
        .and_then(|parent_id| agents.iter().find(|candidate| &candidate.id == parent_id))
        .cloned();
    Ok(Json(parent))
}

async fn steer_task(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(body): Json<TaskControlBody>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let task = state
        .tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "Agent task not found",
                None,
            )
        })?;
    if task.status != TaskStatus::Running {
        return Err(api_error(
            StatusCode::CONFLICT,
            "task_not_running",
            "Only a running task can be steered",
            None,
        ));
    }
    let message = body
        .message
        .filter(|message| !message.trim().is_empty())
        .ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "missing_message",
                "Steering message is required",
                None,
            )
        })?;
    state
        .manager
        .steer(&task.agent_id, message)
        .await
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "steer_failed",
                error,
                None,
            )
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_task(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
    Json(body): Json<TaskControlBody>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let (agent_id, batch_id) = {
        let mut tasks = state.tasks.write().await;
        let task = tasks.get_mut(&task_id).ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "Agent task not found",
                None,
            )
        })?;
        if task.status.is_terminal() {
            return Err(api_error(
                StatusCode::CONFLICT,
                "task_already_finished",
                "Agent task has already finished",
                None,
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();
        task.status = TaskStatus::Stopped;
        task.error = Some(
            body.reason
                .clone()
                .unwrap_or_else(|| "cancelled by user".to_string()),
        );
        task.completed_at = Some(now.clone());
        task.last_activity_at = now;
        (task.agent_id.clone(), task.batch_id.clone())
    };
    state
        .manager
        .cancel(&agent_id, body.reason)
        .await
        .map_err(|error| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cancel_failed",
                error,
                None,
            )
        })?;
    state.registry.persist().await;
    try_resume_task_batch(
        state.manager,
        state.tasks,
        state.task_batches,
        &batch_id,
        &state.registry,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Reset a finished (failed/stopped/orphaned) task to running and re-run it
/// against the same child agent with the original task text and timeout.
/// Shared by the hub HTTP endpoint and the Studio task-panel command.
pub async fn retry_task_impl(
    manager: Arc<AgentManager>,
    registry: TaskRegistry,
    task_id: &str,
) -> Result<AgentTask, String> {
    let task = registry
        .tasks
        .read()
        .await
        .get(task_id)
        .cloned()
        .ok_or_else(|| "Agent task not found".to_string())?;
    if task.status == TaskStatus::Completed {
        return Err("A completed task does not need a retry".to_string());
    }
    if !task.status.is_terminal() {
        return Err("Only a finished task can be retried".to_string());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut retried = task.clone();
    retried.status = TaskStatus::Running;
    retried.started_at = Some(now.clone());
    retried.completed_at = None;
    retried.last_activity_at = now;
    retried.error = None;
    retried.summary = String::new();
    registry
        .tasks
        .write()
        .await
        .insert(task_id.to_string(), retried.clone());
    registry.persist().await;
    let manager = manager.clone();
    let tasks = registry.tasks.clone();
    let task_batches = registry.task_batches.clone();
    let registry = registry.clone();
    let run_task_id = task_id.to_string();
    tokio::spawn(async move {
        execute_delegated_task(
            manager,
            tasks,
            task_batches,
            registry,
            run_task_id,
            task.batch_id.clone(),
            task.agent_id.clone(),
            task.parent_agent_id.clone(),
            task.delegated_task.clone(),
            task.timeout_secs,
            uuid::Uuid::new_v4().to_string(),
            0,
            task.parent_agent_id.clone(),
            vec![task.agent_id.clone()],
        )
        .await;
    });
    Ok(retried)
}

async fn retry_task(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<AgentTask>, (StatusCode, Json<ApiError>)> {
    retry_task_impl(state.manager, state.registry, &task_id)
        .await
        .map(Json)
        .map_err(|error| {
            let status = if error.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::CONFLICT
            };
            api_error(status, "retry_failed", error, None)
        })
}

async fn try_resume_task_batch(
    manager: Arc<AgentManager>,
    tasks: Arc<RwLock<HashMap<String, AgentTask>>>,
    batches: Arc<RwLock<HashMap<String, AgentTaskBatch>>>,
    batch_id: &str,
    registry: &TaskRegistry,
) {
    let mut resumed = false;
    let (parent_agent_id, task_ids) = {
        let tasks_guard = tasks.read().await;
        let mut batches_guard = batches.write().await;
        let Some(batch) = batches_guard.get_mut(batch_id) else {
            return;
        };
        let all_finished = !batch.task_ids.is_empty()
            && batch.task_ids.iter().all(|task_id| {
                tasks_guard
                    .get(task_id)
                    .is_some_and(|task| task.status.is_terminal())
            });
        if !batch.sealed || !all_finished || batch.resume_triggered {
            return;
        }
        batch.resume_triggered = true;
        batch.status = if batch.task_ids.iter().any(|task_id| {
            tasks_guard
                .get(task_id)
                .is_some_and(|task| task.status != TaskStatus::Completed)
        }) {
            BatchStatus::Error
        } else {
            BatchStatus::Completed
        };
        resumed = true;
        (batch.parent_agent_id.clone(), batch.task_ids.clone())
    };
    if resumed {
        registry.persist().await;
    }

    let results = {
        let tasks_guard = tasks.read().await;
        task_ids
            .iter()
            .filter_map(|task_id| tasks_guard.get(task_id).cloned())
            .collect::<Vec<_>>()
    };
    let details = serde_json::json!({
        "batchId": batch_id,
        "results": results,
    });
    let content = format!(
        "[SUB_AGENT_BATCH_COMPLETED]\n\nAll delegated tasks in batch {batch_id} have finished. Continue the original task using the structured results in this message. Synthesize the findings instead of merely repeating them, resolve conflicts or omissions, perform any necessary verification or remaining work, and answer the user when the task is complete. Do not wait for or poll these finished Agents.\n\n{}",
        serde_json::to_string_pretty(&details).unwrap_or_else(|_| "{}".to_string())
    );
    if let Err(error) = manager
        .append_agent_task_batch_completed(&parent_agent_id, &details, content)
        .await
    {
        log::warn!("Failed to resume completed Agent task batch: {error}");
        if let Some(batch) = batches.write().await.get_mut(batch_id) {
            batch.resume_triggered = false;
        }
    }
}

/// Run one delegated task to completion: ask the child agent, reconcile the
/// structured result against its real tool traces, persist the outcome,
/// backfill the parent, and resume the sealed batch once. Shared by first
/// dispatch and task-level retry.
#[allow(clippy::too_many_arguments)]
async fn execute_delegated_task(
    manager: Arc<AgentManager>,
    tasks: Arc<RwLock<HashMap<String, AgentTask>>>,
    task_batches: Arc<RwLock<HashMap<String, AgentTaskBatch>>>,
    registry: TaskRegistry,
    task_id: String,
    batch_id: String,
    agent_id: String,
    parent_agent_id: String,
    delegated_task: String,
    timeout_secs: u64,
    request_id: String,
    request_depth: u64,
    source_agent_id: String,
    visited_agent_ids: Vec<String>,
) {
    if let Some(batch) = task_batches.write().await.get_mut(&batch_id) {
        batch.status = BatchStatus::Running;
    }
    let outcome = {
        let activity = Arc::new(Mutex::new(CollectedToolActivity::default()));
        let (trace_collector, stop_collector) =
            spawn_tool_trace_collector(&manager, &agent_id, activity.clone());
        let outcome = manager
            .ask(
                &agent_id,
                delegated_task.clone(),
                timeout_secs,
                CollaborationContext {
                    request_id,
                    request_depth,
                    source_agent_id: source_agent_id.clone(),
                    visited_agent_ids,
                },
            )
            .await;
        let _ = stop_collector.send(true);
        let _ = trace_collector.await;
        let collected = activity.lock().await.clone();
        (outcome, collected)
    };
    let (outcome, collected) = outcome;
    let mut completed_task = tasks
        .read()
        .await
        .get(&task_id)
        .cloned()
        .expect("delegated task must exist");
    let completed_at = chrono::Utc::now().to_rfc3339();
    completed_task.completed_at = Some(completed_at.clone());
    completed_task.last_activity_at = completed_at;
    if completed_task.status == TaskStatus::Stopped {
        // A control-plane cancellation won the race; do not overwrite it
        // with the abort error returned by the in-flight ask operation.
    } else {
        match outcome {
            Ok(final_text) => {
                let mut generated = sanitize_generated_summary(
                    match manager
                        .summarize_task_result(&agent_id, delegated_task, final_text.clone(), 120)
                        .await
                    {
                        Ok(text) => parse_generated_task_summary(&text)
                            .unwrap_or_else(|error| fallback_summary(&final_text, &error)),
                        Err(error) => fallback_summary(&final_text, &error),
                    },
                );
                // Cross-check the summarizer's claims against the tool
                // traces the child agent actually produced: real file
                // edits are merged in, uncorroborated claims are flagged,
                // and successful commands become verification evidence.
                for file in &collected.changed_files {
                    if !generated.changed_files.iter().any(|seen| seen == file) {
                        generated.changed_files.push(file.clone());
                    }
                }
                if !generated.changed_files.is_empty() && collected.changed_files.is_empty() {
                    generated
                        .remaining_risks
                        .push("Summarizer-reported files were not observed in tool traces"
                            .to_string());
                }
                if !collected.verified_commands.is_empty() {
                    generated.verification.push(format!(
                        "Tool trace: `{}` succeeded",
                        collected.verified_commands.join("`, `")
                    ));
                }
                if !collected.failed_test_commands.is_empty() {
                    generated.remaining_risks.push(format!(
                        "Failing test commands observed in tool traces: `{}`",
                        collected.failed_test_commands.join("`, `")
                    ));
                }
                completed_task.status = TaskStatus::Completed;
                completed_task.summary = generated.summary;
                completed_task.changed_files = generated.changed_files;
                completed_task.verification = generated.verification;
                completed_task.remaining_risks = generated.remaining_risks;
                completed_task.final_text = truncate_chars(&final_text, MAX_FINAL_TEXT_CHARS);
                if !collected.failed_test_commands.is_empty() {
                    // A failed test run invalidates the summarizer's
                    // success verdict: report the task as an error so the
                    // parent and the Studio panel never treat it as done.
                    completed_task.status = TaskStatus::Error;
                    completed_task.error = Some(format!(
                        "A test command failed during the task: `{}`",
                        collected.failed_test_commands.join("`, `")
                    ));
                }
            }
            Err(error) => {
                completed_task.status = TaskStatus::Error;
                completed_task.error = Some(error);
            }
        }
    }
    tasks
        .write()
        .await
        .insert(task_id.clone(), completed_task.clone());
    registry.persist().await;
    if parent_agent_id != "unknown" {
        match serde_json::to_value(&completed_task) {
            Ok(result) => {
                manager.notify_agent_task_result(&parent_agent_id, &result);
                if let Err(error) = manager
                    .append_agent_task_result(&parent_agent_id, &result)
                    .await
                {
                    log::warn!("Failed to backfill Agent task result: {error}");
                }
            }
            Err(error) => log::warn!("Failed to serialize Agent task result: {error}"),
        }
        try_resume_task_batch(
            manager.clone(),
            tasks.clone(),
            task_batches,
            &batch_id,
            &registry,
        )
        .await;
    }
}

async fn seal_task_batch(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(batch_id): axum::extract::Path<String>,
    Json(body): Json<SealBatchBody>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    {
        let mut batches = state.task_batches.write().await;
        let Some(batch) = batches.get_mut(&batch_id) else {
            // A turn with no delegation has nothing to seal.
            return Ok(StatusCode::NO_CONTENT);
        };
        if batch.parent_agent_id != body.source_agent_id {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "batch_owner_mismatch",
                "Task batch belongs to another Agent",
                None,
            ));
        }
        batch.sealed = true;
    }
    state.registry.persist().await;
    try_resume_task_batch(
        state.manager.clone(),
        state.tasks.clone(),
        state.task_batches.clone(),
        &batch_id,
        &state.registry,
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct WaitTasksBody {
    task_ids: Vec<String>,
    #[serde(default = "default_wait_for")]
    wait_for: String,
    #[serde(default = "default_wait_timeout")]
    timeout_secs: u64,
}

fn default_wait_for() -> String {
    "all".to_string()
}

fn default_wait_timeout() -> u64 {
    30
}

#[derive(Serialize)]
struct WaitTasksResponse {
    tasks: Vec<AgentTask>,
    timed_out: bool,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

fn api_error(
    status: StatusCode,
    code: &str,
    error: impl Into<String>,
    request_id: Option<String>,
) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: error.into(),
            code: code.to_string(),
            request_id,
        }),
    )
}

fn parse_generated_task_summary(text: &str) -> Result<GeneratedTaskSummary, String> {
    let start = text
        .find('{')
        .ok_or_else(|| "Task summarizer returned no JSON object".to_string())?;
    let end = text
        .rfind('}')
        .ok_or_else(|| "Task summarizer returned incomplete JSON".to_string())?;
    serde_json::from_str(&text[start..=end])
        .map_err(|error| format!("Task summarizer returned invalid JSON: {error}"))
}

fn fallback_summary(final_text: &str, error: &str) -> GeneratedTaskSummary {
    GeneratedTaskSummary {
        summary: final_text.chars().take(240).collect(),
        remaining_risks: vec![format!("Structured summary generation failed: {error}")],
        ..GeneratedTaskSummary::default()
    }
}

const MAX_SUMMARY_CHARS: usize = 1_000;
const MAX_FINAL_TEXT_CHARS: usize = 20_000;
const MAX_SUMMARY_LIST_ENTRIES: usize = 50;
const MAX_SUMMARY_ENTRY_CHARS: usize = 500;

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Enforce schema sanity on summarizer-produced fields: bounded list sizes
/// and entry lengths so a runaway summary cannot bloat task state, the
/// parent context, or the persisted snapshot.
fn sanitize_generated_summary(mut summary: GeneratedTaskSummary) -> GeneratedTaskSummary {
    summary.summary = truncate_chars(&summary.summary, MAX_SUMMARY_CHARS);
    let clamp = |items: &mut Vec<String>| {
        items.truncate(MAX_SUMMARY_LIST_ENTRIES);
        for item in items.iter_mut() {
            *item = truncate_chars(item, MAX_SUMMARY_ENTRY_CHARS);
        }
    };
    clamp(&mut summary.changed_files);
    clamp(&mut summary.verification);
    clamp(&mut summary.remaining_risks);
    summary
}

/// Tool activity observed on the child agent while a delegated task runs,
/// used to cross-check the summarizer's structured result against what the
/// agent actually did.
#[derive(Clone, Default)]
struct CollectedToolActivity {
    changed_files: Vec<String>,
    verified_commands: Vec<String>,
    failed_test_commands: Vec<String>,
    pending_bash: HashMap<String, String>,
}

const MAX_COLLECTED_CHANGED_FILES: usize = 50;
const MAX_COLLECTED_VERIFIED_COMMANDS: usize = 20;

/// Update the collected activity from one tool execution event.
fn record_tool_trace_event(event: &serde_json::Value, collected: &mut CollectedToolActivity) {
    match event["type"].as_str() {
        Some("tool_execution_start") => {
            let args = &event["args"];
            match event["toolName"].as_str() {
                Some("edit") | Some("write") => {
                    if let Some(path) = args["path"].as_str() {
                        if !collected.changed_files.iter().any(|seen| seen == path)
                            && collected.changed_files.len() < MAX_COLLECTED_CHANGED_FILES
                        {
                            collected.changed_files.push(path.to_string());
                        }
                    }
                }
                Some("bash") => {
                    if let (Some(call_id), Some(command)) =
                        (event["toolCallId"].as_str(), args["command"].as_str())
                    {
                        collected
                            .pending_bash
                            .insert(call_id.to_string(), command.to_string());
                    }
                }
                _ => {}
            }
        }
        Some("tool_execution_end") => {
            if event["toolName"].as_str() == Some("bash") {
                if let Some(call_id) = event["toolCallId"].as_str() {
                    let Some(command) = collected.pending_bash.remove(call_id) else {
                        return;
                    };
                    if event["isError"].as_bool() == Some(true) {
                        // A failed test run must never leave the task marked
                        // as a success. The heuristic skips innocuous
                        // failures like `grep` finding no match.
                        if command.contains("test")
                            && collected.failed_test_commands.len()
                                < MAX_COLLECTED_VERIFIED_COMMANDS
                            && !collected
                                .failed_test_commands
                                .iter()
                                .any(|seen| seen == &command)
                        {
                            collected.failed_test_commands.push(command);
                        }
                    } else if collected.verified_commands.len() < MAX_COLLECTED_VERIFIED_COMMANDS
                        && !collected
                            .verified_commands
                            .iter()
                            .any(|seen| seen == &command)
                    {
                        collected.verified_commands.push(command);
                    }
                }
            }
        }
        _ => {}
    }
}

/// Watch a child agent's real tool execution events for the duration of a
/// delegated task: edit/write calls record changed file paths and successful
/// bash calls record verification evidence. Returns a stop signal; once
/// signalled, the collector drains any buffered events before exiting, so
/// callers must await the handle to guarantee complete collection.
fn spawn_tool_trace_collector(
    manager: &AgentManager,
    agent_id: &str,
    activity: Arc<Mutex<CollectedToolActivity>>,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::watch::Sender<bool>,
) {
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let mut events = manager.subscribe_global();
    let agent_id = agent_id.to_string();
    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                recv = events.recv() => {
                    match recv {
                        Ok((event_agent_id, event)) if event_agent_id == agent_id => {
                            let mut collected = activity.lock().await;
                            record_tool_trace_event(&event, &mut collected);
                        }
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = stop_rx.changed() => {
                    // Drain whatever the host already broadcast before the
                    // stop signal so late-but-sent tool events are not lost.
                    loop {
                        match events.try_recv() {
                            Ok((event_agent_id, event)) if event_agent_id == agent_id => {
                                let mut collected = activity.lock().await;
                                record_tool_trace_event(&event, &mut collected);
                            }
                            Ok(_) => {}
                            Err(_) => break,
                        }
                    }
                    break;
                }
            }
        }
    });
    (handle, stop_tx)
}

async fn spawn_agent(
    AxumState(state): AxumState<AppState>,
    Json(body): Json<SpawnBody>,
) -> Result<Json<SpawnResponse>, (StatusCode, Json<ApiError>)> {
    let request = SpawnRequest {
        cwd: body.cwd,
        parent_agent_id: body.parent_agent_id,
        model: body.model,
        provider: body.provider,
        args: None,
        depth: body.depth,
    };
    let info = state
        .manager
        .spawn(request)
        .await
        .map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, "spawn_failed", e, None))?;

    let agent_id = info.id.clone();
    Ok(Json(SpawnResponse { agent_id, info }))
}

async fn send_prompt(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let not_found = || {
        api_error(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            "Agent not found",
            None,
        )
    };
    let process = state
        .manager
        .get_process(&agent_id)
        .await
        .ok_or_else(not_found)?;
    // Queue behind any in-flight ask() on this agent.
    let _guard = process.prompt_lock.lock().await;
    state
        .manager
        .send_prompt(
            &agent_id,
            body.message,
            body.images,
            body.file_references,
            None,
        )
        .await
        .map_err(|e| api_error(StatusCode::NOT_FOUND, "prompt_failed", e, None))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ask_agent(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<AskBody>,
) -> Result<Json<AskResponse>, (StatusCode, Json<ApiError>)> {
    let request_id = if body.request_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        body.request_id.clone()
    };
    if body.request_depth > MAX_REQUEST_DEPTH {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "depth_limit",
            format!(
                "Agent request depth {} exceeds maximum {}",
                body.request_depth, MAX_REQUEST_DEPTH
            ),
            Some(request_id),
        ));
    }
    if body
        .visited_agent_ids
        .iter()
        .any(|visited| visited == &agent_id)
    {
        return Err(api_error(
            StatusCode::CONFLICT,
            "cycle_detected",
            format!(
                "Agent request cycle blocked: target {} was already visited",
                agent_id
            ),
            Some(request_id),
        ));
    }
    let source_agent_id = if body.source_agent_id.is_empty() {
        "unknown".to_string()
    } else {
        body.source_agent_id.clone()
    };
    if let Err(code) =
        state
            .request_tracker
            .lock()
            .await
            .check(&source_agent_id, &agent_id, &body.question)
    {
        let message = if code == "duplicate_request" {
            "Repeated agent request blocked"
        } else {
            "Agent request rate limit exceeded"
        };
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            message,
            Some(request_id),
        ));
    }
    let collaboration_context = CollaborationContext {
        request_id: request_id.clone(),
        request_depth: body.request_depth,
        source_agent_id: source_agent_id.to_string(),
        visited_agent_ids: {
            let mut visited = body.visited_agent_ids;
            if !visited.iter().any(|visited| visited == &agent_id) {
                visited.push(agent_id.clone());
            }
            visited
        },
    };
    let reply = state
        .manager
        .ask(
            &agent_id,
            body.question,
            body.timeout_secs,
            collaboration_context,
        )
        .await
        .map_err(|e| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                if e.contains("timed out") {
                    "timeout"
                } else {
                    "ask_failed"
                },
                e,
                Some(request_id),
            )
        })?;
    Ok(Json(AskResponse { reply }))
}

async fn delegate_task(
    AxumState(state): AxumState<AppState>,
    Json(body): Json<DelegateBody>,
) -> Result<Json<DelegateResponse>, (StatusCode, Json<ApiError>)> {
    let request_id = if body.request_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        body.request_id.clone()
    };
    if body.token_budget == 0 || body.token_budget > MAX_TASK_TOKEN_BUDGET {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "task_token_budget_exceeded",
            format!("Task token budget must be between 1 and {MAX_TASK_TOKEN_BUDGET}"),
            Some(request_id),
        ));
    }
    if body.cost_budget_micro_usd == 0
        || body.cost_budget_micro_usd > MAX_TASK_COST_BUDGET_MICRO_USD
    {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "task_cost_budget_exceeded",
            format!(
                "Task cost budget must be between 1 and {MAX_TASK_COST_BUDGET_MICRO_USD} micro-USD"
            ),
            Some(request_id),
        ));
    }
    let queue_permit = state.queue_slots.clone().try_acquire_owned().map_err(|_| {
        api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "task_queue_full",
            format!("Agent task queue limit ({MAX_QUEUED_TASKS}) reached"),
            Some(request_id.clone()),
        )
    })?;
    if body.request_depth > MAX_REQUEST_DEPTH {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "depth_limit",
            format!(
                "Agent request depth {} exceeds maximum {}",
                body.request_depth, MAX_REQUEST_DEPTH
            ),
            Some(request_id),
        ));
    }

    let (agent_id, created_agent) = if let Some(agent_id) = body.agent_id {
        if body
            .visited_agent_ids
            .iter()
            .any(|visited| visited == &agent_id)
        {
            return Err(api_error(
                StatusCode::CONFLICT,
                "cycle_detected",
                format!("Agent request cycle blocked: target {agent_id} was already visited"),
                Some(request_id),
            ));
        }
        state.manager.get_info(&agent_id).await.map_err(|e| {
            api_error(
                StatusCode::NOT_FOUND,
                "agent_not_found",
                e,
                Some(request_id.clone()),
            )
        })?;
        (agent_id, false)
    } else {
        let info = state
            .manager
            .spawn(SpawnRequest {
                cwd: body.cwd,
                parent_agent_id: (!body.source_agent_id.is_empty())
                    .then_some(body.source_agent_id.clone()),
                model: body.model,
                provider: body.provider,
                args: None,
                depth: body.depth,
            })
            .await
            .map_err(|e| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "spawn_failed",
                    e,
                    Some(request_id.clone()),
                )
            })?;
        (info.id, true)
    };

    let source_agent_id = if body.source_agent_id.is_empty() {
        "unknown".to_string()
    } else {
        body.source_agent_id.clone()
    };
    if let Err(code) =
        state
            .request_tracker
            .lock()
            .await
            .check(&source_agent_id, &agent_id, &body.task)
    {
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            code,
            if code == "duplicate_request" {
                "Repeated agent request blocked"
            } else {
                "Agent request rate limit exceeded"
            },
            Some(request_id),
        ));
    }

    let task_id = format!("task-{}", uuid::Uuid::new_v4());
    let batch_id = if body.batch_id.is_empty() {
        format!("batch-{}", uuid::Uuid::new_v4())
    } else {
        body.batch_id.clone()
    };
    let now = chrono::Utc::now().to_rfc3339();
    let task = AgentTask {
        task_id: task_id.clone(),
        batch_id: batch_id.clone(),
        agent_id: agent_id.clone(),
        status: TaskStatus::Queued,
        parent_agent_id: source_agent_id.clone(),
        delegated_task: body.task.clone(),
        created_at: now.clone(),
        started_at: None,
        completed_at: None,
        last_activity_at: now,
        token_budget: body.token_budget,
        cost_budget_micro_usd: body.cost_budget_micro_usd,
        timeout_secs: body.timeout_secs,
        summary: String::new(),
        changed_files: Vec::new(),
        verification: Vec::new(),
        remaining_risks: Vec::new(),
        final_text: String::new(),
        error: None,
    };
    state.tasks.write().await.insert(task_id.clone(), task);
    state.registry.persist().await;
    {
        let mut batches = state.task_batches.write().await;
        let batch = batches
            .entry(batch_id.clone())
            .or_insert_with(|| AgentTaskBatch {
                batch_id: batch_id.clone(),
                parent_agent_id: source_agent_id.clone(),
                token_budget: 0,
                cost_budget_micro_usd: 0,
                ..AgentTaskBatch::default()
            });
        if batch.parent_agent_id != source_agent_id {
            return Err(api_error(
                StatusCode::CONFLICT,
                "batch_owner_mismatch",
                "Task batch belongs to another Agent",
                Some(request_id),
            ));
        }
        if batch.token_budget.saturating_add(body.token_budget) > MAX_BATCH_TOKEN_BUDGET {
            state.tasks.write().await.remove(&task_id);
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "batch_token_budget_exceeded",
                format!("Batch token budget limit ({MAX_BATCH_TOKEN_BUDGET}) exceeded"),
                Some(request_id),
            ));
        }
        if batch
            .cost_budget_micro_usd
            .saturating_add(body.cost_budget_micro_usd)
            > MAX_BATCH_COST_BUDGET_MICRO_USD
        {
            state.tasks.write().await.remove(&task_id);
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "batch_cost_budget_exceeded",
                format!("Batch cost budget limit ({MAX_BATCH_COST_BUDGET_MICRO_USD} micro-USD) exceeded"),
                Some(request_id),
            ));
        }
        batch.token_budget += body.token_budget;
        batch.cost_budget_micro_usd += body.cost_budget_micro_usd;
        batch.task_ids.push(task_id.clone());
    }
    state
        .manager
        .notify_delegated_task(&agent_id, &source_agent_id, &body.task);

    let manager = state.manager.clone();
    let tasks = state.tasks.clone();
    let task_batches = state.task_batches.clone();
    let registry = state.registry.clone();
    let task_slots = state.task_slots.clone();
    let background_batch_id = batch_id.clone();
    let background_task_id = task_id.clone();
    let background_agent_id = agent_id.clone();
    let parent_agent_id = source_agent_id.clone();
    let delegated_task = body.task.clone();
    let mut visited_agent_ids = body.visited_agent_ids;
    if !visited_agent_ids.iter().any(|visited| visited == &agent_id) {
        visited_agent_ids.push(agent_id.clone());
    }
    tokio::spawn(async move {
        let _queue_permit = queue_permit;
        let _task_permit = match task_slots.acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => return,
        };
        loop {
            let (can_start, cancelled_while_queued) = {
                let mut all_tasks = tasks.write().await;
                let already_finished = all_tasks
                    .get(&background_task_id)
                    .is_some_and(|task| task.status.is_terminal());
                if already_finished {
                    // A control-plane cancellation landed while the task was
                    // still queued; never start it.
                    (true, true)
                } else {
                    let parent_running = all_tasks
                        .values()
                        .filter(|task| {
                            task.parent_agent_id == parent_agent_id
                                && task.status == TaskStatus::Running
                        })
                        .count();
                    let batch_running = all_tasks
                        .values()
                        .filter(|task| {
                            task.batch_id == background_batch_id
                                && task.status == TaskStatus::Running
                        })
                        .count();
                    if parent_running < MAX_PARENT_RUNNING_TASKS
                        && batch_running < MAX_BATCH_RUNNING_TASKS
                    {
                        if let Some(task) = all_tasks.get_mut(&background_task_id) {
                            let now = chrono::Utc::now().to_rfc3339();
                            task.status = TaskStatus::Running;
                            task.started_at = Some(now.clone());
                            task.last_activity_at = now;
                        }
                        (true, false)
                    } else {
                        (false, false)
                    }
                }
            };
            if can_start {
                if cancelled_while_queued {
                    return;
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        drop(_queue_permit);
        execute_delegated_task(
            manager,
            tasks,
            task_batches,
            registry,
            background_task_id,
            background_batch_id,
            background_agent_id,
            parent_agent_id,
            delegated_task,
            body.timeout_secs,
            request_id,
            body.request_depth,
            source_agent_id,
            visited_agent_ids,
        )
        .await;
    });

    Ok(Json(DelegateResponse {
        task_id,
        batch_id,
        agent_id,
        created_agent,
        status: "queued".to_string(),
    }))
}

async fn wait_tasks(
    AxumState(state): AxumState<AppState>,
    Json(body): Json<WaitTasksBody>,
) -> Result<Json<WaitTasksResponse>, (StatusCode, Json<ApiError>)> {
    if body.task_ids.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "missing_task_ids",
            "At least one task id is required",
            None,
        ));
    }
    if body.wait_for != "any" && body.wait_for != "all" {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "invalid_wait_mode",
            "wait_for must be 'any' or 'all'",
            None,
        ));
    }

    let deadline = Instant::now() + Duration::from_secs(body.timeout_secs.min(300));
    loop {
        let snapshots = {
            let tasks = state.tasks.read().await;
            body.task_ids
                .iter()
                .filter_map(|task_id| tasks.get(task_id).cloned())
                .collect::<Vec<_>>()
        };
        if snapshots.len() != body.task_ids.len() {
            return Err(api_error(
                StatusCode::NOT_FOUND,
                "task_not_found",
                "One or more Agent tasks were not found",
                None,
            ));
        }
        let finished = |task: &AgentTask| task.status.is_terminal();
        let ready = if body.wait_for == "any" {
            snapshots.iter().any(finished)
        } else {
            snapshots.iter().all(finished)
        };
        if ready || Instant::now() >= deadline || body.timeout_secs == 0 {
            return Ok(Json(WaitTasksResponse {
                tasks: snapshots,
                timed_out: !ready,
            }));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn get_status(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Result<Json<AgentInfo>, (StatusCode, Json<ApiError>)> {
    state
        .manager
        .get_info(&agent_id)
        .await
        .map_err(|e| api_error(StatusCode::NOT_FOUND, "agent_not_found", e, None))?;
    let agents = state.manager.list().await;
    let info = agents
        .into_iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "agent_not_found",
                "Agent not found",
                None,
            )
        })?;
    Ok(Json(info))
}

async fn stop_agent(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    state
        .manager
        .stop(&agent_id)
        .await
        .map_err(|e| api_error(StatusCode::NOT_FOUND, "stop_failed", e, None))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn list_agents(AxumState(state): AxumState<AppState>) -> Json<Vec<AgentInfo>> {
    Json(state.manager.list().await)
}

async fn list_child_agents(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
) -> Result<Json<Vec<AgentInfo>>, (StatusCode, Json<ApiError>)> {
    state
        .manager
        .get_info(&agent_id)
        .await
        .map_err(|error| api_error(StatusCode::NOT_FOUND, "agent_not_found", error, None))?;
    let agents = state.manager.list().await;
    let mut descendant_ids = std::collections::HashSet::from([agent_id]);
    let mut descendants = Vec::new();
    loop {
        let mut found_new = false;
        for agent in &agents {
            if descendant_ids.contains(&agent.id) {
                continue;
            }
            if agent
                .parent_agent_id
                .as_ref()
                .is_some_and(|parent_id| descendant_ids.contains(parent_id))
            {
                descendant_ids.insert(agent.id.clone());
                descendants.push(agent.clone());
                found_new = true;
            }
        }
        if !found_new {
            break;
        }
    }
    Ok(Json(descendants))
}

/// Build the hub API router with token auth applied.
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/agents", get(list_agents).post(spawn_agent))
        .route("/agents/{agent_id}", get(get_status).delete(stop_agent))
        .route("/agents/{agent_id}/children", get(list_child_agents))
        .route("/agents/{agent_id}/parent", get(get_parent_agent))
        .route("/agents/{agent_id}/prompt", post(send_prompt))
        .route("/agents/{agent_id}/ask", post(ask_agent))
        .route("/tasks/delegate", post(delegate_task))
        .route("/tasks", get(list_tasks))
        .route("/tasks/{task_id}", get(get_task))
        .route("/tasks/{task_id}/steer", post(steer_task))
        .route("/tasks/{task_id}/cancel", post(cancel_task))
        .route("/tasks/{task_id}/retry", post(retry_task))
        .route("/tasks/batches/{batch_id}/seal", post(seal_task_batch))
        .route("/tasks/batches/{batch_id}", get(get_task_batch))
        .route("/tasks/wait", post(wait_tasks))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_hub_token,
        ))
        .with_state(state)
}

/// Start the HTTP API server on localhost. Returns the bound port.
pub async fn start_api_server(
    manager: Arc<AgentManager>,
    port: u16,
    registry: TaskRegistry,
) -> Result<u16, String> {
    let state = AppState {
        manager: manager.clone(),
        request_tracker: Arc::new(Mutex::new(RequestTracker::default())),
        tasks: registry.tasks.clone(),
        task_batches: registry.task_batches.clone(),
        registry,
        task_slots: Arc::new(Semaphore::new(MAX_GLOBAL_RUNNING_TASKS)),
        queue_slots: Arc::new(Semaphore::new(MAX_QUEUED_TASKS)),
    };

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("Failed to bind API server: {}", e))?;

    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?
        .port();

    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("API server failed");
    });

    log::info!("Agent API server started on port {}", actual_port);
    Ok(actual_port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state(manager: Arc<AgentManager>) -> AppState {
        let registry = TaskRegistry::default();
        AppState {
            manager,
            request_tracker: Arc::new(Mutex::new(RequestTracker::default())),
            tasks: registry.tasks.clone(),
            task_batches: registry.task_batches.clone(),
            registry,
            task_slots: Arc::new(Semaphore::new(MAX_GLOBAL_RUNNING_TASKS)),
            queue_slots: Arc::new(Semaphore::new(MAX_QUEUED_TASKS)),
        }
    }

    #[tokio::test]
    async fn task_registry_restore_marks_unfinished_work_orphaned() {
        let dir = std::env::temp_dir().join(format!("nova-tasks-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");

        let registry = TaskRegistry::default();
        registry.set_state_path(path.clone()).await;
        let running_task = AgentTask {
            task_id: "task-running".to_string(),
            batch_id: "batch-x".to_string(),
            agent_id: "agent-a".to_string(),
            status: TaskStatus::Running,
            parent_agent_id: "agent-parent".to_string(),
            delegated_task: "half done".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            completed_at: None,
            last_activity_at: "2026-01-01T00:00:00Z".to_string(),
            token_budget: 100,
            cost_budget_micro_usd: 100,
            timeout_secs: 300,
            summary: String::new(),
            changed_files: Vec::new(),
            verification: Vec::new(),
            remaining_risks: Vec::new(),
            final_text: String::new(),
            error: None,
        };
        registry
            .tasks
            .write()
            .await
            .insert("task-running".to_string(), running_task);
        registry
            .task_batches
            .write()
            .await
            .insert("batch-x".to_string(), AgentTaskBatch {
                batch_id: "batch-x".to_string(),
                parent_agent_id: "agent-parent".to_string(),
                task_ids: vec!["task-running".to_string()],
                sealed: true,
                resume_triggered: true,
                status: BatchStatus::Running,
                token_budget: 100,
                cost_budget_micro_usd: 100,
            });
        registry.persist().await;

        // A fresh registry (simulated Studio restart) restores the snapshot:
        // unfinished work becomes orphaned/stopped and the already-triggered
        // resume marker survives so the batch is never summarized twice.
        let restored = TaskRegistry::default();
        restored.set_state_path(path.clone()).await;
        restored.restore().await.unwrap();
        let tasks = restored.tasks.read().await;
        let task = tasks.get("task-running").unwrap();
        assert_eq!(task.status, TaskStatus::Orphaned);
        assert_eq!(
            task.error.as_deref(),
            Some("Studio restarted before this task finished")
        );
        assert!(task.completed_at.is_some());
        drop(tasks);
        let batches = restored.task_batches.read().await;
        let batch = batches.get("batch-x").unwrap();
        assert_eq!(batch.status, BatchStatus::Stopped);
        assert!(batch.sealed);
        assert!(batch.resume_triggered);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn hub_rejects_requests_without_token() {
        let manager = Arc::new(AgentManager::new(
            "true".to_string(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = build_router(test_state(manager.clone()));

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/agents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hub_accepts_request_with_token() {
        let manager = Arc::new(AgentManager::new(
            "true".to_string(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = build_router(test_state(manager.clone()));

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/agents")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn hub_rejects_wrong_token() {
        let manager = Arc::new(AgentManager::new(
            "true".to_string(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = build_router(test_state(manager.clone()));

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/agents")
                    .header("x-nova-token", "wrong-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn delegate_rejects_task_budget_before_spawning() {
        let manager = Arc::new(AgentManager::new(
            "true".to_string(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = build_router(test_state(manager.clone()));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(
                        serde_json::json!({
                            "task": "too expensive",
                            "cwd": "/tmp",
                            "token_budget": MAX_TASK_TOKEN_BUDGET + 1
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn request_tracker_blocks_duplicate_storms() {
        let mut tracker = RequestTracker::default();
        for _ in 0..DUPLICATE_REQUEST_LIMIT {
            assert_eq!(tracker.check("agent-a", "agent-b", "same question"), Ok(()));
        }
        assert_eq!(
            tracker.check("agent-a", "agent-b", "same question"),
            Err("duplicate_request")
        );
    }

    #[tokio::test]
    async fn hub_blocks_agent_request_cycles_before_prompting() {
        let manager = Arc::new(AgentManager::new(
            "true".to_string(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let app = build_router(test_state(manager.clone()));
        let body = serde_json::json!({
            "question": "loop",
            "source_agent_id": "agent-b",
            "request_id": "request-a-b-a",
            "request_depth": 2,
            "visited_agent_ids": ["agent-a", "agent-b"]
        });

        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agents/agent-a/ask")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn delegate_returns_a_task_then_wait_collects_its_result() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let agent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let mut events = manager.subscribe_global();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "background work",
            "agent_id": agent.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-delegate",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            delegated.get("status").and_then(|value| value.as_str()),
            Some("queued")
        );
        let task_id = delegated
            .get("task_id")
            .and_then(|value| value.as_str())
            .unwrap();

        let wait_body = serde_json::json!({
            "task_ids": [task_id],
            "wait_for": "all",
            "timeout_secs": 15
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/wait")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(wait_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let waited: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            waited
                .pointer("/tasks/0/status")
                .and_then(|value| value.as_str()),
            Some("completed")
        );
        assert!(waited
            .pointer("/tasks/0/finalText")
            .and_then(|value| value.as_str())
            .is_some());
        assert_eq!(
            waited
                .pointer("/tasks/0/summary")
                .and_then(|value| value.as_str()),
            Some("mock summary")
        );
        let result_event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let (event_agent_id, event) = events.recv().await.unwrap();
                if event_agent_id == parent.id
                    && event.get("type").and_then(serde_json::Value::as_str)
                        == Some("agent_task_result")
                {
                    break event;
                }
            }
        })
        .await
        .expect("parent did not receive the structured Agent result event");
        assert_eq!(
            result_event
                .pointer("/result/summary")
                .and_then(serde_json::Value::as_str),
            Some("mock summary")
        );
        manager.stop(&agent.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn child_agent_list_excludes_self_and_unrelated_conversations() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let grandchild = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(child.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 2,
            })
            .await
            .unwrap();
        let unrelated = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/agents/{}/children", parent.id))
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed: Vec<AgentInfo> = serde_json::from_slice(&bytes).unwrap();
        let listed_ids = listed
            .iter()
            .map(|agent| agent.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(listed_ids.len(), 2);
        assert!(listed_ids.contains(child.id.as_str()));
        assert!(listed_ids.contains(grandchild.id.as_str()));
        assert!(!listed_ids.contains(parent.id.as_str()));
        assert!(!listed_ids.contains(unrelated.id.as_str()));

        manager.stop(&grandchild.id).await.unwrap();
        manager.stop(&child.id).await.unwrap();
        manager.stop(&unrelated.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn hub_answers_concurrent_asks_without_losing_replies() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child_a = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let child_b = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let ask_body = |target: &str, question: &str| {
            serde_json::json!({
                "question": question,
                "timeout_secs": 10,
                "source_agent_id": parent.id.clone(),
                "request_id": format!("request-{question}"),
                "request_depth": 1,
                "visited_agent_ids": [parent.id.clone()]
            })
            .to_string()
        };

        // Two asks to different agents plus two to the same agent: the
        // per-agent prompt lock must serialize the same-agent pair without
        // dropping or swapping either reply.
        let (res_a, res_b, res_a1, res_a2) = tokio::join!(
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/agents/{}/ask", child_a.id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(ask_body(&child_a.id, "what is A?")))
                    .unwrap(),
            ),
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/agents/{}/ask", child_b.id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(ask_body(&child_b.id, "what is B?")))
                    .unwrap(),
            ),
            app.clone().oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/agents/{}/ask", child_a.id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(ask_body(&child_a.id, "first concurrent")))
                    .unwrap(),
            ),
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/agents/{}/ask", child_a.id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(ask_body(&child_a.id, "second concurrent")))
                    .unwrap(),
            ),
        );
        let res_a = res_a.unwrap();
        let res_b = res_b.unwrap();
        let res_a1 = res_a1.unwrap();
        let res_a2 = res_a2.unwrap();
        assert_eq!(res_a.status(), StatusCode::OK);
        assert_eq!(res_b.status(), StatusCode::OK);
        assert_eq!(res_a1.status(), StatusCode::OK);
        assert_eq!(res_a2.status(), StatusCode::OK);
        for (res, target) in [
            (res_a, &child_a.id),
            (res_b, &child_b.id),
            (res_a1, &child_a.id),
            (res_a2, &child_a.id),
        ] {
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            let reply: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(
                reply["reply"]
                    .as_str()
                    .unwrap()
                    .contains(format!("id={target}").as_str()),
                "reply should come from the asked agent {target}: {reply}"
            );
        }

        manager.stop(&child_a.id).await.unwrap();
        manager.stop(&child_b.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_stops_an_in_flight_task_and_resumes_the_batch_once() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let mut events = manager.subscribe_global();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "NOVA_MOCK_SLOW long running work",
            "agent_id": child.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-cancel",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let task_id = delegated.get("task_id").and_then(|v| v.as_str()).unwrap();
        let batch_id = delegated.get("batch_id").and_then(|v| v.as_str()).unwrap();

        let sealed = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/batches/{}/seal", batch_id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(
                        Body::from(serde_json::json!({ "source_agent_id": parent.id }).to_string()),
                    )
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sealed.status(), StatusCode::NO_CONTENT);

        let cancelled = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/{}/cancel", task_id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(serde_json::json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);

        let status_response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/tasks/{}", task_id))
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status_response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(task["status"].as_str(), Some("stopped"));
        assert_eq!(task["error"].as_str(), Some("cancelled by user"));
        assert!(task["completedAt"].as_str().is_some());

        // The sealed batch with every task terminal resumes the parent exactly
        // once via an appended hidden batch message.
        let batch_resume = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let (event_agent_id, event) = events.recv().await.unwrap();
                if event_agent_id == parent.id
                    && event["type"] == "response"
                    && event["command"] == "append_custom_message"
                {
                    break event;
                }
            }
        })
        .await
        .expect("cancelled batch did not resume the parent");
        assert_eq!(batch_resume["success"], serde_json::Value::Bool(true));
        tokio::time::timeout(std::time::Duration::from_millis(300), async {
            loop {
                let (_, event) = events.recv().await.unwrap();
                if event["type"] == "response" && event["command"] == "append_custom_message" {
                    panic!("batch resumed the parent more than once");
                }
            }
        })
        .await
        .unwrap_err();

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn delegate_result_cross_checks_files_against_tool_traces() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "NOVA_MOCK_TOOLS background work",
            "agent_id": child.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-trace",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let task_id = delegated.get("task_id").and_then(|v| v.as_str()).unwrap();

        let wait_body = serde_json::json!({
            "task_ids": [task_id],
            "wait_for": "all",
            "timeout_secs": 15
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/wait")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(wait_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let waited: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            waited
                .pointer("/tasks/0/status")
                .and_then(|value| value.as_str()),
            Some("completed")
        );
        // The file the child agent really edited lands in changedFiles even
        // though the summarizer reported none, and the successful bash run
        // becomes verification evidence alongside the summarizer's own.
        let changed_files = waited
            .pointer("/tasks/0/changedFiles")
            .and_then(|value| value.as_array())
            .unwrap();
        assert!(changed_files
            .iter()
            .any(|file| file.as_str() == Some("/tmp/mock-changed.ts")));
        let verification = waited
            .pointer("/tasks/0/verification")
            .and_then(|value| value.as_array())
            .unwrap();
        assert!(verification
            .iter()
            .any(|entry| entry.as_str() == Some("mock check")));
        assert!(verification
            .iter()
            .any(|entry| entry.as_str().is_some_and(|text| text.contains("npm test"))));

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn failed_test_command_never_marks_a_task_successful() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "NOVA_MOCK_TOOLS_FAIL background work",
            "agent_id": child.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-fail",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let task_id = delegated.get("task_id").and_then(|v| v.as_str()).unwrap();

        let wait_body = serde_json::json!({
            "task_ids": [task_id],
            "wait_for": "all",
            "timeout_secs": 15
        });
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/wait")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(wait_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let waited: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        // Even though the agent replied normally, the failed `npm test` in
        // its tool trace downgrades the task to an error.
        assert_eq!(
            waited
                .pointer("/tasks/0/status")
                .and_then(|value| value.as_str()),
            Some("error")
        );
        assert!(waited
            .pointer("/tasks/0/error")
            .and_then(|value| value.as_str())
            .is_some_and(|text| text.contains("npm test")));
        assert!(waited
            .pointer("/tasks/0/remainingRisks")
            .and_then(|value| value.as_array())
            .is_some_and(|risks| risks.iter().any(|risk| risk
                .as_str()
                .is_some_and(|text| text.contains("npm test")))));

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn task_query_endpoints_filter_by_batch_status_and_parent() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "queryable work",
            "agent_id": child.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-query",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let batch_id = delegated.get("batch_id").and_then(|v| v.as_str()).unwrap();

        let query = |app: Router, uri: String| {
            let app = app.clone();
            let token = manager.hub_token.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .uri(uri)
                        .header("x-nova-token", token.as_str())
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };

        // Filter by batch id.
        let response = query(app.clone(), format!("/tasks?batchId={batch_id}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let listed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(listed["tasks"][0]["batchId"].as_str(), Some(batch_id));

        // Filter by an unknown status is a validation error.
        let response = query(app.clone(), "/tasks?status=bogus".to_string()).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        // Batch detail includes the sealed/resume markers and its tasks.
        let response = query(app.clone(), format!("/tasks/batches/{batch_id}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let detail: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(detail["batch"]["batchId"].as_str(), Some(batch_id));
        assert_eq!(detail["batch"]["parentAgentId"].as_str(), Some(parent.id.as_str()));
        assert_eq!(detail["tasks"].as_array().unwrap().len(), 1);

        // Unknown batch is a 404.
        let response = query(app.clone(), "/tasks/batches/batch-does-not-exist".to_string()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // Parent lookup resolves the child's parent to the root agent, and a
        // root agent has a null parent.
        let response = query(app.clone(), format!("/agents/{}/parent", child.id)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let found_parent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(found_parent["id"].as_str(), Some(parent.id.as_str()));

        let response = query(app, format!("/agents/{}/parent", parent.id)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let found_parent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(found_parent.is_null());

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_task_can_be_retried_and_reset_to_running() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let delegate_body = serde_json::json!({
            "task": "NOVA_MOCK_SLOW retryable work",
            "agent_id": child.id,
            "cwd": "/tmp",
            "source_agent_id": parent.id.clone(),
            "request_id": "request-retry",
            "request_depth": 1,
            "visited_agent_ids": [parent.id.clone()]
        });
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/delegate")
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(delegate_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let delegated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let task_id = delegated.get("task_id").and_then(|v| v.as_str()).unwrap();

        // Cancel the in-flight task so it lands in a terminal stopped state.
        let cancelled = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/{}/cancel", task_id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(serde_json::json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);

        // Retrying resets the task and re-dispatches it to the same agent.
        let retried = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/{}/retry", task_id))
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retried.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(retried.into_body(), usize::MAX).await.unwrap();
        let retried_task: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(retried_task["status"].as_str(), Some("running"));
        assert!(retried_task["error"].is_null());
        assert!(retried_task["completedAt"].is_null());
        assert_eq!(
            retried_task["agentId"].as_str(),
            Some(child.id.as_str()),
            "retry must reuse the same child agent"
        );

        // Retrying a running task again is rejected.
        let again = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/{}/retry", task_id))
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(again.status(), StatusCode::CONFLICT);

        // Unknown task ids are 404.
        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/tasks/task-does-not-exist/retry")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        // Tear down the re-dispatched slow task and the agents.
        let _ = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/tasks/{}/cancel", task_id))
                    .header("content-type", "application/json")
                    .header("x-nova-token", manager.hub_token.as_str())
                    .body(Body::from(serde_json::json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn identical_ask_storm_is_rate_limited_while_fresh_asks_pass() {
        let manager = Arc::new(AgentManager::new(
            format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR")),
            std::env::temp_dir().join(format!("nova-studio-{}.json", uuid::Uuid::new_v4())),
        ));
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: None,
                provider: None,
                args: None,
                depth: 0,
            })
            .await
            .unwrap();
        let child = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some(parent.id.clone()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap();
        let app = build_router(test_state(manager.clone()));
        let ask_body = |question: &str| {
            serde_json::json!({
                "question": question,
                "timeout_secs": 10,
                "source_agent_id": parent.id.clone(),
                "request_id": format!("request-storm-{question}"),
                "request_depth": 1,
                "visited_agent_ids": [parent.id.clone()]
            })
            .to_string()
        };
        let child_uri = format!("/agents/{}/ask", child.id);
        let token = manager.hub_token.clone();
        let ask = |app: Router, question: &'static str| {
            let app = app.clone();
            let uri = child_uri.clone();
            let token = token.clone();
            async move {
                app.oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("content-type", "application/json")
                        .header("x-nova-token", token.as_str())
                        .body(Body::from(ask_body(question)))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };

        // DUPLICATE_REQUEST_LIMIT identical asks succeed, then the storm is
        // throttled, while a distinct question from the same source still passes.
        for _ in 0..DUPLICATE_REQUEST_LIMIT {
            let res = ask(app.clone(), "same question").await;
            assert_eq!(res.status(), StatusCode::OK);
        }
        let throttled = ask(app.clone(), "same question").await;
        assert_eq!(throttled.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = axum::body::to_bytes(throttled.into_body(), usize::MAX).await.unwrap();
        let api_error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(api_error["code"].as_str(), Some("duplicate_request"));

        let fresh = ask(app, "a different question").await;
        assert_eq!(fresh.status(), StatusCode::OK);

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }
}
