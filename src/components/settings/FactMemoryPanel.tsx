import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, LoaderCircle, Pin, PinOff, Search } from "lucide-react";
import {
  getFactMemory,
  updateFactMemory,
  type FactApplicability,
  type FactMemoryFact,
  type FactMemoryState,
  type MemoryFactAction,
} from "../../lib/tauri-bridge";

const GROUPS: { id: FactApplicability; label: string; hint: string }[] = [
  { id: "universal", label: "通用", hint: "适用于所有项目" },
  { id: "transferable", label: "可迁移经验", hint: "来自某个项目，可迁移到别处" },
  { id: "project", label: "项目环境", hint: "只对特定项目生效" },
];

const KIND_LABELS: Record<FactMemoryFact["kind"], string> = {
  decision: "决策",
  preference: "偏好",
  constraint: "约束",
  project: "项目",
  commitment: "承诺",
  event: "事件",
};

const ARCHIVE_REASON_LABELS: Record<string, string> = {
  expired: "已过期",
  stale: "陈旧",
  superseded: "已被替代",
  manual: "手动归档",
  promoted: "已晋升到画像",
  capped: "超出上限",
};

/** Nova injects at most 12 active facts, each truncated to 160 characters. */
const MAX_INJECTED_FACTS = 12;
const MAX_INJECTED_CHARS = 160;

/** Archived and superseded facts are no longer retrieved or injected. */
function isActiveFact(fact: FactMemoryFact): boolean {
  return !fact.archivedAt && !fact.supersededBy;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "未知日期";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

function factMatches(fact: FactMemoryFact, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    fact.text,
    KIND_LABELS[fact.kind] ?? fact.kind,
    ...(fact.topics ?? []),
    ...(fact.projects ?? []),
    fact.originProject?.path ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Rough, deliberately cheap: the real pick depends on the retrieval query.
 * Mixed Chinese/English text averages about two characters per token. */
function estimateInjectionTokens(facts: FactMemoryFact[]): number {
  const chars = facts
    .filter(isActiveFact)
    .slice(0, MAX_INJECTED_FACTS)
    .reduce(
      (total, fact) => total + Math.min(Array.from(fact.text).length, MAX_INJECTED_CHARS),
      0,
    );
  return Math.ceil(chars / 2);
}

interface FactCardProps {
  fact: FactMemoryFact;
  busy: boolean;
  onAction: (fact: FactMemoryFact, action: MemoryFactAction) => void;
}

function FactCard({ fact, busy, onAction }: FactCardProps) {
  const archived = !isActiveFact(fact);
  const projectPaths =
    fact.applicability === "project" ? fact.projects ?? [] : fact.originProject ? [fact.originProject.path] : [];
  const sessionFile = fact.source?.sessionFile;

  return (
    <article className={`fact-memory-card ${fact.pinned ? "fact-memory-card-pinned" : ""} ${archived ? "fact-memory-card-archived" : ""}`}>
      <div className="fact-memory-card-main">
        <p className="fact-memory-text">{fact.text}</p>
        <div className="fact-memory-meta">
          <span>{formatDate(fact.createdAt)}</span>
          <span className="fact-memory-chip">{KIND_LABELS[fact.kind] ?? fact.kind}</span>
          <span>重要度 {fact.importance}/5</span>
          <span>命中 {fact.retrievalCount ?? 0} 次</span>
          {projectPaths.length > 0 && <span className="fact-memory-projects">{projectPaths.map(basename).join(" · ")}</span>}
          {fact.pinned && !archived && <span className="fact-memory-pinned">已置顶</span>}
          {archived && (
            <span className="fact-memory-chip fact-memory-chip-muted">
              {ARCHIVE_REASON_LABELS[fact.archiveReason ?? ""] ?? (fact.supersededBy ? "已被替代" : "已归档")}
            </span>
          )}
        </div>
        {sessionFile && (
          <p className="fact-memory-source" title={sessionFile}>
            来源会话 {basename(sessionFile)}
          </p>
        )}
      </div>
      {!archived && (
        <div className="fact-memory-actions">
          <button
            type="button"
            title={fact.pinned ? "取消置顶" : "置顶"}
            aria-label={fact.pinned ? `取消置顶：${fact.text}` : `置顶：${fact.text}`}
            disabled={busy}
            onClick={() => onAction(fact, fact.pinned ? "unpin" : "pin")}
          >
            {fact.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button
            type="button"
            title="归档"
            aria-label={`归档：${fact.text}`}
            disabled={busy}
            onClick={() => onAction(fact, "archive")}
          >
            {busy ? <LoaderCircle size={14} /> : <Archive size={14} />}
          </button>
        </div>
      )}
    </article>
  );
}

export function FactMemoryPanel() {
  const [data, setData] = useState<FactMemoryState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await getFactMemory());
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

  const runAction = useCallback(
    async (fact: FactMemoryFact, action: MemoryFactAction) => {
      if (action === "archive" && !window.confirm(`归档这条事实？归档后不再注入，记录会保留。\n\n${fact.text}`)) return;
      setBusyId(fact.id);
      setActionError(null);
      try {
        await updateFactMemory({ id: fact.id, action });
        await refresh();
      } catch (reason) {
        setActionError(String(reason));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => (data?.facts ?? []).filter((fact) => factMatches(fact, needle)), [data, needle]);
  const activeFacts = useMemo(() => filtered.filter(isActiveFact), [filtered]);
  const archivedFacts = useMemo(() => filtered.filter((fact) => !isActiveFact(fact)), [filtered]);
  const estimatedTokens = useMemo(() => estimateInjectionTokens(data?.facts ?? []), [data]);
  const stats = data?.stats;

  if (loading) {
    return (
      <div className="personalization-loading">
        <LoaderCircle size={16} /> 正在读取事实…
      </div>
    );
  }

  if (error) {
    return (
      <div className="fact-memory-error" role="alert">
        <p className="personalization-error">读取事实失败：{error}</p>
        <button type="button" className="fact-memory-retry" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="fact-memory-stats">
        <span>
          活跃 <strong>{stats?.active ?? 0}</strong>
        </span>
        <span>
          归档 <strong>{stats?.archived ?? 0}</strong>
        </span>
        <span>
          预计注入约 <strong>{estimatedTokens}</strong> tokens
        </span>
      </div>
      {stats && !stats.factsEnabled && (
        <p className="fact-memory-disabled">
          事实记忆已停用（settings.json 中 memory.facts.enabled 为 false）：Nova 不会抽取或注入事实，这里只展示已有数据。
        </p>
      )}
      <div className="fact-memory-toolbar">
        <label className="fact-memory-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索事实内容、标签或项目"
            aria-label="搜索事实"
          />
        </label>
        <button
          type="button"
          className={`fact-memory-archive-toggle ${showArchived ? "fact-memory-archive-toggle-on" : ""}`}
          aria-pressed={showArchived}
          disabled={(stats?.archived ?? 0) === 0}
          onClick={() => setShowArchived((current) => !current)}
        >
          {showArchived ? "隐藏归档" : `已归档 ${stats?.archived ?? 0}`}
        </button>
      </div>
      {actionError && (
        <p className="personalization-error" role="alert">
          {actionError}
        </p>
      )}
      {activeFacts.length === 0 ? (
        <p className="personalization-empty">
          {needle
            ? "没有匹配的事实。"
            : (stats?.archived ?? 0) > 0
              ? "没有活跃事实。已归档的记录可通过上方「已归档」查看。"
              : "还没有事实。Nova 会在会话过程中抽取值得长期保留的信息。"}
        </p>
      ) : (
        GROUPS.map((group) => {
          const groupFacts = activeFacts.filter((fact) => fact.applicability === group.id);
          if (groupFacts.length === 0) return null;
          return (
            <section className="fact-memory-group" key={group.id}>
              <div className="fact-memory-group-header">
                <h2>{group.label}</h2>
                <span>
                  {group.hint} · {groupFacts.length} 条
                </span>
              </div>
              {groupFacts.map((fact) => (
                <FactCard key={fact.id} fact={fact} busy={busyId === fact.id} onAction={(target, action) => void runAction(target, action)} />
              ))}
            </section>
          );
        })
      )}
      {showArchived && archivedFacts.length > 0 && (
        <section className="fact-memory-group">
          <div className="fact-memory-group-header">
            <h2>已归档</h2>
            <span>不再注入 · {archivedFacts.length} 条</span>
          </div>
          {archivedFacts.map((fact) => (
            <FactCard key={fact.id} fact={fact} busy={false} onAction={(target, action) => void runAction(target, action)} />
          ))}
        </section>
      )}
    </>
  );
}
