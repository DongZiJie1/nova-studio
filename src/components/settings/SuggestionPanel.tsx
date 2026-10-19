import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import {
  getMemorySuggestions,
  resolveMemorySuggestion,
  type MemorySuggestion,
  type MemorySuggestionResolution,
  type SuggestionAction,
} from "../../lib/tauri-bridge";

const ACTION_LABELS: Record<SuggestionAction, string> = {
  create: "新建",
  append: "追加",
  update: "更新",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

export function SuggestionPanel() {
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSuggestions(await getMemorySuggestions());
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = useCallback(
    async (suggestion: MemorySuggestion, action: MemorySuggestionResolution) => {
      if (
        action === "reject" &&
        !window.confirm(`拒绝这条建议？相关事实会保持原状。\n\n${suggestion.title}`)
      ) {
        return;
      }
      setBusyId(suggestion.id);
      setError(null);
      setNotice(null);
      try {
        await resolveMemorySuggestion({ id: suggestion.id, action });
        setNotice(
          action === "accept"
            ? "已接受：画像已更新，相关事实已归档。切换到「画像」或「事实」即可看到最新内容。"
            : "已拒绝该建议，相关事实保持原状。",
        );
        await refresh();
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <>
      {notice && (
        <p className="suggestion-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="suggestion-error" role="alert">
          <p className="personalization-error">{error}</p>
          <button type="button" className="fact-memory-retry" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}
      {loading ? (
        <div className="personalization-loading">
          <LoaderCircle size={16} /> 正在读取建议…
        </div>
      ) : suggestions.length === 0 ? (
        <p className="personalization-empty">
          暂无待确认的建议。Nova 在会话结束时评审值得长期保留的事实，只有你在这里接受后才会写进画像。
        </p>
      ) : (
        suggestions.map((suggestion) => (
          <article className="suggestion-card" key={suggestion.id}>
            <header className="suggestion-card-head">
              <span className={`suggestion-action suggestion-action-${suggestion.action}`}>
                {ACTION_LABELS[suggestion.action] ?? suggestion.action}
              </span>
              <h2>{suggestion.title}</h2>
              <span className="suggestion-fact-count">{suggestion.factIds.length} 条事实</span>
            </header>
            <p className="suggestion-content">{suggestion.proposedContent}</p>
            {suggestion.reason && <p className="suggestion-reason">原因：{suggestion.reason}</p>}
            <div className="suggestion-card-footer">
              <span className="suggestion-date">{formatDate(suggestion.createdAt)}</span>
              <div className="suggestion-actions">
                <button
                  type="button"
                  className="suggestion-reject"
                  disabled={busyId !== null}
                  onClick={() => void resolve(suggestion, "reject")}
                >
                  <X size={14} />拒绝
                </button>
                <button
                  type="button"
                  className="suggestion-accept"
                  disabled={busyId !== null}
                  onClick={() => void resolve(suggestion, "accept")}
                >
                  {busyId === suggestion.id ? <LoaderCircle size={14} /> : <Check size={14} />}
                  接受
                </button>
              </div>
            </div>
          </article>
        ))
      )}
    </>
  );
}
