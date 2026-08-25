const ACTIVITY_KEY = "nova-studio.daily-interactions.v1";
export const ACTIVITY_UPDATED_EVENT = "nova-studio:activity-updated";

export interface DailyActivity {
  interactions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type DailyInteractions = Record<string, DailyActivity>;

function emptyActivity(): DailyActivity {
  return { interactions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function loadDailyInteractions(): DailyInteractions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([date, value]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      if (typeof value === "number") {
        return [[date, { ...emptyActivity(), interactions: Math.max(0, Math.floor(value)) }]];
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Partial<DailyActivity>;
      return [[date, {
        interactions: Math.max(0, Math.floor(Number(record.interactions) || 0)),
        inputTokens: Math.max(0, Math.floor(Number(record.inputTokens) || 0)),
        outputTokens: Math.max(0, Math.floor(Number(record.outputTokens) || 0)),
        cacheReadTokens: Math.max(0, Math.floor(Number(record.cacheReadTokens) || 0)),
        cacheWriteTokens: Math.max(0, Math.floor(Number(record.cacheWriteTokens) || 0)),
      }]];
    }));
  } catch {
    return {};
  }
}

export function recordUserInteraction(timestamp = Date.now()): void {
  const activity = loadDailyInteractions();
  const date = localDateKey(timestamp);
  const day = activity[date] ?? emptyActivity();
  activity[date] = { ...day, interactions: day.interactions + 1 };
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
  window.dispatchEvent(new CustomEvent(ACTIVITY_UPDATED_EVENT, { detail: { date, activity: activity[date] } }));
}

export function recordTokenUsage(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}, timestamp = Date.now()): void {
  const activity = loadDailyInteractions();
  const date = localDateKey(timestamp);
  const day = activity[date] ?? emptyActivity();
  activity[date] = {
    ...day,
    inputTokens: day.inputTokens + Math.max(0, Math.floor(usage.input ?? 0)),
    outputTokens: day.outputTokens + Math.max(0, Math.floor(usage.output ?? 0)),
    cacheReadTokens: day.cacheReadTokens + Math.max(0, Math.floor(usage.cacheRead ?? 0)),
    cacheWriteTokens: day.cacheWriteTokens + Math.max(0, Math.floor(usage.cacheWrite ?? 0)),
  };
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
  window.dispatchEvent(new CustomEvent(ACTIVITY_UPDATED_EVENT, { detail: { date, activity: activity[date] } }));
}
