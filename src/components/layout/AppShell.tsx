import { useState, useRef, useCallback, useEffect } from "react";
import { Background } from "./Background";
import { useAgentStore, type AgentState } from "../../stores/agent-store";
import { useSettingsStore } from "../../stores/settings-store";
import { activateAgent, listAgents, spawnAgent, sendPrompt } from "../../lib/tauri-bridge";
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { ChatMessage } from "../chat/ChatMessage";
import { StreamingText } from "../chat/StreamingText";
import { ToolCallCard } from "../chat/ToolCallCard";
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
  const updateStatus = useAgentStore((s) => s.updateStatus);

  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
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
  const sidebarHoverModeRef = useRef(false);
  const sidebarHoverCloseTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

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
  const availableProjectCwds = Array.from(
    new Set([
      ...rootsByProject.keys(),
      ...(defaultCwd ? [defaultCwd] : []),
      inputProjectCwd,
    ]),
  );
  const streamingText = activeAgent?.streamingText ?? "";
  const conversationPairs = buildConversationPairs(activeAgent?.messages ?? []);
  const showConversationMinimap =
    conversationPairs.length >= CONVERSATION_MINIMAP_PAIR_THRESHOLD;
  const toolCallsSize = activeAgent?.activeToolCalls.size ?? 0;
  const messagesSize = activeAgent?.messages.length ?? 0;

  // Follow the conversation: keep scrolled to the bottom as content streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
    const keepSidebarClear = () => {
      if (!hasSidebarClearance(window.innerWidth)) {
        setSidebarOpen(false);
        sidebarHoverModeRef.current = false;
      }
    };
    keepSidebarClear();
    window.addEventListener("resize", keepSidebarClear);
    const observer = new ResizeObserver(keepSidebarClear);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", keepSidebarClear);
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
          status: info.status,
          cwd: info.cwd,
          model: info.model,
          messages: [],
          createdAt: info.created_at,
          messageCount: info.message_count,
          streamingText: "",
          activeToolCalls: new Map(),
        };
        addAgent(newAgent);
        agentId = info.id;
        setPendingProjectCwd(null);
      }

      // Add user message to UI immediately
      addUserMessage(agentId, text);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      // Send to agent via Tauri backend
      await sendPrompt(agentId, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send prompt:", msg);
      setError(msg);
      setTimeout(() => setError(null), 8000);
    } finally {
      setIsSending(false);
    }
  };

  const handleAbort = async () => {
    if (!activeId) return;
    try {
      updateStatus(activeId, "idle");
      // Abort is a no-op at the Tauri level for now;
      // the Rust backend would need to forward an abort command.
    } catch (err) {
      console.error("Failed to abort:", err);
    }
  };

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
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Failed to activate agent:", message);
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
                  Ship faster with Nova in{" "}
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
              <div className="w-full max-w-3xl py-6">
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
                    <ChatMessage message={msg} />
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
                {streamingText && <StreamingText content={streamingText} />}
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
              padding: "0 24px 56px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <div style={{ width: "100%", maxWidth: 640 }}>
              {/* Input card */}
              <div className="nova-input" style={{ overflow: "visible" }}>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    autoResize();
                  }}
                  onKeyDown={(e) => {
                    if (
                      isComposingRef.current ||
                      e.nativeEvent.isComposing ||
                      e.nativeEvent.keyCode === 229
                    ) {
                      return;
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
                        console.log(
                          "selected files:",
                          Array.from(files).map((f) => f.name),
                        );
                      }
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
                          background: "rgba(18, 20, 31, 0.98)",
                          border: "1px solid rgba(151, 159, 204, 0.18)",
                          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.42)",
                          backdropFilter: "blur(18px)",
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
                    <button
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 11px",
                        borderRadius: 8,
                        fontSize: 12.5,
                        color: "#9aa0b4",
                        background: "rgba(255, 255, 255, 0.05)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                        cursor: "pointer",
                      }}
                    >
                      <Sparkles size={13} style={{ color: "#a5b0fc" }} />
                      <span>High</span>
                      <ChevronDown size={13} style={{ color: "#6d7387" }} />
                    </button>

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
