import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { ensureDir, pathExists } from "../util/atomic-json.js";
import { newTaskId } from "../util/ids.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
	path: string;
	head?: string;
	branch?: string;
	detached?: boolean;
	bare?: boolean;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			timeout: 5_000,
		});
		return Boolean(stdout.trim());
	} catch {
		return false;
	}
}

export async function repoRoot(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		timeout: 5_000,
	});
	return stdout.trim();
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	if (!(await isGitRepo(cwd))) return [];
	const { stdout } = await execFileAsync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
		timeout: 10_000,
	});
	const entries: WorktreeInfo[] = [];
	let current: WorktreeInfo | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length) };
		} else if (current && line.startsWith("HEAD ")) {
			current.head = line.slice(5);
		} else if (current && line.startsWith("branch ")) {
			current.branch = line.slice(7).replace(/^refs\/heads\//, "");
		} else if (current && line === "detached") {
			current.detached = true;
		} else if (current && line === "bare") {
			current.bare = true;
		}
	}
	if (current) entries.push(current);
	return entries;
}

export async function createWorktree(options: {
	cwd: string;
	root: string;
	name?: string;
}): Promise<{ path: string; branch: string }> {
	const root = path.resolve(options.root.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
	const repo = await repoRoot(options.cwd);
	const name =
		options.name?.trim() ||
		`${path.basename(repo).replace(/[^a-zA-Z0-9._-]+/g, "-")}-${newTaskId()}`;
	if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
		throw new Error("Worktree name may contain only letters, digits, dots, underscores and dashes.");
	}
	const target = path.join(root, name);
	await ensureDir(root);
	const existing = (await listWorktrees(repo)).find(
		(entry) => path.resolve(entry.path) === path.resolve(target),
	);
	if (existing) return { path: existing.path, branch: existing.branch ?? "(detached)" };
	if (await pathExists(target)) throw new Error(`Target already exists: ${target}`);
	const branch = `flintcode/${name}`;
	try {
		await execFileAsync("git", ["-C", repo, "worktree", "add", target, "-b", branch], {
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		});
	} catch (error) {
		// Reuse an existing branch if one is already present.
		try {
			await execFileAsync("git", ["-C", repo, "worktree", "add", target, branch], {
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
			});
		} catch {
			throw new Error(
				`Could not create worktree ${target}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { path: target, branch };
}

export async function removeWorktree(cwd: string, targetOrName: string, force = false): Promise<string> {
	const repo = await repoRoot(cwd);
	const worktrees = await listWorktrees(repo);
	const match = worktrees.find(
		(entry) =>
			path.resolve(entry.path) === path.resolve(targetOrName) ||
			path.basename(entry.path) === targetOrName ||
			entry.branch === targetOrName ||
			entry.branch === `flintcode/${targetOrName}`,
	);
	if (!match) throw new Error(`No worktree matched "${targetOrName}".`);
	if (path.resolve(match.path) === path.resolve(repo)) {
		throw new Error("Refusing to remove the main worktree.");
	}
	await execFileAsync(
		"git",
		["-C", repo, "worktree", "remove", ...(force ? ["--force"] : []), match.path],
		{ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
	);
	return match.path;
}

export function formatWorktrees(worktrees: WorktreeInfo[], currentCwd: string): string {
	if (worktrees.length === 0) return "Not inside a git repository.";
	return worktrees
		.map((entry) => {
			const current = path.resolve(entry.path) === path.resolve(currentCwd) ? "  ← current" : "";
			return `${entry.branch ?? (entry.detached ? "(detached)" : "(bare)")}${current}\n  ${entry.path}`;
		})
		.join("\n");
}
