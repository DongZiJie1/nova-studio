use crate::agent_process::AgentProcess;
use crate::nova_host_process::NovaHostProcess;
use crate::rpc_types::{AgentInfo, FileReference, ImageContent, RpcCommand, SpawnRequest};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};
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
    host: Mutex<Option<Arc<NovaHostProcess>>>,
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
    created_at: String,
    message_count: usize,
    #[serde(default)]
    first_message: String,
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
            host: Mutex::new(None),
        }
    }

    async fn ensure_host(&self, cwd: &str) -> Result<Arc<NovaHostProcess>, String> {
        let mut host = self.host.lock().await;
        if let Some(existing) = host.as_ref() {
            if existing.is_alive().await {
                return Ok(existing.clone());
            }
        }
        let created = Arc::new(
            NovaHostProcess::spawn(
                self.cli_path.clone(),
                cwd.to_string(),
                self.hub_url.read().await.clone(),
                self.hub_token.clone(),
            )
            .await?,
        );
        *host = Some(created.clone());
        Ok(created)
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
                    let name = session
                        .name
                        .or_else(|| legacy.and_then(|item| item.name.clone()))
                        .or_else(|| fallback_session_name(&session.first_message));
                    (
                        id.clone(),
                        PersistedAgent {
                            id,
                            // A Nova parentSession records conversation lineage (fork/clone),
                            // not an Agent collaboration hierarchy. Only Studio's persisted
                            // parent_agent_id is authoritative for nested Agent rendering.
                            parent_agent_id: legacy.and_then(|item| item.parent_agent_id.clone()),
                            name,
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

    /// Merge Nova's current session catalog into the in-memory Studio view.
    ///
    /// Nova is the source of truth and may create sessions outside this Studio
    /// process, so a one-time snapshot taken during startup is not sufficient.
    pub async fn refresh_sessions(&self) -> Result<(), String> {
        let catalog = self.load_nova_sessions().await?;
        let catalog_ids: HashSet<String> = catalog
            .sessions
            .iter()
            .map(|session| format!("agent-{}", session.session_id))
            .collect();
        let running_ids: HashSet<String> = self.agents.read().await.keys().cloned().collect();
        let mut records = self.records.write().await;
        for session in catalog.sessions {
            let id = format!("agent-{}", session.session_id);
            let cwd = normalize_project_cwd(&session.cwd).unwrap_or(session.cwd);
            let fallback_name = fallback_session_name(&session.first_message);

            if let Some(record) = records.get_mut(&id) {
                if session.name.is_some() {
                    record.name = session.name;
                } else if record.name.is_none() {
                    record.name = fallback_name;
                }
                record.cwd = cwd;
                record.session_file = Some(session.session_file);
                record.created_at = session.created_at;
                record.message_count = session.message_count;
            } else {
                records.insert(
                    id.clone(),
                    PersistedAgent {
                        id,
                        // Newly discovered sessions may be forks, clones, or sessions
                        // created outside Studio. Session lineage must remain flat here.
                        parent_agent_id: None,
                        name: session.name.or(fallback_name),
                        cwd,
                        model: None,
                        provider: None,
                        args: Vec::new(),
                        session_id: session.session_id,
                        session_file: Some(session.session_file),
                        created_at: session.created_at,
                        message_count: session.message_count,
                        depth: 0,
                    },
                );
            }
        }
        // Nova's catalog is the source of truth. Drop records whose session
        // files were deleted outside Studio, while retaining live agents until
        // they stop so a refresh cannot make an active conversation disappear.
        records.retain(|id, _| catalog_ids.contains(id) || running_ids.contains(id));
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

        let host = self.ensure_host(&record.cwd).await?;
        let process = AgentProcess::attach(
            agent_id.clone(),
            record.parent_agent_id.clone(),
            record.cwd.clone(),
            record.model.clone(),
            record.session_id.clone(),
            record.depth,
            record.name.clone(),
            Some(record.created_at.clone()),
            host.clone(),
        )
        .await?;

        let session_path = extra_args
            .windows(2)
            .find(|pair| pair[0] == "--session")
            .map(|pair| pair[1].clone());
        let mut ready_events = process.subscribe();
        host.send_host_command(serde_json::json!({
            "type": "agent_create",
            "agentId": agent_id,
            "cwd": record.cwd,
            "sessionId": record.session_id,
            "sessionPath": session_path,
            "parentSession": extra_args
                .windows(2)
                .find(|pair| pair[0] == "--parent-session")
                .map(|pair| pair[1].clone()),
            "depth": record.depth,
        }))?;
        let ready = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let event = ready_events
                    .recv()
                    .await
                    .map_err(|_| "Nova host event stream closed".to_string())?;
                if event.get("type").and_then(serde_json::Value::as_str) != Some("response")
                    || event.get("command").and_then(serde_json::Value::as_str)
                        != Some("agent_create")
                {
                    continue;
                }
                if event.get("success").and_then(serde_json::Value::as_bool) == Some(true) {
                    return Ok(());
                }
                return Err(event
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Nova host failed to create agent")
                    .to_string());
            }
        })
        .await
        .map_err(|_| "Timed out waiting for Nova host to create agent".to_string())?;
        ready?;

        if let (Some(provider), Some(model_id)) = (record.provider.as_ref(), record.model.as_ref())
        {
            process.send_command(&RpcCommand::SetModel {
                id: None,
                provider: provider.clone(),
                model_id: model_id.clone(),
            })?;
        }

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
            let _ = agent.send_command(&RpcCommand::GetState { id: None });
            let _ = agent.send_command(&RpcCommand::GetSessionStats { id: None });
            let _ = agent.send_command(&RpcCommand::GetAvailableModels { id: None });
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
        if let Some(agent) = self.get_process(agent_id).await {
            // The frontend can be reloaded while the process remains alive.
            // Always replay history when the user selects an existing process.
            agent.send_command(&RpcCommand::GetMessages { id: None })?;
            let _ = agent.send_command(&RpcCommand::GetState { id: None });
            let _ = agent.send_command(&RpcCommand::GetSessionStats { id: None });
            let _ = agent.send_command(&RpcCommand::GetAvailableModels { id: None });
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
        file_references: Option<Vec<FileReference>>,
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
            file_references,
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

    /// Request session stats (context usage, token counts) from an agent
    pub async fn request_session_stats(&self, agent_id: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::GetSessionStats { id: None })
    }

    /// Request available models from an agent
    pub async fn request_available_models(&self, agent_id: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::GetAvailableModels { id: None })
    }

    /// Start a fresh session in an existing Studio agent process.
    pub async fn new_session(&self, agent_id: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::NewSession { id: None })?;
        agent.send_command(&RpcCommand::GetMessages { id: None })?;
        agent.send_command(&RpcCommand::GetState { id: None })
    }

    pub async fn request_messages(&self, agent_id: &str) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::GetMessages { id: None })
    }

    pub async fn fork_session(&self, agent_id: &str, entry_id: String) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::Fork { id: None, entry_id, position: "at".to_string() })
    }

    pub async fn set_feedback(&self, agent_id: &str, entry_id: String, rating: Option<String>) -> Result<(), String> {
        if !matches!(rating.as_deref(), None | Some("up") | Some("down")) {
            return Err("Invalid feedback rating".to_string());
        }
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::SetFeedback { id: None, entry_id, rating })
    }

    /// Compact the current session, optionally using caller-provided instructions.
    pub async fn compact(
        &self,
        agent_id: &str,
        instructions: Option<String>,
    ) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::Compact {
            id: None,
            custom_instructions: instructions,
        })
    }

    /// Set the display name stored in Nova's session metadata.
    pub async fn set_session_name(&self, agent_id: &str, name: String) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::SetSessionName { id: None, name })
    }

    /// Switch model for an agent
    pub async fn set_model(&self, agent_id: &str, provider: String, model_id: String) -> Result<(), String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        agent.send_command(&RpcCommand::SetModel { id: None, provider, model_id })
    }

    /// List all available models from nova CLI
    pub async fn list_all_models(&self) -> Result<Vec<serde_json::Value>, String> {
        let is_js_file = self.cli_path.ends_with(".js");
        let mut command = if is_js_file {
            let mut command = tokio::process::Command::new("node");
            command.arg(&self.cli_path);
            command
        } else {
            tokio::process::Command::new(&self.cli_path)
        };
        let output = command
            .arg("--list-models")
            .output()
            .await
            .map_err(|error| format!("Failed to list models: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Nova list-models failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = stdout.lines().collect();
        // Skip header line, parse remaining lines
        let mut models = Vec::new();
        for line in lines.iter().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let provider = parts[0];
                let model_id = parts[1];
                let context_window = parts[2];
                let max_tokens = parts[3];
                let thinking = parts.get(4).map(|s| *s == "yes").unwrap_or(false);
                let images = parts.get(5).map(|s| *s == "yes").unwrap_or(false);
                // Parse context window (e.g., "1M" -> 1000000, "200K" -> 200000)
                let context_window_num = if context_window.ends_with('M') {
                    context_window.trim_end_matches('M').parse::<f64>().unwrap_or(0.0) * 1_000_000.0
                } else if context_window.ends_with('K') {
                    context_window.trim_end_matches('K').parse::<f64>().unwrap_or(0.0) * 1_000.0
                } else {
                    context_window.parse::<f64>().unwrap_or(0.0)
                };
                // Parse max tokens
                let max_tokens_num = if max_tokens.ends_with('K') {
                    max_tokens.trim_end_matches('K').parse::<f64>().unwrap_or(0.0) * 1_000.0
                } else {
                    max_tokens.parse::<f64>().unwrap_or(0.0)
                };
                models.push(serde_json::json!({
                    "id": model_id,
                    "name": model_id,
                    "provider": provider,
                    "contextWindow": context_window_num as i64,
                    "maxTokens": max_tokens_num as i64,
                    "reasoning": thinking,
                    "images": images,
                }));
            }
        }
        Ok(models)
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
            file_references: None,
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

fn fallback_session_name(first_message: &str) -> Option<String> {
    let first_line = first_message.lines().next()?.trim();
    let first_clause = first_line
        .split(['。', '！', '？', '，', '.', '!', '?', ','])
        .next()
        .unwrap_or(first_line)
        .trim();
    let name = first_clause.chars().take(12).collect::<String>();
    (!name.is_empty()).then_some(name)
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

    #[test]
    fn unnamed_legacy_sessions_get_a_short_stable_fallback_name() {
        assert_eq!(
            fallback_session_name("帮我检查最近消失的会话，顺便修复加载问题。"),
            Some("帮我检查最近消失的会话".to_string())
        );
        assert_eq!(fallback_session_name("  \nnext"), None);
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
    async fn restore_keeps_session_lineage_flat_without_agent_metadata() {
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
        assert_eq!(restored_child.parent_agent_id, None);
        assert_eq!(restored_child.session_id.as_deref(), Some("mock-child"));
        assert_eq!(restored.count().await, 0);

        let mut events = restored.subscribe_global();
        let activated = restored.activate("agent-mock-parent").await.unwrap();
        assert_eq!(activated.status, AgentStatus::Idle);
        assert_eq!(restored.count().await, 1);
        let (_, history) = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            recv_lifecycle_event(&mut events, "response"),
        )
        .await
        .expect("restored session did not replay its history");
        assert_eq!(
            history.get("command").and_then(|value| value.as_str()),
            Some("get_messages")
        );
        assert_eq!(
            history
                .pointer("/data/messages")
                .and_then(|value| value.as_array())
                .map(Vec::len),
            Some(2)
        );

        let _ = tokio::fs::remove_file(state_path).await;
    }
}
