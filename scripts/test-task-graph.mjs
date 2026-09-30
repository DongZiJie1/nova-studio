import assert from "node:assert/strict";
import { test } from "node:test";
import { sortTopicsByUrgency, deadlineTone, layoutTopic, taskState, topicOf } from "../src/components/todos/task-graph.ts";

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    tags: ["实验"],
    description: "",
    status: "pending",
    priority: "medium",
    source: "user",
    createdAt: "2026-09-20",
    updatedAt: "2026-09-20",
    order: 0,
    ...overrides,
  };
}

test("a topic falls back to the first tag and then to 未分类", () => {
  assert.equal(topicOf(task("a", { topic: "论文" })), "论文");
  assert.equal(topicOf(task("b")), "实验");
  assert.equal(topicOf(task("c", { tags: [] })), "未分类");
});

test("state is the stored status", () => {
  assert.equal(taskState(task("a")), "ready");
  assert.equal(taskState(task("b", { status: "in_progress" })), "in_progress");
  assert.equal(taskState(task("c", { status: "completed" })), "completed");
});

test("cards wrap two per row in list order", () => {
  const items = [
    task("five", { order: 5 }),
    task("six", { order: 6 }),
    task("seven", { order: 7 }),
    task("eight", { order: 8 }),
    task("nine", { order: 9 }),
  ];
  const graph = layoutTopic(items);
  assert.deepEqual(
    graph.nodes.map((node) => node.todo.id),
    ["five", "six", "seven", "eight", "nine"],
  );
  assert.equal(graph.nodes[0].y, graph.nodes[1].y);
  assert.ok(graph.nodes[2].y > graph.nodes[0].y);
  assert.ok(graph.nodes[4].y > graph.nodes[2].y);
  assert.ok(graph.nodes[0].x < graph.nodes[1].x);
});

test("layout keeps every card inside the canvas and width never grows with task count", () => {
  const many = Array.from({ length: 21 }, (_, index) => task(String(index), { order: index }));
  const graph = layoutTopic(many);
  assert.equal(graph.nodes.length, 21);
  assert.equal(graph.width, 524);
  for (const node of graph.nodes) {
    assert.ok(node.x >= 0 && node.x + 236 <= graph.width);
    assert.ok(node.y >= 0 && node.y + node.height <= graph.height);
  }
});

test("a lone card is centred in the canvas", () => {
  const graph = layoutTopic([task("solo")]);
  assert.equal(graph.width, 268);
  assert.equal(graph.nodes[0].x, 16);
});

test("deadlines sort earliest first, preserve ties, and put undated tasks last without mutating input", () => {
  const items = [
    task("undated-last", { order: 8 }),
    task("later", { dueAt: "2027-01-01", order: 0 }),
    task("same-day-second", { dueAt: "2026-10-01T00:00:00Z", order: 4 }),
    task("undated-first", { dueAt: "", order: 2 }),
    task("earliest", { dueAt: "2026-09-01", order: 9 }),
    task("same-day-first", { dueAt: "2026-10-01", order: 3 }),
  ];
  const original = [...items];
  assert.deepEqual(layoutTopic(items).nodes.map(({ todo }) => todo.id), [
    "earliest", "same-day-first", "same-day-second", "later", "undated-first", "undated-last",
  ]);
  assert.deepEqual(items, original);
});


test("completed tasks follow all open tasks and sort by deadline within their group", () => {
  const items = [
    task("done-undated", { status: "completed" }),
    task("done-later", { status: "completed", dueAt: "2026-09-05" }),
    task("open-undated"),
    task("done-earlier", { status: "completed", dueAt: "2026-09-01" }),
    task("open-dated", { status: "in_progress", dueAt: "2026-10-01" }),
  ];
  assert.deepEqual(layoutTopic(items).nodes.map(({ todo }) => todo.id), [
    "open-dated", "open-undated", "done-earlier", "done-later", "done-undated",
  ]);
});

test("deadline colors use inclusive calendar-day boundaries and leave completed tasks neutral", () => {
  const now = new Date(2026, 8, 21, 23, 59);
  for (const [date, tone] of [
    ["2026-09-20", "warning"], ["2026-09-21", "warning"],
    ["2026-09-25", "warning"], ["2026-09-26", "warning"],
    ["2026-10-01", "warning"], ["2026-10-02", "reminder"],
    ["2026-10-21", "reminder"], ["2026-10-22", "gentle"],
    [undefined, "neutral"], ["invalid", "neutral"],
  ]) {
    assert.equal(deadlineTone(date, false, now), tone, date);
    assert.equal(deadlineTone(date, true, now), "neutral", date);
  }
});


test("topics sort by warning, then reminder, then gentle counts descending with stable ties", () => {
  const now = new Date(2026, 8, 22);
  const topic = (id, warning, reminder, gentle) => ({ id, items: [
    ...Array.from({ length: warning }, (_, i) => task(`${id}-w${i}`, { dueAt: "2026-09-30" })),
    ...Array.from({ length: reminder }, (_, i) => task(`${id}-r${i}`, { dueAt: "2026-10-15" })),
    ...Array.from({ length: gentle }, (_, i) => task(`${id}-g${i}`, { dueAt: "2027-01-01" })),
  ] });
  const topics = [
    topic("gentle", 0, 0, 5), topic("tie-first", 1, 1, 1),
    topic("reminder", 0, 2, 0), topic("more-gentle", 1, 1, 2),
    topic("more-reminder", 1, 2, 0), topic("more-warning", 2, 0, 0),
    topic("tie-last", 1, 1, 1),
    { id: "neutral", items: [task("undated"), task("done", { status: "completed", dueAt: "2026-09-01" })] },
  ];
  const original = [...topics];
  assert.deepEqual(sortTopicsByUrgency(topics, now).map(({ id }) => id), [
    "more-warning", "more-reminder", "more-gentle", "tie-first", "tie-last", "reminder", "gentle", "neutral",
  ]);
  assert.deepEqual(topics, original);
});
