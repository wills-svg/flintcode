import * as path from "node:path";
import { pathExists, readJsonResult, writeJsonAtomic } from "../../util/atomic-json.js";
import type { Logger } from "../../util/logger.js";
import type { FlintcodePaths } from "../paths.js";
import { GATEWAY_KEY_ENV, gatewayModels, loadProviderRegistry } from "./store.js";
import { startProviderGateway, type ProviderGateway } from "./gateway.js";

interface PiModelsFile {
	$schema?: string;
	providers?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ProviderRuntime {
	gateway?: ProviderGateway;
	modelsFile: string;
	modelCount: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function gatewayModelConfig(model: {
	id: string;
	name?: string;
	contextWindow?: number;
	vision?: boolean;
	reasoning?: boolean;
}): Record<string, unknown> {
	return {
		id: model.id,
		name: model.name ?? model.id,
		contextWindow: model.contextWindow ?? 128_000,
		input: model.vision ? ["text", "image"] : ["text"],
		reasoning: model.reasoning ?? false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export async function prepareProviderRuntime(
	paths: FlintcodePaths,
	logger?: Logger,
): Promise<ProviderRuntime> {
	const registry = await loadProviderRegistry(paths);
	const managed = gatewayModels(registry);
	const gateway = await startProviderGateway(paths, { ...(logger ? { logger } : {}) });
	if (gateway) process.env[GATEWAY_KEY_ENV] = gateway.token;

	const piResult = await readJsonResult<unknown>(paths.piModelsFile, {});
	if (piResult.error) logger?.warn("pi models.json could not be read", { error: piResult.error });
	const piModels = piResult.exists && !piResult.error ? (asObject(piResult.value) as PiModelsFile | undefined) : undefined;

	const flintcodeResult = await readJsonResult<unknown>(paths.modelsFile, {});
	if (flintcodeResult.error) logger?.warn("generated models.json could not be read", { error: flintcodeResult.error });
	const flintcodeModels =
		flintcodeResult.exists && !flintcodeResult.error
			? (asObject(flintcodeResult.value) as PiModelsFile | undefined)
			: undefined;

	const providers: Record<string, unknown> = { ...(asObject(piModels?.providers) ?? {}) };
	for (const [id, provider] of Object.entries(asObject(flintcodeModels?.providers) ?? {})) {
		if (id !== "flintcode") providers[id] = provider;
	}
	if (gateway) {
		providers.flintcode = {
			baseUrl: `${gateway.url}/v1`,
			api: "openai-completions",
			apiKey: `$${GATEWAY_KEY_ENV}`,
			models: managed.map((entry) => gatewayModelConfig({ ...entry.model, id: entry.key })),
		};
	}
	const merged: PiModelsFile = {
		$schema: piModels?.$schema ?? "https://pi.dev/schemas/models.schema.json",
		...piModels,
		providers,
	};
	await writeJsonAtomic(paths.modelsFile, merged, { mode: 0o600 });
	logger?.debug("provider runtime ready", {
		gateway: gateway ? gateway.url : "disabled",
		managedModels: managed.length,
	});
	return { ...(gateway ? { gateway } : {}), modelsFile: paths.modelsFile, modelCount: managed.length };
}

export async function modelsFileExists(paths: FlintcodePaths): Promise<boolean> {
	return pathExists(path.join(paths.home, "models.json"));
}
