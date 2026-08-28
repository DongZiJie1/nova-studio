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
use tokio::sync::Mutex;

const MAX_REQUEST_DEPTH: u64 = 2;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(10);
const DUPLICATE_REQUEST_LIMIT: usize = 3;
const SOURCE_WINDOW: Duration = Duration::from_secs(60);
const SOURCE_REQUEST_LIMIT: usize = 30;

#[derive(Clone)]
struct AppState {
    manager: Arc<AgentManager>,
    request_tracker: Arc<Mutex<RequestTracker>>,
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
        "unknown"
    } else {
        &body.source_agent_id
    };
    if let Err(code) =
        state
            .request_tracker
            .lock()
            .await
            .check(source_agent_id, &agent_id, &body.question)
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

/// Build the hub API router with token auth applied.
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/agents", get(list_agents).post(spawn_agent))
        .route("/agents/{agent_id}", get(get_status).delete(stop_agent))
        .route("/agents/{agent_id}/prompt", post(send_prompt))
        .route("/agents/{agent_id}/ask", post(ask_agent))
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
}
