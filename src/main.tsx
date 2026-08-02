import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

const rootEl = document.getElementById("root") as HTMLElement;

// Show a marker so we can tell whether HTML loaded before React mounts
const marker = document.createElement("div");
marker.id = "app-loading";
marker.style.cssText =
  "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-family:system-ui;font-size:14px;color:#9ca3af;z-index:9999";
marker.textContent = "Loading...";
rootEl.appendChild(marker);

try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // If React mounted, remove the loading marker
  marker.remove();
} catch (err) {
  marker.textContent = `FATAL: ${String(err)}`;
  marker.style.color = "#ef4444";
  console.error("FATAL render error:", err);
}

