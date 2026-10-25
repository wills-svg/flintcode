import test from "node:test";
import assert from "node:assert/strict";
import { isWorkerMessage } from "../../src/agent-worker/protocol.js";

test("worker message guard accepts protocol frames", () => {
	assert.equal(isWorkerMessage({ type: "ready", pid: 1234 }), true);
	assert.equal(isWorkerMessage({ type: "activity", line: "started" }), true);
	assert.equal(isWorkerMessage({ type: "text", text: "report" }), true);
	assert.equal(
		isWorkerMessage({
			type: "permission_request",
			id: "perm-1",
			toolName: "read",
			input: { path: "src/app.ts" },
		}),
		true,
	);
	assert.equal(isWorkerMessage({ type: "result", status: "done", output: "done", durationMs: 1 }), true);
	assert.equal(isWorkerMessage({ type: "fatal", error: "boom" }), true);
});

test("worker message guard rejects unrelated IPC traffic", () => {
	for (const value of [null, undefined, 12, "ready", {}, { type: "unknown" }]) {
		assert.equal(isWorkerMessage(value), false);
	}
});
