import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";

const STREAM_RENDER_INTERVAL_MS = 100;

function useThrottledContent(content: string): string {
  const [rendered, setRendered] = useState(content);
  const lastRenderAt = useRef(performance.now());
  const latestContent = useRef(content);

  useEffect(() => {
    latestContent.current = content;
    if (content.length < rendered.length) {
      setRendered(content);
      lastRenderAt.current = performance.now();
      return;
    }

    const remaining = STREAM_RENDER_INTERVAL_MS - (performance.now() - lastRenderAt.current);
    const timer = window.setTimeout(() => {
      setRendered(latestContent.current);
      lastRenderAt.current = performance.now();
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [content, rendered.length]);

  return rendered;
}

export function StreamingText({ content, avatarId }: { content: string; avatarId: AgentAvatarId }) {
  const renderedContent = useThrottledContent(content);
  return (
    <div className="msg-row msg-row-assistant">
      <div className="msg-avatar msg-avatar-nova">
        <img src={agentAvatarSrc(avatarId)} alt="Nova" />
      </div>
      <div className="msg-column">
        <div className="msg-meta">
          <span className="msg-author">Nova</span>
          <span className="msg-time">…</span>
        </div>
        <div className="msg-bubble msg-bubble-assistant">
          {renderedContent ? (
            <Markdown content={renderedContent} highlightCode={false} />
          ) : (
            <span className="msg-thinking">
              <i />
              <i />
              <i />
            </span>
          )}
          {renderedContent && <span className="msg-cursor" />}
        </div>
      </div>
    </div>
  );
}
