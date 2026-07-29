use serde::{Deserialize, Serialize};

/// Commands sent from the bridge to the agent process (stdin)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RpcCommand {
    #[serde(rename = "prompt")]
    Prompt {
        id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<String>>,
    },
    #[serde(rename = "abort")]
    Abort { id: Option<String> },
    #[serde(rename = "set_model")]
    SetModel {
        id: Option<String>,
        provider: String,
        model_id: String,
    },
    #[serde(rename = "get_state")]
    GetState { id: Option<String> },
    #[serde(rename = "get_messages")]
    GetMessages { id: Option<String> },
    #[serde(rename = "get_session_stats")]
    GetSessionStats { id: Option<String> },
    #[serde(rename = "new_session")]
    NewSession { id: Option<String> },
    #[serde(rename = "set_thinking_level")]
    SetThinkingLevel { id: Option<String>, level: String },
    #[serde(rename = "compact")]
    Compact {
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
}

/// Messages received from the agent process (stdout)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentMessage {
    #[serde(rename = "response")]
    Response {
        id: Option<String>,
        command: Option<String>,
        success: bool,
        #[serde(default)]
        data: serde_json::Value,
    },
    #[serde(rename = "message_start")]
    MessageStart {
        message: Option<serde_json::Value>,
    },
    #[serde(rename = "message_update")]
    MessageUpdate {
        message: Option<serde_json::Value>,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: Option<serde_json::Value>,
    },
    #[serde(rename = "message_end")]
    MessageEnd {
        message: Option<serde_json::Value>,
    },
    #[serde(rename = "tool_execution_start")]
    ToolExecutionStart {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "tool_execution_update")]
    ToolExecutionUpdate {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "tool_execution_end")]
    ToolExecutionEnd {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "agent_settled")]
    AgentSettled {},
    #[serde(rename = "turn_start")]
    TurnStart {},
    #[serde(rename = "turn_end")]
    TurnEnd {},
    /// Catch-all for unknown event types
    #[serde(other)]
    Unknown,
}

/// Status of an agent process
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Idle,
    Streaming,
    Error,
    Stopped,
}

/// Info about a running agent, returned to frontend/tools
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub status: AgentStatus,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
    pub message_count: usize,
    pub last_error: Option<String>,
}

/// Spawn request from frontend or agent tool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

/// Prompt request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRequest {
    pub agent_id: String,
    pub message: String,
    #[serde(default)]
    pub images: Option<Vec<String>>,
}
