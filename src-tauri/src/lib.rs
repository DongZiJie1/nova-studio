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
        .setup(|app| {
            // Determine the path to the nova CLI
            // In dev, it's the nova monorepo's dist/cli.js
            // In production, it's bundled with the app
            let cli_path = resolve_cli_path();

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
fn resolve_cli_path() -> String {
    // Try common locations
    let candidates = vec![
        // Relative to nova-studio (dev mode)
        "../../nova/packages/nova/dist/cli.js",
        // Absolute path
        "/Users/dongzj1102/Desktop/Pi-Agent/nova/packages/nova/dist/cli.js",
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return std::fs::canonicalize(candidate)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| candidate.to_string());
        }
    }

    // Fallback: assume it's in PATH or relative
    log::warn!("Could not find nova CLI, using default path");
    "dist/cli.js".to_string()
}
