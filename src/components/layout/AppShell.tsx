import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Background } from "./Background";
import { useAgentStore, type AgentState, type AvailableModel } from "../../stores/agent-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
  abortAgent,
  activateAgent,
  listAgents,
  listProjectFiles,
  spawnAgent,
  sendPrompt,
  setModel,
  requestAvailableModels,
  listAllModels,
  fetchModelsViaShell,
} from "../../lib/tauri-bridge";
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { ImageContent } from "../../lib/rpc-types";
import { ChatMessage } from "../chat/ChatMessage";
import { StreamingText } from "../chat/StreamingText";
import { ToolCallCard } from "../chat/ToolCallCard";
import { SlashCommandMenu } from "../chat/SlashCommandMenu";
import { FileMentionMenu } from "../chat/FileMentionMenu";
import { getOrAssignAgentAvatar } from "../../lib/agent-avatars";
import { matchingSlashCommands, type SlashCommand } from "../../lib/slash-commands";
import { findFileMention, insertFileMention } from "../../lib/file-mentions";
import {
  Paperclip,
  ArrowUp,
  Square,
  Home,
  FolderOpen,
  Pencil,
  Sparkles,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
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
} from "lucide-react";

const PROJECT_NAMES_KEY = "nova-studio.project-names";
const AGENT_NAMES_KEY = "nova-studio.agent-names";
const HIDDEN_AGENTS_KEY = "nova-studio.hidden-agents";
const SIDEBAR_LEFT = 56;
const SIDEBAR_WIDTH = 340;
const SIDEBAR_CONTENT_GAP = 20;
const CHAT_COLUMN_MAX_WIDTH = 768;
const PAGE_HORIZONTAL_PADDING = 24;
const CONVERSATION_MINIMAP_PAIR_THRESHOLD = 6;

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

/** Compact token count formatting, matching the TUI footer (e.g. 7.8k, 313k, 1.2M). */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
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

/** Merged session usage + context stats chip with hover breakdown. */
function SessionStats({ agent }: { agent: AgentState }) {
  const [contextHoverOpen, setContextHoverOpen] = useState(false);
  const su = agent.sessionUsage;
  const cu = agent.contextUsage;
  const live = agent.liveUsage;
  const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(0) + "k" : String(n));
  const r = 7;
  const circ = 2 * Math.PI * r;
  const model = agent.modelMeta;

  // Completed session totals + the in-flight turn's live usage.
  // For providers that only report usage at the end of the stream, estimate the
  // output tokens from the streamed text so the counter rolls live as tokens appear.
  const estimatedLiveOutput = Math.round(agent.streamingText.length / 4);
  const liveOutput = Math.max(live?.output ?? 0, estimatedLiveOutput);
  const totalInput = (su?.input ?? 0) + (live?.input ?? 0);
  const totalOutput = (su?.output ?? 0) + liveOutput;
  const totalCacheRead = (su?.cacheRead ?? 0) + (live?.cacheRead ?? 0);
  const totalCacheWrite = (su?.cacheWrite ?? 0) + (live?.cacheWrite ?? 0);

  // Live context occupancy. cu.tokens already includes the last turn's output
  // (input + output + cacheRead + cacheWrite); add the in-flight turn's new
  // input + output so Used context grows in real time as tokens stream.
  const baseContextTokens = cu?.tokens ?? 0;
  const usedContextTokens = baseContextTokens + (live?.input ?? 0) + liveOutput;
  const contextWindow = cu?.contextWindow ?? 0;
  const pct = contextWindow > 0 ? (usedContextTokens / contextWindow) * 100 : null;
  const color = pct == null ? "#8a90a4" : pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#818cf8";
  const dash = pct != null ? (pct / 100) * circ : 0;

  // Rolling token counters for ↑↓
  const rollingInput = useRollingNumber(totalInput);
  const rollingOutput = useRollingNumber(totalOutput);

  const parts: string[] = [];
  if (totalInput > 0) parts.push(`↑${formatTokens(Math.round(rollingInput))}`);
  if (totalOutput > 0) parts.push(`↓${formatTokens(Math.round(rollingOutput))}`);

  // Cache hit rate (no "CH" prefix) — shown inline and in the hover breakdown
  const latestPromptTokens = totalInput + totalCacheRead + totalCacheWrite;
  const cacheHitRate = latestPromptTokens > 0 ? (totalCacheRead / latestPromptTokens) * 100 : undefined;
  const hasCache = totalCacheRead > 0 || totalCacheWrite > 0;
  if (hasCache && cacheHitRate !== undefined) {
    parts.push(`${cacheHitRate.toFixed(1)}%`);
  }

  const showRing = pct != null;
  const showTokens = parts.length > 0;
  if (!showRing && !showTokens) return null;
  const statsText = parts.join(" ");

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px 4px 6px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
        cursor: "default",
        userSelect: "none",
      }}
      onMouseEnter={() => setContextHoverOpen(true)}
      onMouseLeave={() => setContextHoverOpen(false)}
    >
      {showRing && (
        <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
          <circle cx="9" cy="9" r={r} fill="none" stroke={`${color}25`} strokeWidth="2" />
          <circle
            cx="9" cy="9" r={r}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ - dash}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      )}
      {pct != null && (
        <span style={{ fontSize: 11, color, fontWeight: 500, whiteSpace: "nowrap" }}>
          {pct.toFixed(1)}%
        </span>
      )}
      {showTokens && (
        <span style={{ fontSize: 11, color: "#8a90a4", whiteSpace: "nowrap" }}>{statsText}</span>
      )}
      {contextHoverOpen && cu && (
        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 36,
            zIndex: 50,
            width: 260,
            padding: "12px 14px",
            borderRadius: 10,
            background: "rgba(18, 20, 31, 0.92)",
            border: "1px solid rgba(151, 159, 204, 0.18)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
            backdropFilter: "blur(16px)",
            fontSize: 11.5,
            color: "#c0c4d6",
            lineHeight: 1.6,
          }}
        >
          {model && (
            <div style={{ color: "#e5e8ff", fontWeight: 600, marginBottom: 8, fontSize: 12 }}>
              {model.name}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Used context</span>
            <span style={{ color: color, fontWeight: 600 }}>
              {fmtK(usedContextTokens)} / {fmtK(contextWindow)}
            </span>
          </div>
          {hasCache && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Cache hit rate</span>
                <span
                  style={{
                    color:
                      cacheHitRate != null
                        ? cacheHitRate > 90
                          ? "#34d399"
                          : cacheHitRate > 70
                            ? "#f59e0b"
                            : "#818cf8"
                        : "#8a90a4",
                    fontWeight: 600,
                  }}
                >
                  {cacheHitRate != null ? `${cacheHitRate.toFixed(1)}%` : "—"}
                </span>
              </div>
            </>
          )}
          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "6px 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", color: "#8a90a4" }}>
            <span>Available</span>
            <span>{fmtK(Math.max(0, contextWindow - usedContextTokens))}</span>
          </div>
        </div>
      )}
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

function hasSidebarClearance(viewportWidth: number): boolean {
  const contentWidth = Math.min(
    CHAT_COLUMN_MAX_WIDTH,
    Math.max(0, viewportWidth - PAGE_HORIZONTAL_PADDING * 2),
  );
  const contentLeft = (viewportWidth - contentWidth) / 2;
  const sidebarRight = SIDEBAR_LEFT + SIDEBAR_WIDTH;
  return sidebarRight + SIDEBAR_CONTENT_GAP <= contentLeft;
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

function agentStatusMeta(status: AgentState["status"]): {
  label: string;
  className: string;
  dot: string;
} {
  switch (status) {
    case "streaming":
      return { label: "Running", className: "running", dot: "#fbbf24" };
    case "idle":
      return { label: "Ready", className: "ready", dot: "#34d399" };
    case "starting":
      return { label: "Starting", className: "waiting", dot: "#60a5fa" };
    case "error":
      return { label: "Error", className: "error", dot: "#f87171" };
    case "stopped":
      return { label: "Stopped", className: "stopped", dot: "#6b7280" };
  }
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

function AgentTreeNode({
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
  const status = agentStatusMeta(agent.status);
  const isActive = agent.id === activeId;
  const isChild = depth > 0;

  return (
    <div className={`agent-tree-node ${depth > 0 ? "agent-tree-child" : ""}`}>
      <button
        onClick={() => onSelect(agent.id)}
        className={`agent-card ${isChild ? "agent-card-child" : ""} ${isActive ? "agent-card-active" : ""}`}
      >
        <span className="agent-tile">
          <Sparkles
            size={isChild ? 15 : 20}
            style={{ color: isActive ? "#c4caff" : "#8d95c5" }}
          />
          <span
            className={`agent-dot ${agent.status === "streaming" ? "animate-pulse" : ""}`}
            style={{ background: status.dot }}
          />
        </span>
        <span className="agent-text">
          <span className="agent-name">{agentDisplayName(agent, agentNames)}</span>
          {!isChild && (
            <span className="agent-sub" title={agent.cwd}>
              {agentSubtitle(agent)}
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
}

export function AppShell() {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const addAgent = useAgentStore((s) => s.addAgent);
  const syncAgents = useAgentStore((s) => s.syncAgents);
  const addUserMessage = useAgentStore((s) => s.addUserMessage);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const availableModels = useAgentStore((s) => s.availableModels);

  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);


  const [input, setInput] = useState("");
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [slashCommandMenuDismissed, setSlashCommandMenuDismissed] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [fileMentionMenuDismissed, setFileMentionMenuDismissed] = useState(false);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [selectedProjectFileIndex, setSelectedProjectFileIndex] = useState(0);
  const [selectedFileReferences, setSelectedFileReferences] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  // Keep ref in sync for cleanup on unmount
  useEffect(() => { attachmentsRef.current = pendingAttachments; }, [pendingAttachments]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [savedInput, setSavedInput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
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
  const inputCardRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const sidebarHoverModeRef = useRef(false);
  const sidebarHoverCloseTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const isAgentHidden = (agent: AgentState): boolean => {
    if (hiddenAgentIds.has(agent.id)) return true;
    let parentId = agent.parentAgentId;
    while (parentId) {
      if (hiddenAgentIds.has(parentId)) return true;
      parentId = agentsById.get(parentId)?.parentAgentId ?? null;
    }
    return false;
  };
  const visibleAgents = agents.filter((agent) => !isAgentHidden(agent));
  const visibleAgentsById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const activeAgent = visibleAgents.find((a) => a.id === activeId);
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
  const childrenByParent = new Map<string, AgentState[]>();
  for (const agent of visibleAgents) {
    if (!agent.parentAgentId || !visibleAgentsById.has(agent.parentAgentId)) continue;
    const siblings = childrenByParent.get(agent.parentAgentId) ?? [];
    siblings.push(agent);
    childrenByParent.set(agent.parentAgentId, siblings);
  }
  const rootAgents = visibleAgents.filter(
    (agent) => !agent.parentAgentId || !visibleAgentsById.has(agent.parentAgentId),
  );
  const rootsByProject = new Map<string, AgentState[]>();
  for (const agent of rootAgents) {
    const projectAgents = rootsByProject.get(agent.cwd) ?? [];
    projectAgents.push(agent);
    rootsByProject.set(agent.cwd, projectAgents);
  }
  const hasMessages =
    (activeAgent?.messages.length ?? 0) > 0 ||
    (activeAgent?.messageCount ?? 0) > 0;
  // Home is a new conversation inside a concrete project, never a
  // project-less scratchpad. Prefer an explicitly selected/default project,
  // then the most recently used project, and finally the user's home folder.
  const welcomeProjectCwd =
    pendingProjectCwd || defaultCwd || agents[0]?.cwd || "~";
  const inputProjectCwd = activeAgent?.cwd ?? welcomeProjectCwd;
  const conversationParent = activeAgent?.parentAgentId
    ? agentsById.get(activeAgent.parentAgentId)
    : undefined;
  const conversationUserLabel = conversationParent
    ? agentDisplayName(conversationParent, agentNames)
    : activeAgent?.parentAgentId
      ? (agentNames[activeAgent.parentAgentId] ?? "Parent Agent")
      : "You";
  const availableProjectCwds = Array.from(
    new Set([
      ...rootsByProject.keys(),
      ...(defaultCwd ? [defaultCwd] : []),
      inputProjectCwd,
    ]),
  );
  const streamingText = activeAgent?.streamingText ?? "";
  const slashCommands = slashCommandMenuDismissed ? [] : matchingSlashCommands(input);
  const fileMention = fileMentionMenuDismissed ? null : findFileMention(input, cursorPosition);
  const conversationPairs = buildConversationPairs(activeAgent?.messages ?? []);
  const showConversationMinimap =
    conversationPairs.length >= CONVERSATION_MINIMAP_PAIR_THRESHOLD;
  const toolCallsSize = activeAgent?.activeToolCalls.size ?? 0;
  const messagesSize = activeAgent?.messages.length ?? 0;

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

  // Follow the conversation: keep scrolled to the bottom as content streams in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messagesSize, streamingText, toolCallsSize]);

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
    if (slashCommands.length === 0 && !fileMention) return;
    const dismissSlashCommands = (event: MouseEvent) => {
      if (!inputCardRef.current?.contains(event.target as Node)) {
        setSlashCommandMenuDismissed(true);
        setFileMentionMenuDismissed(true);
      }
    };
    document.addEventListener("mousedown", dismissSlashCommands);
    return () => document.removeEventListener("mousedown", dismissSlashCommands);
  }, [slashCommands.length, fileMention]);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      if (!hasSidebarClearance(window.innerWidth)) {
        setSidebarOpen(false);
        sidebarHoverModeRef.current = false;
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    const observer = new ResizeObserver(handleResize);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", handleResize);
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      if (sidebarHoverCloseTimerRef.current !== null) {
        window.clearTimeout(sidebarHoverCloseTimerRef.current);
      }
    },
    [],
  );

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

    // Always fetch all models via the Rust command (uses absolute CLI path,
    // works without a running agent). Populates the homepage model picker.
    void listAllModels()
      .then((models) => {
        const mapped: AvailableModel[] = (models ?? []).map((m) => ({
          id: String(m.id ?? ""),
          name: String(m.name ?? ""),
          provider: String(m.provider ?? ""),
          contextWindow: Number(m.contextWindow ?? 0),
          maxTokens: Number(m.maxTokens ?? 0),
          reasoning: Boolean(m.reasoning),
          images: Boolean(m.images),
        }));
        if (mapped.length > 0) {
          useAgentStore.setState({ availableModels: mapped });
        } else {
          // Fallback: try via shell
          void fetchModelsViaShell()
            .then((shellModels) => {
              const mapped2: AvailableModel[] = (shellModels ?? []).map((m) => ({
                id: String(m.id ?? ""),
                name: String(m.name ?? ""),
                provider: String(m.provider ?? ""),
                contextWindow: Number(m.contextWindow ?? 0),
                maxTokens: Number(m.maxTokens ?? 0),
                reasoning: Boolean(m.reasoning),
                images: Boolean(m.images),
              }));
              if (mapped2.length > 0) {
                useAgentStore.setState({ availableModels: mapped2 });
              }
            })
            .catch((err) =>
              console.error("Failed to fetch models via shell:", err)
            );
        }
      })
      .catch((err) => {
        console.error("[AppShell] listAllModels failed:", err);
        void fetchModelsViaShell()
          .then((shellModels) => {
            const mapped2: AvailableModel[] = (shellModels ?? []).map((m) => ({
              id: String(m.id ?? ""),
              name: String(m.name ?? ""),
              provider: String(m.provider ?? ""),
              contextWindow: Number(m.contextWindow ?? 0),
              maxTokens: Number(m.maxTokens ?? 0),
              reasoning: Boolean(m.reasoning),
              images: Boolean(m.images),
            }));
            if (mapped2.length > 0) {
              useAgentStore.setState({ availableModels: mapped2 });
            }
          })
          .catch((err2) =>
            console.error("Failed to fetch models via shell:", err2)
          );
      });
  }, []);

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
        );

        const newAgent: AgentState = {
          id: info.id,
          parentAgentId: info.parent_agent_id,
          name: null,
          avatarId: getOrAssignAgentAvatar(info.id),
          status: info.status,
          cwd: info.cwd,
          model: info.model,
          messages: [],
          createdAt: info.created_at,
          messageCount: info.message_count,
          streamingText: "",
          activeToolCalls: new Map(),
          modelMeta: null,
          contextUsage: null,
          lastTurnUsage: null,
          sessionUsage: null,
          autoCompactionEnabled: true,
          liveUsage: null,
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
      await sendPrompt(
        agentId,
        finalMessage,
        images.length > 0 ? images : undefined,
        fileReferences.length > 0 ? fileReferences : undefined,
      );
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

  const handleSelectAgent = (agentId: string) => {
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
  };

  const handleToggleSidebar = () => {
    const willOpen = !sidebarOpen;
    if (willOpen && !hasSidebarClearance(window.innerWidth)) {
      setSidebarOpen(false);
      return;
    }
    setSidebarOpen(willOpen);
    if (willOpen) {
      void listAgents()
        .then(syncAgents)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Failed to refresh sessions:", message);
          setError(message);
        });
    }
  };

  const handleSidebarHoverEnter = () => {
    if (sidebarHoverCloseTimerRef.current !== null) {
      window.clearTimeout(sidebarHoverCloseTimerRef.current);
      sidebarHoverCloseTimerRef.current = null;
    }
    if (!hasSidebarClearance(window.innerWidth)) {
      sidebarHoverModeRef.current = true;
      setSidebarOpen(true);
    }
  };

  const handleSidebarHoverLeave = () => {
    if (!sidebarHoverModeRef.current) return;
    sidebarHoverCloseTimerRef.current = window.setTimeout(() => {
      setSidebarOpen(false);
      sidebarHoverModeRef.current = false;
      sidebarHoverCloseTimerRef.current = null;
    }, 100);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      <Background />

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

      <div className="relative z-10 flex h-full flex-col">
        {/* Top nav bar */}
        <div
          style={{
            flexShrink: 0,
            width: "100%",
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 18px 0 12px",
            zIndex: 20,
          }}
        >
          {/* Primary navigation stays at the far-left edge; branding follows it. */}
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: "0.01em",
                color: "#eef0f8",
              }}
            >
              <Sparkles size={17} style={{ color: "#b9c1ff" }} />
              Nova Studio
            </div>
            <nav
              aria-label="Primary navigation"
              style={{
                position: "fixed",
                zIndex: 32,
                left: 8,
                top: 72,
                display: "flex",
                width: 48,
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <button
                onClick={() => setActiveAgent(null)}
                title="Home"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 48,
                  height: 42,
                  padding: 0,
                  borderRadius: 12,
                  fontSize: 13,
                  fontWeight: activeId === null ? 500 : 400,
                  color: activeId === null ? "#eef0f8" : "#7b8197",
                  background: activeId === null ? "rgba(255, 255, 255, 0.07)" : "transparent",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <Home size={15} />
              </button>
              <button
                onClick={handleToggleSidebar}
                onMouseEnter={handleSidebarHoverEnter}
                onMouseLeave={handleSidebarHoverLeave}
                title="Projects"
                className={sidebarOpen ? "top-nav-active" : ""}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 48,
                  height: 42,
                  padding: 0,
                  borderRadius: 12,
                  fontSize: 13,
                  color: sidebarOpen ? "#eef0f8" : "#7b8197",
                  background: sidebarOpen ? "rgba(255, 255, 255, 0.07)" : "transparent",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  cursor: "pointer",
                }}
              >
                {sidebarOpen ? <PanelLeftClose size={15} /> : <FolderOpen size={15} />}
              </button>
            </nav>
          </div>

        </div>

        {/* Body row: sidebar + main */}
        <div className="relative flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside
          onMouseEnter={handleSidebarHoverEnter}
          onMouseLeave={handleSidebarHoverLeave}
          className={`glass-panel absolute z-20 top-0 bottom-3 left-[56px] p-4 flex flex-col ${
            sidebarOpen ? "w-[280px]" : "hidden"
          }`}
          style={!hasSidebarClearance(windowWidth) ? { backgroundColor: "rgba(10, 12, 24, 0.95)" } : undefined}
        >
          {sidebarOpen && (
            <>
              <div className="sidebar-section-title">
                <span className="sidebar-section-icon">
                  <FolderOpen size={14} />
                </span>
                <span>项目</span>
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
                            onEdit={(agent) =>
                              setEditingAgent({
                                id: agent.id,
                                name: agentDisplayName(agent, agentNames),
                              })
                            }
                            onHide={setHidingAgent}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
        </aside>

        {/* Main */}
        <main className="relative w-full flex flex-col overflow-hidden">
          {/* Content area */}
          <div
            ref={scrollRef}
            className={`flex-1 overflow-y-auto flex flex-col items-center px-6 ${
              !hasMessages ? "justify-center" : "justify-start"
            }`}
          >
            {!hasMessages ? (
              /* Empty state — tagline */
              <div
                className="text-center max-w-4xl w-full animate-fade-in-up"
                style={{ marginTop: "4vh" }}
              >
                {/* Floating sparkle */}
                <div className="flex justify-center" style={{ marginBottom: 32 }}>
                  <svg
                    className="hero-icon-glow"
                    width="64"
                    height="64"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.1}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z"
                    />
                  </svg>
                </div>

                {/* Tagline */}
                <h2
                  className="hero-title"
                  style={{
                    fontSize: 44,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.15,
                  }}
                >
                  Ship faster with Nova{agentsLoaded && (
                    <>
                      {" in "}
                      <span
                        style={{
                          position: "relative",
                          display: "inline-block",
                        }}
                      >
                        <span
                          style={{
                            background: "linear-gradient(135deg, #a78bfa, #818cf8, #60a5fa)",
                            WebkitBackgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                            textShadow: "0 0 40px rgba(129, 140, 248, 0.5)",
                          }}
                        >
                          {projectNames[inputProjectCwd] ?? inputProjectCwd.split(/[\\/]/).filter(Boolean).pop() ?? inputProjectCwd}
                        </span>
                    <span
                      style={{
                        position: "absolute",
                        bottom: -2,
                        left: 0,
                        right: 0,
                        height: 2,
                        background: "linear-gradient(90deg, #818cf8, #60a5fa)",
                        borderRadius: 1,
                      }}
                    />
                  </span>.
                    </>
                  )}
                </h2>
                <p
                  style={{
                    marginTop: 16,
                    fontSize: 15,
                    color: "#7d8398",
                    letterSpacing: "0.01em",
                  }}
                >
                  From idea to code, from concept to creation.
                </p>
              </div>
            ) : (
              /* Messages view */
              <div
                className="w-full max-w-3xl pt-6"
                style={{ paddingBottom: 48 }}
              >
                {activeAgent && activeAgent.messages.length === 0 && (
                  <div
                    style={{
                      padding: "28px 0",
                      color: "#7d8398",
                      fontSize: 13,
                      textAlign: "center",
                    }}
                  >
                    Loading conversation…
                  </div>
                )}
                {activeAgent?.messages.map((msg) => (
                  <div
                    key={msg.id}
                    id={msg.role === "user" ? `conversation-turn-${msg.id}` : undefined}
                    style={{ scrollMarginTop: 24 }}
                  >
                    <ChatMessage
                      message={msg}
                      userLabel={conversationUserLabel}
                      avatarId={activeAgent.avatarId}
                    />
                  </div>
                ))}

                {/* Active tool calls */}
                {activeAgent &&
                  Array.from(activeAgent.activeToolCalls.values()).map((tc) => (
                    <div key={tc.id} className="msg-row msg-row-tool">
                      <ToolCallCard
                        name={tc.name}
                        status={tc.status}
                        args={tc.args}
                        result={tc.result}
                      />
                    </div>
                  ))}

                {/* Streaming text */}
                {streamingText && activeAgent && (
                  <StreamingText content={streamingText} avatarId={activeAgent.avatarId} />
                )}
              </div>
            )}
          </div>

          {showConversationMinimap && (
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
            style={{
              flexShrink: 0,
              padding: "60px 24px 56px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <div style={{ width: "100%", maxWidth: 640 }}>
              {/* Input card */}
              <div
                ref={inputCardRef}
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
                        style={{
                          position: "relative",
                          width: att.isImage ? 64 : "auto",
                          maxWidth: 200,
                          borderRadius: 8,
                          overflow: "hidden",
                          border: "1px solid rgba(255,255,255,0.1)",
                          background: "rgba(255,255,255,0.05)",
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
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 10px",
                              fontSize: 11,
                              color: "#d1d5db",
                            }}
                          >
                            <IconComp size={14} color={typeInfo.color} style={{ flexShrink: 0 }} />
                            <span
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
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
                          onClick={() => removeAttachment(att.id)}
                          style={{
                            position: "absolute",
                            top: 2,
                            right: 2,
                            width: 18,
                            height: 18,
                            borderRadius: "50%",
                            background: "rgba(0,0,0,0.7)",
                            border: "none",
                            color: "#fff",
                            fontSize: 10,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: 0,
                          }}
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
                {fileMention && (
                  <FileMentionMenu
                    files={projectFiles}
                    loading={projectFilesLoading}
                    selectedIndex={Math.min(selectedProjectFileIndex, Math.max(0, projectFiles.length - 1))}
                    onSelectedIndexChange={setSelectedProjectFileIndex}
                    onSelect={selectProjectFile}
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
                    color: "#eceef6",
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
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 32,
                      height: 32,
                      borderRadius: 9,
                      color: "#6d7387",
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
                    {/* Session usage + context (merged TUI-footer style) */}
                    {activeAgent && <SessionStats agent={activeAgent} />}
                    {/* Model selector - show on homepage (no active agent) or when models are loaded */}
                    {(availableModels.length > 0 || !activeId) && (
                      <div style={{ position: "relative" }}>
                        <button
                          type="button"
                          onClick={() => setModelPickerOpen((open) => !open)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 10px",
                            borderRadius: 8,
                            fontSize: 11.5,
                            color: modelPickerOpen ? "#d5d9ff" : "#8a90a4",
                            background: modelPickerOpen ? "rgba(129, 140, 248, 0.12)" : "rgba(255, 255, 255, 0.05)",
                            border: "1px solid rgba(255, 255, 255, 0.08)",
                            cursor: "pointer",
                            transition: "all 0.15s ease",
                            maxWidth: 180,
                            overflow: "hidden",
                          }}
                          onMouseEnter={(e) => {
                            if (!modelPickerOpen) {
                              e.currentTarget.style.background = "rgba(129, 140, 248, 0.1)";
                              e.currentTarget.style.color = "#b9c1ff";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!modelPickerOpen) {
                              e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
                              e.currentTarget.style.color = "#8a90a4";
                            }
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
                            style={{
                              position: "absolute",
                              right: 0,
                              bottom: 36,
                              zIndex: 50,
                              width: 280,
                              maxHeight: 360,
                              overflowY: "auto",
                              padding: 4,
                              borderRadius: 12,
                              background: "rgba(20, 22, 34, 0.6)",
                              border: "1px solid rgba(255, 255, 255, 0.12)",
                              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
                              backdropFilter: "blur(24px) saturate(150%)",
                              WebkitBackdropFilter: "blur(24px) saturate(150%)",
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
                                  <div style={{ padding: "6px 10px 3px", fontSize: 10, color: "#5a6078", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                                    {provider}
                                  </div>
                                  {models.map((m) => {
                                    const isActive = activeModelId === m.id;
                                    return (
                                      <button
                                        key={m.id}
                                        type="button"
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
                                          color: isActive ? "#e5e8ff" : "#a2a8bb",
                                          background: isActive ? "rgba(124, 133, 224, 0.14)" : "transparent",
                                          border: "none",
                                          cursor: "pointer",
                                          textAlign: "left",
                                          transition: "all 0.12s ease",
                                        }}
                                        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(129, 140, 248, 0.1)"; }}
                                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
                                      >
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                                        <span style={{ fontSize: 10, color: "#5a6078", flexShrink: 0, marginLeft: 8 }}>
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
                    <button
                      type="button"
                      onClick={() => setProjectPickerOpen((open) => !open)}
                      title="切换项目"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "5px 10px",
                        borderRadius: 8,
                        fontSize: 11.5,
                        color: projectPickerOpen ? "#d5d9ff" : "#8a90a4",
                        background: projectPickerOpen ? "rgba(129, 140, 248, 0.12)" : "rgba(255, 255, 255, 0.05)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        maxWidth: 180,
                        overflow: "hidden",
                      }}
                      onMouseEnter={(e) => {
                        if (!projectPickerOpen) {
                          e.currentTarget.style.background = "rgba(129, 140, 248, 0.1)";
                          e.currentTarget.style.color = "#b9c1ff";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!projectPickerOpen) {
                          e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
                          e.currentTarget.style.color = "#8a90a4";
                        }
                      }}
                    >
                      <FolderOpen size={12} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {projectNames[inputProjectCwd] ?? inputProjectCwd.split(/[\\/]/).filter(Boolean).pop() ?? inputProjectCwd}
                      </span>
                    </button>
                    {projectPickerOpen && (
                      <div
                        ref={projectPickerRef}
                        style={{
                          position: "absolute",
                          left: 0,
                          bottom: 44,
                          zIndex: 40,
                          padding: 4,
                          borderRadius: 10,
                          background: "rgba(18, 20, 31, 0.45)",
                          border: "1px solid rgba(151, 159, 204, 0.2)",
                          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.3)",
                          backdropFilter: "blur(24px) saturate(1.4)",
                          minWidth: 240,
                          width: "max-content",
                          maxWidth: 500,
                        }}
                      >
                        <div
                          style={{
                            padding: "4px 8px 5px",
                            color: "#6f758a",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                          }}
                        >
                          选择项目
                        </div>
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
                              <FolderOpen
                                size={12}
                                style={{ color: selected ? "#aeb6ff" : "#777e95", flexShrink: 0 }}
                              />
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
                            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                            marginTop: 4,
                            paddingTop: 8,
                          }}
                        >
                          <Plus size={12} style={{ color: "#a5b0fc", flexShrink: 0 }} />
                          <span style={{ fontSize: 12, color: "#a5b0fc" }}>创建新项目</span>
                        </button>
                      </div>
                    )}
                    {/* Abort button (visible during streaming) */}
                    {activeAgent?.status === "streaming" ? (
                      <button
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
        </main>
        </div>
      </div>
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
