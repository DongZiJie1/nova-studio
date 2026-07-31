mod agent_api;
mod agent_manager;
mod agent_process;
mod commands;
mod rpc_types;

use agent_manager::AgentManager;
use commands::AgentManagerState;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Determine the path to the nova CLI
            // Priority: env var > bundled sidecar (prod) > global npm > dev paths
            let cli_path = resolve_cli_path(app.handle());

            // Create the central AgentManager
            let manager = Arc::new(AgentManager::new(cli_path));

            // Start the HTTP API server for agent tools
            let manager_clone = manager.clone();
            let api_port = 9528; // fixed port for now
            tauri::async_runtime::spawn(async move {
                match agent_api::start_api_server(manager_clone, api_port).await {
                    Ok(port) => log::info!("Agent API available at http://127.0.0.1:{}", port),
                    Err(e) => log::error!("Failed to start agent API: {}", e),
                }
            });

            // Store AgentManager as Tauri managed state
            app.manage(AgentManagerState(manager));

            // Set up event forwarding: agent events → Tauri frontend events
            let app_handle = app.handle().clone();
            let manager_ref = app.state::<AgentManagerState>().0.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = manager_ref.subscribe_global();
                while let Ok((agent_id, msg)) = rx.recv().await {
                    log::debug!("[event] -> frontend: agent={} type={:?}", agent_id, msg_type(&msg));
                    let payload = serde_json::json!({
                        "agentId": agent_id,
                        "event": msg,
                    });
                    let _ = app_handle.emit("agent-event", &payload);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_agent,
            commands::stop_agent,
            commands::list_agents,
            commands::get_agent_info,
            commands::send_prompt,
            commands::abort_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resolve the path to the nova CLI entry point
///
/// Search order:
/// 1. NOVA_CLI_PATH env var (explicit override)
/// 2. Bundled sidecar (production only - check binaries/ dir)
/// 3. `nova` command in PATH (global npm install)
/// 4. Dev mode relative paths
fn resolve_cli_path(app_handle: &tauri::AppHandle) -> String {
    // 1. Explicit env var override (highest priority)
    if let Ok(path) = std::env::var("NOVA_CLI_PATH") {
        if std::path::Path::new(&path).exists() {
            log::info!("Using nova CLI from NOVA_CLI_PATH: {}", path);
            return path;
        }
    }

    // 2. Try bundled sidecar (production only - dev doesn't bundle externalBin)
    #[cfg(not(dev))]
    {
        // In production, check app bundle's Resources directory
        if let Some(resource_dir) = app_handle.path().resource_dir().ok() {
            let nova_path = resource_dir.join("nova");
            if nova_path.exists() {
                log::info!("Using bundled nova: {}", nova_path.display());
                return nova_path.to_string_lossy().to_string();
            }
        }
    }

    // 3. Try to find `nova` in PATH (user did npm i -g)
    if let Ok(output) = std::process::Command::new("which").arg("nova").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            log::info!("Found nova in PATH: {}", path);
            return path;
        }
    }

    log::warn!("Could not find nova CLI. Install it: npm link @dongzijie1/nova");
    "nova".to_string()
}

fn msg_type(msg: &rpc_types::AgentMessage) -> &'static str {
    match msg {
        rpc_types::AgentMessage::Response { .. } => "response",
        rpc_types::AgentMessage::MessageStart { .. } => "message_start",
        rpc_types::AgentMessage::MessageUpdate { .. } => "message_update",
        rpc_types::AgentMessage::MessageEnd { .. } => "message_end",
        rpc_types::AgentMessage::ToolExecutionStart { .. } => "tool_start",
        rpc_types::AgentMessage::ToolExecutionUpdate { .. } => "tool_update",
        rpc_types::AgentMessage::ToolExecutionEnd { .. } => "tool_end",
        rpc_types::AgentMessage::AgentSettled {} => "agent_settled",
        rpc_types::AgentMessage::TurnStart {} => "turn_start",
        rpc_types::AgentMessage::TurnEnd {} => "turn_end",
        rpc_types::AgentMessage::Unknown => "unknown",
    }
}
