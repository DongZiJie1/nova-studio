use crate::agent_process::AgentProcess;
use crate::rpc_types::{AgentInfo, ImageContent, RpcCommand, SpawnRequest};
use chrono::Utc;
use std::collections::HashMap;
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
}

impl AgentManager {
    pub fn new(cli_path: String) -> Self {
        let (global_event_tx, _) = broadcast::channel(512);
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            global_event_tx,
            cli_path,
        }
    }

    /// Spawn a new agent process
    pub async fn spawn(&self, request: SpawnRequest) -> Result<AgentInfo, String> {
        let id = Uuid::new_v4().to_string()[..8].to_string();
        let agent_id = format!("agent-{}", id);

        let extra_args = request.args.unwrap_or_default();

        let process = AgentProcess::spawn(
            agent_id.clone(),
            request.cwd.clone(),
            self.cli_path.clone(),
            request.model,
            request.provider,
            extra_args,
        )
        .await?;

        let info = self.build_info(&agent_id, &request.cwd, &process).await;

        // Forward events from this agent to the global event bus
        let mut rx = process.subscribe();
        let global_tx = self.global_event_tx.clone();
        let aid = agent_id.clone();
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                let _ = global_tx.send((aid.clone(), msg));
            }
        });

        self.agents
            .write()
            .await
            .insert(agent_id, Arc::new(process));

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
        agent.stop().await
    }

    /// List all agents
    pub async fn list(&self) -> Vec<AgentInfo> {
        let agents = self.agents.read().await;
        let mut infos = Vec::new();
        for (id, agent) in agents.iter() {
            let status = agent.get_status().await;
            let msg_count = *agent.message_count.lock().await;
            let last_err = agent.last_error.lock().await.clone();
            infos.push(AgentInfo {
                id: id.clone(),
                status,
                cwd: agent.cwd.clone(),
                model: None,
                session_id: None,
                created_at: Utc::now().to_rfc3339(),
                message_count: msg_count,
                last_error: last_err,
            });
        }
        infos
    }

    /// Get info about a specific agent
    pub async fn get_info(&self, agent_id: &str) -> Result<AgentInfo, String> {
        let agents = self.agents.read().await;
        let agent = agents.get(agent_id).ok_or("Agent not found")?;
        let status = agent.get_status().await;
        let cwd = agent.cwd.clone();
        let msg_count = *agent.message_count.lock().await;
        let last_err = agent.last_error.lock().await.clone();
        Ok(AgentInfo {
            id: agent_id.to_string(),
            status,
            cwd,
            model: None,
            session_id: None,
            created_at: Utc::now().to_rfc3339(),
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

    async fn build_info(
        &self,
        id: &str,
        cwd: &str,
        process: &AgentProcess,
    ) -> AgentInfo {
        AgentInfo {
            id: id.to_string(),
            status: process.get_status().await,
            cwd: cwd.to_string(),
            model: None,
            session_id: None,
            created_at: Utc::now().to_rfc3339(),
            message_count: 0,
            last_error: None,
        }
    }
}
