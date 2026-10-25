import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFlintcodePaths } from "../../src/core/paths.js";
import { patchFlintcodeConfig } from "../../src/core/config.js";
import { updateSessionTodos } from "../../src/core/todos.js";
import { SessionLock } from "../../src/core/session-lock.js";
import { readJson, writeJsonAtomic } from "../../src/util/atomic-json.js";
import { withFileLock } from "../../src/util/lock.js";

async function tempRoot(): Promise<{ root: string; cwd: string; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "flintcode-lock-"));
	const cwd = path.join(root, "work");
	await fs.mkdir(cwd, { recursive: true });
	return { root, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withFileLock serializes read-modify-write operations", async () => {
	const workspace = await tempRoot();
	try {
		const file = path.join(workspace.root, "counter.json");
		await writeJsonAtomic(file, { value: 0 });
		await Promise.all(
			[0, 1, 2, 3].map(() =>
				withFileLock(file, async () => {
					const current = await readJson<{ value: number }>(file, { value: 0 });
					await sleep(25);
					await writeJsonAtomic(file, { value: current.value + 1 });
				}),
			),
		);
		const result = await readJson<{ value: number }>(file, { value: 0 });
		assert.equal(result.value, 4);
	} finally {
		await workspace.cleanup();
	}
});

test("patchFlintcodeConfig merges concurrent patches and preserves unknown keys", async () => {
	const workspace = await tempRoot();
	try {
		const paths = createFlintcodePaths(path.join(workspace.root, "home"), workspace.cwd);
		await fs.mkdir(paths.home, { recursive: true });
		await writeJsonAtomic(paths.configFile, {
			custom: { keep: true },
			permissions: { mode: "yolo" },
		});
		await fs.mkdir(paths.projectFlintcodeDir, { recursive: true });
		await writeJsonAtomic(paths.projectConfigFile, { ui: { theme: "project-theme" } });
		await Promise.all([
			patchFlintcodeConfig(paths, (config) => {
				config.ui.theme = "flintcode";
			}),
			patchFlintcodeConfig(paths, (config) => {
				config.permissions.mode = "auto";
			}),
		]);
		const raw = await readJson<Record<string, any>>(paths.configFile, {});
		assert.deepEqual(raw.custom, { keep: true });
		assert.equal(raw.ui.theme, "flintcode");
		assert.equal(raw.permissions.mode, "auto");
		// The project override must stay in the project file.
		assert.notEqual(raw.ui.theme, "project-theme");
	} finally {
		await workspace.cleanup();
	}
});

test("session locks reject a second live owner and move between sessions", async () => {
	const workspace = await tempRoot();
	try {
		const stateDir = path.join(workspace.root, "state");
		const first = new SessionLock(stateDir);
		await first.acquire("session-1", workspace.cwd);
		await first.acquire("session-1", workspace.cwd);
		const second = new SessionLock(stateDir);
		await assert.rejects(
			() => second.acquire("session-1", workspace.cwd),
			/already open/,
		);
		await first.acquire("session-2", workspace.cwd);
		const third = new SessionLock(stateDir);
		await third.acquire("session-1", workspace.cwd);
		await third.release();
		await first.release();
		const fourth = new SessionLock(stateDir);
		await fourth.acquire("session-2", workspace.cwd);
		await fourth.release();
	} finally {
		await workspace.cleanup();
	}
});

test("updateSessionTodos prevents lost updates between concurrent writers", async () => {
	const workspace = await tempRoot();
	try {
		const paths = createFlintcodePaths(path.join(workspace.root, "home"), workspace.cwd);
		await Promise.all(
			["alpha", "beta"].map((title) =>
				updateSessionTodos(paths, "session-lock", async (store) => {
					await sleep(20);
					return {
						...store,
						items: [
							...store.items,
							{
								id: `todo-${title}`,
								title,
								status: "pending",
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							},
						],
					};
				}),
			),
		);
		const final = await updateSessionTodos(paths, "session-lock", (store) => store);
		assert.equal(final.items.length, 2);
		assert.deepEqual(final.items.map((item) => item.title).sort(), ["alpha", "beta"]);
	} finally {
		await workspace.cleanup();
	}
});
