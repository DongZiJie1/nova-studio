use crate::rpc_types::{AgentMessage, AgentStatus, RpcCommand};
use serde_json;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};

/// A single agent process running `node cli.js --mode rpc`
pub struct AgentProcess {
    pub id: String,
    pub cwd: String,
    pub status: Arc<Mutex<AgentStatus>>,
    pub message_count: Arc<Mutex<usize>>,
    pub last_error: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Child>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    event_tx: broadcast::Sender<AgentMessage>,
    _stdout_task: tokio::task::JoinHandle<()>,
    _stdin_task: tokio::task::JoinHandle<()>,
}

impl AgentProcess {
    /// Spawn a new agent process
    pub async fn spawn(
        id: String,
        cwd: String,
        cli_path: String,
        model: Option<String>,
        provider: Option<String>,
        extra_args: Vec<String>,
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

        log::info!("[process:{}] spawning: {} {} (cwd={})", id, program, args.join(" "), resolved_cwd);

        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(&resolved_cwd)
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
        let (event_tx, _) = broadcast::channel(256);
        let (stdin_tx, stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        // stdout reader task - parses JSONL events
        let event_tx_clone = event_tx.clone();
        let status_clone = status.clone();
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
                                let name = data.get("toolName").and_then(|v| v.as_str()).unwrap_or("?");
                                let id = data.get("toolCallId").and_then(|v| v.as_str()).unwrap_or("?");
                                log::info!("[process:{}] tool_start: {} ({})", id_clone, name, id);
                            }
                            AgentMessage::ToolExecutionEnd { data } => {
                                let name = data.get("toolName").and_then(|v| v.as_str()).unwrap_or("?");
                                let err = data.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
                                log::info!("[process:{}] tool_end: {} error={}", id_clone, name, err);
                            }
                            AgentMessage::Response { success, command, data, .. } => {
                                log::info!("[process:{}] response: cmd={:?} success={}", id_clone, command, success);
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
                        let _ = event_tx_clone.send(msg);
                    }
                    Err(e) => {
                        log::warn!("[process:{}] parse error: {} — raw: {}", id_clone, e, truncate(&line, 200));
                    }
                }
            }
            log::info!("[process:{}] stdout closed, setting status=Stopped", id_clone);
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
        *status.lock().await = AgentStatus::Idle;

        log::info!("[process:{}] ready, status=Idle", id);

        Ok(Self {
            id,
            cwd,
            status,
            message_count,
            last_error,
            child: Arc::new(Mutex::new(child)),
            stdin_tx,
            event_tx,
            _stdout_task: stdout_task,
            _stdin_task: stdin_task,
        })
    }

    /// Send a command to the agent process
    pub fn send_command(&self, cmd: &RpcCommand) -> Result<(), String> {
        let json =
            serde_json::to_string(cmd).map_err(|e| format!("Failed to serialize command: {}", e))?;
        self.stdin_tx
            .send(json)
            .map_err(|e| format!("Failed to send command: {}", e))
    }

    /// Subscribe to events from this agent
    pub fn subscribe(&self) -> broadcast::Receiver<AgentMessage> {
        self.event_tx.subscribe()
    }

    /// Get current status
    pub async fn get_status(&self) -> AgentStatus {
        self.status.lock().await.clone()
    }

    /// Stop the agent process
    pub async fn stop(&self) -> Result<(), String> {
        log::info!("[process:{}] stopping", self.id);
        let mut child = self.child.lock().await;
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill agent process: {}", e))?;
        *self.status.lock().await = AgentStatus::Stopped;
        Ok(())
    }

    /// Check if the process is still alive
    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        child.try_wait().ok().flatten().is_none()
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
