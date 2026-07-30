# Changelog

## 2026-07-29

### Features
- **Rust backend — agent process management (dual-mode architecture)**
  - `rpc_types.rs`: RPC protocol types (commands, responses, events)
  - `agent_process.rs`: single agent process spawn + stdin/stdout JSONL communication
  - `agent_manager.rs`: central AgentManager (spawn/stop/list/status)
  - `commands.rs`: Tauri commands for frontend (UI-driven mode)
  - `agent_api.rs`: HTTP API on localhost:9528 for agent tools (agent-driven mode)
  - `lib.rs`: wires everything together, event forwarding to frontend
- **Switch to light theme with glassmorphism**
  - Light color palette: white/gray backgrounds, indigo-violet accents
  - Subtle mesh gradient background with blurred color orbs
  - Glass panels with white transparency and soft shadows
- **Layout components + Zustand stores**
  - `Background.tsx`: replaceable background with 5 presets + custom image
  - `Sidebar.tsx`: agent list with status dots, new agent button, settings link
  - `AppShell.tsx`: main layout shell composing Background + Sidebar + content area
  - `stores/ui-store.ts`: UI state (bg preset, custom bg url, sidebar collapsed)
  - `stores/agent-store.ts`: agent state (agents map, active agent, messages, status)
- **Chat-first UX** — no create button, auto-spawn on first message
- **Codex-style empty state** — centered logo, heading, clean tagline
- **Codex-style input box** — rounded card with project path, toolbar, send button
- **Attachment button opens file picker** — system file dialog, supports multi-select

### Fixes
- Center icon, simplify button, adjust spacing
- Refine button — no shadow, smaller radius, flatter
- Input box — inline styles for reliability, centered layout
- Center input area, add bottom spacing
