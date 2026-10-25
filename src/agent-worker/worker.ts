import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAgentGuardExtension } from "../extensions/agent-guard.js";
import { createFlintcodeModelRuntime } from "../core/models.js";
import type { FlintcodePaths } from "../core/paths.js";
import type { FlintcodeConfig } from "../core/types.js";
import { oneLine, truncateText } from "../util/format.js";
import { findReport, reportShape as describeReportShape } from "../util/agent-report.js";
import type { ParentToWorker, WorkerInitMessage, WorkerToParent } from "./protocol.js";

const SUBAGENT_RULES = `You are running as a Flintcode subagent, separate from the parent conversation.
- Finish the task end-to-end and return a concise final report.
- You cannot ask the user directly. If something is ambiguous, state the assumption you used.
- Use tools when they make the result more reliable.
- After the final tool call, send the report in a normal assistant text message. Never put it only in a thinking block, tool output or progress message.
- Keep the final report self-contained: the parent has not seen your intermediate work.`;

const PERMISSION_TIMEOUT_MS = 15 * 60_000;

let session: AgentSession | undefined;
let unsubscribe: (() => void) | undefined;
let abortRequested = false;
let fatalSent = false;
let running = false;
let runStarted = 0;
let completedToolCalls = 0;
let toolBudgetReached = false;
let toolBudget = 40;
const pendingPermissions = new Map<string, (response: { allow: boolean; reason?: string }) => void>();
let permissionCounter = 0;

function send(message: WorkerToParent): void {
	try {
		process.send?.(message);
	} catch {
		// The parent channel is gone; nothing useful can be delivered.
	}
}

function sendFatal(error: unknown): void {
	if (fatalSent) return;
	fatalSent = true;
	const message = error instanceof Error ? error.message : String(error);
	send({ type: "fatal", error: message });
	cleanup();
	setTimeout(() => process.exit(1), 50).unref?.();
}

function settlePermissions(allow: boolean, reason: string): void {
	for (const [id, resolve] of [...pendingPermissions]) {
		pendingPermissions.delete(id);
		resolve({ allow, reason });
	}
}

function cleanup(): void {
	settlePermissions(false, "The subagent finished before the approval arrived.");
	unsubscribe?.();
	unsubscribe = undefined;
	if (session) {
		try {
			session.dispose();
		} catch {
			// Ignore teardown failures while exiting.
		}
		session = undefined;
	}
}

function extensionPaths(config: FlintcodeConfig, paths: FlintcodePaths): string[] {
	return config.compat.piExtensions.map((entry) =>
		path.isAbsolute(entry) ? entry : path.resolve(paths.home, entry),
	);
}

function safeArgsSummary(args: Record<string, unknown>): string {
	const preferred = ["command", "path", "file_path", "query", "url", "description"]
		.map((key) => args[key])
		.find((value): value is string => typeof value === "string");
	if (preferred) return truncateText(oneLine(preferred), 120);
	return truncateText(Object.keys(args).slice(0, 3).join(", "), 120);
}

function permissionBridge(sendRequest: (id: string, toolName: string, input: Record<string, unknown>) => void) {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_call", async (event) => {
			const id = `perm-${++permissionCounter}`;
			let timer: NodeJS.Timeout | undefined;
			const decision = new Promise<{ allow: boolean; reason?: string }>((resolve) => {
				pendingPermissions.set(id, resolve);
				timer = setTimeout(() => {
					if (pendingPermissions.delete(id)) {
						resolve({ allow: false, reason: "Permission approval timed out." });
					}
				}, PERMISSION_TIMEOUT_MS);
				timer.unref?.();
			});
			sendRequest(id, event.toolName, (event.input ?? {}) as Record<string, unknown>);
			try {
				const result = await decision;
				if (result.allow) return undefined;
				return { block: true, reason: result.reason ?? "Denied by the parent session." };
			} finally {
				if (timer) clearTimeout(timer);
				pendingPermissions.delete(id);
			}
		});
	};
}

async function createSession(message: WorkerInitMessage): Promise<AgentSession> {
	const settings = SettingsManager.create(message.cwd, message.paths.home, {
		projectTrusted: message.projectTrusted,
	});
	const loader = new DefaultResourceLoader({
		cwd: message.cwd,
		agentDir: message.paths.home,
		settingsManager: settings,
		noExtensions: true,
		additionalExtensionPaths: extensionPaths(message.config, message.paths),
		additionalSkillPaths: [
			message.paths.skillsDir,
			...(message.projectTrusted ? [message.paths.projectSkillsDir] : []),
			...(message.config.compat.piSkills ? [message.paths.piSkillsDir] : []),
		],
		appendSystemPrompt: [message.agent.systemPrompt, SUBAGENT_RULES],
		extensionFactories: [
			permissionBridge((id, toolName, input) =>
				send({ type: "permission_request", id, toolName, input }),
			),
			createAgentGuardExtension(message.config.agents.maxToolOutputChars),
		],
	});
	await loader.reload({ resolveProjectTrust: async () => message.projectTrusted });
	const { runtime } = await createFlintcodeModelRuntime(message.paths, message.config);
	const created = await createAgentSession({
		cwd: message.cwd,
		agentDir: message.paths.home,
		settingsManager: settings,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(message.cwd),
		modelRuntime: runtime,
		model: message.model as Model<any>,
		...(message.thinking ? { thinkingLevel: message.thinking as ThinkingLevel } : {}),
		tools: message.agent.tools,
	});
	await created.session.bindExtensions({
		mode: "print",
		onError: (error) => {
			send({ type: "activity", line: `extension: ${truncateText(error.error, 120)}` });
		},
	});
	return created.session;
}

function attachProgress(target: AgentSession): void {
	let lastTextSent = 0;
	let lastText = "";
	unsubscribe = target.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			const text = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const trimmed = text.trim();
			if (!trimmed || trimmed === lastText) return;
			const now = Date.now();
			if (now - lastTextSent < 350) return;
			lastTextSent = now;
			lastText = trimmed;
			send({ type: "text", text: truncateText(trimmed, 600) });
			return;
		}
		if (event.type === "tool_execution_start") {
			send({
				type: "activity",
				line: `→ ${event.toolName} ${safeArgsSummary((event.args ?? {}) as Record<string, unknown>)}`,
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			completedToolCalls += 1;
			send({ type: "activity", line: `← ${event.toolName} ${event.isError ? "error" : "ok"}` });
			if (running && !abortRequested && !toolBudgetReached && completedToolCalls >= toolBudget) {
				toolBudgetReached = true;
				send({ type: "activity", line: `stopped exploration after ${completedToolCalls} tool calls` });
				void target.abort().catch(() => undefined);
			}
		}
	});
}

function reportShape(target: AgentSession): string {
	return describeReportShape(target.messages);
}

async function prepare(message: WorkerInitMessage): Promise<void> {
	completedToolCalls = 0;
	toolBudgetReached = false;
	toolBudget = message.config.agents.maxToolCalls;
	const created = await createSession(message);
	if (abortRequested) {
		created.dispose();
		send({ type: "result", status: "aborted", error: "aborted", durationMs: 0 });
		setTimeout(() => process.exit(0), 50).unref?.();
		return;
	}
	session = created;
	attachProgress(created);
	send({ type: "ready", pid: process.pid });
}

async function execute(prompt: string): Promise<void> {
	if (!session) {
		sendFatal(new Error("worker received run without a prepared session"));
		return;
	}
	running = true;
	runStarted = Date.now();
	const target = session;
	let report = findReport(target.messages);
	const statsUsage = () => {
		const stats = target.getSessionStats();
		return {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			totalTokens: stats.tokens.total,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: stats.cost,
			},
		} satisfies Usage;
	};
	try {
		await target.prompt(prompt);
		report = findReport(target.messages);
		if ((!report || report.source === "thinking") && !abortRequested) {
			send({
				type: "activity",
				line: report
					? "thinking-only result; requesting one plain-text recovery pass"
					: `no report (${reportShape(target)}); requesting one plain-text recovery pass`,
			});
			await target.prompt(
				"Your previous response had no usable assistant text block. Return the completed report now as plain assistant text. Do not call tools and do not rely on a thinking block.",
			);
			report = findReport(target.messages);
		}
		if (!report) {
			send({
				type: "result",
				status: "error",
				error: `Subagent completed without a recoverable final report (${reportShape(target)}).`,
				usage: statsUsage(),
				durationMs: Date.now() - runStarted,
			});
			return;
		}
		send({
			type: "result",
			status: abortRequested
				? "aborted"
				: report.source === "text"
					? "done"
					: "error",
			output: report.text,
			reportSource: report.source,
			...(report.source === "thinking"
				? { error: "Subagent returned only reasoning content, not a final text report." }
				: {}),
			usage: statsUsage(),
			durationMs: Date.now() - runStarted,
		});
	} catch (error) {
		const parentAborted = abortRequested;
		const aborted = parentAborted || /aborted/i.test(String(error));
		report ??= findReport(target.messages);
		if (toolBudgetReached && !parentAborted) {
			send({ type: "activity", line: `tool budget reached; requesting summary` });
			try {
				await target.prompt(
					"Your tool budget is exhausted. Do not call any more tools. Return the best final report from the evidence already gathered, or state exactly what remains unknown.",
				);
			} catch {
				// The summary attempt may itself abort; return what was recovered.
			}
			report = findReport(target.messages) ?? report;
		}
		if (report) {
			const source = toolBudgetReached || aborted ? "partial" : report.source;
			send({
				type: "result",
				status: source === "text" ? "done" : "aborted",
				output: report.text,
				reportSource: source,
				error: source === "text" ? undefined : "Subagent report is partial or reasoning-only; its tool or time budget was interrupted.",
				usage: statsUsage(),
				durationMs: Date.now() - runStarted,
			});
		} else {
			send({
				type: "result",
				status: aborted ? "aborted" : "error",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - runStarted,
			});
		}
	} finally {
		running = false;
		cleanup();
		setTimeout(() => process.exit(0), 80).unref?.();
	}
}

async function handleMessage(message: ParentToWorker): Promise<void> {
	if (message.type === "init") {
		await prepare(message);
		return;
	}
	if (message.type === "run") {
		if (message.prompt === undefined) return;
		await execute(message.prompt);
		return;
	}
	if (message.type === "abort") {
		abortRequested = true;
		settlePermissions(false, message.reason ?? "Aborted by the parent.");
		if (session) {
			try {
				await session.abort();
			} catch {
				// Ignore abort failures during teardown.
			}
		}
		return;
	}
	if (message.type === "permission_response") {
		const resolve = pendingPermissions.get(message.id);
		if (resolve) {
			pendingPermissions.delete(message.id);
			resolve({ allow: message.allow, reason: message.reason });
		}
	}
}

process.on("message", (value) => {
	if (!value || typeof value !== "object") return;
	void handleMessage(value as ParentToWorker).catch((error) => sendFatal(error));
});

process.on("uncaughtException", (error) => sendFatal(error));
process.on("unhandledRejection", (error) => sendFatal(error));

process.on("SIGTERM", () => {
	abortRequested = true;
	settlePermissions(false, "The worker process is shutting down.");
	if (running && session) {
		void session
			.abort()
			.catch(() => undefined)
			.finally(() => setTimeout(() => process.exit(0), 100));
		setTimeout(() => process.exit(0), 1_500).unref?.();
	} else {
		cleanup();
		process.exit(0);
	}
});

process.on("disconnect", () => {
	abortRequested = true;
	settlePermissions(false, "The parent session disconnected.");
	void session?.abort().catch(() => undefined);
	setTimeout(() => process.exit(0), 400).unref?.();
});

if (!process.send) {
	process.stderr.write("flintcode agent worker: IPC channel is missing\n");
	process.exit(2);
}
