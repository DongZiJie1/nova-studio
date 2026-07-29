import "./App.css";

function App() {
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Background layer */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a0a1a] via-[#0f0f2a] to-[#0a0a1a]" />

      {/* Noise texture overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Main content */}
      <div className="relative z-10 flex h-full">
        {/* Sidebar */}
        <aside className="glass-panel m-3 mr-0 w-64 flex-shrink-0 p-4">
          <div className="mb-6">
            <h1 className="gradient-text text-xl font-bold tracking-tight">
              Nova Studio
            </h1>
            <p className="mt-1 text-xs text-text-secondary">
              AI Coding Agent
            </p>
          </div>

          <div className="space-y-1">
            <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary">
              <span className="flex h-5 w-5 items-center justify-center rounded bg-accent-start/20 text-[10px] text-accent-start">
                +
              </span>
              New Agent
            </button>
          </div>
        </aside>

        {/* Main area */}
        <main className="flex flex-1 flex-col p-3 pl-0">
          <div className="glass-panel flex flex-1 flex-col items-center justify-center p-8">
            <div className="text-center">
              <h2 className="gradient-text mb-3 text-3xl font-bold">
                Welcome to Nova Studio
              </h2>
              <p className="mb-6 max-w-md text-text-secondary">
                Your AI-powered coding assistant with a beautiful visual
                interface. Create an agent to get started.
              </p>
              <button className="rounded-lg bg-gradient-to-r from-accent-start to-accent-end px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-accent-start/25 transition-all hover:shadow-xl hover:shadow-accent-start/30 hover:brightness-110">
                Create Agent
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
