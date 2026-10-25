import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome } from "../core/paths.js";
import { loadFlintcodeConfig, loadHooksFile } from "../core/config.js";
import { resolveProjectTrust } from "../core/trust.js";
import { createFlintcodeModelRuntime, listModels, resolveFlintcodeModel, isFreeModel, modelKey } from "../core/models.js";
import { createFlintcodeInspectionServices } from "../core/session-host.js";
import { pathExists } from "../util/atomic-json.js";
import { shortPath, truncateText } from "../util/format.js";
import { VERSION } from "../version.js";
import type { CliArgs } from "./args.js";

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
	section: string;
	status: CheckStatus;
	label: string;
	detail?: string;
}

function compareVersions(current: string, minimum: string): boolean {
	const parse = (value: string) => value.replace(/^v/, "").split(".").map((part) => Number(part));
	const a = parse(current);
	const b = parse(minimum);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left > right) return true;
		if (left < right) return false;
	}
	return true;
}

async function commandExists(command: string): Promise<boolean> {
	const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const entry of pathEntries) {
		const candidate = path.join(entry, command);
		try {
			await fs.access(candidate, constants.X_OK);
			return true;
		} catch {
			// Continue searching.
		}
	}
	return false;
}

async function countFilesRecursive(directory: string, predicate: (name: string) => boolean): Promise<number> {
	let count = 0;
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) count += await countFilesRecursive(fullPath, predicate);
			else if (entry.isFile() && predicate(entry.name)) count += 1;
		}
	} catch {
		// Missing directories count as zero.
	}
	return count;
}

function formatCheck(check: Check): string {
	const marker = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "fail";
	return `  ${marker} ${check.label}${check.detail ? `  ${check.detail}` : ""}`;
}

function printChecks(checks: Check[]): void {
	let section = "";
	for (const check of checks) {
		if (check.section !== section) {
			if (section) console.log("");
			section = check.section;
			console.log(`${section}`);
		}
		console.log(formatCheck(check));
	}
}

export async function runDoctor(args: CliArgs): Promise<number> {
	const json = args.commandArgs.includes("--json");
	const network = args.commandArgs.includes("--network");
	const checks: Check[] = [];
	const add = (section: string, status: CheckStatus, label: string, detail?: string) => {
		checks.push({ section, status, label, ...(detail ? { detail } : {}) });
	};

	const nodeVersion = process.versions.node;
	add(
		"Runtime",
		compareVersions(nodeVersion, "22.19.0") ? "ok" : "fail",
		`Node ${nodeVersion}`,
		`${process.platform}/${process.arch}`,
	);
	if (process.arch === "arm") {
		add("Runtime", "warn", "32-bit ARM detected", "Flintcode supports it, but heavy MCP servers may not.");
	} else {
		add("Runtime", "ok", "Architecture", process.arch);
	}
	add("Runtime", "ok", "Version", `flintcode ${VERSION}`);

	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	try {
		await ensureFlintcodeLayout(paths);
		add("State", "ok", "Flintcode home", shortPath(paths.home));
	} catch (error) {
		add("State", "fail", "Cannot create Flintcode home", error instanceof Error ? error.message : String(error));
	}
	const writeTest = path.join(paths.stateDir, `.doctor-${process.pid}`);
	try {
		await fs.writeFile(writeTest, "ok", { mode: 0o600 });
		await fs.unlink(writeTest);
		add("State", "ok", "State directory is writable");
	} catch (error) {
		add("State", "fail", "State directory is not writable", error instanceof Error ? error.message : String(error));
	}

	const configResult = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: false });
	if (configResult.warnings.length) {
		for (const warning of configResult.warnings) add("Configuration", "warn", warning);
	} else {
		add("Configuration", "ok", "flintcode.json", configResult.sources.length ? shortPath(configResult.sources[0]) : "defaults");
	}
	add("Configuration", "ok", "Permission mode", configResult.config.permissions.mode);
	add("Configuration", "ok", "Agent limits", `depth ${configResult.config.agents.maxDepth}, concurrent ${configResult.config.agents.maxConcurrent}`);

	const trust = await resolveProjectTrust({
		cwd: args.cwd,
		paths,
		interactive: false,
		assumeTrusted: false,
		usePiTrustStore: true,
	});
	add(
		"Project",
		trust.trusted ? "ok" : trust.hasResources ? "warn" : "ok",
		"Project trust",
		trust.hasResources ? `${trust.trusted ? "trusted" : "untrusted"} (${trust.reason})` : "no project resources",
	);
	add(
		"Project",
		configResult.config.compat.piInstructions ? "ok" : "warn",
		"pi instructions",
		configResult.config.compat.piInstructions ? "enabled" : "disabled",
	);
	if (await pathExists(paths.piAgentDir)) {
		add("pi compatibility", "ok", "pi agent directory", shortPath(paths.piAgentDir));
	} else {
		add("pi compatibility", "warn", "pi agent directory missing", shortPath(paths.piAgentDir));
	}

	let modelRuntime: Awaited<ReturnType<typeof createFlintcodeModelRuntime>>["runtime"] | undefined;
	let modelPaths: Awaited<ReturnType<typeof createFlintcodeModelRuntime>>["paths"] | undefined;
	try {
		const created = await createFlintcodeModelRuntime(paths, configResult.config);
		modelRuntime = created.runtime;
		modelPaths = created.paths;
		add(
			"Models",
			"ok",
			"Sources",
			`auth=${modelPaths.authPath ? (modelPaths.piAuthUsed ? "pi" : "flintcode") : "none"}, models=${
				modelPaths.modelsPath ? (modelPaths.piModelsUsed ? "pi" : "flintcode") : "builtin"
			}`,
		);
	} catch (error) {
		add("Models", "fail", "Could not load model runtime", error instanceof Error ? error.message : String(error));
	}
	if (modelRuntime) {
		let activeRuntime = modelRuntime;
		try {
			const services = await createFlintcodeInspectionServices({
				cwd: args.cwd,
				paths,
				config: configResult.config,
				projectTrusted: trust.trusted,
				modelRuntime,
			});
			activeRuntime = services.modelRuntime;
			add("Models", "ok", "Provider extensions loaded");
		} catch (error) {
			add("Models", "warn", "Provider extensions failed", error instanceof Error ? error.message : String(error));
		}
		try {
			const models = await listModels(activeRuntime);
			const available = models.filter((model) => model.available);
			const free = models.filter((model) => model.free);
			add("Models", models.length ? "ok" : "fail", `${models.length} chat models`, `${available.length} available, ${free.length} free`);
			for (const model of available.slice(0, 3)) {
				add("Models", "ok", "Available", `${model.key}${model.free ? " (free)" : ""}`);
			}
			try {
				const selected = await resolveFlintcodeModel(activeRuntime, configResult.config);
				add("Models", "ok", "Default selection", modelKey(selected.model));
			} catch (error) {
				add("Models", "warn", "Default selection failed", error instanceof Error ? error.message : String(error));
			}
			add(
				"Models",
				network ? "warn" : "ok",
				network ? "Live probe not run" : "Network probe skipped",
				network ? "use a session for a live request" : "run a prompt to verify inference",
			);
		} catch (error) {
			add("Models", "warn", "Model inspection failed", error instanceof Error ? error.message : String(error));
		}
	}
	const keyNames = Object.keys(process.env).filter((name) => /_API_KEY$/.test(name));
	if (keyNames.length) add("Credentials", "ok", "Environment keys", keyNames.sort().join(", "));
	else add("Credentials", "warn", "No *_API_KEY environment keys", "stored auth.json credentials still work");

	const hooks = await loadHooksFile(paths);
	if (hooks.warnings.length) {
		for (const warning of hooks.warnings) add("Extensions", "warn", warning);
	}
	add("Extensions", "ok", "Hooks", `${hooks.hooks.filter((hook) => hook.enabled !== false).length} enabled`);
	const skillCount =
		(await countFilesRecursive(paths.skillsDir, (name) => name === "SKILL.md")) +
		(configResult.config.compat.piSkills
			? await countFilesRecursive(paths.piSkillsDir, (name) => name === "SKILL.md")
			: 0);
	add("Extensions", "ok", "Skills", `${skillCount} discovered`);
	const agentCount =
		(await countFilesRecursive(paths.agentsDir, (name) => name.endsWith(".md"))) +
		(configResult.config.compat.piAgents
			? await countFilesRecursive(paths.piAgentsDir, (name) => name.endsWith(".md"))
			: 0);
	add("Extensions", "ok", "Agent definitions", `${agentCount} discovered`);
	if (await pathExists(paths.mcpFile)) add("Extensions", "ok", "MCP config", shortPath(paths.mcpFile));
	else add("Extensions", "ok", "MCP config", "none");

	for (const [label, command] of [
		["git", "git"],
		["ripgrep", "rg"],
		["tmux", "tmux"],
	] as const) {
		const found = await commandExists(command);
		add("Terminal", found ? "ok" : "warn", label, found ? "on PATH" : "not found");
	}
	add(
		"Terminal",
		"ok",
		"Environment",
		[
			`TERM=${process.env.TERM ?? "unset"}`,
			process.env.TMUX ? "tmux" : undefined,
			process.env.TERMUX_VERSION ? `termux ${process.env.TERMUX_VERSION}` : undefined,
			process.stdout.isTTY ? "tty" : "no tty",
		]
			.filter(Boolean)
			.join(", "),
	);

	const failures = checks.filter((check) => check.status === "fail");
	const warnings = checks.filter((check) => check.status === "warn");
	if (json) {
		console.log(
			JSON.stringify(
				{
					version: VERSION,
					node: nodeVersion,
					platform: process.platform,
					arch: process.arch,
					checks,
					summary: { ok: checks.length - failures.length - warnings.length, warnings: warnings.length, failures: failures.length },
				},
				null,
				2,
			),
		);
	} else {
		console.log(`Flintcode doctor ${VERSION}\n`);
		printChecks(checks);
		console.log(
			`\n${checks.length - failures.length - warnings.length} ok, ${warnings.length} warnings, ${failures.length} failures`,
		);
	}
	return failures.length ? 1 : 0;
}
