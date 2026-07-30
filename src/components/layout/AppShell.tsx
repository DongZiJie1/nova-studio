import { useState, useRef, useCallback } from "react";
import { Background } from "./Background";
import { useAgentStore, type AgentState } from "../../stores/agent-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
  spawnAgent,
  sendPrompt,
  stopAgent,
} from "../../lib/tauri-bridge";
import {
  Paperclip,
  ArrowUp,
  Settings2,
  Square,
} from "lucide-react";

export function AppShell() {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const addAgent = useAgentStore((s) => s.addAgent);
  const addUserMessage = useAgentStore((s) => s.addUserMessage);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const updateStatus = useAgentStore((s) => s.updateStatus);

  const defaultCwd = useSettingsStore((s) => s.defaultCwd);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const activeAgent = agents.find((a) => a.id === activeId);
  const hasMessages = (activeAgent?.messages.length ?? 0) > 0;

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      let agentId = activeId;

      // Spawn agent if none exists
      if (!agentId) {
        const cwd = defaultCwd || "~";
        const info = await spawnAgent(
          cwd,
          defaultModel || undefined,
          defaultProvider || undefined,
        );

        const newAgent: AgentState = {
          id: info.id,
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
      }

      // Add user message to UI immediately
      addUserMessage(agentId, text);

      // Send to agent via Tauri backend
      await sendPrompt(agentId, text);
    } catch (err) {
      console.error("Failed to send prompt:", err);
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

  const handleStopAgent = async () => {
    if (!activeId) return;
    try {
      await stopAgent(activeId);
      removeAgent(activeId);
    } catch (err) {
      console.error("Failed to stop agent:", err);
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      <Background />

      <div className="relative z-10 flex h-full p-4 gap-4">
        {/* Sidebar */}
        <aside
          className={`glass-panel flex-shrink-0 p-5 flex flex-col ${
            agents.length > 0 ? "w-64" : "w-0 overflow-hidden p-0 border-0"
          }`}
        >
          {agents.length > 0 && (
            <>
              <div className="mb-6">
                <h1 className="text-lg font-bold text-text-primary tracking-tight">
                  Nova <span className="gradient-text">Studio</span>
                </h1>
              </div>
              <div className="flex-1 overflow-y-auto space-y-1">
                {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setActiveAgent(agent.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all ${
                    agent.id === activeId
                      ? "bg-indigo-50 text-accent-start font-medium"
                      : "text-text-secondary hover:bg-gray-50"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full flex-shrink-0 ${
                      agent.status === "idle"
                        ? "bg-emerald-400"
                        : agent.status === "streaming"
                          ? "bg-indigo-400 animate-pulse"
                          : agent.status === "error"
                            ? "bg-red-400"
                            : "bg-gray-300"
                    }`}
                  />
                  <span className="truncate">{agent.name ?? agent.id}</span>
                </button>
              ))}
            </div>
            {activeId && (
              <button
                onClick={handleStopAgent}
                className="mt-2 text-xs text-text-muted hover:text-error transition-colors"
              >
                Stop Agent
              </button>
            )}
            </>
          )}
        </aside>

        {/* Main */}
        <main className="glass-panel flex-1 flex flex-col overflow-hidden">
          {/* Content area */}
          <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6">
            {!hasMessages ? (
              /* Empty state — tagline */
              <div className="text-center max-w-2xl w-full">
                {/* Logo */}
                <div className="flex justify-center mb-6">
                  <div className="h-12 w-12 rounded-xl bg-gray-100 flex items-center justify-center">
                    <svg
                      className="w-6 h-6 text-text-muted"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z"
                      />
                    </svg>
                  </div>
                </div>

                {/* Tagline */}
                <h2 className="text-3xl font-bold text-text-primary leading-snug">
                  Ship faster with Nova.
                  <br />
                  <span className="text-text-secondary font-normal text-2xl">
                    From idea to code, from concept to creation.
                  </span>
                </h2>
              </div>
            ) : (
              /* Messages view */
              <div className="w-full max-w-3xl space-y-4">
                {activeAgent?.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-gradient-to-r from-accent-start to-accent-end text-white"
                          : "bg-white/80 text-text-primary border border-border-glass"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}

                {/* Streaming text */}
                {activeAgent?.streamingText && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white/80 text-text-primary border border-border-glass">
                      {activeAgent.streamingText}
                      <span className="inline-block w-1.5 h-4 bg-accent-start ml-0.5 animate-pulse" />
                    </div>
                  </div>
                )}

                {/* Active tool calls */}
                {activeAgent &&
                  activeAgent.activeToolCalls.size > 0 &&
                  Array.from(activeAgent.activeToolCalls.values()).map(
                    (tc) => (
                      <div
                        key={tc.id}
                        className="flex justify-start"
                      >
                        <div className="rounded-2xl px-4 py-2 text-xs bg-indigo-50 text-accent-start border border-indigo-100 flex items-center gap-2">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              tc.status === "running"
                                ? "bg-indigo-400 animate-pulse"
                                : tc.status === "done"
                                  ? "bg-emerald-400"
                                  : "bg-red-400"
                            }`}
                          />
                          {tc.name}
                        </div>
                      </div>
                    ),
                  )}
              </div>
            )}
          </div>

          {/* Input area */}
          <div
            style={{
              flexShrink: 0,
              padding: "0 24px 32px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <div style={{ width: "100%", maxWidth: 680 }}>
              {/* Project path */}
              {activeAgent && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    fontSize: 12,
                    color: "#9ca3af",
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
              <div
                style={{
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 16,
                  overflow: "hidden",
                }}
              >
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    autoResize();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder="Ask Nova anything..."
                  rows={1}
                  style={{
                    width: "100%",
                    resize: "none",
                    background: "transparent",
                    padding: "14px 16px 8px",
                    fontSize: 14,
                    color: "#1a1a2e",
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
                    padding: "6px 10px 10px",
                  }}
                >
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      padding: 6,
                      borderRadius: 8,
                      color: "#9ca3af",
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
                      gap: 6,
                    }}
                  >
                    <button
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "4px 8px",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "#9ca3af",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      <Settings2 size={14} />
                      <span>High</span>
                    </button>

                    {/* Abort button (visible during streaming) */}
                    {activeAgent?.status === "streaming" ? (
                      <button
                        onClick={handleAbort}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 28,
                          height: 28,
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
                          width: 28,
                          height: 28,
                          borderRadius: "50%",
                          background:
                            input.trim() && !isSending ? "#1f2937" : "#d1d5db",
                          color: "#fff",
                          border: "none",
                          cursor:
                            input.trim() && !isSending
                              ? "pointer"
                              : "not-allowed",
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
  );
}
