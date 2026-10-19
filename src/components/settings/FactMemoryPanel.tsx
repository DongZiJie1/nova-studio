import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Archive, Filter, LoaderCircle, Pin, PinOff, Search } from "lucide-react";
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
/** `<user_facts>` wrapper plus its three header lines, measured on nova's block. */
const INJECTION_BLOCK_OVERHEAD = 60;
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

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

/** The toolbar filter keeps one dimension: `all`, `scope:<applicability>` or `kind:<kind>`. */
function matchesFilter(fact: FactMemoryFact, filter: string): boolean {
  if (filter === "all") return true;
  const [dimension, value] = filter.split(":");
  if (dimension === "kind") return fact.kind === value;
  if (dimension === "scope") return fact.applicability === value;
  return true;
}

/** Mirrors nova's `estimateMemoryTokens`: CJK characters are one token, others four per token. */
function countTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** Mirrors nova's `truncateFactText` so the estimate measures what is injected. */
function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}

/** Mirrors nova's `renderFactLine`: the id, date, scope, kind and importance are injected too. */
function renderFactLine(fact: FactMemoryFact, text: string): string {
  const project = (fact.projects ?? [])[0];
  let scope: string = fact.applicability;
  if (fact.applicability === "transferable" && fact.originProject) {
    scope = `transferable(from ${basename(fact.originProject.path)})`;
  } else if (fact.applicability === "project" && project !== undefined) {
    scope = `project:${project}`;
  }
  return `- [${fact.id}] ${fact.createdAt.slice(0, 10)} · ${scope} · ${fact.kind} · imp ${fact.importance} · ${text}`;
}

/** Best-effort: the real pick is score-based, so mirror the cap with pinned facts first, then the newest. */
function estimateInjection(facts: FactMemoryFact[]): { count: number; tokens: number } {
  const selected = facts.filter(isActiveFact).slice(0, MAX_INJECTED_FACTS);
  const tokens = selected.reduce(
    (total, fact) => total + countTokens(renderFactLine(fact, truncateText(fact.text, MAX_INJECTED_CHARS))),
    INJECTION_BLOCK_OVERHEAD,
  );
  return { count: selected.length, tokens };
}

interface FactCardProps {
  fact: FactMemoryFact;
  busy: boolean;
  onAction: (fact: FactMemoryFact, action: MemoryFactAction) => void;
}

function FactCard({ fact, busy, onAction }: FactCardProps) {
  const tooltipId = useId();
  const pinHint = fact.pinned
    ? "取消置顶：恢复按相关性等规则选择这条记忆。"
    : "置顶：优先选入对话上下文，仍受适用范围和容量限制。";
  const archiveHint = "归档：保留记录，但不再注入对话。可在「已归档」中查看。";
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
          <span className="fact-memory-action">
          <button
            type="button"
            aria-describedby={`${tooltipId}-pin`}
            aria-label={fact.pinned ? `取消置顶：${fact.text}` : `置顶：${fact.text}`}
            disabled={busy}
            onClick={() => onAction(fact, fact.pinned ? "unpin" : "pin")}
          >
            {fact.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <span id={`${tooltipId}-pin`} role="tooltip" className="fact-memory-action-tooltip">{pinHint}</span>
          </span>
          <span className="fact-memory-action">
          <button
            type="button"
            aria-describedby={`${tooltipId}-archive`}
            aria-label={`归档：${fact.text}`}
            disabled={busy}
            onClick={() => onAction(fact, "archive")}
          >
            {busy ? <LoaderCircle size={14} /> : <Archive size={14} />}
          </button>
          <span id={`${tooltipId}-archive`} role="tooltip" className="fact-memory-action-tooltip">{archiveHint}</span>
          </span>
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
  const [filter, setFilter] = useState("all");
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
  const filtered = useMemo(
    () => (data?.facts ?? []).filter((fact) => factMatches(fact, needle) && matchesFilter(fact, filter)),
    [data, needle, filter],
  );
  const activeFacts = useMemo(() => filtered.filter(isActiveFact), [filtered]);
  const archivedFacts = useMemo(() => filtered.filter((fact) => !isActiveFact(fact)), [filtered]);
  const filterCounts = useMemo(() => {
    const scope: Record<string, number> = {};
    const kind: Record<string, number> = {};
    for (const fact of data?.facts ?? []) {
      if (!isActiveFact(fact)) continue;
      scope[fact.applicability] = (scope[fact.applicability] ?? 0) + 1;
      kind[fact.kind] = (kind[fact.kind] ?? 0) + 1;
    }
    return { scope, kind };
  }, [data]);
  const visibleGroups = useMemo(() => {
    if (filter.startsWith("kind:")) {
      if (activeFacts.length === 0) return [];
      const kind = filter.slice("kind:".length) as FactMemoryFact["kind"];
      return [{ id: kind, label: KIND_LABELS[kind] ?? kind, hint: "事实类型", facts: activeFacts }];
    }
    return GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      hint: group.hint,
      facts: activeFacts.filter((fact) => fact.applicability === group.id),
    })).filter((group) => group.facts.length > 0);
  }, [activeFacts, filter]);
  const injection = useMemo(() => estimateInjection(data?.facts ?? []), [data]);
  const stats = data?.stats;

  if (loading) {
    return (
      <section className="settings-card memory-surface">
        <div className="personalization-loading">
          <LoaderCircle size={16} /> 正在读取事实…
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="settings-card memory-surface">
        <div className="fact-memory-error" role="alert">
          <p className="personalization-error">读取事实失败：{error}</p>
          <button type="button" className="fact-memory-retry" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-card memory-surface">
      <div className="fact-memory-stats">
        <span>
          活跃 <strong>{stats?.active ?? 0}</strong>
        </span>
        <span>
          归档 <strong>{stats?.archived ?? 0}</strong>
        </span>
        <span title="按置顶与最近的 12 条估算，实际按会话相关性选择">
          预计注入 <strong>{injection.count}</strong> 条 · 约 <strong>{injection.tokens}</strong> tokens
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
        <label className="fact-memory-filter">
          <Filter size={14} aria-hidden="true" />
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="筛选记忆类型">
            <option value="all">全部记忆</option>
            <optgroup label="适用范围">
              {GROUPS.map((group) => (
                <option key={group.id} value={`scope:${group.id}`}>
                  {group.label}（{filterCounts.scope[group.id] ?? 0}）
                </option>
              ))}
            </optgroup>
            <optgroup label="事实类型">
              {(Object.keys(KIND_LABELS) as Array<FactMemoryFact["kind"]>).map((kind) => (
                <option key={kind} value={`kind:${kind}`}>
                  {KIND_LABELS[kind]}（{filterCounts.kind[kind] ?? 0}）
                </option>
              ))}
            </optgroup>
          </select>
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
          {needle || filter !== "all"
            ? "没有符合筛选的事实。"
            : (stats?.archived ?? 0) > 0
              ? "没有活跃事实。已归档的记录可通过上方「已归档」查看。"
              : "还没有事实。Nova 会在会话过程中抽取值得长期保留的信息。"}
        </p>
      ) : (
        visibleGroups.map((group) => (
          <section className="fact-memory-group" key={group.id}>
            <div className="fact-memory-group-header">
              <h2>{group.label}</h2>
              <span>
                {group.hint} · {group.facts.length} 条
              </span>
            </div>
            {group.facts.map((fact) => (
              <FactCard key={fact.id} fact={fact} busy={busyId === fact.id} onAction={(target, action) => void runAction(target, action)} />
            ))}
          </section>
        ))
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
    </section>
  );
}
