import { useState } from "react";
import { Background } from "./Background";
import { useAgentStore } from "../../stores/agent-store";
import {
  Search,
  Hammer,
  Eye,
  Bug,
  Paperclip,
  ArrowUp,
  Settings2,
} from "lucide-react";

const suggestions = [
  { icon: Search, label: "Explore and understand code", color: "text-blue-500" },
  { icon: Hammer, label: "Build new features or tools", color: "text-violet-500" },
  { icon: Eye, label: "Review code and suggest changes", color: "text-emerald-500" },
  { icon: Bug, label: "Fix issues and failures", color: "text-orange-500" },
];

export function AppShell() {
  const agents = useAgentStore((s) => s.agents);
  const activeId = useAgentStore((s) => s.activeAgentId);
  const [input, setInput] = useState("");

  const activeAgent = agents.find((a) => a.id === activeId);
  const hasMessages = (activeAgent?.messages.length ?? 0) > 0;

  const handleSubmit = () => {
    if (!input.trim()) return;
    // TODO: spawn agent + send prompt
    console.log("send:", input);
    setInput("");
  };

  const handleSuggestion = (label: string) => {
    setInput(label);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      <Background />

      <div className="relative z-10 flex h-full p-4 gap-4">
        {/* Sidebar — hidden when no agents */}
        {agents.length > 0 && (
          <aside className="glass-panel w-64 flex-shrink-0 p-5 flex flex-col">
            <div className="mb-6">
              <h1 className="text-lg font-bold text-text-primary tracking-tight">
                Nova <span className="gradient-text">Studio</span>
              </h1>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {agents.map((agent) => (
                <button
                  key={agent.id}
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
                          : "bg-gray-300"
                    }`}
                  />
                  <span className="truncate">{agent.name ?? agent.id}</span>
                </button>
              ))}
            </div>
          </aside>
        )}

        {/* Main */}
        <main className="glass-panel flex-1 flex flex-col overflow-hidden">
          {/* Content area */}
          <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6">
            {!hasMessages ? (
              /* Empty state — welcome + suggestions */
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

                {/* Heading */}
                <h2 className="text-3xl font-bold text-text-primary mb-8">
                  What should Nova do next?
                </h2>

                {/* Suggestion cards */}
                <div className="grid grid-cols-4 gap-3">
                  {suggestions.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => handleSuggestion(s.label)}
                      className="group flex flex-col items-start gap-3 rounded-xl border border-border-glass bg-white/60 p-4 text-left transition-all hover:border-indigo-200 hover:bg-white hover:shadow-sm"
                    >
                      <s.icon className={`w-5 h-5 ${s.color}`} />
                      <span className="text-sm text-text-secondary group-hover:text-text-primary">
                        {s.label}
                      </span>
                    </button>
                  ))}
                </div>
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
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="p-4 pt-0">
            <div className="max-w-3xl mx-auto">
              {/* Project path */}
              <div className="flex items-center gap-2 px-4 py-2 rounded-t-xl border border-b-0 border-border-glass bg-white/60 text-xs text-text-muted">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
                </svg>
                <span>~/nova-studio</span>
              </div>

              {/* Input box */}
              <div className="flex items-end gap-2 border border-border-glass rounded-b-xl bg-white/60 px-4 py-3">
                {/* Left: attach + model */}
                <div className="flex items-center gap-1 mb-0.5">
                  <button className="p-1.5 rounded-lg text-text-muted hover:bg-gray-100 transition-colors">
                    <Paperclip className="w-4 h-4" />
                  </button>
                </div>

                {/* Text input */}
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder="Ask Nova anything..."
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none leading-relaxed"
                />

                {/* Right: model + send */}
                <div className="flex items-center gap-1 mb-0.5">
                  <button className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-text-muted hover:bg-gray-100 transition-colors">
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>High</span>
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!input.trim()}
                    className="rounded-lg bg-gray-800 p-1.5 text-white transition-all hover:bg-gray-700 active:scale-[0.95] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
