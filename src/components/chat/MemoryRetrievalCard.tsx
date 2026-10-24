import { useMemo, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { parseRetrievedFacts } from "../../lib/memory-retrieval";

/**
 * Shows the facts retrieved for this request. Collapsed by default: the block is
 * model context, not part of the conversation, but it stays auditable.
 */
export function MemoryRetrievalCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const facts = useMemo(() => parseRetrievedFacts(content), [content]);

  return (
    <div className={`memory-retrieval-card${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="memory-retrieval-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="memory-retrieval-icon" aria-hidden="true">
          <Brain size={14} />
        </span>
        <span className="memory-retrieval-title">
          {facts.length > 0 ? `已检索 ${facts.length} 条相关记忆` : "已检索相关记忆"}
        </span>
        <span className="memory-retrieval-hint">按当前消息从长期记忆选出</span>
        <ChevronRight size={14} className="memory-retrieval-chevron" aria-hidden="true" />
      </button>
      {open &&
        (facts.length > 0 ? (
          <ul className="memory-retrieval-list">
            {facts.map((fact) => (
              <li key={fact.id}>
                <code>{fact.id}</code>
                <span>{fact.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <pre className="memory-retrieval-raw">{content}</pre>
        ))}
    </div>
  );
}
