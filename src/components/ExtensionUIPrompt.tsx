import { useEffect, useRef, useState } from "react";
import { onAgentEvent, sendExtensionUIResponse } from "../lib/tauri-bridge";
import type {
  AgentEventPayload,
  ExtensionUIRequest,
} from "../lib/rpc-types";
import { ArrowRight, Check, MessageCircleQuestion, PenLine, X } from "lucide-react";

interface PendingDialog {
  agentId: string;
  request: ExtensionUIRequest;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input"]);

/** nova's ask_user_question appends this sentinel to select options; selecting it
 * means "let the user type a custom answer" (ask-user-question.ts). */
const TYPE_SOMETHING = "Type something";

export function ExtensionUIPrompt() {
  const [queue, setQueue] = useState<PendingDialog[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [customValue, setCustomValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    if (current) {
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

  return (
    <div className="nova-question-overlay" onClick={() => respond({ cancelled: true })}>
      <div className="nova-question-card" role="dialog" aria-modal="true" aria-labelledby="nova-question-title" onClick={(e) => e.stopPropagation()}>
        <header className="nova-question-header">
          <span className="nova-question-icon"><MessageCircleQuestion size={20} /></span>
          <div><span>需要你的选择</span><h2 id="nova-question-title">{title}</h2></div>
          {queue.length > 1 && <span className="nova-question-queue">{queue.length} 个问题</span>}
          <button type="button" className="nova-question-close" onClick={() => respond({ cancelled: true })} aria-label="取消"><X size={17} /></button>
        </header>
        <div className="nova-question-body">
          {message ? <div className="nova-question-message">{message}</div> : null}

          {request.method === "select" && (
            <div className="nova-question-options">
              {(request.options ?? []).map((opt, i) =>
                opt === TYPE_SOMETHING ? (
                  <label className="nova-question-custom" key={i}><PenLine size={15} /><input placeholder="输入其他答案…" value={customValue} onChange={(e) => setCustomValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && customValue.trim()) respond({ value: customValue.trim() }); }} /><button type="button" disabled={!customValue.trim()} onClick={() => customValue.trim() && respond({ value: customValue.trim() })} aria-label="提交自定义答案"><ArrowRight size={15} /></button></label>
                ) : (
                  <button key={i} type="button" className="nova-question-option" onClick={() => respond({ value: opt })}><span className="nova-question-option-index">{i + 1}</span><span>{opt}</span><ArrowRight size={15} /></button>
                ),
              )}
            </div>
          )}

          {request.method === "input" && (
            <div className="nova-question-input-section">
              <textarea ref={inputRef} placeholder={request.placeholder || "输入你的回答…"} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); respond({ value: inputValue }); } if (e.key === "Escape") respond({ cancelled: true }); }} />
              <div className="nova-question-actions">
                <button type="button" className="nova-question-button-secondary" onClick={() => respond({ cancelled: true })}>取消</button>
                <button type="button" className="nova-question-button-primary" onClick={() => respond({ value: inputValue })}><ArrowRight size={15} />提交</button>
              </div>
            </div>
          )}
        </div>

        {request.method === "confirm" && (
          <div className="nova-question-actions">
            <button type="button" className="nova-question-button-secondary" onClick={() => respond({ cancelled: true })}>取消</button>
            <button type="button" className="nova-question-button-primary" onClick={() => respond({ confirmed: true })}><Check size={15} />确认</button>
          </div>
        )}

      </div>
    </div>
  );
}
