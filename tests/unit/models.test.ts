import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, supportedThinkingLevels } from "../../src/core/models.js";

function model(overrides: Record<string, unknown>): Model<any> {
	return {
		id: "test",
		name: "Test",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 100_000,
		maxTokens: 10_000,
		...overrides,
	} as unknown as Model<any>;
}

test("non-reasoning models only support off", () => {
	assert.deepEqual(supportedThinkingLevels(model({ reasoning: false })), ["off"]);
});

test("reasoning models default to standard levels and expose xhigh/max only when mapped", () => {
	assert.deepEqual(supportedThinkingLevels(model({})), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(
		supportedThinkingLevels(model({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } })),
		["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	);
});

test("null mappings remove a level", () => {
	assert.deepEqual(
		supportedThinkingLevels(model({ thinkingLevelMap: { medium: null, max: "max" } })),
		["off", "minimal", "low", "high", "max"],
	);
});

test("clamping selects a real supported level", () => {
	const supported = model({ thinkingLevelMap: { minimal: null, medium: null, xhigh: null } });
	assert.deepEqual(supportedThinkingLevels(supported), ["off", "low", "high"]);
	assert.equal(clampThinkingLevel(supported, "medium"), "high");
	assert.equal(clampThinkingLevel(supported, "minimal"), "low");
});
