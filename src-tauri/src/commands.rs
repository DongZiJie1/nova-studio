use crate::agent_api::{TaskRegistry, TaskSnapshot};
use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentInfo, FileReference, ImageContent, SpawnRequest};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfigurationInput {
    provider_id: String,
    /// When omitted, only the provider API key is saved (no models.json entry).
    model_id: Option<String>,
    display_name: Option<String>,
    base_url: String,
    api: String,
    api_key: Option<String>,
    context_window: u64,
    max_tokens: u64,
    reasoning: bool,
    images: bool,
}

fn nova_agent_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("NOVA_CODING_AGENT_DIR") {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("Unable to locate the user home directory")?;
    Ok(PathBuf::from(home).join(".nova").join("agent"))
}

fn read_json_object(path: &Path, root_key: &str) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({ root_key: {} }));
    }
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))?;
    if !value
        .get(root_key)
        .is_some_and(serde_json::Value::is_object)
    {
        return Err(format!(
            "{} must contain a {root_key} object",
            path.display()
        ));
    }
    Ok(value)
}

fn write_private_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())? + "\n";
    let temporary_path = path.with_extension("json.tmp");
    std::fs::write(&temporary_path, content)
        .map_err(|error| format!("Unable to write {}: {error}", temporary_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Unable to secure {}: {error}", temporary_path.display()))?;
    }
    std::fs::rename(&temporary_path, path)
        .map_err(|error| format!("Unable to replace {}: {error}", path.display()))
}

#[tauri::command]
pub async fn save_model_configuration(input: ModelConfigurationInput) -> Result<(), String> {
    let provider_id = input.provider_id.trim();
    let model_id = input.model_id.as_deref().map(str::trim).filter(|model| !model.is_empty());
    let base_url = input.base_url.trim().trim_end_matches('/');
    let api_key = input.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty());
    if provider_id.is_empty() {
        return Err("Provider ID is required".to_string());
    }
    if model_id.is_some() && base_url.is_empty() {
        return Err("Base URL is required when saving a model".to_string());
    }
    if model_id.is_none() && api_key.is_none() {
        return Err("Nothing to save: provide a model or an API key".to_string());
    }
    if model_id.is_some() {
        if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
            return Err("Base URL must start with http:// or https://".to_string());
        }
        const SUPPORTED_APIS: &[&str] = &[
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
        ];
        if !SUPPORTED_APIS.contains(&input.api.as_str()) {
            return Err("Unsupported API type".to_string());
        }
        if input.context_window == 0 || input.max_tokens == 0 || input.max_tokens > input.context_window
        {
            return Err("Token limits are invalid".to_string());
        }
    }

    let agent_dir = nova_agent_dir()?;
    std::fs::create_dir_all(&agent_dir)
        .map_err(|error| format!("Unable to create {}: {error}", agent_dir.display()))?;

    if let Some(model_id) = model_id {
        let models_path = agent_dir.join("models.json");
        let mut config = read_json_object(&models_path, "providers")?;
        let providers = config["providers"]
            .as_object_mut()
            .expect("validated providers object");
        let provider = providers
            .entry(provider_id.to_string())
            .or_insert_with(|| serde_json::json!({}));
        let provider_object = provider
            .as_object_mut()
            .ok_or_else(|| format!("Provider {provider_id} must be an object"))?;
        provider_object.insert("baseUrl".to_string(), serde_json::json!(base_url));
        provider_object.insert("api".to_string(), serde_json::json!(input.api));
        let models = provider_object
            .entry("models".to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("Provider {provider_id} models must be an array"))?;
        let mut model = serde_json::json!({
            "id": model_id,
            "reasoning": input.reasoning,
            "input": if input.images { vec!["text", "image"] } else { vec!["text"] },
            "contextWindow": input.context_window,
            "maxTokens": input.max_tokens,
        });
        if let Some(name) = input
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            model["name"] = serde_json::json!(name);
        }
        if let Some(existing) = models
            .iter_mut()
            .find(|model| model.get("id").and_then(|id| id.as_str()) == Some(model_id))
        {
            *existing = model;
        } else {
            models.push(model);
        }
        write_private_json(&models_path, &config)?;
    }

    if let Some(api_key) = api_key {
        let auth_path = agent_dir.join("auth.json");
        let mut auth = if auth_path.exists() {
            let content = std::fs::read_to_string(&auth_path)
                .map_err(|error| format!("Unable to read {}: {error}", auth_path.display()))?;
            serde_json::from_str::<serde_json::Value>(&content)
                .map_err(|error| format!("Unable to parse {}: {error}", auth_path.display()))?
        } else {
            serde_json::json!({})
        };
        let auth_object = auth
            .as_object_mut()
            .ok_or("auth.json must contain an object")?;
        auth_object.insert(
            provider_id.to_string(),
            serde_json::json!({ "type": "api_key", "key": api_key }),
        );
        write_private_json(&auth_path, &auth)?;
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelInfo {
    id: String,
    name: Option<String>,
    reasoning: bool,
    images: bool,
    context_window: u64,
    max_tokens: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfiguration {
    provider_id: String,
    base_url: Option<String>,
    api: Option<String>,
    /// Plaintext API key. Masking / reveal happens in the frontend only.
    api_key: Option<String>,
    /// Where the key was found: "auth" (auth.json) or "models" (models.json).
    api_key_source: Option<String>,
    models: Vec<ProviderModelInfo>,
}

fn read_auth_object(agent_dir: &Path) -> serde_json::Value {
    let auth_path = agent_dir.join("auth.json");
    std::fs::read_to_string(&auth_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

fn parse_provider_model(model: &serde_json::Value) -> Option<ProviderModelInfo> {
    let object = model.as_object()?;
    let id = object.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let images = object
        .get("input")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|input| input.iter().any(|item| item.as_str() == Some("image")));
    Some(ProviderModelInfo {
        id,
        name: object.get("name").and_then(serde_json::Value::as_str).map(str::to_string),
        reasoning: object.get("reasoning").and_then(serde_json::Value::as_bool).unwrap_or(false),
        images,
        context_window: object.get("contextWindow").and_then(serde_json::Value::as_u64).unwrap_or(0),
        max_tokens: object.get("maxTokens").and_then(serde_json::Value::as_u64).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn get_model_configurations() -> Result<Vec<ProviderConfiguration>, String> {
    let agent_dir = nova_agent_dir()?;
    let config = read_json_object(&agent_dir.join("models.json"), "providers")?;
    let auth = read_auth_object(&agent_dir);
    let Some(providers) = config["providers"].as_object() else {
        return Ok(Vec::new());
    };
    let mut configurations = Vec::new();
    for (provider_id, provider) in providers {
        let Some(provider_object) = provider.as_object() else {
            continue;
        };
        let auth_key = auth
            .get(provider_id)
            .and_then(|entry| entry.get("key"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let (api_key, api_key_source) = if let Some(key) = auth_key {
            (Some(key), Some("auth".to_string()))
        } else {
            match provider_object.get("apiKey").and_then(serde_json::Value::as_str) {
                Some(key) => (Some(key.to_string()), Some("models".to_string())),
                None => (None, None),
            }
        };
        let models = provider_object
            .get("models")
            .and_then(serde_json::Value::as_array)
            .map(|models| models.iter().filter_map(parse_provider_model).collect())
            .unwrap_or_default();
        configurations.push(ProviderConfiguration {
            provider_id: provider_id.clone(),
            base_url: provider_object.get("baseUrl").and_then(serde_json::Value::as_str).map(str::to_string),
            api: provider_object.get("api").and_then(serde_json::Value::as_str).map(str::to_string),
            api_key,
            api_key_source,
            models,
        });
    }
    // Built-in providers connected only through auth.json (no models.json entry).
    if let Some(auth_object) = auth.as_object() {
        for (provider_id, entry) in auth_object {
            if providers.contains_key(provider_id.as_str()) {
                continue;
            }
            configurations.push(ProviderConfiguration {
                provider_id: provider_id.clone(),
                base_url: None,
                api: None,
                api_key: entry.get("key").and_then(serde_json::Value::as_str).map(str::to_string),
                api_key_source: Some("auth".to_string()),
                models: Vec::new(),
            });
        }
    }
    configurations.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
    Ok(configurations)
}

fn remove_auth_entry(agent_dir: &Path, provider_id: &str) -> Result<bool, String> {
    let auth_path = agent_dir.join("auth.json");
    if !auth_path.exists() {
        return Ok(false);
    }
    let mut auth = read_auth_object(agent_dir);
    let Some(auth_object) = auth.as_object_mut() else {
        return Ok(false);
    };
    if auth_object.remove(provider_id).is_none() {
        return Ok(false);
    }
    write_private_json(&auth_path, &auth)?;
    Ok(true)
}

#[tauri::command]
pub async fn delete_model_configuration(provider_id: String, model_id: String) -> Result<(), String> {
    let agent_dir = nova_agent_dir()?;
    let models_path = agent_dir.join("models.json");
    let mut config = read_json_object(&models_path, "providers")?;
    let providers = config["providers"]
        .as_object_mut()
        .ok_or("models.json must contain a providers object")?;
    let provider = providers
        .get_mut(provider_id.as_str())
        .ok_or_else(|| format!("Provider {provider_id} is not a custom provider"))?;
    let provider_object = provider
        .as_object_mut()
        .ok_or_else(|| format!("Provider {provider_id} must be an object"))?;
    let models = provider_object
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| format!("Provider {provider_id} has no models array"))?;
    let before = models.len();
    models.retain(|model| model.get("id").and_then(serde_json::Value::as_str) != Some(model_id.as_str()));
    if models.len() == before {
        return Err(format!("Model {model_id} not found for provider {provider_id}"));
    }
    if models.is_empty() {
        providers.remove(provider_id.as_str());
        write_private_json(&models_path, &config)?;
        remove_auth_entry(&agent_dir, &provider_id)?;
    } else {
        write_private_json(&models_path, &config)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_provider_configuration(provider_id: String) -> Result<(), String> {
    let agent_dir = nova_agent_dir()?;
    let models_path = agent_dir.join("models.json");
    let mut config = read_json_object(&models_path, "providers")?;
    let providers = config["providers"]
        .as_object_mut()
        .ok_or("models.json must contain a providers object")?;
    let mut removed_provider = false;
    if providers.contains_key(provider_id.as_str()) {
        providers.remove(provider_id.as_str());
        write_private_json(&models_path, &config)?;
        removed_provider = true;
    }
    let removed_auth = remove_auth_entry(&agent_dir, &provider_id)?;
    if !removed_provider && !removed_auth {
        return Err(format!("Provider {provider_id} has no local configuration"));
    }
    Ok(())
}

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
pub async fn ask_temporary(
    state: State<'_, AgentManagerState>,
    app: tauri::AppHandle,
    agent_id: String,
    question: String,
    request_id: String,
) -> Result<String, String> {
    log::info!(
        "[cmd] ask_temporary parent={} len={} request={}",
        agent_id,
        question.len(),
        request_id
    );
    let emitter = move |payload: serde_json::Value| {
        if let Err(error) = app.emit("temporary-answer-chunk", &payload) {
            log::warn!("Failed to emit temporary answer chunk: {error}");
        }
    };
    state
        .0
        .temporary_ask(&agent_id, question, request_id, emitter)
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
pub async fn cancel_task(
    manager: State<'_, AgentManagerState>,
    registry: State<'_, TaskRegistryState>,
    task_id: String,
    reason: Option<String>,
) -> Result<crate::agent_api::AgentTask, String> {
    crate::agent_api::cancel_task_impl(manager.0.clone(), registry.0.clone(), &task_id, reason)
        .await
}

#[tauri::command]
pub async fn list_agent_tasks(state: State<'_, TaskRegistryState>) -> Result<TaskSnapshot, String> {
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
pub async fn revert_file_change(
    state: State<'_, AgentManagerState>,
    agent_id: String,
    path: String,
    patches: Vec<String>,
    created: Option<bool>,
) -> Result<(), String> {
    state
        .0
        .revert_file_change(&agent_id, path, patches, created)
        .await
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
