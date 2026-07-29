import { useState } from "react";
import { Background } from "./Background";
import { Sidebar } from "./Sidebar";
import { useAgentStore } from "../../stores/agent-store";

export function AppShell() {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const [input, setInput] = useState("");

  const activeAgent = agents.find((a) => a.id === activeId);

  const handleSubmit = () => {
    if (!input.trim()) return;
    // TODO: spawn agent if none exists, then send prompt
    console.log("send:", input);
    setInput("");
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      <Background />

      <div className="relative z-10 flex h-full p-4 gap-4">
        <Sidebar />

        {/* Main content — chat area */}
        <main className="glass-panel flex-1 flex flex-col overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {activeAgent?.messages.length === 0 && !activeAgent && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <h2 className="text-2xl font-bold text-text-primary mb-2">
                  Nova <span className="gradient-text">Studio</span>
                </h2>
                <p className="text-sm text-text-secondary">
                  Start typing to begin a conversation
                </p>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="p-4 pt-0">
            <div className="glass-panel rounded-2xl px-4 py-3">
              <div className="flex items-end gap-3">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder="Message Nova..."
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
                />
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim()}
                  className="rounded-lg bg-gradient-to-r from-accent-start to-accent-end p-2 text-white transition-all hover:brightness-110 active:scale-[0.95] disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="text-center text-[11px] text-text-muted mt-2">
              Nova Studio v0.1
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
