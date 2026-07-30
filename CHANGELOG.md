# Changelog

## v0.2.1 (2026-07-30)

### 改进

- **Nova CLI 查找逻辑** — 支持三种查找方式：`NOVA_CLI_PATH` 环境变量 > `which nova`（全局 npm 安装）> 开发模式相对路径。用户全局安装 `npm i -g @dongzijie1/nova` 后桌面应用自动找到。
- **CLI 调用方式自适应** — 自动检测 `.js` 文件（用 `node` 执行）和命令名（直接执行），兼容开发和生产两种场景。

### 修复

- **`~` 路径展开** — Rust `Command::current_dir("~")` 不会像 shell 展开波浪号，现在用 `$HOME` 环境变量手动展开。

---

## v0.2.1 (2026-07-30)

### Improvements

- **Nova CLI resolution** — Three-tier lookup: `NOVA_CLI_PATH` env var > `which nova` (global npm) > dev-mode relative paths. Works after a simple `npm i -g @dongzijie1/nova`.
- **Adaptive CLI invocation** — Auto-detects `.js` files (run with `node`) vs command names (run directly),兼容 dev and production.

### Fixes

- **`~` path expansion** — Rust `Command::current_dir("~")` doesn't expand tilde like a shell. Now resolved via `$HOME` env var.

---

## v0.2.0 (2026-07-30)

### 新增功能

- **前端类型系统** — 新建 `lib/tauri-bridge.ts`（Tauri invoke/emit 封装）、`lib/event-parser.ts`（事件解析分类）、`stores/settings-store.ts`（设置持久化）。
- **RPC 协议类型补全** — `rpc-types.ts` 覆盖 Rust 后端全部 AgentMessage 变体、StreamEvent、SpawnRequest、AgentInfo 等类型。
- **多 Agent 状态管理** — `agent-store.ts` 支持 streamingText 流式累积、activeToolCalls 工具调用追踪、handleAgentEvent 事件自动分发。
- **全链路对接** — AppShell 接入 spawnAgent/sendPrompt 实现完整发送流程，App.tsx 挂载全局事件监听，事件自动流入 Zustand store。
- **调试日志** — Rust 后端全链路添加 `log::debug/info`，`RUST_LOG=debug` 可观测 stdin/stdout 通信和事件转发。

### 改进

- **textarea 自动撑高** — 输入多行内容时 textarea 高度自适应，修复 placeholder 重叠显示问题。
- **侧边栏无闪烁** — 用 CSS width 过渡替代条件渲染，避免第一条消息时布局跳动。

### 修复

- **Tauri WebView 渲染卡顿** — 移除 `backdrop-filter: blur(20px)`，该属性在 Tauri WebView 中性能极差。
- **Rust `truncate` UTF-8 安全** — 使用 `is_char_boundary` 避免多字节字符截断 panic。
- **Response 失败时 `last_error` 丢失** — 恢复从 `data.error` 提取错误信息逻辑。

---

## v0.2.0 (2026-07-30)

### Features

- **Frontend type system** — New `lib/tauri-bridge.ts` (typed Tauri invoke/emit), `lib/event-parser.ts` (event parsing), `stores/settings-store.ts` (persisted settings).
- **Full RPC protocol types** — `rpc-types.ts` covers all Rust AgentMessage variants, StreamEvent, SpawnRequest, AgentInfo.
- **Multi-agent state management** — `agent-store.ts` with streamingText accumulation, activeToolCalls tracking, handleAgentEvent auto-dispatch.
- **Full-stack integration** — AppShell wired to spawnAgent/sendPrompt, App.tsx global event listener, events flow into Zustand store.
- **Debug logging** — Rust backend full-path `log::debug/info`, observable with `RUST_LOG=debug`.

### Improvements

- **Textarea auto-resize** — Input area grows with multi-line content, fixing placeholder overlap.
- **Sidebar no-flicker** — CSS width transition instead of conditional rendering, no layout jump on first message.

### Fixes

- **Tauri WebView render lag** — Removed `backdrop-filter: blur(20px)` which is extremely slow in Tauri WebView.
- **Rust `truncate` UTF-8 safety** — Uses `is_char_boundary` to avoid multi-byte character panic.
- **`last_error` lost on Response failure** — Restored `data.error` extraction logic.

---

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

### 待完成（已移至后续版本）

- ~~RPC 协议 TypeScript 类型定义 + Tauri bridge 封装~~ → v0.2.0
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

- ~~RPC protocol TypeScript types + Tauri bridge abstraction~~ → v0.2.0
- Agent chat panel (streaming output, tool call cards, code highlighting)
- Multi-agent grid (run multiple agents simultaneously, independent panels)
- Settings panel (theme switching, model selection, API key config)
- macOS / Windows packaging and release
