import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Check, LayoutGrid, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import {
  deleteProviderConfiguration,
  getModelConfigurations,
  saveModelConfiguration,
  type ModelConfigurationInput,
  type ProviderConfiguration,
} from "../../lib/tauri-bridge";
import type { AvailableModel } from "../../stores/agent-store";

interface ModelSettingsProps {
  onSaved: () => Promise<void>;
  models: AvailableModel[];
}

/** Built-in providers that can be connected with a plain API key.
 * baseUrls/protocols mirror nova's packages/ai/src/providers/*.ts. */
const PRESET_PROVIDERS: { id: string; name: string; baseUrl: string; api: ModelConfigurationInput["api"] }[] = [
  { id: "anthropic", name: "Claude Official", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
  { id: "google", name: "Gemini Native", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-completions" },
  { id: "moonshotai-cn", name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
  { id: "moonshotai", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions" },
  { id: "kimi-coding", name: "Kimi For Coding", baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages" },
  { id: "zai", name: "Z.AI", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions" },
  { id: "zai-coding-cn", name: "Z.AI Coding CN", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions" },
  { id: "xiaomi", name: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan CN", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-completions" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan AMS", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", api: "openai-completions" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan SGP", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan CN", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages" },
  { id: "minimax-cn", name: "MiniMax CN", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions" },
  { id: "fireworks", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference", api: "anthropic-messages" },
  { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions" },
  { id: "together", name: "Together", baseUrl: "https://api.together.ai/v1", api: "openai-completions" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
  { id: "huggingface", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", api: "openai-completions" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh", api: "anthropic-messages" },
  { id: "ant-ling", name: "Ant Ling", baseUrl: "https://api.ant-ling.com/v1", api: "openai-completions" },
];

const CUSTOM_PROVIDER = "__custom__";

/** Provider logos bundled at build time (Simple Icons SVGs + vendor favicons). */
const LOGO_MODULES = import.meta.glob<string>("../../assets/provider-logos/*.{svg,png,ico}", {
  eager: true,
  query: "?url",
  import: "default",
});
const PROVIDER_LOGOS: Record<string, string> = {};
for (const [path, url] of Object.entries(LOGO_MODULES)) {
  PROVIDER_LOGOS[path.split("/").pop()!.replace(/\.(svg|png|ico)$/, "")] = url;
}
/** Preset ids whose logo lives under a shared brand file. */
const LOGO_ALIASES: Record<string, string> = {
  google: "googlegemini",
  "moonshotai-cn": "kimi",
  moonshotai: "kimi",
  "kimi-coding": "kimi",
  "xiaomi-token-plan-cn": "xiaomi",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-sgp": "xiaomi",
  "qwen-token-plan-cn": "qwen",
  "qwen-token-plan": "qwen",
  "minimax-cn": "minimax",
  "vercel-ai-gateway": "vercel",
  zai: "zhipu",
  "zai-coding-cn": "zhipu",
};

function providerLogo(providerId: string): string | undefined {
  return PROVIDER_LOGOS[LOGO_ALIASES[providerId] ?? providerId];
}

const INITIAL_FORM: ModelConfigurationInput = {
  providerId: "",
  modelId: "",
  displayName: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  images: false,
};

type ModelRow = Pick<ModelConfigurationInput, "modelId" | "displayName" | "contextWindow" | "maxTokens" | "reasoning" | "images">;

const INITIAL_MODEL_ROW: ModelRow = {
  modelId: "",
  displayName: "",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  images: false,
};

const AVATAR_COLORS = ["#4f6ef7", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#64748b"];

function avatarColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function ModelSettings({ onSaved, models }: ModelSettingsProps) {
  const [form, setForm] = useState<ModelConfigurationInput>(INITIAL_FORM);
  const [modelRows, setModelRows] = useState<ModelRow[]>([INITIAL_MODEL_ROW]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [presetQuery, setPresetQuery] = useState("");
  const [configs, setConfigs] = useState<ProviderConfiguration[]>([]);
  const [configsError, setConfigsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ providerId: string; modelId: string } | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const refreshConfigs = useCallback(async () => {
    try {
      setConfigs(await getModelConfigurations());
      setConfigsError(null);
    } catch (reason) {
      setConfigsError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refreshConfigs();
  }, [refreshConfigs]);

  const configMap = useMemo(() => new Map(configs.map((config) => [config.providerId, config])), [configs]);
  const connectedIds = useMemo(() => {
    const ids = new Set(configMap.keys());
    for (const model of models) ids.add(model.provider);
    return ids;
  }, [configMap, models]);

  const normalizedPresetQuery = presetQuery.trim().toLowerCase();
  const presetChips = useMemo(() => {
    const matched = PRESET_PROVIDERS.filter(
      (preset) => !normalizedPresetQuery || `${preset.id} ${preset.name}`.toLowerCase().includes(normalizedPresetQuery),
    );
    return matched.sort((left, right) => {
      const leftConnected = connectedIds.has(left.id) ? 0 : 1;
      const rightConnected = connectedIds.has(right.id) ? 0 : 1;
      return leftConnected - rightConnected || left.name.localeCompare(right.name);
    });
  }, [normalizedPresetQuery, connectedIds]);

  const selectedPreset = selected && selected !== CUSTOM_PROVIDER ? PRESET_PROVIDERS.find((preset) => preset.id === selected) : undefined;
  const selectedConfig = selected && selected !== CUSTOM_PROVIDER ? configMap.get(selected) : undefined;
  const selectedConnected = selected ? connectedIds.has(selected) : false;
  const isBuiltinSelection = Boolean(selectedPreset);
  const modelRequired = selected === CUSTOM_PROVIDER || editing !== null;

  const applyPresetPrefill = useCallback(
    (providerId: string) => {
      const preset = PRESET_PROVIDERS.find((entry) => entry.id === providerId);
      if (!preset) return;
      const savedConfig = configMap.get(providerId);
      const catalogModel = models.find((model) => model.provider === providerId);
      setForm({
        providerId: preset.id,
        modelId: catalogModel?.id ?? "",
        displayName: catalogModel && catalogModel.name !== catalogModel.id ? catalogModel.name : "",
        baseUrl: preset.baseUrl,
        api: preset.api,
        apiKey: savedConfig?.apiKey ?? "",
        contextWindow: catalogModel?.contextWindow || INITIAL_FORM.contextWindow,
        maxTokens: catalogModel?.maxTokens || INITIAL_FORM.maxTokens,
        reasoning: catalogModel?.reasoning ?? false,
        images: catalogModel?.images ?? false,
      });
      setModelRows([catalogModel ? {
        modelId: catalogModel.id,
        displayName: catalogModel.name !== catalogModel.id ? catalogModel.name : "",
        contextWindow: catalogModel.contextWindow || INITIAL_MODEL_ROW.contextWindow,
        maxTokens: catalogModel.maxTokens || INITIAL_MODEL_ROW.maxTokens,
        reasoning: catalogModel.reasoning,
        images: catalogModel.images,
      } : INITIAL_MODEL_ROW]);
    },
    [configMap, models],
  );

  const selectPreset = (providerId: string) => {
    setSelected(providerId);
    setEditing(null);
    setError(null);
    setSaved(false);
    if (providerId === CUSTOM_PROVIDER) {
      setForm(INITIAL_FORM);
      setModelRows([INITIAL_MODEL_ROW]);
      return;
    }
    applyPresetPrefill(providerId);
  };

  const update = <K extends keyof ModelConfigurationInput>(key: K, value: ModelConfigurationInput[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const updateModelRow = <K extends keyof ModelRow>(index: number, key: K, value: ModelRow[K]) => {
    setModelRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
    setSaved(false);
  };

  const addModelRow = () => {
    setModelRows((current) => [...current, { ...INITIAL_MODEL_ROW }]);
    setSaved(false);
  };

  const removeModelRow = (index: number) => {
    setModelRows((current) => current.length === 1 ? [INITIAL_MODEL_ROW] : current.filter((_, rowIndex) => rowIndex !== index));
    setSaved(false);
  };

  const cancelEdit = () => {
    setEditing(null);
    setError(null);
    if (selected && selected !== CUSTOM_PROVIDER) applyPresetPrefill(selected);
    else {
      setForm(INITIAL_FORM);
      setModelRows([INITIAL_MODEL_ROW]);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const rows = modelRows.filter((row) => row.modelId?.trim());
      if (modelRequired && rows.length === 0) throw new Error("请至少添加一个模型 ID");
      const modelIds = rows.map((row) => row.modelId!.trim());
      if (new Set(modelIds).size !== modelIds.length) throw new Error("模型 ID 不能重复");
      if (rows.length === 0) {
        await saveModelConfiguration({ ...form, modelId: "" });
      } else {
        for (const [index, row] of rows.entries()) {
          await saveModelConfiguration({ ...form, ...row, apiKey: index === 0 ? form.apiKey : "" });
        }
      }
      await onSaved();
      await refreshConfigs();
      setSaved(true);
      if (editing) setEditing(null);
      if (!selected || selected === CUSTOM_PROVIDER) {
        setForm(INITIAL_FORM);
        setModelRows([INITIAL_MODEL_ROW]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeProvider = async (providerId: string, custom: boolean) => {
    const message = custom
      ? `确定删除 Provider「${providerId}」及其全部模型？将同时移除该 Provider 的 API Key，此操作不可撤销。`
      : `确定移除 Provider「${providerId}」的 API Key？移除后需重新接入才能使用，此操作不可撤销。`;
    const confirmed = await ask(message, { title: custom ? "删除 Provider" : "移除 API Key", kind: "warning" });
    if (!confirmed) return;
    try {
      await deleteProviderConfiguration(providerId);
      if (selected === providerId) setSelected(null);
      await refreshConfigs();
      await onSaved();
    } catch (reason) {
      setConfigsError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <header className="settings-page-header">
        <h1>模型</h1>
        <p>选择预设供应商接入，或自定义模型服务。保存后可在新会话的模型选择器中使用。</p>
      </header>

      <section className="settings-card model-catalog-card">
        <div className="model-catalog-header">
          <div className="settings-card-copy">
            <h2><LayoutGrid size={15} />预设供应商 <span className="model-count">{PRESET_PROVIDERS.length}</span></h2>
            <p>选中一个供应商，在下方填入接入信息。已接入的供应商会高亮显示。</p>
          </div>
          <label className="model-search">
            <Search size={14} />
            <input value={presetQuery} onChange={(event) => setPresetQuery(event.target.value)} placeholder="搜索供应商" aria-label="搜索预设供应商" />
          </label>
        </div>
        {configsError && <p className="model-settings-error model-configs-error">读取配置失败：{configsError}</p>}
        <div className="model-preset-grid">
          <button
            type="button"
            className={`model-preset-chip${selected === CUSTOM_PROVIDER ? " model-preset-chip-selected" : ""}`}
            onClick={() => selectPreset(CUSTOM_PROVIDER)}
          >
            <span className="model-preset-avatar model-preset-avatar-custom"><Plus size={13} /></span>
            <span className="model-preset-name">自定义配置</span>
          </button>
          {presetChips.map((preset) => {
            const connected = connectedIds.has(preset.id);
            const logo = providerLogo(preset.id);
            return (
              <button
                type="button"
                key={preset.id}
                className={`model-preset-chip${selected === preset.id ? " model-preset-chip-selected" : ""}${connected ? " model-preset-chip-connected" : ""}`}
                onClick={() => selectPreset(preset.id)}
              >
                {logo ? (
                  <img className="model-preset-logo" src={logo} alt="" />
                ) : (
                  <span className="model-preset-avatar" style={{ background: avatarColor(preset.id) }}>{preset.name.slice(0, 1)}</span>
                )}
                <span className="model-preset-name">{preset.name}</span>
                {connected && (
                  <span className="model-preset-check" title="已接入"><Check size={11} /></span>
                )}
              </button>
            );
          })}
          {presetChips.length === 0 && <div className="model-catalog-empty">没有匹配的供应商</div>}
        </div>
        <p className="model-preset-footnote">💡 已接入的供应商会排在前面并带 ✓ 标记；自定义配置需手动填写所有必要字段。</p>
      </section>

      {selected && (
        <section className="settings-card model-settings-card model-preset-detail-card" ref={formRef}>
          <div className="model-preset-detail-header">
            <div className="settings-card-copy model-settings-heading">
              <h2>
                {selected === CUSTOM_PROVIDER ? (
                  <><Plus size={15} />自定义配置</>
                ) : (
                  <>
                    {providerLogo(selected) ? (
                      <img className="model-preset-logo model-preset-logo-sm" src={providerLogo(selected)} alt="" />
                    ) : (
                      <span className="model-preset-avatar model-preset-avatar-sm" style={{ background: avatarColor(selected) }}>
                        {selectedPreset?.name.slice(0, 1) ?? "?"}
                      </span>
                    )}
                    {selectedPreset?.name ?? selected}
                  </>
                )}
                <span className={`model-preset-state-badge${selectedConnected ? " model-preset-state-connected" : ""}`}>
                  {selectedConnected ? "已接入" : "未接入"}
                </span>
              </h2>
              <p>
                {selected === CUSTOM_PROVIDER
                  ? "手动填写所有必要字段，相同 Provider ID 和模型 ID 会更新已有配置。"
                  : selectedConnected
                    ? "管理接入信息和模型。"
                    : "填入 API Key 即可接入；模型 ID 留空则使用内置模型目录。"}
              </p>
            </div>
            {selectedConfig && selected !== CUSTOM_PROVIDER && (
              <button
                type="button"
                className="model-icon-btn model-icon-danger"
                onClick={() => void removeProvider(selected, selectedConfig.models.length > 0)}
              >
                <Trash2 size={12} />{selectedConfig.models.length > 0 ? "删除 Provider" : "移除 API Key"}
              </button>
            )}
          </div>

          <form onSubmit={(event) => void submit(event)}>
            <div className="model-settings-grid">
              {!isBuiltinSelection && (
                <label>
                  <span>Provider ID</span>
                  <input
                    required
                    value={form.providerId}
                    onChange={(event) => update("providerId", event.target.value)}
                    placeholder="例如 openai-compatible"
                  />
                </label>
              )}
              <label className={isBuiltinSelection ? "model-settings-wide" : undefined}><span>API 协议</span><select value={form.api} onChange={(event) => update("api", event.target.value as ModelConfigurationInput["api"])}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
              <label className="model-settings-wide"><span>Base URL</span><input required={modelRequired} type="url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" /></label>
              <label className="model-settings-wide"><span>API Key <small>{selectedConnected ? "已回填，可直接修改" : "请输入访问密钥"}</small></span><input type="text" autoComplete="off" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder="sk-..." /></label>
            </div>

            <div className="model-list-editor">
              <div className="model-list-editor-header">
                <div>
                  <strong>模型</strong>
                  {!modelRequired && <small>可选；不填写则使用内置模型目录</small>}
                </div>
                {!editing && <button type="button" className="model-add-row" onClick={addModelRow}><Plus size={13} />添加模型</button>}
              </div>
              {modelRows.map((row, index) => (
                <div className="model-row-editor" key={index}>
                  <div className="model-row-editor-title">
                    <span>模型 {index + 1}</span>
                    {!editing && <button type="button" className="model-icon-btn model-icon-danger" onClick={() => removeModelRow(index)} title="移除此模型"><Trash2 size={13} /></button>}
                  </div>
                  <div className="model-settings-grid">
                    <label><span>模型 ID</span><input required={modelRequired || modelRows.length > 1} value={row.modelId ?? ""} onChange={(event) => updateModelRow(index, "modelId", event.target.value)} placeholder="例如 gpt-5" /></label>
                    <label><span>显示名称 <small>可选</small></span><input value={row.displayName ?? ""} onChange={(event) => updateModelRow(index, "displayName", event.target.value)} placeholder="模型在选择器中的名称" /></label>
                    <label><span>上下文窗口</span><input required={Boolean(row.modelId?.trim())} min={1} type="number" value={row.contextWindow} onChange={(event) => updateModelRow(index, "contextWindow", Number(event.target.value))} /></label>
                    <label><span>最大输出 Token</span><input required={Boolean(row.modelId?.trim())} min={1} max={row.contextWindow} type="number" value={row.maxTokens} onChange={(event) => updateModelRow(index, "maxTokens", Number(event.target.value))} /></label>
                  </div>
                  <div className="model-settings-options">
                    <label><input type="checkbox" checked={row.reasoning} onChange={(event) => updateModelRow(index, "reasoning", event.target.checked)} /><span>支持推理</span></label>
                    <label><input type="checkbox" checked={row.images} onChange={(event) => updateModelRow(index, "images", event.target.checked)} /><span>支持图片输入</span></label>
                  </div>
                </div>
              ))}
            </div>

            <div className="model-settings-actions">
              <div aria-live="polite">
                {error && <p className="model-settings-error">{error}</p>}
                {saved && <p className="model-settings-success"><Check size={14} />已保存并刷新</p>}
              </div>
              <div className="model-settings-submit-row">
                {editing && (
                  <button type="button" className="model-settings-cancel" onClick={cancelEdit}>取消编辑</button>
                )}
                <button type="submit" disabled={saving}>{saving ? <LoaderCircle className="tool-spin" size={15} /> : <Check size={15} />}{saving ? "保存中…" : editing ? "保存修改" : selectedConnected ? "更新接入" : "接入"}</button>
              </div>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
