use serde::{Deserialize, Serialize};

/// Image content for prompt messages — mirrors nova's ImageContent
/// (packages/ai/src/types.ts). `data` is base64-encoded image data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReference {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollaborationContext {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "requestDepth")]
    pub request_depth: u64,
    #[serde(rename = "visitedAgentIds")]
    pub visited_agent_ids: Vec<String>,
}

/// Commands sent from the bridge to the agent process (stdin)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RpcCommand {
    #[serde(rename = "prompt")]
    Prompt {
        id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<ImageContent>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "fileReferences")]
        file_references: Option<Vec<FileReference>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "collaborationContext")]
        collaboration_context: Option<CollaborationContext>,
    },
    #[serde(rename = "abort")]
    Abort { id: Option<String> },
    #[serde(rename = "set_model")]
    SetModel {
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    #[serde(rename = "get_state")]
    GetState { id: Option<String> },
    #[serde(rename = "get_context_snapshot")]
    GetContextSnapshot { id: Option<String> },
    #[serde(rename = "get_messages")]
    GetMessages { id: Option<String> },
    #[serde(rename = "get_session_stats")]
    GetSessionStats { id: Option<String> },
    #[serde(rename = "get_execution_traces")]
    GetExecutionTraces { id: Option<String> },
    #[serde(rename = "get_available_models")]
    GetAvailableModels { id: Option<String> },
    #[serde(rename = "new_session")]
    NewSession { id: Option<String> },
    #[serde(rename = "fork")]
    Fork {
        id: Option<String>,
        #[serde(rename = "entryId")]
        entry_id: String,
        position: String,
    },
    #[serde(rename = "set_feedback")]
    SetFeedback {
        id: Option<String>,
        #[serde(rename = "entryId")]
        entry_id: String,
        rating: Option<String>,
    },
    #[serde(rename = "set_thinking_level")]
    SetThinkingLevel { id: Option<String>, level: String },
    #[serde(rename = "compact")]
    Compact {
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "customInstructions")]
        custom_instructions: Option<String>,
    },
    #[serde(rename = "set_session_name")]
    SetSessionName { id: Option<String>, name: String },
    #[serde(rename = "extension_ui_response")]
    ExtensionUIResponse {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confirmed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
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
    MessageStart { message: Option<serde_json::Value> },
    #[serde(rename = "message_update")]
    MessageUpdate {
        message: Option<serde_json::Value>,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: Option<serde_json::Value>,
    },
    #[serde(rename = "message_end")]
    MessageEnd { message: Option<serde_json::Value> },
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
    #[serde(rename = "agent_name_update")]
    AgentNameUpdate { name: String },
    #[serde(rename = "agent_start")]
    AgentStart {},
    #[serde(rename = "agent_end")]
    AgentEnd {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "queue_update")]
    QueueUpdate {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "compaction_start")]
    CompactionStart {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "compaction_end")]
    CompactionEnd {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "auto_retry_start")]
    AutoRetryStart {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "auto_retry_end")]
    AutoRetryEnd {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "turn_start")]
    TurnStart {},
    #[serde(rename = "turn_end")]
    TurnEnd {
        #[serde(flatten)]
        data: serde_json::Value,
    },
    #[serde(rename = "extension_ui_request")]
    ExtensionUIRequest {
        #[serde(flatten)]
        data: serde_json::Value,
    },
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
    #[serde(default)]
    pub parent_agent_id: Option<String>,
    /// Display name, initially "Nova", then LLM-generated after first prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    /// The agent that delegated this process, or None for a user-created root.
    #[serde(default)]
    pub parent_agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Collaboration hop depth: 0 for user-spawned agents, incremented for
    /// agents spawned by another agent. Used to bound delegation chains.
    #[serde(default)]
    pub depth: u64,
}

/// Prompt request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRequest {
    pub agent_id: String,
    pub message: String,
    #[serde(default)]
    pub images: Option<Vec<ImageContent>>,
    #[serde(default)]
    pub file_references: Option<Vec<FileReference>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// nova reads set_model via `command.modelId` (camelCase) — rpc-mode.ts
    #[test]
    fn set_model_serializes_camel_case_model_id() {
        let cmd = RpcCommand::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude-opus-4-7".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"modelId\":\"claude-opus-4-7\""));
        assert!(!json.contains("model_id"));
    }

    /// nova reads compact via `command.customInstructions` (camelCase) — rpc-mode.ts
    #[test]
    fn compact_serializes_camel_case_custom_instructions() {
        let cmd = RpcCommand::Compact {
            id: None,
            custom_instructions: Some("keep it short".into()),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"customInstructions\":\"keep it short\""));
        assert!(!json.contains("custom_instructions"));
    }

    /// nova prompt images are ImageContent[] ({ type, data, mimeType }) — packages/ai/src/types.ts
    #[test]
    fn prompt_serializes_images_as_image_content() {
        let cmd = RpcCommand::Prompt {
            id: None,
            message: "hi".into(),
            images: Some(vec![ImageContent {
                content_type: "image".into(),
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
            }]),
            file_references: Some(vec![FileReference {
                path: "src/main.rs".into(),
            }]),
            collaboration_context: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"mimeType\":\"image/png\""));
        assert!(json.contains("\"data\":\"aGVsbG8=\""));
        assert!(json.contains("\"type\":\"image\""));
        assert!(!json.contains("mime_type"));
        assert!(json.contains("\"fileReferences\":[{\"path\":\"src/main.rs\"}]"));
    }

    /// nova emits extension_ui_request via createDialogPromise — rpc-mode.ts
    /// (fields id/method/title/message/options must survive the flatten)
    #[test]
    fn extension_ui_request_parse_preserving_dialog_fields() {
        let msg: AgentMessage = serde_json::from_str(
            r#"{"type":"extension_ui_request","id":"abc-123","method":"select","title":"Choose","message":"Pick one","options":["选项A","选项B"],"timeout":120000}"#,
        )
        .unwrap();
        match msg {
            AgentMessage::ExtensionUIRequest { data } => {
                assert_eq!(data["id"], "abc-123");
                assert_eq!(data["method"], "select");
                assert_eq!(data["title"], "Choose");
                assert_eq!(data["message"], "Pick one");
                assert_eq!(data["options"][0], "选项A");
                assert_eq!(data["timeout"], 120000);
            }
            _ => panic!("expected ExtensionUIRequest"),
        }
    }

    /// nova resolves pending dialogs on extension_ui_response — rpc-mode.ts stdin handler.
    /// Each form (value / confirmed / cancelled) must serialize with only its own field.
    #[test]
    fn extension_ui_response_serializes_value_form() {
        let cmd = RpcCommand::ExtensionUIResponse {
            id: "abc-123".into(),
            value: Some("选项A".into()),
            confirmed: None,
            cancelled: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"extension_ui_response\""));
        assert!(json.contains("\"id\":\"abc-123\""));
        assert!(json.contains("\"value\":\"选项A\""));
        assert!(!json.contains("confirmed"));
        assert!(!json.contains("cancelled"));
    }

    #[test]
    fn extension_ui_response_serializes_confirm_and_cancel_forms() {
        let confirm = RpcCommand::ExtensionUIResponse {
            id: "c-1".into(),
            value: None,
            confirmed: Some(true),
            cancelled: None,
        };
        let json = serde_json::to_string(&confirm).unwrap();
        assert!(json.contains("\"confirmed\":true"));
        assert!(!json.contains("cancelled"));

        let cancel = RpcCommand::ExtensionUIResponse {
            id: "c-2".into(),
            value: None,
            confirmed: None,
            cancelled: Some(true),
        };
        let json = serde_json::to_string(&cancel).unwrap();
        assert!(json.contains("\"cancelled\":true"));
        assert!(!json.contains("confirmed"));
    }

    /// nova emits agent_start/agent_end — must not be swallowed by the Unknown catch-all
    #[test]
    fn agent_start_and_end_parse_preserving_fields() {
        let agent_start: AgentMessage = serde_json::from_str(r#"{"type":"agent_start"}"#).unwrap();
        assert!(matches!(agent_start, AgentMessage::AgentStart {}));

        let agent_end: AgentMessage = serde_json::from_str(
            r#"{"type":"agent_end","messages":[{"role":"assistant","content":"hi"}],"willRetry":false}"#,
        )
        .unwrap();
        match agent_end {
            AgentMessage::AgentEnd { data } => {
                assert_eq!(data["willRetry"].as_bool(), Some(false));
                assert!(data["messages"].is_array());
            }
            _ => panic!("expected AgentEnd"),
        }
    }
}
