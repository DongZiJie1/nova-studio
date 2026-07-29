import { Background } from "./Background";
import { Sidebar } from "./Sidebar";
import { Sparkles } from "lucide-react";

interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const handleCreateAgent = () => {
    // TODO: open create agent dialog
    console.log("create agent");
  };

  const handleOpenSettings = () => {
    // TODO: open settings panel
    console.log("open settings");
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg-primary">
      <Background />

      <div className="relative z-10 flex h-full p-4 gap-4">
        <Sidebar onCreateAgent={handleCreateAgent} onOpenSettings={handleOpenSettings} />

        <main className="glass-panel flex-1 flex flex-col overflow-hidden">
          {children ?? <WelcomeView />}
        </main>
      </div>
    </div>
  );
}

function WelcomeView() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-16">
      <div className="text-center max-w-md">
        <div className="mx-auto mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-start to-accent-end shadow-lg shadow-indigo-200">
          <Sparkles className="w-8 h-8 text-white" />
        </div>

        <h2 className="text-3xl font-bold text-text-primary mb-4">
          Welcome to <span className="gradient-text">Nova Studio</span>
        </h2>
        <p className="text-text-secondary leading-relaxed mb-14">
          Your AI-powered coding assistant with a beautiful visual interface.
          <br />
          Create an agent to start building.
        </p>

        <button className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-accent-start to-accent-end px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-200 transition-all hover:shadow-xl hover:shadow-indigo-300 hover:brightness-105 active:scale-[0.98]">
          <Sparkles className="w-4 h-4" />
          Create Agent
        </button>
      </div>
    </div>
  );
}
