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
use tokio::sync::{Mutex, RwLock};

const MAX_REQUEST_DEPTH: u64 = 2;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(10);
const DUPLICATE_REQUEST_LIMIT: usize = 3;
const SOURCE_WINDOW: Duration = Duration::from_secs(60);
const SOURCE_REQUEST_LIMIT: usize = 30;

#[derive(Clone)]
struct AppState {
    manager: Arc<AgentManager>,
    request_tracker: Arc<Mutex<RequestTracker>>,
    tasks: Arc<RwLock<HashMap<String, AgentTask>>>,
}

#[derive(Clone, Serialize)]
struct AgentTask {
    task_id: String,
    agent_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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
}

#[derive(Serialize)]
struct DelegateResponse {
    task_id: String,
    agent_id: String,
    created_agent: bool,
    status: String,
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
        .send_prompt(&agent_id, body.message, body.images, body.file_references)
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
    let task = AgentTask {
        task_id: task_id.clone(),
        agent_id: agent_id.clone(),
        status: "running".to_string(),
        result: None,
        error: None,
    };
    state.tasks.write().await.insert(task_id.clone(), task);
    state
        .manager
        .notify_delegated_task(&agent_id, &source_agent_id, &body.task);

    let manager = state.manager.clone();
    let tasks = state.tasks.clone();
    let background_task_id = task_id.clone();
    let background_agent_id = agent_id.clone();
    let mut visited_agent_ids = body.visited_agent_ids;
    if !visited_agent_ids.iter().any(|visited| visited == &agent_id) {
        visited_agent_ids.push(agent_id.clone());
    }
    tokio::spawn(async move {
        let outcome = manager
            .ask(
                &background_agent_id,
                body.task,
                body.timeout_secs,
                CollaborationContext {
                    request_id,
                    request_depth: body.request_depth,
                    source_agent_id,
                    visited_agent_ids,
                },
            )
            .await;
        if let Some(task) = tasks.write().await.get_mut(&background_task_id) {
            match outcome {
                Ok(result) => {
                    task.status = "completed".to_string();
                    task.result = Some(result);
                }
                Err(error) => {
                    task.status = if error.contains("timed out") {
                        "timeout".to_string()
                    } else {
                        "error".to_string()
                    };
                    task.error = Some(error);
                }
            }
        }
    });

    Ok(Json(DelegateResponse {
        task_id,
        agent_id,
        created_agent,
        status: "running".to_string(),
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
        let finished = |task: &AgentTask| task.status != "running";
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
        .route("/agents/{agent_id}/prompt", post(send_prompt))
        .route("/agents/{agent_id}/ask", post(ask_agent))
        .route("/tasks/delegate", post(delegate_task))
        .route("/tasks/wait", post(wait_tasks))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_hub_token,
        ))
        .with_state(state)
}

/// Start the HTTP API server on localhost. Returns the bound port.
pub async fn start_api_server(manager: Arc<AgentManager>, port: u16) -> Result<u16, String> {
    let state = AppState {
        manager: manager.clone(),
        request_tracker: Arc::new(Mutex::new(RequestTracker::default())),
        tasks: Arc::new(RwLock::new(HashMap::new())),
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
        AppState {
            manager,
            request_tracker: Arc::new(Mutex::new(RequestTracker::default())),
            tasks: Arc::new(RwLock::new(HashMap::new())),
        }
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
        let agent = manager
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
        let delegate_body = serde_json::json!({
            "task": "background work",
            "agent_id": agent.id,
            "cwd": "/tmp",
            "source_agent_id": "agent-parent",
            "request_id": "request-delegate",
            "request_depth": 1,
            "visited_agent_ids": ["agent-parent"]
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
            Some("running")
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
            .pointer("/tasks/0/result")
            .and_then(|value| value.as_str())
            .is_some());

        manager.stop(&agent.id).await.unwrap();
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
}
