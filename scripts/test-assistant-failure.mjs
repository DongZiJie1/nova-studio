import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantFailure } from "../src/lib/assistant-failure.ts";

test("empty persisted connection errors and cancellation remain visible", () => {
  assert.equal(assistantFailure({ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." }), "Error: Connection error.");
  assert.equal(assistantFailure({ role: "assistant", content: [], stopReason: "aborted" }), "已停止生成");
  assert.equal(assistantFailure({ role: "assistant", stopReason: "error" }), "Error: 模型请求失败");
});

test("successful responses and non-assistant messages are not failures", () => {
  assert.equal(assistantFailure({ role: "assistant", stopReason: "stop" }), null);
  assert.equal(assistantFailure({ role: "user", stopReason: "error" }), null);
});
