import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const rootEl = document.getElementById("root") as HTMLElement;

// Apply the persisted theme before React mounts to avoid a dark-to-light flash.
try {
  const persistedUi = JSON.parse(localStorage.getItem("nova-ui") ?? "{}");
  const persistedTheme = persistedUi?.state?.theme;
  document.documentElement.dataset.theme = persistedTheme === "midnight" ? "midnight" : "arctic-dawn";
} catch {
  document.documentElement.dataset.theme = "arctic-dawn";
}

try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (err) {
  rootEl.textContent = `FATAL: ${String(err)}`;
  rootEl.style.color = "#ef4444";
  console.error("FATAL render error:", err);
}
