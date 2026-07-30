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
    log::info!("[cmd] spawn_agent cwd={:?} model={:?} provider={:?}", cwd, model, provider);
    let request = SpawnRequest {
        cwd,
        model,
        provider,
        args: None,
    };
    let result = state.0.spawn(request).await;
    match &result {
        Ok(info) => log::info!("[cmd] spawn_agent -> id={} status={:?}", info.id, info.status),
        Err(e) => log::error!("[cmd] spawn_agent -> error: {}", e),
    }
    result
}

#[tauri::command]
pub async fn stop_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    log::info!("[cmd] stop_agent id={}", agent_id);
    state.0.stop(&agent_id).await
}

#[tauri::command]
pub async fn list_agents(state: State<'_, AgentManagerState>) -> Result<Vec<AgentInfo>, String> {
    let list = state.0.list().await;
    log::debug!("[cmd] list_agents -> {} agents", list.len());
    Ok(list)
}

#[tauri::command]
pub async fn get_agent_info(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    log::debug!("[cmd] get_agent_info id={}", agent_id);
    state.0.get_info(&agent_id).await
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    message: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    log::info!("[cmd] send_prompt agent_id={} len={} images={:?}", agent_id, message.len(), images.is_some());
    state.0.send_prompt(&agent_id, message, images).await
}

#[tauri::command]
pub async fn abort_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    log::info!("[cmd] abort_agent id={}", agent_id);
    state.0.abort(&agent_id).await
}
