use crate::nova_host_process::NovaHostProcess;
use crate::rpc_types::{AgentLifecycleSnapshot, AgentMessage, AgentStatus, RpcCommand};
use serde_json;
use std::process::Stdio;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};

/// A single agent process running `node cli.js --mode rpc`
pub struct AgentProcess {
    pub id: String,
    pub parent_agent_id: Option<String>,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: String,
    pub depth: u64,
    pub created_at: String,
    /// Display name: starts as "Nova", replaced by LLM-generated name on first prompt.
    pub name: Arc<Mutex<Option<String>>>,
    pub status: Arc<Mutex<AgentStatus>>,
    pub message_count: Arc<Mutex<usize>>,
    pub last_error: Arc<Mutex<Option<String>>>,
    /// Serializes prompt/ask interactions coming from the hub API so
    /// concurrent collaborators can't interleave messages in one session.
    pub prompt_lock: Arc<Mutex<()>>,
    child: Option<Arc<Mutex<Child>>>,
    host: Option<Arc<NovaHostProcess>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    event_tx: broadcast::Sender<serde_json::Value>,
    _stdout_task: tokio::task::JoinHandle<()>,
    _stderr_task: tokio::task::JoinHandle<()>,
    _stdin_task: tokio::task::JoinHandle<()>,
}

impl AgentProcess {
    /// Attach a logical agent to a shared Nova host process.
    pub async fn attach(
        id: String,
        parent_agent_id: Option<String>,
        cwd: String,
        model: Option<String>,
        session_id: String,
        depth: u64,
        restored_name: Option<String>,
        restored_created_at: Option<String>,
        host: Arc<NovaHostProcess>,
    ) -> Result<Self, String> {
        let event_tx = host.register_agent(&id).await;
        let status = Arc::new(Mutex::new(AgentStatus::Starting));
        let message_count = Arc::new(Mutex::new(0usize));
        let last_error = Arc::new(Mutex::new(None));
        let name = Arc::new(Mutex::new(
            restored_name.or_else(|| Some("Nova".to_string())),
        ));
        let mut events = event_tx.subscribe();
        let status_events = status.clone();
        let count_events = message_count.clone();
        let error_events = last_error.clone();
        let name_events = name.clone();
        let stdout_task = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                match event.get("type").and_then(serde_json::Value::as_str) {
                    Some("agent_settled") => *status_events.lock().await = AgentStatus::Idle,
                    Some("message_start") => *status_events.lock().await = AgentStatus::Streaming,
                    Some("message_end") => *count_events.lock().await += 1,
                    Some("agent_name_update") => {
                        if let Some(value) = event.get("name").and_then(serde_json::Value::as_str) {
                            *name_events.lock().await = Some(value.to_string());
                        }
                    }
                    Some("response")
                        if event.get("success").and_then(serde_json::Value::as_bool)
                            == Some(false) =>
                    {
                        *status_events.lock().await = AgentStatus::Error;
                        *error_events.lock().await = event
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string);
                    }
                    _ => {}
                }
            }
            *status_events.lock().await = AgentStatus::Stopped;
        });
        *status.lock().await = AgentStatus::Idle;
        let (stdin_tx, _) = tokio::sync::mpsc::unbounded_channel();
        Ok(Self {
            id,
            parent_agent_id,
            cwd,
            model,
            session_id,
            depth,
            created_at: restored_created_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            name,
            status,
            message_count,
            last_error,
            prompt_lock: Arc::new(Mutex::new(())),
            child: None,
            host: Some(host),
            stdin_tx,
            event_tx,
            _stdout_task: stdout_task,
            _stderr_task: tokio::spawn(async {}),
            _stdin_task: tokio::spawn(async {}),
        })
    }

    /// Spawn a new agent process
    pub async fn spawn(
        id: String,
        parent_agent_id: Option<String>,
        cwd: String,
        cli_path: String,
        model: Option<String>,
        provider: Option<String>,
        extra_args: Vec<String>,
        hub_url: String,
        hub_token: String,
        depth: u64,
        session_id: String,
        restored_name: Option<String>,
        restored_created_at: Option<String>,
    ) -> Result<Self, String> {
        // Determine how to invoke the CLI:
        // - .js file → node <file> --mode rpc
        // - command name (e.g. "nova") → nova --mode rpc
        let is_js_file = cli_path.ends_with(".js");
        let (program, mut args) = if is_js_file {
            ("node".to_string(), vec![cli_path.clone()])
        } else {
            (cli_path.clone(), vec![])
        };
        args.push("--mode".to_string());
        args.push("rpc".to_string());
        // `--session` already identifies the exact persisted conversation and
        // Nova rejects combining it with `--session-id`.
        let restores_exact_session = extra_args.iter().any(|arg| arg == "--session");
        if !restores_exact_session {
            args.push("--session-id".to_string());
            args.push(session_id.clone());
        }

        if let Some(m) = &model {
            args.push("--model".to_string());
            args.push(m.clone());
        }
        if let Some(p) = &provider {
            args.push("--provider".to_string());
            args.push(p.clone());
        }
        args.extend(extra_args);

        // Expand ~ to home directory
        let resolved_cwd = if cwd.starts_with('~') {
            std::env::var("HOME")
                .map(|home| home + &cwd[1..])
                .unwrap_or_else(|_| cwd.clone())
        } else {
            cwd.clone()
        };

        log::info!(
            "[process:{}] spawning: {} {} (cwd={})",
            id,
            program,
            args.join(" "),
            resolved_cwd
        );

        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(&resolved_cwd)
            // Hub collaboration identity: every agent knows who it is,
            // where the hub API lives, and the token to call it with.
            .env("NOVA_HUB_URL", &hub_url)
            .env("NOVA_HUB_TOKEN", &hub_token)
            .env("NOVA_AGENT_ID", &id)
            .env("NOVA_ASK_DEPTH", depth.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                log::error!("[process:{}] failed to spawn: {}", id, e);
                format!("Failed to spawn agent process: {}", e)
            })?;

        log::info!("[process:{}] spawned, pid={:?}", id, child.id());

        let stdin = child.stdin.take().ok_or("Failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout")?;

        let status = Arc::new(Mutex::new(AgentStatus::Starting));
        let message_count = Arc::new(Mutex::new(0usize));
        let last_error = Arc::new(Mutex::new(None));
        let name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(
            restored_name.or_else(|| Some("Nova".to_string())),
        ));
        let (event_tx, _) = broadcast::channel::<serde_json::Value>(256);
        let (stdin_tx, stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        // stdout reader task - parses JSONL events
        let event_tx_clone = event_tx.clone();
        let status_clone = status.clone();
        let name_clone = name.clone();
        let message_count_clone = message_count.clone();
        let last_error_clone = last_error.clone();
        let id_clone = id.clone();
        let stdout_task = tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                log::debug!("[process:{}] stdout <<< {}", id_clone, truncate(&line, 300));
                match serde_json::from_str::<AgentMessage>(&line) {
                    Ok(msg) => {
                        // Update status based on message type
                        match &msg {
                            AgentMessage::AgentSettled {} => {
                                log::info!("[process:{}] agent_settled", id_clone);
                                *status_clone.lock().await = AgentStatus::Idle;
                            }
                            AgentMessage::AgentNameUpdate { name } => {
                                log::info!("[process:{}] agent_name_update: {}", id_clone, name);
                                *name_clone.lock().await = Some(name.clone());
                            }
                            AgentMessage::MessageStart { .. } => {
                                log::debug!("[process:{}] message_start", id_clone);
                                *status_clone.lock().await = AgentStatus::Streaming;
                            }
                            AgentMessage::MessageUpdate { .. } => {
                                // frequent, don't log
                            }
                            AgentMessage::MessageEnd { .. } => {
                                log::debug!("[process:{}] message_end", id_clone);
                                *message_count_clone.lock().await += 1;
                            }
                            AgentMessage::ToolExecutionStart { data } => {
                                let name =
                                    data.get("toolName").and_then(|v| v.as_str()).unwrap_or("?");
                                let id = data
                                    .get("toolCallId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("?");
                                log::info!("[process:{}] tool_start: {} ({})", id_clone, name, id);
                            }
                            AgentMessage::ToolExecutionEnd { data } => {
                                let name =
                                    data.get("toolName").and_then(|v| v.as_str()).unwrap_or("?");
                                let err = data
                                    .get("isError")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                log::info!(
                                    "[process:{}] tool_end: {} error={}",
                                    id_clone,
                                    name,
                                    err
                                );
                            }
                            AgentMessage::Response {
                                success,
                                command,
                                data,
                                ..
                            } => {
                                log::info!(
                                    "[process:{}] response: cmd={:?} success={}",
                                    id_clone,
                                    command,
                                    success
                                );
                                if !success {
                                    *status_clone.lock().await = AgentStatus::Error;
                                    let err = data
                                        .get("error")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown error");
                                    *last_error_clone.lock().await = Some(err.to_string());
                                }
                            }
                            AgentMessage::TurnStart {} => {
                                log::debug!("[process:{}] turn_start", id_clone);
                            }
                            AgentMessage::TurnEnd { .. } => {
                                log::debug!("[process:{}] turn_end", id_clone);
                            }
                            _ => {}
                        }
                        // Forward the raw parsed JSON (not the lossy enum) so unknown
                        // event fields survive the trip to the frontend unchanged.
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            let _ = event_tx_clone.send(value);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[process:{}] parse error: {} — raw: {}",
                            id_clone,
                            e,
                            truncate(&line, 200)
                        );
                    }
                }
            }
            log::info!(
                "[process:{}] stdout closed, setting status=Stopped",
                id_clone
            );
            *status_clone.lock().await = AgentStatus::Stopped;
        });

        // stdin writer task - sends commands to the agent
        let id_stdin = id.clone();
        let mut stdin = stdin;
        let stdin_task = tokio::spawn(async move {
            let mut rx = stdin_rx;
            while let Some(msg) = rx.recv().await {
                log::debug!("[process:{}] stdin >>> {}", id_stdin, truncate(&msg, 300));
                let mut line = msg;
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    log::error!("[process:{}] stdin write failed", id_stdin);
                    break;
                }
                if stdin.flush().await.is_err() {
                    log::error!("[process:{}] stdin flush failed", id_stdin);
                    break;
                }
            }
        });

        // Wait a bit for the process to start
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect agent process: {error}"))?
        {
            let mut stderr_text = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_text).await;
            }
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Agent process exited during startup ({exit_status})")
            } else {
                format!("Agent process exited during startup: {detail}")
            });
        }

        // Drain stderr for the lifetime of the process so a verbose CLI cannot
        // fill the pipe and stall. Errors remain visible in the Studio log.
        let stderr = child.stderr.take();
        let stderr_id = id.clone();
        let stderr_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("[process:{}] stderr: {}", stderr_id, truncate(&line, 500));
                }
            }
        });
        *status.lock().await = AgentStatus::Idle;

        log::info!("[process:{}] ready, status=Idle", id);

        Ok(Self {
            id,
            parent_agent_id,
            cwd,
            model,
            session_id,
            depth,
            created_at: restored_created_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            name,
            status,
            message_count,
            last_error,
            prompt_lock: Arc::new(Mutex::new(())),
            child: Some(Arc::new(Mutex::new(child))),
            host: None,
            stdin_tx,
            event_tx,
            _stdout_task: stdout_task,
            _stderr_task: stderr_task,
            _stdin_task: stdin_task,
        })
    }

    /// Send a command to the agent process
    pub fn send_command(&self, cmd: &RpcCommand) -> Result<(), String> {
        if let Some(host) = &self.host {
            return host.send_command(&self.id, cmd);
        }
        let json = serde_json::to_string(cmd)
            .map_err(|e| format!("Failed to serialize command: {}", e))?;
        self.stdin_tx
            .send(json)
            .map_err(|e| format!("Failed to send command: {}", e))
    }

    /// Subscribe to events from this agent
    pub fn subscribe(&self) -> broadcast::Receiver<serde_json::Value> {
        self.event_tx.subscribe()
    }

    /// Get current status
    pub async fn get_status(&self) -> AgentStatus {
        self.status.lock().await.clone()
    }

    pub async fn request_lifecycle(&self) -> Option<AgentLifecycleSnapshot> {
        self.request_lifecycles().await.remove(&self.id)
    }

    pub async fn request_lifecycles(&self) -> HashMap<String, AgentLifecycleSnapshot> {
        let request_id = format!("lifecycle-{}", uuid::Uuid::new_v4());
        let mut events = self.subscribe();
        if self.send_command(&RpcCommand::AgentList {
            id: Some(request_id.clone()),
            include_archived: true,
        })
        .is_err() {
            return HashMap::new();
        }
        tokio::time::timeout(std::time::Duration::from_millis(800), async {
            while let Ok(event) = events.recv().await {
                if event.get("type").and_then(serde_json::Value::as_str) != Some("response")
                    || event.get("id").and_then(serde_json::Value::as_str) != Some(&request_id)
                {
                    continue;
                }
                return event
                    .get("data")
                    .and_then(|data| data.get("agents"))
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| {
                        let agent_id = entry.get("agentId")?.as_str()?.to_string();
                        let lifecycle: AgentLifecycleSnapshot =
                            serde_json::from_value(entry.get("lifecycle")?.clone()).ok()?;
                        Some((agent_id, lifecycle))
                    })
                    .collect();
            }
            HashMap::new()
        })
        .await
        .unwrap_or_default()
    }

    /// Stop the agent process
    pub async fn stop(&self) -> Result<(), String> {
        log::info!("[process:{}] stopping", self.id);
        if let Some(host) = &self.host {
            host.send_host_command(serde_json::json!({
                "type": "agent_stop",
                "agentId": self.id,
            }))?;
            host.unregister_agent(&self.id).await;
        } else if let Some(child) = &self.child {
            child
                .lock()
                .await
                .kill()
                .await
                .map_err(|e| format!("Failed to kill agent process: {}", e))?;
        }
        *self.status.lock().await = AgentStatus::Stopped;
        Ok(())
    }

    /// Check if the process is still alive
    pub async fn is_alive(&self) -> bool {
        if let Some(host) = &self.host {
            return host.is_alive().await;
        }
        let Some(child) = &self.child else {
            return false;
        };
        child.lock().await.try_wait().ok().flatten().is_none()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Safe: find a char boundary before max
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}
