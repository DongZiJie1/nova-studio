import { Markdown } from "./Markdown";
import { agentAvatarSrc, type AgentAvatarId } from "../../lib/agent-avatars";

export function StreamingText({ content, avatarId }: { content: string; avatarId: AgentAvatarId }) {
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
