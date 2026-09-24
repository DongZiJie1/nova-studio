//! Tokio scheduler that fires scheduled tasks by spawning Nova agents.
//!
//! Lives in Studio (not the CLI) so automations run whenever the app is open.
//! App quit = paused; on startup we apply a catch-up miss policy.

use crate::agent_manager::AgentManager;
use crate::rpc_types::SpawnRequest;
use crate::scheduled_tasks::{
	self, begin_run, build_automation_prompt, decide_miss, finish_scheduled_fire,
	record_missed_or_skipped, MissDecision, ScheduledTask, ScheduledTaskState,
	MAX_CONCURRENT_FIRES, SCHEDULE_WRITE_LOCK,
};
use chrono::{DateTime, Local};
use std::collections::HashSet;
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

#[derive(Default)]
struct RunOutcome {
	error: Option<String>,
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
			worktree_enabled: task.worktree_enabled,
			parent_agent_id: None,
			model: task.model.clone(),
			provider: task.provider.clone(),
			args: None,
			depth: 0,
		};

		match self.manager.spawn(request).await {
			Ok(info) => {
				let agent_id = info.id.clone();
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
						self.stamp_run_started(&task.id, &run.id, &agent_id, catch_up);
						self.emit_fired(&task, &run.id, &agent_id, catch_up);
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
							let result = self.with_lock(|| scheduled_tasks::record_scheduled_run_result_state(
								scheduled_tasks::RecordScheduledRunResultInput {
									task_id: task.id.clone(), run_id: run.id.clone(),
									status: "completed".into(), error: None, summary: None,
								}, Local::now()));
							if let Err(error) = result {
								log::error!("[scheduler] persist result failed: {error}");
							} else {
								self.emit_run_updated(&task.id, &run.id, "completed", Some(agent_id.clone()), None);
							}
						}
					}
					Err(error) => {
						self.mark_run_error(&task.id, &run.id, Some(&agent_id), &error);
						self.advance_schedule(&task.id, scheduled_slot, advance);
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

	fn stamp_run_started(&self, task_id: &str, run_id: &str, agent_id: &str, catch_up: bool) {
		let _ = self.with_lock(|| {
			let mut state = scheduled_tasks::read_scheduled_task_state()?;
			if let Some(item) = state.items.iter_mut().find(|t| t.id == task_id) {
				if let Some(run) = item.runs.iter_mut().find(|r| r.id == run_id) {
					run.agent_id = Some(agent_id.to_string());
					run.session_id = Some(agent_id.to_string());
					run.catch_up = Some(catch_up);
				}
				item.last_agent_id = Some(agent_id.to_string());
				item.last_session_id = Some(agent_id.to_string());
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

	fn emit_fired(&self, task: &ScheduledTask, run_id: &str, agent_id: &str, catch_up: bool) {
		let payload = TaskFiredPayload {
			task_id: task.id.clone(),
			run_id: run_id.to_string(),
			title: task.title.clone(),
			agent_id: agent_id.to_string(),
			session_id: agent_id.to_string(),
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
	use super::RunOutcome;
	use serde_json::json;

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
