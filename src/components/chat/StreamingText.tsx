import { Sparkles } from "lucide-react";
import { Markdown } from "./Markdown";

export function StreamingText({ content }: { content: string }) {
  return (
    <div className="msg-row msg-row-assistant">
      <div className="msg-avatar msg-avatar-nova">
        <Sparkles size={16} />
      </div>
      <div className="msg-column">
        <div className="msg-meta">
          <span className="msg-author">Nova</span>
          <span className="msg-time">…</span>
        </div>
        <div className="msg-bubble msg-bubble-assistant">
          {content ? (
            <Markdown content={content} />
          ) : (
            <span className="msg-thinking">
              <i />
              <i />
              <i />
            </span>
          )}
          {content && <span className="msg-cursor" />}
        </div>
      </div>
    </div>
  );
}
