//! Tokio scheduler that fires scheduled tasks by spawning Nova agents.
//!
//! Lives in Studio (not the CLI) so automations run whenever the app is open.
//! App quit = paused; on startup we apply a catch-up miss policy.

use crate::agent_manager::AgentManager;
use crate::rpc_types::{AgentStatus, SpawnRequest};
use crate::scheduled_tasks::{
	self, begin_run, build_automation_prompt, decide_miss, finish_scheduled_fire,
	record_missed_or_skipped, MissDecision, ScheduledTask, ScheduledTaskState,
	MAX_CONCURRENT_FIRES, SCHEDULE_WRITE_LOCK,
};
use chrono::{DateTime, Local};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

pub struct Scheduler {
	app: AppHandle,
	manager: Arc<AgentManager>,
	in_flight: AtomicUsize,
	running_tasks: tokio::sync::Mutex<HashSet<String>>,
	wake: Notify,
}

#[derive(Clone)]
pub struct SchedulerHandle(pub Arc<Scheduler>);

/// Session file a reuse-mode task should continue, when it still exists.
/// Fresh tasks and tasks whose file disappeared must start a new session.
fn resolve_reuse_session_file(task: &ScheduledTask) -> Option<String> {
	if task.session_mode != scheduled_tasks::SESSION_MODE_REUSE {
		return None;
	}
	task.session_file
		.clone()
		.filter(|file| Path::new(file).exists())
}

#[derive(Default)]
struct RunOutcome {
	error: Option<String>,
	/// Last non-empty assistant text, persisted as the run summary.
	summary: Option<String>,
}

/// Prefer the text the automation prompt asks the model to wrap in
/// `<run_summary>`; fall back to the whole message when it is missing.
fn extract_run_summary(text: &str) -> Option<String> {
	if let Some(start) = text.find("<run_summary>") {
		let rest = &text[start + "<run_summary>".len()..];
		if let Some(end) = rest.find("</run_summary>") {
			let inner = rest[..end].trim();
			if !inner.is_empty() {
				return Some(inner.to_string());
			}
		}
	}
	let trimmed = text.trim();
	(!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Text blocks of an assistant message; tool-only turns return `None`.
fn assistant_message_text(message: &serde_json::Value) -> Option<String> {
	let mut parts = Vec::new();
	for block in message["content"].as_array()? {
		if block["type"].as_str() != Some("text") {
			continue;
		}
		if let Some(text) = block["text"].as_str() {
			let text = text.trim();
			if !text.is_empty() {
				parts.push(text.to_string());
			}
		}
	}
	extract_run_summary(&parts.join("\n\n"))
}

impl RunOutcome {
	fn observe(&mut self, event: &serde_json::Value) -> bool {
		match event["type"].as_str() {
			Some("message_end") if event["message"]["role"] == "assistant" => {
				let message = &event["message"];
				self.error = match message["stopReason"].as_str() {
					Some("error") => Some(message["errorMessage"].as_str().unwrap_or("模型请求失败").to_string()),
					Some("aborted") => Some("任务已停止".to_string()),
					_ => None,
				};
				if self.error.is_none() {
					if let Some(text) = assistant_message_text(message) {
						self.summary = Some(text);
					}
				}
			}
			Some("response") if event["command"] == "prompt" && event["success"] == false => {
				self.error = Some(event["error"].as_str().unwrap_or("任务启动失败").to_string());
				return true;
			}
			Some("response") if event["command"] == "abort" && event["success"] == true => {
				self.error = Some("任务已停止".to_string());
				return true;
			}
			Some("agent_settled") => return true,
			_ => {}
		}
		false
	}
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskFiredPayload {
	task_id: String,
	run_id: String,
	title: String,
	agent_id: String,
	session_id: String,
	catch_up: bool,
	next_run_at: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunUpdatedPayload {
	task_id: String,
	run_id: String,
	status: String,
	agent_id: Option<String>,
	error: Option<String>,
}

impl SchedulerHandle {
	pub fn spawn(app: AppHandle, manager: Arc<AgentManager>) -> Self {
		let scheduler = Arc::new(Scheduler {
			app,
			manager,
			in_flight: AtomicUsize::new(0),
			running_tasks: tokio::sync::Mutex::new(HashSet::new()),
			wake: Notify::new(),
		});
		let handle = SchedulerHandle(scheduler);
		let loop_ref = handle.clone();
		tauri::async_runtime::spawn(async move {
			loop_ref.run_loop().await;
		});
		handle
	}

	pub fn notify_tick(&self) {
		self.0.wake.notify_one();
	}

	/// Manual "立即执行" from the UI. Does not consume the next recurring slot.
	pub async fn run_now(&self, task_id: &str) -> Result<ScheduledTaskState, String> {
		self.0.clone().run_now_inner(task_id).await
	}

	async fn run_loop(&self) {
		self.0.clone().tick(true).await;
		loop {
			let wait = self.0.next_wake_delay().await;
			tokio::select! {
				_ = tokio::time::sleep(wait) => {}
				_ = self.0.wake.notified() => {}
			}
			self.0.clone().tick(false).await;
		}
	}
}

impl Scheduler {
	async fn next_wake_delay(&self) -> std::time::Duration {
		let max = std::time::Duration::from_secs(30);
		let state = match scheduled_tasks::read_scheduled_task_state() {
			Ok(state) => state,
			Err(error) => {
				log::warn!("[scheduler] unable to read schedule store: {error}");
				return max;
			}
		};
		let now = Local::now();
		let soonest = state
			.items
			.iter()
			.filter(|task| task.enabled && task.completed_at.is_none())
			.filter_map(|task| task.next_run_at.as_deref())
			.filter_map(|value| DateTime::parse_from_rfc3339(value).ok())
			.map(|dt| dt.with_timezone(&Local))
			.filter(|dt| *dt > now)
			.min();
		match soonest {
			Some(dt) => {
				let delta = (dt - now)
					.to_std()
					.unwrap_or(std::time::Duration::from_secs(1));
				delta.min(max).max(std::time::Duration::from_millis(200))
			}
			None => max,
		}
	}

	async fn tick(self: Arc<Self>, is_startup: bool) {
		let now = Local::now();
		let due = self.collect_due(now);
		if due.is_empty() {
			return;
		}
		log::info!(
			"[scheduler] tick{} due={}",
			if is_startup { " (startup)" } else { "" },
			due.len()
		);
		for (task, scheduled_slot, catch_up) in due {
			if self.in_flight.load(Ordering::SeqCst) >= MAX_CONCURRENT_FIRES {
				log::info!("[scheduler] concurrency cap reached, deferring {}", task.id);
				self.defer_task(&task.id, Local::now()).await;
				continue;
			}
			{
				let mut running = self.running_tasks.lock().await;
				if running.contains(&task.id) {
					self.defer_task(&task.id, Local::now()).await;
					continue;
				}
				running.insert(task.id.clone());
			}
			self.in_flight.fetch_add(1, Ordering::SeqCst);
			let this = self.clone();
			let task_id = task.id.clone();
			tauri::async_runtime::spawn(async move {
				this.clone().fire_task(task, scheduled_slot, catch_up, true).await;
				this.in_flight.fetch_sub(1, Ordering::SeqCst);
				this.running_tasks.lock().await.remove(&task_id);
			});
		}
	}

	/// Collect due tasks and apply miss policy for stale slots.
	fn collect_due(&self, now: DateTime<Local>) -> Vec<(ScheduledTask, DateTime<Local>, bool)> {
		let _guard = match SCHEDULE_WRITE_LOCK.lock() {
			Ok(guard) => guard,
			Err(_) => return Vec::new(),
		};
		let state = match scheduled_tasks::read_scheduled_task_state() {
			Ok(state) => state,
			Err(error) => {
				log::warn!("[scheduler] read failed: {error}");
				return Vec::new();
			}
		};
		let mut out = Vec::new();
		for task in state.items {
			if !task.enabled || task.completed_at.is_some() {
				continue;
			}
			if task.last_run_status.as_deref() == Some("running") {
				continue;
			}
			let Some(next_raw) = task.next_run_at.clone() else {
				continue;
			};
			let Ok(parsed) = DateTime::parse_from_rfc3339(&next_raw) else {
				continue;
			};
			let slot = parsed.with_timezone(&Local);
			if slot > now {
				continue;
			}
			match decide_miss(&task.schedule, slot, now) {
				MissDecision::FireCatchUp { scheduled_slot } => {
					out.push((task, scheduled_slot, true));
				}
				MissDecision::MarkMissed => {
					let id = task.id.clone();
					let _ = record_missed_or_skipped(&id, "missed", "错过执行窗口", now, None);
					self.emit_run_updated(&id, "", "missed", None, Some("错过执行窗口".into()));
				}
				MissDecision::SkipToFuture { next } => {
					let id = task.id.clone();
					let _ = record_missed_or_skipped(&id, "skipped", "错过执行窗口", now, next);
					self.emit_run_updated(&id, "", "skipped", None, Some("错过执行窗口".into()));
				}
			}
		}
		out.sort_by_key(|(task, slot, _)| (task.id.clone(), *slot));
		out.truncate(MAX_CONCURRENT_FIRES * 2);
		out
	}

	/// Push a busy task a few minutes out so the tick does not spin.
	async fn defer_task(&self, task_id: &str, now: DateTime<Local>) {
		let _guard = match SCHEDULE_WRITE_LOCK.lock() {
			Ok(guard) => guard,
			Err(_) => return,
		};
		if let Ok(mut state) = scheduled_tasks::read_scheduled_task_state() {
			if let Some(task) = state.items.iter_mut().find(|t| t.id == task_id) {
				let deferred = now + chrono::Duration::minutes(5);
				task.next_run_at = Some(deferred.to_rfc3339());
				task.updated_at = now.to_rfc3339();
				let _ = scheduled_tasks::write_scheduled_task_state(&state);
			}
		}
	}

	async fn fire_task(
		self: Arc<Self>,
		task: ScheduledTask,
		scheduled_slot: DateTime<Local>,
		catch_up: bool,
		advance: bool,
	) {
		let now = Local::now();
		let planned_label = if advance {
			Some(scheduled_slot.to_rfc3339())
		} else {
			Some("手动立即执行".to_string())
		};
		let prompt = build_automation_prompt(&task, planned_label.as_deref());

		// Session continuity: reuse mode keeps appending to the task's stored
		// session file so earlier research stays in context on every fire.
		let reuse_session = task.session_mode == scheduled_tasks::SESSION_MODE_REUSE;
		let reuse_file = resolve_reuse_session_file(&task);
		if reuse_session {
			if let Some(file) = task.session_file.as_deref() {
				if reuse_file.is_none() {
					log::warn!(
						"[scheduler] session file for {} is missing, starting a new session: {file}",
						task.id
					);
				}
			}
			if task.worktree_enabled {
				log::warn!(
					"[scheduler] {} reuses one session and ignores worktree isolation",
					task.id
				);
			}
			// One .jsonl must have exactly one writer: retire the previous
			// run's agent before continuing in the same file.
			if let Some(previous_agent) = task.last_agent_id.as_deref() {
				if let Some(process) = self.manager.get_process(previous_agent).await {
					if process.get_status().await == AgentStatus::Streaming && advance {
						log::info!(
							"[scheduler] {} session is busy in {}, retrying in 5 minutes",
							task.id,
							previous_agent
						);
						self.defer_task(&task.id, Local::now()).await;
						return;
					}
					if let Err(error) = self.manager.stop(previous_agent).await {
						log::warn!("[scheduler] unable to stop {previous_agent}: {error}");
					}
				}
			}
		}

		let begin = {
			let _guard = match SCHEDULE_WRITE_LOCK.lock() {
				Ok(guard) => guard,
				Err(_) => return,
			};
			begin_run(&task.id, now, catch_up, None, None, None, "running")
		};
		let (_state, run) = match begin {
			Ok(ok) => ok,
			Err(error) => {
				log::error!("[scheduler] begin_run failed for {}: {error}", task.id);
				return;
			}
		};

		let request = SpawnRequest {
			cwd: task.project_path.clone(),
			worktree_enabled: task.worktree_enabled && !reuse_session,
			parent_agent_id: None,
			model: task.model.clone(),
			provider: task.provider.clone(),
			args: reuse_file
				.clone()
				.map(|file| vec!["--session".to_string(), file]),
			depth: 0,
		};

		let spawned = match (reuse_file.as_deref(), task.last_session_id.as_deref()) {
			(Some(_), Some(session_id)) => {
				self.manager
					.spawn_continuing_session(request, session_id)
					.await
			}
			_ => self.manager.spawn(request).await,
		};
		match spawned {
			Ok(info) => {
				let agent_id = info.id.clone();
				let session_id = info.session_id.clone();
				let session_file = info.session_file.clone();
				// Subscribe before sending: fast provider failures must not race UI setup.
				let Some(process) = self.manager.get_process(&agent_id).await else {
					self.mark_run_error(&task.id, &run.id, Some(&agent_id), "Agent process not found");
					self.advance_schedule(&task.id, scheduled_slot, advance);
					return;
				};
				let mut events = process.subscribe();
				if let Err(error) = self
					.manager
					.set_tool_permission_mode(&agent_id, task.permission_mode.clone())
					.await
				{
					log::warn!("[scheduler] set_tool_permission_mode failed: {error}");
				}
				let _ = self
					.manager
					.set_session_name(&agent_id, task.title.clone())
					.await;
				match self
					.manager
					.send_prompt(&agent_id, prompt, None, None, None)
					.await
				{
					Ok(()) => {
						self.stamp_run_started(
							&task.id,
							&run.id,
							&agent_id,
							session_id.as_deref(),
							session_file.as_deref(),
							reuse_session,
							catch_up,
						);
						self.emit_fired(&task, &run.id, &agent_id, session_id.as_deref(), catch_up);
						self.advance_schedule(&task.id, scheduled_slot, advance);
						self.emit_changed();
						let mut outcome = RunOutcome::default();
						loop {
							match events.recv().await {
								Ok(event) => {
									if !outcome.observe(&event) { continue; }
									break;
								}
								Err(error) => {
									outcome.error = Some(format!("Agent event stream interrupted: {error}"));
									break;
								}
							}
						}
						if let Some(error) = outcome.error {
							self.mark_run_error(&task.id, &run.id, Some(&agent_id), &error);
						} else {
							let summary = outcome.summary.clone();
							let result = self.with_lock(|| scheduled_tasks::record_scheduled_run_result_state(
								scheduled_tasks::RecordScheduledRunResultInput {
									task_id: task.id.clone(), run_id: run.id.clone(),
									status: "completed".into(), error: None, summary,
								}, Local::now()));
							if let Err(error) = result {
								log::error!("[scheduler] persist result failed: {error}");
							} else {
								self.emit_run_updated(&task.id, &run.id, "completed", Some(agent_id.clone()), None);
							}
						}
						// Fire-and-forget runs must not keep an idle runtime alive
						// until the next fire; the session file keeps the context.
						if let Err(error) = self.manager.stop(&agent_id).await {
							log::warn!("[scheduler] unable to stop {agent_id} after run: {error}");
						}
					}
					Err(error) => {
						self.mark_run_error(&task.id, &run.id, Some(&agent_id), &error);
						self.advance_schedule(&task.id, scheduled_slot, advance);
						if let Err(stop_error) = self.manager.stop(&agent_id).await {
							log::warn!("[scheduler] unable to stop {agent_id} after failure: {stop_error}");
						}
					}
				}
			}
			Err(error) => {
				self.mark_run_error(&task.id, &run.id, None, &error);
				self.advance_schedule(&task.id, scheduled_slot, advance);
			}
		}
	}

	async fn run_now_inner(self: Arc<Self>, task_id: &str) -> Result<ScheduledTaskState, String> {
		let task = {
			let _guard = SCHEDULE_WRITE_LOCK
				.lock()
				.map_err(|_| "Schedule storage lock is poisoned")?;
			let state = scheduled_tasks::read_scheduled_task_state()?;
			let task = state
				.items
				.iter()
				.find(|t| t.id == task_id)
				.cloned()
				.ok_or_else(|| format!("Scheduled task not found: {task_id}"))?;
			if task.last_run_status.as_deref() == Some("running") {
				return Err("Scheduled task is already running".to_string());
			}
			task
		};

		{
			let mut running = self.running_tasks.lock().await;
			if !running.insert(task_id.to_string()) {
				return Err("Scheduled task is already running".to_string());
			}
		}
		self.in_flight.fetch_add(1, Ordering::SeqCst);
		let this = self.clone();
		let id = task_id.to_string();
		tauri::async_runtime::spawn(async move {
			// Manual fire: advance=false keeps recurring slots.
			this.clone().fire_task(task, Local::now(), false, false).await;
			this.in_flight.fetch_sub(1, Ordering::SeqCst);
			this.running_tasks.lock().await.remove(&id);
		});

		let _guard = SCHEDULE_WRITE_LOCK
			.lock()
			.map_err(|_| "Schedule storage lock is poisoned")?;
		scheduled_tasks::read_scheduled_task_state()
	}

	fn with_lock<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
		let _guard = SCHEDULE_WRITE_LOCK
			.lock()
			.map_err(|_| "Schedule storage lock is poisoned")?;
		f()
	}

	fn advance_schedule(&self, task_id: &str, scheduled_slot: DateTime<Local>, advance: bool) {
		let _ = self.with_lock(|| {
			finish_scheduled_fire(task_id, scheduled_slot, Local::now(), advance)
		});
	}

	fn stamp_run_started(
		&self,
		task_id: &str,
		run_id: &str,
		agent_id: &str,
		session_id: Option<&str>,
		session_file: Option<&str>,
		reuse_session: bool,
		catch_up: bool,
	) {
		let _ = self.with_lock(|| {
			let mut state = scheduled_tasks::read_scheduled_task_state()?;
			if let Some(item) = state.items.iter_mut().find(|t| t.id == task_id) {
				if let Some(run) = item.runs.iter_mut().find(|r| r.id == run_id) {
					run.agent_id = Some(agent_id.to_string());
					run.session_id = session_id.map(str::to_string);
					run.catch_up = Some(catch_up);
				}
				item.last_agent_id = Some(agent_id.to_string());
				if let Some(session_id) = session_id {
					item.last_session_id = Some(session_id.to_string());
				}
				// Only a reuse run owns the task's continuing session file;
				// fresh runs must not steal the pointer from it.
				if reuse_session {
					if let Some(session_file) = session_file {
						item.session_file = Some(session_file.to_string());
					}
				}
				item.updated_at = Local::now().to_rfc3339();
			}
			scheduled_tasks::write_scheduled_task_state(&state)
		});
	}

	fn mark_run_error(&self, task_id: &str, run_id: &str, agent_id: Option<&str>, error: &str) {
		let _ = self.with_lock(|| {
			scheduled_tasks::record_scheduled_run_result_state(
				scheduled_tasks::RecordScheduledRunResultInput {
					task_id: task_id.to_string(),
					run_id: run_id.to_string(),
					status: "error".to_string(),
					error: Some(error.to_string()),
					summary: None,
				},
				Local::now(),
			)
		});
		self.emit_run_updated(
			task_id,
			run_id,
			"error",
			agent_id.map(|s| s.to_string()),
			Some(error.to_string()),
		);
	}

	fn emit_fired(
		&self,
		task: &ScheduledTask,
		run_id: &str,
		agent_id: &str,
		session_id: Option<&str>,
		catch_up: bool,
	) {
		let payload = TaskFiredPayload {
			task_id: task.id.clone(),
			run_id: run_id.to_string(),
			title: task.title.clone(),
			agent_id: agent_id.to_string(),
			session_id: session_id.unwrap_or(agent_id).to_string(),
			catch_up,
			next_run_at: task.next_run_at.clone(),
		};
		let _ = self.app.emit("scheduled-task-fired", &payload);
	}

	fn emit_run_updated(
		&self,
		task_id: &str,
		run_id: &str,
		status: &str,
		agent_id: Option<String>,
		error: Option<String>,
	) {
		let payload = RunUpdatedPayload {
			task_id: task_id.to_string(),
			run_id: run_id.to_string(),
			status: status.to_string(),
			agent_id,
			error,
		};
		let _ = self.app.emit("scheduled-task-run-updated", &payload);
	}

	fn emit_changed(&self) {
		let _ = self
			.app
			.emit("scheduled-tasks-changed", serde_json::json!({ "revisionHint": true }));
	}
}

/// Tauri command entry: fire immediately.
#[tauri::command]
pub async fn run_scheduled_task_now(
	handle: tauri::State<'_, SchedulerHandle>,
	id: String,
) -> Result<ScheduledTaskState, String> {
	handle.run_now(&id).await
}

#[cfg(test)]
mod tests {
	use super::{resolve_reuse_session_file, RunOutcome};
	use crate::scheduled_tasks::{ScheduleRule, ScheduledTask, SESSION_MODE_FRESH, SESSION_MODE_REUSE};
	use serde_json::json;

	fn task_for_session(mode: &str, file: Option<String>) -> ScheduledTask {
		ScheduledTask {
			id: "sch_test".into(),
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
			session_mode: mode.into(),
			session_file: file,
			worktree_enabled: false,
			last_run_at: None,
			last_run_status: None,
			last_agent_id: None,
			last_session_id: None,
			next_run_at: None,
			missed_count: 0,
			runs: vec![],
			created_at: "2026-09-23T00:00:00Z".into(),
			updated_at: "2026-09-23T00:00:00Z".into(),
			completed_at: None,
		}
	}

	#[test]
	fn reuse_mode_only_continues_an_existing_session_file() {
		let dir = std::env::temp_dir().join(format!("nova-scheduler-{}", uuid::Uuid::new_v4()));
		std::fs::create_dir_all(&dir).unwrap();
		let file = dir.join("session.jsonl");
		std::fs::write(&file, "{}\n").unwrap();
		let file_path = file.to_string_lossy().into_owned();

		assert_eq!(
			resolve_reuse_session_file(&task_for_session(SESSION_MODE_REUSE, Some(file_path.clone())))
				.as_deref(),
			Some(file_path.as_str())
		);
		assert!(resolve_reuse_session_file(&task_for_session(
			SESSION_MODE_REUSE,
			Some(dir.join("gone.jsonl").to_string_lossy().into_owned())
		))
		.is_none());
		assert!(resolve_reuse_session_file(&task_for_session(SESSION_MODE_FRESH, Some(file_path))).is_none());
		assert!(resolve_reuse_session_file(&task_for_session(SESSION_MODE_REUSE, None)).is_none());

		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn run_outcome_keeps_the_last_assistant_text() {
		let mut outcome = RunOutcome::default();
		outcome.observe(&json!({"type":"message_end","message":{
			"role":"assistant","stopReason":"toolUse",
			"content":[{"type":"text","text":"先看看有哪些新岗位"}]}}));
		outcome.observe(&json!({"type":"message_end","message":{
			"role":"assistant","stopReason":"stop",
			"content":[{"type":"text","text":"完整调研报告……\n\n<run_summary>本次新增 3 个岗位</run_summary>"}]}}));
		// A tool-only turn must not wipe the previous summary.
		outcome.observe(&json!({"type":"message_end","message":{
			"role":"assistant","stopReason":"toolUse",
			"content":[{"type":"toolCall","name":"read"}]}}));
		assert!(outcome.observe(&json!({"type":"agent_settled"})));
		assert!(outcome.error.is_none());
		assert_eq!(outcome.summary.as_deref(), Some("本次新增 3 个岗位"));
	}

	#[test]
	fn connection_error_is_not_success_when_agent_settles() {
		let mut outcome = RunOutcome::default();
		assert!(!outcome.observe(&json!({"type":"message_end", "message": {
			"role":"assistant", "content":[], "stopReason":"error", "errorMessage":"Connection error."
		}})));
		assert!(outcome.observe(&json!({"type":"agent_settled"})));
		assert_eq!(outcome.error.as_deref(), Some("Connection error."));
	}

	#[test]
	fn successful_retry_clears_previous_provider_error() {
		let mut outcome = RunOutcome::default();
		outcome.observe(&json!({"type":"message_end", "message":{"role":"assistant", "stopReason":"error"}}));
		outcome.observe(&json!({"type":"message_end", "message":{"role":"assistant", "stopReason":"stop"}}));
		assert!(outcome.observe(&json!({"type":"agent_settled"})));
		assert!(outcome.error.is_none());
	}

	#[test]
	fn cancellation_and_prompt_rejection_are_failures() {
		let mut outcome = RunOutcome::default();
		assert!(outcome.observe(&json!({"type":"response", "command":"abort", "success":true})));
		assert!(outcome.error.is_some());
		let mut outcome = RunOutcome::default();
		assert!(outcome.observe(&json!({"type":"response", "command":"prompt", "success":false, "error":"No API key"})));
		assert_eq!(outcome.error.as_deref(), Some("No API key"));
	}
}
