use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentInfo, SpawnRequest};
use std::sync::Arc;
use tauri::State;

/// Managed state wrapper for AgentManager
pub struct AgentManagerState(pub Arc<AgentManager>);

#[tauri::command]
pub async fn spawn_agent(
    state: State<'_, AgentManagerState>,
    cwd: String,
    model: Option<String>,
    provider: Option<String>,
) -> Result<AgentInfo, String> {
    let request = SpawnRequest {
        cwd,
        model,
        provider,
        args: None,
    };
    state.0.spawn(request).await
}

#[tauri::command]
pub async fn stop_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.stop(&agent_id).await
}

#[tauri::command]
pub async fn list_agents(state: State<'_, AgentManagerState>) -> Result<Vec<AgentInfo>, String> {
    Ok(state.0.list().await)
}

#[tauri::command]
pub async fn get_agent_info(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    state.0.get_info(&agent_id).await
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    message: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    state.0.send_prompt(&agent_id, message, images).await
}

#[tauri::command]
pub async fn abort_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.abort(&agent_id).await
}
