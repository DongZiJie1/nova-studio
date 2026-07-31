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

/** nova's ask_user_question appends this sentinel to select options; selecting it
 * means "let the user type a custom answer" (ask-user-question.ts). */
const TYPE_SOMETHING = "Type something";

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(120, 135, 160, 0.25)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
};

const cardStyle: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  background: "rgba(255, 255, 255, 0.7)",
  backdropFilter: "blur(20px) saturate(180%)",
  WebkitBackdropFilter: "blur(20px) saturate(180%)",
  border: "1px solid rgba(255, 255, 255, 0.6)",
  borderRadius: 16,
  padding: 24,
  color: "#111827",
  boxShadow: "0 20px 60px rgba(31, 41, 55, 0.18)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  marginBottom: 8,
  color: "#111827",
};

const messageStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#4b5563",
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
  borderRadius: 10,
  background: "rgba(255, 255, 255, 0.7)",
  color: "#111827",
  border: "1px solid rgba(148, 163, 184, 0.35)",
  cursor: "pointer",
  fontSize: 13,
  boxSizing: "border-box",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginBottom: 16,
  borderRadius: 10,
  background: "rgba(255, 255, 255, 0.8)",
  color: "#111827",
  border: "1px solid rgba(148, 163, 184, 0.4)",
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
  borderRadius: 10,
  fontSize: 13,
  border: "none",
  cursor: "pointer",
};

export function ExtensionUIPrompt() {
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [customInput, setCustomInput] = useState(false);
  const [customValue, setCustomValue] = useState("");
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
    if (current?.request.method === "input" || customInput) {
      inputRef.current?.focus();
    }
  }, [current, customInput]);

  useEffect(() => {
    if (current) {
      setCustomInput(false);
      setCustomValue("");
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
    background: "rgba(255, 255, 255, 0.8)",
    color: "#374151",
    border: "1px solid rgba(148, 163, 184, 0.4)",
  };

  return (
    <div style={overlayStyle} onClick={() => respond({ cancelled: true })}>
      <style>{`
        .nova-ui-option {
          transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
        }
        .nova-ui-option:hover {
          background: rgba(255, 255, 255, 0.98);
          border-color: #3b82f6;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.15);
        }
        .nova-ui-option:active {
          background: rgba(219, 234, 254, 0.9);
          transform: translateY(0);
          box-shadow: none;
        }
      `}</style>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>{title}</div>
        {message ? <div style={messageStyle}>{message}</div> : null}

        {request.method === "select" && (
          <>
            {customInput ? (
              <>
                <input
                  ref={inputRef}
                  style={inputStyle}
                  placeholder="Type your answer..."
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") respond({ value: customValue });
                    if (e.key === "Escape") setCustomInput(false);
                  }}
                />
                <div style={actionRowStyle}>
                  <button
                    style={cancelButton}
                    onClick={() => setCustomInput(false)}
                  >
                    Back
                  </button>
                  <button
                    style={confirmButton}
                    onClick={() => respond({ value: customValue })}
                  >
                    Submit
                  </button>
                </div>
              </>
            ) : (
              <>
                {(request.options ?? []).map((opt, i) => (
                  <button
                    key={i}
                    style={optionStyle}
                    className="nova-ui-option"
                    onClick={() => {
                      if (opt === TYPE_SOMETHING) {
                        setCustomInput(true);
                      } else {
                        respond({ value: opt });
                      }
                    }}
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
