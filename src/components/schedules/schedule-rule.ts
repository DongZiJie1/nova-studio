import type {
  AutomationPermissionMode,
  AutomationSessionMode,
  ScheduleRule,
  ScheduleRunStatus,
} from "../../lib/tauri-bridge";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export const PERMISSION_LABELS: Record<AutomationPermissionMode, string> = {
  ask: "需确认",
  edits: "可改文件",
  allow: "完全允许",
};

export const PERMISSION_HINTS: Record<AutomationPermissionMode, string> = {
  ask: "触发后工具调用会等待确认，适合首次试跑。",
  edits: "允许读写文件，无需逐步确认，适合无人值守。",
  allow: "放开全部工具权限，仅用于高度信任的自动化。",
};

export const SESSION_MODE_LABELS: Record<AutomationSessionMode, string> = {
  fresh: "每次新建会话",
  reuse: "复用同一会话",
};

export const SESSION_MODE_HINTS: Record<AutomationSessionMode, string> = {
  fresh: "每次触发都开一条新会话，历次运行互不影响。",
  reuse: "所有触发都在同一条会话里继续，之前的调研和结论会保留在上下文中。",
};

export const RUN_STATUS_LABELS: Record<ScheduleRunStatus, string> = {
  running: "执行中",
  completed: "已完成",
  error: "出错",
  missed: "已错过",
  skipped: "已跳过",
};

export function formatRuleSummary(rule: ScheduleRule): string {
  if (rule.kind === "once") {
    return rule.runAt ? `指定时刻 ${formatDateTime(rule.runAt)}` : "指定时刻";
  }
  switch (rule.recurrence) {
    case "daily":
      return `每天 ${rule.timeOfDay ?? ""}`.trim();
    case "weekly": {
      const days = (rule.weekdays ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d] ?? String(d))
        .join("、");
      return `每周${days || "?"} ${rule.timeOfDay ?? ""}`.trim();
    }
    case "monthly": {
      const days = (rule.monthDays ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => `${d} 日`)
        .join("、");
      return `每月${days || "?"} ${rule.timeOfDay ?? ""}`.trim();
    }
    case "cron":
      return `cron ${rule.cron ?? ""}`.trim();
    default:
      return "重复规则";
  }
}

export function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toLocalInputValue(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToRfc3339(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

export function defaultRule(): ScheduleRule {
  return {
    kind: "recurring",
    recurrence: "daily",
    timeOfDay: "09:30",
    weekdays: [0],
    monthDays: [1],
  };
}
