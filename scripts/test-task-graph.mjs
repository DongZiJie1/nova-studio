import assert from "node:assert/strict";
import { test } from "node:test";
import { blockersOf, layoutTopic, taskState, topicOf } from "../src/components/todos/task-graph.ts";

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

test("legacy tasks keep their first label as topic and never gain invented arrows", () => {
  const items = Array.from({ length: 21 }, (_, i) => task(String(i), { order: i }));
  const graph = layoutTopic(items, new Set());
  assert.equal(topicOf(items[0]), "实验");
  assert.equal(graph.nodes.length, 21);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.width, 524);
  for (const node of graph.nodes) {
    assert.ok(node.x >= 0 && node.x + 236 <= graph.width);
    assert.ok(node.y >= 0 && node.y + node.height <= graph.height);
  }
});

test("parallel nodes share a layer and their join follows both", () => {
  const items = [
    task("a"),
    task("b", { dependsOn: ["a"] }),
    task("c", { dependsOn: ["a"] }),
    task("d", { dependsOn: ["b", "c"] }),
  ];
  const { nodes, edges } = layoutTopic(items, new Set());
  const node = (id) => nodes.find((item) => item.todo.id === id);
  assert.equal(edges.length, 4);
  assert.equal(node("b").y, node("c").y);
  assert.ok(node("d").y > node("b").y + node("b").height);
  assert.notEqual(node("b").x, node("c").x);
});

test("expanded descendants remain inside a root and move following nodes down", () => {
  const items = [task("a"), task("b", { parentId: "a" }), task("c", { dependsOn: ["a"] })];
  const closed = layoutTopic(items, new Set());
  const open = layoutTopic(items, new Set(["a"]));
  assert.equal(open.nodes.length, 2);
  assert.equal(open.nodes[0].children[0].id, "b");
  assert.equal(open.nodes[1].y - closed.nodes[1].y, 32);
});

test("blockers include ancestor prerequisites and unlock after completion", () => {
  const items = [task("prep"), task("parent", { dependsOn: ["prep"] }), task("child", { parentId: "parent" })];
  assert.deepEqual(
    blockersOf(items[2], items).map((item) => item.id),
    ["prep"],
  );
  assert.equal(taskState(items[2], items), "blocked");
  items[0].status = "completed";
  assert.equal(taskState(items[2], items), "ready");
  assert.deepEqual(
    blockersOf(items[1], items, true).map((item) => item.id),
    ["child"],
  );
});

test("missing prerequisites fail closed, and damaged cycles do not crash rendering", () => {
  const items = [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })];
  assert.equal(layoutTopic(items, new Set()).nodes.length, 2);
  assert.equal(taskState(task("c", { dependsOn: ["missing"] }), items), "blocked");
});

test("dependencies on subtasks do not invent dependencies on their entire parents", () => {
  const items = [task("a"), task("b"), task("a1", { parentId: "a" }), task("b1", { parentId: "b" })];
  items[0].dependsOn = ["b1"];
  items[1].dependsOn = ["a1"];
  const graph = layoutTopic(items, new Set());
  assert.deepEqual(graph.edges, []);
  assert.equal(taskState(items[0], items), "blocked");
  assert.equal(taskState(items[1], items), "blocked");
});
