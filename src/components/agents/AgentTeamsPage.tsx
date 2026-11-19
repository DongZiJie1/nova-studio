import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Brain,
  FileText,
  FolderOpen,
  Globe,
  History,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UserRound,
  Wrench,
  X,
  Layers as LayersIcon,
} from "lucide-react";
import { AgentCapabilityPicker } from "./AgentCapabilityPicker";
import { AgentInstructionsEditor } from "./AgentInstructionsEditor";
import { open } from "@tauri-apps/plugin-dialog";
import {
  archivePersistentAgentMemory,
  deletePersistentAgent,
  getPersistentAgentMemory,
  listPersistentAgents,
  listAgentTools,
  runPersistentAgent,
  savePersistentAgent,
  type AgentInput,
  type PersistentAgent,
} from "../../lib/persistent-agents";
import type { AgentInfo } from "../../lib/rpc-types";
import type { FactMemoryState } from "../../lib/tauri-bridge";
import { useAgentStore } from "../../stores/agent-store";
import "../todos/task-trees.css";
import "./agent-teams.css";

const empty = (): AgentInput => ({
  name: "",
  description: "",
  instructions: "# Agent\n\n描述身份、职责、工作方法和输出要求。\n",
  tools: [],
  skills: [],
});

export function AgentTeamsPage({
  projects,
  onStarted,
  onOpenSession,
}: {
  projects: Array<{ path: string; name: string }>;
  onStarted: (info: AgentInfo, prompt: string, name: string) => Promise<void>;
  onOpenSession: (id: string) => void;
}) {
  const [items, setItems] = useState<PersistentAgent[]>([]);
  const [draft, setDraft] = useState<AgentInput | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "identity" | "instructions" | "capabilities" | "memory" | "history" | "run"
  >("identity");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<FactMemoryState | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [project, setProject] = useState(projects[0]?.path ?? "");
  const [prompt, setPrompt] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<
    PersistentAgent | null | undefined
  >(undefined);
  const memoryRequest = useRef(0);
  const editorContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    editorContentRef.current?.scrollTo({ top: 0 });
  }, [tab, selected]);
  const agents = useAgentStore((s) => s.agents);
  const current = items.find((item) => item.id === selected);
  const dirty =
    draft !== null &&
    (current
      ? JSON.stringify({
          name: current.name,
          description: current.description,
          instructions: current.instructions,
          tools: current.tools,
          skills: current.skills,
          id: current.id,
        }) !== JSON.stringify(draft)
      : true);
  const refresh = useCallback(async () => {
    try {
      setItems(await listPersistentAgents());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const loadMemory = useCallback(async (id: string) => {
    const request = ++memoryRequest.current;
    setMemoryLoading(true);
    setMemory(null);
    try {
      const value = await getPersistentAgentMemory(id);
      if (request === memoryRequest.current) setMemory(value);
    } catch (e) {
      if (request === memoryRequest.current) setError(String(e));
    } finally {
      if (request === memoryRequest.current) setMemoryLoading(false);
    }
  }, []);
  useEffect(() => {
    ++memoryRequest.current;
    setMemory(null);
    if (tab === "memory" && selected) void loadMemory(selected);
  }, [tab, selected, loadMemory]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const applyChoice = async (item: PersistentAgent | null) => {
    setPendingChoice(undefined);
    setError(null);
    if (!item) {
      setBusy(true);
      try {
        const catalog = await listAgentTools();
        setSelected(null);
        setTab("identity");
        setDeleteConfirm(false);
        setDraft({
          ...empty(),
          tools: catalog
            .filter((tool) => tool.defaultEnabled)
            .map((tool) => tool.name),
        });
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(false);
      }
      return;
    }
    setSelected(item.id);
    setTab("identity");
    setDeleteConfirm(false);
    setDraft({
      name: item.name,
      description: item.description,
      instructions: item.instructions,
      tools: [...item.tools],
      skills: [...item.skills],
      id: item.id,
    });
  };
  const choose = (item: PersistentAgent | null) => {
    if (dirty) setPendingChoice(item);
    else applyChoice(item);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    action(async () => {
      if (!draft) return;
      const value = await savePersistentAgent(draft);
      setItems((previous) => [
        ...previous.filter((item) => item.id !== value.id),
        value,
      ]);
      setSelected(value.id);
      setDraft({
        name: value.name,
        description: value.description,
        instructions: value.instructions,
        tools: value.tools,
        skills: value.skills,
        id: value.id,
      });
    });
  const filtered = items.filter((item) =>
    `${item.name} ${item.description}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );

  return (
    <section className="todo-page task-page agent-teams-page">
      <header className="task-page-header">
        <div>
          <span className="todo-eyebrow">YOUR AGENT WORKSPACE</span>
          <h1>
            Agent Teams <small>{items.length}</small>
          </h1>
          <p>为不同职责配置专属 Agent，让身份、技能与经验持续积累。</p>
        </div>
        <button
          className="todo-primary-button"
          disabled={busy || loading}
          onClick={() => choose(null)}
        >
          <Plus size={16} />
          新建 Agent
        </button>
      </header>
      {error && (
        <div className="agent-error" role="alert">
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {pendingChoice !== undefined && (
        <div className="agent-unsaved-notice" role="alert">
          <span>当前修改尚未保存，要切换 Agent 吗？</span>
          <button onClick={() => setPendingChoice(undefined)}>继续编辑</button>
          <button onClick={() => applyChoice(pendingChoice)}>放弃修改</button>
        </div>
      )}
      <div className="agent-workbench">
        <aside className="agent-profile-list" aria-label="Agent 列表">
          <div className="agent-list-heading">
            <span>全部 Agent</span>
            <small>{items.length}</small>
          </div>
          <label className="agent-list-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="搜索 Agent"
              placeholder="搜索 Agent…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="agent-profile-items">
            {loading ? (
              <div className="agent-section-empty">
                <LoaderCircle size={20} className="todo-spinner" />
                正在读取…
              </div>
            ) : filtered.length === 0 ? (
              <div className="agent-list-empty">
                <Bot size={26} />
                <p>{items.length ? "没有匹配的 Agent" : "还没有 Agent"}</p>
                <span>
                  {items.length ? "试试其他关键词" : "从一个明确的职责开始创建"}
                </span>
              </div>
            ) : (
              filtered.map((item) => (
                <button
                  className={`agent-profile-card ${selected === item.id ? "selected" : ""}`}
                  aria-current={selected === item.id ? "true" : undefined}
                  key={item.id}
                  disabled={busy}
                  onClick={() => choose(item)}
                >
                  <span className="agent-profile-avatar">
                    <Bot size={19} />
                  </span>
                  <span className="agent-profile-copy">
                    <strong>{item.name}</strong>
                    <small>{item.description || "全局持久化 Agent"}</small>
                    <span className="agent-profile-meta">
                      {item.tools.length} 个工具<span>·</span>
                      {item.skills.length} 个技能
                    </span>
                  </span>
                  <span className="agent-profile-selected-dot" />
                </button>
              ))
            )}
          </div>
          <div className="agent-list-footer">
            <Globe size={14} />
            <span>全局可用 · 跨项目复用</span>
          </div>
        </aside>
        {!draft ? (
          <div className="agent-editor agent-welcome">
            <div className="agent-welcome-icon">
              <Bot size={32} strokeWidth={1.4} />
            </div>
            <span className="agent-welcome-eyebrow">
              A ROLE. A WAY OF WORKING.
            </span>
            <h2>创建你的长期协作伙伴</h2>
            <p>
              把职责、工作方法和可用能力交给一个专属
              Agent。每次任务独立执行，经验持续保留。
            </p>
            <button
              className="todo-primary-button"
              disabled={loading}
              onClick={() => choose(null)}
            >
              <Plus size={16} />
              新建 Agent
            </button>
          </div>
        ) : (
          <div className="agent-editor">
            <header className="agent-editor-heading">
              <span className="agent-editor-avatar">
                <Bot size={25} strokeWidth={1.5} />
              </span>
              <div className="agent-editor-title">
                <div>
                  <h2>{draft.name || "新建 Agent"}</h2>
                  <span className="agent-global-badge">
                    <Globe size={11} />
                    全局
                  </span>
                </div>
                <p>
                  <span
                    className={`agent-save-dot ${dirty ? "unsaved" : ""}`}
                  />
                  {dirty ? "有未保存的修改" : "所有修改已保存"}
                </p>
              </div>
              <div className="agent-editor-actions">
                {selected && (
                  <button
                    className="agent-secondary-button"
                    disabled={busy}
                    onClick={() => setTab("run")}
                  >
                    <Play size={14} />
                    运行
                  </button>
                )}
                <button
                  className="todo-primary-button"
                  disabled={busy || !dirty || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="todo-spinner" />
                  ) : (
                    <Save size={15} />
                  )}
                  {selected ? "保存修改" : "创建 Agent"}
                </button>
              </div>
            </header>
            <nav className="agent-tabs" aria-label="Agent 配置">
              <button
                aria-pressed={tab === "identity"}
                onClick={() => setTab("identity")}
              >
                <UserRound size={14} />
                基本信息
              </button>
              <button
                aria-pressed={tab === "instructions"}
                onClick={() => setTab("instructions")}
              >
                <FileText size={14} />
                身份指令
              </button>
              <button
                aria-pressed={tab === "capabilities"}
                onClick={() => setTab("capabilities")}
              >
                <Wrench size={14} />
                工具与技能
              </button>
              <button
                disabled={!selected}
                aria-pressed={tab === "memory"}
                onClick={() => setTab("memory")}
              >
                <Brain size={14} />
                独立记忆
              </button>
              <button
                disabled={!selected}
                aria-pressed={tab === "history"}
                onClick={() => {
                  setTab("history");
                  void refresh();
                }}
              >
                <History size={14} />
                执行记录
                {current?.runs.length ? (
                  <small>{current.runs.length}</small>
                ) : null}
              </button>
            </nav>
            <div className="agent-editor-content" ref={editorContentRef}>
              {tab === "identity" && (
                <section className="agent-identity-section">
                  <div className="agent-config-section-heading">
                    <span className="agent-section-icon">
                      <UserRound size={18} />
                    </span>
                    <div>
                      <h3>基本信息</h3>
                      <p>一个容易辨认的名字，一项清晰的职责。</p>
                    </div>
                  </div>
                  <div className="agent-identity-fields">
                    <label>
                      <span>
                        名称 <small>必填</small>
                      </span>
                      <input
                        maxLength={80}
                        disabled={busy}
                        value={draft.name}
                        placeholder="例如 Reviewer、研究助手、技术写作"
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>简介</span>
                      <textarea
                        rows={3}
                        disabled={busy}
                        value={draft.description}
                        placeholder="用一句话描述这个 Agent 擅长什么，以及你希望它负责的事。"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            description: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="agent-summary-grid">
                    <button onClick={() => setTab("instructions")}>
                      <FileText size={18} />
                      <span>
                        身份指令<strong>AGENTS.md</strong>
                      </span>
                      <ArrowUpRight size={14} />
                    </button>
                    <button onClick={() => setTab("capabilities")}>
                      <Wrench size={18} />
                      <span>
                        可用工具<strong>{draft.tools.length} 个工具</strong>
                      </span>
                      <ArrowUpRight size={14} />
                    </button>
                    <button onClick={() => setTab("capabilities")}>
                      <LayersIcon size={18} />
                      <span>
                        专属技能<strong>{draft.skills.length} 个 Skill</strong>
                      </span>
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="agent-identity-note">
                    <Brain size={17} />
                    <p>
                      身份配置和记忆长期保留。切换项目后，仍然可以使用同一个
                      Agent。
                    </p>
                  </div>
                  {current && (
                    <footer className="agent-identity-footer">
                      <span>
                        创建于{" "}
                        {new Date(current.createdAt).toLocaleDateString()}
                        <br />
                        最近更新 {new Date(current.updatedAt).toLocaleString()}
                      </span>
                      {deleteConfirm ? (
                        <div className="agent-delete-confirm">
                          <p>删除此 Agent 的身份、配置与记忆？</p>
                          <button
                            disabled={busy}
                            onClick={() => setDeleteConfirm(false)}
                          >
                            取消
                          </button>
                          <button
                            className="agent-danger"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await deletePersistentAgent(current.id);
                                setSelected(null);
                                setDraft(null);
                                setDeleteConfirm(false);
                                await refresh();
                              })
                            }
                          >
                            确认删除
                          </button>
                        </div>
                      ) : (
                        <button
                          className="agent-danger"
                          disabled={busy}
                          onClick={() => setDeleteConfirm(true)}
                        >
                          <Trash2 size={14} />
                          删除 Agent
                        </button>
                      )}
                    </footer>
                  )}
                </section>
              )}
              {tab === "instructions" && (
                <AgentInstructionsEditor
                  key={selected ?? "new"}
                  content={draft.instructions}
                  disabled={busy}
                  onChange={(instructions) =>
                    setDraft({ ...draft, instructions })
                  }
                />
              )}
              {tab === "capabilities" && (
                <AgentCapabilityPicker
                  tools={draft.tools}
                  skills={draft.skills}
                  disabled={busy}
                  onToolsChange={(tools) => setDraft({ ...draft, tools })}
                  onSkillsChange={(skills) => setDraft({ ...draft, skills })}
                />
              )}
              {tab === "memory" && (
                <section className="agent-memory">
                  <div className="agent-config-section-heading">
                    <span className="agent-section-icon">
                      <Brain size={18} />
                    </span>
                    <div>
                      <h3>独立记忆</h3>
                      <p>随任务积累的经验，只属于这个 Agent。</p>
                    </div>
                    <button
                      className="agent-icon-button"
                      aria-label="刷新记忆"
                      disabled={memoryLoading}
                      onClick={() => selected && void loadMemory(selected)}
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>
                  {memoryLoading ? (
                    <div className="agent-section-empty">
                      <LoaderCircle size={22} className="todo-spinner" />
                      正在读取记忆…
                    </div>
                  ) : !memory ? (
                    <div className="agent-section-empty">
                      记忆读取失败，请点击刷新重试。
                    </div>
                  ) : memory.facts.length === 0 ? (
                    <div className="agent-section-empty">
                      <Brain size={28} strokeWidth={1.3} />
                      <strong>经验从第一次任务开始</strong>
                      <p>
                        运行任务后，记忆会逐渐积累，并在相关任务中被检索使用。
                      </p>
                    </div>
                  ) : (
                    memory.facts.map((fact) => (
                      <article key={fact.id} className="agent-memory-item">
                        <p>{fact.text}</p>
                        <footer>
                          <small>
                            {fact.archivedAt ? "已归档" : "活跃记忆"}
                          </small>
                          {!fact.archivedAt && (
                            <button
                              className="agent-secondary-button"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await archivePersistentAgentMemory(
                                    selected!,
                                    fact.id,
                                  );
                                  await loadMemory(selected!);
                                })
                              }
                            >
                              归档
                            </button>
                          )}
                        </footer>
                      </article>
                    ))
                  )}
                </section>
              )}
              {tab === "history" && (
                <section className="agent-history">
                  <div className="agent-config-section-heading">
                    <span className="agent-section-icon">
                      <History size={18} />
                    </span>
                    <div>
                      <h3>执行记录</h3>
                      <p>每次任务都有独立会话，点击查看完整执行过程。</p>
                    </div>
                  </div>
                  {!current?.runs.length ? (
                    <div className="agent-section-empty">
                      <History size={28} strokeWidth={1.3} />
                      <strong>还没有执行记录</strong>
                      <p>选择项目，交给它第一个任务。</p>
                      <button
                        className="agent-secondary-button"
                        onClick={() => setTab("run")}
                      >
                        <Play size={14} />
                        发起任务
                      </button>
                    </div>
                  ) : (
                    [...current.runs].reverse().map((run) => (
                      <button
                        className="agent-history-row"
                        key={run.agentId}
                        onClick={() => onOpenSession(run.agentId)}
                      >
                        <span className="agent-history-icon">
                          <Play size={16} />
                        </span>
                        <span className="agent-history-copy">
                          <strong>{run.prompt}</strong>
                          <small>{run.projectPath}</small>
                          <small>
                            {new Date(run.createdAt).toLocaleString()} ·{" "}
                            {agents.find((agent) => agent.id === run.agentId)
                              ?.status ?? "已保存"}
                          </small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                    ))
                  )}
                </section>
              )}
              {tab === "run" && selected && (
                <section className="agent-run-panel">
                  <div className="agent-config-section-heading">
                    <span className="agent-section-icon">
                      <Play size={18} />
                    </span>
                    <div>
                      <h3>发起任务</h3>
                      <p>选择一个项目，为 {draft.name} 创建新的独立会话。</p>
                    </div>
                  </div>
                  <label>
                    <span>项目</span>
                    <div className="agent-project-picker">
                      <select
                        aria-label="执行项目"
                        value={project}
                        disabled={busy}
                        onChange={(event) => setProject(event.target.value)}
                      >
                        <option value="">选择项目…</option>
                        {[
                          ...new Map(
                            [
                              ...projects,
                              ...(project &&
                              !projects.some((item) => item.path === project)
                                ? [{ path: project, name: project }]
                                : []),
                            ].map((item) => [item.path, item]),
                          ).values(),
                        ].map((item) => (
                          <option key={item.path} value={item.path}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="agent-secondary-button"
                        disabled={busy}
                        aria-label="选择项目文件夹"
                        onClick={() =>
                          void action(async () => {
                            const path = await open({
                              directory: true,
                              multiple: false,
                            });
                            if (typeof path === "string") setProject(path);
                          })
                        }
                      >
                        <FolderOpen size={16} />
                        浏览
                      </button>
                    </div>
                  </label>
                  <label>
                    <span>任务内容</span>
                    <textarea
                      rows={7}
                      disabled={busy}
                      value={prompt}
                      placeholder="描述你希望这个 Agent 完成的任务…"
                      onChange={(event) => setPrompt(event.target.value)}
                    />
                  </label>
                  <div className="agent-run-footer">
                    <span>
                      {dirty
                        ? "请先保存配置修改，再运行任务。"
                        : "使用已保存的身份、工具、技能与独立记忆。"}
                    </span>
                    <button
                      className="todo-primary-button"
                      disabled={busy || dirty || !project || !prompt.trim()}
                      onClick={() =>
                        void action(async () => {
                          const info = await runPersistentAgent(
                            selected,
                            project,
                            prompt,
                          );
                          await onStarted(info, prompt, draft.name);
                        })
                      }
                    >
                      <Play size={15} />
                      {busy ? "正在创建会话…" : "运行 Agent"}
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
