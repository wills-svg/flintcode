import { spawn } from "node:child_process";
import type { HookConfig, HookEvent } from "./types.js";

export interface HookRunResult {
	blocked: boolean;
	decision?: "allow" | "deny";
	reason?: string;
	input?: Record<string, unknown>;
	text?: string;
	outputs: Array<{ hook: string; stdout: string; stderr: string; timedOut: boolean; exitCode: number | null }>;
}

function matchesPattern(value: string | undefined, pattern: string): boolean {
	if (!value) return false;
	try {
		return new RegExp(pattern, "i").test(value);
	} catch {
		return value.toLowerCase().includes(pattern.toLowerCase());
	}
}

function pathFromInput(input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	for (const key of ["path", "file_path", "filePath", "file", "target", "dir"]) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export class HookRunner {
	private readonly hooks: HookConfig[];
	private readonly cwd: string;
	private readonly timeoutMs: number;

	constructor(options: { hooks: HookConfig[]; cwd: string; timeoutMs?: number }) {
		this.hooks = options.hooks;
		this.cwd = options.cwd;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	list(): HookConfig[] {
		return [...this.hooks];
	}

	async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookRunResult> {
		const matching = this.hooks.filter((hook) => {
			if (hook.enabled === false || hook.event !== event) return false;
			if (hook.matcher?.tool && !matchesPattern(String(payload.toolName ?? ""), hook.matcher.tool)) {
				return false;
			}
			if (hook.matcher?.path) {
				const input = payload.input as Record<string, unknown> | undefined;
				const filePath = pathFromInput(input);
				if (!matchesPattern(filePath, hook.matcher.path)) return false;
			}
			return hook.type !== "prompt";
		});
		const result: HookRunResult = { blocked: false, outputs: [] };
		for (const hook of matching) {
			if (!hook.command) continue;
			const timeout = hook.timeoutMs ?? this.timeoutMs;
			const outcome = await runShellHook(hook, event, payload, this.cwd, timeout);
			result.outputs.push({
				hook: hook.id,
				stdout: outcome.stdout,
				stderr: outcome.stderr,
				timedOut: outcome.timedOut,
				exitCode: outcome.exitCode,
			});
			const parsed = parseHookJson(outcome.stdout);
			if (parsed) {
				if (parsed.decision === "deny" || parsed.block === true) {
					result.blocked = true;
					result.decision = "deny";
					result.reason = typeof parsed.reason === "string" ? parsed.reason : `Blocked by hook ${hook.id}.`;
				}
				if (parsed.decision === "allow") {
					result.decision = "allow";
				}
				if (parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)) {
					result.input = parsed.input as Record<string, unknown>;
				}
				if (typeof parsed.text === "string") result.text = parsed.text;
			} else if (outcome.timedOut && hook.onError === "deny") {
				result.blocked = true;
				result.reason = `Hook ${hook.id} timed out.`;
			} else if (outcome.exitCode !== 0 && hook.onError === "deny") {
				result.blocked = true;
				result.reason = `Hook ${hook.id} failed with exit ${outcome.exitCode}.`;
			}
			if (result.blocked) break;
		}
		return result;
	}
}

function parseHookJson(stdout: string): Record<string, unknown> | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	const candidates = [trimmed, ...trimmed.split("\n").reverse()];
	for (const candidate of candidates) {
		const line = candidate.trim();
		if (!line.startsWith("{") || !line.endsWith("}")) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

function runShellHook(
	hook: HookConfig,
	event: HookEvent,
	payload: Record<string, unknown>,
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number | null }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killedForTimeout = false;
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, timedOut: killedForTimeout, exitCode });
		};
		let child;
		try {
			child = spawn("bash", ["-lc", hook.command ?? ""], {
				cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					FLINTCODE_HOOK_ID: hook.id,
					FLINTCODE_HOOK_EVENT: event,
					FLINTCODE_HOOK_CWD: cwd,
					FLINTCODE_HOOK_INTERNAL: "1",
				},
			});
		} catch (error) {
			stderr = error instanceof Error ? error.message : String(error);
			resolve({ stdout, stderr, timedOut: false, exitCode: null });
			return;
		}
		const cap = 1_000_000;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < cap) stdout += chunk.toString("utf8").slice(0, cap - stdout.length);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < cap) stderr += chunk.toString("utf8").slice(0, cap - stderr.length);
		});
		const timer = setTimeout(() => {
			killedForTimeout = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// Best effort.
			}
			finish(null);
		}, timeoutMs);
		timer.unref?.();
		child.on("error", (error) => {
			stderr += error.message;
			finish(null);
		});
		child.on("exit", (code) => finish(code));
		try {
			child.stdin?.write(
				`${JSON.stringify({
					event,
					cwd,
					timestamp: new Date().toISOString(),
					...payload,
				})}\n`,
			);
			child.stdin?.end();
		} catch {
			// The hook may not read stdin.
		}
	});
}
