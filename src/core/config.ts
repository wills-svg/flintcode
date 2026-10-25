import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDir, pathExists, readJsonResult, writeJsonAtomic } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import type { FlintcodeConfig, PermissionMode, PermissionRule, HookConfig } from "./types.js";
import type { FlintcodePaths } from "./paths.js";
import { expandHome } from "./paths.js";

export const PERMISSION_MODES: PermissionMode[] = [
	"default",
	"accept-edits",
	"auto",
	"dont-ask",
	"yolo",
];

export function defaultConfig(piAgentDir = "~/.pi/agent"): FlintcodeConfig {
	return {
		version: 1,
		defaults: {
			provider: "",
			model: "",
			thinking: "medium",
		},
		compat: {
			piAgentDir,
			piAuth: true,
			piModels: true,
			piSkills: true,
			piAgents: true,
			piPrompts: true,
			piInstructions: true,
			piExtensions: [],
		},
		ui: {
			theme: "flintcode",
			tuiMode: "fullscreen",
			hideThinking: false,
			inlineThinkingMode: "compact",
			outputStyle: "default",
			transcriptBlocks: 800,
			historyMessages: 400,
			toolOutputChars: 32_000,
			statusline: {
				segments: ["mode", "cwd", "git", "model", "thinking", "ctx", "cost", "bg", "todos"],
				separator: "  ",
			},
		},
		permissions: {
			mode: "default",
			rules: [],
			approvalTimeoutSeconds: 900,
			protectSecrets: true,
		},
		agents: {
			maxDepth: 2,
			maxConcurrent: 4,
			maxDurationSeconds: 240,
			maxToolCalls: 40,
			maxToolOutputChars: 24_000,
			workerHeapMb: 256,
			workerStartupSeconds: 45,
		},
		hooks: {
			enabled: true,
			timeoutMs: 10_000,
		},
		loops: {
			minIntervalMs: 30_000,
			maxIterations: 100,
		},
		worktrees: {
			root: "~/.flintcode/worktrees",
		},
		web: {
			enabled: true,
			searchCommand: "",
			maxResults: 8,
		},
	};
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, ...layers: unknown[]): T {
	let result: unknown = Array.isArray(base) ? [...base] : isRecord(base) ? { ...base } : base;
	for (const layer of layers) {
		result = mergeInto(result, layer);
	}
	return result as T;
}

function mergeInto(base: unknown, layer: unknown): unknown {
	if (!isRecord(layer)) {
		if (Array.isArray(layer)) return [...layer];
		return layer === undefined ? base : layer;
	}
	const output: JsonObject = isRecord(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(layer)) {
		if (isRecord(value)) {
			output[key] = mergeInto(output[key], value);
		} else if (Array.isArray(value)) {
			output[key] = [...value];
		} else if (value !== undefined) {
			output[key] = value;
		}
	}
	return output;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeRule(value: unknown): PermissionRule | undefined {
	if (!isRecord(value)) return undefined;
	const action = value.action;
	if (action !== "allow" && action !== "ask" && action !== "deny") return undefined;
	const match = isRecord(value.match) ? value.match : {};
	const list = (input: unknown): string[] | undefined =>
		Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : undefined;
	const normalized: PermissionRule = {
		id: asString(value.id, `rule-${Math.random().toString(36).slice(2, 10)}`),
		match: {
			tools: list(match.tools),
			paths: list(match.paths),
			commands: list(match.commands),
			mcpServers: list(match.mcpServers),
		},
		action,
	};
	const scope = value.scope;
	if (scope === "user" || scope === "project" || scope === "session") normalized.scope = scope;
	if (typeof value.reason === "string") normalized.reason = value.reason;
	return normalized;
}

export function normalizeConfig(raw: unknown, fallback = defaultConfig()): FlintcodeConfig {
	const merged = deepMerge(fallback, raw);
	const config = merged as FlintcodeConfig;
	config.version = 1;
	config.defaults.provider = asString(merged.defaults?.provider, fallback.defaults.provider);
	config.defaults.model = asString(merged.defaults?.model, fallback.defaults.model);
	config.defaults.thinking = asString(merged.defaults?.thinking, fallback.defaults.thinking);
	config.compat.piAgentDir = expandHome(asString(merged.compat?.piAgentDir, fallback.compat.piAgentDir));
	config.compat.piAuth = asBoolean(merged.compat?.piAuth, fallback.compat.piAuth);
	config.compat.piModels = asBoolean(merged.compat?.piModels, fallback.compat.piModels);
	config.compat.piSkills = asBoolean(merged.compat?.piSkills, fallback.compat.piSkills);
	config.compat.piAgents = asBoolean(merged.compat?.piAgents, fallback.compat.piAgents);
	config.compat.piPrompts = asBoolean(merged.compat?.piPrompts, fallback.compat.piPrompts);
	config.compat.piInstructions = asBoolean(merged.compat?.piInstructions, fallback.compat.piInstructions);
	config.compat.piExtensions = Array.isArray(merged.compat?.piExtensions)
		? merged.compat.piExtensions.filter((entry): entry is string => typeof entry === "string")
		: fallback.compat.piExtensions;
	config.ui.theme = asString(merged.ui?.theme, fallback.ui.theme);
	config.ui.tuiMode = merged.ui?.tuiMode === "inline" ? "inline" : "fullscreen";
	config.ui.hideThinking = asBoolean(merged.ui?.hideThinking, fallback.ui.hideThinking);
	config.ui.inlineThinkingMode =
		merged.ui?.inlineThinkingMode === "full" ||
		merged.ui?.inlineThinkingMode === "compact" ||
		merged.ui?.inlineThinkingMode === "hidden"
			? merged.ui.inlineThinkingMode
			: fallback.ui.inlineThinkingMode;
	config.ui.outputStyle = asString(merged.ui?.outputStyle, fallback.ui.outputStyle);
	config.ui.transcriptBlocks = clamp(
		asNumber(merged.ui?.transcriptBlocks, fallback.ui.transcriptBlocks),
		100,
		5_000,
	);
	config.ui.historyMessages = clamp(
		asNumber(merged.ui?.historyMessages, fallback.ui.historyMessages),
		40,
		5_000,
	);
	config.ui.toolOutputChars = clamp(
		asNumber(merged.ui?.toolOutputChars, fallback.ui.toolOutputChars),
		2_000,
		200_000,
	);
	const statusline: JsonObject = isRecord(merged.ui?.statusline) ? merged.ui.statusline : {};
	config.ui.statusline = {
		segments: Array.isArray(statusline.segments)
			? statusline.segments.filter((entry): entry is string => typeof entry === "string")
			: fallback.ui.statusline.segments,
		separator: asString(statusline.separator, fallback.ui.statusline.separator),
		...(typeof statusline.command === "string" ? { command: statusline.command } : {}),
	};
	config.permissions.mode = PERMISSION_MODES.includes(merged.permissions?.mode as PermissionMode)
		? (merged.permissions.mode as PermissionMode)
		: fallback.permissions.mode;
	config.permissions.rules = Array.isArray(merged.permissions?.rules)
		? merged.permissions.rules
				.map(normalizeRule)
				.filter((entry): entry is PermissionRule => entry !== undefined)
		: fallback.permissions.rules;
	config.permissions.approvalTimeoutSeconds = clamp(
		asNumber(merged.permissions?.approvalTimeoutSeconds, fallback.permissions.approvalTimeoutSeconds),
		30,
		7_200,
	);
	config.permissions.protectSecrets = asBoolean(
		merged.permissions?.protectSecrets,
		fallback.permissions.protectSecrets,
	);
	config.agents.maxDepth = clamp(asNumber(merged.agents?.maxDepth, fallback.agents.maxDepth), 1, 4);
	config.agents.maxConcurrent = clamp(
		asNumber(merged.agents?.maxConcurrent, fallback.agents.maxConcurrent),
		1,
		8,
	);
	config.agents.maxDurationSeconds = clamp(
		asNumber(merged.agents?.maxDurationSeconds, fallback.agents.maxDurationSeconds),
		30,
		3_600,
	);
	config.agents.maxToolCalls = clamp(
		asNumber(merged.agents?.maxToolCalls, fallback.agents.maxToolCalls),
		1,
		200,
	);
	config.agents.maxToolOutputChars = clamp(
		asNumber(merged.agents?.maxToolOutputChars, fallback.agents.maxToolOutputChars),
		2_000,
		200_000,
	);
	config.agents.workerHeapMb = clamp(
		asNumber(merged.agents?.workerHeapMb, fallback.agents.workerHeapMb),
		96,
		1_536,
	);
	config.agents.workerStartupSeconds = clamp(
		asNumber(merged.agents?.workerStartupSeconds, fallback.agents.workerStartupSeconds),
		10,
		300,
	);
	config.hooks.enabled = asBoolean(merged.hooks?.enabled, fallback.hooks.enabled);
	config.hooks.timeoutMs = clamp(asNumber(merged.hooks?.timeoutMs, fallback.hooks.timeoutMs), 500, 300_000);
	config.loops.minIntervalMs = clamp(
		asNumber(merged.loops?.minIntervalMs, fallback.loops.minIntervalMs),
		5_000,
		24 * 60 * 60_000,
	);
	config.loops.maxIterations = clamp(
		asNumber(merged.loops?.maxIterations, fallback.loops.maxIterations),
		1,
		10_000,
	);
	config.worktrees.root = expandHome(
		asString(merged.worktrees?.root, fallback.worktrees.root),
	);
	config.web.enabled = asBoolean(merged.web?.enabled, fallback.web.enabled);
	config.web.searchCommand = asString(merged.web?.searchCommand, fallback.web.searchCommand);
	config.web.maxResults = clamp(asNumber(merged.web?.maxResults, fallback.web.maxResults), 1, 20);
	return config;
}

export interface LoadedConfig {
	config: FlintcodeConfig;
	warnings: string[];
	sources: string[];
	projectTrusted: boolean;
}

async function resolveUserConfigFile(paths: FlintcodePaths): Promise<{ file: string; legacy: boolean }> {
	if (await pathExists(paths.configFile)) return { file: paths.configFile, legacy: false };
	const legacy = path.join(path.dirname(paths.configFile), "tau.json");
	if (await pathExists(legacy)) return { file: legacy, legacy: true };
	return { file: paths.configFile, legacy: false };
}

async function resolveProjectConfigFile(paths: FlintcodePaths): Promise<{ file: string; legacy: boolean }> {
	if (await pathExists(paths.projectConfigFile)) return { file: paths.projectConfigFile, legacy: false };
	const legacy = path.join(paths.projectFlintcodeDir, "tau.json");
	if (await pathExists(legacy)) return { file: legacy, legacy: true };
	return { file: paths.projectConfigFile, legacy: false };
}

export async function loadFlintcodeConfig(
	paths: FlintcodePaths,
	cwd: string,
	options?: { projectTrusted?: boolean; fallback?: FlintcodeConfig },
): Promise<LoadedConfig> {
	const warnings: string[] = [];
	const sources: string[] = [];
	const fallback = options?.fallback ?? defaultConfig(paths.piAgentDir);
	const userSource = await resolveUserConfigFile(paths);
	const userResult = await readJsonResult<unknown>(userSource.file, {});
	if (userResult.error) warnings.push(userResult.error);
	let userConfig: unknown = userResult.value;
	if (userResult.exists) {
		if (!isRecord(userConfig)) {
			warnings.push(`${userSource.file} does not contain a JSON object; using defaults.`);
			userConfig = {};
		}
		if (userSource.legacy) {
			warnings.push(
				`Using legacy config ${userSource.file}; it is migrated to ${paths.configFile} on the next write.`,
			);
		}
		sources.push(userSource.file);
	}
	let projectConfig: unknown = {};
	const projectTrusted = options?.projectTrusted ?? false;
	const projectSource = await resolveProjectConfigFile(paths);
	if (await pathExists(projectSource.file)) {
		if (projectTrusted) {
			const projectResult = await readJsonResult<unknown>(projectSource.file, {});
			if (projectResult.error) warnings.push(projectResult.error);
			if (isRecord(projectResult.value)) {
				projectConfig = projectResult.value;
				sources.push(projectSource.file);
				if (projectSource.legacy) {
					warnings.push(
						`Using legacy project config ${projectSource.file}; rename it to ${paths.projectConfigFile} when convenient.`,
					);
				}
			} else if (projectResult.exists) {
				warnings.push(`${projectSource.file} does not contain a JSON object; ignored.`);
			}
		} else {
			warnings.push(
				`Project config ${projectSource.file} was not loaded because the project is not trusted.`,
			);
		}
	}
	const config = normalizeConfig(mergeInto(userConfig, projectConfig), fallback);
	return { config, warnings, sources, projectTrusted };
}

export async function saveFlintcodeConfig(paths: FlintcodePaths, config: FlintcodeConfig): Promise<void> {
	await writeJsonAtomic(paths.configFile, config);
}

/**
 * Read-modify-write of the user config under a cross-process lock. Only the
 * user file is edited: project overrides are never copied into it, and a stale
 * TUI session cannot clobber fields another process wrote.
 */
export async function patchFlintcodeConfig(
	paths: FlintcodePaths,
	mutate: (config: FlintcodeConfig) => void | Promise<void>,
	options?: { fallback?: FlintcodeConfig; timeoutMs?: number },
): Promise<FlintcodeConfig> {
	return withFileLock(
		paths.configFile,
		async () => {
			const fallback = options?.fallback ?? defaultConfig(paths.piAgentDir);
			const source = await resolveUserConfigFile(paths);
			const result = await readJsonResult<unknown>(source.file, {});
			const raw = isRecord(result.value) ? result.value : {};
			const config = normalizeConfig(raw, fallback);
			await mutate(config);
			await writeJsonAtomic(paths.configFile, config);
			return config;
		},
		{ timeoutMs: options?.timeoutMs ?? 10_000 },
	);
}

export async function ensureFlintcodeConfig(paths: FlintcodePaths): Promise<{ created: boolean; config: FlintcodeConfig }> {
	await ensureDir(paths.home);
	const source = await resolveUserConfigFile(paths);
	if (!(await pathExists(paths.configFile))) {
		if (source.legacy) {
			const loaded = await loadFlintcodeConfig(paths, process.cwd(), { projectTrusted: false });
			await saveFlintcodeConfig(paths, loaded.config);
			return { created: true, config: loaded.config };
		}
		const config = defaultConfig(paths.piAgentDir);
		await saveFlintcodeConfig(paths, config);
		return { created: true, config };
	}
	const loaded = await loadFlintcodeConfig(paths, process.cwd(), { projectTrusted: false });
	return { created: false, config: loaded.config };
}

export async function loadHooksFile(paths: FlintcodePaths): Promise<{ hooks: HookConfig[]; warnings: string[] }> {
	const warnings: string[] = [];
	const result = await readJsonResult<unknown>(paths.hooksFile, {});
	if (result.error) warnings.push(result.error);
	const raw = result.value;
	if (!isRecord(raw)) return { hooks: [], warnings };
	const entries = Array.isArray(raw.hooks) ? raw.hooks : [];
	const hooks: HookConfig[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.event !== "string") continue;
		const type = entry.type === "prompt" ? "prompt" : "command";
		if (type === "command" && typeof entry.command !== "string") continue;
		if (type === "prompt" && typeof entry.prompt !== "string") continue;
		const matcher = isRecord(entry.matcher)
			? {
					...(typeof entry.matcher.tool === "string" ? { tool: entry.matcher.tool } : {}),
					...(typeof entry.matcher.path === "string" ? { path: entry.matcher.path } : {}),
				}
			: undefined;
		const timeoutMs =
			typeof entry.timeoutMs === "number" && entry.timeoutMs > 0 ? entry.timeoutMs : undefined;
		hooks.push({
			id: typeof entry.id === "string" ? entry.id : `hook-${hooks.length + 1}`,
			event: entry.event as HookConfig["event"],
			enabled: entry.enabled !== false,
			...(matcher ? { matcher } : {}),
			type,
			...(typeof entry.command === "string" ? { command: entry.command } : {}),
			...(typeof entry.prompt === "string" ? { prompt: entry.prompt } : {}),
			...(typeof entry.model === "string" ? { model: entry.model } : {}),
			...(Array.isArray(entry.tools)
				? { tools: entry.tools.filter((tool): tool is string => typeof tool === "string") }
				: {}),
			...(timeoutMs ? { timeoutMs } : {}),
			onError: entry.onError === "deny" ? "deny" : "allow",
		});
	}
	return { hooks, warnings };
}

export async function writeHooksFile(paths: FlintcodePaths, hooks: HookConfig[]): Promise<void> {
	await writeJsonAtomic(paths.hooksFile, { version: 1, hooks });
}

export async function configDirExists(dirPath: string): Promise<boolean> {
	try {
		await fs.access(dirPath);
		return true;
	} catch {
		return false;
	}
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".flintcode", "flintcode.json");
}
