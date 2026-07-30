import { useEffect } from "react";
import "./App.css";
import { AppShell } from "./components/layout/AppShell";
import { onAgentEvent } from "./lib/tauri-bridge";
import { useAgentStore } from "./stores/agent-store";

function App() {
  const handleAgentEvent = useAgentStore((s) => s.handleAgentEvent);

  useEffect(() => {
    const unlisten = onAgentEvent((payload) => {
      handleAgentEvent(payload);
    });
    return unlisten;
  }, [handleAgentEvent]);

  return <AppShell />;
}

export default App;
