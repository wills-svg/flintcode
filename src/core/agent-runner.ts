import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, FlintcodeConfig } from "./types.js";
import type { FlintcodePaths } from "./paths.js";
import type { PermissionEngine } from "./permissions.js";
import {
	modelKey,
	parseThinkingLevel,
	resolveFlintcodeModel,
	supportedThinkingLevels,
} from "./models.js";
import { newId } from "../util/ids.js";
import { oneLine, truncateText } from "../util/format.js";
import type { ParentToWorker, WorkerInitMessage, WorkerToParent } from "../agent-worker/protocol.js";
import { isWorkerMessage } from "../agent-worker/protocol.js";

const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general-purpose",
		description: "Full coding agent for research or implementation. Writes and shell commands require approval.",
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
		source: "builtin",
		filePath: "",
		systemPrompt:
			"You are a general-purpose Flintcode subagent. Work autonomously on the task, use the available tools, and return a concise report with findings, changes, and verification. Do not ask the user questions; if blocked, explain exactly what you need.",
	},
	{
		name: "explore",
		description: "Fast read-only codebase reconnaissance; returns compressed context.",
		tools: ["read", "grep", "find", "ls"],
		source: "builtin",
		filePath: "",
		systemPrompt:
			"You are an explore subagent. Investigate quickly and return structured findings: key files with line ranges, relevant types/functions, dependencies, and open questions. Do not modify anything.",
	},
	{
		name: "plan",
		description: "Read-only planning specialist that produces a concrete implementation plan.",
		tools: ["read", "grep", "find", "ls"],
		source: "builtin",
		filePath: "",
		systemPrompt:
			"You are a planning subagent. Research the codebase and return a step-by-step plan with file paths, risks, and verification steps. Do not modify anything.",
	},
	{
		name: "reviewer",
		description: "Read-only reviewer focused on bugs, risks, and missing tests.",
		tools: ["read", "grep", "find", "ls"],
		source: "builtin",
		filePath: "",
		systemPrompt:
			"You are a code reviewer subagent. Focus on concrete defects, regressions, security issues, and missing tests. Cite files and line numbers. Do not make changes.",
	},
];

function agentTools(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim());
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	return undefined;
}

function normalizeAgent(name: string, raw: Record<string, unknown>, body: string, source: AgentDefinition["source"], filePath: string): AgentDefinition | undefined {
	if (!body.trim()) return undefined;
	const tools = agentTools(raw.tools);
	return {
		name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : name,
		description:
			typeof raw.description === "string" && raw.description.trim()
				? raw.description.trim()
				: `Subagent from ${filePath}`,
		...(tools ? { tools } : {}),
		...(typeof raw.model === "string" ? { model: raw.model } : {}),
		...(typeof raw.thinking === "string"
			? { thinking: raw.thinking }
			: typeof raw.reasoning === "string"
				? { thinking: raw.reasoning }
				: {}),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

async function loadAgentDirectory(
	directory: string,
	source: AgentDefinition["source"],
	output: Map<string, AgentDefinition>,
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(directory);
	} catch {
		return;
	}
	entries.sort();
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(directory, entry);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const parsed = parseFrontmatter(content);
			const definition = normalizeAgent(
				entry.replace(/\.md$/, ""),
				parsed.frontmatter,
				parsed.body,
				source,
				filePath,
			);
			if (definition) output.set(definition.name.toLowerCase(), definition);
		} catch {
			// Broken symlinks and unreadable files are skipped.
		}
	}
}

export async function discoverAgents(options: {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	cwd: string;
	projectTrusted: boolean;
}): Promise<AgentDefinition[]> {
	const agents = new Map<string, AgentDefinition>();
	for (const agent of BUILTIN_AGENTS) agents.set(agent.name.toLowerCase(), agent);
	if (options.config.compat.piAgents) {
		await loadAgentDirectory(options.paths.piAgentsDir, "pi", agents);
	}
	await loadAgentDirectory(options.paths.agentsDir, "user", agents);
	if (options.projectTrusted) {
		await loadAgentDirectory(options.paths.projectAgentsDir, "project", agents);
	}
	return [...agents.values()].sort((left, right) => left.name.localeCompare(right.name));
}

class Semaphore {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active += 1;
			return;
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active += 1;
	}

	release(): void {
		this.active = Math.max(0, this.active - 1);
		this.waiting.shift()?.();
	}
}

export interface AgentTaskInput {
	description: string;
	prompt: string;
	agent?: string;
	model?: string;
	thinking?: string;
}

export interface AgentProgress {
	index: number;
	agent: string;
	description: string;
	status: "queued" | "running" | "done" | "error" | "aborted";
	activity: string[];
	latestText: string;
	startedAt: number;
	endedAt?: number;
	model?: string;
	thinking?: string;
}

export interface AgentRunResult {
	id: string;
	description: string;
	agent: string;
	status: "done" | "error" | "aborted";
	output: string;
	error?: string;
	usage?: Usage;
	durationMs: number;
	model?: string;
	thinking?: string;
}

export interface BackgroundAgentRecord {
	id: string;
	description: string;
	agent: string;
	status: "running" | "done" | "error" | "aborted";
	output: string;
	error?: string;
	usage?: Usage;
	durationMs: number;
	startedAt: string;
	endedAt?: string;
	model?: string;
	thinking?: string;
	progress: AgentProgress;
}

export interface AgentRunRecord {
	id: string;
	kind: "foreground" | "background";
	description: string;
	agent: string;
	status: "running" | "done" | "error" | "aborted";
	output: string;
	error?: string;
	usage?: Usage;
	durationMs: number;
	startedAt: string;
	endedAt?: string;
	model?: string;
	thinking?: string;
	progress?: AgentProgress;
}

export interface AgentRunnerOptions {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	cwd: string;
	projectTrusted: boolean;
	modelRuntime: ModelRuntime;
	permissionEngine: PermissionEngine;
	agents: AgentDefinition[];
	notify?: (record: BackgroundAgentRecord) => void;
}

export class AgentRunner {
	private readonly options: AgentRunnerOptions;
	private readonly semaphore: Semaphore;
	private readonly background = new Map<string, BackgroundAgentRecord>();
	private readonly recentRuns: AgentRunRecord[] = [];
	private readonly workers = new Set<ChildProcess>();
	private memoryQueue: Promise<void> = Promise.resolve();
	private reservedMemoryMb = 0;
	private disposed = false;

	constructor(options: AgentRunnerOptions) {
		this.options = options;
		this.semaphore = new Semaphore(options.config.agents.maxConcurrent);
	}

	listAgents(): AgentDefinition[] {
		return [...this.options.agents];
	}

	findAgent(name?: string): AgentDefinition {
		const key = (name ?? "general-purpose").toLowerCase();
		const agent = this.options.agents.find((entry) => entry.name.toLowerCase() === key);
		if (!agent) {
			throw new Error(
				`Unknown agent "${name}". Available: ${this.options.agents.map((entry) => entry.name).join(", ")}`,
			);
		}
		return agent;
	}

	async runTasks(
		tasks: AgentTaskInput[],
		context: {
			parentModel: Model<any> | undefined;
			parentThinking: ThinkingLevel;
			signal?: AbortSignal;
			onProgress?: (progress: AgentProgress[]) => void;
		},
	): Promise<AgentRunResult[]> {
		if (tasks.length === 0) throw new Error("No agent tasks were provided.");
		if (tasks.length > 8) throw new Error("At most 8 agent tasks can run in one call.");
		const progress = tasks.map<AgentProgress>((task, index) => {
			const agent = this.findAgent(task.agent);
			return {
				index,
				agent: agent.name,
				description: task.description,
				status: "queued",
				activity: [],
				latestText: "",
				startedAt: 0,
			};
		});
		const emit = () =>
			context.onProgress?.(
				progress.map((entry) => ({ ...entry, activity: entry.activity.slice(-12) })),
			);
		emit();
		const results = await Promise.all(
			tasks.map(async (task, index) => {
				const result = await this.runOne(task, progress[index], context, emit);
				return result;
			}),
		);
		for (const result of results) this.rememberForeground(result);
		return results;
	}

	startBackground(
		tasks: AgentTaskInput[],
		context: {
			parentModel: Model<any> | undefined;
			parentThinking: ThinkingLevel;
		},
	): BackgroundAgentRecord[] {
		if (tasks.length === 0) throw new Error("No agent tasks were provided.");
		if (tasks.length > 8) throw new Error("At most 8 agent tasks can run in one call.");
		return tasks.map((task) => {
			const agent = this.findAgent(task.agent);
			const id = newId("agent");
			const progress: AgentProgress = {
				index: 0,
				agent: agent.name,
				description: task.description,
				status: "queued",
				activity: [],
				latestText: "",
				startedAt: 0,
			};
			const record: BackgroundAgentRecord = {
				id,
				description: task.description,
				agent: agent.name,
				status: "running",
				output: "",
				durationMs: 0,
				startedAt: new Date().toISOString(),
				progress,
			};
			this.background.set(id, record);
			while (this.background.size > 100) {
				const oldest = this.background.keys().next().value;
				if (oldest === undefined) break;
				this.background.delete(oldest);
			}
			void this.runBackground(id, task, record, context);
			return record;
		});
	}

	listBackground(): BackgroundAgentRecord[] {
		return [...this.background.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
	}

	getBackground(idOrPrefix: string): BackgroundAgentRecord | undefined {
		return this.listBackground().find(
			(record) => record.id === idOrPrefix || record.id.startsWith(idOrPrefix),
		);
	}

	listRuns(): AgentRunRecord[] {
		const background: AgentRunRecord[] = this.listBackground().map((record) => ({
			id: record.id,
			kind: "background",
			description: record.description,
			agent: record.agent,
			status: record.status,
			output: record.output,
			...(record.error ? { error: record.error } : {}),
			...(record.usage ? { usage: record.usage } : {}),
			durationMs: record.durationMs,
			startedAt: record.startedAt,
			...(record.endedAt ? { endedAt: record.endedAt } : {}),
			...(record.model ? { model: record.model } : {}),
			...(record.thinking ? { thinking: record.thinking } : {}),
			progress: record.progress,
		}));
		return [...this.recentRuns, ...background].sort((left, right) =>
			right.startedAt.localeCompare(left.startedAt),
		);
	}

	getRunRecord(idOrPrefix: string): AgentRunRecord | undefined {
		return this.listRuns().find(
			(record) => record.id === idOrPrefix || record.id.startsWith(idOrPrefix),
		);
	}

	private rememberForeground(result: AgentRunResult): void {
		this.recentRuns.push({
			id: result.id,
			kind: "foreground",
			description: result.description,
			agent: result.agent,
			status: result.status,
			output: result.output,
			...(result.error ? { error: result.error } : {}),
			...(result.usage ? { usage: result.usage } : {}),
			durationMs: result.durationMs,
			startedAt: new Date(Date.now() - result.durationMs).toISOString(),
			endedAt: new Date().toISOString(),
			...(result.model ? { model: result.model } : {}),
			...(result.thinking ? { thinking: result.thinking } : {}),
		});
		while (this.recentRuns.length > 100) this.recentRuns.shift();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const worker of this.workers) {
			try {
				worker.send({ type: "abort", reason: "Flintcode is shutting down." } satisfies ParentToWorker);
			} catch {
				// The channel may already be closed.
			}
			try {
				worker.kill("SIGTERM");
			} catch {
				// It may already be gone.
			}
			const hardKill = setTimeout(() => {
				try {
					worker.kill("SIGKILL");
				} catch {
					// Ignore.
				}
			}, 1_500);
			hardKill.unref?.();
		}
		this.workers.clear();
		this.reservedMemoryMb = 0;
	}

	private async runBackground(
		id: string,
		task: AgentTaskInput,
		record: BackgroundAgentRecord,
		context: { parentModel: Model<any> | undefined; parentThinking: ThinkingLevel },
	): Promise<void> {
		const progress = record.progress;
		const emit = () => {
			record.progress = { ...progress, activity: [...progress.activity] };
		};
		const result = await this.runOne(task, progress, context, emit);
		record.status = result.status;
		record.output = result.output;
		record.error = result.error;
		record.usage = result.usage;
		record.durationMs = result.durationMs;
		record.model = result.model;
		record.thinking = result.thinking;
		record.endedAt = new Date().toISOString();
		if (!this.disposed) this.options.notify?.(record);
	}

	private async runOne(
		task: AgentTaskInput,
		progress: AgentProgress,
		context: {
			parentModel: Model<any> | undefined;
			parentThinking: ThinkingLevel;
			signal?: AbortSignal;
			onProgress?: (progress: AgentProgress[]) => void;
		},
		emit: () => void,
	): Promise<AgentRunResult> {
		const started = Date.now();
		const agent = this.findAgent(task.agent);
		let usedModel: Model<any> | undefined;
		let usedThinking: ThinkingLevel | undefined;
		await this.semaphore.acquire();
		try {
			if (context.signal?.aborted) throw new Error("aborted");
			const modelSpec = task.model ?? agent.model;
			const resolved = modelSpec
				? await resolveFlintcodeModel(this.options.modelRuntime, this.options.config, modelSpec)
				: undefined;
			const model = resolved?.model ?? context.parentModel;
			if (!model) throw new Error("No model available for the subagent.");
			usedModel = model;
			const requestedThinking = task.thinking ?? agent.thinking ?? resolved?.thinkingLevel;
			const supported = supportedThinkingLevels(model);
			if (requestedThinking) {
				const parsed = parseThinkingLevel(requestedThinking);
				if (!parsed) {
					throw new Error(
						`Unknown reasoning level "${requestedThinking}". ${modelKey(model)} supports: ${supported.join(", ")}.`,
					);
				}
				if (!supported.includes(parsed)) {
					throw new Error(
						`${modelKey(model)} does not support reasoning "${requestedThinking}". Supported: ${supported.join(", ")}.`,
					);
				}
				usedThinking = parsed;
			} else if (supported.includes(context.parentThinking)) {
				usedThinking = context.parentThinking;
			}
			progress.model = modelKey(model);
			progress.thinking = usedThinking;
			progress.status = "running";
			progress.startedAt = started;
			const addActivity = (line: string) => {
				progress.activity.push(truncateText(line, 240));
				if (progress.activity.length > 120) {
					progress.activity.splice(0, progress.activity.length - 120);
				}
			};
			addActivity(
				`started ${agent.name} · ${modelKey(model)}${usedThinking ? ` · reasoning:${usedThinking}` : ""} · ${oneLine(task.description)}`,
			);
			emit();
			const toolNames = (agent.tools ?? ["read", "grep", "find", "ls"]).filter(
				(name) => name !== "Agent" && name !== "agent_output",
			);
			const outcome = await this.runInWorker({
				task,
				agent,
				model,
				thinking: usedThinking,
				toolNames,
				progress,
				addActivity,
				emit,
				...(context.signal ? { signal: context.signal } : {}),
			});
			const timedOut = outcome.timedOut === true;
			const aborted = outcome.status === "aborted" || context.signal?.aborted === true;
			const baseStatus = timedOut ? "error" : aborted ? "aborted" : outcome.status;
			const maxOutput = this.options.config.agents.maxToolOutputChars;
			const streamedFallback = progress.latestText
				? `[No final assistant report was returned. Recovered the last streamed subagent progress below.]\n\n${progress.latestText}`
				: "";
			const sourceOutput = outcome.output?.trim() || streamedFallback;
			const rawOutput = sourceOutput;
			const output =
				rawOutput.length > maxOutput
					? `${truncateText(rawOutput, maxOutput)}\n\n[subagent output truncated to protect memory]`
					: rawOutput;
			const missingReport = !output && baseStatus === "done";
			const status = missingReport ? "error" : baseStatus;
			const error = timedOut
				? "subagent exceeded its time budget"
				: missingReport
					? "Subagent completed without a recoverable final report."
					: outcome.error;
			progress.status = status;
			progress.endedAt = Date.now();
			addActivity(timedOut ? `stopped after ${this.options.config.agents.maxDurationSeconds}s time budget` : status);
			emit();
			return {
				id: newId("run"),
				description: task.description,
				agent: agent.name,
				status,
				output,
				...(error ? { error } : {}),
				...(outcome.usage ? { usage: outcome.usage } : {}),
				durationMs: Date.now() - started,
				...(progress.model ? { model: progress.model } : {}),
				...(progress.thinking ? { thinking: progress.thinking } : {}),
			};
		} catch (error) {
			const aborted = context.signal?.aborted === true || /aborted/i.test(String(error));
			progress.status = aborted ? "aborted" : "error";
			progress.endedAt = Date.now();
			progress.activity.push(aborted ? "aborted" : "error");
			if (progress.activity.length > 120) progress.activity.splice(0, progress.activity.length - 120);
			progress.model = usedModel ? modelKey(usedModel) : progress.model;
			progress.thinking = usedThinking;
			emit();
			return {
				id: newId("run"),
				description: task.description,
				agent: agent.name,
				status: aborted ? "aborted" : "error",
				output: "",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started,
				...(usedModel ? { model: modelKey(usedModel) } : {}),
				...(usedThinking ? { thinking: usedThinking } : {}),
			};
		} finally {
			this.semaphore.release();
		}
	}

	private async reserveWorkerMemory(
		signal: AbortSignal | undefined,
		heapMb: number,
		onWait: (line: string) => void,
	): Promise<(() => void) | undefined> {
		let releaseLock!: () => void;
		const previous = this.memoryQueue;
		this.memoryQueue = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		await previous;
		try {
			const required = this.reservedMemoryMb + heapMb + 96;
			const ready = await waitForMemory(required, signal, onWait);
			if (!ready) return undefined;
			this.reservedMemoryMb += heapMb;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				this.reservedMemoryMb = Math.max(0, this.reservedMemoryMb - heapMb);
			};
		} finally {
			releaseLock();
		}
	}

	private async runInWorker(options: {
		task: AgentTaskInput;
		agent: AgentDefinition;
		model: Model<any>;
		thinking?: ThinkingLevel;
		toolNames: string[];
		progress: AgentProgress;
		addActivity: (line: string) => void;
		emit: () => void;
		signal?: AbortSignal;
	}): Promise<{
		status: "done" | "error" | "aborted";
		output?: string;
		error?: string;
		usage?: Usage;
		timedOut?: boolean;
	}> {
		const started = Date.now();
		const workerHeapMb = this.options.config.agents.workerHeapMb;
		const releaseMemory = await this.reserveWorkerMemory(
			options.signal,
			workerHeapMb,
			(line) => {
				options.addActivity(line);
				options.emit();
			},
		);
		if (!releaseMemory) {
			throw new Error(
				`Not enough free memory to start an isolated subagent (need about ${workerHeapMb + 96} MB). Close other apps or lower agents.workerHeapMb.`,
			);
		}
		const init: WorkerInitMessage = {
			type: "init",
			description: options.task.description,
			prompt: options.task.prompt,
			agent: {
				name: options.agent.name,
				systemPrompt: options.agent.systemPrompt,
				tools: options.toolNames,
			},
			cwd: this.options.cwd,
			paths: this.options.paths,
			config: this.options.config,
			projectTrusted: this.options.projectTrusted,
			model: options.model as unknown,
			modelKey: modelKey(options.model),
			...(options.thinking ? { thinking: options.thinking } : {}),
		};
		const workerPath = fileURLToPath(new URL("../agent-worker/worker.js", import.meta.url));
		const env: NodeJS.ProcessEnv = { ...process.env, FLINTCODE_AGENT_WORKER: "1" };
		delete env.NODE_OPTIONS;
		let worker: ChildProcess;
		try {
			worker = fork(workerPath, [], {
				cwd: this.options.cwd,
				env,
				execArgv: [`--max-old-space-size=${workerHeapMb}`],
				serialization: "json",
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
		} catch (error) {
			releaseMemory();
			throw new Error(
				`Could not start an isolated subagent worker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.workers.add(worker);
		let stderrTail = "";
		worker.stderr?.setEncoding("utf8");
		worker.stderr?.on("data", (chunk: string) => {
			stderrTail = truncateText(`${stderrTail}${chunk}`, 8_000);
		});
		worker.stdout?.resume();

		return new Promise((resolve) => {
			let settled = false;
			let readySeen = false;
			let timedOut = false;
			let startupTimer: NodeJS.Timeout | undefined;
			let runtimeTimer: NodeJS.Timeout | undefined;
			let abortKillTimer: NodeJS.Timeout | undefined;
			let exitKillTimer: NodeJS.Timeout | undefined;

			const sendToWorker = (message: ParentToWorker) => {
				if (settled || !worker.connected) return;
				try {
					worker.send(message);
				} catch {
					// The channel closed between the check and the send.
				}
			};
			const terminate = (hard: boolean) => {
				try {
					worker.kill(hard ? "SIGKILL" : "SIGTERM");
				} catch {
					// It may already be gone.
				}
			};
			const finish = (value: {
				status: "done" | "error" | "aborted";
				output?: string;
				error?: string;
				usage?: Usage;
			}) => {
				if (settled) return;
				settled = true;
				if (startupTimer) clearTimeout(startupTimer);
				if (runtimeTimer) clearTimeout(runtimeTimer);
				if (abortKillTimer) clearTimeout(abortKillTimer);
				this.workers.delete(worker);
				releaseMemory();
				options.signal?.removeEventListener("abort", abortHandler);
				const valueWithTimeout = timedOut
					? { ...value, status: "error" as const, error: "subagent exceeded its time budget" }
					: value;
				resolve({ ...valueWithTimeout, ...(timedOut ? { timedOut: true } : {}) });
				if (!worker.killed) terminate(false);
				exitKillTimer = setTimeout(() => terminate(true), 1_500);
				exitKillTimer.unref?.();
			};
			const fail = (error: string) => {
				const detail = stderrTail.trim() ? `\n${stderrTail.trim()}` : "";
				finish({ status: "error", error: `${error}${detail}` });
			};
			const abortHandler = () => {
				options.addActivity("abort requested");
				options.emit();
				sendToWorker({ type: "abort", reason: "Aborted by the parent." });
				abortKillTimer = setTimeout(() => {
					terminate(true);
					finish({ status: "aborted", error: "aborted" });
				}, 5_000);
				abortKillTimer.unref?.();
			};
			options.signal?.addEventListener("abort", abortHandler, { once: true });

			startupTimer = setTimeout(() => {
				terminate(true);
				fail(
					`Subagent worker did not start within ${this.options.config.agents.workerStartupSeconds}s.`,
				);
			}, this.options.config.agents.workerStartupSeconds * 1_000);
			startupTimer.unref?.();

			worker.on("message", (raw: unknown) => {
				if (!isWorkerMessage(raw)) return;
				const message = raw as WorkerToParent;
				if (message.type === "ready") {
					readySeen = true;
					if (startupTimer) clearTimeout(startupTimer);
					startupTimer = undefined;
					options.addActivity(`worker ready · pid ${message.pid}`);
					options.emit();
					sendToWorker({ type: "run", prompt: options.task.prompt });
					const durationMs = this.options.config.agents.maxDurationSeconds * 1_000;
					runtimeTimer = setTimeout(() => {
						timedOut = true;
						options.addActivity(`stopped after ${Math.round(durationMs / 1_000)}s time budget`);
						options.emit();
						sendToWorker({ type: "abort", reason: "time budget exceeded" });
						const kill = setTimeout(() => {
							terminate(true);
							finish({ status: "error", error: "subagent exceeded its time budget" });
						}, 5_000);
						kill.unref?.();
					}, durationMs);
					runtimeTimer.unref?.();
					return;
				}
				if (message.type === "activity") {
					options.addActivity(message.line);
					options.emit();
					return;
				}
				if (message.type === "text") {
					options.progress.latestText = truncateText(message.text, 600);
					options.emit();
					return;
				}
				if (message.type === "permission_request") {
					void this.options.permissionEngine
						.check(message.toolName, message.input)
						.then((decision) => {
							options.addActivity(
								`permission ${message.toolName} · ${decision.action}${decision.reason ? ` · ${decision.reason}` : ""}`,
							);
							options.emit();
							sendToWorker({
								type: "permission_response",
								id: message.id,
								allow: decision.action === "allow",
								...(decision.reason ? { reason: decision.reason } : {}),
							});
						})
						.catch((error) => {
							sendToWorker({
								type: "permission_response",
								id: message.id,
								allow: false,
								reason: `Permission check failed: ${error instanceof Error ? error.message : String(error)}`,
							});
						});
					return;
				}
				if (message.type === "result") {
					finish({
						status: message.status,
						...(message.output ? { output: message.output } : {}),
						...(message.error ? { error: message.error } : {}),
						...(message.usage ? { usage: message.usage as Usage } : {}),
					});
					return;
				}
				if (message.type === "fatal") {
					fail(`Subagent worker failed: ${message.error}`);
				}
			});

			worker.on("error", (error) => {
				fail(`Subagent worker error: ${error.message}`);
			});
			worker.on("exit", (code, signal) => {
				if (settled) return;
				if (abortKillTimer) clearTimeout(abortKillTimer);
				if (!readySeen) {
					fail(
						`Subagent worker exited before becoming ready (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
					);
					return;
				}
				if (options.signal?.aborted) {
					finish({ status: "aborted", error: "aborted" });
					return;
				}
				fail(
					`Subagent worker exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}) after ${Math.round((Date.now() - started) / 1_000)}s.`,
				);
			});

			sendToWorker(init);
		});
	}
}

async function availableMemoryMb(): Promise<number | undefined> {
	try {
		const text = await fs.readFile("/proc/meminfo", "utf8");
		const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
		if (!match) return undefined;
		return Number(match[1]) / 1024;
	} catch {
		return undefined;
	}
}

async function waitForMemory(
	requiredMb: number,
	signal: AbortSignal | undefined,
	onWait: (line: string) => void,
): Promise<boolean> {
	const deadline = Date.now() + 20_000;
	let warned = false;
	while (!signal?.aborted) {
		const available = await availableMemoryMb();
		if (available === undefined || available >= requiredMb) return true;
		if (Date.now() > deadline) return false;
		if (!warned) {
			warned = true;
			onWait(`waiting for memory · ${Math.round(available)} MB free, need ${requiredMb} MB`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
}

export function formatAgentResults(results: AgentRunResult[]): string {
	const lines: string[] = [];
	for (const result of results) {
		lines.push(`## ${result.description}`);
		lines.push(
			`agent: ${result.agent} · status: ${result.status} · ${(result.durationMs / 1000).toFixed(1)}s` +
				(result.model ? ` · model: ${result.model}` : "") +
				(result.thinking ? ` · reasoning: ${result.thinking}` : ""),
		);
		if (result.usage) {
			lines.push(
				`tokens: ${result.usage.input} in / ${result.usage.output} out · cost: $${result.usage.cost.total.toFixed(4)}`,
			);
		}
		if (result.error) lines.push(`error: ${result.error}`);
		if (result.output) lines.push("", truncateText(result.output, 16_000));
		lines.push("");
	}
	return lines.join("\n").trim();
}

export function sumUsage(results: AgentRunResult[]): Usage | undefined {
	const withUsage = results.filter((result) => result.usage);
	if (withUsage.length === 0) return undefined;
	return withUsage.reduce<Usage>(
		(total, result) => {
			const usage = result.usage!;
			return {
				input: total.input + usage.input,
				output: total.output + usage.output,
				cacheRead: total.cacheRead + usage.cacheRead,
				cacheWrite: total.cacheWrite + usage.cacheWrite,
				totalTokens: total.totalTokens + usage.totalTokens,
				cost: {
					input: total.cost.input + usage.cost.input,
					output: total.cost.output + usage.cost.output,
					cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
					cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
					total: total.cost.total + usage.cost.total,
				},
			};
		},
		{
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	);
}
