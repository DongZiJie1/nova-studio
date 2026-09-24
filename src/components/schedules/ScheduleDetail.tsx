import { X, Play, ExternalLink, Trash2, Power } from "lucide-react";
import type { ScheduledTask } from "../../lib/tauri-bridge";
import {
  PERMISSION_LABELS,
  RUN_STATUS_LABELS,
  formatDateTime,
  formatRuleSummary,
} from "./schedule-rule";

export function ScheduleDetail({
  task,
  onClose,
  onEdit,
  onRunNow,
  onToggle,
  onDelete,
  onOpenSession,
  busy,
}: {
  task: ScheduledTask;
  onClose: () => void;
  onEdit: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onOpenSession: () => void;
  busy: boolean;
}) {
  return (
    <div
      className="task-detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <aside className="todo-detail todo-detail-open" role="dialog" aria-label="定时任务详情">
        <button type="button" className="todo-icon-button todo-detail-close" onClick={onClose} aria-label="关闭">
          <X size={16} />
        </button>
        <div className="todo-detail-fields" key={task.id}>
          <section className="todo-detail-hero">
            <div className="todo-detail-hero-meta">
              <span
                className={`todo-detail-status todo-detail-status-${task.lastRunStatus ?? (task.enabled ? "pending" : "completed")}`}
              >
                {task.lastRunStatus
                  ? RUN_STATUS_LABELS[task.lastRunStatus]
                  : task.enabled
                    ? "待触发"
                    : "已停用"}
              </span>
              <span className="schedule-chip schedule-chip-permission">
                {PERMISSION_LABELS[task.permissionMode]}
              </span>
            </div>
            <div className="todo-detail-hero-title">
              <h1>{task.title}</h1>
            </div>
          </section>

          <section className="todo-detail-section todo-detail-properties">
            <span className="todo-detail-section-title">任务属性</span>
            <div className="todo-detail-properties-grid schedule-properties-grid">
              <div className="todo-property-field">
                <span>触发规则</span>
                <strong className="schedule-property-value">{formatRuleSummary(task.schedule)}</strong>
              </div>
              <div className="todo-property-field">
                <span>下次执行</span>
                <strong className={`schedule-property-value${task.nextRunAt ? "" : " schedule-property-value-empty"}`}>
                  {formatDateTime(task.nextRunAt)}
                </strong>
              </div>
              <div className="todo-property-field">
                <span>上次执行</span>
                <strong className={`schedule-property-value${task.lastRunAt ? "" : " schedule-property-value-empty"}`}>
                  {formatDateTime(task.lastRunAt)}
                </strong>
              </div>
              <div className="todo-property-field">
                <span>所属项目</span>
                <strong
                  className={`schedule-property-value${task.projectPath ? "" : " schedule-property-value-empty"}`}
                  title={task.projectPath}
                >
                  {task.projectPath || "—"}
                </strong>
              </div>
              <div className="todo-property-field">
                <span>权限模式</span>
                <strong className="schedule-property-value">{PERMISSION_LABELS[task.permissionMode]}</strong>
              </div>
              <div className="todo-property-field">
                <span>Worktree</span>
                <strong className="schedule-property-value">{task.worktreeEnabled ? "开启" : "关闭"}</strong>
              </div>
            </div>
          </section>

          <section className="todo-detail-section todo-detail-content-section">
            <span className="todo-detail-section-title">任务说明</span>
            <pre className="schedule-prompt-block">{task.prompt}</pre>
            {task.description ? <p className="schedule-note">{task.description}</p> : null}
          </section>

          <section className="todo-detail-section todo-detail-content-section">
            <span className="todo-detail-section-title">运行历史</span>
            {task.runs.length === 0 ? (
              <p className="schedule-note">还没有执行记录。</p>
            ) : (
              <ul className="schedule-run-list">
                {task.runs.map((run) => (
                  <li key={run.id}>
                    <div className="schedule-run-row">
                      <span className={`schedule-chip schedule-chip-${run.status}`}>
                        {RUN_STATUS_LABELS[run.status]}
                      </span>
                      <span>{formatDateTime(run.startedAt)}</span>
                      {run.catchUp ? <span className="schedule-note">补跑</span> : null}
                    </div>
                    {run.error ? <p className="schedule-run-error">{run.error}</p> : null}
                    {run.summary ? <p className="schedule-note">{run.summary}</p> : null}
                    {run.agentId ? (
                      <button type="button" className="task-toolbar-button" onClick={onOpenSession}>
                        <ExternalLink size={13} />
                        打开会话
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="todo-detail-footer-actions">
            <button type="button" className="todo-primary-button" disabled={busy} onClick={onRunNow}>
              <Play size={14} />
              立即执行
            </button>
            <button type="button" className="todo-secondary-button" disabled={busy} onClick={onEdit}>
              编辑
            </button>
            <button type="button" className="todo-secondary-button" disabled={busy} onClick={onToggle}>
              <Power size={14} />
              {task.enabled ? "停用" : "启用"}
            </button>
            <button type="button" className="todo-secondary-button" disabled={busy} onClick={onOpenSession}>
              <ExternalLink size={14} />
              打开会话
            </button>
            <button
              type="button"
              className="todo-secondary-button schedule-danger"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
