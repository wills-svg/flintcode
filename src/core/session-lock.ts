import * as fs from "node:fs/promises";
import * as path from "node:path";

interface SessionLockOwner {
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: string;
}

const STALE_MS = 45_000;
const HEARTBEAT_MS = 10_000;

function safeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(lockPath: string): Promise<SessionLockOwner | undefined> {
	try {
		const value = JSON.parse(
			await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
		) as Partial<SessionLockOwner>;
		if (typeof value.pid === "number" && typeof value.sessionId === "string") {
			return value as SessionLockOwner;
		}
	} catch {
		// The lock may have been created but not yet populated.
	}
	return undefined;
}

/**
 * Lifetime lease for a session file. Unlike withFileLock this is held for the
 * whole time a session is bound, so two Flintcode processes cannot append to the same
 * JSONL session. A heartbeat keeps the lease fresh while the process is idle.
 */
export class SessionLock {
	private readonly directory: string;
	private held?: { sessionId: string; lockPath: string; heartbeat: NodeJS.Timeout };

	constructor(stateDir: string) {
		this.directory = path.join(stateDir, "session-locks");
	}

	async acquire(sessionId: string, cwd = process.cwd()): Promise<void> {
		if (this.held?.sessionId === sessionId) return;
		await fs.mkdir(this.directory, { recursive: true });
		const lockPath = path.join(this.directory, `${safeId(sessionId)}.lock`);
		let acquired = false;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				await fs.mkdir(lockPath);
				acquired = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const stale = await this.isStale(lockPath);
				if (stale) {
					await fs.rm(lockPath, { recursive: true, force: true });
					continue;
				}
				const owner = await readOwner(lockPath);
				const detail = owner
					? `pid ${owner.pid}, cwd ${owner.cwd}, opened ${owner.startedAt}`
					: "another process";
				throw new Error(
					`Session ${sessionId.slice(0, 12)} is already open (${detail}). ` +
						"Resume it in that process, quit it first, or start a fork with `flintcode --fork`.",
				);
			}
		}
		if (!acquired) {
			throw new Error(`Could not acquire the session lock for ${sessionId.slice(0, 12)}.`);
		}
		try {
			const owner: SessionLockOwner = {
				pid: process.pid,
				sessionId,
				cwd: path.resolve(cwd),
				startedAt: new Date().toISOString(),
			};
			await fs.writeFile(
				path.join(lockPath, "owner.json"),
				JSON.stringify(owner),
				{ mode: 0o600 },
			);
		} catch (error) {
			await fs.rm(lockPath, { recursive: true, force: true });
			throw error;
		}
		const heartbeat = setInterval(() => {
			const now = new Date();
			void fs.utimes(lockPath, now, now).catch(() => undefined);
		}, HEARTBEAT_MS);
		heartbeat.unref?.();
		await this.release();
		this.held = { sessionId, lockPath, heartbeat };
	}

	async release(): Promise<void> {
		if (!this.held) return;
		clearInterval(this.held.heartbeat);
		const lockPath = this.held.lockPath;
		this.held = undefined;
		await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
	}

	private async isStale(lockPath: string): Promise<boolean> {
		let age = 0;
		try {
			const stat = await fs.stat(lockPath);
			age = Date.now() - stat.mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			return true;
		}
		if (age > STALE_MS) return true;
		const owner = await readOwner(lockPath);
		return Boolean(owner && !isAlive(owner.pid) && age > 1_000);
	}
}
