import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createFlintcodePaths, ensureFlintcodeLayout } from "../../src/core/paths.js";
import { defaultConfig, normalizeConfig } from "../../src/core/config.js";
import { formatTodos, loadSessionTodos, replaceTodos, saveSessionTodos } from "../../src/core/todos.js";
import { MemoryService } from "../../src/core/memory.js";
import { GoalService, formatGoals } from "../../src/core/goals.js";
import { LoopManager, parseInterval } from "../../src/core/loops.js";
import { HookRunner } from "../../src/core/hooks.js";
import { htmlToText, parseDuckDuckGoResults } from "../../src/core/web.js";
import { discoverAgents } from "../../src/core/agent-runner.js";

async function tempWorkspace(): Promise<{ home: string; cwd: string; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "flintcode-test-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	await fs.mkdir(cwd, { recursive: true });
	const paths = createFlintcodePaths(home, cwd);
	await ensureFlintcodeLayout(paths);
	return { home, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("config normalization merges layers and clamps limits", () => {
	const config = normalizeConfig({
		defaults: { model: "m" },
		ui: { theme: "light" },
		agents: { maxDepth: 99, maxConcurrent: -2, maxToolCalls: 1000 },
		permissions: { mode: "not-a-mode" },
	});
	const fallback = defaultConfig();
	assert.equal(config.defaults.model, "m");
	assert.equal(config.defaults.provider, fallback.defaults.provider);
	assert.equal(config.ui.theme, "light");
	assert.equal(config.agents.maxDepth, 4);
	assert.equal(config.agents.maxConcurrent, 1);
	assert.equal(config.agents.maxToolCalls, 200);
	assert.equal(config.permissions.mode, "default");
});

test("todos replace, persist and format", async () => {
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		const first = replaceTodos(
			{ version: 1, nextId: 1, items: [] },
			[
				{ content: "design", status: "in_progress", priority: "high" },
				{ content: "test", status: "pending" },
			],
		);
		assert.equal(first.items.length, 2);
		assert.equal(first.items[0].priority, "high");
		await saveSessionTodos(paths, "session-1", first);
		const loaded = await loadSessionTodos(paths, "session-1");
		assert.equal(loaded.items[1].title, "test");
		const second = replaceTodos(loaded, [
			{ id: loaded.items[0].id, content: "design", status: "completed" },
		]);
		assert.equal(second.items.length, 1);
		assert.equal(second.items[0].status, "completed");
		assert.match(formatTodos(second), /1 completed/);
	} finally {
		await workspace.cleanup();
	}
});

test("memory save, search, pinned and delete", async () => {
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		const memory = new MemoryService(paths, workspace.cwd);
		const alpha = await memory.save({
			text: "The build uses TypeScript incremental mode",
			tags: ["build"],
			pinned: true,
		});
		await memory.save({ text: "Unrelated note about banana bread" });
		const results = await memory.search("typescript build");
		assert.equal(results[0].id, alpha.id);
		const pinned = await memory.pinned();
		assert.equal(pinned.length, 1);
		assert.equal((await memory.delete(alpha.id.slice(0, 10)))?.id, alpha.id);
		assert.equal((await memory.list()).length, 1);
	} finally {
		await workspace.cleanup();
	}
});

test("goals are project-scoped and mutable", async () => {
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		const goals = new GoalService(paths, workspace.cwd);
		const goal = await goals.create("Ship Flintcode", "local-first harness");
		assert.equal((await goals.active()).length, 1);
		const updated = await goals.update(goal.id.slice(0, 8), { status: "complete" });
		assert.equal(updated?.status, "complete");
		assert.equal((await goals.active()).length, 0);
		assert.match(formatGoals(await goals.forWorkspace()), /Ship Flintcode/);
		assert.equal(await goals.remove(goal.id), true);
	} finally {
		await workspace.cleanup();
	}
});

test("loop intervals parse and loops do not fire immediately", async () => {
	assert.equal(parseInterval("30s"), 30_000);
	assert.equal(parseInterval("5m"), 300_000);
	assert.equal(parseInterval("bad"), undefined);
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		let prompts = 0;
		const fakeSession = {
			sessionId: "loop-session",
			isStreaming: false,
			prompt: async () => {
				prompts += 1;
			},
		} as unknown as AgentSession;
		const loops = new LoopManager({
			paths,
			minIntervalMs: 5_000,
			maxIterations: 3,
			getSession: () => fakeSession,
		});
		await loops.setSession(fakeSession);
		const record = await loops.add("check status", 5_000);
		const listed = await loops.list();
		assert.equal(listed.length, 1);
		assert.equal(record.status, "active");
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(prompts, 0);
		await loops.stop(record.id, "remove");
		assert.equal((await loops.list()).length, 0);
		loops.dispose();
	} finally {
		await workspace.cleanup();
	}
});

test("hooks can deny and transform input", async () => {
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		const deny = new HookRunner({
			cwd: workspace.cwd,
			timeoutMs: 15_000,
			hooks: [
				{
					id: "deny-bash",
					event: "PreToolUse",
					matcher: { tool: "bash" },
					type: "command",
					command: `printf '{"decision":"deny","reason":"blocked by test"}'`,
				},
			],
		});
		const denied = await deny.run("PreToolUse", { toolName: "bash", input: { command: "ls" } });
		assert.equal(denied.blocked, true);
		assert.equal(denied.reason, "blocked by test");
		const allowed = await deny.run("PreToolUse", { toolName: "read", input: { path: "a" } });
		assert.equal(allowed.blocked, false);
		const transform = new HookRunner({
			cwd: workspace.cwd,
			timeoutMs: 15_000,
			hooks: [
				{
					id: "rewrite",
					event: "UserPromptSubmit",
					type: "command",
					command: `printf '{"text":"rewritten"}'`,
				},
			],
		});
		const result = await transform.run("UserPromptSubmit", { text: "original" });
		assert.equal(result.text, "rewritten");
		void paths;
	} finally {
		await workspace.cleanup();
	}
});

test("html extraction keeps title, text and links", () => {
	const result = htmlToText(
		`<html><head><title>Hello &amp; world</title><style>.x{}</style></head><body><h1>Head</h1><p>Some <b>bold</b> text.</p><a href="https://example.com">Example</a><script>alert(1)</script></body></html>`,
	);
	assert.equal(result.title, "Hello & world");
	assert.match(result.text, /Some bold text/);
	assert.doesNotMatch(result.text, /alert/);
	assert.equal(result.links[0].url, "https://example.com");
});

test("DuckDuckGo result parsing decodes redirects and snippets", () => {
	const html = `
	<div class="result results_links results_links_deep web-result">
	  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftermux.dev%2Fen%2F&rut=x">Termux &amp; tools</a></h2>
	  <a class="result__snippet" href="#">Packages available in Termux.</a>
	</div>
	<div class="result results_links results_links_deep web-result">
	  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/page">Example</a></h2>
	</div>`;
	const results = parseDuckDuckGoResults(html, 5);
	assert.equal(results.length, 2);
	assert.equal(results[0].url, "https://termux.dev/en/");
	assert.equal(results[0].title, "Termux & tools");
	assert.equal(results[0].description, "Packages available in Termux.");
	assert.equal(results[1].url, "https://example.com/page");
});

test("agent discovery includes builtins and project agents", async () => {
	const workspace = await tempWorkspace();
	try {
		const paths = createFlintcodePaths(workspace.home, workspace.cwd);
		await fs.mkdir(path.join(workspace.cwd, ".flintcode", "agents"), { recursive: true });
		await fs.writeFile(
			path.join(workspace.cwd, ".flintcode", "agents", "custom.md"),
			"---\nname: custom\ndescription: custom agent\ntools: read, grep\n---\n\nYou are custom.",
		);
		const agents = await discoverAgents({
			paths,
			config: defaultConfig(paths.piAgentDir),
			cwd: workspace.cwd,
			projectTrusted: true,
		});
		assert.ok(agents.some((agent) => agent.name === "general-purpose"));
		const custom = agents.find((agent) => agent.name === "custom");
		assert.equal(custom?.source, "project");
		assert.deepEqual(custom?.tools, ["read", "grep"]);
		assert.equal(custom?.model, undefined);
	} finally {
		await workspace.cleanup();
	}
});
