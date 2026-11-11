import { useId, useMemo, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { parseRetrievedFacts } from "../../lib/memory-retrieval.ts";

/** Retrieved context stays available for inspection without overwhelming the conversation. */
export function MemoryRetrievalCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const panelId = useId();
  const facts = useMemo(() => parseRetrievedFacts(content), [content]);
  const visibleFacts = showAll ? facts : facts.slice(0, 3);

  return (
    <div className={`memory-retrieval-card${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="memory-retrieval-summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
          setShowAll(false);
        }}
      >
        <span className="memory-retrieval-icon" aria-hidden="true"><Brain size={15} /></span>
        <span className="memory-retrieval-title">相关记忆</span>
        {facts.length > 0 && <span className="memory-retrieval-count">{facts.length} 条</span>}
        <span className="memory-retrieval-action">{open ? "收起" : "查看"}</span>
        <ChevronRight size={13} className="memory-retrieval-chevron" aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!open} className="memory-retrieval-details">
        <p className="memory-retrieval-hint">从长期记忆中检索，与当前对话相关</p>
        {facts.length > 0 ? (
          <>
            <ol className="memory-retrieval-list" tabIndex={0} aria-label="检索到的相关记忆">
              {visibleFacts.map((fact, index) => (
                <li key={fact.id}>
                  <span className="memory-retrieval-number" title={fact.id}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p className="memory-retrieval-text">{fact.text}</p>
                </li>
              ))}
            </ol>
            {facts.length > 3 && (
              <button type="button" className="memory-retrieval-more" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
                {showAll ? "仅显示前 3 条" : `查看其余 ${facts.length - 3} 条记忆`}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <pre className="memory-retrieval-raw">{content}</pre>
        )}
      </div>
    </div>
  );
}
