import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlintcodePaths } from "./paths.js";
import type { LoopRecord } from "./types.js";
import { readJson, writeJsonAtomic } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import { newId } from "../util/ids.js";
import { formatDuration, truncateText } from "../util/format.js";

export interface LoopManagerOptions {
	paths: FlintcodePaths;
	minIntervalMs: number;
	maxIterations: number;
	getSession: () => AgentSession | undefined;
	notify?: (message: string, kind?: "info" | "warning" | "error") => void;
}

export function parseInterval(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = (match[2] ?? "m").toLowerCase();
	const multiplier = unit.startsWith("h") ? 3_600_000 : unit.startsWith("s") ? 1_000 : 60_000;
	return Math.round(amount * multiplier);
}

export class LoopManager {
	private readonly options: LoopManagerOptions;
	private loops: LoopRecord[] = [];
	private sessionId?: string;
	private timer?: NodeJS.Timeout;
	private disposed = false;
	private firing = false;

	constructor(options: LoopManagerOptions) {
		this.options = options;
	}

	async setSession(session: AgentSession | undefined): Promise<void> {
		this.sessionId = session?.sessionId;
		await this.load();
		if (!this.timer) this.startTimer();
	}

	async list(): Promise<LoopRecord[]> {
		await this.load();
		return this.loopsForSession();
	}

	async add(prompt: string, intervalMs: number, options?: { maxIterations?: number }): Promise<LoopRecord> {
		if (!prompt.trim()) throw new Error("A loop prompt is required.");
		if (intervalMs < this.options.minIntervalMs) {
			throw new Error(`Minimum loop interval is ${formatDuration(this.options.minIntervalMs)}.`);
		}
		const record: LoopRecord = {
			id: newId("loop"),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			prompt: prompt.trim(),
			intervalMs,
			dynamic: false,
			maxIterations: Math.min(
				options?.maxIterations ?? this.options.maxIterations,
				this.options.maxIterations,
			),
			iterations: 0,
			createdAt: new Date().toISOString(),
			lastRun: Date.now(),
			status: "active",
		};
		await withFileLock(this.options.paths.loopsFile, async () => {
			await this.load();
			this.loops.push(record);
			await this.save();
		});
		this.notify(`loop ${record.id.slice(0, 10)} every ${formatDuration(intervalMs)}`, "info");
		return record;
	}

	async scheduleOnce(prompt: string, delaySeconds: number): Promise<LoopRecord> {
		if (!prompt.trim()) throw new Error("A wakeup prompt is required.");
		const record: LoopRecord = {
			id: newId("wake"),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			prompt: prompt.trim(),
			intervalMs: Math.max(1_000, delaySeconds * 1_000),
			dynamic: true,
			maxIterations: 1,
			iterations: 0,
			createdAt: new Date().toISOString(),
			lastRun: Date.now(),
			status: "active",
		};
		await withFileLock(this.options.paths.loopsFile, async () => {
			await this.load();
			this.loops.push(record);
			await this.save();
		});
		this.notify(`wakeup scheduled in ${delaySeconds}s`, "info");
		return record;
	}

	async stop(idOrPrefix: string, action: "pause" | "resume" | "remove"): Promise<LoopRecord | undefined> {
		return withFileLock(this.options.paths.loopsFile, async () => {
			await this.load();
			const loop = this.loops.find(
				(entry) => entry.id === idOrPrefix || entry.id.startsWith(idOrPrefix),
			);
			if (!loop) return undefined;
			if (action === "remove") {
				this.loops = this.loops.filter((entry) => entry.id !== loop.id);
				await this.save();
				return loop;
			}
			loop.status = action === "pause" ? "paused" : "active";
			await this.save();
			return loop;
		});
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async load(): Promise<void> {
		const raw = await readJson<unknown>(this.options.paths.loopsFile, { version: 1, loops: [] });
		if (raw && typeof raw === "object" && Array.isArray((raw as { loops?: unknown }).loops)) {
			this.loops = (raw as { loops: LoopRecord[] }).loops;
		} else {
			this.loops = [];
		}
	}

	private async save(): Promise<void> {
		await writeJsonAtomic(this.options.paths.loopsFile, { version: 1, loops: this.loops });
	}

	private loopsForSession(): LoopRecord[] {
		return this.loops.filter((loop) => !loop.sessionId || loop.sessionId === this.sessionId);
	}

	private startTimer(): void {
		this.timer = setInterval(() => {
			void this.tick();
		}, 1_000);
		this.timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (this.disposed || this.firing) return;
		const session = this.options.getSession();
		if (!session || session.sessionId !== this.sessionId) return;
		if (session.isStreaming || this.sessionId === undefined) return;
		const due = await withFileLock(this.options.paths.loopsFile, async () => {
			await this.load();
			const now = Date.now();
			const found = this.loopsForSession().find(
				(loop) =>
					loop.status === "active" &&
					(loop.lastRun === undefined || now - loop.lastRun >= loop.intervalMs) &&
					loop.iterations < loop.maxIterations,
			);
			if (!found) return undefined;
			found.iterations += 1;
			found.lastRun = now;
			if (found.iterations >= found.maxIterations) found.status = "done";
			await this.save();
			return found;
		});
		if (!due) return;
		this.firing = true;
		try {
			this.notify(`loop ${due.id.slice(0, 10)}: ${truncateText(due.prompt, 80)}`, "info");
			await session.prompt(due.prompt, { source: "extension" });
		} catch (error) {
			this.notify(
				`loop ${due.id.slice(0, 10)} failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			this.firing = false;
		}
	}

	private notify(message: string, kind: "info" | "warning" | "error"): void {
		this.options.notify?.(message, kind);
	}
}

export function formatLoops(loops: LoopRecord[]): string {
	if (loops.length === 0) return "No loops scheduled for this session.";
	return loops
		.map((loop) => {
			const next =
				loop.status === "active" && loop.lastRun
					? ` · next in ${formatDuration(Math.max(0, loop.intervalMs - (Date.now() - loop.lastRun)))}`
					: "";
			return `${loop.id.slice(0, 10)}  [${loop.status}]  every ${formatDuration(loop.intervalMs)}  ${loop.iterations}/${loop.maxIterations}${next}\n  ${truncateText(loop.prompt, 180)}`;
		})
		.join("\n");
}
