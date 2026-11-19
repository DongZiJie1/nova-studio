import { useEffect, useId, useRef, type CSSProperties } from "react";
import { FolderOpen, Plus, X } from "lucide-react";
import type { CreateTodoInput, TodoItem } from "../../lib/tauri-bridge";
import { TodoDeadline, TaskStatusIcon } from "./TodoTreeCanvas";
import {
	compareTodoDeadline,
	deadlineTone,
	isClosedTodo,
	sortTopicsByUrgency,
	STATE_LABEL,
	taskState,
	topicOf,
} from "./task-graph";
import { latestProgress, progressPercent } from "./ProgressTimeline";
import "./todo-folders.css";

const FRONT_SHAPE =
	"M .06 .015 H .33 C .405 .015 .405 .17 .49 .17 H .94 Q 1 .17 1 .25 V .93 Q 1 1 .93 1 H .07 Q 0 1 0 .93 V .09 Q 0 .015 .06 .015 Z";
const BACK_SHAPE =
	"M .06 .15 H .43 C .50 .15 .52 .015 .59 .015 H .94 Q 1 .015 1 .09 V .93 Q 1 1 .93 1 H .07 Q 0 1 0 .93 V .225 Q 0 .15 .06 .15 Z";

function FilePreview({ todo, slot }: { todo: TodoItem; slot: number }) {
	const state = taskState(todo);
	const percent = progressPercent(todo);
	return (
		<span
			className={`todo-folder-preview todo-folder-preview-${state}`}
			style={{ "--slot": slot, zIndex: 4 - slot } as CSSProperties}
		>
			<span className="todo-file-heading">
				<strong>{todo.title}</strong>
				<span className="todo-file-status">
					<TaskStatusIcon state={state} />
					{STATE_LABEL[state]}
				</span>
			</span>
			<span className="todo-file-body">
				{state === "in_progress" ? (
					<>
						<span className="todo-file-orbit" />
						<span className="todo-file-progress">
							{typeof percent === "number" ? (
								<>
									<b>{percent}</b>
									<small>%</small>
								</>
							) : (
								<TaskStatusIcon state={state} />
							)}
						</span>
						<span className="todo-file-caption">
							{typeof percent === "number" ? "当前进度" : "正在推进"}
						</span>
					</>
				) : state === "completed" ? (
					<>
						<span className="todo-file-seal">
							<TaskStatusIcon state={state} />
						</span>
						<span className="todo-file-lines">
							<i />
							<i />
							<i />
						</span>
					</>
				) : state === "abandoned" ? (
					<>
						<span className="todo-file-archive">
							<TaskStatusIcon state={state} />
						</span>
						<span className="todo-file-lines">
							<i />
							<i />
						</span>
					</>
				) : (
					<>
						<span className="todo-file-lines">
							<i />
							<i />
							<i />
							<i />
						</span>
						<span className="todo-file-fold" />
					</>
				)}
			</span>
		</span>
	);
}

interface Props {
	items: TodoItem[];
	topic: string | null;
	suspended: boolean;
	busy: boolean;
	onTopic: (topic: string | null) => void;
	onOpen: (id: string) => void;
	onCreate: (seed: Partial<CreateTodoInput>) => void;
	onToggle: (todo: TodoItem) => void;
}

export function TodoFolderView({
	items,
	topic,
	suspended,
	busy,
	onTopic,
	onOpen,
	onCreate,
	onToggle,
}: Props) {
	const shapeId = useId().replace(/:/g, "");
	const map = new Map<
		string,
		{ key: string; label: string; items: TodoItem[] }
	>();
	for (const item of items) {
		const label = topicOf(item);
		const key = label.toLocaleLowerCase();
		const group = map.get(key) ?? { key, label, items: [] };
		group.items.push(item);
		map.set(key, group);
	}
	const groups = sortTopicsByUrgency([...map.values()]);
	const active = topic ? map.get(topic) : undefined;
	return (
		<>
			<svg
				width="0"
				height="0"
				className="todo-folder-shapes"
				aria-hidden="true"
			>
				<defs>
					<clipPath id={`${shapeId}-front`} clipPathUnits="objectBoundingBox">
						<path d={FRONT_SHAPE} />
					</clipPath>
					<clipPath id={`${shapeId}-back`} clipPathUnits="objectBoundingBox">
						<path d={BACK_SHAPE} />
					</clipPath>
				</defs>
			</svg>
			<div className="todo-folder-scroll">
				{groups.length === 0 ? (
					<div className="todo-empty">
						<FolderOpen size={32} />
						<h3>没有符合条件的主题</h3>
						<button
							className="todo-primary-button"
							disabled={busy}
							onClick={() => onCreate({})}
						>
							<Plus size={16} />
							新建主题与任务
						</button>
					</div>
				) : (
					<div className="todo-folder-grid">
						{groups.map((group) => {
							const hue = [...group.key].reduce(
								(value, char) => (value * 31 + char.charCodeAt(0)) % 360,
								215,
							);
							const completed = group.items.filter(
								(item) => item.status === "completed",
							).length;
							const open = group.items.filter((item) => !isClosedTodo(item));
							const overdue = open.filter(
								(item) => deadlineTone(item.dueAt, false) === "overdue",
							).length;
							return (
								<div
									className="todo-folder"
									key={group.key}
									style={
										{
											"--folder-hue": hue,
											"--folder-front-shape": `url(#${shapeId}-front)`,
											"--folder-back-shape": `url(#${shapeId}-back)`,
										} as CSSProperties
									}
								>
									<button
										className="todo-folder-open"
										onClick={() => onTopic(group.key)}
										aria-label={`打开主题：${group.label}，${group.items.length} 项任务`}
									>
										<span className="todo-folder-back" />
										<span className="todo-folder-previews" aria-hidden="true">
											{[...group.items]
												.sort(compareTodoDeadline)
												.slice(0, 4)
												.map((todo, slot) => (
													<FilePreview key={todo.id} todo={todo} slot={slot} />
												))}
										</span>
										<span className="todo-folder-front">
											<span className="todo-folder-glass" aria-hidden="true" />
											<svg
												className="todo-folder-rim"
												viewBox="0 0 1 1"
												preserveAspectRatio="none"
												aria-hidden="true"
											>
												<path
													d={FRONT_SHAPE}
													vectorEffect="non-scaling-stroke"
												/>
											</svg>
											<span className="todo-folder-copy">
												<strong>{group.label}</strong>
												<small>
													{group.items.length} 项任务 · {completed} 已完成
												</small>
												<span
													className={`todo-folder-notice${overdue ? " todo-folder-notice-overdue" : ""}`}
												>
													{overdue
														? `${overdue} 项已逾期`
														: open.length
															? `${open.length} 项待处理`
															: "全部已结束"}
												</span>
												<span className="todo-folder-meter" aria-hidden="true">
													<i
														style={{
															width: `${group.items.length ? (completed / group.items.length) * 100 : 0}%`,
														}}
													/>
												</span>
											</span>
											<span className="todo-folder-enter">
												<FolderOpen size={22} />
											</span>
										</span>
									</button>
									<button
										className="todo-folder-add"
										disabled={busy}
										onClick={() => onCreate({ topic: group.label })}
										aria-label={`在${group.label}添加任务`}
									>
										<Plus size={20} />
									</button>
								</div>
							);
						})}
					</div>
				)}
			</div>
			{active && (
				<TopicDialog
					key={active.key}
					label={active.label}
					items={active.items}
					suspended={suspended}
					busy={busy}
					onClose={() => onTopic(null)}
					onOpen={onOpen}
					onCreate={onCreate}
					onToggle={onToggle}
				/>
			)}
		</>
	);
}

function TopicDialog({
	label,
	items,
	suspended,
	busy,
	onClose,
	onOpen,
	onCreate,
	onToggle,
}: Omit<Props, "topic" | "onTopic"> & { label: string; onClose: () => void }) {
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		if (suspended) return;
		const previous = document.activeElement as HTMLElement | null;
		const panel = ref.current;
		panel?.querySelector<HTMLButtonElement>("button")?.focus();
		const keyboard = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
			if (event.key !== "Tab") return;
			const controls = [
				...(panel?.querySelectorAll<HTMLElement>(
					'button:not(:disabled), [tabindex="0"]',
				) ?? []),
			];
			const first = controls[0],
				last = controls[controls.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		panel?.addEventListener("keydown", keyboard);
		return () => {
			panel?.removeEventListener("keydown", keyboard);
			if (previous?.isConnected) previous.focus();
		};
	}, [suspended]);
	return (
		<div
			className="todo-folder-backdrop"
			hidden={suspended}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section
				ref={ref}
				className="todo-folder-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={`${label}的待办`}
			>
				<header>
					<div>
						<span className="todo-folder-eyebrow">
							主题文件夹 · {items.length} 项任务
						</span>
						<h2>
							<FolderOpen size={26} />
							{label}
						</h2>
					</div>
					<div className="todo-folder-dialog-actions">
						<button
							className="todo-primary-button"
							disabled={busy}
							onClick={() => onCreate({ topic: label })}
						>
							<Plus size={16} />
							添加任务
						</button>
						<button
							className="todo-folder-close"
							onClick={onClose}
							aria-label="关闭主题文件夹"
						>
							<X size={20} />
						</button>
					</div>
				</header>
				<div className="todo-folder-cards">
					{[...items].sort(compareTodoDeadline).map((todo) => {
						const state = taskState(todo),
							percent = progressPercent(todo),
							latest = latestProgress(todo);
						return (
							<article
								className={`todo-folder-task todo-folder-task-${state}`}
								key={todo.id}
							>
								<div className="todo-folder-task-heading">
									<button
										className={`task-status task-status-${state}`}
										disabled={busy}
										onClick={() => onToggle(todo)}
										aria-label={`${isClosedTodo(todo) ? "重新打开" : "完成"}：${todo.title}`}
									>
										<TaskStatusIcon state={state} />
									</button>
									<button
										className="todo-folder-task-title"
										onClick={() => onOpen(todo.id)}
									>
										{todo.title}
									</button>
								</div>
								<span className={`todo-folder-task-state task-status-${state}`}>
									{STATE_LABEL[state]}
								</span>
								{todo.description && (
									<p className="todo-folder-task-description">
										{todo.description}
									</p>
								)}
								{typeof percent === "number" && (
									<div className="todo-folder-task-progress">
										<span>
											完成进度<strong>{percent}%</strong>
										</span>
										<i>
											<b style={{ width: `${percent}%` }} />
										</i>
									</div>
								)}
								{latest && (
									<p className="todo-folder-task-latest">
										{latest.source === "agent" ? "Nova" : "我"} ·{" "}
										{latest.content}
									</p>
								)}
								<footer>
									<TodoDeadline
										dueAt={todo.dueAt}
										closed={isClosedTodo(todo)}
									/>
									<button onClick={() => onOpen(todo.id)}>查看详情 →</button>
								</footer>
							</article>
						);
					})}
				</div>
			</section>
		</div>
	);
}
