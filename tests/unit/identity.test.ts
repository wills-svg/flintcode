import test from "node:test";
import assert from "node:assert/strict";
import { applyFlintcodeIdentity } from "../../src/extensions/identity.js";

const PI_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read
</tools>

<docs>
Pi documentation:
- Main documentation: /pi/docs
- Examples: /pi/examples
</docs>`;

test("replaces pi identity and docs with Flintcode identity and policy", () => {
	const prompt = applyFlintcodeIdentity(PI_PROMPT);
	assert.match(prompt, /You are Flintcode/);
	assert.doesNotMatch(prompt, /operating inside pi/);
	assert.doesNotMatch(prompt, /Pi documentation:/);
	assert.match(prompt, /flintcode docs/);
	assert.match(prompt, /Never describe yourself as pi/);
	assert.match(prompt, /<harness_identity>/);
	assert.match(prompt, /<tools>/);
});

test("does not duplicate identity on repeated application", () => {
	const once = applyFlintcodeIdentity(PI_PROMPT);
	const twice = applyFlintcodeIdentity(once);
	assert.equal((twice.match(/<harness_identity>/g) ?? []).length, 1);
	assert.equal((twice.match(/You are Flintcode/g) ?? []).length, 1);
});
