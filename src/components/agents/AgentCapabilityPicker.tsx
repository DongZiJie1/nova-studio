import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  listInstalledAgentSkills,
  listAgentTools,
  type AgentToolCatalogItem,
  type InstalledAgentSkill,
} from "../../lib/persistent-agents";

function ChoiceCard({
  name,
  description,
  hint,
  icon: Icon,
  checked,
  disabled,
  unavailable,
  onChange,
}: {
  name: string;
  description?: string;
  hint?: string;
  icon: LucideIcon;
  checked: boolean;
  disabled: boolean;
  unavailable?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      title={hint ? `${name}\n${hint}` : name}
      className={`agent-tool-card ${description ? "agent-skill-card" : ""} ${unavailable ? "agent-skill-unavailable" : ""}`}
    >
      <input
        type="checkbox"
        aria-label={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="agent-tool-check" aria-hidden="true">
        <Check size={13} strokeWidth={3} />
      </span>
      <Icon
        className="agent-tool-icon"
        size={19}
        strokeWidth={1.7}
        aria-hidden="true"
      />
      <span className="agent-choice-copy">
        <span className="agent-tool-name">{name}</span>
        {description && (
          <span className="agent-skill-description">{description}</span>
        )}
        {unavailable && (
          <span className="agent-skill-status">当前不可用 · 可取消选择</span>
        )}
      </span>
    </label>
  );
}

export function AgentCapabilityPicker({
  tools,
  skills,
  disabled,
  onToolsChange,
  onSkillsChange,
}: {
  tools: string[];
  skills: string[];
  disabled: boolean;
  onToolsChange: (tools: string[]) => void;
  onSkillsChange: (skills: string[]) => void;
}) {
  const [catalog, setCatalog] = useState<InstalledAgentSkill[]>([]);
  const [toolCatalog, setToolCatalog] = useState<AgentToolCatalogItem[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const toolsRequest = useRef(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const items = await listInstalledAgentSkills();
      if (mounted.current && token === request.current) setCatalog(items);
    } catch (reason) {
      if (mounted.current && token === request.current)
        setError(String(reason));
    } finally {
      if (mounted.current && token === request.current) setLoading(false);
    }
  }, []);
  const refreshTools = useCallback(async () => {
    const token = ++toolsRequest.current;
    setToolsLoading(true);
    setToolsError(null);
    try {
      const items = await listAgentTools();
      if (mounted.current && token === toolsRequest.current)
        setToolCatalog(items);
    } catch (reason) {
      if (mounted.current && token === toolsRequest.current)
        setToolsError(String(reason));
    } finally {
      if (mounted.current && token === toolsRequest.current)
        setToolsLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([refresh(), refreshTools()]);
    return () => {
      mounted.current = false;
      ++request.current;
      ++toolsRequest.current;
    };
  }, [refresh, refreshTools]);
  const missing =
    loading || error
      ? []
      : skills.filter((name) => !catalog.some((skill) => skill.name === name));
  const choices = [
    ...catalog.map((skill) => ({ ...skill, unavailable: false })),
    ...missing.map((name) => ({
      name,
      description: "该 Agent 之前选择的 Skill 暂时不可用。",
      filePath: "",
      unavailable: true,
    })),
  ];
  const filtered = choices.filter((skill) =>
    `${skill.name} ${skill.description}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const missingTools =
    toolsLoading || toolsError
      ? []
      : tools.filter((name) => !toolCatalog.some((tool) => tool.name === name));
  const toolChoices = [
    ...toolCatalog.map((tool) => ({ ...tool, unavailable: false })),
    ...missingTools.map((name) => ({
      name,
      description: "该 Agent 之前选择的工具未在当前运行时注册。",
      defaultEnabled: false,
      sourceInfo: undefined,
      unavailable: true,
    })),
  ].filter((tool) =>
    `${tool.name} ${tool.description}`
      .toLocaleLowerCase()
      .includes(toolQuery.toLocaleLowerCase()),
  );
  return (
    <div className="agent-capabilities">
      <section className="agent-config-section">
        <div className="agent-config-section-heading">
          <span className="agent-section-icon">
            <Wrench size={18} />
          </span>
          <div>
            <h3>
              可用工具 <small>{tools.length} 已选择</small>
            </h3>
            <p>来自 Agent 当前已注册的工具，包含内置工具和扩展工具。</p>
          </div>
          <button
            className="agent-icon-button"
            aria-label="刷新工具列表"
            disabled={toolsLoading}
            onClick={() => void refreshTools()}
          >
            <RefreshCw
              size={16}
              className={toolsLoading ? "todo-spinner" : ""}
            />
          </button>
        </div>
        <label className="agent-skill-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索工具"
            placeholder="搜索工具名称或用途…"
            value={toolQuery}
            onChange={(event) => setToolQuery(event.target.value)}
          />
        </label>
        {toolsLoading ? (
          <div className="agent-section-empty" role="status">
            <LoaderCircle size={20} className="todo-spinner" />
            正在读取 Agent 工具…
          </div>
        ) : toolsError ? (
          <div className="agent-catalog-error" role="alert">
            <span>{toolsError}</span>
            <button onClick={() => void refreshTools()}>重新加载工具</button>
          </div>
        ) : toolChoices.length ? (
          <fieldset
            disabled={disabled}
            className="agent-choice-fieldset"
            aria-label="可用工具"
          >
            <div className="agent-tool-grid">
              {toolChoices.map((tool) => (
                <ChoiceCard
                  key={tool.name}
                  name={tool.name}
                  hint={tool.description}
                  icon={tool.sourceInfo?.source === "builtin" ? Wrench : Puzzle}
                  unavailable={tool.unavailable}
                  checked={tools.includes(tool.name)}
                  disabled={disabled}
                  onChange={(checked) =>
                    onToolsChange(
                      checked
                        ? [...tools, tool.name]
                        : tools.filter((name) => name !== tool.name),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="agent-section-empty">
            <Wrench size={24} />
            <strong>
              {toolQuery ? "没有匹配的工具" : "当前 Agent 没有注册工具"}
            </strong>
          </div>
        )}
      </section>
      <section className="agent-config-section">
        <div className="agent-config-section-heading">
          <span className="agent-section-icon">
            <Puzzle size={18} />
          </span>
          <div>
            <h3>
              Skills <small>{skills.length} 已选择</small>
            </h3>
            <p>从已安装的技能中选择，让 Agent 在任务中使用相应的工作方法。</p>
          </div>
          <button
            className="agent-icon-button"
            aria-label="刷新 Skill 列表"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? "todo-spinner" : ""} />
          </button>
        </div>
        <label className="agent-skill-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="搜索 Skill"
            placeholder="搜索技能名称或用途…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {loading ? (
          <div className="agent-section-empty" role="status">
            <LoaderCircle size={20} className="todo-spinner" />
            正在读取已安装的 Skill…
          </div>
        ) : error ? (
          <div className="agent-catalog-error" role="alert">
            <span>{error}</span>
            <button onClick={() => void refresh()}>重新加载</button>
          </div>
        ) : filtered.length ? (
          <fieldset
            disabled={disabled}
            className="agent-choice-fieldset"
            aria-label="可用 Skills"
          >
            <div className="agent-skill-grid">
              {filtered.map((skill) => (
                <ChoiceCard
                  key={skill.name}
                  name={skill.name}
                  description={skill.description}
                  icon={Puzzle}
                  unavailable={skill.unavailable}
                  checked={skills.includes(skill.name)}
                  disabled={disabled}
                  onChange={(checked) =>
                    onSkillsChange(
                      checked
                        ? [...skills, skill.name]
                        : skills.filter((name) => name !== skill.name),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="agent-section-empty">
            <Puzzle size={24} />
            <strong>{query ? "没有匹配的 Skill" : "还没有安装 Skill"}</strong>
            <p>
              {query
                ? "换个关键词试试。"
                : "安装技能后刷新列表，即可在这里选择。"}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
