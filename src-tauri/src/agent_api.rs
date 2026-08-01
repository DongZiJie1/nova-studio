use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentInfo, ImageContent, SpawnRequest};
use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    manager: Arc<AgentManager>,
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
}

async fn spawn_agent(
    AxumState(state): AxumState<AppState>,
    Json(body): Json<SpawnBody>,
) -> Result<Json<SpawnResponse>, (StatusCode, Json<ApiError>)> {
    let request = SpawnRequest {
        cwd: body.cwd,
        model: body.model,
        provider: body.provider,
        args: None,
        depth: body.depth,
    };
    let info = state
        .manager
        .spawn(request)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e })))?;

    let agent_id = info.id.clone();
    Ok(Json(SpawnResponse {
        agent_id,
        info,
    }))
}

async fn send_prompt(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let not_found = || {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Agent not found".to_string(),
            }),
        )
    };
    let process = state.manager.get_process(&agent_id).await.ok_or_else(not_found)?;
    // Queue behind any in-flight ask() on this agent.
    let _guard = process.prompt_lock.lock().await;
    state
        .manager
        .send_prompt(&agent_id, body.message, body.images)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, Json(ApiError { error: e })))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ask_agent(
    AxumState(state): AxumState<AppState>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<AskBody>,
) -> Result<Json<AskResponse>, (StatusCode, Json<ApiError>)> {
    let reply = state
        .manager
        .ask(&agent_id, body.question, body.timeout_secs)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: e })))?;
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
        .map_err(|e| (StatusCode::NOT_FOUND, Json(ApiError { error: e })))?;
    let agents = state.manager.list().await;
    let info = agents
        .into_iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "Agent not found".to_string(),
                }),
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
        .map_err(|e| (StatusCode::NOT_FOUND, Json(ApiError { error: e })))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn list_agents(
    AxumState(state): AxumState<AppState>,
) -> Json<Vec<AgentInfo>> {
    Json(state.manager.list().await)
}

/// Build the hub API router with token auth applied.
fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/agents", get(list_agents).post(spawn_agent))
        .route(
            "/agents/{agent_id}",
            get(get_status).delete(stop_agent),
        )
        .route("/agents/{agent_id}/prompt", post(send_prompt))
        .route("/agents/{agent_id}/ask", post(ask_agent))
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
) -> Result<u16, String> {
    let state = AppState {
        manager: manager.clone(),
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
        axum::serve(listener, app)
            .await
            .expect("API server failed");
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

    #[tokio::test]
    async fn hub_rejects_requests_without_token() {
        let manager = Arc::new(AgentManager::new("true".to_string()));
        let app = build_router(AppState {
            manager: manager.clone(),
        });

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
        let manager = Arc::new(AgentManager::new("true".to_string()));
        let app = build_router(AppState {
            manager: manager.clone(),
        });

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
        let manager = Arc::new(AgentManager::new("true".to_string()));
        let app = build_router(AppState {
            manager: manager.clone(),
        });

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
}
