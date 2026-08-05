use crate::rpc_types::RpcCommand;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex, RwLock};

/// One Nova RPC process shared by every active AgentSession.
pub struct NovaHostProcess {
    child: Arc<Mutex<Child>>,
    stdin_tx: tokio::sync::mpsc::UnboundedSender<String>,
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<Value>>>>,
    _stdout_task: tokio::task::JoinHandle<()>,
    _stderr_task: tokio::task::JoinHandle<()>,
    _stdin_task: tokio::task::JoinHandle<()>,
}

impl NovaHostProcess {
    pub async fn spawn(
        cli_path: String,
        cwd: String,
        hub_url: String,
        hub_token: String,
    ) -> Result<Self, String> {
        let is_js_file = cli_path.ends_with(".js");
        let (program, mut args) = if is_js_file {
            ("node".to_string(), vec![cli_path])
        } else {
            (cli_path, vec![])
        };
        args.extend(["--mode".to_string(), "rpc".to_string()]);

        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(cwd)
            .env("NOVA_HUB_URL", hub_url)
            .env("NOVA_HUB_TOKEN", hub_token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("Failed to spawn Nova host: {error}"))?;

        let stdin = child.stdin.take().ok_or("Failed to open Nova host stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to open Nova host stdout")?;
        let stderr = child.stderr.take();
        let channels = Arc::new(RwLock::new(
            HashMap::<String, broadcast::Sender<Value>>::new(),
        ));
        let stdout_channels = channels.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    log::warn!("[host] invalid JSONL: {}", line);
                    continue;
                };
                let Some(agent_id) = value.get("agentId").and_then(Value::as_str) else {
                    log::debug!("[host] unscoped event: {}", line);
                    continue;
                };
                if let Some(tx) = stdout_channels.read().await.get(agent_id) {
                    let _ = tx.send(value);
                }
            }
        });

        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let stdin_task = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(mut line) = stdin_rx.recv().await {
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let stderr_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("[host] stderr: {}", line);
                }
            }
        });

        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin_tx,
            channels,
            _stdout_task: stdout_task,
            _stderr_task: stderr_task,
            _stdin_task: stdin_task,
        })
    }

    pub async fn register_agent(&self, agent_id: &str) -> broadcast::Sender<Value> {
        let (tx, _) = broadcast::channel(256);
        self.channels
            .write()
            .await
            .insert(agent_id.to_string(), tx.clone());
        tx
    }

    pub async fn unregister_agent(&self, agent_id: &str) {
        self.channels.write().await.remove(agent_id);
    }

    pub fn send_command(&self, agent_id: &str, command: &RpcCommand) -> Result<(), String> {
        let mut value = serde_json::to_value(command)
            .map_err(|error| format!("Failed to serialize command: {error}"))?;
        value
            .as_object_mut()
            .ok_or("RPC command must serialize to an object")?
            .insert("agentId".to_string(), Value::String(agent_id.to_string()));
        self.stdin_tx
            .send(value.to_string())
            .map_err(|error| format!("Failed to send host command: {error}"))
    }

    pub fn send_host_command(&self, value: Value) -> Result<(), String> {
        self.stdin_tx
            .send(value.to_string())
            .map_err(|error| format!("Failed to send host command: {error}"))
    }

    pub async fn is_alive(&self) -> bool {
        self.child.lock().await.try_wait().ok().flatten().is_none()
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.child
            .lock()
            .await
            .kill()
            .await
            .map_err(|error| format!("Failed to stop Nova host: {error}"))
    }
}
