import { useEffect, useRef, useState } from "react";
import { onAgentEvent, sendExtensionUIResponse } from "../lib/tauri-bridge";
import type {
  AgentEventPayload,
  ExtensionUIRequest,
} from "../lib/rpc-types";

interface PendingDialog {
  agentId: string;
  request: ExtensionUIRequest;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input"]);

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.6)",
};

const cardStyle: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 12,
  padding: 20,
  color: "#e5e7eb",
  boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  marginBottom: 8,
};

const messageStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#9ca3af",
  marginBottom: 16,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const optionStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 12px",
  marginBottom: 8,
  borderRadius: 8,
  background: "#1f2937",
  color: "#e5e7eb",
  border: "1px solid #374151",
  cursor: "pointer",
  fontSize: 13,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginBottom: 16,
  borderRadius: 8,
  background: "#1f2937",
  color: "#e5e7eb",
  border: "1px solid #374151",
  fontSize: 13,
  boxSizing: "border-box",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

const buttonBase: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
};

export function ExtensionUIPrompt() {
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unlisten = onAgentEvent((payload: AgentEventPayload) => {
      const evt = payload.event as AgentEventPayload["event"] &
        ExtensionUIRequest;
      if (evt.type === "extension_ui_request" && DIALOG_METHODS.has(evt.method)) {
        setQueue((q) => [...q, { agentId: payload.agentId, request: evt }]);
      }
    });
    return unlisten;
  }, []);

  const current = queue[0];

  useEffect(() => {
    if (current?.request.method === "input") {
      inputRef.current?.focus();
    }
  }, [current]);

  if (!current) return null;

  const { agentId, request } = current;
  const title = request.title || "Nova";
  const message = request.message || "";

  const respond = (
    resp: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => {
    void sendExtensionUIResponse(agentId, { id: request.id, ...resp });
    setQueue((q) => q.slice(1));
    setInputValue("");
  };

  const confirmButton: React.CSSProperties = {
    ...buttonBase,
    background: "#2563eb",
    color: "#fff",
  };
  const cancelButton: React.CSSProperties = {
    ...buttonBase,
    background: "#374151",
    color: "#e5e7eb",
  };

  return (
    <div style={overlayStyle} onClick={() => respond({ cancelled: true })}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>{title}</div>
        {message ? <div style={messageStyle}>{message}</div> : null}

        {request.method === "select" && (
          <>
            {(request.options ?? []).map((opt, i) => (
              <button
                key={i}
                style={optionStyle}
                onClick={() => respond({ value: opt })}
              >
                {opt}
              </button>
            ))}
            <div style={actionRowStyle}>
              <button
                style={cancelButton}
                onClick={() => respond({ cancelled: true })}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {request.method === "confirm" && (
          <div style={actionRowStyle}>
            <button
              style={cancelButton}
              onClick={() => respond({ cancelled: true })}
            >
              Cancel
            </button>
            <button
              style={confirmButton}
              onClick={() => respond({ confirmed: true })}
            >
              Confirm
            </button>
          </div>
        )}

        {request.method === "input" && (
          <>
            <input
              ref={inputRef}
              style={inputStyle}
              placeholder={request.placeholder}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") respond({ value: inputValue });
                if (e.key === "Escape") respond({ cancelled: true });
              }}
            />
            <div style={actionRowStyle}>
              <button
                style={cancelButton}
                onClick={() => respond({ cancelled: true })}
              >
                Cancel
              </button>
              <button
                style={confirmButton}
                onClick={() => respond({ value: inputValue })}
              >
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
