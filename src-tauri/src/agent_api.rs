use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentInfo, ImageContent, SpawnRequest};
use axum::{
    extract::State as AxumState,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    manager: Arc<AgentManager>,
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
    state
        .manager
        .send_prompt(&agent_id, body.message, body.images)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, Json(ApiError { error: e })))?;
    Ok(Json(serde_json::json!({ "ok": true })))
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

/// Start the HTTP API server on localhost. Returns the bound port.
pub async fn start_api_server(
    manager: Arc<AgentManager>,
    port: u16,
) -> Result<u16, String> {
    let state = AppState {
        manager: manager.clone(),
    };

    let app = Router::new()
        .route("/agents", get(list_agents).post(spawn_agent))
        .route(
            "/agents/{agent_id}",
            get(get_status).delete(stop_agent),
        )
        .route("/agents/{agent_id}/prompt", post(send_prompt))
        .with_state(state);

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
