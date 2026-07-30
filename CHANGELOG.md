# Changelog

## v0.1.0 (2026-07-29)

### 技术决策

- **桌面框架选择 Tauri 2.0** — 相比 Electron，打包体积从 150MB 降至 5-15MB，Rust 内核性能更好，Mac/Windows 双平台支持。
- **独立仓库** — Nova Studio 与 nova monorepo 物理并列、独立版本管理，通过进程间通信（stdin/stdout JSONL）与 agent 交互，无代码依赖。
- **双模式架构** — AgentManager 同时暴露 Tauri Commands（前端调用）和本地 HTTP API（agent 工具调用），前端和主 agent 都能管理子 agent，底层共享同一套进程管理器。
- **亮色系 + 毛玻璃** — 采用浅色主题，indigo-violet 渐变作为强调色，毛玻璃面板 + 模糊光斑背景，干净现代。

### 新增功能

- **Agent 进程管理** — Rust 后端可 spawn/stop/list agent 子进程，每个进程通过 stdin/stdout JSONL 双向通信，支持实时事件流。
- **Chat-first 交互** — 打开即用，无需手动创建 agent。用户输入第一条消息时自动创建 agent 并发送 prompt。
- **可替换背景** — 5 种预设背景（mesh-indigo/rose/emerald/slate/plain），支持自定义图片，用户可切换。
- **Codex 风格界面** — 空状态展示品牌标语，底部输入框带项目路径指示器、附件按钮、模型选择器。
- **文件选择** — 附件按钮点击弹出系统文件选择框，支持多选。

### 待完成

- RPC 协议 TypeScript 类型定义 + Tauri bridge 封装
- Agent 对话面板（流式输出、工具调用卡片、代码高亮）
- 多 Agent 网格面板（同时运行多个 agent，独立面板）
- 设置面板（主题切换、模型选择、API Key 配置）
- macOS / Windows 打包发布

---

## v0.1.0 (2026-07-29)

### Technical Decisions

- **Tauri 2.0 as desktop shell** — Package size drops from ~150MB (Electron) to 5-15MB, Rust kernel for performance, Mac/Windows support.
- **Independent repository** — Nova Studio lives alongside the nova monorepo but is independently versioned. Communicates with agent processes via stdin/stdout JSONL, zero code dependency.
- **Dual-mode architecture** — AgentManager exposes both Tauri Commands (for frontend) and a local HTTP API (for agent tools). Both the UI and the main agent can spawn/manage sub-agents through the same process manager.
- **Light theme + glassmorphism** — Light color palette with indigo-violet gradient accents, frosted-glass panels with blurred color orbs, clean modern aesthetic.

### Features

- **Agent process management** — Rust backend can spawn/stop/list agent child processes. Each communicates via stdin/stdout JSONL with real-time event streaming.
- **Chat-first UX** — Open and start typing immediately. No manual agent creation — the first message auto-spawns an agent and sends the prompt.
- **Replaceable backgrounds** — 5 built-in presets (mesh-indigo/rose/emerald/slate/plain), custom image support, user-switchable.
- **Codex-style interface** — Clean empty state with brand tagline. Bottom input bar with project path indicator, attachment button, and model selector.
- **File picker** — Attachment button opens native system file dialog with multi-select support.

### TODO

- RPC protocol TypeScript types + Tauri bridge abstraction
- Agent chat panel (streaming output, tool call cards, code highlighting)
- Multi-agent grid (run multiple agents simultaneously, independent panels)
- Settings panel (theme switching, model selection, API key config)
- macOS / Windows packaging and release
