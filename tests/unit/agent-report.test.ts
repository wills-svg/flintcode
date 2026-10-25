import test from "node:test";
import assert from "node:assert/strict";
import { extractReport, findReport, reportShape } from "../../src/util/agent-report.js";

test("extractReport skips a trailing tool-only assistant message", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "do it" }] },
		{ role: "assistant", content: [{ type: "text", text: "First finding\nSecond finding" }] },
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "done", arguments: {} }], stopReason: "toolUse" },
	];
	assert.equal(extractReport(messages), "First finding\nSecond finding");
});

test("extractReport recovers reasoning when no assistant text exists", () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "The report should start here and continue below." }],
			stopReason: "stop",
		},
	];
	assert.match(extractReport(messages), /recovered the final reasoning block/);
	assert.match(extractReport(messages), /report should start here/);
	assert.equal(findReport(messages)?.source, "thinking");
});

test("missing reports expose the assistant message shape", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "toolCall", id: "b", name: "grep", arguments: {} },
			],
			stopReason: "toolUse",
		},
	];
	assert.equal(
		reportShape(messages),
		"1 assistant messages · blocks toolCall:2 · last stop \"toolUse\"",
	);
});
