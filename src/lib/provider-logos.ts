/** Provider logos bundled at build time (Simple Icons SVGs + vendor favicons). */
const LOGO_MODULES = import.meta.glob<string>("../assets/provider-logos/*.{svg,png,ico}", {
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

/** Logo URL for a provider id, or undefined when no asset is bundled. */
export function providerLogo(providerId: string): string | undefined {
  return PROVIDER_LOGOS[LOGO_ALIASES[providerId] ?? providerId];
}
