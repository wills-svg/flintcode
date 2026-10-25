import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FlintcodePaths } from "./paths.js";
import type { BackgroundTask, BackgroundTaskStatus } from "./types.js";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../util/atomic-json.js";
import { newTaskId } from "../util/ids.js";
import { oneLine, truncateText } from "../util/format.js";

export interface BackgroundTaskRecord extends BackgroundTask {
	pid: number;
	pgid: number;
	logPath: string;
}

function taskDirectory(paths: FlintcodePaths): string {
	return path.join(paths.tasksDir, "bash");
}

export function taskMetaPath(paths: FlintcodePaths, id: string): string {
	return path.join(taskDirectory(paths), `${id}.json`);
}

export function taskLogPath(paths: FlintcodePaths, id: string): string {
	return path.join(taskDirectory(paths), `${id}.log`);
}

export class TaskManager {
	private readonly paths: FlintcodePaths;

	constructor(paths: FlintcodePaths) {
		this.paths = paths;
	}

	async start(command: string, options?: { cwd?: string; description?: string; sessionId?: string }): Promise<BackgroundTaskRecord> {
		if (!command.trim()) throw new Error("command is required");
		const id = newTaskId();
		const directory = taskDirectory(this.paths);
		await ensureDir(directory);
		const logPath = taskLogPath(this.paths, id);
		const metaPath = taskMetaPath(this.paths, id);
		const cwd = options?.cwd ?? process.cwd();
		const handle = await fs.open(logPath, "a", 0o600);
		let child;
		try {
			child = spawn("bash", ["-lc", command], {
				cwd,
				detached: true,
				stdio: ["ignore", handle.fd, handle.fd],
				env: {
					...process.env,
					FLINTCODE_TASK_ID: id,
					FLINTCODE_TASK_LOG: logPath,
				},
			});
		} finally {
			await handle.close();
		}
		const pid = child.pid;
		if (!pid) throw new Error("Failed to start background task");
		const record: BackgroundTaskRecord = {
			id,
			kind: "bash",
			status: "running",
			pid,
			pgid: pid,
			command,
			...(options?.description ? { description: options.description } : {}),
			cwd,
			startedAt: new Date().toISOString(),
			logPath,
			...(options?.sessionId ? { sessionId: options.sessionId } : {}),
		};
		await writeJsonAtomic(metaPath, record);
		child.on("exit", (code, signal) => {
			void this.finish(id, code, signal);
		});
		child.on("error", () => {
			void this.finish(id, null, "error");
		});
		child.unref();
		return record;
	}

	private async finish(id: string, code: number | null, signal: NodeJS.Signals | string | null): Promise<void> {
		const metaPath = taskMetaPath(this.paths, id);
		const record = await readJson<BackgroundTaskRecord | undefined>(metaPath, undefined);
		if (!record) return;
		if (record.status !== "running") return;
		record.status = code === 0 ? "done" : signal === "SIGTERM" || signal === "SIGKILL" ? "killed" : "failed";
		record.exitCode = code;
		record.endedAt = new Date().toISOString();
		record.tail = await this.tail(id, 20);
		await writeJsonAtomic(metaPath, record);
	}

	async get(idOrPrefix: string): Promise<BackgroundTaskRecord | undefined> {
		const records = await this.list();
		return records.find((record) => record.id === idOrPrefix || record.id.startsWith(idOrPrefix));
	}

	async list(): Promise<BackgroundTaskRecord[]> {
		const directory = taskDirectory(this.paths);
		let entries: string[];
		try {
			entries = await fs.readdir(directory);
		} catch {
			return [];
		}
		const records: BackgroundTaskRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const record = await readJson<BackgroundTaskRecord | undefined>(
				path.join(directory, entry),
				undefined,
			);
			if (!record) continue;
			if (record.status === "running" && !isProcessAlive(record.pid)) {
				record.status = "done";
				record.endedAt = record.endedAt ?? new Date().toISOString();
				record.exitCode = record.exitCode ?? null;
				await writeJsonAtomic(path.join(directory, entry), record);
			}
			records.push(record);
		}
		return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
	}

	async output(idOrPrefix: string, tailLines = 60): Promise<{ record: BackgroundTaskRecord; output: string }> {
		const record = await this.get(idOrPrefix);
		if (!record) throw new Error(`No background task matched "${idOrPrefix}".`);
		if (record.status === "running" && !isProcessAlive(record.pid)) {
			await this.finish(record.id, null, "lost");
			record.status = "failed";
		}
		const output = await this.tail(record.id, tailLines);
		record.tail = output;
		return { record, output };
	}

	async kill(idOrPrefix: string): Promise<BackgroundTaskRecord> {
		const record = await this.get(idOrPrefix);
		if (!record) throw new Error(`No background task matched "${idOrPrefix}".`);
		if (record.status !== "running") return record;
		try {
			process.kill(-record.pgid, "SIGTERM");
		} catch {
			try {
				process.kill(record.pid, "SIGTERM");
			} catch {
				// It may already be gone.
			}
		}
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && isProcessAlive(record.pid)) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (isProcessAlive(record.pid)) {
			try {
				process.kill(-record.pgid, "SIGKILL");
			} catch {
				// Best effort.
			}
		}
		record.status = "killed";
		record.endedAt = new Date().toISOString();
		record.exitCode = null;
		await writeJsonAtomic(taskMetaPath(this.paths, record.id), record);
		return record;
	}

	async tail(id: string, lines: number): Promise<string> {
		const logPath = taskLogPath(this.paths, id);
		if (!(await pathExists(logPath))) return "";
		try {
			const stat = await fs.stat(logPath);
			const maxBytes = 96 * 1024;
			const start = Math.max(0, stat.size - maxBytes);
			const handle = await fs.open(logPath, "r");
			try {
				const length = stat.size - start;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, start);
				const text = buffer.toString("utf8");
				const all = text.split("\n");
				if (start > 0) all.shift();
				return all.slice(-lines).join("\n");
			} finally {
				await handle.close();
			}
		} catch {
			return "";
		}
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function formatTaskRecord(record: BackgroundTaskRecord): string {
	const status = record.status as BackgroundTaskStatus;
	const ended = record.endedAt ? ` ended ${record.endedAt}` : "";
	return [
		`${record.id}  [${status}]  ${record.command ? truncateText(oneLine(record.command), 120) : "(no command)"}`,
		`  pid ${record.pid} · cwd ${record.cwd} · started ${record.startedAt}${ended}${record.exitCode !== undefined ? ` · exit ${record.exitCode}` : ""}`,
		record.tail ? `  ${truncateText(record.tail.replace(/\s+/g, " "), 200)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
