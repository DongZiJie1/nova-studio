//! Scheduled tasks (定时任务) — separate from todos.
//!
//! Storage lives in `~/.nova/agent/scheduled-tasks.json`. Automations have
//! their own permission mode and run state, deliberately not merged into
//! `todos.json` (product: 自动化与普通待办必须使用不同的权限和运行状态).

use crate::commands::{nova_agent_dir, write_private_json};
use chrono::{DateTime, Datelike, Duration, Local, NaiveTime};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

pub static SCHEDULE_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub const SCHEDULE_TITLE_MAX: usize = 120;
pub const SCHEDULE_PROMPT_MAX: usize = 50_000;
pub const SCHEDULE_RUNS_CAP: usize = 20;
/// Overdue window within which a missed slot is still fired once as catch-up.
pub const CATCH_UP_WINDOW_MINUTES: i64 = 60;
pub const MAX_CONCURRENT_FIRES: usize = 2;
/// Session continuity for scheduled runs: `fresh` starts a new Nova session
/// on every fire, `reuse` keeps appending to the task's stored session file.
pub const SESSION_MODE_FRESH: &str = "fresh";
pub const SESSION_MODE_REUSE: &str = "reuse";

/// Stored tasks without the field predate session reuse and keep firing fresh.
fn default_session_mode() -> String {
	SESSION_MODE_FRESH.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRule {
	pub kind: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub run_at: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub recurrence: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub time_of_day: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub weekdays: Option<Vec<u8>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub month_days: Option<Vec<u8>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cron: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub timezone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
	pub id: String,
	pub task_id: String,
	pub started_at: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub finished_at: Option<String>,
	pub status: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub agent_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub catch_up: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
	pub id: String,
	pub title: String,
	pub prompt: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	pub project_path: String,
	pub enabled: bool,
	pub schedule: ScheduleRule,
	pub permission_mode: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub provider: Option<String>,
	/// `fresh` (default for pre-existing tasks) or `reuse`.
	#[serde(default = "default_session_mode")]
	pub session_mode: String,
	/// Absolute path of the Nova session file this task continues in `reuse` mode.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_file: Option<String>,
	#[serde(default)]
	pub worktree_enabled: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub last_run_at: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub last_run_status: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub last_agent_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub last_session_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub next_run_at: Option<String>,
	#[serde(default)]
	pub missed_count: u32,
	#[serde(default)]
	pub runs: Vec<ScheduledRun>,
	pub created_at: String,
	pub updated_at: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskState {
	pub version: u8,
	pub items: Vec<ScheduledTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduledTaskInput {
	pub title: String,
	pub prompt: String,
	pub description: Option<String>,
	pub project_path: String,
	pub schedule: ScheduleRule,
	pub permission_mode: Option<String>,
	pub model: Option<String>,
	pub provider: Option<String>,
	pub session_mode: Option<String>,
	pub worktree_enabled: Option<bool>,
	pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScheduledTaskInput {
	pub id: String,
	pub title: Option<String>,
	pub prompt: Option<String>,
	pub description: Option<String>,
	pub project_path: Option<String>,
	pub schedule: Option<ScheduleRule>,
	pub permission_mode: Option<String>,
	pub model: Option<String>,
	pub provider: Option<String>,
	pub session_mode: Option<String>,
	pub worktree_enabled: Option<bool>,
	pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordScheduledRunResultInput {
	pub task_id: String,
	pub run_id: String,
	pub status: String,
	pub error: Option<String>,
	pub summary: Option<String>,
}

pub fn scheduled_tasks_path() -> Result<PathBuf, String> {
	Ok(nova_agent_dir()?.join("scheduled-tasks.json"))
}

pub fn read_scheduled_task_state() -> Result<ScheduledTaskState, String> {
	let path = scheduled_tasks_path()?;
	if !path.exists() {
		return Ok(ScheduledTaskState {
			version: 1,
			items: Vec::new(),
		});
	}
	let content = std::fs::read_to_string(&path)
		.map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
	let mut state: ScheduledTaskState = serde_json::from_str(&content)
		.map_err(|error| format!("Unable to parse {}: {error}", path.display()))?;
	state.version = 1;
	Ok(state)
}

pub fn write_scheduled_task_state(state: &ScheduledTaskState) -> Result<(), String> {
	let path = scheduled_tasks_path()?;
	let directory = path
		.parent()
		.ok_or("Unable to locate scheduled-tasks directory")?;
	std::fs::create_dir_all(directory)
		.map_err(|error| format!("Unable to create {}: {error}", directory.display()))?;
	let value = serde_json::to_value(state).map_err(|error| error.to_string())?;
	write_private_json(&path, &value)
}

pub fn normalize_schedule_title(value: &str) -> Result<String, String> {
	let title = value.split_whitespace().collect::<Vec<_>>().join(" ");
	if title.is_empty() {
		return Err("Scheduled task title is required".to_string());
	}
	if title.chars().count() > SCHEDULE_TITLE_MAX {
		return Err(format!(
			"Scheduled task title must not exceed {SCHEDULE_TITLE_MAX} characters"
		));
	}
	Ok(title)
}

pub fn normalize_schedule_prompt(value: &str) -> Result<String, String> {
	let prompt = value.trim().to_string();
	if prompt.is_empty() {
		return Err("Scheduled task prompt is required".to_string());
	}
	if prompt.chars().count() > SCHEDULE_PROMPT_MAX {
		return Err(format!(
			"Scheduled task prompt must not exceed {SCHEDULE_PROMPT_MAX} characters"
		));
	}
	Ok(prompt)
}

pub fn normalize_optional_value(value: Option<String>) -> Option<String> {
	value.and_then(|item| {
		let trimmed = item.trim();
		(!trimmed.is_empty()).then(|| trimmed.to_string())
	})
}

pub fn validate_permission_mode(value: &str) -> Result<(), String> {
	if matches!(value, "ask" | "edits" | "allow") {
		Ok(())
	} else {
		Err(format!("Invalid permission mode: {value}"))
	}
}

pub fn validate_session_mode(value: &str) -> Result<(), String> {
	if value == SESSION_MODE_FRESH || value == SESSION_MODE_REUSE {
		Ok(())
	} else {
		Err(format!("Invalid session mode: {value}"))
	}
}

/// New tasks default to one continuing conversation; legacy tasks without the
/// field stay on fresh sessions until the user flips the switch.
pub fn normalize_session_mode(value: Option<String>) -> Result<String, String> {
	let mode = normalize_optional_value(value).unwrap_or_else(|| SESSION_MODE_REUSE.to_string());
	validate_session_mode(&mode)?;
	Ok(mode)
}

pub fn validate_run_status(value: &str) -> Result<(), String> {
	if matches!(
		value,
		"running" | "completed" | "error" | "missed" | "skipped"
	) {
		Ok(())
	} else {
		Err(format!("Invalid run status: {value}"))
	}
}

fn parse_time_of_day(value: &str) -> Result<NaiveTime, String> {
	NaiveTime::parse_from_str(value, "%H:%M")
		.map_err(|_| format!("timeOfDay must be HH:mm, got: {value}"))
}

fn parse_rfc3339(value: &str) -> Result<DateTime<Local>, String> {
	DateTime::parse_from_rfc3339(value)
		.map(|dt| dt.with_timezone(&Local))
		.map_err(|_| format!("Expected RFC 3339 timestamp, got: {value}"))
}

pub fn validate_schedule_rule(rule: &ScheduleRule) -> Result<(), String> {
	match rule.kind.as_str() {
		"once" => {
			let run_at = rule
				.run_at
				.as_deref()
				.ok_or("once schedule requires runAt")?;
			parse_rfc3339(run_at)?;
		}
		"recurring" => {
			let recurrence = rule
				.recurrence
				.as_deref()
				.ok_or("recurring schedule requires recurrence")?;
			match recurrence {
				"daily" => {
					let time = rule
						.time_of_day
						.as_deref()
						.ok_or("daily schedule requires timeOfDay")?;
					parse_time_of_day(time)?;
				}
				"weekly" => {
					let time = rule
						.time_of_day
						.as_deref()
						.ok_or("weekly schedule requires timeOfDay")?;
					parse_time_of_day(time)?;
					let days = rule
						.weekdays
						.as_ref()
						.ok_or("weekly schedule requires weekdays")?;
					if days.is_empty() {
						return Err("weekly schedule requires at least one weekday".to_string());
					}
					for day in days {
						if *day > 6 {
							return Err(format!("Invalid weekday: {day} (expected 0=Mon..6=Sun)"));
						}
					}
				}
				"monthly" => {
					let time = rule
						.time_of_day
						.as_deref()
						.ok_or("monthly schedule requires timeOfDay")?;
					parse_time_of_day(time)?;
					let days = rule
						.month_days
						.as_ref()
						.ok_or("monthly schedule requires monthDays")?;
					if days.is_empty() {
						return Err("monthly schedule requires at least one month day".to_string());
					}
					for day in days {
						if !(1..=28).contains(day) {
							return Err(format!("Invalid month day: {day} (expected 1..=28)"));
						}
					}
				}
				"cron" => {
					let expr = rule.cron.as_deref().ok_or("cron schedule requires cron")?;
					Schedule::from_str(expr)
						.map_err(|error| format!("Invalid cron expression: {error}"))?;
				}
				other => return Err(format!("Invalid recurrence: {other}")),
			}
		}
		other => return Err(format!("Invalid schedule kind: {other}")),
	}
	Ok(())
}

/// Next fire strictly after `after`, based on the *scheduled slot* (not fire time).
pub fn compute_next_run(rule: &ScheduleRule, after: DateTime<Local>) -> Option<DateTime<Local>> {
	match rule.kind.as_str() {
		"once" => {
			let run_at = parse_rfc3339(rule.run_at.as_deref()?).ok()?;
			(run_at > after).then_some(run_at)
		}
		"recurring" => match rule.recurrence.as_deref()? {
			"daily" => {
				let time = parse_time_of_day(rule.time_of_day.as_deref()?).ok()?;
				next_time_of_day(after, time, |_| true)
			}
			"weekly" => {
				let time = parse_time_of_day(rule.time_of_day.as_deref()?).ok()?;
				let days = rule.weekdays.clone().unwrap_or_default();
				next_time_of_day(after, time, |date| {
					days.contains(&(date.weekday().num_days_from_monday() as u8))
				})
			}
			"monthly" => {
				let time = parse_time_of_day(rule.time_of_day.as_deref()?).ok()?;
				let days = rule.month_days.clone().unwrap_or_default();
				next_time_of_day(after, time, |date| {
					days.contains(&(date.day() as u8))
				})
			}
			"cron" => {
				let expr = rule.cron.as_deref()?;
				let schedule = Schedule::from_str(expr).ok()?;
				schedule
					.after(&after)
					.next()
					.map(|dt| dt.with_timezone(&Local))
			}
			_ => None,
		},
		_ => None,
	}
}

fn next_time_of_day(
	after: DateTime<Local>,
	time: NaiveTime,
	day_ok: impl Fn(chrono::NaiveDate) -> bool,
) -> Option<DateTime<Local>> {
	for offset in 0..400 {
		let date = (after + Duration::days(offset)).date_naive();
		if !day_ok(date) {
			continue;
		}
		if let Some(candidate) = date.and_time(time).and_local_timezone(Local).single() {
			if candidate > after {
				return Some(candidate);
			}
		}
	}
	None
}

/// How to treat a slot whose `nextRunAt` is already in the past.
#[derive(Debug, Clone, PartialEq)]
pub enum MissDecision {
	/// Fire once with `catchUp = true`, then advance from the scheduled slot.
	FireCatchUp { scheduled_slot: DateTime<Local> },
	/// One-shot too stale: record `missed`, disable the task.
	MarkMissed,
	/// Recurring too stale: record one `skipped` run, jump to the next future slot.
	SkipToFuture { next: Option<DateTime<Local>> },
}

pub fn decide_miss(
	rule: &ScheduleRule,
	scheduled_slot: DateTime<Local>,
	now: DateTime<Local>,
) -> MissDecision {
	let overdue = now - scheduled_slot;
	let within_window = overdue <= Duration::minutes(CATCH_UP_WINDOW_MINUTES);
	if within_window {
		return MissDecision::FireCatchUp { scheduled_slot };
	}
	if rule.kind == "once" {
		return MissDecision::MarkMissed;
	}
	MissDecision::SkipToFuture {
		next: compute_next_run(rule, scheduled_slot),
	}
}

pub fn push_run(task: &mut ScheduledTask, run: ScheduledRun) {
	task.runs.insert(0, run);
	if task.runs.len() > SCHEDULE_RUNS_CAP {
		task.runs.truncate(SCHEDULE_RUNS_CAP);
	}
}

pub fn build_automation_prompt(task: &ScheduledTask, planned_at: Option<&str>) -> String {
	let planned = planned_at.unwrap_or("立即执行");
	vec![
		"请按 Nova 定时任务自动执行。".to_string(),
		format!("任务标题：{}", task.title),
		format!("任务 id：{}", task.id),
		format!("计划时间：{planned}"),
		format!("权限模式：{}", task.permission_mode),
		format!("任务说明：\n{}", task.prompt),
		"执行要求：\n1. 按任务说明独立完成工作，不要等待用户补充。\n2. 完成后总结实际完成的内容、验证结果和仍需处理的问题；缺少证据时不要声称完成。\n3. 这是自动化运行，不需要更新普通待办。".to_string(),
	]
	.join("\n\n")
}

fn apply_next_run(task: &mut ScheduledTask, after: DateTime<Local>) {
	if !task.enabled || task.completed_at.is_some() {
		task.next_run_at = None;
		return;
	}
	if task.schedule.kind == "once" {
		// Keep the slot even when it is already past so startup catch-up can
		// fire it (≤1h) or mark it missed. compute_next_run would return None
		// for past once slots and the task would silently never run.
		task.next_run_at = task.schedule.run_at.clone();
		return;
	}
	task.next_run_at = compute_next_run(&task.schedule, after).map(|dt| dt.to_rfc3339());
}

fn validate_and_normalize_rule(rule: ScheduleRule) -> Result<ScheduleRule, String> {
	let mut rule = rule;
	rule.kind = rule.kind.trim().to_string();
	if let Some(rec) = rule.recurrence.as_mut() {
		*rec = rec.trim().to_string();
	}
	if let Some(time) = rule.time_of_day.as_mut() {
		*time = time.trim().to_string();
	}
	if let Some(cron) = rule.cron.as_mut() {
		*cron = cron.trim().to_string();
	}
	if let Some(run_at) = rule.run_at.as_mut() {
		// Normalize once instants to RFC3339 via chrono so later parsing is stable.
		let parsed = parse_rfc3339(run_at)?;
		*run_at = parsed.to_rfc3339();
	}
	if let Some(days) = rule.weekdays.as_mut() {
		days.sort_unstable();
		days.dedup();
	}
	if let Some(days) = rule.month_days.as_mut() {
		days.sort_unstable();
		days.dedup();
	}
	validate_schedule_rule(&rule)?;
	Ok(rule)
}

pub fn create_scheduled_task_state(
	input: CreateScheduledTaskInput,
	now: DateTime<Local>,
) -> Result<(ScheduledTaskState, ScheduledTask), String> {
	let title = normalize_schedule_title(&input.title)?;
	let prompt = normalize_schedule_prompt(&input.prompt)?;
	let project_path = input
		.project_path
		.trim()
		.to_string();
	if project_path.is_empty() {
		return Err("projectPath is required for scheduled tasks".to_string());
	}
	let schedule = validate_and_normalize_rule(input.schedule)?;
	let permission_mode = input
		.permission_mode
		.unwrap_or_else(|| "ask".to_string());
	validate_permission_mode(&permission_mode)?;
	let session_mode = normalize_session_mode(input.session_mode)?;
	let mut state = read_scheduled_task_state()?;
	let mut task = ScheduledTask {
		id: format!("sch_{}", uuid::Uuid::new_v4()),
		title,
		prompt,
		description: normalize_optional_value(input.description),
		project_path,
		enabled: input.enabled.unwrap_or(true),
		schedule,
		permission_mode,
		model: normalize_optional_value(input.model),
		provider: normalize_optional_value(input.provider),
		session_mode,
		session_file: None,
		worktree_enabled: input.worktree_enabled.unwrap_or(false),
		last_run_at: None,
		last_run_status: None,
		last_agent_id: None,
		last_session_id: None,
		next_run_at: None,
		missed_count: 0,
		runs: Vec::new(),
		created_at: now.to_rfc3339(),
		updated_at: now.to_rfc3339(),
		completed_at: None,
	};
	apply_next_run(&mut task, now);
	state.items.push(task.clone());
	write_scheduled_task_state(&state)?;
	Ok((state, task))
}

pub fn update_scheduled_task_state(
	input: UpdateScheduledTaskInput,
	now: DateTime<Local>,
) -> Result<(ScheduledTaskState, ScheduledTask), String> {
	let mut state = read_scheduled_task_state()?;
	let mut schedule_changed = false;
	let mut enabled_changed = false;
	let task = state
		.items
		.iter_mut()
		.find(|task| task.id == input.id)
		.ok_or_else(|| format!("Scheduled task not found: {}", input.id))?;
	if let Some(title) = input.title.as_deref() {
		task.title = normalize_schedule_title(title)?;
	}
	if let Some(prompt) = input.prompt.as_deref() {
		task.prompt = normalize_schedule_prompt(prompt)?;
	}
	if input.description.is_some() {
		task.description = normalize_optional_value(input.description);
	}
	if let Some(project_path) = input.project_path.as_deref() {
		let project_path = project_path.trim().to_string();
		if project_path.is_empty() {
			return Err("projectPath is required for scheduled tasks".to_string());
		}
		if task.project_path != project_path {
			// Sessions belong to one project; never continue the old one here.
			task.session_file = None;
			task.last_session_id = None;
		}
		task.project_path = project_path;
	}
	if let Some(schedule) = input.schedule {
		task.schedule = validate_and_normalize_rule(schedule)?;
		schedule_changed = true;
		// A rewritten rule can revive a completed one-shot.
		if task.completed_at.is_some() && task.schedule.kind != "once" {
			task.completed_at = None;
		}
	}
	if let Some(permission_mode) = input.permission_mode.as_deref() {
		validate_permission_mode(permission_mode)?;
		task.permission_mode = permission_mode.to_string();
	}
	if input.model.is_some() {
		task.model = normalize_optional_value(input.model);
	}
	if input.provider.is_some() {
		task.provider = normalize_optional_value(input.provider);
	}
	if let Some(session_mode) = normalize_optional_value(input.session_mode) {
		validate_session_mode(&session_mode)?;
		task.session_mode = session_mode;
	}
	if let Some(worktree) = input.worktree_enabled {
		task.worktree_enabled = worktree;
	}
	if let Some(enabled) = input.enabled {
		if task.enabled != enabled {
			task.enabled = enabled;
			enabled_changed = true;
		}
	}
	task.updated_at = now.to_rfc3339();
	if schedule_changed || enabled_changed {
		let after = if task.enabled {
			now
		} else {
			// Keep the prior nextRunAt when disabling so re-enable can resume.
			now
		};
		apply_next_run(task, after);
		if !task.enabled {
			task.next_run_at = None;
		}
	}
	let snapshot = task.clone();
	write_scheduled_task_state(&state)?;
	Ok((state, snapshot))
}

pub fn delete_scheduled_task_state(id: &str) -> Result<ScheduledTaskState, String> {
	let mut state = read_scheduled_task_state()?;
	let before = state.items.len();
	state.items.retain(|task| task.id != id);
	if before == state.items.len() {
		return Err(format!("Scheduled task not found: {id}"));
	}
	write_scheduled_task_state(&state)?;
	Ok(state)
}

pub fn set_scheduled_task_enabled_state(
	id: &str,
	enabled: bool,
	now: DateTime<Local>,
) -> Result<(ScheduledTaskState, ScheduledTask), String> {
	update_scheduled_task_state(
		UpdateScheduledTaskInput {
			id: id.to_string(),
			title: None,
			prompt: None,
			description: None,
			project_path: None,
			schedule: None,
			permission_mode: None,
			model: None,
			provider: None,
			session_mode: None,
			worktree_enabled: None,
			enabled: Some(enabled),
		},
		now,
	)
}

/// Start a run record and stamp last-run fields. Caller owns spawn/fire.
pub fn begin_run(
	task_id: &str,
	now: DateTime<Local>,
	catch_up: bool,
	error: Option<String>,
	agent_id: Option<String>,
	session_id: Option<String>,
	status: &str,
) -> Result<(ScheduledTaskState, ScheduledRun), String> {
	let mut state = read_scheduled_task_state()?;
	let task = state
		.items
		.iter_mut()
		.find(|task| task.id == task_id)
		.ok_or_else(|| format!("Scheduled task not found: {task_id}"))?;
	let run = ScheduledRun {
		id: format!("run_{}", uuid::Uuid::new_v4()),
		task_id: task_id.to_string(),
		started_at: now.to_rfc3339(),
		finished_at: (status != "running").then(|| now.to_rfc3339()),
		status: status.to_string(),
		agent_id,
		session_id,
		error,
		summary: None,
		catch_up: Some(catch_up),
	};
	push_run(task, run.clone());
	task.last_run_at = Some(now.to_rfc3339());
	task.last_run_status = Some(status.to_string());
	if let Some(agent_id) = run.agent_id.clone() {
		task.last_agent_id = Some(agent_id);
		task.last_session_id = run.session_id.clone().or(run.agent_id.clone());
	}
	if status != "running" {
		task.missed_count = task.missed_count.saturating_add(0);
	}
	task.updated_at = now.to_rfc3339();
	write_scheduled_task_state(&state)?;
	Ok((state, run))
}

/// Advance nextRunAt after a scheduled fire. Manual runs should pass `advance: false`.
pub fn finish_scheduled_fire(
	task_id: &str,
	scheduled_slot: DateTime<Local>,
	now: DateTime<Local>,
	advance: bool,
) -> Result<ScheduledTaskState, String> {
	let mut state = read_scheduled_task_state()?;
	let task = state
		.items
		.iter_mut()
		.find(|task| task.id == task_id)
		.ok_or_else(|| format!("Scheduled task not found: {task_id}"))?;
	if task.schedule.kind == "once" {
		task.completed_at = Some(now.to_rfc3339());
		task.next_run_at = None;
		task.enabled = false;
	} else if advance {
		apply_next_run(task, scheduled_slot);
	} else {
		// Manual run: keep the existing next slot.
		if task.next_run_at.is_none() {
			apply_next_run(task, now);
		}
	}
	task.updated_at = now.to_rfc3339();
	write_scheduled_task_state(&state)?;
	Ok(state)
}

pub fn record_scheduled_run_result_state(
	input: RecordScheduledRunResultInput,
	now: DateTime<Local>,
) -> Result<ScheduledTaskState, String> {
	validate_run_status(&input.status)?;
	let mut state = read_scheduled_task_state()?;
	let task = state
		.items
		.iter_mut()
		.find(|task| task.id == input.task_id)
		.ok_or_else(|| format!("Scheduled task not found: {}", input.task_id))?;
	let run = task
		.runs
		.iter_mut()
		.find(|run| run.id == input.run_id)
		.ok_or_else(|| format!("Scheduled run not found: {}", input.run_id))?;
	run.status = input.status.clone();
	run.finished_at = Some(now.to_rfc3339());
	if input.error.is_some() {
		run.error = input.error;
	}
	if input.summary.is_some() {
		run.summary = input.summary;
	}
	task.last_run_status = Some(input.status.clone());
	task.updated_at = now.to_rfc3339();
	if input.status == "missed" {
		task.missed_count = task.missed_count.saturating_add(1);
	}
	write_scheduled_task_state(&state)?;
	Ok(state)
}

pub fn record_missed_or_skipped(
	task_id: &str,
	status: &str,
	message: &str,
	now: DateTime<Local>,
	next: Option<DateTime<Local>>,
) -> Result<ScheduledTaskState, String> {
	let mut state = read_scheduled_task_state()?;
	let task = state
		.items
		.iter_mut()
		.find(|task| task.id == task_id)
		.ok_or_else(|| format!("Scheduled task not found: {task_id}"))?;
	let run = ScheduledRun {
		id: format!("run_{}", uuid::Uuid::new_v4()),
		task_id: task_id.to_string(),
		started_at: now.to_rfc3339(),
		finished_at: Some(now.to_rfc3339()),
		status: status.to_string(),
		agent_id: None,
		session_id: None,
		error: Some(message.to_string()),
		summary: None,
		catch_up: Some(false),
	};
	push_run(task, run);
	task.last_run_at = Some(now.to_rfc3339());
	task.last_run_status = Some(status.to_string());
	task.updated_at = now.to_rfc3339();
	if status == "missed" {
		task.missed_count = task.missed_count.saturating_add(1);
		task.enabled = false;
		task.completed_at = Some(now.to_rfc3339());
		task.next_run_at = None;
	} else {
		task.next_run_at = next.map(|dt| dt.to_rfc3339());
	}
	write_scheduled_task_state(&state)?;
	Ok(state)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_scheduled_tasks() -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	read_scheduled_task_state()
}

#[tauri::command]
pub async fn create_scheduled_task(
	input: CreateScheduledTaskInput,
) -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	let (state, _) = create_scheduled_task_state(input, Local::now())?;
	Ok(state)
}

#[tauri::command]
pub async fn update_scheduled_task(
	input: UpdateScheduledTaskInput,
) -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	let (state, _) = update_scheduled_task_state(input, Local::now())?;
	Ok(state)
}

#[tauri::command]
pub async fn delete_scheduled_task(id: String) -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	delete_scheduled_task_state(&id)
}

#[tauri::command]
pub async fn set_scheduled_task_enabled(
	id: String,
	enabled: bool,
) -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	let (state, _) = set_scheduled_task_enabled_state(&id, enabled, Local::now())?;
	Ok(state)
}

#[tauri::command]
pub async fn record_scheduled_run_result(
	input: RecordScheduledRunResultInput,
) -> Result<ScheduledTaskState, String> {
	let _guard = SCHEDULE_WRITE_LOCK
		.lock()
		.map_err(|_| "Schedule storage lock is poisoned")?;
	record_scheduled_run_result_state(input, Local::now())
}

#[cfg(test)]
mod scheduled_task_tests {
	use super::*;
	use chrono::TimeZone;

	fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
		Local.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
	}

	#[test]
	fn normalizes_title_and_prompt() {
		assert_eq!(
			normalize_schedule_title("  每日   行业调研  ").unwrap(),
			"每日 行业调研"
		);
		assert!(normalize_schedule_title("   ").is_err());
		assert!(normalize_schedule_prompt("").is_err());
		assert!(validate_permission_mode("ask").is_ok());
		assert!(validate_permission_mode("yolo").is_err());
	}

	#[test]
	fn validates_schedule_rules() {
		assert!(validate_schedule_rule(&ScheduleRule {
			kind: "once".into(),
			run_at: Some("2026-09-23T10:00:00+08:00".into()),
			recurrence: None,
			time_of_day: None,
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		})
		.is_ok());
		assert!(validate_schedule_rule(&ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("daily".into()),
			time_of_day: Some("09:30".into()),
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		})
		.is_ok());
		assert!(validate_schedule_rule(&ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("cron".into()),
			time_of_day: None,
			weekdays: None,
			month_days: None,
			cron: Some("not a cron".into()),
			timezone: None,
		})
		.is_err());
		assert!(validate_schedule_rule(&ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("monthly".into()),
			time_of_day: Some("10:00".into()),
			weekdays: None,
			month_days: Some(vec![31]),
			cron: None,
			timezone: None,
		})
		.is_err());
	}

	#[test]
	fn computes_next_daily_run() {
		let rule = ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("daily".into()),
			time_of_day: Some("09:30".into()),
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		};
		// Before today's slot → today 09:30
		let next = compute_next_run(&rule, local(2026, 9, 23, 8, 0)).unwrap();
		assert_eq!(next, local(2026, 9, 23, 9, 30));
		// After today's slot → tomorrow 09:30
		let next = compute_next_run(&rule, local(2026, 9, 23, 10, 0)).unwrap();
		assert_eq!(next, local(2026, 9, 24, 9, 30));
	}

	#[test]
	fn computes_next_weekly_run() {
		// 2026-09-23 is a Wednesday (weekday 2).
		let rule = ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("weekly".into()),
			time_of_day: Some("08:00".into()),
			weekdays: Some(vec![0, 2]),
			month_days: None,
			cron: None,
			timezone: None,
		};
		let next = compute_next_run(&rule, local(2026, 9, 23, 9, 0)).unwrap();
		// After Wed 08:00 → next Mon 08:00
		assert_eq!(next, local(2026, 9, 28, 8, 0));
	}

	#[test]
	fn computes_next_monthly_run() {
		let rule = ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("monthly".into()),
			time_of_day: Some("10:00".into()),
			weekdays: None,
			month_days: Some(vec![1, 15]),
			cron: None,
			timezone: None,
		};
		let next = compute_next_run(&rule, local(2026, 9, 16, 0, 0)).unwrap();
		assert_eq!(next, local(2026, 10, 1, 10, 0));
		let next = compute_next_run(&rule, local(2026, 9, 1, 11, 0)).unwrap();
		assert_eq!(next, local(2026, 9, 15, 10, 0));
	}

	#[test]
	fn computes_next_once_run() {
		let rule = ScheduleRule {
			kind: "once".into(),
			run_at: Some(local(2026, 9, 23, 12, 0).to_rfc3339()),
			recurrence: None,
			time_of_day: None,
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		};
		assert!(compute_next_run(&rule, local(2026, 9, 23, 11, 0)).is_some());
		assert!(compute_next_run(&rule, local(2026, 9, 23, 13, 0)).is_none());
	}

	#[test]
	fn decides_miss_policy() {
		let once = ScheduleRule {
			kind: "once".into(),
			run_at: Some(local(2026, 9, 23, 10, 0).to_rfc3339()),
			recurrence: None,
			time_of_day: None,
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		};
		let daily = ScheduleRule {
			kind: "recurring".into(),
			run_at: None,
			recurrence: Some("daily".into()),
			time_of_day: Some("10:00".into()),
			weekdays: None,
			month_days: None,
			cron: None,
			timezone: None,
		};
		let slot = local(2026, 9, 23, 10, 0);
		// Within 1h → catch-up
		assert_eq!(
			decide_miss(&once, slot, local(2026, 9, 23, 10, 30)),
			MissDecision::FireCatchUp { scheduled_slot: slot }
		);
		// Once too stale → missed
		assert_eq!(
			decide_miss(&once, slot, local(2026, 9, 23, 12, 30)),
			MissDecision::MarkMissed
		);
		// Recurring too stale → skip to next future slot
		match decide_miss(&daily, slot, local(2026, 9, 23, 12, 30)) {
			MissDecision::SkipToFuture { next } => {
				assert_eq!(next, Some(local(2026, 9, 24, 10, 0)));
			}
			other => panic!("expected SkipToFuture, got {other:?}"),
		}
	}

	#[test]
	fn serializes_camel_case_fields() {
		let task = ScheduledTask {
			id: "sch_1".into(),
			title: "t".into(),
			prompt: "p".into(),
			description: None,
			project_path: "/tmp".into(),
			enabled: true,
			schedule: ScheduleRule {
				kind: "once".into(),
				run_at: Some("2026-09-23T10:00:00+08:00".into()),
				recurrence: None,
				time_of_day: None,
				weekdays: None,
				month_days: None,
				cron: None,
				timezone: None,
			},
			permission_mode: "ask".into(),
			model: None,
			provider: None,
			session_mode: SESSION_MODE_REUSE.into(),
			session_file: None,
			worktree_enabled: false,
			last_run_at: None,
			last_run_status: None,
			last_agent_id: None,
			last_session_id: None,
			next_run_at: Some("2026-09-23T10:00:00+08:00".into()),
			missed_count: 0,
			runs: vec![],
			created_at: "2026-09-23T00:00:00Z".into(),
			updated_at: "2026-09-23T00:00:00Z".into(),
			completed_at: None,
		};
		let value = serde_json::to_value(&task).unwrap();
		assert_eq!(value["projectPath"], "/tmp");
		assert_eq!(value["permissionMode"], "ask");
		assert_eq!(value["sessionMode"], "reuse");
		assert_eq!(value["nextRunAt"], "2026-09-23T10:00:00+08:00");
		assert_eq!(value["worktreeEnabled"], false);
		assert!(value.get("lastRunAt").is_none());
		assert!(value.get("sessionFile").is_none());
		let restored: ScheduledTask = serde_json::from_value(value).unwrap();
		assert_eq!(restored.project_path, "/tmp");
		assert_eq!(restored.permission_mode, "ask");
	}

	#[test]
	fn session_mode_defaults_keep_legacy_tasks_fresh() {
		let value = serde_json::json!({
			"id": "sch_legacy",
			"title": "t",
			"prompt": "p",
			"projectPath": "/tmp",
			"enabled": true,
			"schedule": { "kind": "recurring", "recurrence": "daily", "timeOfDay": "09:00" },
			"permissionMode": "ask",
			"worktreeEnabled": false,
			"missedCount": 0,
			"runs": [],
			"createdAt": "2026-09-23T00:00:00Z",
			"updatedAt": "2026-09-23T00:00:00Z"
		});
		let task: ScheduledTask = serde_json::from_value(value).unwrap();
		assert_eq!(task.session_mode, SESSION_MODE_FRESH);
		assert!(task.session_file.is_none());
		// New tasks created without an explicit mode continue one conversation.
		assert_eq!(normalize_session_mode(None).unwrap(), SESSION_MODE_REUSE);
		assert!(validate_session_mode("nope").is_err());
	}
}
