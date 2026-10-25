import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileLockOptions {
	timeoutMs?: number;
	staleMs?: number;
}

interface LockOwner {
	pid: number;
	at: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		const text = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
		const value = JSON.parse(text) as Partial<LockOwner>;
		if (typeof value.pid === "number" && typeof value.at === "number") {
			return { pid: value.pid, at: value.at };
		}
	} catch {
		// Missing or unreadable owner metadata is handled by mtime checks.
	}
	return undefined;
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
	let age = 0;
	try {
		const stat = await fs.stat(lockPath);
		age = Date.now() - stat.mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		return true;
	}
	if (age > staleMs) return true;
	const owner = await readOwner(lockPath);
	if (owner && !isAlive(owner.pid) && age > 1_000) return true;
	return false;
}

async function removeLock(lockPath: string): Promise<void> {
	await fs.rm(lockPath, { recursive: true, force: true });
}

/**
 * Cross-process advisory lock. The lock is a directory so acquisition is
 * atomic on filesystems without O_EXCL support for appends; stale locks left by
 * crashed processes are reclaimed after `staleMs`.
 */
export async function withFileLock<T>(
	targetPath: string,
	operation: () => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	let delay = 20;
	for (;;) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await lockIsStale(lockPath, staleMs)) {
				await removeLock(lockPath);
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out after ${timeoutMs}ms waiting for the lock on ${path.basename(lockPath)}. ` +
						`If no Flintcode process is running, remove ${lockPath}.`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * 20)));
			delay = Math.min(delay * 2, 200);
		}
	}
	try {
		const owner: LockOwner = { pid: process.pid, at: Date.now() };
		await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
		return await operation();
	} finally {
		await removeLock(lockPath).catch(() => undefined);
	}
}
