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
    created_at: String,
    depth: u64,
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
        let contents = match tokio::fs::read_to_string(&self.state_path).await {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Failed to read Studio state: {error}")),
        };
        let saved: Vec<PersistedAgent> = serde_json::from_str(&contents)
            .map_err(|error| format!("Failed to parse Studio state: {error}"))?;
        *self.records.write().await = saved
            .iter()
            .cloned()
            .map(|item| (item.id.clone(), item))
            .collect();

        let mut pending = saved;
        while !pending.is_empty() {
            let before = pending.len();
            let mut deferred = Vec::new();
            for record in pending {
                let parent_ready = match record.parent_agent_id.as_ref() {
                    Some(parent) => self.agents.read().await.contains_key(parent),
                    None => true,
                };
                if !parent_ready {
                    deferred.push(record);
                    continue;
                }
                if let Err(error) = self.spawn_record(record.clone(), false).await {
                    log::error!("Failed to restore agent {}: {}", record.id, error);
                }
            }
            if deferred.len() == before {
                for mut record in deferred.drain(..) {
                    log::warn!(
                        "Restoring {} without missing parent {:?}",
                        record.id,
                        record.parent_agent_id
                    );
                    record.parent_agent_id = None;
                    let _ = self.spawn_record(record, false).await;
                }
            }
            pending = deferred;
        }
        Ok(())
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

        let short_id = Uuid::new_v4().to_string()[..8].to_string();
        let record = PersistedAgent {
            id: format!("agent-{short_id}"),
            parent_agent_id: request.parent_agent_id,
            name: Some("Nova".to_string()),
            cwd: request.cwd,
            model: request.model,
            provider: request.provider,
            args: request.args.unwrap_or_default(),
            session_id: short_id,
            created_at: chrono::Utc::now().to_rfc3339(),
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
        let extra_args = record.args.clone();

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
        let state_path = self.state_path.clone();
        let aid = agent_id.clone();
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Some(name) = msg.get("name").and_then(|value| value.as_str()) {
                    if msg.get("type").and_then(|value| value.as_str()) == Some("agent_name_update")
                    {
                        if let Some(record) = records.write().await.get_mut(&aid) {
                            record.name = Some(name.to_string());
                        }
                        let _ = persist_records(&state_path, &records).await;
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
            self.persist().await?;
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

    /// Send a prompt to an agent
    pub async fn send_prompt(
        &self,
        agent_id: &str,
        message: String,
        images: Option<Vec<ImageContent>>,
    ) -> Result<(), String> {
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

    /// Stop and remove an agent
    pub async fn stop(&self, agent_id: &str) -> Result<(), String> {
        let mut agents = self.agents.write().await;
        let agent = agents.remove(agent_id).ok_or("Agent not found")?;
        agent.stop().await?;
        self.records.write().await.remove(agent_id);
        self.persist().await?;
        let _ = self.global_event_tx.send((
            agent_id.to_string(),
            serde_json::json!({
                "type": "agent_removed",
            }),
        ));
        Ok(())
    }

    /// List all agents
    pub async fn list(&self) -> Vec<AgentInfo> {
        let agents = self.agents.read().await;
        let mut infos = Vec::new();
        for (id, agent) in agents.iter() {
            let status = agent.get_status().await;
            let agent_name = agent.name.lock().await.clone();
            let msg_count = *agent.message_count.lock().await;
            let last_err = agent.last_error.lock().await.clone();
            infos.push(AgentInfo {
                id: id.clone(),
                parent_agent_id: agent.parent_agent_id.clone(),
                name: agent_name,
                status,
                cwd: agent.cwd.clone(),
                model: agent.model.clone(),
                session_id: Some(agent.session_id.clone()),
                created_at: agent.created_at.clone(),
                message_count: msg_count,
                last_error: last_err,
            });
        }
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
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        let status = agent.get_status().await;
        let cwd = agent.cwd.clone();
        let agent_name = agent.name.lock().await.clone();
        let msg_count = *agent.message_count.lock().await;
        let last_err = agent.last_error.lock().await.clone();
        Ok(AgentInfo {
            id: agent_id.to_string(),
            parent_agent_id: agent.parent_agent_id.clone(),
            name: agent_name,
            status,
            cwd,
            model: agent.model.clone(),
            session_id: Some(agent.session_id.clone()),
            created_at: agent.created_at.clone(),
            message_count: msg_count,
            last_error: last_err,
        })
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

    async fn persist(&self) -> Result<(), String> {
        persist_records(&self.state_path, &self.records).await
    }
}

async fn persist_records(
    path: &PathBuf,
    records: &Arc<RwLock<HashMap<String, PersistedAgent>>>,
) -> Result<(), String> {
    let mut values: Vec<_> = records.read().await.values().cloned().collect();
    values.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    let json = serde_json::to_string_pretty(&values)
        .map_err(|error| format!("Failed to serialize Studio state: {error}"))?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create Studio state directory: {error}"))?;
    }
    tokio::fs::write(path, json)
        .await
        .map_err(|error| format!("Failed to write Studio state: {error}"))
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

        let (removed_agent_id, removed_event) =
            recv_lifecycle_event(&mut lifecycle_rx, "agent_removed").await;
        assert_eq!(removed_agent_id, info.id);
        assert_eq!(
            removed_event.get("type").and_then(|value| value.as_str()),
            Some("agent_removed")
        );
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
        let manager = AgentManager::new(mock_cli_path(), state_path.clone());
        let parent = manager
            .spawn(SpawnRequest {
                cwd: "/tmp".to_string(),
                parent_agent_id: None,
                model: Some("test-model".to_string()),
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
        drop(manager);

        let restored = AgentManager::new(mock_cli_path(), state_path.clone());
        restored.restore().await.unwrap();
        let infos = restored.list().await;
        assert_eq!(infos.len(), 2);
        let restored_parent = infos.iter().find(|info| info.id == parent.id).unwrap();
        let restored_child = infos.iter().find(|info| info.id == child.id).unwrap();
        assert_eq!(restored_parent.cwd, "/tmp");
        assert_eq!(restored_parent.session_id, parent.session_id);
        assert_eq!(
            restored_child.parent_agent_id.as_deref(),
            Some(parent.id.as_str())
        );
        assert_eq!(restored_child.session_id, child.session_id);

        tokio::fs::remove_file(state_path).await.unwrap();
    }
}
