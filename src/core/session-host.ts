import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type InlineExtension,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import { pathExists } from "../util/atomic-json.js";
import type { FlintcodeConfig } from "./types.js";
import type { FlintcodePaths } from "./paths.js";
import {
	clampThinkingLevel,
	modelKey,
	parseThinkingLevel,
	resolveFlintcodeModel,
	supportedThinkingLevels,
	type ResolvedModel,
} from "./models.js";

export interface SessionSelection {
	resume?: string | true;
	continue?: boolean;
	fork?: boolean;
	sessionId?: string;
	noSession?: boolean;
}

export interface HostOptions {
	cwd: string;
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	modelRuntime: ModelRuntime;
	selection: SessionSelection;
	projectTrusted: boolean;
	tools?: string[];
	excludedTools?: string[];
	extensionFactories?: InlineExtension[];
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	logger?: Logger;
	modelSpec?: string;
	model?: ResolvedModel;
	thinkingLevel?: ThinkingLevel;
}

export async function createFlintcodeInspectionServices(options: {
	cwd: string;
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	projectTrusted: boolean;
	modelRuntime: ModelRuntime;
}): Promise<AgentSessionServices> {
	const settingsManager = SettingsManager.create(options.cwd, options.paths.home, {
		projectTrusted: options.projectTrusted,
	});
	return createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.paths.home,
		settingsManager,
		modelRuntime: options.modelRuntime,
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: options.config.compat.piExtensions.map((entry) =>
				path.isAbsolute(entry) ? entry : path.resolve(options.paths.home, entry),
			),
		},
		resourceLoaderReloadOptions: {
			resolveProjectTrust: async () => options.projectTrusted,
		},
	});
}

export interface FlintcodeSessionHost {
	runtime: AgentSessionRuntime;
	selection: SessionSelection;
	initialModel: ResolvedModel;
	resumed: boolean;
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	projectTrusted: boolean;
	dispose(): Promise<void>;
}

async function findSessionPath(sessionsDir: string, query: string): Promise<string> {
	if (await pathExists(query)) return path.resolve(query);
	const sessions = await SessionManager.listAll(sessionsDir);
	const exact = sessions.find((session) => session.id === query);
	if (exact) return exact.path;
	const byPrefix = sessions.filter((session) => session.id.startsWith(query));
	if (byPrefix.length === 1) return byPrefix[0].path;
	const byName = sessions.filter((session) =>
		(session.name ?? "").toLowerCase().includes(query.toLowerCase()),
	);
	if (byName.length === 1) return byName[0].path;
	if (byName.length > 1) {
		throw new Error(
			`Session "${query}" is ambiguous: ${byName
				.slice(0, 5)
				.map((session) => `${session.id.slice(0, 8)} (${session.name})`)
				.join(", ")}`,
		);
	}
	throw new Error(`No session matched "${query}". Use \`flintcode sessions\` to list sessions.`);
}

async function selectSessionManager(options: HostOptions): Promise<SessionManager> {
	const { paths, cwd, selection } = options;
	if (selection.noSession) return SessionManager.inMemory(cwd);

	if (typeof selection.resume === "string") {
		const sourcePath = await findSessionPath(paths.sessionsDir, selection.resume);
		if (selection.fork) return SessionManager.forkFrom(sourcePath, cwd, paths.sessionsDir);
		return SessionManager.open(sourcePath, paths.sessionsDir, cwd);
	}

	if (selection.resume === true || selection.continue || selection.fork) {
		const recent = SessionManager.continueRecent(cwd, paths.sessionsDir);
		if (!selection.fork) return recent;
		const recentPath = recent.getSessionFile();
		if (!recentPath) throw new Error("There is no session to fork.");
		return SessionManager.forkFrom(recentPath, cwd, paths.sessionsDir);
	}

	return SessionManager.create(cwd, paths.sessionsDir, {
		...(selection.sessionId ? { id: selection.sessionId } : {}),
	});
}

export async function createFlintcodeSessionHost(options: HostOptions): Promise<FlintcodeSessionHost> {
	const { paths, config, cwd, modelRuntime, selection, projectTrusted, logger } = options;
	let resolvedModel = options.model;
	const sessionManager = await selectSessionManager(options);
	const resumed = sessionManager.getEntries().length > 0;
	const extensionFactories = options.extensionFactories ?? [];

	const piUserSkillPaths = config.compat.piSkills ? [paths.piSkillsDir] : [];
	const piUserPromptPaths = config.compat.piPrompts ? [paths.piPromptsDir] : [];
	const extraExtensionPaths = config.compat.piExtensions.map((entry) =>
		path.isAbsolute(entry) ? entry : path.resolve(paths.home, entry),
	);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: targetCwd,
		agentDir,
		sessionManager: targetManager,
		sessionStartEvent,
	}) => {
		const settingsManager = SettingsManager.create(targetCwd, agentDir, { projectTrusted });
		settingsManager.applyOverrides({
			hideThinkingBlock: config.ui.hideThinking,
			theme: config.ui.theme,
			tuiMode: config.ui.tuiMode === "fullscreen" ? "fullscreen" : "regular",
		});
		const services = await createAgentSessionServices({
			cwd: targetCwd,
			agentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				additionalSkillPaths: [
					paths.skillsDir,
					...(projectTrusted ? [paths.projectSkillsDir] : []),
					...piUserSkillPaths,
				],
				additionalPromptTemplatePaths: [
					paths.promptsDir,
					...(projectTrusted ? [paths.projectPromptsDir] : []),
					...piUserPromptPaths,
				],
				additionalThemePaths: [paths.themesDir],
				additionalExtensionPaths: extraExtensionPaths,
				extensionFactories,
				...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
				...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
				agentsFilesOverride: (base) => {
					const files = [...base.agentsFiles];
					if (
						config.compat.piInstructions &&
						existsSync(paths.piAgentsFile) &&
						!files.some((file) => path.resolve(file.path) === path.resolve(paths.piAgentsFile))
					) {
						files.push({
							path: paths.piAgentsFile,
							content: readFileSync(paths.piAgentsFile, "utf8"),
						});
					}
					return { agentsFiles: files };
				},
			},
			resourceLoaderReloadOptions: {
				resolveProjectTrust: async () => projectTrusted,
			},
		});
		if (!resolvedModel || options.modelSpec) {
			resolvedModel = await resolveFlintcodeModel(services.modelRuntime, config, options.modelSpec);
			if (resolvedModel.note) {
				logger?.info("model selection", {
					note: resolvedModel.note,
					model: `${resolvedModel.model.provider}/${resolvedModel.model.id}`,
				});
			}
		}
		const hasHistory = targetManager.getEntries().length > 0;
		const restoreSessionModel = hasHistory && !options.modelSpec && !options.model;
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: targetManager,
			sessionStartEvent,
			...(restoreSessionModel ? {} : { model: resolvedModel.model as Model<Api> }),
			...(options.tools ? { tools: options.tools } : {}),
			...(options.excludedTools ? { excludeTools: options.excludedTools } : {}),
		});
		const explicitThinking = options.thinkingLevel ?? resolvedModel?.thinkingLevel;
		const configuredThinking =
			!hasHistory && !explicitThinking ? parseThinkingLevel(config.defaults.thinking) : undefined;
		const requestedThinking = explicitThinking ?? configuredThinking;
		if (requestedThinking) {
			const activeModel = (created.session.model as Model<Api> | undefined) ?? resolvedModel.model;
			const supported = supportedThinkingLevels(activeModel);
			if (supported.includes(requestedThinking)) {
				created.session.setThinkingLevel(requestedThinking);
			} else if (explicitThinking) {
				created.session.dispose();
				throw new Error(
					`${modelKey(activeModel)} does not support reasoning "${requestedThinking}". Supported levels: ${supported.join(", ")}.`,
				);
			} else {
				const fallback = clampThinkingLevel(activeModel, requestedThinking);
				created.session.setThinkingLevel(fallback);
				logger?.warn("configured reasoning level clamped to model capabilities", {
					model: modelKey(activeModel),
					requested: requestedThinking,
					fallback,
					supported,
				});
			}
		}
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: paths.home,
		sessionManager,
	});

	const actualModel = (runtime.session.model as Model<Api> | undefined) ?? resolvedModel?.model;
	if (!actualModel) throw new Error("The session was created without a usable model.");
	const initialModel: ResolvedModel = {
		model: actualModel,
		...(resumed ? {} : resolvedModel?.note ? { note: resolvedModel.note } : {}),
	};

	return {
		runtime,
		selection,
		initialModel,
		resumed,
		paths,
		config,
		projectTrusted,
		dispose: async () => {
			await runtime.dispose();
		},
	};
}
