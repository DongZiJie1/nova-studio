import { useState, useRef, useCallback, useEffect } from "react";
import { Background } from "./Background";
import { useAgentStore, type AgentState } from "../../stores/agent-store";
import { useSettingsStore } from "../../stores/settings-store";
import { activateAgent, spawnAgent, sendPrompt } from "../../lib/tauri-bridge";
import { openPath } from "@tauri-apps/plugin-opener";
import { ChatMessage } from "../chat/ChatMessage";
import { StreamingText } from "../chat/StreamingText";
import { ToolCallCard } from "../chat/ToolCallCard";
import {
  Paperclip,
  ArrowUp,
  Square,
  Home,
  FolderOpen,
  Code,
  Pencil,
  Lightbulb,
  Bug,
  BarChart3,
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
  return agent.model ?? `Agent ${agent.id.replace(/^agent-/, "")}`;
}

function agentSubtitle(agent: AgentState): string {
  if (!agent.parentAgentId) {
    return `Main coordinator · ${agent.id.replace(/^agent-/, "")}`;
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
  const addUserMessage = useAgentStore((s) => s.addUserMessage);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const updateStatus = useAgentStore((s) => s.updateStatus);

  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const hasMessages = (activeAgent?.messages.length ?? 0) > 0;
  const streamingText = activeAgent?.streamingText ?? "";
  const toolCallsSize = activeAgent?.activeToolCalls.size ?? 0;
  const messagesSize = activeAgent?.messages.length ?? 0;

  // Follow the conversation: keep scrolled to the bottom as content streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messagesSize, streamingText, toolCallsSize]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    setIsSending(true);

    try {
      let agentId = activeId;

      // Spawn agent if none exists
      if (!agentId) {
        const cwd = (pendingProjectCwd ?? defaultCwd) || "~";
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
    void activateAgent(agentId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to activate agent:", message);
      setError(message);
    });
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
            padding: "0 28px",
            zIndex: 20,
          }}
        >
          {/* Logo */}
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
            <nav style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                onClick={() => setActiveAgent(null)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 16px",
                  borderRadius: 999,
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
                Home
              </button>
              <button
                onClick={() => setSidebarOpen((open) => !open)}
                className={sidebarOpen ? "top-nav-active" : ""}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 16px",
                  borderRadius: 999,
                  fontSize: 13,
                  color: sidebarOpen ? "#eef0f8" : "#7b8197",
                  background: sidebarOpen ? "rgba(255, 255, 255, 0.07)" : "transparent",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  cursor: "pointer",
                }}
              >
                {sidebarOpen ? <PanelLeftClose size={15} /> : <FolderOpen size={15} />}
                Projects
              </button>
            </nav>
          </div>

          {/* User avatar */}
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "rgba(255, 255, 255, 0.07)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 600,
              color: "#9aa0b4",
            }}
          >
            N
          </div>
        </div>

        {/* Body row: sidebar + main */}
        <div className="relative flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside
          className={`glass-panel absolute z-20 top-0 bottom-3 left-3 p-4 flex flex-col ${
            sidebarOpen ? "w-[340px]" : "hidden"
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
        <main className="w-full flex flex-col overflow-hidden">
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
                className="text-center max-w-2xl w-full animate-fade-in-up"
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
                  Ship faster with Nova.
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
                {activeAgent?.messages.map((msg) => (
                  <ChatMessage key={msg.id} message={msg} />
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
              {/* Project path */}
              {activeAgent && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    fontSize: 12,
                    color: "#6b7186",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
                    />
                  </svg>
                  <span>{activeAgent.cwd}</span>
                </div>
              )}

              {/* Input card */}
              <div className="nova-input" style={{ overflow: "hidden" }}>
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
                      gap: 10,
                    }}
                  >
                    <button
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 13px",
                        borderRadius: 999,
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

              {/* Action buttons */}
              {!hasMessages && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    marginTop: 18,
                  }}
                >
                  {[
                    { icon: Code, label: "Code", color: "#60a5fa" },
                    { icon: Pencil, label: "Design", color: "#a78bfa" },
                    { icon: Lightbulb, label: "Brainstorm", color: "#fbbf24" },
                    { icon: Bug, label: "Debug", color: "#f87171" },
                    { icon: BarChart3, label: "Analyze", color: "#34d399" },
                  ].map(({ icon: Icon, label, color }) => (
                    <button
                      key={label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "8px 18px",
                        borderRadius: 999,
                        fontSize: 13,
                        color: "#b7bdc9",
                        background: "rgba(255, 255, 255, 0.035)",
                        border: "1px solid rgba(255, 255, 255, 0.07)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <Icon size={14} style={{ color }} />
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Keyboard shortcut hint */}
              {!hasMessages && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    marginTop: 18,
                    fontSize: 12,
                    color: "#626879",
                  }}
                >
                  <kbd
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 24,
                      height: 24,
                      padding: "0 6px",
                      borderRadius: 6,
                      background: "rgba(255, 255, 255, 0.045)",
                      border: "1px solid rgba(255, 255, 255, 0.09)",
                      fontSize: 12,
                      color: "#8a90a3",
                      fontFamily: "inherit",
                    }}
                  >
                    ⌘
                  </kbd>
                  <kbd
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 24,
                      height: 24,
                      padding: "0 6px",
                      borderRadius: 6,
                      background: "rgba(255, 255, 255, 0.045)",
                      border: "1px solid rgba(255, 255, 255, 0.09)",
                      fontSize: 12,
                      color: "#8a90a3",
                      fontFamily: "inherit",
                    }}
                  >
                    K
                  </kbd>
                  <span style={{ marginLeft: 4 }}>to quickly open</span>
                </div>
              )}
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
