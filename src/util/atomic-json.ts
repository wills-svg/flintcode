import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const queues = new Map<string, Promise<unknown>>();

function serialize<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(filePath) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(operation);
	queues.set(filePath, next);
	return next.finally(() => {
		if (queues.get(filePath) === next) queues.delete(filePath);
	});
}

export async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export interface JsonReadResult<T> {
	value: T;
	exists: boolean;
	error?: string;
}

export async function readJsonResult<T>(filePath: string, fallback: T): Promise<JsonReadResult<T>> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		try {
			return { value: JSON.parse(text) as T, exists: true };
		} catch (error) {
			return {
				value: fallback,
				exists: true,
				error: `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { value: fallback, exists: false };
		return {
			value: fallback,
			exists: false,
			error: `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	return (await readJsonResult(filePath, fallback)).value;
}

export async function writeJsonAtomic(
	filePath: string,
	value: unknown,
	options?: { mode?: number; pretty?: boolean },
): Promise<void> {
	await serialize(filePath, async () => {
		await ensureDir(path.dirname(filePath));
		const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		const text = `${JSON.stringify(value, null, options?.pretty === false ? 0 : 2)}\n`;
		const handle = await fs.open(temporary, "w", options?.mode ?? 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, filePath);
		try {
			const directoryHandle = await fs.open(path.dirname(filePath), "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {
			// Directory fsync is not supported everywhere (notably some Android kernels).
		}
	});
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await serialize(filePath, async () => {
		await ensureDir(path.dirname(filePath));
		const line = `${JSON.stringify(value)}\n`;
		await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
	});
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
	try {
		const text = await fs.readFile(filePath, "utf8");
		const values: T[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				values.push(JSON.parse(trimmed) as T);
			} catch {
				// Ignore a partially written or corrupt line.
			}
		}
		return values;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function writeJsonlAtomic<T>(filePath: string, values: T[]): Promise<void> {
	await serialize(filePath, async () => {
		await ensureDir(path.dirname(filePath));
		const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		const text = values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
		await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
		await fs.rename(temporary, filePath);
	});
}
