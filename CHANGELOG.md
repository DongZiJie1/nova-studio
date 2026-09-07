# Changelog

## v1.4.0 (未发布)

### 新增功能

- **批次任务面板** — 侧边栏按批次展示委派任务与进度（如“2/3 已完成”），支持任务行跳转子 Agent 会话、运行中取消、失败/停止/中断重试。
- **任务级重试** — 重试真正重新执行委派任务（同一子 Agent、原任务文本和超时），执行结果重新走工具轨迹校验并回填父 Agent，而不是只重新 prompt。
- **Task/Batch 持久化与重启恢复** — 任务与批次状态写入 `tasks.json` 快照；重启后未结束任务标记为 `orphaned`、未结束批次关闭为 `stopped`，已触发续跑的批次不会重复汇总。
- **工具轨迹证据校验** — 子任务结果与真实工具执行事件交叉验证：实际编辑的文件合并进 `changedFiles`，摘要报告但轨迹中未观察到的文件标记为残余风险，成功的测试/构建命令成为验证证据。
- **失败测试降级** — 工具轨迹中出现失败的测试命令时，任务强制标记为失败并记录失败命令，摘要模型无法把坏结果标成成功。
- **非打扰式完成通知** — 后台子 Agent 完成时右下角弹出状态 toast（8 秒自动消失），点击直达该 Agent 会话。
- **Hub 查询端点** — `GET /tasks`（按批次/状态/Agent/父 Agent 过滤）、`GET /tasks/batches/{id}`（批次详情）、`GET /agents/{id}/parent`、`POST /tasks/{id}/retry`。

### 修复

- 修复排队中的任务被取消后仍可能启动执行的竞态。
- 修复取消批次后父 Agent 可能被续跑多次或丢失续跑的问题。
- 修复任务取消时因事件路由错误导致响应发到错误 Agent 的问题（mock CLI agentId 提取）。

## v1.2.0 (2026-08-15)

### 新增功能

- **共享 Nova Host** — 多个 Agent 会话复用一个长驻 Nova RPC 进程，支持会话恢复、切换和实时控制。
- **结构化文件引用** — 支持通过 `@` 选择项目文件并以安全的 RPC 文件引用传递给 Agent。
- **斜杠命令** — 输入框提供斜杠命令补全，并与 Nova RPC 会话命令联动。
- **实时会话统计** — 展示上下文窗口、输入与输出 token，并使用 API 返回的真实用量。
- **Agent 头像与项目导航** — 增加随机头像、项目切换和持久化会话浏览体验。

### 交互改进

- **模型与图片能力** — 统一模型选择器状态，完善图片附件能力和输入体验。
- **思考与工具活动** — 思考过程和工具调用支持折叠、展开及更清晰的执行详情。
- **长消息流式渲染** — 优化长回复的实时渲染性能和状态展示。

### 修复

- 修复停止生成和 `Esc` 中断行为。
- 修复输出 token 被累计显示的问题，改为显示最近一次用户输入后的输出量。

## v0.4.3 (2026-07-31)

### 新增功能

- **extension_ui_request 弹窗端到端支持** — 新增 `ExtensionUIPrompt` 组件，支持扩展 UI 弹窗（对话框 + 选项 + 自定义输入）。
- **'Type something' 内联输入** — 弹窗选项支持内联自定义输入，选项列表保持完整。

### RPC 协议对齐

- **事件枚举补全 + `images` 类型** — RPC 协议与 nova 完全对齐。
- **事件转发改用原始 JSON** — 未知事件不再丢字段。

### 样式

- **弹窗 light frosted-glass 毛玻璃效果** + 选项 hover 反馈增强。

---

## v0.4.2 (2026-07-31)

### 修复

- **RPC `set_model`/`compact` 字段名对齐** nova 的 camelCase 命名，修复 RPC 调用参数不匹配。

---

## v0.4.1 (2026-07-31)

### 修复

- **DMG 白屏 + Agent 无回复** — 修复两个打包 Bug。
- **消息重复显示** — 修复重复显示 bug，开启 devtools 方便调试。
- **sidecar 路径解析** — 从可执行文件目录（executable dir）解析，而非 resource_dir。

### 改进

- **GitHub Actions 跨平台构建** — 新增 CI 流水线，跨平台打包并修复 sidecar 打包。
- **更换应用图标**。

---

## v0.3.0 (2026-07-30)

### 新增功能

- **Tauri Sidecar** — Nova agent 编译为独立二进制文件，捆绑在桌面应用内，用户无需手动安装。
- **Bun 编译支持** — 使用 `bun build --compile` 将 TypeScript agent 编译为单个可执行文件（~73MB），无需 Node.js 运行时。
- **自动化打包流程** — `npm run build:nova` 一键编译 agent 二进制，`npx tauri build` 生成 DMG 安装包。

### 改进

- **CLI 路径解析增强** — 优先查找 bundled sidecar（Resources 目录），其次环境变量，最后全局安装。
- **新增 `tauri-plugin-shell`** — 支持 sidecar 进程管理（当前未使用，保留扩展能力）。

---

## v0.2.1 (2026-07-30)

### 改进

- **Nova CLI 查找逻辑** — 支持三种查找方式：`NOVA_CLI_PATH` 环境变量 > `which nova`（全局 npm 安装）> 开发模式相对路径。用户全局安装 `npm i -g @dongzijie1/nova` 后桌面应用自动找到。
- **CLI 调用方式自适应** — 自动检测 `.js` 文件（用 `node` 执行）和命令名（直接执行），兼容开发和生产两种场景。

### 修复

- **`~` 路径展开** — Rust `Command::current_dir("~")` 不会像 shell 展开波浪号，现在用 `$HOME` 环境变量手动展开。

---

## v0.3.0 (2026-07-30)

### Features

- **Tauri Sidecar** — Nova agent compiled as standalone binary, bundled with desktop app. Users don't need manual installation.
- **Bun compilation** — TypeScript agent compiled to single executable via `bun build --compile` (~73MB), no Node.js runtime required.
- **Automated build flow** — `npm run build:nova` compiles agent binary, `npx tauri build` generates DMG installer.

### Improvements

- **Enhanced CLI path resolution** — Priority: bundled sidecar (Resources dir) > env var > global install.
- **Added `tauri-plugin-shell`** — Support for sidecar process management (reserved for future use).

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
