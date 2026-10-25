import * as fs from "node:fs/promises";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

function safeData(data: unknown): unknown {
	if (data === undefined) return undefined;
	if (data instanceof Error) {
		return { name: data.name, message: data.message, stack: data.stack };
	}
	return data;
}

export async function createLogger(logFile: string, options?: { debug?: boolean }): Promise<Logger> {
	await fs.mkdir(path.dirname(logFile), { recursive: true });
	const write = (level: LogLevel, message: string, data?: unknown) => {
		const record = {
			time: new Date().toISOString(),
			level,
			message,
			...(data === undefined ? {} : { data: safeData(data) }),
		};
		void fs.appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8").catch(() => undefined);
		if (options?.debug) {
			const suffix = data === undefined ? "" : ` ${JSON.stringify(safeData(data))}`;
			console.error(`[flintcode ${level}] ${message}${suffix}`);
		}
	};
	return {
		debug: (message, data) => write("debug", message, data),
		info: (message, data) => write("info", message, data),
		warn: (message, data) => write("warn", message, data),
		error: (message, data) => write("error", message, data),
	};
}
