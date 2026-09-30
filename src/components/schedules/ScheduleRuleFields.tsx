import type { ScheduleRule } from "../../lib/tauri-bridge";
import { toLocalInputValue, localInputToRfc3339 } from "./schedule-rule";

const WEEKDAYS = [
  { value: 0, label: "一" },
  { value: 1, label: "二" },
  { value: 2, label: "三" },
  { value: 3, label: "四" },
  { value: 4, label: "五" },
  { value: 5, label: "六" },
  { value: 6, label: "日" },
];

export function ScheduleRuleFields({
  rule,
  onChange,
}: {
  rule: ScheduleRule;
  onChange: (rule: ScheduleRule) => void;
}) {
  const setKind = (kind: ScheduleRule["kind"]) => {
    if (kind === "once") {
      onChange({
        ...rule,
        kind: "once",
        recurrence: undefined,
        runAt: rule.runAt || localInputToRfc3339(toLocalInputValue(new Date(Date.now() + 60_000))),
      });
    } else {
      onChange({
        ...rule,
        kind: "recurring",
        recurrence: rule.recurrence && rule.recurrence !== undefined ? rule.recurrence : "daily",
        timeOfDay: rule.timeOfDay || "09:30",
        weekdays: rule.weekdays?.length ? rule.weekdays : [0],
        monthDays: rule.monthDays?.length ? rule.monthDays : [1],
        runAt: undefined,
      });
    }
  };

  const runAtLocal = rule.runAt ? toLocalInputValue(new Date(rule.runAt)) : "";

  return (
    <div className="schedule-rule-fields">
      <label>
        <span>触发方式</span>
        <div className="task-view-switch" role="group" aria-label="触发方式">
          <button type="button" aria-pressed={rule.kind === "once"} onClick={() => setKind("once")}>
            一次性
          </button>
          <button type="button" aria-pressed={rule.kind === "recurring"} onClick={() => setKind("recurring")}>
            重复
          </button>
        </div>
      </label>

      {rule.kind === "once" ? (
        <label>
          <span>执行时间</span>
          <input
            type="datetime-local"
            value={runAtLocal}
            onChange={(event) =>
              onChange({
                ...rule,
                kind: "once",
                runAt: localInputToRfc3339(event.target.value),
              })
            }
          />
        </label>
      ) : (
        <>
          <label>
            <span>重复规则</span>
            <select
              value={rule.recurrence ?? "daily"}
              onChange={(event) =>
                onChange({ ...rule, kind: "recurring", recurrence: event.target.value as ScheduleRule["recurrence"] })
              }
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="cron">自定义 cron</option>
            </select>
          </label>

          {rule.recurrence !== "cron" && (
            <label>
              <span>执行时刻</span>
              <input
                type="time"
                value={rule.timeOfDay ?? "09:30"}
                onChange={(event) => onChange({ ...rule, timeOfDay: event.target.value })}
              />
            </label>
          )}

          {rule.recurrence === "weekly" && (
            <div className="schedule-weekdays" role="group" aria-label="星期">
              <span>星期</span>
              <div className="schedule-weekday-row">
                {WEEKDAYS.map((day) => {
                  const selected = rule.weekdays?.includes(day.value) ?? false;
                  return (
                    <button
                      key={day.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        const current = new Set(rule.weekdays ?? []);
                        if (selected) current.delete(day.value);
                        else current.add(day.value);
                        const next = [...current].sort((a, b) => a - b);
                        onChange({ ...rule, weekdays: next.length ? next : [day.value] });
                      }}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {rule.recurrence === "monthly" && (
            <label>
              <span>每月日期（1–28，逗号分隔）</span>
              <input
                value={(rule.monthDays ?? []).join(", ")}
                onChange={(event) => {
                  const days = event.target.value
                    .split(/[,，\s]+/)
                    .map((part) => Number.parseInt(part, 10))
                    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 28);
                  onChange({ ...rule, monthDays: days.length ? days : [1] });
                }}
                placeholder="1, 15"
              />
            </label>
          )}

          {rule.recurrence === "cron" && (
            <label>
              <span>cron 表达式</span>
              <input
                value={rule.cron ?? ""}
                onChange={(event) => onChange({ ...rule, cron: event.target.value })}
                placeholder="0 9 * * *"
                spellCheck={false}
              />
            </label>
          )}
        </>
      )}
    </div>
  );
}
