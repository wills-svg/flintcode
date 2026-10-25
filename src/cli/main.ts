import { runPrintMode, runRpcMode } from "@earendil-works/pi-coding-agent";
import { parseArgs, type CliArgs } from "./args.js";
import { bootstrap } from "./bootstrap.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runModelsCommand } from "./models.js";
import {
	runAuthCommand,
	runLoginCommand,
	runLogoutCommand,
	runManagedModelsCommand,
	runProvidersCommand,
	runUseCommand,
} from "./providers.js";
import { runPluginsCommand } from "./plugins.js";
import { runSessionsCommand } from "./sessions.js";
import { runTrustCommand } from "./trust-cmd.js";
import {
	runAgentsCommand,
	runConfigCommand,
	runCronCommand,
	runHooksCommand,
	runMcpCommand,
	runSkillsCommand,
	runWorktreeCommand,
} from "./resources.js";
import { runFetchCommand, runSearchCommand } from "./search.js";
import { runDocsCommand } from "./docs.js";
import { createWorktree } from "../core/worktrees.js";
import { createFlintcodePaths, resolveFlintcodeHome } from "../core/paths.js";
import { loadFlintcodeConfig } from "../core/config.js";
import { commandHelp, formatVersion, generalHelp } from "./help.js";
import { createFlintcodeSessionHost, type SessionSelection } from "../core/session-host.js";
import { PermissionEngine } from "../core/permissions.js";
import { PlanController } from "../core/plan.js";
import { SessionLock } from "../core/session-lock.js";
import { createFlintcodeExtensions } from "../extensions/index.js";
import { loadHooksFile } from "../core/config.js";
import { HookRunner } from "../core/hooks.js";
import { MemoryService } from "../core/memory.js";
import { GoalService } from "../core/goals.js";
import { parseThinkingLevel, formatThinkingLevels } from "../core/models.js";
import { discoverAgents } from "../core/agent-runner.js";
import { oneLine } from "../util/format.js";
import type { PermissionMode } from "../core/types.js";

async function readStdinIfPiped(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text || undefined;
}

function selectionFromArgs(args: CliArgs): SessionSelection {
	return {
		resume: args.resume,
		continue: args.continue,
		fork: args.fork,
		sessionId: args.sessionId,
		noSession: args.noSession,
	};
}

function applyCliOverrides(args: CliArgs, config: { permissions: { mode: PermissionMode } }): void {
	if (args.permissionMode) config.permissions.mode = args.permissionMode;
}

async function runNonInteractive(args: CliArgs): Promise<number> {
	const boot = await bootstrap(args, { interactive: false });
	applyCliOverrides(args, boot.config);
	const thinking = args.thinking ? parseThinkingLevel(args.thinking) : undefined;
	if (args.thinking && !thinking) {
		throw new Error(`Invalid thinking level "${args.thinking}". Use one of: ${formatThinkingLevels()}`);
	}
	const cliAgent = args.agent
		? (
				await discoverAgents({
					paths: boot.paths,
					config: boot.config,
					cwd: args.cwd,
					projectTrusted: boot.trust.trusted,
				})
			).find((agent) => agent.name.toLowerCase() === args.agent!.toLowerCase())
		: undefined;
	if (args.agent && !cliAgent) throw new Error(`No agent named "${args.agent}". Run \`flintcode agents\`.`);
	const cliThinking = thinking ?? (cliAgent?.thinking ? parseThinkingLevel(cliAgent.thinking) : undefined);
	const promptAdditions = [
		...(cliAgent ? [cliAgent.systemPrompt] : []),
		...args.appendSystemPrompt,
		...(args.addDirs.length
			? [`Additional directories available by absolute path:\n${args.addDirs.map((dir) => `- ${dir}`).join("\n")}`]
			: []),
	];
	const cliRules = [
		...boot.config.permissions.rules,
		...args.allowedTools.map((tool, index) => ({
			id: `cli-allow-${index + 1}`,
			match: { tools: [tool] },
			action: "allow" as const,
		})),
	];
	const permissionEngine = new PermissionEngine({
		cwd: args.cwd,
		mode: boot.config.permissions.mode,
		rules: cliRules,
		interactive: false,
		protectSecrets: boot.config.permissions.protectSecrets,
	});
	const planController = new PlanController(permissionEngine);
	const memory = new MemoryService(boot.paths, args.cwd);
	const goals = new GoalService(boot.paths, args.cwd);
	const hooksData = await loadHooksFile(boot.paths);
	for (const warning of hooksData.warnings) boot.logger.warn(warning);
	const hooksRunner = boot.config.hooks.enabled
		? new HookRunner({
				hooks: hooksData.hooks,
				cwd: args.cwd,
				timeoutMs: boot.config.hooks.timeoutMs,
			})
		: undefined;
	if (hooksRunner) {
		permissionEngine.setPermissionHook(async (request) => {
			const result = await hooksRunner.run("PermissionRequest", {
				toolName: request.toolName,
				target: request.target,
				mode: request.mode,
				input: request.input,
			});
			if (result.decision === "allow") return { decision: "allow" };
			if (result.blocked || result.decision === "deny") {
				return { decision: "deny", reason: result.reason };
			}
			return undefined;
		});
	}
	const host = await createFlintcodeSessionHost({
		cwd: args.cwd,
		paths: boot.paths,
		config: boot.config,
		modelRuntime: boot.modelRuntime,
		selection: selectionFromArgs(args),
		projectTrusted: boot.trust.trusted,
		extensionFactories: createFlintcodeExtensions({
			paths: boot.paths,
			config: boot.config,
			cwd: args.cwd,
			projectTrusted: boot.trust.trusted,
			modelRuntime: boot.modelRuntime,
			permissionEngine,
			planController,
			memory,
			goals,
			...(hooksRunner ? { hooks: hooksRunner } : {}),
		}),
		...((args.tools ?? cliAgent?.tools) ? { tools: args.tools ?? cliAgent?.tools } : {}),
		...(args.disallowedTools.length ? { excludedTools: args.disallowedTools } : {}),
		...((args.model ?? cliAgent?.model) ? { modelSpec: args.model ?? cliAgent?.model } : {}),
		...(cliThinking ? { thinkingLevel: cliThinking } : {}),
		...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
		...(promptAdditions.length ? { appendSystemPrompt: promptAdditions } : {}),
		logger: boot.logger,
	});
	planController.attachSession(host.runtime.session);
	const sessionLock = new SessionLock(boot.paths.stateDir);
	let ownsHost = true;
	try {
		if (host.runtime.session.sessionManager.getSessionFile?.()) {
			await sessionLock.acquire(host.runtime.session.sessionId, args.cwd);
		}
		if (args.sessionName) host.runtime.session.setSessionName(args.sessionName);
		if (args.mode === "rpc") {
			ownsHost = false;
			await runRpcMode(host.runtime);
			return 0;
		}
		const prompt = args.prompt ?? (await readStdinIfPiped());
		if (!prompt) {
			console.log(generalHelp());
			return 1;
		}
		if (boot.trust.hasResources && !boot.trust.trusted) {
			console.error("flintcode: warning: project resources are untrusted; tools still run with your OS permissions.");
		}
		// runPrintMode owns and disposes the runtime in its own finally block.
		ownsHost = false;
		const exitCode = await runPrintMode(host.runtime, {
			mode: args.mode === "json" ? "json" : "text",
			initialMessage: prompt,
			...(args.attachments.length
				? {
						messages: [
							`Attached files:\n${args.attachments.map((file) => `- ${file}`).join("\n")}`,
						],
					}
				: {}),
		});
		return exitCode;
	} finally {
		await sessionLock.release();
		if (ownsHost) await host.dispose();
	}
}

async function runInteractive(args: CliArgs): Promise<number> {
	const { runTui } = await import("../tui/app.js");
	return runTui(args);
}

async function runPrintCommand(args: CliArgs): Promise<number> {
	const parsed = parseArgs(args.commandArgs);
	if (parsed.errors.length) {
		for (const error of parsed.errors) console.error(`flintcode: ${error}`);
		return 2;
	}
	parsed.args.cwd = args.cwd;
	parsed.args.configDir = args.configDir;
	parsed.args.debug = args.debug;
	parsed.args.mode = "print";
	return runNonInteractive(parsed.args);
}

async function runCommand(args: CliArgs): Promise<number | undefined> {
	switch (args.command) {
		case "init":
			return runInit(args);
		case "doctor":
			return runDoctor(args);
		case "models": {
			const sub = args.commandArgs[0];
			if (sub === "add" || sub === "remove" || sub === "rm" || sub === "alias") {
				return runManagedModelsCommand(args, sub);
			}
			return runModelsCommand(args);
		}
		case "providers":
			return runProvidersCommand(args);
		case "auth":
			return runAuthCommand(args);
		case "login":
			return runLoginCommand(args);
		case "logout":
			return runLogoutCommand(args);
		case "use":
			return runUseCommand(args);
		case "plugins":
			return runPluginsCommand(args);
		case "sessions":
			return runSessionsCommand(args);
		case "trust":
			return runTrustCommand(args);
		case "skills":
			return runSkillsCommand(args);
		case "agents":
			return runAgentsCommand(args);
		case "hooks":
			return runHooksCommand(args);
		case "mcp":
			return runMcpCommand(args);
		case "worktree":
			return runWorktreeCommand(args);
		case "cron":
			return runCronCommand(args);
		case "config":
			return runConfigCommand(args);
		case "search":
			return runSearchCommand(args);
		case "fetch":
			return runFetchCommand(args);
		case "docs":
			return runDocsCommand(args);
		case "help":
			console.log(args.commandArgs[0] ? commandHelp(args.commandArgs[0]) : generalHelp());
			return 0;
		case "version":
			console.log(formatVersion());
			return 0;
		case "print":
			return runPrintCommand(args);
		default:
			return undefined;
	}
}

async function prepareWorktree(args: CliArgs): Promise<void> {
	if (!args.worktree || args.command) return;
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	const loaded = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: false });
	const created = await createWorktree({
		cwd: args.cwd,
		root: loaded.config.worktrees.root,
		...(typeof args.worktree === "string" ? { name: args.worktree } : {}),
	});
	console.error(`flintcode: worktree ${created.path} (${created.branch})`);
	args.cwd = created.path;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const parsed = parseArgs(argv);
	const args = parsed.args;
	if (parsed.errors.length) {
		for (const error of parsed.errors) console.error(`flintcode: ${error}`);
		console.error("Run `flintcode --help` for usage.");
		return 2;
	}
	if (args.help) {
		console.log(args.command ? commandHelp(args.command) : generalHelp());
		return 0;
	}
	if (args.version) {
		console.log(formatVersion());
		return 0;
	}
	try {
		await prepareWorktree(args);
		const commandResult = await runCommand(args);
		if (commandResult !== undefined) return commandResult;
		if (args.mode === "interactive") return runInteractive(args);
		return runNonInteractive(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`flintcode: ${oneLine(message)}`);
		if (args.debug && error instanceof Error && error.stack) console.error(error.stack);
		return 1;
	}
}
