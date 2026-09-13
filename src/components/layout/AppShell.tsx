import { memo, useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Background } from "./Background";
import { useAgentStore, type AgentState, type AvailableModel } from "../../stores/agent-store";
import { useNotificationStore } from "../../stores/notification-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useUiStore } from "../../stores/ui-store";
import {
  abortAgent,
  cancelAgent,
  retryAgent,
  steerAgent,
  activateAgent,
  listAgents,
  listProjectFiles,
  spawnAgent,
  sendPrompt,
  setModel,
  setToolPermissionMode,
  respondToolPermission,
  requestAvailableModels,
  requestSessionStats,
  requestExecutionTraces,
  requestContextSnapshot,
  askTemporary,
  onTemporaryAnswerChunk,
  listAllModels,
  fetchModelsViaShell,
  startNewSession,
  compactSession,
  setSessionName,
  setMessageFeedback,
  forkSession,
  requestMessages,
  revertFileChange,
  checkWorktreeAvailable,
  getWorktreeStatus,
  getWorktreeDiff,
  acceptWorktree,
  rejectWorktree,
} from "../../lib/tauri-bridge";
import { common, createLowlight } from "lowlight";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { ImageContent } from "../../lib/rpc-types";
import type { ExecutionTrace } from "../../lib/rpc-types";
import type { ToolPermissionMode, WorktreeStatus } from "../../lib/rpc-types";

const TOOL_PERMISSION_MODES: Array<{ value: ToolPermissionMode; label: string; description: string }> = [
  { value: "ask", label: "询问", description: "危险操作前弹窗确认" },
  { value: "edits", label: "自动编辑", description: "文件编辑自动批准，其余仍询问" },
  { value: "allow", label: "全部放行", description: "跳过所有权限检查" },
];

const AGENT_TRAJECTORY_TOOL_NAMES = new Set(["hub_delegate_task"]);

function isAgentTrajectoryTool(name: string): boolean {
  return AGENT_TRAJECTORY_TOOL_NAMES.has(name);
}
import { ChatMessage, ToolCallList, type TurnFileChange } from "../chat/ChatMessage";
import { NotificationToasts } from "./NotificationToasts";
import { ActivityHeatmap } from "../settings/ActivityHeatmap";
import { ModelSettings } from "../settings/ModelSettings";
import { StreamingText } from "../chat/StreamingText";
import { ThinkingCard } from "../chat/ThinkingCard";
import { Markdown } from "../chat/Markdown";
import { SlashCommandMenu } from "../chat/SlashCommandMenu";
import { FileMentionMenu } from "../chat/FileMentionMenu";
import { agentAvatarSrc, getOrAssignAgentAvatar } from "../../lib/agent-avatars";
import {
  BUILTIN_SLASH_COMMANDS,
  matchingSlashCommands,
  type SlashCommand,
} from "../../lib/slash-commands";
import { findFileMention, insertFileMention } from "../../lib/file-mentions";
import {
  Paperclip,
  ArrowUp,
  ArrowDown,
  Square,
  FolderOpen,
  Pencil,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
  ExternalLink,
  EyeOff,
  FileText,
  FileCode,
  FileJson,
  FileType,
  Image,
  File,
  Moon,
  Sun,
  Settings,
  Palette,
  ChartNoAxesColumnIncreasing,
  ArrowLeft,
  MessageCircle,
  Route,
  PanelLeftClose,
  PanelLeftOpen,
  LoaderCircle,
  RotateCcw,
  Bot,
  GitBranch,
  GitMerge,
  Trash2,
} from "lucide-react";

const PROJECT_NAMES_KEY = "nova-studio.project-names";
const AGENT_NAMES_KEY = "nova-studio.agent-names";

function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18a10.98 10.98 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
const HIDDEN_AGENTS_KEY = "nova-studio.hidden-agents";
const CONVERSATION_MINIMAP_PAIR_THRESHOLD = 6;

function isTemporaryRuntimeProject(cwd: string): boolean {
  const directoryName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return directoryName.startsWith("pi-runtime");
}

interface ConversationPair {
  userMessageId: string;
  userText: string;
  assistantText: string;
}

interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;        // base64 (images) or text content (text files)
  isImage: boolean;
  isText: boolean;
  previewUrl?: string;  // blob URL for image thumbnails
}

function readWorkbenchPanelWidth(key: string, fallback: number): number {
  const stored = Number(localStorage.getItem(key));
  const maxWidth = Math.max(420, window.innerWidth - 460);
  const width = Number.isFinite(stored) && stored >= 320 ? stored : fallback;
  return Math.min(width, maxWidth);
}

function createNewFileDisplayPatch(path: string, content: string): string | undefined {
  if (!content) return undefined;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.split("\n");
  const noNewlineMarker = content.endsWith("\n") ? "" : "\n\\ No newline at end of file";
  return `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${noNewlineMarker}`;
}

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

interface DiffToken {
  text: string;
  cls: string;
}

interface DiffCell {
  no?: number;
  text: string;
  kind: "add" | "del" | "ctx";
  tokens?: DiffToken[];
}

type DiffRow =
  | { type: "gap"; count: number }
  | { type: "marker"; side: "left" | "right" }
  | { type: "row"; left?: DiffCell; right?: DiffCell };

const lowlight = createLowlight(common);
const highlightCache = new Map<string, DiffToken[][]>();

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", cs: "csharp",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp", swift: "swift", php: "php", lua: "lua",
  sql: "sql", r: "r", json: "json", yaml: "yaml", yml: "yaml", ini: "ini", toml: "ini",
  css: "css", scss: "scss", less: "less", html: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  diff: "diff", patch: "diff", graphql: "graphql", gql: "graphql", perl: "perl", pl: "perl",
};

function diffLanguageForPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXTENSION_LANGUAGES[ext] ?? "plaintext";
}

const FILE_BADGE_TONES: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  css: "style", scss: "style", less: "style",
  html: "web", xml: "web", svg: "web", vue: "web",
  md: "doc", mdx: "doc", txt: "doc",
  json: "data", yaml: "data", yml: "data", toml: "data", ini: "data",
  py: "py",
  rs: "sys", go: "sys", java: "sys", c: "sys", h: "sys", cpp: "sys", cc: "sys", hpp: "sys",
  swift: "sys", kt: "sys", cs: "sys", php: "sys", sql: "sys", lua: "sys",
  sh: "sh", bash: "sh", zsh: "sh",
};

function fileBadge(path: string): { label: string; tone: string } {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return { label: (ext || "file").slice(0, 4).toUpperCase(), tone: FILE_BADGE_TONES[ext] ?? "plain" };
}

/**
 * Highlight a contiguous block of diff lines as one snippet so multi-line
 * tokens survive, then split the resulting hast tree back into per-line
 * token arrays (safe React spans, no raw HTML).
 */
function highlightRun(text: string, language: string): DiffToken[][] {
  const cacheKey = `${language}\u0000${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;
  const lines: DiffToken[][] = [[]];
  try {
    const visit = (node: HastNode, inherited: string) => {
      if (node.type === "text") {
        const parts = (node.value ?? "").split("\n");
        parts.forEach((part, partIndex) => {
          if (partIndex > 0) lines.push([]);
          if (part) lines[lines.length - 1].push({ text: part, cls: inherited });
        });
        return;
      }
      const raw = node.properties?.className;
      const own = Array.isArray(raw) ? raw.filter((item) => typeof item === "string").join(" ") : "";
      const next = own ? (inherited ? `${inherited} ${own}` : own) : inherited;
      for (const child of node.children ?? []) visit(child, next);
    };
    for (const child of lowlight.highlight(language, text).children) visit(child as HastNode, "");
  } catch {
    lines.length = 0;
    for (const line of text.split("\n")) lines.push([{ text: line, cls: "" }]);
  }
  if (highlightCache.size > 600) highlightCache.clear();
  highlightCache.set(cacheKey, lines);
  return lines;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffRows(patches: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let nextOld = 0;
  let nextNew = 0;
  let started = false;
  let lastMarkerSide: "left" | "right" = "right";
  let pendingDelete: DiffCell[] = [];
  let pendingAdd: DiffCell[] = [];

  // Pair a run of deletions with the following run of additions row by row
  // (GitHub split-diff alignment); the shorter side stays empty.
  const flushChangeRun = () => {
    const count = Math.max(pendingDelete.length, pendingAdd.length);
    for (let index = 0; index < count; index++) {
      rows.push({ type: "row", left: pendingDelete[index], right: pendingAdd[index] });
    }
    pendingDelete = [];
    pendingAdd = [];
  };

  for (const patch of patches) {
    for (const line of patch.split("\n")) {
      const header = line.match(HUNK_HEADER_PATTERN);
      if (header) {
        flushChangeRun();
        const oldStart = Number(header[1]);
        if (!started) {
          if (oldStart > 1) rows.push({ type: "gap", count: oldStart - 1 });
          started = true;
        } else if (oldStart > nextOld) {
          rows.push({ type: "gap", count: oldStart - nextOld });
        }
        nextOld = oldStart;
        nextNew = Number(header[3]);
        continue;
      }
      if (!started) continue; // Index:/===/---/+++ meta lines
      if (line.startsWith("+")) {
        pendingAdd.push({ no: nextNew++, text: line.slice(1), kind: "add" });
        lastMarkerSide = "right";
        continue;
      }
      if (line.startsWith("-")) {
        pendingDelete.push({ no: nextOld++, text: line.slice(1), kind: "del" });
        lastMarkerSide = "left";
        continue;
      }
      flushChangeRun();
      if (line.startsWith("\\")) {
        rows.push({ type: "marker", side: lastMarkerSide });
        continue;
      }
      rows.push({
        type: "row",
        left: { no: nextOld++, text: line.slice(1), kind: "ctx" },
        right: { no: nextNew++, text: line.slice(1), kind: "ctx" },
      });
      lastMarkerSide = "right";
    }
  }
  flushChangeRun();
  return rows;
}

function applyDiffHighlighting(rows: DiffRow[], language: string) {
  const highlightSide = (side: "left" | "right") => {
    let run: DiffCell[] = [];
    const flushRun = () => {
      if (!run.length) return;
      const tokens = highlightRun(run.map((cell) => cell.text).join("\n"), language);
      run.forEach((cell, index) => {
        cell.tokens = tokens[index] ?? [{ text: cell.text, cls: "" }];
      });
      run = [];
    };
    for (const row of rows) {
      if (row.type !== "row") {
        flushRun();
        continue;
      }
      const cell = row[side];
      if (cell) run.push(cell);
    }
    flushRun();
  };
  highlightSide("left");
  highlightSide("right");
}

function FileDiff({ patches, path }: { patches: string[]; path: string }) {
  const rows = useMemo(() => {
    const parsed = parseDiffRows(patches);
    applyDiffHighlighting(parsed, diffLanguageForPath(path));
    return parsed;
  }, [patches, path]);

  const renderCell = (cell?: DiffCell) => {
    if (!cell) return null;
    const tokens = cell.tokens ?? [];
    if (!tokens.length || (tokens.length === 1 && !tokens[0].text)) return "\u00A0";
    return tokens.map((token, index) =>
      token.cls ? <span key={index} className={token.cls}>{token.text}</span> : <span key={index}>{token.text}</span>,
    );
  };

  return (
    <div className="split-diff">
      <table className="split-diff-table">
        <colgroup>
          <col className="split-diff-col-num" />
          <col className="split-diff-col-code" />
          <col className="split-diff-col-num" />
          <col className="split-diff-col-code" />
        </colgroup>
        <tbody>
          {rows.map((row, index) => {
            if (row.type === "gap") {
              return (
                <tr key={index} className="split-diff-gap">
                  <td colSpan={4}><span className="split-diff-gap-label">{row.count} unmodified lines</span></td>
                </tr>
              );
            }
            if (row.type === "marker") {
              return (
                <tr key={index} className="split-diff-marker">
                  <td className="split-diff-num" />
                  <td className="split-diff-code">{row.side === "left" ? "\\ No newline at end of file" : "\u00A0"}</td>
                  <td className="split-diff-num" />
                  <td className="split-diff-code">{row.side === "right" ? "\\ No newline at end of file" : "\u00A0"}</td>
                </tr>
              );
            }
            const { left, right } = row;
            const rowClass = !left && right
              ? " is-add"
              : left && !right
                ? " is-del"
                : left && right && (left.kind !== "ctx" || right.kind !== "ctx")
                  ? " is-mod"
                  : "";
            return (
              <tr key={index} className={`split-diff-row${rowClass}`}>
                <td className="split-diff-num">{left?.no ?? ""}</td>
                <td className={`split-diff-code split-diff-code-left${left ? ` is-${left.kind}` : " is-empty"}`}>{renderCell(left)}</td>
                <td className="split-diff-num">{right?.no ?? ""}</td>
                <td className={`split-diff-code${right ? ` is-${right.kind}` : " is-empty"}`}>{renderCell(right)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SelectedTrajectoryEntry {
  id: string;
  label: string;
  data: unknown;
}

type TrajectoryDetailView = "execution" | "json";

interface ChatHistoryProps {
  messages: AgentState["messages"];
  agentSenderLabels: Record<string, string>;
  avatarId: AgentState["avatarId"];
  actionableAssistantMessageIds: Set<string>;
  turnFileChangesByAssistantId: Map<string, TurnFileChange[]>;
  onFeedback: (message: AgentState["messages"][number], rating: "up" | "down" | null) => void;
  onFork: (message: AgentState["messages"][number]) => void;
  onOpenAgent: (agentId: string, view: "chat" | "trajectory") => void;
  onRevertFileChange: (assistantMessageId: string, change: TurnFileChange) => Promise<void>;
  onReviewFileChange: (assistantMessageId: string, path: string) => void;
}

const ChatHistory = memo(function ChatHistory({
  messages,
  agentSenderLabels,
  avatarId,
  actionableAssistantMessageIds,
  turnFileChangesByAssistantId,
  onFeedback,
  onFork,
  onOpenAgent,
  onRevertFileChange,
  onReviewFileChange,
}: ChatHistoryProps) {
  return messages.map((message) => (
    <div
      key={message.id}
      id={message.role === "user" ? `conversation-turn-${message.id}` : undefined}
      style={{ scrollMarginTop: 24 }}
    >
      <ChatMessage
        message={message}
        userLabel={message.sourceAgentId ? (agentSenderLabels[message.sourceAgentId] ?? "Main Agent") : "User"}
        avatarId={avatarId}
        showActions={actionableAssistantMessageIds.has(message.id)}
        onFeedback={onFeedback}
        onFork={onFork}
        onOpenAgent={onOpenAgent}
        onRevertFileChange={(change) => onRevertFileChange(message.id, change)}
        onReviewFileChange={(path) => onReviewFileChange(message.id, path)}
        fileChanges={turnFileChangesByAssistantId.get(message.id)}
      />
    </div>
  ));
});

function formatTrajectoryTime(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") return "暂无时间数据";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无时间数据";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatTrajectoryDuration(value: number | undefined): string {
  if (value === undefined) return "暂无耗时数据";
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} 秒`;
  return `${Math.floor(value / 60_000)} 分 ${((value % 60_000) / 1000).toFixed(1)} 秒`;
}

function formatTrajectoryStatus(value: ExecutionTrace["status"] | undefined): string {
  if (value === "running") return "执行中";
  if (value === "success") return "已完成";
  if (value === "error") return "失败";
  if (value === "cancelled") return "已取消";
  if (value === "interrupted") return "已中断";
  return "已记录";
}

function TrajectoryExecutionDetails({ entry, modelName, traces }: { entry: SelectedTrajectoryEntry; modelName: string; traces: ExecutionTrace[] }) {
  const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
  const role = typeof data.role === "string" ? data.role : typeof data.type === "string" ? data.type : entry.label.toLowerCase();
  const timestamp = data.timestamp;
  const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls as Array<Record<string, unknown>> : [];
  const entryId = typeof data.entryId === "string" ? data.entryId : undefined;
  const toolCallIds = new Set(toolCalls.map((tool) => tool.id).filter((id): id is string => typeof id === "string"));
  if (role === "active_tool_call" && typeof data.id === "string") toolCallIds.add(data.id);
  const matchingTraces = traces.filter((trace) =>
    (trace.category === "model" && entryId !== undefined && trace.messageEntryId === entryId) ||
    (trace.category === "tool" && trace.toolCallId !== undefined && toolCallIds.has(trace.toolCallId)),
  );
  const modelTrace = matchingTraces.find((trace) => trace.category === "model");
  const thinkingTrace = [...traces].reverse().find((trace) =>
    trace.category === "thinking" &&
    (trace.parentTraceId === modelTrace?.traceId || (role === "streaming_thinking" && trace.status === "running")),
  );
  const primaryTrace = role === "thinking" || role === "streaming_thinking" ? thinkingTrace : modelTrace;
  const typeLabel = role === "tool" || role === "active_tool_call"
    ? "工具调用"
    : role === "assistant" || role === "streaming_assistant"
      ? "模型调用"
      : role === "thinking" || role === "streaming_thinking"
        ? "模型思考"
        : role === "user"
          ? "用户输入"
          : role === "agent_result"
            ? "子 Agent 回传"
            : role === "agent_batch"
              ? "子任务批次完成指令"
              : role === "notice"
                ? "系统提示"
          : role === "context_system"
            ? "系统提示词"
            : role === "context_tools"
              ? "工具定义集合"
              : role === "context_skills"
                ? "Skill 声明集合"
                : role === "context_instructions"
                  ? "项目指令集合"
          : role;
  const isContextEntry = role.startsWith("context_");

  return (
    <div className="trajectory-execution-details">
      <dl className="trajectory-execution-summary">
        <div><dt>事件类型</dt><dd>{typeLabel}</dd></div>
        {isContextEntry && Array.isArray(data.items) && <div><dt>资源数量</dt><dd>{data.items.length}</dd></div>}
        {isContextEntry && typeof data.name === "string" && <div><dt>资源名称</dt><dd>{data.name}</dd></div>}
        {isContextEntry && typeof data.path === "string" && <div><dt>来源路径</dt><dd>{data.path}</dd></div>}
        <div><dt>记录时间</dt><dd>{formatTrajectoryTime(timestamp)}</dd></div>
        {(role === "assistant" || role === "streaming_assistant" || role === "thinking" || role === "streaming_thinking") && (
          <div><dt>调用模型</dt><dd>{modelTrace?.model ?? modelName}</dd></div>
        )}
        <div><dt>事件状态</dt><dd>{primaryTrace ? formatTrajectoryStatus(primaryTrace.status) : role.startsWith("streaming_") ? "执行中" : "已记录"}</dd></div>
        {primaryTrace && <div><dt>开始时间</dt><dd>{formatTrajectoryTime(primaryTrace.startedAt)}</dd></div>}
        {primaryTrace && <div><dt>结束时间</dt><dd>{formatTrajectoryTime(primaryTrace.endedAt)}</dd></div>}
        {primaryTrace && <div><dt>执行耗时</dt><dd>{formatTrajectoryDuration(primaryTrace.durationMs)}</dd></div>}
        {thinkingTrace && modelTrace && <div><dt>模型总耗时</dt><dd>{formatTrajectoryDuration(modelTrace.durationMs)}</dd></div>}
        {modelTrace?.stopReason && <div><dt>停止原因</dt><dd>{modelTrace.stopReason}</dd></div>}
        {modelTrace?.usage && <div><dt>Token 用量</dt><dd>输入 {formatTokens(modelTrace.usage.input)} · 输出 {formatTokens(modelTrace.usage.output)} · 缓存读取 {formatTokens(modelTrace.usage.cacheRead)}</dd></div>}
      </dl>
      {toolCalls.length > 0 && (
        <section className="trajectory-execution-calls">
          <h4>工具调用</h4>
          {toolCalls.map((tool, index) => (
            (() => {
              const toolId = typeof tool.id === "string" ? tool.id : undefined;
              const trace = matchingTraces.find((candidate) => candidate.category === "tool" && candidate.toolCallId === toolId);
              return <div className="trajectory-execution-call" key={toolId ?? index}>
              <div><strong>{typeof tool.name === "string" ? tool.name : "tool"}</strong><span>{trace ? formatTrajectoryStatus(trace.status) : tool.status === "error" ? "失败" : tool.status === "running" || tool.status === "pending" ? "执行中" : "已完成"}</span></div>
              <dl>
                <div><dt>调用 ID</dt><dd>{toolId ?? "—"}</dd></div>
                <div><dt>开始时间</dt><dd>{formatTrajectoryTime(trace?.startedAt)}</dd></div>
                <div><dt>结束时间</dt><dd>{formatTrajectoryTime(trace?.endedAt)}</dd></div>
                <div><dt>执行耗时</dt><dd>{formatTrajectoryDuration(trace?.durationMs)}</dd></div>
                {trace?.permissionDecision && <div><dt>权限检查</dt><dd>{trace.permissionDecision === "allowed" ? "已允许" : "已拒绝"}</dd></div>}
                {trace?.permissionReason && <div><dt>权限说明</dt><dd>{trace.permissionReason}</dd></div>}
              </dl>
            </div>;
            })()
          ))}
        </section>
      )}
      {toolCalls.length === 0 && role === "active_tool_call" && (
        <section className="trajectory-execution-calls">
          <h4>工具调用</h4>
          <div className="trajectory-execution-call">
            <div><strong>{typeof data.name === "string" ? data.name : "tool"}</strong><span>执行中</span></div>
            <dl>
              <div><dt>调用 ID</dt><dd>{typeof data.id === "string" ? data.id : "—"}</dd></div>
              <div><dt>执行时间</dt><dd>正在执行</dd></div>
            </dl>
          </div>
        </section>
      )}
      {isContextEntry && (
        <p className="trajectory-execution-note">该项在第一条用户消息之前进入模型上下文；System 仅展示基础系统指令，工具、Skill 和项目指令分别在独立条目中展示。</p>
      )}
      {!isContextEntry && matchingTraces.length === 0 && !thinkingTrace && (
        <p className="trajectory-execution-note">该记录来自旧会话，或当前调用尚未同步，因此暂无精确开始、结束和耗时数据。</p>
      )}
    </div>
  );
}

function TrajectoryFullDetails({ entry }: { entry: SelectedTrajectoryEntry }) {
  const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
  const type = typeof data.type === "string" ? data.type : "";

  if (type === "context_system") {
    return <pre className="trajectory-detail-text">{typeof data.content === "string" ? data.content : ""}</pre>;
  }

  if (type === "context_tools" || type === "context_skills") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    const suffix = type === "context_tools" ? "工具" : "Skill";
    return (
      <div className="trajectory-detail-resources">
        {items.map((item, index) => (
          <section key={`${String(item.name ?? suffix)}-${index}`} className="trajectory-detail-resource">
            <strong>{String(item.name ?? "未命名")} {suffix}</strong>
            <p>{typeof item.description === "string" && item.description ? item.description : "暂无描述"}</p>
            {type === "context_skills" && typeof item.filePath === "string" && <span>{item.filePath}</span>}
          </section>
        ))}
        {items.length === 0 && <p className="trajectory-detail-empty">暂无内容</p>}
      </div>
    );
  }

  if (type === "context_instructions") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    return (
      <div className="trajectory-detail-resources">
        {items.map((item, index) => {
          const path = typeof item.path === "string" ? item.path : "项目指令";
          return (
            <section key={`${path}-${index}`} className="trajectory-detail-resource trajectory-detail-instruction">
              <strong>{path.split(/[\\/]/).pop() ?? path}</strong>
              <span>{path}</span>
              <pre>{typeof item.content === "string" ? item.content : ""}</pre>
            </section>
          );
        })}
        {items.length === 0 && <p className="trajectory-detail-empty">暂无内容</p>}
      </div>
    );
  }

  return <pre className="trajectory-detail-json">{JSON.stringify(entry.data, null, 2)}</pre>;
}

/** Compact token count formatting, matching the TUI footer (e.g. 7.8k, 313k, 1.2M). */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

async function loadBackgroundImage(path: string): Promise<string> {
  const bytes = await readFile(path);
  const sourceUrl = URL.createObjectURL(new Blob([bytes]));

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("无法读取所选图片"));
      element.src = sourceUrl;
    });

    const maxWidth = 1920;
    const maxHeight = 1200;
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理所选图片");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

/** Animate a number toward its target value (rolling/ticking counter effect). */
function useRollingNumber(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;
    const to = target;
    if (from === to) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const current = from + (to - from) * eased;
      displayRef.current = current;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return display;
}

/** Session usage and context stats displayed above the composer. */
function SessionStats({ agent }: { agent: AgentState }) {
  const su = agent.sessionUsage;
  const cu = agent.contextUsage;
  const live = agent.liveUsage;

  // Completed session totals + the in-flight turn's live usage.
  // For providers that only report usage at the end of the stream, estimate the
  // output tokens from the streamed text so the counter rolls live as tokens appear.
  const estimatedLiveOutput = Math.round(agent.streamingText.length / 4);
  const liveOutput = Math.max(live?.output ?? 0, estimatedLiveOutput);
  const totalInput = (su?.input ?? 0) + (live?.input ?? 0);
  const totalCacheRead = (su?.cacheRead ?? 0) + (live?.cacheRead ?? 0);
  const totalCacheWrite = (su?.cacheWrite ?? 0) + (live?.cacheWrite ?? 0);
  // ↓ shows output since last user input, not cumulative session output
  const outputSinceLastUserInput = agent.outputSinceLastUserInput + liveOutput;
  const usedContextTokens = (cu?.tokens ?? 0) + (live?.input ?? 0) + liveOutput;
  const contextWindow = cu?.contextWindow ?? 0;
  const contextPercent = contextWindow > 0 ? (usedContextTokens / contextWindow) * 100 : null;

  // Rolling token counters for ↑↓
  const rollingInput = useRollingNumber(totalInput);
  const rollingOutput = useRollingNumber(outputSinceLastUserInput);

  // Cache hit rate (no "CH" prefix) — shown inline and in the hover breakdown
  const latestPromptTokens = totalInput + totalCacheRead + totalCacheWrite;
  const cacheHitRate = latestPromptTokens > 0 ? (totalCacheRead / latestPromptTokens) * 100 : undefined;
  const hasCache = totalCacheRead > 0 || totalCacheWrite > 0;

  if (!cu && !hasCache && totalInput <= 0 && outputSinceLastUserInput <= 0) return null;

  const itemStyle: CSSProperties = {
    flex: "1 1 0",
    minWidth: 0,
    textAlign: "center",
  };
  const valueStyle: CSSProperties = {
    display: "inline-block",
    minWidth: "5.5ch",
    marginLeft: 5,
    textAlign: "left",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"',
    color: "var(--color-text-secondary)",
    fontWeight: 600,
  };

  return (
    <div
      className="session-stats"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minWidth: 0,
        width: "100%",
        padding: "0 12px 8px",
        color: "var(--color-text-muted)",
        fontSize: 11,
        cursor: "default",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {cu && (
        <>
          <span
            className="session-stat-item"
            tabIndex={0}
            data-tooltip="当前发送给模型的上下文占用，包含系统提示、历史对话、工具结果和当前内容；接近上限时需要压缩上下文。"
            style={itemStyle}
          >上下文<span style={{ ...valueStyle, minWidth: "19ch" }}>{formatTokens(usedContextTokens)} / {formatTokens(contextWindow)}{contextPercent != null ? ` (${contextPercent.toFixed(1)}%)` : ""}</span></span>
          <span aria-hidden="true" style={{ opacity: 0.35 }}>|</span>
        </>
      )}
      <span
        className="session-stat-item session-stat-cache"
        tabIndex={0}
        data-tooltip="Session 输入中通过模型缓存读取的比例。命中率越高，重复上下文的处理成本通常越低。"
        style={itemStyle}
      >缓存命中率<span style={{ ...valueStyle, color: cacheHitRate != null && cacheHitRate > 90 ? "#34d399" : cacheHitRate != null && cacheHitRate > 70 ? "#f59e0b" : "#818cf8" }}>{cacheHitRate != null ? `${cacheHitRate.toFixed(1)}%` : "—"}</span></span>
      <span aria-hidden="true" style={{ opacity: 0.35 }}>|</span>
      <span
        className="session-stat-item session-stat-input"
        tabIndex={0}
        data-tooltip="整个 Session 内模型调用产生的累计未缓存输入，可能包含系统提示和未命中缓存的历史内容，不等于当前用户消息长度。"
        style={itemStyle}
      >输入 Token<span style={valueStyle}>{formatTokens(Math.round(rollingInput))}</span></span>
      <span aria-hidden="true" style={{ opacity: 0.35 }}>|</span>
      <span
        className="session-stat-item"
        tabIndex={0}
        data-tooltip="从最近一次用户发送消息开始，模型在当前轮生成的累计输出 Token。"
        style={itemStyle}
      >输出 Token<span style={valueStyle}>{formatTokens(Math.round(rollingOutput))}</span></span>
    </div>
  );
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  const textExts = [".txt", ".md", ".json", ".xml", ".yaml", ".yml", ".csv", ".toml",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp",
    ".h", ".css", ".html", ".sh", ".bash", ".zsh", ".sql", ".env", ".gitignore",
    ".dockerfile", ".makefile", ".cfg", ".ini", ".conf", ".log", ".diff", ".patch"];
  const name = file.name.toLowerCase();
  return textExts.some((ext) => name.endsWith(ext));
}

type FileTypeIcon = {
  icon: typeof FileText;
  color: string;
  label: string;
};

function getFileTypeIcon(name: string, mimeType: string): FileTypeIcon {
  const lower = name.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    return { icon: FileText, color: "#ef4444", label: "PDF" };
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return { icon: FileText, color: "#818cf8", label: "MD" };
  }
  if (lower.endsWith(".json")) {
    return { icon: FileJson, color: "#f59e0b", label: "JSON" };
  }
  if (/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(lower)) {
    return { icon: FileCode, color: "#eab308", label: "JS/TS" };
  }
  if (/\.(py|rb|go|rs|java|c|cpp|h|swift|kt)$/.test(lower)) {
    return { icon: FileCode, color: "#22c55e", label: "Code" };
  }
  if (/\.(html|css|scss|less|svg)$/.test(lower)) {
    return { icon: FileCode, color: "#06b6d4", label: "Web" };
  }
  if (/\.(xml|yaml|yml|toml|ini|cfg|conf)$/.test(lower)) {
    return { icon: FileType, color: "#a78bfa", label: "Config" };
  }
  if (/\.(txt|log|diff|patch|sh|bash|zsh)$/.test(lower)) {
    return { icon: FileText, color: "#9ca3af", label: "Text" };
  }
  if (mimeType.startsWith("image/")) {
    return { icon: Image, color: "#ec4899", label: "Image" };
  }
  return { icon: File, color: "#6b7280", label: "File" };
}

function fileToAttachment(file: File): Promise<PendingAttachment> {
  const isImage = isImageFile(file);
  const isText = !isImage && isTextFile(file);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      let data: string;
      if (isImage) {
        // Strip the data URL prefix to get pure base64
        data = result.includes(",") ? result.split(",")[1] : result;
      } else if (isText) {
        // Plain text content (readAsText gives us raw text)
        data = result;
      } else {
        // Binary non-image: store as base64
        data = result.includes(",") ? result.split(",")[1] : result;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data,
        isImage,
        isText,
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      });
    };
    reader.onerror = reject;
    if (isText) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  });
}

/** Guess MIME type from file extension (for Tauri drag-drop paths which lack MIME) */
function guessMimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    pdf: "application/pdf",
    json: "application/json", xml: "application/xml",
    txt: "text/plain", md: "text/markdown", csv: "text/csv",
    js: "text/javascript", ts: "text/typescript", jsx: "text/javascript", tsx: "text/typescript",
    py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
    html: "text/html", css: "text/css", sh: "text/x-shellscript",
  };
  return map[ext] || "application/octet-stream";
}

/** Convert a Tauri file path to a PendingAttachment by reading its content via fs plugin */
async function pathToAttachment(filePath: string): Promise<PendingAttachment> {
  const name = filePath.split("/").pop() || filePath;
  const mimeType = guessMimeType(name);
  const isImage = mimeType.startsWith("image/");
  const textMimes = ["text/", "application/json", "application/xml"];
  const isText = !isImage && (textMimes.some((t) => mimeType.startsWith(t)) || isTextFile({ name, type: mimeType } as File));

  let data: string;
  let previewUrl: string | undefined;

  if (isText) {
    data = await readTextFile(filePath);
  } else {
    const bytes = await readFile(filePath);
    // Convert Uint8Array to base64
    const blob = new Blob([bytes]);
    data = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.includes(",") ? result.split(",")[1] : result);
      };
      reader.readAsDataURL(blob);
    });
    if (isImage) {
      previewUrl = URL.createObjectURL(blob);
    }
  }

  return { id: crypto.randomUUID(), name, mimeType, data, isImage, isText, previewUrl };
}

function buildConversationPairs(messages: AgentState["messages"]): ConversationPair[] {
  const pairs: ConversationPair[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      pairs.push({
        userMessageId: message.id,
        userText: message.content,
        assistantText: "",
      });
    } else if (message.role === "assistant") {
      const currentPair = pairs[pairs.length - 1];
      if (currentPair && !currentPair.assistantText) {
        currentPair.assistantText = message.content;
      }
    }
  }
  return pairs;
}

function loadProjectNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_NAMES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function loadStringRecord(key: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

function loadHiddenAgents(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_AGENTS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** File path an edit/write tool call targeted, accepting either argument spelling. */
function toolEditedPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.path === "string") return record.path;
  if (typeof record.file_path === "string") return record.file_path;
  return "";
}

function agentDisplayName(agent: AgentState, agentNames: Record<string, string> = {}): string {
  if (agentNames[agent.id]) return agentNames[agent.id];
  if (agent.name) return agent.name;
  if (!agent.parentAgentId) return "Nova";
  return agent.model ?? "Agent";
}

function agentSubtitle(agent: AgentState): string {
  if (!agent.parentAgentId) {
    return "Main coordinator";
  }
  if (agent.status === "streaming") return "Working on delegated task";
  if (agent.status === "starting") return "Starting delegated agent";
  if (agent.status === "error") return "Delegated task needs attention";
  return agent.cwd;
}

interface AgentTreeNodeProps {
  agent: AgentState;
  childrenByParent: Map<string, AgentState[]>;
  agentsById: Map<string, AgentState>;
  activeId: string | null;
  onSelect: (id: string) => void;
  agentNames: Record<string, string>;
  onEdit: (agent: AgentState) => void;
  onHide: (agent: AgentState) => void;
  depth?: number;
}

const AgentTreeNode = memo(function AgentTreeNode({
  agent,
  childrenByParent,
  agentsById,
  activeId,
  onSelect,
  agentNames,
  onEdit,
  onHide,
  depth = 0,
}: AgentTreeNodeProps) {
  const children = childrenByParent.get(agent.id) ?? [];
  const [childrenExpanded, setChildrenExpanded] = useState(false);
  const isActive = agent.id === activeId;
  const isChild = depth > 0;

  return (
    <div className={`agent-tree-node ${depth > 0 ? "agent-tree-child" : ""} ${isActive ? "agent-tree-node-active" : ""}`}>
      <button
        onClick={() => onSelect(agent.id)}
        className={`agent-card ${isChild ? "agent-card-child" : ""} ${isActive ? "agent-card-active" : ""}`}
      >
        <span className="agent-text">
          <span className="agent-name">{agentDisplayName(agent, agentNames)}</span>
          {!isChild && (
            <span className="agent-sub" title={agent.cwd}>
              {agentSubtitle(agent)}
            </span>
          )}
          {agent.worktree && (
            <span
              className={`agent-worktree-badge ${agent.worktree.state !== "active" ? "agent-worktree-badge-resolved" : ""}`}
              title={`${agent.worktree.branch}\n${agent.worktree.path}`}
            >
              <GitBranch size={10} />
              {agent.worktree.branch.replace(/^nova\//, "")}
            </span>
          )}
        </span>
        <span
          role="button"
          tabIndex={0}
          className="agent-action"
          title="Rename agent"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(agent);
          }}
        >
          <Pencil size={12} />
        </span>
        {isChild && agent.status === "streaming" && (
          <span
            role="button"
            tabIndex={0}
            className="agent-action"
            title="Cancel delegated task"
            onClick={(event) => {
              event.stopPropagation();
              void cancelAgent(agent.id, "cancelled from parent task");
            }}
          >
            <Square size={12} />
          </span>
        )}
        {isChild && (agent.status === "error" || agent.status === "stopped") && (
          <span
            role="button"
            tabIndex={0}
            className="agent-action"
            title="Retry delegated task"
            onClick={(event) => {
              event.stopPropagation();
              void retryAgent(agent.id);
            }}
          >
            <RotateCcw size={12} />
          </span>
        )}
        <span
          role="button"
          tabIndex={0}
          className="agent-action"
          title="Hide agent"
          onClick={(event) => {
            event.stopPropagation();
            onHide(agent);
          }}
        >
          <EyeOff size={13} />
        </span>
        {children.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className="agent-expand"
            title={childrenExpanded ? "Collapse child agents" : "Expand child agents"}
            onClick={(event) => {
              event.stopPropagation();
              setChildrenExpanded((expanded) => !expanded);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setChildrenExpanded((expanded) => !expanded);
              }
            }}
          >
            {childrenExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </button>

      {childrenExpanded && children.length > 0 && (
        <div className="agent-children">
          {children.map((child) => (
            <AgentTreeNode
              key={child.id}
              agent={child}
              childrenByParent={childrenByParent}
              agentsById={agentsById}
              activeId={activeId}
              onSelect={onSelect}
              agentNames={agentNames}
              onEdit={onEdit}
              onHide={onHide}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface ReviewFileEntry {
  path: string;
  kind: TurnFileChange["kind"];
  created?: boolean;
  additions: number;
  deletions: number;
  turns: { patches: string[]; additions: number; deletions: number }[];
}

interface BatchTaskPanelProps {
  sessionId: string;
  onTemporaryAsk: (question: string, onDelta?: (text: string) => void) => Promise<string>;
  onCollapse: () => void;
  mode: "review" | "temporary" | "agents";
  reviewFiles: ReviewFileEntry[];
  expandedReviewFiles: Set<string>;
  onToggleReviewFile: (path: string) => void;
  childAgents: AgentState[];
  agentNames: Record<string, string>;
  onSelectAgent: (agentId: string) => void;
  /** Preformatted warning about files edited by more than one agent; empty when none. */
  crossAgentWarning: string;
  /** Reverts every change the agent made; absent when reverting is unavailable. */
  onRevertAll?: () => Promise<void>;
  revertAllBusy?: boolean;
}

interface TemporaryChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  streaming?: boolean;
}

/**
 * Conversation-side summary grouping the current agent's directly delegated
 * tasks by batch, with live status and controls for each child agent.
 */
const BatchTaskPanel = memo(function BatchTaskPanel({
  sessionId,
  onTemporaryAsk,
  onCollapse,
  mode,
  reviewFiles,
  expandedReviewFiles,
  onToggleReviewFile,
  childAgents,
  agentNames,
  onSelectAgent,
  crossAgentWarning,
  onRevertAll,
  revertAllBusy,
}: BatchTaskPanelProps) {
  const [turnIndexes, setTurnIndexes] = useState<Record<string, number>>({});
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const [temporaryInput, setTemporaryInput] = useState("");
  const [temporaryPending, setTemporaryPending] = useState(false);
  const [temporaryError, setTemporaryError] = useState<string | null>(null);
  const [temporaryEntries, setTemporaryEntries] = useState<TemporaryChatEntry[]>([]);

  useEffect(() => {
    // Remove data written by older builds; side questions are intentionally
    // scoped to this renderer lifetime only.
    localStorage.removeItem(`nova-temporary-chat:${sessionId}`);
    setTemporaryEntries([]);
    setTemporaryInput("");
    setTemporaryError(null);
  }, [sessionId]);

  const submitTemporaryQuestion = async () => {
    const question = temporaryInput.trim();
    if (!question || temporaryPending) return;
    const userEntry: TemporaryChatEntry = { id: crypto.randomUUID(), role: "user", content: question, createdAt: Date.now() };
    const answerEntryId = crypto.randomUUID();
    setTemporaryEntries([...temporaryEntries, userEntry, { id: answerEntryId, role: "assistant", content: "", createdAt: Date.now(), streaming: true }]);
    setTemporaryInput("");
    setTemporaryPending(true);
    setTemporaryError(null);
    try {
      const answer = await onTemporaryAsk(question, (text) => {
        setTemporaryEntries((current) => current.map((entry) => entry.id === answerEntryId ? { ...entry, content: text } : entry));
      });
      setTemporaryEntries((current) => current.map((entry) => entry.id === answerEntryId ? { ...entry, content: answer || entry.content, streaming: false } : entry));
    } catch (askError) {
      setTemporaryEntries((current) => current.filter((entry) => entry.id !== answerEntryId));
      setTemporaryError(askError instanceof Error ? askError.message : String(askError));
    } finally {
      setTemporaryPending(false);
    }
  };

  return (
    <section className="task-panel agent-workbench" aria-label={mode === "review" ? "文件审查" : mode === "agents" ? "子 Agent" : "临时提问"}>
      <button
        type="button"
        className="task-panel-header"
        onClick={onCollapse}
        aria-label={mode === "review" ? "收起文件审查" : mode === "agents" ? "收起子 Agent" : "收起临时提问"}
      >
        <span className="task-panel-heading">
          {mode === "review" ? <FileCode size={15} /> : mode === "agents" ? <Bot size={15} /> : <MessageCircle size={15} />}
          {mode === "review" ? "文件审查" : mode === "agents" ? "子 Agent" : "临时提问"}
        </span>
        {mode === "review" && reviewFiles.length > 0 && <span className="task-panel-count">{reviewFiles.length}</span>}
        {mode === "agents" && childAgents.length > 0 && <span className="task-panel-count">{childAgents.length}</span>}
        <ChevronRight size={13} />
      </button>
      <div className="task-panel-body">
          {mode === "review" ? (
            <div className="agent-file-review">
              {crossAgentWarning && (
                <div className="agent-file-review-conflict" role="status">
                  <strong>多个 Agent 改过同一批文件</strong>
                  <span>
                    这些文件的写入是后来者覆盖先前者。撤回某一方的改动前请先确认当前内容。
                  </span>
                  <pre>{crossAgentWarning}</pre>
                </div>
              )}
              {reviewFiles.length > 0 ? (
                <section className="agent-file-review-turn">
                  <header className="agent-file-review-turn-header">
                    <span>会话累计 · {reviewFiles.length} 个文件</span>
                    <span className="agent-file-review-turn-actions">
                      <span className="turn-file-change-stats"><b>+{reviewFiles.reduce((total, file) => total + file.additions, 0)}</b><i>-{reviewFiles.reduce((total, file) => total + file.deletions, 0)}</i></span>
                      {onRevertAll && (
                        <button
                          type="button"
                          className="turn-file-change-revert"
                          disabled={revertAllBusy}
                          onClick={() => (confirmRevertAll ? void onRevertAll() : setConfirmRevertAll(true))}
                          onBlur={() => setConfirmRevertAll(false)}
                        >
                          <RotateCcw size={12} />
                          {revertAllBusy ? "撤回中…" : confirmRevertAll ? "确认撤回全部？" : "撤回该 Agent 全部改动"}
                        </button>
                      )}
                    </span>
                  </header>
                  <div className="agent-file-review-entries">
                    {reviewFiles.map((file) => {
                      const badge = fileBadge(file.path);
                      const slashIndex = file.path.lastIndexOf("/");
                      const expanded = expandedReviewFiles.has(file.path);
                      return (
                        <div key={file.path} className="agent-file-review-entry">
                          <button
                            type="button"
                            className={`agent-file-review-file${expanded ? " agent-file-review-file-active" : ""}`}
                            title={file.path}
                            onClick={() => {
                              if (expanded) {
                                setTurnIndexes((current) => {
                                  if (!(file.path in current)) return current;
                                  const next = { ...current };
                                  delete next[file.path];
                                  return next;
                                });
                              }
                              onToggleReviewFile(file.path);
                            }}
                            aria-expanded={expanded}
                          >
                            <ChevronRight size={11} className={`agent-file-review-chevron${expanded ? " agent-file-review-chevron-open" : ""}`} />
                            <span className={`agent-file-review-badge agent-file-review-badge-${badge.tone}`}>{badge.label}</span>
                            <span className="agent-file-review-file-path">
                              <span className="agent-file-review-file-dir">{slashIndex >= 0 ? file.path.slice(0, slashIndex + 1) : ""}</span>
                              <strong>{slashIndex >= 0 ? file.path.slice(slashIndex + 1) : file.path}</strong>
                            </span>
                            <span className="turn-file-change-stats"><b>+{file.additions}</b><i>-{file.deletions}</i></span>
                          </button>
                          {expanded && (() => {
                            const turns = file.turns;
                            if (turns.length === 0 || (turns[0]?.patches.length ?? 0) === 0) return <p>此文件没有可展示的 Diff</p>;
                            if (turns.length === 1) return <FileDiff patches={turns[0].patches} path={file.path} />;
                            const index = Math.min(turnIndexes[file.path] ?? turns.length - 1, turns.length - 1);
                            const turn = turns[index];
                            return (
                              <>
                                <div className="agent-file-review-diff-nav">
                                  <button
                                    type="button"
                                    disabled={index <= 0}
                                    onClick={() => setTurnIndexes((current) => ({ ...current, [file.path]: index - 1 }))}
                                  >
                                    <ChevronLeft size={11} />上一轮
                                  </button>
                                  <span className="turn-file-change-stats"><b>+{turn.additions}</b><i>-{turn.deletions}</i></span>
                                  <button
                                    type="button"
                                    disabled={index >= turns.length - 1}
                                    onClick={() => setTurnIndexes((current) => ({ ...current, [file.path]: index + 1 }))}
                                  >
                                    下一轮<ChevronRight size={11} />
                                  </button>
                                </div>
                                <FileDiff patches={turn.patches} path={file.path} />
                              </>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : <p className="agent-workbench-empty">点击助手回复下方的文件即可审查 Diff</p>}
            </div>
          ) : mode === "agents" ? (
            <div className="agent-workbench-content agent-workbench-agent-overview">
              <section className="agent-workbench-section">
                <h4>当前子 Agent</h4>
                <div className="agent-workbench-agents">
                  {childAgents.length > 0 ? childAgents.map((agent) => {
                    const taskStatus = agent.lifecycle?.taskStatus;
                    const running = taskStatus
                      ? taskStatus === "queued" || taskStatus === "starting" || taskStatus === "running" || taskStatus === "waiting"
                      : agent.status === "starting" || agent.status === "streaming";
                    const failed = taskStatus
                      ? taskStatus === "error" || taskStatus === "stopped" || taskStatus === "orphaned"
                      : agent.status === "error";
                    const statusLabel = running ? "进行中" : failed ? "异常" : taskStatus === "completed" ? "已完成" : "已结束";
                    return (
                      <button key={agent.id} type="button" className="agent-workbench-agent" onClick={() => onSelectAgent(agent.id)} title={agent.id}>
                        <img src={agentAvatarSrc(agent.avatarId)} alt="" />
                        <span className="agent-workbench-agent-name">{agentDisplayName(agent, agentNames)}</span>
                        <span className={`agent-workbench-agent-status ${running ? "is-running" : failed ? "is-error" : "is-completed"}`}>
                          <i />{statusLabel}
                        </span>
                      </button>
                    );
                  }) : <p className="agent-workbench-empty">当前会话暂无子 Agent</p>}
                </div>
              </section>
            </div>
          ) : (
            <div className="temporary-chat">
              <div className="temporary-chat-note">复用当前主 Agent 上下文 · 不写入主会话</div>
              <div className="temporary-chat-messages">
                {temporaryEntries.length > 0 ? temporaryEntries.map((entry) => (
                  <div key={entry.id} className={`temporary-chat-message temporary-chat-message-${entry.role}`}>
                    <span>{entry.role === "user" ? "你" : "Nova"}</span>
                    <div>{entry.role === "assistant" ? (entry.streaming
                      ? <div className="temporary-chat-streaming-text">{entry.content}</div>
                      : <Markdown content={entry.content} highlightCode={false} />)
                      : entry.content}</div>
                  </div>
                )) : <p className="agent-workbench-empty">在这里提问，不会影响主 Agent 的上下文</p>}
                {temporaryPending && !temporaryEntries.some((entry) => entry.streaming && entry.content) && <div className="temporary-chat-thinking"><LoaderCircle size={13} className="tool-spin" />正在旁路思考…</div>}
                {temporaryError && <div className="temporary-chat-error">{temporaryError}</div>}
              </div>
              <div className="temporary-chat-composer">
                <textarea value={temporaryInput} onChange={(event) => setTemporaryInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitTemporaryQuestion(); } }} placeholder="临时问一下…" rows={2} disabled={temporaryPending} />
                <button type="button" onClick={() => void submitTemporaryQuestion()} disabled={!temporaryInput.trim() || temporaryPending} aria-label="发送临时提问"><ArrowUp size={14} /></button>
              </div>
            </div>
          )}
      </div>
    </section>
  );
});

interface WorktreeReviewPanelProps {
  agent: AgentState;
  onCollapse: () => void;
  /** Called after the worktree is merged or discarded so the shell can refresh. */
  onResolved: (message: string) => void;
}

/**
 * Reviews the agent's isolated checkout: what it changed, then accept (squash-merge into the
 * project) or reject (discard). Conflicting merges are reported, never forced.
 */
const WorktreeReviewPanel = memo(function WorktreeReviewPanel({
  agent,
  onCollapse,
  onResolved,
}: WorktreeReviewPanelProps) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const worktree = agent.worktree;
  const resolved = !worktree || worktree.state !== "active";

  useEffect(() => {
    if (!worktree || resolved) return;
    let cancelled = false;
    setError(null);
    void getWorktreeStatus(agent.id)
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setSelectedPath((current) =>
          current && next.files.some((file) => file.path === current) ? current : (next.files[0]?.path ?? null),
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, refreshToken, resolved, worktree]);

  useEffect(() => {
    if (!selectedPath || resolved) {
      setDiff("");
      return;
    }
    let cancelled = false;
    void getWorktreeDiff(agent.id, selectedPath)
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, selectedPath, refreshToken, resolved]);

  const handleAccept = async () => {
    setBusy("accept");
    setError(null);
    setConflicts([]);
    try {
      const outcome = await acceptWorktree(agent.id);
      if (outcome.merged) onResolved(outcome.message);
      else {
        setConflicts(outcome.conflicts);
        setError(outcome.message);
        setRefreshToken((token) => token + 1);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy("reject");
    setError(null);
    try {
      await rejectWorktree(agent.id);
      onResolved("已丢弃该 Agent 的改动");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
      setConfirmingReject(false);
    }
  };

  const totalAdditions = status?.files.reduce((total, file) => total + file.additions, 0) ?? 0;
  const totalDeletions = status?.files.reduce((total, file) => total + file.deletions, 0) ?? 0;

  return (
    <section className="task-panel agent-workbench" aria-label="Worktree 审查">
      <button type="button" className="task-panel-header" onClick={onCollapse} aria-label="收起 Worktree 审查">
        <span className="task-panel-heading">
          <GitBranch size={15} />
          Worktree 审查
        </span>
        {status && status.files.length > 0 && <span className="task-panel-count">{status.files.length}</span>}
        <ChevronRight size={13} />
      </button>
      <div className="task-panel-body">
        <div className="agent-file-review">
          <section className="agent-file-review-turn">
            <header className="agent-file-review-turn-header">
              <span>{worktree?.branch ?? "worktree"}</span>
              {status && (
                <span className="turn-file-change-stats">
                  <b>+{totalAdditions}</b>
                  <i>-{totalDeletions}</i>
                </span>
              )}
            </header>
            <div style={{ padding: "4px 10px 8px", fontSize: 10.5, opacity: 0.75, wordBreak: "break-all" }}>
              {worktree ? `${worktree.path} · 基于 ${worktree.baseBranch ?? worktree.baseCommit.slice(0, 8)}` : ""}
            </div>
          </section>

          {resolved && worktree && (
            <p style={{ padding: "0 10px", fontSize: 11.5 }}>
              {worktree.state === "merged"
                ? "该 worktree 已合并进项目。"
                : worktree.state === "missing"
                  ? "该 worktree 的目录已不存在。"
                  : "该 worktree 已被丢弃。"}
            </p>
          )}

          {!resolved && status?.dirty && (
            <p style={{ padding: "0 10px", fontSize: 11 }}>
              该 Agent 还有未提交的改动，接受时会先自动提交。
            </p>
          )}

          {!resolved && status && status.files.length === 0 && (
            <p style={{ padding: "0 10px", fontSize: 11.5 }}>该 Agent 还没有改动任何文件。</p>
          )}

          {!resolved && (
            <div className="agent-file-review-entries">
              {status?.files.map((file) => {
                const slashIndex = file.path.lastIndexOf("/");
                const expanded = file.path === selectedPath;
                return (
                  <div key={file.path} className="agent-file-review-entry">
                    <button
                      type="button"
                      className={`agent-file-review-file${expanded ? " agent-file-review-file-active" : ""}`}
                      title={file.path}
                      onClick={() => setSelectedPath(expanded ? null : file.path)}
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        size={11}
                        className={`agent-file-review-chevron${expanded ? " agent-file-review-chevron-open" : ""}`}
                      />
                      <span className="agent-file-review-file-path">
                        <span className="agent-file-review-file-dir">
                          {slashIndex >= 0 ? file.path.slice(0, slashIndex + 1) : ""}
                        </span>
                        <strong>{slashIndex >= 0 ? file.path.slice(slashIndex + 1) : file.path}</strong>
                      </span>
                      <span className="turn-file-change-stats">
                        <b>+{file.additions}</b>
                        <i>-{file.deletions}</i>
                      </span>
                    </button>
                    {expanded && diff.trim().length > 0 && <FileDiff patches={[diff]} path={file.path} />}
                  </div>
                );
              })}
            </div>
          )}

          {error && (
            <div style={{ margin: "8px 10px", padding: "8px 10px", borderRadius: 8, background: "var(--bg-tertiary, rgba(0,0,0,0.2))", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
              {error}
              {conflicts.length > 0 && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {conflicts.map((path) => (
                    <li key={path} style={{ fontFamily: "monospace" }}>{path}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!resolved && (
            <div style={{ display: "flex", gap: 8, padding: "10px" }}>
              <button
                type="button"
                className="project-open-button"
                disabled={busy !== null}
                onClick={() => (confirmingReject ? void handleReject() : setConfirmingReject(true))}
                onBlur={() => setConfirmingReject(false)}
              >
                <Trash2 size={13} />
                {busy === "reject" ? "丢弃中…" : confirmingReject ? "确认丢弃？" : "丢弃改动"}
              </button>
              <button
                type="button"
                className="agent-hide-confirm"
                disabled={busy !== null}
                onClick={() => void handleAccept()}
              >
                <GitMerge size={13} />
                {busy === "accept" ? "合并中…" : "接受并合并"}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
});

export function AppShell() {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const addAgent = useAgentStore((s) => s.addAgent);
  const syncAgents = useAgentStore((s) => s.syncAgents);
  const addUserMessage = useAgentStore((s) => s.addUserMessage);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const availableModels = useAgentStore((s) => s.availableModels);
  const refreshAgentTasks = useAgentStore((s) => s.refreshAgentTasks);

  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);
  const worktreeEnabled = useSettingsStore((s) => s.worktreeEnabled);
  const setWorktreeEnabled = useSettingsStore((s) => s.setWorktreeEnabled);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const customBgUrl = useUiStore((s) => s.customBgUrl);
  const setCustomBgUrl = useUiStore((s) => s.setCustomBgUrl);
  const backgroundBlur = useUiStore((s) => s.backgroundBlur);
  const setBackgroundBlur = useUiStore((s) => s.setBackgroundBlur);

  const [input, setInput] = useState("");
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [slashCommandMenuDismissed, setSlashCommandMenuDismissed] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [fileMentionMenuDismissed, setFileMentionMenuDismissed] = useState(false);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [selectedProjectFileIndex, setSelectedProjectFileIndex] = useState(0);
  const [agentWorkbenchOpen, setAgentWorkbenchOpen] = useState(false);
  const [agentWorkbenchMode, setAgentWorkbenchMode] = useState<"review" | "temporary" | "agents" | "worktree">("review");
  const [expandedReviewFiles, setExpandedReviewFiles] = useState<Set<string>>(() => new Set());
  const [reviewPanelWidth, setReviewPanelWidth] = useState(() => readWorkbenchPanelWidth("nova-workbench-width-review", Math.round(window.innerWidth * 0.45)));
  const [temporaryPanelWidth, setTemporaryPanelWidth] = useState(() => readWorkbenchPanelWidth("nova-workbench-width-temporary", Math.round(window.innerWidth * 0.32)));
  const [dockResizing, setDockResizing] = useState(false);
  const dockResizeDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const workbenchPanelWidth = agentWorkbenchMode === "temporary" ? temporaryPanelWidth : reviewPanelWidth;
  const handleDockResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dockResizeDrag.current = { startX: event.clientX, startWidth: workbenchPanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDockResizing(true);
  };
  const handleDockResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dockResizeDrag.current;
    if (!drag) return;
    const maxWidth = Math.max(420, window.innerWidth - 460);
    const nextWidth = Math.min(maxWidth, Math.max(320, drag.startWidth + (drag.startX - event.clientX)));
    if (agentWorkbenchMode === "temporary") setTemporaryPanelWidth(nextWidth);
    else setReviewPanelWidth(nextWidth);
  };
  const handleDockResizeEnd = () => {
    if (!dockResizeDrag.current) return;
    dockResizeDrag.current = null;
    setDockResizing(false);
    localStorage.setItem(agentWorkbenchMode === "temporary" ? "nova-workbench-width-temporary" : "nova-workbench-width-review", String(workbenchPanelWidth));
  };
  const [selectedFileReferences, setSelectedFileReferences] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  // Pull the delegated task/batch snapshot once when the shell mounts.
  useEffect(() => { void refreshAgentTasks(); }, [refreshAgentTasks]);
  useEffect(() => {
    setExpandedReviewFiles(new Set());
    setAgentWorkbenchOpen(false);
  }, [activeId]);
  // Keep ref in sync for cleanup on unmount
  useEffect(() => { attachmentsRef.current = pendingAttachments; }, [pendingAttachments]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [savedInput, setSavedInput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [revertedFileChanges, setRevertedFileChanges] = useState<Set<string>>(() => new Set());
  const [reviewRevertBusy, setReviewRevertBusy] = useState(false);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  // Whether the project staged for the next agent is a git repo (worktrees need one).
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "models" | "activity">("appearance");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [conversationView, setConversationView] = useState<"chat" | "trajectory">("chat");
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [selectedTrajectoryEntry, setSelectedTrajectoryEntry] = useState<SelectedTrajectoryEntry | null>(null);
  const [trajectoryDetailView, setTrajectoryDetailView] = useState<TrajectoryDetailView>("execution");
  const [pendingProjectCwd, setPendingProjectCwd] = useState<string | null>(null);
  const [projectNames, setProjectNames] = useState<Record<string, string>>(loadProjectNames);
  const [agentNames, setAgentNames] = useState<Record<string, string>>(
    () => loadStringRecord(AGENT_NAMES_KEY),
  );
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Set<string>>(loadHiddenAgents);
  const [editingProject, setEditingProject] = useState<{ cwd: string; name: string } | null>(null);
  const [editingAgent, setEditingAgent] = useState<{ id: string; name: string } | null>(null);
  const [hidingAgent, setHidingAgent] = useState<AgentState | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const permissionPickerRef = useRef<HTMLDivElement>(null);
  const worktreePickerRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const lastConversationScrollTopRef = useRef(0);
  const isComposingRef = useRef(false);

  const userHistory = useMemo(() => {
    if (!activeId) return [];
    const agent = agents.find(a => a.id === activeId);
    if (!agent) return [];
    return agent.messages
      .filter(m => m.role === "user")
      .map(m => m.content)
      .reverse();
  }, [activeId, agents]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const hasFiles = pendingAttachments.length > 0;
    const maxHeight = 200;
    if (hasFiles) {
      // Files attached (icons occupy space) → allow growing
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    } else {
      // No files → keep fixed height, never grow; scroll inside instead
      el.style.height = "";
      el.style.overflowY = "auto";
    }
  }, [pendingAttachments.length]);

  // Re-apply textarea height when attachments change (fixed when none, growable when files present)
  useEffect(() => {
    autoResize();
  }, [autoResize, pendingAttachments]);

  const agentNavigationKey = agents.map((agent) => [
    agent.id,
    agent.parentAgentId ?? "",
    agent.cwd,
    agent.name ?? "",
    agent.status,
    agent.messageCount,
  ].join("\u001f")).join("\u001e");
  const { agentsById, visibleAgents, visibleAgentIds, childrenByParent, rootsByProject } = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const isAgentHidden = (agent: AgentState): boolean => {
      if (hiddenAgentIds.has(agent.id)) return true;
      let parentId = agent.parentAgentId;
      while (parentId) {
        if (hiddenAgentIds.has(parentId)) return true;
        parentId = byId.get(parentId)?.parentAgentId ?? null;
      }
      return false;
    };
    const visible = agents.filter(
      (agent) => !isAgentHidden(agent) && !isTemporaryRuntimeProject(agent.cwd),
    );
    const visibleById = new Map(visible.map((agent) => [agent.id, agent]));
    const children = new Map<string, AgentState[]>();
    const roots = new Map<string, AgentState[]>();
    for (const agent of visible) {
      if (agent.parentAgentId && visibleById.has(agent.parentAgentId)) {
        const siblings = children.get(agent.parentAgentId) ?? [];
        siblings.push(agent);
        children.set(agent.parentAgentId, siblings);
      } else {
        // A worktree agent runs in its own checkout but belongs to the project it
        // branched from, so it is grouped by projectCwd rather than cwd.
        const projectKey = agent.projectCwd ?? agent.cwd;
        const projectAgents = roots.get(projectKey) ?? [];
        projectAgents.push(agent);
        roots.set(projectKey, projectAgents);
      }
    }
    return {
      agentsById: byId,
      visibleAgents: visible,
      visibleAgentIds: new Set(visible.map((agent) => agent.id)),
      childrenByParent: children,
      rootsByProject: roots,
    };
  }, [agentNavigationKey, hiddenAgentIds]);
  const activeAgent = activeId && visibleAgentIds.has(activeId)
    ? agents.find((agent) => agent.id === activeId)
    : undefined;
  const currentSubAgents = useMemo(() => {
    if (!activeAgent) return [];
    const descendants = new Set<string>();
    const pending = [activeAgent.id];
    while (pending.length > 0) {
      const parentId = pending.pop();
      if (!parentId) continue;
      for (const agent of agents) {
        if (agent.parentAgentId === parentId && !descendants.has(agent.id)) {
          descendants.add(agent.id);
          pending.push(agent.id);
        }
      }
    }
    return agents.filter((agent) => descendants.has(agent.id));
  }, [activeAgent, agents]);
  const activeDelegatedAgents = useMemo(
    () => currentSubAgents.filter((agent) => agent.status === "starting" || agent.status === "streaming"),
    [currentSubAgents],
  );
  const showAgentWorkbench = Boolean(activeAgent);
  const temporaryStreamHandlers = useRef<Map<string, (text: string) => void>>(new Map());
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onTemporaryAnswerChunk((chunk) => {
      temporaryStreamHandlers.current.get(chunk.requestId)?.(chunk.text);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const handleTemporaryAsk = useCallback(async (question: string, onDelta?: (text: string) => void) => {
    if (!activeAgent) throw new Error("当前没有可复用上下文的主 Agent");
    const requestId = crypto.randomUUID();
    if (onDelta) temporaryStreamHandlers.current.set(requestId, onDelta);
    try {
      return await askTemporary(activeAgent.id, question, requestId);
    } finally {
      temporaryStreamHandlers.current.delete(requestId);
    }
  }, [activeAgent]);
  // Source of truth for the model shown in the picker. Prefer the agent's
  // modelMeta (from get_state, reflects the actual session model) over the
  // possibly-stale `model` field that list_agents reports from spawn time.
  const activeModelId = activeAgent
    ? (activeAgent.modelMeta?.id ?? activeAgent.model)
    : defaultModel;
  const activeModelName = useMemo(
    () => availableModels.find((m) => m.id === activeModelId)?.name ?? activeModelId ?? "Model",
    [availableModels, activeModelId],
  );
  const hasMessages =
    (activeAgent?.messages.length ?? 0) > 0 ||
    (activeAgent?.messageCount ?? 0) > 0;
  // Home is a new conversation inside a concrete project, never a
  // project-less scratchpad. Prefer an explicitly selected/default project,
  // then the most recently used project, and finally the user's home folder.
  const validPendingProjectCwd =
    pendingProjectCwd && !isTemporaryRuntimeProject(pendingProjectCwd) ? pendingProjectCwd : "";
  const validDefaultCwd = defaultCwd && !isTemporaryRuntimeProject(defaultCwd) ? defaultCwd : "";
  const welcomeProjectCwd =
    validPendingProjectCwd || validDefaultCwd || visibleAgents[0]?.cwd || "~";
  const inputProjectCwd = activeAgent?.projectCwd ?? activeAgent?.cwd ?? welcomeProjectCwd;
  const inputProjectName =
    projectNames[inputProjectCwd] ?? inputProjectCwd.split(/[\\/]/).filter(Boolean).pop() ?? inputProjectCwd;
  // The worktree switch applies to the next agent, so it is only offered before one exists.
  const worktreeToggleVisible = !activeAgent;
  useEffect(() => {
    if (!worktreeToggleVisible) return;
    let cancelled = false;
    void checkWorktreeAvailable(welcomeProjectCwd)
      .then((available) => {
        if (!cancelled) setWorktreeAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setWorktreeAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeToggleVisible, welcomeProjectCwd]);
  const agentSenderLabels = useMemo(
    () => Object.fromEntries(agents.map((agent) => [
      agent.id,
      agentNames[agent.id] || (!agent.parentAgentId ? "Main Agent" : agentDisplayName(agent, agentNames)),
    ])),
    [agents, agentNames],
  );
  const availableProjectCwds = Array.from(
    new Set([
      ...rootsByProject.keys(),
      ...(validDefaultCwd ? [validDefaultCwd] : []),
      inputProjectCwd,
    ].filter((cwd) => !isTemporaryRuntimeProject(cwd))),
  );
  const streamingText = activeAgent?.streamingText ?? "";
  const slashCommands = slashCommandMenuDismissed ? [] : matchingSlashCommands(input);
  const fileMention = fileMentionMenuDismissed ? null : findFileMention(input, cursorPosition);
  const conversationPairs = useMemo(
    () => buildConversationPairs(activeAgent?.messages ?? []),
    [activeAgent?.messages],
  );
  const trajectoryRequests = useMemo(() => {
    const groups: Array<{ id: string; messages: AgentState["messages"] }> = [];
    for (const message of activeAgent?.messages ?? []) {
      if (message.role === "user" || groups.length === 0) {
        groups.push({ id: message.id, messages: [message] });
      } else {
        groups[groups.length - 1].messages.push(message);
      }
    }
    return groups;
  }, [activeAgent?.messages]);
  const trajectoryContextEntries = useMemo(() => {
    const snapshot = activeAgent?.contextSnapshot;
    if (!snapshot) return [];
    return [
      {
        id: "context-system",
        role: "SYSTEM",
        className: "system",
        preview: snapshot.systemPrompt,
        data: { type: "context_system", content: snapshot.systemPrompt },
      },
      {
        id: "context-tools",
        role: "TOOLS",
        className: "tool-definition",
        preview: snapshot.tools.length > 0
          ? `${snapshot.tools.length} 个 · ${snapshot.tools.map((tool) => tool.name).join(" · ")}`
          : "未启用工具",
        data: { type: "context_tools", items: snapshot.tools },
      },
      {
        id: "context-skills",
        role: "SKILLS",
        className: "skill",
        preview: snapshot.skills.length > 0
          ? `${snapshot.skills.length} 个 · ${snapshot.skills.map((skill) => skill.name).join(" · ")}`
          : "未加载 Skill",
        data: { type: "context_skills", items: snapshot.skills },
      },
      {
        id: "context-instructions",
        role: "INSTRUCTIONS",
        className: "instruction",
        preview: snapshot.contextFiles.length > 0
          ? `${snapshot.contextFiles.length} 个 · ${snapshot.contextFiles.map((file) => file.path.split(/[\\/]/).pop() ?? file.path).join(" · ")}`
          : "未加载项目指令",
        data: { type: "context_instructions", items: snapshot.contextFiles },
      },
    ];
  }, [activeAgent?.contextSnapshot]);
  const chatMessages = useMemo(() => {
    const grouped: AgentState["messages"] = [];
    for (const message of activeAgent?.messages ?? []) {
      if (message.role === "agent_batch") continue;
      const previous = grouped[grouped.length - 1];
      if (message.role === "tool" && previous?.role === "tool") {
        grouped[grouped.length - 1] = {
          ...previous,
          toolCalls: [...(previous.toolCalls ?? []), ...(message.toolCalls ?? [])],
        };
      } else {
        grouped.push(message);
      }
    }
    return grouped;
  }, [activeAgent?.messages]);
  const actionableAssistantMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let lastAssistantId: string | null = null;
    for (const message of chatMessages) {
      if (message.role === "user") {
        if (lastAssistantId) ids.add(lastAssistantId);
        lastAssistantId = null;
      } else if (message.role === "assistant" && message.content.trim()) {
        lastAssistantId = message.id;
      }
    }
    if (lastAssistantId && activeAgent?.status !== "streaming") ids.add(lastAssistantId);
    return ids;
  }, [chatMessages, activeAgent?.status]);
  const turnFileChangesByAssistantId = useMemo(() => {
    const result = new Map<string, TurnFileChange[]>();
    for (const request of trajectoryRequests) {
      const assistant = [...request.messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
      if (!assistant) continue;
      const byPath = new Map<string, TurnFileChange>();
      for (const message of request.messages) {
        for (const tool of message.toolCalls ?? []) {
          if (tool.status !== "done" || (tool.name !== "edit" && tool.name !== "write")) continue;
          const args = tool.args && typeof tool.args === "object" ? tool.args as Record<string, unknown> : {};
          const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
          if (!path) continue;
          const resultRecord = tool.result && typeof tool.result === "object" ? tool.result as Record<string, unknown> : {};
          const details = resultRecord.details && typeof resultRecord.details === "object" ? resultRecord.details as Record<string, unknown> : {};
          const backendPatch = typeof details.patch === "string" ? details.patch : undefined;
          const patch = backendPatch ?? (tool.name === "write" && typeof args.content === "string"
            ? createNewFileDisplayPatch(path, args.content)
            : undefined);
          const patchLines = patch?.split("\n") ?? [];
          const previous = byPath.get(path);
          const patches = patch ? [...(previous?.patches ?? []), patch] : previous?.patches;
          const additions = tool.name === "write"
            ? (typeof args.content === "string" && args.content ? args.content.split("\n").length : 0)
            : patchLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
          const deletions = tool.name === "edit"
            ? patchLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length
            : 0;
          byPath.set(path, {
            path,
            kind: tool.name,
            additions: (previous?.additions ?? 0) + additions,
            deletions: (previous?.deletions ?? 0) + deletions,
            patches,
            created: previous?.created ?? (details.created === true),
            revertible: (previous?.revertible ?? true) && Boolean(backendPatch),
          });
        }
      }
      const visible = Array.from(byPath.values()).filter((change) => !revertedFileChanges.has(`${assistant.id}:${change.path}`));
      if (visible.length > 0) result.set(assistant.id, visible);
    }
    return result;
  }, [trajectoryRequests, revertedFileChanges]);
  // Session-cumulative view: one entry per file, with its per-turn changes kept in order.
  const cumulativeReviewFiles = useMemo(() => {
    const byPath = new Map<string, {
      path: string;
      kind: TurnFileChange["kind"];
      created?: boolean;
      additions: number;
      deletions: number;
      turns: { patches: string[]; additions: number; deletions: number }[];
    }>();
    for (const [, changes] of turnFileChangesByAssistantId) {
      for (const change of changes) {
        const turn = { patches: change.patches ?? [], additions: change.additions, deletions: change.deletions };
        const existing = byPath.get(change.path);
        if (existing) {
          existing.additions += change.additions;
          existing.deletions += change.deletions;
          existing.turns.push(turn);
        } else {
          byPath.set(change.path, {
            path: change.path,
            kind: change.kind,
            created: change.created,
            additions: change.additions,
            deletions: change.deletions,
            turns: [turn],
          });
        }
      }
    }
    return Array.from(byPath.values());
  }, [turnFileChangesByAssistantId]);

  // Files touched by more than one agent in the same directory: writes are last-one-wins,
  // so the user has to be told before trusting or reverting either side. Agents in their own
  // worktree are skipped — separate checkouts cannot overwrite each other.
  const crossAgentFileWarning = useMemo(() => {
    const byCwd = new Map<string, AgentState[]>();
    for (const agent of agents) {
      if (agent.worktree) continue;
      const group = byCwd.get(agent.cwd) ?? [];
      group.push(agent);
      byCwd.set(agent.cwd, group);
    }
    const ownersByPath = new Map<string, { path: string; agents: string[] }>();
    for (const [cwd, group] of byCwd) {
      if (group.length < 2) continue;
      for (const agent of group) {
        const files = new Set<string>();
        for (const message of agent.messages) {
          for (const tool of message.toolCalls ?? []) {
            if (tool.status !== "done" || (tool.name !== "edit" && tool.name !== "write")) continue;
            const path = toolEditedPath(tool.args);
            if (path) files.add(path);
          }
        }
        for (const path of files) {
          const key = `${cwd}\u001f${path}`;
          const entry = ownersByPath.get(key) ?? { path, agents: [] };
          if (!entry.agents.includes(agent.id)) entry.agents.push(agent.id);
          ownersByPath.set(key, entry);
        }
      }
    }
    const contested = Array.from(ownersByPath.values()).filter((entry) => entry.agents.length > 1);
    if (contested.length === 0) return "";
    return contested
      .map((entry) => `${entry.path}（${entry.agents.map((id) => agentNames[id] || id).join("、")}）`)
      .join("\n");
  }, [agents, agentNames]);

  // Undo everything one agent changed. Turns are reverted newest-first because each turn's
  // patch only applies to the file state the previous turn left behind; a file that changed
  // since is refused by nova and reported rather than silently overwritten.
  const handleRevertAgentChanges = useCallback(async () => {
    if (!activeAgent) return;
    setReviewRevertBusy(true);
    const revertedKeys = new Set<string>();
    const failures: string[] = [];
    const turns = [...turnFileChangesByAssistantId.entries()].reverse();
    for (const [assistantId, changes] of turns) {
      for (const change of changes) {
        if (!change.patches?.length) {
          failures.push(`${change.path}（没有可用的 patch）`);
          continue;
        }
        try {
          await revertFileChange(activeAgent.id, change.path, change.patches, change.created);
          revertedKeys.add(`${assistantId}:${change.path}`);
        } catch (error) {
          failures.push(`${change.path}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (revertedKeys.size > 0) {
      setRevertedFileChanges((current) => new Set([...current, ...revertedKeys]));
    }
    setReviewRevertBusy(false);
    if (failures.length > 0) {
      setError(`有 ${failures.length} 个文件没能撤回：\n${failures.join("\n")}`);
      window.setTimeout(() => setError(null), 12000);
    }
  }, [activeAgent, turnFileChangesByAssistantId]);

  const handleReviewFileChange = useCallback((_assistantId: string, path: string) => {
    setExpandedReviewFiles(new Set([path]));
    setAgentWorkbenchMode("review");
    setAgentWorkbenchOpen(true);
  }, []);
  const toggleReviewFile = useCallback((path: string) => {
    setExpandedReviewFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleRevertFileChange = useCallback(async (assistantMessageId: string, change: TurnFileChange) => {
    if (!activeAgent || !change.patches?.length) return;
    try {
      await revertFileChange(activeAgent.id, change.path, change.patches, change.created);
      setRevertedFileChanges((current) => new Set(current).add(`${assistantMessageId}:${change.path}`));
      setExpandedReviewFiles((current) => {
        if (!current.has(change.path)) return current;
        const next = new Set(current);
        next.delete(change.path);
        return next;
      });
    } catch (revertError) {
      const message = revertError instanceof Error ? revertError.message : String(revertError);
      setError(message);
      window.setTimeout(() => setError(null), 8000);
      throw revertError;
    }
  }, [activeAgent?.id]);

  const handleMessageFeedback = useCallback((message: AgentState["messages"][number], rating: "up" | "down" | null) => {
    if (!activeAgent || !message.entryId) return;
    const previous = message.feedback;
    updateAgent(activeAgent.id, {
      messages: activeAgent.messages.map((item) => item.entryId === message.entryId ? { ...item, feedback: rating ?? undefined } : item),
    });
    void setMessageFeedback(activeAgent.id, message.entryId, rating).catch((feedbackError) => {
      updateAgent(activeAgent.id, {
        messages: useAgentStore.getState().getAgent(activeAgent.id)?.messages.map((item) => item.entryId === message.entryId ? { ...item, feedback: previous } : item) ?? [],
      });
      setError(feedbackError instanceof Error ? feedbackError.message : String(feedbackError));
    });
  }, [activeAgent?.id, activeAgent?.messages, updateAgent]);

  const handleForkMessage = useCallback((message: AgentState["messages"][number]) => {
    if (!activeAgent || !message.entryId) return;
    void forkSession(activeAgent.id, message.entryId)
      .then(() => new Promise((resolve) => window.setTimeout(resolve, 180)))
      .then(async () => {
        await requestMessages(activeAgent.id);
        const infos = await listAgents();
        syncAgents(infos);
      })
      .catch((forkError) => setError(forkError instanceof Error ? forkError.message : String(forkError)));
  }, [activeAgent?.id, syncAgents]);
  const showConversationMinimap =
    conversationPairs.length >= CONVERSATION_MINIMAP_PAIR_THRESHOLD;

  const handleConversationScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const currentScrollTop = container.scrollTop;
    const isScrollingUp = currentScrollTop < lastConversationScrollTopRef.current - 0.5;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceFromBottom <= 48;
    // Any upward movement is explicit user intent. Stop following the stream
    // immediately instead of waiting until the viewport is 48px from bottom.
    isNearBottomRef.current = isScrollingUp ? false : isNearBottom;
    lastConversationScrollTopRef.current = currentScrollTop;
    setShowScrollToBottom(!isNearBottom && container.scrollHeight > container.clientHeight);
  }, []);

  const handleConversationWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) isNearBottomRef.current = false;
  }, []);

  const scrollConversationToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    container.scrollTop = container.scrollHeight;
    lastConversationScrollTopRef.current = container.scrollTop;
  }, []);

  useEffect(() => {
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
    const frame = window.requestAnimationFrame(scrollConversationToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, scrollConversationToBottom]);

  useEffect(() => {
    if (conversationView !== "chat" || settingsOpen || activeAgent?.status !== "streaming") return;
    if (!isNearBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeId,
    conversationView,
    settingsOpen,
    activeAgent?.status,
    activeAgent?.messages.length,
    activeAgent?.streamingThinking,
    activeAgent?.activeToolCalls.size,
    streamingText,
  ]);

  useEffect(() => {
    setSelectedTrajectoryEntry(null);
  }, [activeId]);

  useEffect(() => {
    if (conversationView !== "trajectory" || !activeId) return;
    void Promise.all([
      requestExecutionTraces(activeId),
      requestContextSnapshot(activeId),
    ]).catch((trajectoryError) => {
      setError(trajectoryError instanceof Error ? trajectoryError.message : String(trajectoryError));
    });
  }, [conversationView, activeId, activeAgent?.status]);

  const selectTrajectoryEntry = useCallback((entry: SelectedTrajectoryEntry) => {
    setSelectedTrajectoryEntry(entry);
    setTrajectoryDetailView("execution");
    if (activeId) {
      void requestExecutionTraces(activeId).catch((traceError) => {
        setError(traceError instanceof Error ? traceError.message : String(traceError));
      });
    }
  }, [activeId]);

  useEffect(() => {
    if (!fileMention) {
      setProjectFiles([]);
      setProjectFilesLoading(false);
      return;
    }

    let cancelled = false;
    setProjectFilesLoading(true);
    const timer = window.setTimeout(() => {
      void listProjectFiles(inputProjectCwd, fileMention.query)
        .then((files) => {
          if (!cancelled) setProjectFiles(files);
        })
        .catch(() => {
          if (!cancelled) setProjectFiles([]);
        })
        .finally(() => {
          if (!cancelled) setProjectFilesLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileMention?.query, inputProjectCwd, fileMentionMenuDismissed]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    const closePicker = (event: MouseEvent) => {
      if (!projectPickerRef.current?.contains(event.target as Node)) {
        setProjectPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, [projectPickerOpen]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const closePicker = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, [modelPickerOpen]);

  useEffect(() => {
    if (!permissionPickerOpen) return;
    const closePicker = (event: MouseEvent) => {
      if (!permissionPickerRef.current?.contains(event.target as Node)) {
        setPermissionPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, [permissionPickerOpen]);

  useEffect(() => {
    if (!worktreePickerOpen) return;
    const closePicker = (event: MouseEvent) => {
      if (!worktreePickerRef.current?.contains(event.target as Node)) {
        setWorktreePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, [worktreePickerOpen]);

  const pendingPermission = activeAgent?.pendingPermission ?? null;
  const pendingPermissionAgentId = activeAgent?.id ?? null;
  useEffect(() => {
    if (!pendingPermission || !pendingPermissionAgentId) return;
    // Capture phase so the dialog consumes Enter/Esc before the composer
    // (or any other global shortcut) behind it can react.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void respondToolPermission(pendingPermissionAgentId, pendingPermission.toolCallId, false);
        useAgentStore.getState().updateAgent(pendingPermissionAgentId, { pendingPermission: null });
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void respondToolPermission(pendingPermissionAgentId, pendingPermission.toolCallId, true);
        useAgentStore.getState().updateAgent(pendingPermissionAgentId, { pendingPermission: null });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pendingPermission, pendingPermissionAgentId]);

  // nova denies the request once its deadline passes and emits tool_permission_resolved.
  // If that event never arrives (agent crash, dropped RPC) the dialog would stay up
  // forever, so close it locally instead. The request is denied either way.
  useEffect(() => {
    if (!pendingPermission || !pendingPermissionAgentId) return;
    const timer = setTimeout(() => {
      useAgentStore.getState().updateAgent(pendingPermissionAgentId, { pendingPermission: null });
    }, pendingPermission.timeoutMs ?? 120_000);
    return () => clearTimeout(timer);
  }, [pendingPermission, pendingPermissionAgentId]);

  useEffect(() => {
    if (slashCommands.length === 0 && !fileMention) return;
    const dismissSlashCommands = (event: MouseEvent) => {
      if (!composerShellRef.current?.contains(event.target as Node)) {
        setSlashCommandMenuDismissed(true);
        setFileMentionMenuDismissed(true);
      }
    };
    document.addEventListener("mousedown", dismissSlashCommands);
    return () => document.removeEventListener("mousedown", dismissSlashCommands);
  }, [slashCommands.length, fileMention]);

  // Auto-select a default model when models are loaded and none is configured yet
  useEffect(() => {
    if (availableModels.length === 0) return;
    if (defaultModel) return;

    const pick = (pool: AvailableModel[]): AvailableModel | undefined => {
      // Prefer non-dated flagship ids (no -YYYYMMDD suffix)
      const flagships = pool.filter((m) => !/-\d{8}$/.test(m.id));
      const candidates = flagships.length > 0 ? flagships : pool;
      // Prefer vision-capable models, then largest context window
      const vision = candidates.filter((m) => m.images);
      const bestPool = vision.length > 0 ? vision : candidates;
      return [...bestPool].sort((a, b) => b.contextWindow - a.contextWindow)[0];
    };

    const byProvider = defaultProvider
      ? availableModels.filter((m) => m.provider === defaultProvider)
      : [];
    const chosen = pick(byProvider.length > 0 ? byProvider : availableModels) ?? availableModels[0];
    if (chosen) {
      setDefaultModel(chosen.id);
      setDefaultProvider(chosen.provider);
    }
  }, [availableModels, defaultModel, defaultProvider, setDefaultModel, setDefaultProvider]);

  const refreshModelCatalog = useCallback(async () => {
    const results = await Promise.allSettled([listAllModels(), fetchModelsViaShell()]);
    const merged = new Map<string, AvailableModel>();
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[AppShell] model catalog source failed:", result.reason);
        continue;
      }
      for (const model of result.value ?? []) {
        const mapped: AvailableModel = {
          id: String(model.id ?? ""),
          name: String(model.name ?? model.id ?? ""),
          provider: String(model.provider ?? ""),
          contextWindow: Number(model.contextWindow ?? 0),
          maxTokens: Number(model.maxTokens ?? 0),
          reasoning: Boolean(model.reasoning),
          images: Boolean(model.images),
        };
        if (!mapped.id || !mapped.provider) continue;
        merged.set(`${mapped.provider}:${mapped.id}`, mapped);
      }
    }
    if (merged.size === 0) throw new Error("模型已保存，但刷新模型列表失败");
    useAgentStore.setState({ availableModels: Array.from(merged.values()) });
  }, []);

  // Load agents on mount
  useEffect(() => {
    listAgents()
      .then((infos) => {
        syncAgents(infos);
        setAgentsLoaded(true);
        // If there's a running agent, get models from it
        if (infos.length > 0) {
          void requestAvailableModels(infos[0].id).catch(() => {});
        }
      })
      .catch(() => setAgentsLoaded(true));

    // Merge the bundled/absolute CLI catalog with the user's shell Nova.
    // The latter includes newly-added models.json providers such as Ollama,
    // while packaged Studio builds may point at an older bundled CLI.
    void refreshModelCatalog().catch((reason) => console.error("[AppShell] initial model refresh failed:", reason));
  }, [refreshModelCatalog]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
    };
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const newAttachments: PendingAttachment[] = await Promise.all(
      Array.from(files).map(fileToAttachment),
    );
    setPendingAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Tauri native drag-drop — register once via ref, dedup by path
  const dropUnlistenRef = useRef<(() => void) | null>(null);
  const droppedPathsRef = useRef(new Set<string>());

  useEffect(() => {
    if (dropUnlistenRef.current) return; // already registered
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        console.log("[drop] raw paths:", event.payload.paths, "already loaded:", [...droppedPathsRef.current]);
        const paths = event.payload.paths.filter((p) => !droppedPathsRef.current.has(p));
        console.log("[drop] new paths:", paths);
        if (paths.length === 0) return;
        paths.forEach((p) => droppedPathsRef.current.add(p));
        Promise.all(paths.map(pathToAttachment))
          .then((loaded) => setPendingAttachments((prev) => [...prev, ...loaded]))
          .catch((err) => console.error("[drag-drop] failed:", err));
      }
    }).then((fn) => { dropUnlistenRef.current = fn; });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const fileItems = Array.from(items).filter((item) => item.kind === "file");
    if (fileItems.length === 0) return;
    e.preventDefault();
    const files = fileItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    const slashMatch = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      const command = slashMatch[1].toLowerCase();
      const args = slashMatch[2]?.trim() ?? "";
      try {
        if (command === "model") {
          setModelPickerOpen(true);
        } else {
          if (!activeId) throw new Error(`/${command} 需要先创建一个会话`);
          if (command === "new") {
            await startNewSession(activeId);
          } else if (command === "compact") {
            await compactSession(activeId, args || undefined);
          } else if (command === "name") {
            if (!args) throw new Error("用法：/name <会话名称>");
            await setSessionName(activeId, args);
            setAgentNames((names) => {
              const next = { ...names, [activeId]: args };
              localStorage.setItem(AGENT_NAMES_KEY, JSON.stringify(next));
              return next;
            });
          } else if (command === "session") {
            await requestSessionStats(activeId);
          } else if (command === "copy") {
            const lastReply = [...(activeAgent?.messages ?? [])]
              .reverse()
              .find((message) => message.role === "assistant")?.content;
            if (!lastReply) throw new Error("当前会话还没有可复制的 Nova 回复");
            await navigator.clipboard.writeText(lastReply);
          } else if (BUILTIN_SLASH_COMMANDS.some((item) => item.name === command)) {
            throw new Error(`/${command} 尚未在 Studio 中实现，请暂时在 Nova CLI 中使用`);
          } else {
            // Extension commands, prompt templates and skills are executed by Nova's prompt RPC.
            return void sendRegularPrompt();
          }
        }
        setInput("");
        setSlashCommandMenuDismissed(false);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setTimeout(() => setError(null), 8000);
        return;
      }
    }

    await sendRegularPrompt();
  };

  const sendRegularPrompt = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    setIsSending(true);

    try {
      let agentId = activeId;

      // Spawn agent if none exists
      if (!agentId) {
        const cwd = welcomeProjectCwd;
        const info = await spawnAgent(
          cwd,
          defaultModel || undefined,
          defaultProvider || undefined,
          worktreeEnabled && worktreeAvailable ? true : undefined,
        );

        const newAgent: AgentState = {
          id: info.id,
          parentAgentId: info.parent_agent_id,
          createdBy: info.created_by,
          name: null,
          avatarId: getOrAssignAgentAvatar(info.id),
          status: info.status,
          cwd: info.cwd,
          projectCwd: info.project_cwd ?? null,
          worktree: info.worktree ?? null,
          model: info.model,
          messages: [],
          createdAt: info.created_at,
          messageCount: info.message_count,
          streamingText: "",
          streamingThinking: "",
          activeToolCalls: new Map(),
          modelMeta: null,
          contextUsage: null,
          lastTurnUsage: null,
          sessionUsage: null,
          executionTraces: [],
          contextSnapshot: null,
          autoCompactionEnabled: true,
          toolPermissionMode: "ask",
          pendingPermission: null,
          liveUsage: null,
          outputSinceLastUserInput: 0,
        };
        addAgent(newAgent);
        agentId = info.id;
        setPendingProjectCwd(null);
        // Request available models for the new agent
        void requestAvailableModels(info.id).catch((err) =>
          console.error("Failed to request available models:", err)
        );
      }

      // Add user message to UI immediately
      const msgAttachments = pendingAttachments.map((att) => ({
        name: att.name,
        mimeType: att.mimeType,
        isImage: att.isImage,
      }));
      addUserMessage(agentId, text, msgAttachments.length > 0 ? msgAttachments : undefined);
      const fileReferences = selectedFileReferences
        .filter((path) => text.includes(`@${path}`))
        .map((path) => ({ path }));

      // Build ImageContent[] from image attachments
      const images: ImageContent[] = pendingAttachments
        .filter((att) => att.isImage)
        .map((att) => ({
          type: "image" as const,
          data: att.data,
          mimeType: att.mimeType,
        }));

      // Append text file content as context to the message
      const textFiles = pendingAttachments.filter((att) => att.isText);
      let finalMessage = text;
      if (textFiles.length > 0) {
        const fileContexts = textFiles
          .map((att) => `\n\n--- Attached file: ${att.name} ---\n${att.data}`)
          .join("");
        finalMessage = text + fileContexts;
      }

      // Clear input and attachments
      setInput("");
      setHistoryIndex(-1);
      setSelectedFileReferences([]);
      for (const att of pendingAttachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      setPendingAttachments([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      // Provisional input estimate so the token counter starts rolling the moment
      // the message is sent (real usage arrives from message_update/end events).
      const baseCtxTokens = activeAgent?.contextUsage?.tokens ?? 0;
      const estTurnInput = Math.round(baseCtxTokens + finalMessage.length / 4);
      useAgentStore.setState((s) => ({
        agents: s.agents.map((a) =>
          a.id === agentId
            ? {
                ...a,
                liveUsage: { input: estTurnInput, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : a,
        ),
      }));

      // Send to agent via Tauri backend
      if (activeAgent?.parentAgentId && activeAgent.status === "streaming") {
        await steerAgent(agentId, finalMessage);
      } else {
        await sendPrompt(
          agentId,
          finalMessage,
          images.length > 0 ? images : undefined,
          fileReferences.length > 0 ? fileReferences : undefined,
          activeDelegatedAgents.length > 0 ? activeDelegatedAgents.map((agent) => agent.id) : undefined,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send prompt:", msg);
      setError(msg);
      setTimeout(() => setError(null), 8000);
    } finally {
      setIsSending(false);
    }
  };

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    setInput(`/${command.name} `);
    setSlashCommandMenuDismissed(true);
    setSelectedSlashCommandIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoResize();
    });
  }, [autoResize]);

  const selectProjectFile = useCallback((path: string) => {
    const mention = findFileMention(input, cursorPosition);
    if (!mention) return;
    const inserted = insertFileMention(input, mention, path);
    setInput(inserted.value);
    setSelectedFileReferences((paths) => (paths.includes(path) ? paths : [...paths, path]));
    setCursorPosition(inserted.cursor);
    setFileMentionMenuDismissed(true);
    setSelectedProjectFileIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      autoResize();
    });
  }, [autoResize, cursorPosition, input]);

  const handleAbort = useCallback(async () => {
    if (!activeId) return;
    try {
      await abortAgent(activeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to abort:", message);
      setError(message);
    }
  }, [activeId]);

  useEffect(() => {
    if (activeAgent?.status !== "streaming") return;
    const abortOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void handleAbort();
    };
    window.addEventListener("keydown", abortOnEscape);
    return () => window.removeEventListener("keydown", abortOnEscape);
  }, [activeAgent?.status, handleAbort]);

  const handleSelectAgent = useCallback((agentId: string) => {
    setSettingsOpen(false);
    setConversationView("chat");
    setActiveAgent(agentId);
    void activateAgent(agentId)
      .then((info) => {
        updateAgent(agentId, {
          status: info.status,
          name: info.name,
          model: info.model,
          messageCount: Math.max(info.message_count, agentsById.get(agentId)?.messageCount ?? 0),
        });
        // Request available models for the activated agent
        void requestAvailableModels(agentId).catch((err) =>
          console.error("Failed to request available models:", err)
        );
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Failed to activate agent:", message);
        updateAgent(agentId, { status: "error" });
        setError(message);
      });
  }, [agentsById, setActiveAgent, updateAgent]);

  const handleEditAgent = useCallback((agent: AgentState) => {
    setEditingAgent({
      id: agent.id,
      name: agentDisplayName(agent, agentNames),
    });
  }, [agentNames]);

  const handleChooseBackground = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof selected !== "string") return;

    try {
      setCustomBgUrl(await loadBackgroundImage(selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "背景图片加载失败");
    }
  };

  return (
    <div
      className={`relative h-screen w-screen overflow-hidden bg-bg-primary ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}${!settingsOpen && conversationView === "chat" && showAgentWorkbench && agentWorkbenchOpen ? " studio-root-dock-open" : ""}`}
      data-custom-background={customBgUrl ? "true" : "false"}
      style={{ "--conversation-sidebar-width": `${workbenchPanelWidth}px` } as CSSProperties}
    >
      <Background />
      <div
        className="app-titlebar-drag"
        data-tauri-drag-region
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          void getCurrentWindow().startDragging().catch((dragError) => {
            console.error("Failed to start window drag:", dragError);
          });
        }}
      >
        <span data-tauri-drag-region>Nova Studio</span>
      </div>

      {/* Full-window drag overlay */}
      {isDragOver && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9990,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(99, 102, 241, 0.08)",
            backdropFilter: "blur(4px)",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              padding: "32px 48px",
              borderRadius: 16,
              border: "2px dashed #818cf8",
              background: "rgba(129, 140, 248, 0.1)",
            }}
          >
            <Paperclip size={32} color="#818cf8" />
            <span style={{ color: "#818cf8", fontSize: 15, fontWeight: 500 }}>
              Drop files here
            </span>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          style={{
            position: "fixed",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 9999,
            background: "rgba(239, 68, 68, 0.15)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "#fca5a5",
            padding: "10px 20px",
            borderRadius: 12,
            fontSize: 13,
            fontFamily: "system-ui",
            maxWidth: "90vw",
            wordBreak: "break-word",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            backdropFilter: "blur(12px)",
          }}
        >
          {error}
          <button
            onClick={() => setError(null)}
            style={{
              marginLeft: 12,
              background: "none",
              border: "none",
              color: "#fca5a5",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            x
          </button>
        </div>
      )}

      <div className="app-workspace relative z-10 flex h-full flex-col">
        {/* Body row: sidebar + main */}
        <div className="relative flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside
          className={`studio-sidebar glass-panel relative z-20 mb-3 ml-3 flex shrink-0 flex-col ${sidebarCollapsed ? "studio-sidebar-collapsed" : ""}`}
        >
          {sidebarCollapsed ? (
            <nav className="sidebar-collapsed-nav" aria-label="折叠侧边栏">
              <button
                type="button"
                className="sidebar-collapsed-logo"
                onClick={() => setSidebarCollapsed(false)}
                aria-label="展开侧边栏"
                title="展开侧边栏"
              >
                <img src={theme === "arctic-dawn" ? "/images/nova-avatar.jpg" : "/images/nova-avatar-dark.jpg"} alt="Nova" />
                <PanelLeftOpen className="sidebar-collapsed-expand-icon" size={20} />
              </button>
              {settingsOpen ? (
                <>
                  <button type="button" className="sidebar-collapsed-action" onClick={() => setSettingsOpen(false)} aria-label="返回主页" title="返回主页"><ArrowLeft size={19} /></button>
                  <button type="button" className={`sidebar-collapsed-action ${settingsSection === "appearance" ? "sidebar-settings-button-active" : ""}`} onClick={() => setSettingsSection("appearance")} aria-label="外观设置" title="外观设置"><Palette size={19} /></button>
                  <button type="button" className={`sidebar-collapsed-action ${settingsSection === "models" ? "sidebar-settings-button-active" : ""}`} onClick={() => setSettingsSection("models")} aria-label="模型设置" title="模型设置"><Bot size={19} /></button>
                  <button type="button" className={`sidebar-collapsed-action ${settingsSection === "activity" ? "sidebar-settings-button-active" : ""}`} onClick={() => setSettingsSection("activity")} aria-label="活跃度" title="活跃度"><ChartNoAxesColumnIncreasing size={19} /></button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="sidebar-collapsed-action"
                    onClick={() => {
                      setPendingProjectCwd(null);
                      setActiveAgent(null);
                      setSettingsOpen(false);
                      setConversationView("chat");
                    }}
                    aria-label="新会话"
                    title="新会话"
                  >
                    <Plus size={20} />
                  </button>
                  <button type="button" className="sidebar-collapsed-action" onClick={() => setSidebarCollapsed(false)} aria-label="查看工作区" title="查看工作区"><FolderOpen size={19} /></button>
                  <button type="button" className="sidebar-collapsed-action" onClick={() => void openUrl("https://github.com/DongZiJie1/nova-agent")} aria-label="打开 Nova Agent GitHub" title="Nova Agent GitHub"><GithubMark size={19} /></button>
                  <button type="button" className="sidebar-collapsed-action sidebar-collapsed-settings" onClick={() => setSettingsOpen(true)} aria-label="设置" title="设置"><Settings size={19} /></button>
                </>
              )}
            </nav>
          ) : settingsOpen ? (
            <div className="settings-sidebar-content">
              <header className="settings-sidebar-header">
                <button
                  type="button"
                  className="settings-back-button"
                  onClick={() => setSettingsOpen(false)}
                >
                  <ArrowLeft size={16} />
                  <span>返回</span>
                </button>
                <h1>设置</h1>
                <button
                  type="button"
                  className="sidebar-collapse-button"
                  onClick={() => setSidebarCollapsed(true)}
                  aria-label="收起侧边栏"
                  title="收起侧边栏"
                >
                  <PanelLeftClose size={18} />
                </button>
              </header>
              <nav className="settings-sidebar-nav" aria-label="设置分类">
                <button type="button" className={`settings-category-button ${settingsSection === "appearance" ? "settings-category-button-active" : ""}`} onClick={() => setSettingsSection("appearance")}>
                  <Palette size={16} />
                  <span>外观</span>
                </button>
                <button type="button" className={`settings-category-button ${settingsSection === "models" ? "settings-category-button-active" : ""}`} onClick={() => setSettingsSection("models")}>
                  <Bot size={16} />
                  <span>模型</span>
                </button>
                <button type="button" className={`settings-category-button ${settingsSection === "activity" ? "settings-category-button-active" : ""}`} onClick={() => setSettingsSection("activity")}>
                  <ChartNoAxesColumnIncreasing size={16} />
                  <span>活跃度</span>
                </button>
              </nav>
            </div>
          ) : (
            <>
              <header className="sidebar-header">
                <div className="sidebar-brand">
                  <span className="sidebar-brand-mark">
                    <img src={theme === "arctic-dawn" ? "/images/nova-avatar.jpg" : "/images/nova-avatar-dark.jpg"} alt="Nova" />
                  </span>
                  <span>Nova</span>
                  <span className="sidebar-brand-badge">STUDIO</span>
                  <button
                    type="button"
                    className="sidebar-collapse-button"
                    onClick={() => setSidebarCollapsed(true)}
                    aria-label="收起侧边栏"
                    title="收起侧边栏"
                  >
                    <PanelLeftClose size={18} />
                  </button>
                </div>
                <button
                  type="button"
                  className="sidebar-new-session"
                  onClick={() => {
                    setPendingProjectCwd(null);
                    setActiveAgent(null);
                    setSettingsOpen(false);
                    setConversationView("chat");
                  }}
                >
                  <Plus size={16} />
                  <span>新会话</span>
                </button>
              </header>

              <div className="sidebar-workspace-heading">
                <span>工作区</span>
                <span className="sidebar-project-count">{rootsByProject.size}</span>
              </div>
              <div className="agent-tree flex-1 overflow-y-auto">
                {Array.from(rootsByProject.entries()).map(([cwd, projectAgents]) => (
                  <section key={cwd} className="project-group">
                    <button
                      className="project-group-title"
                      title={cwd}
                      onClick={() =>
                        setCollapsedProjects((current) => {
                          const next = new Set(current);
                          if (next.has(cwd)) next.delete(cwd);
                          else next.add(cwd);
                          return next;
                        })
                      }
                    >
                      <span className="project-group-icon">
                        <FolderOpen size={17} />
                      </span>
                      <span className="project-group-text">
                        <span className="project-group-name">
                          {projectNames[cwd] ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}
                        </span>
                        <span className="project-group-path">{cwd}</span>
                      </span>
                      <span className="project-agent-count">
                        {projectAgents.length}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className="project-action"
                        title="Add agent"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingProjectCwd(cwd);
                          setActiveAgent(null);
                        }}
                      >
                        <Plus size={14} />
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className="project-action"
                        title="Edit project"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingProject({
                            cwd,
                            name: projectNames[cwd] ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd,
                          });
                        }}
                      >
                        <Pencil size={13} />
                      </span>
                      {collapsedProjects.has(cwd) ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                    </button>
                    {!collapsedProjects.has(cwd) && (
                      <div className="project-agents">
                        {projectAgents.map((agent) => (
                          <AgentTreeNode
                            key={agent.id}
                            agent={agent}
                            childrenByParent={childrenByParent}
                            agentsById={agentsById}
                            activeId={activeId}
                            onSelect={handleSelectAgent}
                            agentNames={agentNames}
                            onEdit={handleEditAgent}
                            onHide={setHidingAgent}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
              <footer className="sidebar-footer">
                <button
                  type="button"
                  className="sidebar-settings-button"
                  onClick={() => void openUrl("https://github.com/DongZiJie1/nova-agent")}
                  title="在浏览器中打开 Nova Agent GitHub"
                >
                  <GithubMark size={16} />
                  <span>GitHub</span>
                </button>
                <button
                  type="button"
                  className={`sidebar-settings-button ${settingsOpen ? "sidebar-settings-button-active" : ""}`}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings size={16} />
                  <span>设置</span>
                </button>
              </footer>
            </>
          )}
        </aside>

        {/* Main */}
        <main className={`studio-main ${hasMessages ? "studio-main-has-messages" : ""} relative w-full flex flex-col overflow-hidden`}>
          {settingsOpen && (
            <section className="settings-page">
              <div className={`settings-page-inner ${settingsSection === "activity" ? "settings-page-inner-activity" : ""}`}>
                {settingsSection === "appearance" ? (
                  <>
                  <header className="settings-page-header">
                    <h1>外观</h1>
                    <p>调整 Nova Studio 的主题和桌面背景。</p>
                  </header>

                  <div className="settings-card">
                    <div className="settings-card-copy">
                      <h2>主题</h2>
                      <p>选择界面的明暗风格。</p>
                    </div>
                    <div className="theme-switcher" data-active-theme={theme} role="group" aria-label="主题风格">
                      <button
                        type="button"
                        className={`theme-switcher-option ${theme === "arctic-dawn" ? "theme-switcher-option-active" : ""}`}
                        onClick={() => setTheme("arctic-dawn")}
                        aria-pressed={theme === "arctic-dawn"}
                      >
                        <Sun size={16} /><span>明亮</span>
                      </button>
                      <button
                        type="button"
                        className={`theme-switcher-option ${theme === "midnight" ? "theme-switcher-option-active" : ""}`}
                        onClick={() => setTheme("midnight")}
                        aria-pressed={theme === "midnight"}
                      >
                        <Moon size={16} /><span>暗黑</span>
                      </button>
                    </div>
                  </div>

                  <div className="settings-card settings-background-card">
                    <div className="settings-background-main">
                      <div className="settings-card-copy">
                        <h2>桌面背景</h2>
                        <p>选择本地图片，或恢复主题默认背景。</p>
                      </div>
                      <div className="settings-background-actions">
                        <button type="button" className="background-picker-button" onClick={() => void handleChooseBackground()}>
                          <Image size={15} /><span>选择图片</span>
                        </button>
                        {customBgUrl && (
                          <button type="button" className="settings-background-clear" onClick={() => setCustomBgUrl(null)}>
                            <X size={14} /><span>清除背景</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <label className={`settings-blur-control ${customBgUrl ? "" : "settings-blur-control-disabled"}`}>
                      <span className="settings-blur-label">
                        <span>整体模糊</span>
                        <output>{backgroundBlur === 0 ? "默认" : `${backgroundBlur}px`}</output>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="18"
                        step="1"
                        value={backgroundBlur}
                        disabled={!customBgUrl}
                        onChange={(event) => setBackgroundBlur(Number(event.target.value))}
                        aria-label="背景整体模糊强度"
                      />
                      <span className="settings-blur-scale"><span>清晰</span><span>模糊</span></span>
                    </label>
                  </div>
                  </>
                ) : settingsSection === "models" ? (
                  <ModelSettings
                    models={availableModels}
                    onSaved={refreshModelCatalog}
                  />
                ) : (
                  <ActivityHeatmap />
                )}
              </div>
            </section>
          )}
          {!settingsOpen && activeAgent && (
            <div className="conversation-view-switcher" data-active-view={conversationView}>
              <button
                type="button"
                className={conversationView === "chat" ? "conversation-view-option-active" : ""}
                onClick={() => setConversationView("chat")}
              >
                <MessageCircle size={14} />
                <span>对话</span>
              </button>
              <button
                type="button"
                className={conversationView === "trajectory" ? "conversation-view-option-active" : ""}
                onClick={() => setConversationView("trajectory")}
              >
                <Route size={14} />
                <span>轨迹</span>
              </button>
            </div>
          )}
          {/* Content area + docked workbench sidebar */}
          <div className={`conversation-dock${!settingsOpen && conversationView === "chat" && showAgentWorkbench && agentWorkbenchOpen ? " conversation-dock-open" : ""}${dockResizing ? " conversation-dock-resizing" : ""}`}>
            <div className="conversation-dock-main">
          {/* Content area */}
          <div
            ref={scrollRef}
            onScroll={handleConversationScroll}
            onWheelCapture={handleConversationWheel}
            className={`conversation-scroll flex-1 overflow-y-auto flex flex-col items-center px-6 ${
              !hasMessages ? "justify-center" : "justify-start"
            } ${hasMessages ? "conversation-scroll-has-messages" : ""} ${hasMessages && conversationView === "chat" ? "conversation-scroll-chat" : ""}`}
            style={{ paddingTop: activeAgent && !settingsOpen ? 54 : undefined }}
          >
            {conversationView === "trajectory" && activeAgent ? (
              <div className={`trajectory-view ${selectedTrajectoryEntry ? "trajectory-view-inspecting" : ""}`}>
                <div className="trajectory-main">
                  {activeAgent.messages.length === 0 && activeAgent.activeToolCalls.size === 0 && !activeAgent.streamingThinking && trajectoryContextEntries.length === 0 ? (
                    <div className="trajectory-empty">当前会话还没有轨迹数据</div>
                  ) : (
                    <div className="trajectory-list">
                    {trajectoryContextEntries.length > 0 && (
                      <section className="trajectory-request trajectory-context-request">
                        <span className="trajectory-request-label">CONTEXT</span>
                        <div className="trajectory-request-events">
                          {trajectoryContextEntries.map((entry) => (
                            <div
                              key={entry.id}
                              className={`trajectory-row trajectory-row-${entry.className} ${selectedTrajectoryEntry?.id === entry.id ? "trajectory-row-selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              aria-pressed={selectedTrajectoryEntry?.id === entry.id}
                              onClick={() => selectTrajectoryEntry({ id: entry.id, label: entry.role, data: entry.data })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  selectTrajectoryEntry({ id: entry.id, label: entry.role, data: entry.data });
                                }
                              }}
                            >
                              <span className="trajectory-node" />
                              <span className="trajectory-role">{entry.role}</span>
                              <div className="trajectory-content">{entry.preview || "—"}</div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                    {trajectoryRequests.map((request, requestIndex) => (
                      <section key={request.id} className="trajectory-request">
                        <span className="trajectory-request-label">REQUEST {requestIndex + 1}</span>
                        <div className="trajectory-request-events">
                          {request.messages.map((message) => {
                            const isAgentTool = message.role === "tool"
                              && Boolean(message.toolCalls?.some((tool) => isAgentTrajectoryTool(tool.name)));
                            const isSubAgentResult = message.role === "agent_result";
                            const isAgentBatch = message.role === "agent_batch";
                            const isAgentEntry = isAgentTool || isSubAgentResult || isAgentBatch;
                            const trajectoryRole = isAgentBatch
                              ? "AGENT_BATCH"
                              : isSubAgentResult
                              ? "SUB_AGENT"
                              : isAgentTool
                                ? "AGENT"
                              : message.role === "user"
                                ? "USER"
                                : message.role === "assistant"
                                  ? "ASSISTANT"
                                  : message.role === "thinking"
                                    ? "THINK"
                                    : "TOOL";
                            return (
                            <div
                              key={message.id}
                              className={`trajectory-row trajectory-row-${isAgentBatch ? "agent-batch" : isSubAgentResult ? "sub-agent" : isAgentEntry ? "agent" : message.role} ${selectedTrajectoryEntry?.id === message.id ? "trajectory-row-selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              aria-pressed={selectedTrajectoryEntry?.id === message.id}
                              onClick={() => selectTrajectoryEntry({ id: message.id, label: trajectoryRole, data: message })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  selectTrajectoryEntry({ id: message.id, label: trajectoryRole, data: message });
                                }
                              }}
                            >
                              <span className="trajectory-node" />
                              <span className="trajectory-role">{trajectoryRole}</span>
                              <div className="trajectory-content">
                                {message.role === "tool" && message.toolCalls?.length
                                  ? message.toolCalls.map((tool) => (
                                      <div key={tool.id} className="trajectory-tool-line">
                                        <strong>{tool.name}</strong>
                                        <span>{JSON.stringify(tool.args)}</span>
                                        {tool.result !== undefined && <span>→ {String(tool.result)}</span>}
                                      </div>
                                    ))
                                  : message.content || "—"}
                              </div>
                            </div>
                            );
                          })}
                          {requestIndex === trajectoryRequests.length - 1 && activeAgent.streamingThinking && (
                            <div
                              className={`trajectory-row trajectory-row-thinking trajectory-row-live ${selectedTrajectoryEntry?.id === "live-thinking" ? "trajectory-row-selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => selectTrajectoryEntry({ id: "live-thinking", label: "THINK", data: { type: "streaming_thinking", content: activeAgent.streamingThinking } })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  selectTrajectoryEntry({ id: "live-thinking", label: "THINK", data: { type: "streaming_thinking", content: activeAgent.streamingThinking } });
                                }
                              }}
                            >
                              <span className="trajectory-node" />
                              <span className="trajectory-role">THINK</span>
                              <div className="trajectory-content">{activeAgent.streamingThinking}</div>
                            </div>
                          )}
                          {requestIndex === trajectoryRequests.length - 1 && Array.from(activeAgent.activeToolCalls.values()).map((tool) => {
                            const isAgentTool = isAgentTrajectoryTool(tool.name);
                            const trajectoryRole = isAgentTool ? "AGENT" : "TOOL";
                            return (
                            <div
                              key={tool.id}
                              className={`trajectory-row trajectory-row-${isAgentTool ? "agent" : "tool"} trajectory-row-live ${selectedTrajectoryEntry?.id === `live-tool-${tool.id}` ? "trajectory-row-selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => selectTrajectoryEntry({ id: `live-tool-${tool.id}`, label: trajectoryRole, data: { type: "active_tool_call", ...tool } })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  selectTrajectoryEntry({ id: `live-tool-${tool.id}`, label: trajectoryRole, data: { type: "active_tool_call", ...tool } });
                                }
                              }}
                            >
                              <span className="trajectory-node" />
                              <span className="trajectory-role">{trajectoryRole}</span>
                              <div className="trajectory-content trajectory-tool-line">
                                <strong>{tool.name}</strong>
                                <span>{JSON.stringify(tool.args)}</span>
                                {tool.result !== undefined && <span>→ {String(tool.result)}</span>}
                              </div>
                            </div>
                            );
                          })}
                          {requestIndex === trajectoryRequests.length - 1 && streamingText && (
                            <div
                              className={`trajectory-row trajectory-row-assistant trajectory-row-live ${selectedTrajectoryEntry?.id === "live-assistant" ? "trajectory-row-selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => selectTrajectoryEntry({ id: "live-assistant", label: "ASSISTANT", data: { type: "streaming_assistant", content: streamingText } })}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  selectTrajectoryEntry({ id: "live-assistant", label: "ASSISTANT", data: { type: "streaming_assistant", content: streamingText } });
                                }
                              }}
                            >
                              <span className="trajectory-node" />
                              <span className="trajectory-role">ASSISTANT</span>
                              <div className="trajectory-content">{streamingText}</div>
                            </div>
                          )}
                        </div>
                      </section>
                    ))}
                    </div>
                  )}
                </div>
                <aside
                  className={`trajectory-detail-panel ${selectedTrajectoryEntry ? "trajectory-detail-panel-open" : ""}`}
                  aria-hidden={!selectedTrajectoryEntry}
                >
                    <header className="trajectory-detail-header">
                      <div>
                        <span className="trajectory-detail-kicker">TRAJECTORY DETAIL</span>
                        <strong>{selectedTrajectoryEntry?.label ?? "DETAIL"}</strong>
                      </div>
                      <button
                        type="button"
                        className="trajectory-detail-close"
                        onClick={() => setSelectedTrajectoryEntry(null)}
                        aria-label="关闭轨迹详情"
                      >
                        <X size={15} />
                      </button>
                    </header>
                    <div className="trajectory-detail-tabs" role="tablist" aria-label="轨迹详情显示方式">
                      <button type="button" role="tab" aria-selected={trajectoryDetailView === "execution"} className={trajectoryDetailView === "execution" ? "trajectory-detail-tab-active" : ""} onClick={() => setTrajectoryDetailView("execution")}>执行信息</button>
                      <button type="button" role="tab" aria-selected={trajectoryDetailView === "json"} className={trajectoryDetailView === "json" ? "trajectory-detail-tab-active" : ""} onClick={() => setTrajectoryDetailView("json")}>完整信息</button>
                    </div>
                    {selectedTrajectoryEntry && trajectoryDetailView === "execution" ? (
                      <TrajectoryExecutionDetails entry={selectedTrajectoryEntry} modelName={activeModelName} traces={activeAgent.executionTraces} />
                    ) : (
                      selectedTrajectoryEntry ? <TrajectoryFullDetails entry={selectedTrajectoryEntry} /> : null
                    )}
                  </aside>
              </div>
            ) : !hasMessages ? (
              /* Empty state — tagline */
              <div
                className="empty-state-hero text-center max-w-6xl w-full animate-fade-in-up"
                style={{ marginTop: "4vh" }}
              >
                {/* Tagline */}
                <h2
                  className="hero-title"
                  style={{
                    fontSize: "clamp(32px, 3.8vw, 62px)",
                    fontWeight: 720,
                    letterSpacing: "-0.035em",
                    lineHeight: 1.06,
                  }}
                >
                  <span className="hero-title-prefix">
                    Ship faster with Nova{agentsLoaded ? " in" : ""}
                  </span>
                  {agentsLoaded && (
                    <>
                      <span
                        className="hero-project-name"
                        title={inputProjectName}
                        style={{
                          position: "relative",
                        }}
                      >
                        <span
                          className="hero-project-name-text"
                          style={{
                            background: "linear-gradient(135deg, var(--color-accent-end), var(--color-accent-start), #60a5fa)",
                            WebkitBackgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                            textShadow: "0 0 40px var(--accent-shadow)",
                          }}
                        >
                          {inputProjectName}
                        </span>
                        <span
                          style={{
                            position: "absolute",
                            bottom: -2,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: "linear-gradient(90deg, var(--color-accent-start), #60a5fa)",
                            borderRadius: 1,
                          }}
                        />
                      </span>
                      <span>.</span>
                    </>
                  )}
                </h2>
                <p
                  style={{
                    marginTop: 22,
                    fontSize: "clamp(15px, 1.15vw, 18px)",
                    color: "var(--color-text-secondary)",
                    letterSpacing: "0.01em",
                  }}
                >
                  From idea to code, from concept to creation.
                </p>
              </div>
            ) : (
              /* Messages view */
              <div
                className="conversation-thread w-full pt-6"
                style={{ paddingBottom: 48 }}
              >
                {activeAgent && activeAgent.messages.length === 0 && (
                  <div
                    style={{
                      padding: "28px 0",
                      color: "var(--color-text-secondary)",
                      fontSize: 13,
                      textAlign: "center",
                    }}
                  >
                    Loading conversation…
                  </div>
                )}
                {activeAgent && (
                  <ChatHistory
                    messages={chatMessages}
                    agentSenderLabels={agentSenderLabels}
                    avatarId={activeAgent.avatarId}
                    actionableAssistantMessageIds={actionableAssistantMessageIds}
                    turnFileChangesByAssistantId={turnFileChangesByAssistantId}
                    onFeedback={handleMessageFeedback}
                    onFork={handleForkMessage}
                    onOpenAgent={(agentId, view) => {
                      handleSelectAgent(agentId);
                      setConversationView(view);
                    }}
                    onRevertFileChange={handleRevertFileChange}
                    onReviewFileChange={handleReviewFileChange}
                  />
                )}

                {/* Active tool calls */}
                {activeAgent && activeAgent.activeToolCalls.size > 0 && (
                  <div className="msg-row msg-row-tool">
                    <ToolCallList tools={Array.from(activeAgent.activeToolCalls.values())} />
                  </div>
                )}

                {activeAgent?.streamingThinking && (
                  <div className="msg-row msg-row-special">
                    <ThinkingCard content={activeAgent.streamingThinking} streaming />
                  </div>
                )}

                {/* Streaming text */}
                {streamingText && activeAgent && (
                  <StreamingText content={streamingText} avatarId={activeAgent.avatarId} />
                )}
              </div>
            )}
          </div>

          {!settingsOpen && conversationView === "chat" && !showAgentWorkbench && showConversationMinimap && (
            <nav
              className="conversation-minimap"
              aria-label="Conversation navigation"
              style={{
                height: Math.min(420, Math.max(150, conversationPairs.length * 13)),
              }}
            >
              {conversationPairs.map((pair, index) => (
                <button
                  key={pair.userMessageId}
                  type="button"
                  className="conversation-minimap-step"
                  aria-label={`跳转到第 ${index + 1} 轮对话`}
                  onClick={() => {
                    document
                      .getElementById(`conversation-turn-${pair.userMessageId}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span className="conversation-minimap-tick" />
                  <span className="conversation-minimap-preview" role="tooltip">
                    <strong>{pair.userText}</strong>
                    <span>{pair.assistantText || "等待模型回答…"}</span>
                  </span>
                </button>
              ))}
            </nav>
          )}

          {/* Input area */}
          <div
            className="conversation-input-area"
            style={{
              flexShrink: 0,
              padding: "60px 24px 56px",
              display: !settingsOpen && conversationView === "chat" ? "flex" : "none",
              justifyContent: "center",
            }}
          >
            <div
              ref={composerShellRef}
              className="composer-shell"
              style={{ position: "relative", width: "100%", maxWidth: 660 }}
            >
              {showScrollToBottom && activeAgent && (
                <button
                  type="button"
                  className="scroll-to-bottom-button"
                  onClick={scrollConversationToBottom}
                  aria-label="滚动到对话底部"
                >
                  <ArrowDown size={18} />
                </button>
              )}
              {activeAgent && <SessionStats agent={activeAgent} />}
              {activeDelegatedAgents.length > 0 && (
                <div className="delegated-task-status" role="status" aria-live="polite">
                  <LoaderCircle className="delegated-task-status-icon" size={15} />
                  <div>
                    <strong>
                      {activeDelegatedAgents.length === 1
                        ? `${agentDisplayName(activeDelegatedAgents[0], agentNames)} 正在执行子任务`
                        : `${activeDelegatedAgents.length} 个子 Agent 正在执行任务`}
                    </strong>
                    <span>你可以继续问我任何问题；子任务完成后，我会带着结果自动继续处理。</span>
                  </div>
                </div>
              )}
              {fileMention && (
                <FileMentionMenu
                  files={projectFiles}
                  loading={projectFilesLoading}
                  selectedIndex={Math.min(selectedProjectFileIndex, Math.max(0, projectFiles.length - 1))}
                  onSelectedIndexChange={setSelectedProjectFileIndex}
                  onSelect={selectProjectFile}
                />
              )}
              {/* Input card */}
              <div
                className="nova-input"
                style={{
                  overflow: "visible",
                  ...(isDragOver ? {
                    outline: "2px dashed #818cf8",
                    outlineOffset: -2,
                    background: "rgba(129, 140, 248, 0.06)",
                  } : {}),
                }}
              >
                {/* Attachment previews */}
                {pendingAttachments.length > 0 && (() => {
                  const MAX_VISIBLE = 6; // ~2 rows of 3
                  const visible = pendingAttachments.slice(0, MAX_VISIBLE);
                  const hiddenCount = pendingAttachments.length - MAX_VISIBLE;
                  return (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      padding: "10px 12px 0",
                      maxHeight: 136,
                      overflow: "hidden",
                    }}
                  >
                    {visible.map((att) => {
                      const typeInfo = getFileTypeIcon(att.name, att.mimeType);
                      const IconComp = typeInfo.icon;
                      return (
                      <div
                        key={att.id}
                        className="input-attachment"
                        style={{
                          width: att.isImage ? 64 : "auto",
                        }}
                      >
                        {att.isImage && att.previewUrl ? (
                          <img
                            src={att.previewUrl}
                            alt={att.name}
                            style={{
                              width: 64,
                              height: 64,
                              objectFit: "cover",
                              display: "block",
                            }}
                          />
                        ) : (
                          <div
                            className="input-attachment-content"
                          >
                            <IconComp size={14} color={typeInfo.color} style={{ flexShrink: 0 }} />
                            <span
                              className="input-attachment-name"
                              style={{
                                maxWidth: 120,
                              }}
                            >
                              {att.name}
                            </span>
                            <span
                              style={{
                                fontSize: 9,
                                color: typeInfo.color,
                                background: `${typeInfo.color}18`,
                                padding: "1px 4px",
                                borderRadius: 4,
                                flexShrink: 0,
                              }}
                            >
                              {typeInfo.label}
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          className="input-attachment-remove"
                          aria-label={`Remove ${att.name}`}
                          onClick={() => removeAttachment(att.id)}
                        >
                          <X size={10} />
                        </button>
                      </div>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "center" }}>
                        +{hiddenCount} more
                      </span>
                    )}
                  </div>
                  );
                })()}
                {slashCommands.length > 0 && (
                  <SlashCommandMenu
                    commands={slashCommands}
                    selectedIndex={Math.min(selectedSlashCommandIndex, slashCommands.length - 1)}
                    onSelectedIndexChange={setSelectedSlashCommandIndex}
                    onSelect={selectSlashCommand}
                  />
                )}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setHistoryIndex(-1);
                    setCursorPosition(e.currentTarget.selectionStart);
                    setSlashCommandMenuDismissed(false);
                    setFileMentionMenuDismissed(false);
                    setSelectedSlashCommandIndex(0);
                    setSelectedProjectFileIndex(0);
                    autoResize();
                  }}
                  onSelect={(e) => setCursorPosition(e.currentTarget.selectionStart)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (
                      isComposingRef.current ||
                      e.nativeEvent.isComposing ||
                      e.nativeEvent.keyCode === 229
                    ) {
                      return;
                    }
                    if (slashCommands.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSelectedSlashCommandIndex((index) => (index + 1) % slashCommands.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSelectedSlashCommandIndex(
                          (index) => (index - 1 + slashCommands.length) % slashCommands.length,
                        );
                        return;
                      }
                      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                        e.preventDefault();
                        selectSlashCommand(
                          slashCommands[Math.min(selectedSlashCommandIndex, slashCommands.length - 1)],
                        );
                        return;
                      }
                      if (e.key === "Escape") {
                        setSlashCommandMenuDismissed(true);
                        return;
                      }
                    }
                    if (fileMention && projectFiles.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSelectedProjectFileIndex((index) => (index + 1) % projectFiles.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSelectedProjectFileIndex(
                          (index) => (index - 1 + projectFiles.length) % projectFiles.length,
                        );
                        return;
                      }
                      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                        e.preventDefault();
                        selectProjectFile(
                          projectFiles[Math.min(selectedProjectFileIndex, projectFiles.length - 1)],
                        );
                        return;
                      }
                    }
                    if (fileMention && e.key === "Escape") {
                      setFileMentionMenuDismissed(true);
                      return;
                    }
                    if (userHistory.length > 0) {
                      if (e.key === "ArrowUp") {
                        const textarea = textareaRef.current;
                        if (textarea) {
                          const cursorPos = textarea.selectionStart;
                          const textBeforeCursor = input.substring(0, cursorPos);
                          const isFirstLine = !textBeforeCursor.includes("\n");
                          if (isFirstLine) {
                            e.preventDefault();
                            if (historyIndex === -1) {
                              setSavedInput(input);
                            }
                            const newIndex = Math.min(historyIndex + 1, userHistory.length - 1);
                            setHistoryIndex(newIndex);
                            setInput(userHistory[newIndex]);
                            setTimeout(() => {
                              if (textareaRef.current) {
                                textareaRef.current.selectionStart = textareaRef.current.value.length;
                                textareaRef.current.selectionEnd = textareaRef.current.value.length;
                              }
                            }, 0);
                            return;
                          }
                        }
                      }
                      if (e.key === "ArrowDown") {
                        if (historyIndex >= 0) {
                          e.preventDefault();
                          const newIndex = historyIndex - 1;
                          setHistoryIndex(newIndex);
                          if (newIndex === -1) {
                            setInput(savedInput);
                          } else {
                            setInput(userHistory[newIndex]);
                          }
                          setTimeout(() => {
                            if (textareaRef.current) {
                              textareaRef.current.selectionStart = textareaRef.current.value.length;
                              textareaRef.current.selectionEnd = textareaRef.current.value.length;
                            }
                          }, 0);
                          return;
                        }
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false;
                  }}
                  placeholder="Ask Nova anything..."
                  rows={1}
                  style={{
                    width: "100%",
                    minHeight: 96,
                    resize: "none",
                    background: "transparent",
                    padding: "18px 20px 8px",
                    fontSize: 15,
                    color: "var(--color-text-primary)",
                    outline: "none",
                    lineHeight: 1.6,
                    fontFamily: "inherit",
                    border: "none",
                    overflow: "hidden",
                  }}
                />

                {/* Bottom toolbar */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px 12px",
                  }}
                >
                  <button
                    className="input-attach-button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 32,
                      height: 32,
                      borderRadius: 9,
                      color: "var(--color-text-muted)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    <Paperclip size={16} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files && files.length > 0) {
                        addFiles(files);
                      }
                      // Reset so same file can be selected again
                      e.target.value = "";
                    }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      position: "relative",
                    }}
                  >
                    {/* Model selector - show on homepage (no active agent) or when models are loaded */}
                    {(availableModels.length > 0 || !activeId) && (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className={`input-toolbar-control model-picker-trigger ${modelPickerOpen ? "model-picker-trigger-open" : ""}`}
                          onClick={() => setModelPickerOpen((open) => !open)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 10px",
                            borderRadius: 8,
                            fontSize: 11.5,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            maxWidth: 180,
                            overflow: "hidden",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                            <path d="M2 12h20" />
                          </svg>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {activeModelName}
                          </span>
                        </button>
                        {modelPickerOpen && (
                          <div
                            ref={modelPickerRef}
                            className="model-picker-popover"
                            style={{
                              position: "absolute",
                              right: 0,
                              bottom: 36,
                              width: 280,
                              maxHeight: 360,
                              overflowY: "auto",
                            }}
                          >
                            {(() => {
                              const grouped = new Map<string, AvailableModel[]>();
                              for (const m of availableModels) {
                                const arr = grouped.get(m.provider) ?? [];
                                arr.push(m);
                                grouped.set(m.provider, arr);
                              }
                              return Array.from(grouped.entries()).map(([provider, models]) => (
                                <div key={provider}>
                                  <div className="model-picker-provider" style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                                    {provider}
                                  </div>
                                  {models.map((m) => {
                                    const isActive = activeModelId === m.id;
                                    return (
                                      <button
                                        key={m.id}
                                        type="button"
                                        className={`model-picker-option ${isActive ? "model-picker-option-active" : ""}`}
                                        onClick={() => {
                                          if (activeAgent) {
                                            setModel(activeAgent.id, m.provider, m.id);
                                            updateAgent(activeAgent.id, { model: m.id, modelMeta: { id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning, images: m.images } });
                                          } else {
                                            // On homepage, save as default model for new agents
                                            setDefaultModel(m.id);
                                            setDefaultProvider(m.provider);
                                          }
                                          setModelPickerOpen(false);
                                        }}
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "space-between",
                                          width: "100%",
                                          padding: "6px 10px",
                                          borderRadius: 7,
                                          fontSize: 12,
                                          cursor: "pointer",
                                          textAlign: "left",
                                          transition: "all 0.12s ease",
                                        }}
                                      >
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                                        <span className="model-picker-context" style={{ fontSize: 10, flexShrink: 0, marginLeft: 8 }}>
                                          {m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(0)}M` : `${(m.contextWindow / 1000).toFixed(0)}K`}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              ));
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Worktree isolation - applies to the next agent in this project */}
                    {worktreeToggleVisible && (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className={`input-toolbar-control model-picker-trigger ${worktreePickerOpen ? "model-picker-trigger-open" : ""}`}
                          onClick={() => setWorktreePickerOpen((open) => !open)}
                          title={
                            worktreeAvailable
                              ? "让下一个 Agent 在自己的 git worktree 里工作"
                              : "当前项目不是 git 仓库，无法使用 worktree 隔离"
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 10px",
                            borderRadius: 8,
                            fontSize: 11.5,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            opacity: worktreeAvailable ? 1 : 0.5,
                          }}
                        >
                          <GitBranch size={12} style={{ flexShrink: 0 }} />
                          <span style={{ whiteSpace: "nowrap" }}>
                            {worktreeEnabled && worktreeAvailable ? "独立 worktree" : "共用目录"}
                          </span>
                        </button>
                        {worktreePickerOpen && (
                          <div
                            ref={worktreePickerRef}
                            className="model-picker-popover"
                            style={{ position: "absolute", right: 0, bottom: 36, width: 268 }}
                          >
                            <div className="model-picker-provider" style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                              新 Agent 的工作目录
                            </div>
                            <button
                              type="button"
                              className={`model-picker-option ${!worktreeEnabled || !worktreeAvailable ? "model-picker-option-active" : ""}`}
                              onClick={() => {
                                setWorktreeEnabled(false);
                                setWorktreePickerOpen(false);
                              }}
                              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, width: "100%", padding: "6px 10px" }}
                            >
                              <span>共用项目目录</span>
                              <span className="model-picker-context" style={{ fontSize: 10 }}>默认。改动直接写进项目</span>
                            </button>
                            <button
                              type="button"
                              disabled={!worktreeAvailable}
                              className={`model-picker-option ${worktreeEnabled && worktreeAvailable ? "model-picker-option-active" : ""}`}
                              onClick={() => {
                                setWorktreeEnabled(true);
                                setWorktreePickerOpen(false);
                              }}
                              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, width: "100%", padding: "6px 10px", opacity: worktreeAvailable ? 1 : 0.5 }}
                            >
                              <span>独立 git worktree</span>
                              <span className="model-picker-context" style={{ fontSize: 10 }}>并行 Agent 互不覆盖，改完再决定接受或丢弃</span>
                            </button>
                            {!worktreeAvailable && (
                              <div style={{ padding: "4px 10px 8px", fontSize: 10.5, opacity: 0.7 }}>
                                当前项目不是 git 仓库，无法使用 worktree 隔离
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Permission mode selector - per active agent session */}
                    {activeAgent && (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          className={`input-toolbar-control model-picker-trigger ${permissionPickerOpen ? "model-picker-trigger-open" : ""}`}
                          onClick={() => setPermissionPickerOpen((open) => !open)}
                          title="工具权限模式"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 10px",
                            borderRadius: 8,
                            fontSize: 11.5,
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <rect x="3" y="11" width="18" height="11" rx="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                          </svg>
                          <span style={{ whiteSpace: "nowrap" }}>
                            {TOOL_PERMISSION_MODES.find((m) => m.value === activeAgent.toolPermissionMode)?.label ?? activeAgent.toolPermissionMode}
                          </span>
                        </button>
                        {permissionPickerOpen && (
                          <div
                            ref={permissionPickerRef}
                            className="model-picker-popover"
                            style={{
                              position: "absolute",
                              right: 0,
                              bottom: 36,
                              width: 240,
                            }}
                          >
                            <div className="model-picker-provider" style={{ padding: "6px 10px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                              工具权限模式
                            </div>
                            {TOOL_PERMISSION_MODES.map((mode) => {
                              const isActive = activeAgent.toolPermissionMode === mode.value;
                              return (
                                <button
                                  key={mode.value}
                                  type="button"
                                  className={`model-picker-option ${isActive ? "model-picker-option-active" : ""}`}
                                  onClick={() => {
                                    setToolPermissionMode(activeAgent.id, mode.value);
                                    updateAgent(activeAgent.id, { toolPermissionMode: mode.value });
                                    setPermissionPickerOpen(false);
                                  }}
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    alignItems: "flex-start",
                                    gap: 1,
                                    width: "100%",
                                    padding: "6px 10px",
                                    borderRadius: 7,
                                    fontSize: 12,
                                    cursor: "pointer",
                                    textAlign: "left",
                                    transition: "all 0.12s ease",
                                  }}
                                >
                                  <span>{mode.label}</span>
                                  <span style={{ fontSize: 10.5, opacity: 0.65 }}>{mode.description}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className={`input-toolbar-control project-picker-trigger ${projectPickerOpen ? "project-picker-trigger-open" : ""}`}
                      onClick={() => setProjectPickerOpen((open) => !open)}
                      title="切换项目"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "5px 10px",
                        borderRadius: 8,
                        fontSize: 11.5,
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        maxWidth: 180,
                        overflow: "hidden",
                      }}
                    >
                      <FolderOpen size={12} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {inputProjectName}
                      </span>
                    </button>
                    {projectPickerOpen && (
                      <div
                        ref={projectPickerRef}
                        className="project-picker-popover"
                        style={{
                          position: "absolute",
                          left: 0,
                          bottom: 44,
                          minWidth: 240,
                          width: "max-content",
                          maxWidth: 500,
                          display: "flex",
                          flexDirection: "column",
                          maxHeight: "min(56vh, 420px)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          className="project-picker-title"
                          style={{
                            flexShrink: 0,
                            padding: "4px 8px 5px",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                          }}
                        >
                          选择项目
                        </div>
                        <div
                          style={{
                            flex: 1,
                            minHeight: 0,
                            overflowY: "auto",
                            overscrollBehavior: "contain",
                          }}
                        >
                          {availableProjectCwds.map((cwd) => {
                            const selected = cwd === inputProjectCwd;
                            return (
                              <button
                                key={cwd}
                                type="button"
                                onClick={() => {
                                  setPendingProjectCwd(cwd);
                                  setActiveAgent(null);
                                  setProjectPickerOpen(false);
                                }}
                                title={cwd}
                                className={`project-picker-option ${selected ? "project-picker-option-selected" : ""}`}
                              >
                                <FolderOpen size={12} style={{ flexShrink: 0 }} />
                                <span
                                  style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    fontSize: 12,
                                  }}
                                >
                                  {projectNames[cwd] ?? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            const selected = await open({
                              directory: true,
                              multiple: false,
                              title: "选择项目文件夹",
                            });
                            if (selected) {
                              setPendingProjectCwd(selected);
                              setActiveAgent(null);
                              setProjectPickerOpen(false);
                            }
                          }}
                          className="project-picker-option"
                          style={{
                            flexShrink: 0,
                            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                            marginTop: 4,
                            paddingTop: 8,
                          }}
                        >
                          <Plus size={12} style={{ flexShrink: 0 }} />
                          <span style={{ fontSize: 12 }}>创建新项目</span>
                        </button>
                      </div>
                    )}
                    {/* Abort button (visible during streaming) */}
                    {activeAgent?.status === "streaming" ? (
                      <button
                        className="input-action-button input-abort-button"
                        onClick={handleAbort}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          background: "#ef4444",
                          color: "#fff",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        <Square size={12} />
                      </button>
                    ) : (
                      <button
                        className="input-action-button input-send-button"
                        onClick={handleSubmit}
                        disabled={!input.trim() || isSending}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          background: "#8b93f5",
                          color: "#fff",
                          border: "none",
                          boxShadow: "0 2px 14px rgba(139, 147, 245, 0.45)",
                          opacity: input.trim() && !isSending ? 1 : 0.55,
                          cursor:
                            input.trim() && !isSending
                              ? "pointer"
                              : "not-allowed",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <ArrowUp size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
            </div>
            {!settingsOpen && conversationView === "chat" && showAgentWorkbench && (
              <div className="agent-workbench-triggers" aria-label="会话工具">
                <button
                  type="button"
                  className={`agent-workbench-trigger ${agentWorkbenchOpen && agentWorkbenchMode === "review" ? "agent-workbench-trigger-active" : ""}`}
                  onClick={() => { setAgentWorkbenchMode("review"); setExpandedReviewFiles((current) => { const valid = new Set([...current].filter((path) => cumulativeReviewFiles.some((file) => file.path === path))); if (valid.size === 0 && cumulativeReviewFiles[0]) valid.add(cumulativeReviewFiles[0].path); return valid; }); setAgentWorkbenchOpen((open) => agentWorkbenchMode === "review" ? !open : true); }}
                  aria-label="文件审查"
                >
                  <FileCode size={17} />
                  {cumulativeReviewFiles.length > 0 && <span className="agent-workbench-trigger-count">{cumulativeReviewFiles.length}</span>}
                  <span className="agent-workbench-trigger-tip">文件审查</span>
                </button>
                <button
                  type="button"
                  className={`agent-workbench-trigger ${agentWorkbenchOpen && agentWorkbenchMode === "temporary" ? "agent-workbench-trigger-active" : ""}`}
                  onClick={() => { setAgentWorkbenchMode("temporary"); setAgentWorkbenchOpen((open) => agentWorkbenchMode === "temporary" ? !open : true); }}
                  aria-label="临时提问"
                >
                  <MessageCircle size={17} />
                  <span className="agent-workbench-trigger-tip">临时提问</span>
                </button>
                <button
                  type="button"
                  className={`agent-workbench-trigger agent-workbench-agent-trigger ${activeDelegatedAgents.length > 0 ? "agent-workbench-trigger-running" : ""} ${agentWorkbenchOpen && agentWorkbenchMode === "agents" ? "agent-workbench-trigger-active" : ""}`}
                  onClick={() => { setAgentWorkbenchMode("agents"); setAgentWorkbenchOpen((open) => agentWorkbenchMode === "agents" ? !open : true); }}
                  aria-label={`子 Agent，${currentSubAgents.length} 个，${activeDelegatedAgents.length} 个进行中`}
                >
                  <Bot size={17} />
                  {currentSubAgents.length > 0 && <span className="agent-workbench-trigger-count">{currentSubAgents.length}</span>}
                  <span className="agent-workbench-trigger-tip">子 Agent · {activeDelegatedAgents.length} 进行中</span>
                </button>
                {activeAgent?.worktree && (
                  <button
                    type="button"
                    className={`agent-workbench-trigger ${agentWorkbenchOpen && agentWorkbenchMode === "worktree" ? "agent-workbench-trigger-active" : ""} ${activeAgent.worktree.state === "active" ? "agent-workbench-trigger-running" : ""}`}
                    onClick={() => { setAgentWorkbenchMode("worktree"); setAgentWorkbenchOpen((open) => agentWorkbenchMode === "worktree" ? !open : true); }}
                    aria-label="Worktree 审查"
                  >
                    <GitBranch size={17} />
                    <span className="agent-workbench-trigger-tip">Worktree 审查</span>
                  </button>
                )}
              </div>
            )}
            {!settingsOpen && conversationView === "chat" && showAgentWorkbench && agentWorkbenchOpen && (
              <>
                <div
                  className="conversation-dock-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="拖拽调整侧栏宽度"
                  onPointerDown={handleDockResizeStart}
                  onPointerMove={handleDockResizeMove}
                  onPointerUp={handleDockResizeEnd}
                  onPointerCancel={handleDockResizeEnd}
                />
                <aside className="conversation-task-summary">
                  {agentWorkbenchMode === "worktree" && activeAgent?.worktree ? (
                    <WorktreeReviewPanel
                      agent={activeAgent}
                      onCollapse={() => setAgentWorkbenchOpen(false)}
                      onResolved={(message) => {
                        void listAgents()
                          .then((infos) => syncAgents(infos))
                          .catch(() => undefined);
                        useNotificationStore.getState().push({
                          agentId: activeAgent.id,
                          agentName: agentDisplayName(activeAgent, agentNames),
                          status: "completed",
                          detail: message,
                        });
                      }}
                    />
                  ) : (
                    <BatchTaskPanel
                      sessionId={activeAgent?.id.replace(/^agent-/, "") ?? "unknown"}
                      onTemporaryAsk={handleTemporaryAsk}
                      onCollapse={() => setAgentWorkbenchOpen(false)}
                      mode={agentWorkbenchMode === "worktree" ? "review" : agentWorkbenchMode}
                      reviewFiles={cumulativeReviewFiles}
                      expandedReviewFiles={expandedReviewFiles}
                      onToggleReviewFile={toggleReviewFile}
                      childAgents={currentSubAgents}
                      agentNames={agentNames}
                      onSelectAgent={handleSelectAgent}
                      crossAgentWarning={crossAgentFileWarning}
                      onRevertAll={
                        activeAgent && cumulativeReviewFiles.length > 0 && activeAgent.status !== "stopped"
                          ? handleRevertAgentChanges
                          : undefined
                      }
                      revertAllBusy={reviewRevertBusy}
                    />
                  )}
                </aside>
              </>
            )}
          </div>
        </main>
        </div>
      </div>
      <NotificationToasts />
      {editingProject && (
        <div className="project-modal-backdrop" onMouseDown={() => setEditingProject(null)}>
          <div className="project-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-header">
              <div>
                <h3>Edit project</h3>
                <p>{editingProject.cwd}</p>
              </div>
              <button onClick={() => setEditingProject(null)} title="Close">
                <X size={16} />
              </button>
            </div>
            <label className="project-modal-field">
              <span>Project name</span>
              <input
                autoFocus
                value={editingProject.name}
                onChange={(event) =>
                  setEditingProject({ ...editingProject, name: event.target.value })
                }
              />
            </label>
            <div className="project-modal-actions">
              <button
                className="project-open-button"
                onClick={() => void openPath(editingProject.cwd)}
              >
                <ExternalLink size={14} />
                Open folder
              </button>
              <button
                className="project-save-button"
                disabled={!editingProject.name.trim()}
                onClick={() => {
                  const next = {
                    ...projectNames,
                    [editingProject.cwd]: editingProject.name.trim(),
                  };
                  localStorage.setItem(PROJECT_NAMES_KEY, JSON.stringify(next));
                  setProjectNames(next);
                  setEditingProject(null);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {editingAgent && (
        <div className="project-modal-backdrop" onMouseDown={() => setEditingAgent(null)}>
          <div className="project-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-header">
              <div>
                <h3>Edit agent</h3>
                <p>{editingAgent.id}</p>
              </div>
              <button onClick={() => setEditingAgent(null)} title="Close">
                <X size={16} />
              </button>
            </div>
            <label className="project-modal-field">
              <span>Agent name</span>
              <input
                autoFocus
                value={editingAgent.name}
                onChange={(event) =>
                  setEditingAgent({ ...editingAgent, name: event.target.value })
                }
              />
            </label>
            <div className="project-modal-actions project-modal-actions-end">
              <button
                className="project-save-button"
                disabled={!editingAgent.name.trim()}
                onClick={() => {
                  const next = {
                    ...agentNames,
                    [editingAgent.id]: editingAgent.name.trim(),
                  };
                  localStorage.setItem(AGENT_NAMES_KEY, JSON.stringify(next));
                  setAgentNames(next);
                  setEditingAgent(null);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {activeAgent?.pendingPermission && (
        <div className="project-modal-backdrop">
          <div className="project-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-header">
              <div>
                <h3>允许执行工具？</h3>
                <p style={{ fontFamily: "monospace", fontSize: 13 }}>{activeAgent.pendingPermission.toolName}</p>
              </div>
            </div>
            <div
              style={{
                maxHeight: 260,
                overflowY: "auto",
                margin: "8px 0 12px",
                padding: 10,
                borderRadius: 8,
                background: "var(--bg-tertiary, rgba(0,0,0,0.2))",
                fontSize: 11.5,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontFamily: "monospace",
              }}
            >
              {safePermissionArgsText(activeAgent.pendingPermission.args)}
            </div>
            <div className="project-modal-actions">
              <button
                className="project-open-button"
                onClick={() => {
                  void respondToolPermission(activeAgent.id, activeAgent.pendingPermission!.toolCallId, false);
                  updateAgent(activeAgent.id, { pendingPermission: null });
                }}
              >
                拒绝 (Esc)
              </button>
              <button
                className="agent-hide-confirm"
                onClick={() => {
                  void respondToolPermission(activeAgent.id, activeAgent.pendingPermission!.toolCallId, true);
                  updateAgent(activeAgent.id, { pendingPermission: null });
                }}
              >
                允许 (Enter)
              </button>
            </div>
          </div>
        </div>
      )}
      {hidingAgent && (
        <div className="project-modal-backdrop" onMouseDown={() => setHidingAgent(null)}>
          <div className="project-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-header">
              <div>
                <h3>Hide agent?</h3>
                <p>{agentDisplayName(hidingAgent, agentNames)}</p>
              </div>
              <button onClick={() => setHidingAgent(null)} title="Close">
                <X size={16} />
              </button>
            </div>
            <p className="project-modal-description">
              This only removes the conversation from the project sidebar. The Agent session and its history will not be deleted.
            </p>
            <div className="project-modal-actions">
              <button className="project-open-button" onClick={() => setHidingAgent(null)}>
                Cancel
              </button>
              <button
                className="agent-hide-confirm"
                onClick={() => {
                  const next = new Set(hiddenAgentIds).add(hidingAgent.id);
                  localStorage.setItem(HIDDEN_AGENTS_KEY, JSON.stringify(Array.from(next)));
                  setHiddenAgentIds(next);
                  let selectedId = activeId;
                  while (selectedId) {
                    if (selectedId === hidingAgent.id) {
                      setActiveAgent(null);
                      break;
                    }
                    selectedId = agentsById.get(selectedId)?.parentAgentId ?? null;
                  }
                  setHidingAgent(null);
                }}
              >
                Hide agent
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function safePermissionArgsText(args: unknown): string {
  if (args == null) return "(无参数)";
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}
