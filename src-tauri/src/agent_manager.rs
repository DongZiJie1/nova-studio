use crate::agent_process::AgentProcess;
use crate::rpc_types::{AgentInfo, ImageContent, RpcCommand, SpawnRequest};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

/// Central manager for all agent processes.
/// Shared between Tauri commands (UI-driven) and HTTP API (agent-driven).
pub struct AgentManager {
    agents: Arc<RwLock<HashMap<String, Arc<AgentProcess>>>>,
    /// Global event bus: receives events from ALL agents, tagged with agent_id
    global_event_tx: broadcast::Sender<(String, serde_json::Value)>,
    cli_path: String,
    /// Token agents must present to call the hub HTTP API (x-nova-token).
    pub hub_token: String,
    /// Base URL of the hub API, set once the HTTP server has bound its port.
    hub_url: RwLock<String>,
    state_path: PathBuf,
    records: Arc<RwLock<HashMap<String, PersistedAgent>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedAgent {
    id: String,
    parent_agent_id: Option<String>,
    name: Option<String>,
    cwd: String,
    model: Option<String>,
    provider: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    session_id: String,
    #[serde(default)]
    session_file: Option<String>,
    created_at: String,
    #[serde(default)]
    message_count: usize,
    depth: u64,
}

#[derive(Debug, Deserialize)]
struct NovaSessionCatalog {
    sessions: Vec<NovaSessionSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NovaSessionSummary {
    session_id: String,
    cwd: String,
    session_file: String,
    name: Option<String>,
    parent_session_id: Option<String>,
    created_at: String,
    message_count: usize,
}

impl AgentManager {
    pub fn new(cli_path: String, state_path: PathBuf) -> Self {
        let (global_event_tx, _) = broadcast::channel(512);
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            global_event_tx,
            cli_path,
            hub_token: Uuid::new_v4().to_string(),
            hub_url: RwLock::new("http://127.0.0.1:9528".to_string()),
            state_path,
            records: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn restore(&self) -> Result<(), String> {
        let legacy: Vec<PersistedAgent> = match tokio::fs::read_to_string(&self.state_path).await {
            Ok(contents) => match serde_json::from_str(&contents) {
                Ok(records) => records,
                Err(error) => {
                    log::warn!(
                        "Ignoring malformed legacy Studio state at {}: {}",
                        self.state_path.display(),
                        error
                    );
                    Vec::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                log::warn!(
                    "Unable to read legacy Studio state at {}: {}",
                    self.state_path.display(),
                    error
                );
                Vec::new()
            }
        };
        let legacy_by_session: HashMap<_, _> = legacy
            .iter()
            .cloned()
            .map(|record| (record.session_id.clone(), record))
            .collect();
        let records = match self.load_nova_sessions().await {
            Ok(catalog) => catalog
                .sessions
                .into_iter()
                .map(|session| {
                    let legacy = legacy_by_session.get(&session.session_id);
                    let cwd = normalize_project_cwd(&session.cwd).unwrap_or(session.cwd);
                    let id = format!("agent-{}", session.session_id);
                    (
                        id.clone(),
                        PersistedAgent {
                            id,
                            parent_agent_id: session
                                .parent_session_id
                                .map(|parent| format!("agent-{parent}")),
                            name: session
                                .name
                                .or_else(|| legacy.and_then(|item| item.name.clone())),
                            cwd,
                            model: legacy.and_then(|item| item.model.clone()),
                            provider: legacy.and_then(|item| item.provider.clone()),
                            args: Vec::new(),
                            session_id: session.session_id,
                            session_file: Some(session.session_file),
                            created_at: session.created_at,
                            message_count: session.message_count,
                            depth: legacy.map_or(0, |item| item.depth),
                        },
                    )
                })
                .collect(),
            Err(error) if !legacy.is_empty() => {
                log::warn!(
                    "Nova session catalog unavailable; restoring legacy Studio records temporarily: {}",
                    error
                );
                legacy
                    .into_iter()
                    .map(|record| (record.id.clone(), record))
                    .collect()
            }
            Err(error) => return Err(error),
        };
        *self.records.write().await = records;
        Ok(())
    }

    async fn load_nova_sessions(&self) -> Result<NovaSessionCatalog, String> {
        let is_js_file = self.cli_path.ends_with(".js");
        let mut command = if is_js_file {
            let mut command = tokio::process::Command::new("node");
            command.arg(&self.cli_path);
            command
        } else {
            tokio::process::Command::new(&self.cli_path)
        };
        let output = command
            .arg("--list-sessions")
            .arg("--offline")
            .output()
            .await
            .map_err(|error| format!("Failed to query Nova sessions: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Nova session query failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Nova returned invalid session catalog: {error}"))
    }

    /// Called once the hub HTTP server has bound its actual port.
    pub async fn set_hub_url(&self, url: String) {
        *self.hub_url.write().await = url;
    }

    /// Get the process handle for an agent (used by the hub API to take
    /// the per-agent prompt lock).
    pub async fn get_process(&self, agent_id: &str) -> Option<Arc<AgentProcess>> {
        self.agents.read().await.get(agent_id).cloned()
    }

    /// Spawn a new agent process
    pub async fn spawn(&self, request: SpawnRequest) -> Result<AgentInfo, String> {
        if let Some(parent_id) = request.parent_agent_id.as_deref() {
            if !self.agents.read().await.contains_key(parent_id) {
                return Err(format!("Parent agent not found: {}", parent_id));
            }
        }

        let cwd = normalize_project_cwd(&request.cwd)?;
        let short_id = Uuid::new_v4().to_string()[..8].to_string();
        let mut args = request.args.unwrap_or_default();
        if let Some(parent_id) = request.parent_agent_id.as_ref() {
            let mut parent_file = self
                .records
                .read()
                .await
                .get(parent_id)
                .and_then(|record| record.session_file.clone());
            if parent_file.is_none() {
                let parent_session_id = parent_id.strip_prefix("agent-").unwrap_or(parent_id);
                parent_file = self
                    .load_nova_sessions()
                    .await?
                    .sessions
                    .into_iter()
                    .find(|session| session.session_id == parent_session_id)
                    .map(|session| session.session_file);
            }
            if let Some(parent_file) = parent_file {
                args.push("--parent-session".to_string());
                args.push(parent_file);
            }
        }
        let record = PersistedAgent {
            id: format!("agent-{short_id}"),
            parent_agent_id: request.parent_agent_id,
            name: Some("Nova".to_string()),
            cwd,
            model: request.model,
            provider: request.provider,
            args,
            session_id: short_id,
            session_file: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            message_count: 0,
            depth: request.depth,
        };
        self.spawn_record(record, true).await
    }

    async fn spawn_record(
        &self,
        record: PersistedAgent,
        persist: bool,
    ) -> Result<AgentInfo, String> {
        let agent_id = record.id.clone();
        let mut extra_args = record.args.clone();
        // Restored sessions may live in a configured or project-specific
        // directory that differs from the current Nova defaults. Opening the
        // exact file prevents `--session-id` from silently creating a second
        // session with the same id in another directory.
        if let Some(session_file) = record.session_file.as_ref() {
            if !extra_args.iter().any(|arg| arg == "--session") {
                extra_args.push("--session".to_string());
                extra_args.push(session_file.clone());
            }
        }

        let hub_url = self.hub_url.read().await.clone();
        let process = AgentProcess::spawn(
            agent_id.clone(),
            record.parent_agent_id.clone(),
            record.cwd.clone(),
            self.cli_path.clone(),
            record.model.clone(),
            record.provider.clone(),
            extra_args,
            hub_url,
            self.hub_token.clone(),
            record.depth,
            record.session_id.clone(),
            record.name.clone(),
            Some(record.created_at.clone()),
        )
        .await?;

        let info = self.build_info(&agent_id, &record.cwd, &process).await;

        // Forward events from this agent to the global event bus
        let mut rx = process.subscribe();
        let global_tx = self.global_event_tx.clone();
        let records = self.records.clone();
        let aid = agent_id.clone();
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Some(name) = msg.get("name").and_then(|value| value.as_str()) {
                    if msg.get("type").and_then(|value| value.as_str()) == Some("agent_name_update")
                    {
                        if let Some(record) = records.write().await.get_mut(&aid) {
                            record.name = Some(name.to_string());
                        }
                    }
                }
                let _ = global_tx.send((aid.clone(), msg));
            }
        });

        self.agents
            .write()
            .await
            .insert(agent_id.clone(), Arc::new(process));
        if persist {
            self.records.write().await.insert(agent_id.clone(), record);
        }

        if let Some(agent) = self.get_process(&agent_id).await {
            let _ = agent.send_command(&RpcCommand::GetMessages { id: None });
        }

        // Notify the frontend even when the agent was created through the
        // HTTP hub API rather than a Tauri invoke from the UI.
        let _ = self.global_event_tx.send((
            agent_id,
            serde_json::json!({
                "type": "agent_created",
                "info": info.clone(),
            }),
        ));

        Ok(info)
    }

    pub async fn activate(&self, agent_id: &str) -> Result<AgentInfo, String> {
        if self.get_process(agent_id).await.is_some() {
            return self.get_info(agent_id).await;
        }
        let record = self
            .records
            .read()
            .await
            .get(agent_id)
            .cloned()
            .ok_or("Agent session not found")?;
        self.spawn_record(record, false).await
    }

    /// Send a prompt to an agent
    pub async fn send_prompt(
        &self,
        agent_id: &str,
        message: String,
        images: Option<Vec<ImageContent>>,
    ) -> Result<(), String> {
        if self.get_process(agent_id).await.is_none() {
            self.activate(agent_id).await?;
        }
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;

        if !agent.is_alive().await {
            return Err("Agent process is not running".to_string());
        }

        let cmd = RpcCommand::Prompt {
            id: None,
            message,
            images,
        };
        agent.send_command(&cmd)
    }

    /// Send an abort command to an agent
    pub async fn abort(&self, agent_id: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        let cmd = RpcCommand::Abort { id: None };
        agent.send_command(&cmd)
    }

    /// Ask an agent a question and wait for its full reply.
    ///
    /// Unlike send_prompt (fire-and-forget), this subscribes to the agent's
    /// event stream first, sends the prompt, then collects text until the
    /// agent settles. The per-agent prompt lock is held for the whole
    /// exchange so concurrent hub callers queue up instead of interleaving.
    pub async fn ask(
        &self,
        agent_id: &str,
        question: String,
        timeout_secs: u64,
    ) -> Result<String, String> {
        let agent = self.get_process(agent_id).await.ok_or("Agent not found")?;
        if !agent.is_alive().await {
            return Err("Agent process is not running".to_string());
        }

        let _guard = agent.prompt_lock.lock().await;

        // Subscribe BEFORE sending so no reply event is missed.
        let mut rx = agent.subscribe();
        agent.send_command(&RpcCommand::Prompt {
            id: None,
            message: question,
            images: None,
        })?;

        let mut reply = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("ask timed out after {}s", timeout_secs));
            }
            let event = match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(ev)) => ev,
                Ok(Err(_)) => return Err("agent event stream closed".to_string()),
                Err(_) => return Err(format!("ask timed out after {}s", timeout_secs)),
            };
            match event.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "message_end" => {
                    if let Some(m) = event.get("message") {
                        let text = extract_text_from_message(m);
                        if !text.is_empty() {
                            reply = text;
                        }
                    }
                }
                "response" => {
                    if event.get("success").and_then(|v| v.as_bool()) == Some(false) {
                        let err = event
                            .pointer("/data/error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown error");
                        return Err(format!("agent error: {}", err));
                    }
                }
                "agent_settled" => {
                    return if reply.is_empty() {
                        Err("agent settled without a text reply".to_string())
                    } else {
                        Ok(reply)
                    };
                }
                _ => {}
            }
        }
    }

    /// Send an extension UI response (from a frontend dialog) to an agent
    pub async fn send_extension_ui_response(
        &self,
        agent_id: &str,
        id: String,
        value: Option<String>,
        confirmed: Option<bool>,
        cancelled: Option<bool>,
    ) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        if !agent.is_alive().await {
            return Err("Agent process is not running".to_string());
        }
        let cmd = RpcCommand::ExtensionUIResponse {
            id,
            value,
            confirmed,
            cancelled,
        };
        agent.send_command(&cmd)
    }

    /// Stop an agent process while retaining its persisted session record.
    pub async fn stop(&self, agent_id: &str) -> Result<(), String> {
        let mut agents = self.agents.write().await;
        let agent = agents.remove(agent_id).ok_or("Agent not found")?;
        agent.stop().await?;
        Ok(())
    }

    /// List all agents
    pub async fn list(&self) -> Vec<AgentInfo> {
        let records = self.records.read().await;
        let agents = self.agents.read().await;
        let mut infos = Vec::new();
        for (id, record) in records.iter() {
            if let Some(agent) = agents.get(id) {
                infos.push(self.build_info(id, &record.cwd, agent).await);
            } else {
                infos.push(agent_info_from_record(record));
            }
        }
        infos.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        infos
    }

    pub async fn request_all_messages(&self) {
        let agents = self.agents.read().await;
        for agent in agents.values() {
            let _ = agent.send_command(&RpcCommand::GetMessages { id: None });
        }
    }

    /// Get info about a specific agent
    pub async fn get_info(&self, agent_id: &str) -> Result<AgentInfo, String> {
        if let Some(agent) = self.agents.read().await.get(agent_id).cloned() {
            return Ok(self.build_info(agent_id, &agent.cwd, &agent).await);
        }
        self.records
            .read()
            .await
            .get(agent_id)
            .map(agent_info_from_record)
            .ok_or_else(|| "Agent session not found".to_string())
    }

    /// Subscribe to global events (all agents)
    pub fn subscribe_global(&self) -> broadcast::Receiver<(String, serde_json::Value)> {
        self.global_event_tx.subscribe()
    }

    /// Get the number of running agents
    pub async fn count(&self) -> usize {
        self.agents.read().await.len()
    }

    async fn build_info(&self, id: &str, cwd: &str, process: &AgentProcess) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            parent_agent_id: process.parent_agent_id.clone(),
            name: process.name.lock().await.clone(),
            status: process.get_status().await,
            cwd: cwd.to_string(),
            model: process.model.clone(),
            session_id: Some(process.session_id.clone()),
            created_at: process.created_at.clone(),
            message_count: 0,
            last_error: None,
        }
    }
}

fn agent_info_from_record(record: &PersistedAgent) -> AgentInfo {
    AgentInfo {
        id: record.id.clone(),
        parent_agent_id: record.parent_agent_id.clone(),
        name: record.name.clone(),
        status: crate::rpc_types::AgentStatus::Stopped,
        cwd: record.cwd.clone(),
        model: record.model.clone(),
        session_id: Some(record.session_id.clone()),
        created_at: record.created_at.clone(),
        message_count: record.message_count,
        last_error: None,
    }
}

fn normalize_project_cwd(cwd: &str) -> Result<String, String> {
    let expanded = if cwd == "~" {
        PathBuf::from(
            std::env::var("HOME").map_err(|_| "HOME is not set; cannot expand '~'".to_string())?,
        )
    } else if let Some(relative) = cwd.strip_prefix("~/") {
        PathBuf::from(
            std::env::var("HOME").map_err(|_| "HOME is not set; cannot expand '~'".to_string())?,
        )
        .join(relative)
    } else {
        PathBuf::from(cwd)
    };
    if !expanded.is_absolute() {
        return Err(format!(
            "Project directory '{cwd}' must be an absolute path or start with '~/'"
        ));
    }
    let absolute = expanded;
    let canonical = std::fs::canonicalize(&absolute).map_err(|error| {
        format!(
            "Project directory '{}' is not accessible: {error}",
            absolute.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Project path '{}' is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// Extract assistant text from a `message_end` message payload.
/// `content` may be a plain string or an array of content parts.
fn extract_text_from_message(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc_types::AgentStatus;

    fn mock_cli_path() -> String {
        format!("{}/test-fixtures/mock-cli.sh", env!("CARGO_MANIFEST_DIR"))
    }

    async fn recv_lifecycle_event(
        rx: &mut broadcast::Receiver<(String, serde_json::Value)>,
        event_type: &str,
    ) -> (String, serde_json::Value) {
        loop {
            let event = rx.recv().await.unwrap();
            if event.1.get("type").and_then(|value| value.as_str()) == Some(event_type) {
                return event;
            }
        }
    }

    #[test]
    fn extract_text_handles_string_and_parts_content() {
        let s = serde_json::json!({"role": "assistant", "content": "plain"});
        assert_eq!(extract_text_from_message(&s), "plain");

        let parts = serde_json::json!({
            "role": "assistant",
            "content": [
                {"type": "text", "text": "hello "},
                {"type": "tool_call", "id": "x"},
                {"type": "text", "text": "world"}
            ]
        });
        assert_eq!(extract_text_from_message(&parts), "hello world");

        let empty = serde_json::json!({"role": "assistant"});
        assert_eq!(extract_text_from_message(&empty), "");
    }

    #[test]
    fn project_paths_are_normalized_to_one_real_directory() {
        let direct = normalize_project_cwd("/tmp").unwrap();
        let equivalent = normalize_project_cwd("/tmp/../tmp/").unwrap();
        assert_eq!(direct, equivalent);
        assert!(std::path::Path::new(&direct).is_absolute());
        assert!(normalize_project_cwd("relative/project").is_err());
    }

    #[tokio::test]
    async fn spawn_injects_hub_env_and_ask_waits_for_reply() {
        let manager = AgentManager::new(
            mock_cli_path(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", Uuid::new_v4())),
        );
        let mut lifecycle_rx = manager.subscribe_global();
        manager
            .set_hub_url("http://127.0.0.1:9999".to_string())
            .await;

        let info = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: Some("test-model".to_string()),
                provider: None,
                args: None,
                depth: 2,
            })
            .await
            .expect("spawn failed");

        assert!(info.id.starts_with("agent-"));
        assert_eq!(info.model.as_deref(), Some("test-model"));
        assert!(!info.created_at.is_empty());

        let (created_agent_id, created_event) =
            recv_lifecycle_event(&mut lifecycle_rx, "agent_created").await;
        assert_eq!(created_agent_id, info.id);
        assert_eq!(
            created_event.get("type").and_then(|value| value.as_str()),
            Some("agent_created")
        );
        assert_eq!(
            created_event
                .pointer("/info/id")
                .and_then(|value| value.as_str()),
            Some(info.id.as_str())
        );

        let reply = manager
            .ask(&info.id, "hello".to_string(), 15)
            .await
            .expect("ask failed");

        // The mock CLI echoes its hub env vars in the reply text.
        assert!(
            reply.contains("url=http://127.0.0.1:9999"),
            "reply: {reply}"
        );
        assert!(reply.contains(&format!("id={}", info.id)), "reply: {reply}");
        assert!(
            reply.contains(&format!("token={}", manager.hub_token)),
            "reply: {reply}"
        );
        // depth passed through SpawnRequest reaches the child env.
        assert!(reply.contains("depth=2"), "reply: {reply}");

        // model is reported truthfully in list()/get_info() too
        let listed = manager.list().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].model.as_deref(), Some("test-model"));
        let got = manager.get_info(&info.id).await.unwrap();
        assert_eq!(got.created_at, info.created_at);

        manager.stop(&info.id).await.unwrap();
        assert_eq!(manager.count().await, 0);
        let stopped = manager.get_info(&info.id).await.unwrap();
        assert_eq!(stopped.status, AgentStatus::Stopped);
        assert_eq!(manager.list().await.len(), 1);
    }

    #[tokio::test]
    async fn ask_unknown_agent_errors() {
        let manager = AgentManager::new(
            mock_cli_path(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", Uuid::new_v4())),
        );
        let err = manager
            .ask("agent-nope", "hi".to_string(), 5)
            .await
            .unwrap_err();
        assert_eq!(err, "Agent not found");
    }

    #[tokio::test]
    async fn spawn_records_parent_child_relationship() {
        let manager = AgentManager::new(
            mock_cli_path(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", Uuid::new_v4())),
        );
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

        assert_eq!(child.parent_agent_id.as_deref(), Some(parent.id.as_str()));
        let listed_child = manager.get_info(&child.id).await.unwrap();
        assert_eq!(
            listed_child.parent_agent_id.as_deref(),
            Some(parent.id.as_str())
        );

        manager.stop(&child.id).await.unwrap();
        manager.stop(&parent.id).await.unwrap();
    }

    #[tokio::test]
    async fn spawn_rejects_unknown_parent() {
        let manager = AgentManager::new(
            mock_cli_path(),
            std::env::temp_dir().join(format!("nova-studio-{}.json", Uuid::new_v4())),
        );
        let err = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: Some("agent-missing".to_string()),
                model: None,
                provider: None,
                args: None,
                depth: 1,
            })
            .await
            .unwrap_err();

        assert_eq!(err, "Parent agent not found: agent-missing");
    }

    #[tokio::test]
    async fn restore_preserves_project_session_and_parent_relationship() {
        let state_path =
            std::env::temp_dir().join(format!("nova-studio-restore-{}.json", Uuid::new_v4()));
        let restored = AgentManager::new(mock_cli_path(), state_path.clone());
        restored.restore().await.unwrap();
        let infos = restored.list().await;
        assert_eq!(infos.len(), 2);
        let restored_parent = infos
            .iter()
            .find(|info| info.id == "agent-mock-parent")
            .unwrap();
        let restored_child = infos
            .iter()
            .find(|info| info.id == "agent-mock-child")
            .unwrap();
        assert_eq!(restored_parent.cwd, normalize_project_cwd("/tmp").unwrap());
        assert_eq!(restored_parent.session_id.as_deref(), Some("mock-parent"));
        assert_eq!(restored_parent.status, AgentStatus::Stopped);
        assert_eq!(restored_parent.message_count, 2);
        assert_eq!(
            restored_child.parent_agent_id.as_deref(),
            Some("agent-mock-parent")
        );
        assert_eq!(restored_child.session_id.as_deref(), Some("mock-child"));
        assert_eq!(restored.count().await, 0);

        let activated = restored.activate("agent-mock-parent").await.unwrap();
        assert_eq!(activated.status, AgentStatus::Idle);
        assert_eq!(restored.count().await, 1);

        let _ = tokio::fs::remove_file(state_path).await;
    }
}
