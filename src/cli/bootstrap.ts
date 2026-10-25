import * as fs from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import { createLogger } from "../util/logger.js";
import { ensureFlintcodeLayout, createFlintcodePaths, resolveFlintcodeHome, type FlintcodePaths } from "../core/paths.js";
import {
	ensureFlintcodeConfig,
	loadFlintcodeConfig,
	type LoadedConfig,
} from "../core/config.js";
import { resolveProjectTrust, type TrustResolution } from "../core/trust.js";
import { createFlintcodeModelRuntime, type ModelPaths } from "../core/models.js";
import { prepareProviderRuntime } from "../core/providers/runtime.js";
import type { ProviderGateway } from "../core/providers/gateway.js";
import type { CliArgs } from "./args.js";

export interface BootstrapOptions {
	interactive?: boolean;
	autoInit?: boolean;
	quiet?: boolean;
}

export interface BootstrapResult {
	paths: FlintcodePaths;
	config: LoadedConfig["config"];
	configWarnings: string[];
	configSources: string[];
	trust: TrustResolution;
	modelRuntime: ModelRuntime;
	modelPaths: ModelPaths;
	providerGateway?: ProviderGateway;
	managedModelCount: number;
	logger: Logger;
}

export async function validateWorkingDirectory(cwd: string): Promise<void> {
	const stat = await fs.stat(cwd).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
}

export async function bootstrap(args: CliArgs, options?: BootstrapOptions): Promise<BootstrapResult> {
	await validateWorkingDirectory(args.cwd);
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	let paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	if (options?.autoInit !== false) {
		await ensureFlintcodeConfig(paths);
	}
	const logger = await createLogger(paths.logFile, { debug: args.debug });
	const interactive = options?.interactive ?? false;
	const trust = await resolveProjectTrust({
		cwd: args.cwd,
		paths,
		interactive,
		assumeTrusted: args.trust === true,
		assumeUntrusted: args.trust === false,
		usePiTrustStore: true,
	});
	const loaded = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: trust.trusted });
	if (loaded.config.compat.piAgentDir !== paths.piAgentDir) {
		paths = createFlintcodePaths(home, args.cwd, loaded.config.compat.piAgentDir);
		await ensureFlintcodeLayout(paths);
	}
	let modelRuntime: ModelRuntime;
	let modelPaths: ModelPaths;
	let providerRuntime;
	try {
		providerRuntime = await prepareProviderRuntime(paths, logger);
	} catch (error) {
		throw new Error(
			`Could not prepare provider configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const created = await createFlintcodeModelRuntime(paths, loaded.config);
		modelRuntime = created.runtime;
		modelPaths = created.paths;
	} catch (error) {
		await providerRuntime.gateway?.close();
		throw new Error(
			`Could not load models: ${error instanceof Error ? error.message : String(error)}. Run \`flintcode doctor\` for details.`,
		);
	}
	const warnings = [...loaded.warnings];
	if (!trust.trusted && trust.hasResources) {
		warnings.push(
			`Project resources were not loaded (${trust.reason}). Run \`flintcode trust allow\` to trust this folder.`,
		);
	}
	if (!options?.quiet) {
		for (const warning of warnings) console.error(`flintcode: warning: ${warning}`);
	}
	return {
		paths,
		config: loaded.config,
		configWarnings: loaded.warnings,
		configSources: loaded.sources,
		trust,
		modelRuntime,
		modelPaths,
		...(providerRuntime.gateway ? { providerGateway: providerRuntime.gateway } : {}),
		managedModelCount: providerRuntime.modelCount,
		logger,
	};
}
