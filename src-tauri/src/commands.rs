use crate::agent_api::{TaskRegistry, TaskSnapshot};
use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentInfo, FileReference, ImageContent, SpawnRequest};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

const MAX_PROJECT_SCAN_ENTRIES: usize = 50_000;
const MAX_PROJECT_FILE_RESULTS: usize = 200;
const SKIPPED_PROJECT_DIRS: &[&str] = &[
    ".git",
    ".idea",
    ".next",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
];

/// Managed state wrapper for AgentManager
pub struct AgentManagerState(pub Arc<AgentManager>);

/// Managed state wrapper for the shared delegated task registry
pub struct TaskRegistryState(pub TaskRegistry);

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn collect_project_files(cwd: &str, query: &str, limit: usize) -> Result<Vec<String>, String> {
    let root = expand_home(cwd)
        .canonicalize()
        .map_err(|error| format!("Unable to open project directory: {error}"))?;
    if !root.is_dir() {
        return Err("Project path is not a directory".to_string());
    }

    let normalized_query = query.to_lowercase();
    let mut directories = VecDeque::from([root.clone()]);
    let mut matches = Vec::new();
    let mut scanned = 0usize;

    while let Some(directory) = directories.pop_front() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > MAX_PROJECT_SCAN_ENTRIES {
                break;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name();
                if !SKIPPED_PROJECT_DIRS.iter().any(|skipped| name == *skipped) {
                    directories.push_back(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&root) else {
                continue;
            };
            let display = relative.to_string_lossy().replace('\\', "/");
            if normalized_query.is_empty() || display.to_lowercase().contains(&normalized_query) {
                matches.push(display);
            }
        }
        if scanned > MAX_PROJECT_SCAN_ENTRIES {
            break;
        }
    }

    matches.sort_by(|left, right| {
        let left_lower = left.to_lowercase();
        let right_lower = right.to_lowercase();
        let rank = |path: &str| {
            let file_name = Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path);
            if path.starts_with(&normalized_query) {
                0
            } else if file_name.starts_with(&normalized_query) {
                1
            } else {
                2
            }
        };
        rank(&left_lower)
            .cmp(&rank(&right_lower))
            .then_with(|| left_lower.cmp(&right_lower))
    });
    matches.truncate(limit.min(MAX_PROJECT_FILE_RESULTS));
    Ok(matches)
}

#[tauri::command]
pub async fn list_project_files(
    cwd: String,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        collect_project_files(
            &cwd,
            query.as_deref().unwrap_or_default(),
            limit.unwrap_or(80),
        )
    })
    .await
    .map_err(|error| format!("Project file scan failed: {error}"))?
}

#[tauri::command]
pub async fn spawn_agent(
    state: State<'_, AgentManagerState>,
    cwd: String,
    model: Option<String>,
    provider: Option<String>,
) -> Result<AgentInfo, String> {
    log::info!(
        "[cmd] spawn_agent cwd={:?} model={:?} provider={:?}",
        cwd,
        model,
        provider
    );
    let request = SpawnRequest {
        cwd,
        parent_agent_id: None,
        model,
        provider,
        args: None,
        depth: 0,
    };
    let result = state.0.spawn(request).await;
    match &result {
        Ok(info) => log::info!(
            "[cmd] spawn_agent -> id={} status={:?}",
            info.id,
            info.status
        ),
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
    if let Err(error) = state.0.refresh_sessions().await {
        // Keep showing the last known snapshot if Nova is temporarily
        // unavailable. A later list call can reconcile it again.
        log::warn!("[cmd] unable to refresh Nova sessions: {}", error);
    }
    let list = state.0.list().await;
    state.0.request_all_messages().await;
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
pub async fn activate_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<AgentInfo, String> {
    log::info!("[cmd] activate_agent id={}", agent_id);
    state.0.activate(&agent_id).await
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    message: String,
    images: Option<Vec<ImageContent>>,
    file_references: Option<Vec<FileReference>>,
    background_agent_ids: Option<Vec<String>>,
) -> Result<(), String> {
    log::info!(
        "[cmd] send_prompt agent_id={} len={} images={:?}",
        agent_id,
        message.len(),
        images.is_some()
    );
    state
        .0
        .send_prompt(
            &agent_id,
            message,
            images,
            file_references,
            background_agent_ids,
        )
        .await
}

#[tauri::command]
pub async fn abort_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    log::info!("[cmd] abort_agent id={}", agent_id);
    state.0.abort(&agent_id).await
}

#[tauri::command]
pub async fn steer_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    message: String,
) -> Result<(), String> {
    state.0.steer(&agent_id, message).await
}

#[tauri::command]
pub async fn cancel_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    state.0.cancel(&agent_id, reason).await
}

#[tauri::command]
pub async fn force_stop_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    reason: Option<String>,
    timed_out: Option<bool>,
) -> Result<(), String> {
    state
        .0
        .force_stop(&agent_id, reason, timed_out.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn retry_agent(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    message: Option<String>,
) -> Result<(), String> {
    state.0.retry(&agent_id, message).await
}

#[tauri::command]
pub async fn retry_task(
    manager: State<'_, AgentManagerState>,
    registry: State<'_, TaskRegistryState>,
    task_id: String,
) -> Result<crate::agent_api::AgentTask, String> {
    crate::agent_api::retry_task_impl(manager.0.clone(), registry.0.clone(), &task_id).await
}

#[tauri::command]
pub async fn list_agent_tasks(
    state: State<'_, TaskRegistryState>,
) -> Result<TaskSnapshot, String> {
    Ok(state.0.snapshot().await)
}

#[tauri::command]
pub async fn new_session(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.new_session(&agent_id).await
}

#[tauri::command]
pub async fn request_messages(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.request_messages(&agent_id).await
}

#[tauri::command]
pub async fn fork_session(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    entry_id: String,
) -> Result<(), String> {
    state.0.fork_session(&agent_id, entry_id).await
}

#[tauri::command]
pub async fn set_message_feedback(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    entry_id: String,
    rating: Option<String>,
) -> Result<(), String> {
    state.0.set_feedback(&agent_id, entry_id, rating).await
}

#[tauri::command]
pub async fn compact_session(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    instructions: Option<String>,
) -> Result<(), String> {
    state.0.compact(&agent_id, instructions).await
}

#[tauri::command]
pub async fn set_session_name(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    name: String,
) -> Result<(), String> {
    state.0.set_session_name(&agent_id, name).await
}

#[tauri::command]
pub async fn send_extension_ui_response(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    id: String,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: Option<bool>,
) -> Result<(), String> {
    log::info!(
        "[cmd] send_extension_ui_response id={} value={:?} confirmed={:?} cancelled={:?}",
        id,
        value,
        confirmed,
        cancelled
    );
    state
        .0
        .send_extension_ui_response(&agent_id, id, value, confirmed, cancelled)
        .await
}

#[tauri::command]
pub async fn request_session_stats(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.request_session_stats(&agent_id).await
}

#[tauri::command]
pub async fn request_execution_traces(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.request_execution_traces(&agent_id).await
}

#[tauri::command]
pub async fn request_context_snapshot(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.request_context_snapshot(&agent_id).await
}

#[tauri::command]
pub async fn request_available_models(
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    state.0.request_available_models(&agent_id).await
}

#[tauri::command]
pub async fn list_all_models(
    state: State<'_, AgentManagerState>,
) -> Result<Vec<serde_json::Value>, String> {
    state.0.list_all_models().await
}

#[tauri::command]
pub async fn set_model(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    provider: String,
    model_id: String,
) -> Result<(), String> {
    state.0.set_model(&agent_id, provider, model_id).await
}
