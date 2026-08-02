import { useEffect } from "react";
import "./App.css";
import { AppShell } from "./components/layout/AppShell";
import { ExtensionUIPrompt } from "./components/ExtensionUIPrompt";
import { listAgents, onAgentEvent } from "./lib/tauri-bridge";
import { useAgentStore } from "./stores/agent-store";

function App() {
  const handleAgentEvent = useAgentStore((s) => s.handleAgentEvent);
  const syncAgents = useAgentStore((s) => s.syncAgents);

  useEffect(() => {
    const unlisten = onAgentEvent((payload) => {
      handleAgentEvent(payload);
    });

    // Reconcile with the backend after registering the event listener. This
    // picks up agents created through the Hub before the frontend was ready.
    void listAgents()
      .then(syncAgents)
      .catch((error) => console.error("Failed to sync agents:", error));

    return unlisten;
  }, [handleAgentEvent, syncAgents]);

  return (
    <>
      <AppShell />
      <ExtensionUIPrompt />
    </>
  );
}

export default App;
