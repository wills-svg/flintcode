import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FlintcodeConfig } from "./types.js";
import type { FlintcodePaths } from "./paths.js";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelPaths {
	authPath?: string;
	modelsPath?: string;
	piAuthUsed: boolean;
	piModelsUsed: boolean;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export async function resolveModelPaths(paths: FlintcodePaths, config: FlintcodeConfig): Promise<ModelPaths> {
	const flintcodeAuth = await exists(paths.authFile);
	const flintcodeModels = await exists(paths.modelsFile);
	const piAuth = config.compat.piAuth && (await exists(paths.piAuthFile));
	const piModels = config.compat.piModels && (await exists(paths.piModelsFile));
	return {
		authPath: flintcodeAuth ? paths.authFile : piAuth ? paths.piAuthFile : undefined,
		modelsPath: flintcodeModels ? paths.modelsFile : piModels ? paths.piModelsFile : undefined,
		piAuthUsed: !flintcodeAuth && Boolean(piAuth),
		piModelsUsed: !flintcodeModels && Boolean(piModels),
	};
}

export async function createFlintcodeModelRuntime(
	paths: FlintcodePaths,
	config: FlintcodeConfig,
): Promise<{ runtime: ModelRuntime; paths: ModelPaths }> {
	const modelPaths = await resolveModelPaths(paths, config);
	const runtime = await ModelRuntime.create({
		authPath: modelPaths.authPath,
		modelsPath: modelPaths.modelsPath ?? null,
	});
	return { runtime, paths: modelPaths };
}

export function isFreeModel(model: Model<Api>): boolean {
	const freeFlag = (model as Model<Api> & { free?: unknown }).free;
	if (freeFlag === true) return true;
	const cost = model.cost;
	return Boolean(cost && cost.input === 0 && cost.output === 0);
}

export function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function modelLabel(model: Model<Api>): string {
	const free = isFreeModel(model) ? " (free)" : "";
	return `${model.name || model.id}${free}`;
}

export function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	return THINKING_LEVELS.find((level) => level === normalized);
}

/**
 * Mirror pi's model capability rule exactly:
 * reasoning models get every standard level except xhigh/max unless the model
 * explicitly maps those levels; non-reasoning models only get "off".
 */
export function supportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel(model: Model<Api>, requested: ThinkingLevel): ThinkingLevel {
	const supported = supportedThinkingLevels(model);
	if (supported.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
		const candidate = THINKING_LEVELS[index];
		if (supported.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = THINKING_LEVELS[index];
		if (supported.includes(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}

export function formatThinkingLevels(): string {
	return THINKING_LEVELS.join(", ");
}

function chatModels(runtime: ModelRuntime): Model<Api>[] {
	return runtime.getModels() as Model<Api>[];
}

interface ModelMatch {
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	ambiguous?: Model<Api>[];
}

function matchModelSpec(
	all: readonly Model<Api>[],
	spec: string,
	usable: (provider: string) => boolean,
	allowFuzzy: boolean,
): ModelMatch {
	const text = spec.trim();
	if (!text) return {};
	const exact = (candidate: string) =>
		all.filter((model) => modelKey(model) === candidate || model.id === candidate);
	let candidates = exact(text);
	let thinkingLevel: ThinkingLevel | undefined;
	if (candidates.length === 0) {
		const colon = text.lastIndexOf(":");
		if (colon > 0) {
			const parsed = parseThinkingLevel(text.slice(colon + 1));
			if (parsed) {
				candidates = exact(text.slice(0, colon));
				thinkingLevel = parsed;
			}
		}
	}
	if (candidates.length === 0 && allowFuzzy) {
		const query = text.toLowerCase();
		candidates = all.filter((model) => {
			const key = modelKey(model).toLowerCase();
			return key.includes(query) || model.name.toLowerCase().includes(query);
		});
	}
	if (candidates.length > 1) {
		const authenticated = candidates.filter((model) => usable(model.provider));
		if (authenticated.length > 0) candidates = authenticated;
	}
	if (candidates.length === 1) {
		return { model: candidates[0], thinkingLevel };
	}
	if (candidates.length > 1) {
		return { ambiguous: candidates, thinkingLevel };
	}
	return {};
}

function ambiguousMessage(spec: string, matches: readonly Model<Api>[]): Error {
	const choices = matches
		.slice(0, 8)
		.map((model) => modelKey(model))
		.join(", ");
	return new Error(`Model "${spec}" is ambiguous. Choose one of: ${choices}`);
}

export interface ResolvedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	note?: string;
}

export async function resolveFlintcodeModel(
	runtime: ModelRuntime,
	config: FlintcodeConfig,
	spec?: string,
): Promise<ResolvedModel> {
	const all = chatModels(runtime);
	if (all.length === 0) {
		throw new Error(
			"No models are configured. Add a provider to models.json, set an API key, or run `flintcode init`.",
		);
	}
	const usable = (provider: string) => runtime.hasConfiguredAuth(provider);
	const trySpec = (candidate: string, allowFuzzy: boolean): ResolvedModel | undefined => {
		const match = matchModelSpec(all, candidate, usable, allowFuzzy);
		if (match.model) return { model: match.model, thinkingLevel: match.thinkingLevel };
		if (match.ambiguous) throw ambiguousMessage(candidate, match.ambiguous);
		return undefined;
	};

	if (spec) {
		const resolved = trySpec(spec, true);
		if (resolved) return resolved;
		const candidates = all
			.filter((model) => model.id.toLowerCase().includes(spec.toLowerCase()))
			.slice(0, 8)
			.map(modelKey);
		throw new Error(
			`Model "${spec}" was not found.${candidates.length ? ` Similar: ${candidates.join(", ")}` : ""}`,
		);
	}

	const configured = config.defaults.provider && config.defaults.model
		? trySpec(`${config.defaults.provider}/${config.defaults.model}`, false)
		: undefined;
	if (configured) return configured;
	if (config.defaults.model) {
		const configuredById = trySpec(config.defaults.model, false);
		if (configuredById) return configuredById;
	}

	let available: readonly Model<Api>[] = [];
	try {
		available = await runtime.getAvailableOfType("chat");
	} catch {
		available = [];
	}
	const freeModels = [...available]
		.filter(isFreeModel)
		.sort((left, right) => (right.contextWindow ?? 0) - (left.contextWindow ?? 0));
	const preferredFree =
		freeModels.find((model) => model.provider === "kilo" && model.id === "kilo-auto/free") ??
		freeModels.find(
			(model) =>
				model.provider === "litepod" &&
				model.id.toLowerCase().includes("deepseek") &&
				model.reasoning,
		) ??
		freeModels.find((model) => model.provider === "litepod") ??
		freeModels[0];
	if (preferredFree) {
		return { model: preferredFree, note: "selected an available free model" };
	}
	if (available[0]) return { model: available[0] };

	const callable = all.find((model) => usable(model.provider));
	if (callable) return { model: callable };
	return { model: all[0], note: "no provider authentication was detected" };
}

export interface AvailableModel {
	model: Model<Api>;
	available: boolean;
	free: boolean;
	key: string;
}

export async function listModels(runtime: ModelRuntime): Promise<AvailableModel[]> {
	const all = chatModels(runtime);
	let availableKeys = new Set<string>();
	try {
		const available = await runtime.getAvailableOfType("chat");
		availableKeys = new Set(available.map((model) => `${model.provider}/${model.id}`));
	} catch {
		// Fall back to per-provider auth checks below.
	}
	return all
		.map((model) => {
			const key = modelKey(model);
			return {
				model,
				key,
				free: isFreeModel(model),
				available: availableKeys.has(key) || runtime.hasConfiguredAuth(model.provider),
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveExplicitModel(runtime: ModelRuntime, spec: string): Model<Api> | undefined {
	const all = chatModels(runtime);
	const match = matchModelSpec(all, spec, (provider) => runtime.hasConfiguredAuth(provider), false);
	return match.model;
}

export function modelDirectorySummary(paths: ModelPaths): string {
	const parts: string[] = [];
	if (paths.authPath) parts.push(`auth=${paths.piAuthUsed ? "pi" : "flintcode"}`);
	else parts.push("auth=none");
	if (paths.modelsPath) parts.push(`models=${paths.piModelsUsed ? "pi" : "flintcode"}`);
	else parts.push("models=builtin");
	return parts.join(" ");
}

export function modelDisplayName(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function modelContextWindow(model: Model<Api>): string {
	const window = model.contextWindow;
	if (!window) return "unknown";
	if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(window % 1_000_000 ? 1 : 0)}M`;
	if (window >= 1_000) return `${Math.round(window / 1_000)}k`;
	return String(window);
}

export function resolveModelPathInput(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return path.resolve(value);
}
