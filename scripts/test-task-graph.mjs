import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutTopic, taskState, topicOf } from "../src/components/todos/task-graph.ts";

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
