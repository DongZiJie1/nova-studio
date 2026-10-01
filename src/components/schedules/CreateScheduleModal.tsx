import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, X } from "lucide-react";
import {
  createScheduledTask,
  updateScheduledTask,
  type AutomationPermissionMode,
  type AutomationSessionMode,
  type CreateScheduledTaskInput,
  type ScheduleRule,
  type ScheduledTask,
  type ScheduledTaskState,
} from "../../lib/tauri-bridge";
import {
  PERMISSION_HINTS,
  PERMISSION_LABELS,
  SESSION_MODE_HINTS,
  SESSION_MODE_LABELS,
  defaultRule,
} from "./schedule-rule";
import { ScheduleRuleFields } from "./ScheduleRuleFields";

export interface ScheduleFormValue {
  title: string;
  prompt: string;
  description: string;
  projectPath: string;
  schedule: ScheduleRule;
  permissionMode: AutomationPermissionMode;
  sessionMode: AutomationSessionMode;
  worktreeEnabled: boolean;
}

export function CreateScheduleModal({
  editing,
  projects,
  onClose,
  onSaved,
  onError,
}: {
  editing?: ScheduledTask | null;
  projects: Array<{ path: string; name: string }>;
  onClose: () => void;
  onSaved: (state: ScheduledTaskState) => void;
  onError: (error: string) => void;
}) {
  const modalRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ScheduleFormValue>(() => ({
    title: editing?.title ?? "",
    prompt: editing?.prompt ?? "",
    description: editing?.description ?? "",
    projectPath: editing?.projectPath ?? projects[0]?.path ?? "",
    schedule: editing?.schedule ?? defaultRule(),
    permissionMode: editing?.permissionMode ?? "ask",
    sessionMode: editing?.sessionMode ?? "reuse",
    worktreeEnabled: editing?.worktreeEnabled ?? false,
  }));

  useEffect(() => {
    const dialog = modalRef.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim() || !form.prompt.trim() || !form.projectPath.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        onSaved(
          await updateScheduledTask({
            id: editing.id,
            title: form.title,
            prompt: form.prompt,
            description: form.description,
            projectPath: form.projectPath,
            schedule: form.schedule,
            permissionMode: form.permissionMode,
            sessionMode: form.sessionMode,
            worktreeEnabled: form.worktreeEnabled,
          }),
        );
      } else {
        const input: CreateScheduledTaskInput = {
          title: form.title,
          prompt: form.prompt,
          description: form.description || undefined,
          projectPath: form.projectPath,
          schedule: form.schedule,
          permissionMode: form.permissionMode,
          sessionMode: form.sessionMode,
          worktreeEnabled: form.worktreeEnabled,
        };
        onSaved(await createScheduledTask(input));
      }
    } catch (reason) {
      onError(String(reason));
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="todo-modal-backdrop"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <form
        ref={modalRef}
        className="todo-modal"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-modal-title"
      >
        <header>
          <span className="todo-modal-icon">
            <CalendarClock size={16} />
          </span>
          <div>
            <h2 id="schedule-modal-title">{editing ? "编辑定时任务" : "新建定时任务"}</h2>
            <p>到点自动 spawn Nova 执行；权限与运行状态独立于普通待办。</p>
          </div>
          <button type="button" className="todo-icon-button" disabled={saving} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="todo-modal-fields">
          <label>
            <span>标题</span>
            <input
              autoFocus
              value={form.title}
              maxLength={120}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="例如：每日行业调研"
            />
          </label>
          <label>
            <span>
              任务说明 <small>{form.prompt.length}/50000</small>
            </span>
            <textarea
              value={form.prompt}
              maxLength={50000}
              rows={5}
              onChange={(event) => setForm({ ...form, prompt: event.target.value })}
              placeholder="发给 Nova 的完整任务描述与验收要求…"
            />
          </label>
          <label>
            <span>备注（不发给 Agent）</span>
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="仅自己查看的说明"
            />
          </label>
          <label>
            <span>所属项目</span>
            <select
              value={form.projectPath}
              onChange={(event) => setForm({ ...form, projectPath: event.target.value })}
            >
              {projects.length === 0 ? <option value="">请选择项目</option> : null}
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
              {form.projectPath && !projects.some((p) => p.path === form.projectPath) ? (
                <option value={form.projectPath}>{form.projectPath}</option>
              ) : null}
            </select>
          </label>

          <ScheduleRuleFields rule={form.schedule} onChange={(schedule) => setForm({ ...form, schedule })} />

          <label>
            <span>权限模式</span>
            <select
              value={form.permissionMode}
              onChange={(event) =>
                setForm({ ...form, permissionMode: event.target.value as AutomationPermissionMode })
              }
            >
              {(Object.keys(PERMISSION_LABELS) as AutomationPermissionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_LABELS[mode]}
                </option>
              ))}
            </select>
            <small className="schedule-field-hint">{PERMISSION_HINTS[form.permissionMode]}</small>
          </label>

          <label>
            <span>会话模式</span>
            <select
              value={form.sessionMode}
              onChange={(event) =>
                setForm({ ...form, sessionMode: event.target.value as AutomationSessionMode })
              }
            >
              {(Object.keys(SESSION_MODE_LABELS) as AutomationSessionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {SESSION_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
            <small className="schedule-field-hint">{SESSION_MODE_HINTS[form.sessionMode]}</small>
          </label>

          <label className="schedule-checkbox-row">
            <input
              type="checkbox"
              checked={form.worktreeEnabled}
              onChange={(event) => setForm({ ...form, worktreeEnabled: event.target.checked })}
            />
            <span>在独立 worktree 中执行（需要项目是 git 仓库）</span>
          </label>
          {form.sessionMode === "reuse" && form.worktreeEnabled ? (
            <small className="schedule-field-hint">复用会话时忽略 worktree，直接在项目目录中继续。</small>
          ) : null}
        </div>

        <footer>
          <button type="button" className="todo-secondary-button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="todo-primary-button"
            disabled={saving || !form.title.trim() || !form.prompt.trim() || !form.projectPath.trim()}
          >
            {saving ? "保存中…" : editing ? "保存修改" : "创建定时任务"}
          </button>
        </footer>
      </form>
    </div>,
    document.querySelector<HTMLElement>("[data-custom-background]") ?? document.body,
  );
}
