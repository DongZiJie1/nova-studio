import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, LoaderCircle, RotateCcw, Save, Search } from "lucide-react";
import {
  getSearchSettings,
  saveSearchSettings,
  type SearchSettingsState,
} from "../../lib/tauri-bridge";

/**
 * One `web_search` provider. The ids and limits mirror nova's
 * `packages/nova/src/core/search/config.ts`; `deepseek` reuses the DeepSeek
 * credential that `/login` writes to auth.json.
 */
interface ProviderOption {
  id: string;
  name: string;
  tag: string;
  description: string;
  /** A key stored in settings.json is required for this provider. */
  needsKey: boolean;
  keyEnv?: string;
  /** Whether this provider reads `search.baseUrl` (gateway / self-hosted). */
  supportsBaseUrl?: boolean;
  baseUrlRequired?: boolean;
  baseUrlPlaceholder?: string;
  keyPlaceholder?: string;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: "so",
    name: "360 搜索 (so.com)",
    tag: "默认 · 无需密钥",
    description: "国内网络可直接访问，结果里的跳转链接会自动解析为真实地址。",
    needsKey: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek 搜索",
    tag: "需要密钥 · 按次计费",
    description:
      "DeepSeek 自研搜索引擎（POST /v1/tools/search），用 /login 保存的 DeepSeek 密钥即可。按成功请求计费，约 ¥5 / 1000 次；空结果不计费。",
    needsKey: true,
    keyEnv: "DEEPSEEK_API_KEY",
    supportsBaseUrl: true,
    baseUrlPlaceholder: "https://api.deepseek.com",
    keyPlaceholder: "留空则使用 auth.json 里的 DeepSeek 密钥",
  },
  {
    id: "bing",
    name: "Bing",
    tag: "无需密钥",
    description: "抓取 Bing 网页搜索结果，适合英文内容。",
    needsKey: false,
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    tag: "无需密钥",
    description: "抓取 DuckDuckGo HTML 结果；部分网络下会被限流或屏蔽。",
    needsKey: false,
  },
  {
    id: "brave",
    name: "Brave Search",
    tag: "需要密钥",
    description: "Brave 官方搜索 API，结果稳定；调用次数受订阅额度限制。",
    needsKey: true,
    keyEnv: "BRAVE_API_KEY",
    keyPlaceholder: "Brave Search 订阅令牌",
  },
  {
    id: "tavily",
    name: "Tavily",
    tag: "需要密钥",
    description: "Tavily 搜索 API，摘要里带有更多页面正文，适合调研类问题。",
    needsKey: true,
    keyEnv: "TAVILY_API_KEY",
    keyPlaceholder: "tvly-...",
  },
  {
    id: "searxng",
    name: "SearXNG",
    tag: "自建",
    description: "指向你自己的 SearXNG 实例，需要该实例开启 JSON 输出格式。",
    needsKey: false,
    supportsBaseUrl: true,
    baseUrlRequired: true,
    baseUrlPlaceholder: "https://searx.example",
  },
];

function providerById(id: string): ProviderOption {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function SearchSettings() {
  const [state, setState] = useState<SearchSettingsState | null>(null);
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [maxResults, setMaxResults] = useState(5);
  const [timeoutMs, setTimeoutMs] = useState(20_000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => providerById(provider), [provider]);

  const applyState = useCallback((next: SearchSettingsState) => {
    setState(next);
    setProvider(next.provider);
    setApiKey(next.apiKey ?? "");
    setBaseUrl(next.baseUrl ?? "");
    setMaxResults(next.maxResults);
    setTimeoutMs(next.timeoutMs);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    void getSearchSettings()
      .then((next) => applyState(next))
      .catch((reason: unknown) => {
        setError(String(reason));
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [applyState]);

  useEffect(() => {
    load();
  }, [load]);

  const currentBaseUrl = active.supportsBaseUrl ? baseUrl.trim() : (state?.baseUrl ?? "").trim();
  const dirty =
    state !== null &&
    (provider !== state.provider ||
      apiKey.trim() !== (state.apiKey ?? "") ||
      currentBaseUrl !== (state.baseUrl ?? "") ||
      maxResults !== state.maxResults ||
      timeoutMs !== state.timeoutMs);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await saveSearchSettings({
        provider,
        // An empty key removes the stored one so nova can fall back to
        // auth.json (deepseek) or the provider-specific env var.
        apiKey: apiKey.trim() || undefined,
        baseUrl: currentBaseUrl || undefined,
        maxResults: clampInteger(maxResults, 5, 1, 10),
        timeoutMs: clampInteger(timeoutMs, 20_000, 1_000, 60_000),
      });
      applyState(next);
      setSaved(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const keyHint = (() => {
    if (active.id === "deepseek" && !apiKey.trim()) {
      return state?.deepseekAuthKeyAvailable
        ? "已检测到 /login 保存的 DeepSeek 密钥，API Key 可以留空。"
        : "未检测到 DeepSeek 密钥：填写密钥、设置 DEEPSEEK_API_KEY，或先 /login 登录 DeepSeek。";
    }
    if (active.needsKey && !apiKey.trim() && active.keyEnv) {
      return `留空时 nova 会尝试读取环境变量 ${active.keyEnv}。`;
    }
    if (active.id === "searxng") {
      return "需要填写实例地址，并确保该实例允许 JSON 格式输出。";
    }
    if (active.supportsBaseUrl) {
      return "可选：填写网关或代理地址；留空使用官方地址。";
    }
    return "该服务无需密钥，直接保存即可使用。";
  })();

  return (
    <div>
      <header className="settings-page-header">
        <h1>网络搜索</h1>
        <p>选择 Nova 的 web_search 工具使用的搜索服务。配置写入 settings.json 的 search 段，下一次搜索即生效。</p>
      </header>

      <div className="settings-card">
        <div className="settings-card-copy">
          <h2>当前配置</h2>
          <p>聊天时模型自动调用 web_search；这里只决定它走哪个服务。</p>
        </div>
        {state && (
          <div className="model-saved-tags">
            <span className="model-saved-tag model-saved-tag-accent">{providerById(state.provider).name}</span>
            <span className="model-saved-tag">
              {state.apiKey
                ? "已保存密钥"
                : state.provider === "deepseek" && state.deepseekAuthKeyAvailable
                  ? "使用 auth.json 密钥"
                  : "无密钥"}
            </span>
            <span className="model-saved-tag">{state.maxResults} 条结果</span>
            <span className="model-saved-tag">{Math.round(state.timeoutMs / 1000)}s 超时</span>
          </div>
        )}
      </div>

      <form className="settings-card model-settings-card" onSubmit={(event) => void submit(event)}>
        <div className="model-settings-heading">
          <div className="settings-card-copy">
            <h2>
              <Search size={16} />
              搜索服务
            </h2>
            <p>保存后写入全局设置；通过环境变量覆盖的值仍然优先。</p>
          </div>
        </div>

        <div className="model-settings-grid">
          <label className="model-settings-wide">
            <span>服务提供方</span>
            <select
              value={provider}
              disabled={loading || saving}
              onChange={(event) => {
                const next = event.target.value;
                setProvider(next);
                setSaved(false);
                setError(null);
                // Never carry one provider's credential or gateway over to
                // another provider; switching back re-fills the saved values.
                if (state && next === state.provider) {
                  setApiKey(state.apiKey ?? "");
                  setBaseUrl(state.baseUrl ?? "");
                } else {
                  setApiKey("");
                  setBaseUrl("");
                }
              }}
            >
              {PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · {option.tag}
                </option>
              ))}
            </select>
          </label>

          <div className="model-settings-wide settings-card-copy">
            <p>{active.description}</p>
          </div>

          <label className="model-settings-wide">
            <span>
              API Key{" "}
              <small>
                {active.needsKey
                  ? active.id === "deepseek"
                    ? "可用 /login 密钥或环境变量代替"
                    : "必填（可用环境变量代替）"
                  : "可选"}
              </small>
            </span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={loading || saving}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaved(false);
              }}
              placeholder={
                active.id === "deepseek" && !state?.deepseekAuthKeyAvailable
                  ? "sk-..."
                  : (active.keyPlaceholder ?? "无需填写")
              }
            />
          </label>

          {active.supportsBaseUrl && (
            <label className="model-settings-wide">
              <span>
                Base URL <small>{active.baseUrlRequired ? "必填" : "可选"}</small>
              </span>
              <input
                type="url"
                required={active.baseUrlRequired}
                value={baseUrl}
                disabled={loading || saving}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setSaved(false);
                }}
                placeholder={active.baseUrlPlaceholder}
              />
            </label>
          )}

          <label>
            <span>
              返回条数 <small>1–10</small>
            </span>
            <input
              type="number"
              min={1}
              max={10}
              value={maxResults}
              disabled={loading || saving}
              onChange={(event) => {
                setMaxResults(Number(event.target.value));
                setSaved(false);
              }}
            />
          </label>

          <label>
            <span>
              超时（毫秒）<small>1000–60000</small>
            </span>
            <input
              type="number"
              min={1000}
              max={60000}
              step="any"
              value={timeoutMs}
              disabled={loading || saving}
              onChange={(event) => {
                setTimeoutMs(Number(event.target.value));
                setSaved(false);
              }}
            />
          </label>
        </div>

        <div className="model-settings-actions">
          {error ? (
            <p className="model-settings-error">{error}</p>
          ) : saved ? (
            <p className="model-settings-success">
              <Check size={14} />
              已保存
            </p>
          ) : (
            <p>{keyHint}</p>
          )}
          {loadFailed ? (
            <button type="button" disabled={loading} onClick={() => load()}>
              {loading ? <LoaderCircle size={15} className="tool-spin" /> : <RotateCcw size={15} />}
              重试
            </button>
          ) : (
            <button type="submit" disabled={loading || saving || !dirty}>
              {saving ? <LoaderCircle size={15} className="tool-spin" /> : <Save size={15} />}
              保存设置
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
