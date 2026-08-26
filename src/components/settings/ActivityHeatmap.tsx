import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ACTIVITY_UPDATED_EVENT, loadDailyInteractions, type DailyActivity, type DailyInteractions } from "../../lib/activity-tracker";

const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const WEEKDAYS = ["", "周一", "", "周三", "", "周五", ""];

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activityLevel(count: number): number {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 7) return 3;
  return 4;
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: tokens >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(tokens);
}

function buildCalendar(year: number, activity: DailyInteractions) {
  const first = new Date(year, 0, 1);
  const last = new Date(year, 11, 31);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - last.getDay()));

  const weeks: Array<Array<{ date: Date; activity: DailyActivity; inYear: boolean }>> = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    if (cursor.getDay() === 0) weeks.push([]);
    const date = new Date(cursor);
    weeks[weeks.length - 1].push({
      date,
      activity: activity[dateKey(date)] ?? { interactions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      inYear: date.getFullYear() === year,
    });
  }
  return weeks;
}

export function ActivityHeatmap() {
  const currentYear = new Date().getFullYear();
  const [activity, setActivity] = useState<DailyInteractions>(() => loadDailyInteractions());
  const activityYears = Object.keys(activity).map((date) => Number(date.slice(0, 4)));
  const earliestYear = Math.min(currentYear, ...activityYears);
  const years = Array.from({ length: currentYear - earliestYear + 1 }, (_, index) => currentYear - index);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [tooltip, setTooltip] = useState<{ day: DailyActivity; date: Date; x: number; y: number } | null>(null);

  useEffect(() => {
    const refresh = () => setActivity(loadDailyInteractions());
    window.addEventListener(ACTIVITY_UPDATED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(ACTIVITY_UPDATED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const weeks = useMemo(() => buildCalendar(selectedYear, activity), [selectedYear, activity]);
  const total = Object.entries(activity)
    .filter(([date]) => date.startsWith(`${selectedYear}-`))
    .reduce((sum, [, day]) => sum + day.interactions, 0);
  const activeDays = Object.entries(activity).filter(([date, day]) => date.startsWith(`${selectedYear}-`) && day.interactions > 0).length;

  return (
    <div className="activity-settings-layout">
      <section className="activity-settings-main">
        <header className="settings-page-header activity-page-heading">
          <div>
            <h1>活跃度</h1>
            <p>记录你每天与 Nova 的有效交互，仅在本机保存日期和次数。</p>
          </div>
          <nav className="activity-years" aria-label="选择年份">
            {years.map((year) => (
              <button key={year} type="button" className={year === selectedYear ? "activity-year-active" : ""} onClick={() => setSelectedYear(year)}>
                {year}
              </button>
            ))}
          </nav>
        </header>

        <div className="activity-summary-row">
          <div><strong>{total}</strong><span>{selectedYear} 年交互</span></div>
          <div><strong>{activeDays}</strong><span>活跃天数</span></div>
        </div>

        <div className="activity-heatmap-card">
          <div className="activity-heatmap-scroll">
            <div className="activity-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(8px, 1fr))` }}>
              {weeks.map((week, index) => {
                const firstInMonth = week.find((day) => day.inYear && day.date.getDate() === 1);
                return <span key={index}>{firstInMonth ? MONTHS[firstInMonth.date.getMonth()] : ""}</span>;
              })}
            </div>
            <div className="activity-calendar-row">
              <div className="activity-weekdays">
                {WEEKDAYS.map((day, index) => <span key={index}>{day}</span>)}
              </div>
              <div className="activity-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(8px, 1fr))` }}>
                {weeks.flatMap((week, weekIndex) => week.map((day) => (
                  <span
                    key={`${weekIndex}-${dateKey(day.date)}`}
                    className={`activity-cell activity-level-${activityLevel(day.activity.interactions)} ${day.inYear ? "" : "activity-cell-outside"}`}
                    onMouseEnter={(event) => day.inYear && setTooltip({ day: day.activity, date: day.date, x: event.clientX, y: event.clientY })}
                    onMouseMove={(event) => tooltip && setTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)}
                    onMouseLeave={() => setTooltip(null)}
                  />
                )))}
              </div>
            </div>
          </div>
          <footer className="activity-legend">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`activity-cell activity-level-${level}`} />)}
            <span>多</span>
          </footer>
        </div>

        <p className="activity-privacy-note">每发送一条用户消息计为一次交互。不会保存或分析消息正文，也不会上传活跃度数据。</p>
        {tooltip && createPortal(
          <div className="activity-tooltip" style={{ left: tooltip.x + 14, top: tooltip.y + 14 }} role="tooltip">
            <strong>{tooltip.date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" })}</strong>
            <dl>
              <div><dt>交互</dt><dd>{tooltip.day.interactions} 次</dd></div>
              <div><dt>总 Token</dt><dd>{formatTokens(tooltip.day.inputTokens + tooltip.day.outputTokens)}</dd></div>
              <div><dt>输入 / 输出</dt><dd>{formatTokens(tooltip.day.inputTokens)} / {formatTokens(tooltip.day.outputTokens)}</dd></div>
              <div><dt>缓存读取</dt><dd>{formatTokens(tooltip.day.cacheReadTokens)}</dd></div>
              {tooltip.day.cacheWriteTokens > 0 && <div><dt>缓存写入</dt><dd>{formatTokens(tooltip.day.cacheWriteTokens)}</dd></div>}
            </dl>
          </div>,
          document.body,
        )}
      </section>
    </div>
  );
}
