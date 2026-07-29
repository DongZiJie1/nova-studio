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
        let mut args = vec![cli_path, "--mode".to_string(), "rpc".to_string()];

        if let Some(m) = &model {
            args.push("--model".to_string());
            args.push(m.clone());
        }
        if let Some(p) = &provider {
            args.push("--provider".to_string());
            args.push(p.clone());
        }
        args.extend(extra_args);

        let mut child = Command::new("node")
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn agent process: {}", e))?;

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
        let stdout_task = tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<AgentMessage>(&line) {
                    Ok(msg) => {
                        // Update status based on message type
                        match &msg {
                            AgentMessage::AgentSettled {} => {
                                *status_clone.lock().await = AgentStatus::Idle;
                            }
                            AgentMessage::MessageStart { .. } => {
                                *status_clone.lock().await = AgentStatus::Streaming;
                            }
                            AgentMessage::Response { success, .. } => {
                                if !success {
                                    *status_clone.lock().await = AgentStatus::Error;
                                }
                            }
                            _ => {}
                        }
                        // Count messages
                        match &msg {
                            AgentMessage::MessageEnd { .. } => {
                                *message_count_clone.lock().await += 1;
                            }
                            AgentMessage::Response { success, data, .. } => {
                                if !success {
                                    let err = data
                                        .get("error")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown error");
                                    *last_error_clone.lock().await = Some(err.to_string());
                                }
                            }
                            _ => {}
                        }
                        let _ = event_tx_clone.send(msg);
                    }
                    Err(e) => {
                        log::warn!("Failed to parse agent message: {} — raw: {}", e, line);
                    }
                }
            }
            *status_clone.lock().await = AgentStatus::Stopped;
        });

        // stdin writer task - sends commands to the agent
        let mut stdin = stdin;
        let stdin_task = tokio::spawn(async move {
            let mut rx = stdin_rx;
            while let Some(msg) = rx.recv().await {
                let mut line = msg;
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Wait a bit for the process to start
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        *status.lock().await = AgentStatus::Idle;

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
