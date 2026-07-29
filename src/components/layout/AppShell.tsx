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
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-start to-accent-end shadow-lg shadow-indigo-200">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
        </div>

        {/* Heading */}
        <h2 className="text-3xl font-bold text-text-primary mb-3">
          Welcome to <span className="gradient-text">Nova Studio</span>
        </h2>

        {/* Description */}
        <p className="text-text-secondary leading-relaxed mb-10">
          Your AI-powered coding assistant with a beautiful visual interface.
        </p>

        {/* CTA button */}
        <button className="rounded-xl bg-gradient-to-r from-accent-start to-accent-end px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-200/50 transition-all hover:shadow-lg hover:shadow-indigo-200/60 hover:brightness-105 active:scale-[0.98]">
          Create Agent
        </button>
      </div>
    </div>
  );
}
