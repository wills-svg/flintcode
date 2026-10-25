import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome, type FlintcodePaths } from "../core/paths.js";
import { loadHooksFile, loadFlintcodeConfig } from "../core/config.js";
import type { FlintcodeConfig, HookEvent } from "../core/types.js";
import { resolveProjectTrust } from "../core/trust.js";
import { readJson, writeJsonAtomic, pathExists } from "../util/atomic-json.js";
import { shortPath, oneLine, truncateText } from "../util/format.js";
import { discoverAgents } from "../core/agent-runner.js";
import { HookRunner } from "../core/hooks.js";
import { listWorktrees, createWorktree, removeWorktree, formatWorktrees } from "../core/worktrees.js";
import { formatLoops } from "../core/loops.js";
import type { LoopRecord } from "../core/types.js";
import type { CliArgs } from "./args.js";

interface ResourceContext {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	trusted: boolean;
}

async function resourceContext(args: CliArgs): Promise<ResourceContext> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	let paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const trust = await resolveProjectTrust({
		cwd: args.cwd,
		paths,
		interactive: false,
		assumeTrusted: args.trust === true,
		assumeUntrusted: args.trust === false,
		usePiTrustStore: true,
	});
	const loaded = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: trust.trusted });
	if (loaded.config.compat.piAgentDir !== paths.piAgentDir) {
		paths = createFlintcodePaths(home, args.cwd, loaded.config.compat.piAgentDir);
		await ensureFlintcodeLayout(paths);
	}
	return { paths, config: loaded.config, trusted: trust.trusted };
}

interface SkillInfo {
	name: string;
	description: string;
	path: string;
	source: string;
}

async function findSkills(directory: string, source: string, output: SkillInfo[]): Promise<void> {
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
	if (skillFile) {
		const filePath = path.join(directory, "SKILL.md");
		try {
			const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
			const raw = parsed.frontmatter as { name?: unknown; description?: unknown };
			output.push({
				name:
					typeof raw.name === "string" && raw.name.trim()
						? raw.name.trim()
						: path.basename(directory),
				description:
					typeof raw.description === "string" ? raw.description : "(no description)",
				path: filePath,
				source,
			});
		} catch {
			// Skip unreadable skills.
		}
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			await findSkills(path.join(directory, entry.name), source, output);
		}
	}
}

export async function runSkillsCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const json = args.commandArgs.includes("--json");
	const sub = args.commandArgs[0];
	if (sub === "path") {
		console.log(`flintcode: ${context.paths.skillsDir}`);
		console.log(`project:   ${context.paths.projectSkillsDir}`);
		if (context.config.compat.piSkills) console.log(`pi:        ${context.paths.piSkillsDir}`);
		return 0;
	}
	if (sub === "install") {
		const source = args.commandArgs[1];
		if (!source) throw new Error("Usage: flintcode skills install <dir> [--name <name>] [--force]");
		const named = args.commandArgs.indexOf("--name");
		const name = (named >= 0 ? args.commandArgs[named + 1] : undefined) ?? path.basename(path.resolve(source));
		if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Skill name may contain only letters, digits, dots, underscores and dashes");
		const stat = await fs.stat(source).catch(() => undefined);
		if (!stat?.isDirectory()) throw new Error(`Skill source is not a directory: ${source}`);
		const skillFile = path.join(source, "SKILL.md");
		if (!(await fs.stat(skillFile).catch(() => undefined))) throw new Error(`No SKILL.md in ${source}`);
		const destination = path.join(context.paths.skillsDir, name);
		if (await fs.stat(destination).catch(() => undefined)) {
			if (!args.commandArgs.includes("--force")) throw new Error(`${destination} already exists; pass --force to replace it`);
			await fs.rm(destination, { recursive: true, force: true });
		}
		await fs.cp(source, destination, { recursive: true });
		console.log(`Installed skill ${name} at ${destination}.`);
		return 0;
	}
	if (sub === "remove" || sub === "rm") {
		const name = args.commandArgs[1];
		if (!name) throw new Error("Usage: flintcode skills remove <name> --yes");
		if (!args.commandArgs.includes("--yes")) throw new Error("Refusing to delete a skill without --yes");
		const destination = path.join(context.paths.skillsDir, name);
		await fs.rm(destination, { recursive: true, force: true });
		console.log(`Removed skill ${name}.`);
		return 0;
	}
	const skills: SkillInfo[] = [];
	await findSkills(context.paths.skillsDir, "flintcode", skills);
	if (context.trusted) await findSkills(context.paths.projectSkillsDir, "project", skills);
	if (context.config.compat.piSkills) await findSkills(context.paths.piSkillsDir, "pi", skills);
	const seen = new Set<string>();
	const unique = skills.filter((skill) => {
		if (seen.has(skill.name)) return false;
		seen.add(skill.name);
		return true;
	});
	if (json) {
		console.log(JSON.stringify({ skills: unique }, null, 2));
		return 0;
	}
	if (unique.length === 0) {
		console.log("No skills discovered.");
		return 0;
	}
	for (const skill of unique) {
		console.log(`${skill.name}  [${skill.source}]`);
		console.log(`  ${truncateText(oneLine(skill.description), 160)}`);
		console.log(`  ${shortPath(skill.path)}`);
	}
	console.log(`\n${unique.length} skill(s).`);
	return 0;
}

export async function runAgentsCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const json = args.commandArgs.includes("--json");
	const agents = await discoverAgents({
		paths: context.paths,
		config: context.config,
		cwd: args.cwd,
		projectTrusted: context.trusted,
	});
	if (json) {
		console.log(
			JSON.stringify(
				{
					agents: agents.map((agent) => ({
						name: agent.name,
						description: agent.description,
						source: agent.source,
						tools: agent.tools ?? ["read", "grep", "find", "ls"],
						model: agent.model,
						thinking: agent.thinking,
						filePath: agent.filePath,
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}
	for (const agent of agents) {
		console.log(`${agent.name}  [${agent.source}]`);
		console.log(`  ${truncateText(oneLine(agent.description), 180)}`);
		console.log(`  tools: ${(agent.tools ?? ["read", "grep", "find", "ls"]).join(", ")}${agent.model ? ` · model: ${agent.model}` : ""}`);
	}
	console.log(`\n${agents.length} agent(s).`);
	return 0;
}

export async function runHooksCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const json = args.commandArgs.includes("--json");
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const action = positional[0] ?? "list";
	const data = await loadHooksFile(context.paths);
	for (const warning of data.warnings) console.error(`flintcode: warning: ${warning}`);
	if (action === "test") {
		const event = (positional[1] ?? "PreToolUse") as HookEvent;
		let toolIndex = args.commandArgs.indexOf("--tool");
		const toolName = toolIndex >= 0 ? args.commandArgs[toolIndex + 1] : undefined;
		toolIndex = args.commandArgs.indexOf("--input");
		let input: Record<string, unknown> = {};
		if (toolIndex >= 0) {
			try {
				input = JSON.parse(args.commandArgs[toolIndex + 1] ?? "{}") as Record<string, unknown>;
			} catch {
				throw new Error("--input must be valid JSON");
			}
		}
		const runner = new HookRunner({
			hooks: data.hooks,
			cwd: args.cwd,
			timeoutMs: context.config.hooks.timeoutMs,
		});
		const result = await runner.run(event, { toolName, input });
		console.log(JSON.stringify(result, null, 2));
		return result.blocked ? 1 : 0;
	}
	if (action !== "list" && action !== "ls") {
		throw new Error("Usage: flintcode hooks [list|test <event> [--tool name] [--input json]]");
	}
	const hooks = data.hooks;
	if (json) {
		console.log(JSON.stringify({ hooks, path: context.paths.hooksFile }, null, 2));
		return 0;
	}
	if (hooks.length === 0) {
		console.log(`No hooks configured at ${shortPath(context.paths.hooksFile)}.`);
		return 0;
	}
	for (const hook of hooks) {
		console.log(`${hook.enabled === false ? "[disabled] " : ""}${hook.id} · ${hook.event}`);
		if (hook.matcher?.tool) console.log(`  tool: ${hook.matcher.tool}`);
		console.log(`  ${truncateText(oneLine(hook.command ?? hook.prompt ?? ""), 180)}`);
	}
	return 0;
}

export async function runMcpCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const action = positional[0] ?? "list";
	const mcpPath = context.paths.mcpFile;
	const raw = await readJson<unknown>(mcpPath, { mcpServers: {} });
	const file =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { mcpServers?: Record<string, Record<string, unknown>> })
			: { mcpServers: {} };
	file.mcpServers ??= {};
	if (action === "path") {
		console.log(mcpPath);
		return 0;
	}
	if (action === "list" || action === "ls") {
		const entries = Object.entries(file.mcpServers);
		if (args.commandArgs.includes("--json")) {
			console.log(JSON.stringify(file.mcpServers, null, 2));
			return 0;
		}
		if (entries.length === 0) {
			console.log(`No MCP servers configured at ${shortPath(mcpPath)}.`);
			return 0;
		}
		for (const [name, server] of entries) {
			console.log(`${name}${server.enabled === false ? " [disabled]" : ""}`);
			if (typeof server.command === "string") {
				const serverArgs = Array.isArray(server.args) ? server.args.map(String) : [];
				console.log(`  stdio: ${server.command} ${serverArgs.join(" ")}`);
			} else if (typeof server.url === "string") {
				console.log(`  http: ${server.url}`);
			}
			if (typeof server.description === "string") console.log(`  ${server.description}`);
		}
		return 0;
	}
	if (action === "add") {
		const name = positional[1];
		if (!name) throw new Error("Usage: flintcode mcp add <name> -- <command...>");
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid MCP server name.");
		const urlIndex = args.commandArgs.indexOf("--url");
		const dashIndex = args.commandArgs.indexOf("--");
		if (urlIndex >= 0) {
			const url = args.commandArgs[urlIndex + 1];
			if (!url) throw new Error("--url requires a value");
			file.mcpServers[name] = { url };
		} else if (dashIndex >= 0) {
			const [command, ...serverArgs] = args.commandArgs.slice(dashIndex + 1);
			if (!command) throw new Error("A command is required after --");
			file.mcpServers[name] = { command, args: serverArgs };
		} else {
			throw new Error("Provide a server command after --, or --url <url>.");
		}
		await writeJsonAtomic(mcpPath, file);
		console.log(`Added MCP server ${name} to ${shortPath(mcpPath)}.`);
		return 0;
	}
	if (action === "remove" || action === "rm") {
		const name = positional[1];
		if (!name || !file.mcpServers[name]) throw new Error(`No MCP server named "${name}".`);
		delete file.mcpServers[name];
		await writeJsonAtomic(mcpPath, file);
		console.log(`Removed MCP server ${name}.`);
		return 0;
	}
	if (action === "enable" || action === "disable") {
		const name = positional[1];
		if (!name || !file.mcpServers[name]) throw new Error(`No MCP server named "${name}".`);
		file.mcpServers[name].enabled = action === "enable";
		await writeJsonAtomic(mcpPath, file);
		console.log(`${action === "enable" ? "Enabled" : "Disabled"} ${name}.`);
		return 0;
	}
	throw new Error("Usage: flintcode mcp [list|add|remove|enable|disable|path]");
}

export async function runWorktreeCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const action = positional[0] ?? "list";
	if (action === "list" || action === "ls") {
		const worktrees = await listWorktrees(args.cwd);
		if (args.commandArgs.includes("--json")) {
			console.log(JSON.stringify({ worktrees }, null, 2));
			return 0;
		}
		console.log(formatWorktrees(worktrees, args.cwd));
		return 0;
	}
	if (action === "create" || action === "add") {
		const created = await createWorktree({
			cwd: args.cwd,
			root: context.config.worktrees.root,
			...(positional[1] ? { name: positional[1] } : {}),
		});
		console.log(`Created ${created.path} (${created.branch}).`);
		console.log(`Start Flintcode there with: flintcode -w ${created.path}`);
		return 0;
	}
	if (action === "remove" || action === "rm") {
		if (!positional[1]) throw new Error("Usage: flintcode worktree remove <name> [--force]");
		const removed = await removeWorktree(
			args.cwd,
			positional[1],
			args.commandArgs.includes("--force"),
		);
		console.log(`Removed ${removed}.`);
		return 0;
	}
	throw new Error("Usage: flintcode worktree [list|create [name]|remove <name> [--force]]");
}

export async function runCronCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	const raw = await readJson<unknown>(context.paths.loopsFile, { loops: [] });
	const loops =
		raw && typeof raw === "object" && Array.isArray((raw as { loops?: unknown }).loops)
			? ((raw as { loops: LoopRecord[] }).loops as LoopRecord[])
			: [];
	if (args.commandArgs.includes("--json")) {
		console.log(JSON.stringify({ loops, path: context.paths.loopsFile }, null, 2));
		return 0;
	}
	console.log(formatLoops(loops));
	console.log("\nLoops run while a Flintcode session is open. Manage them with /loop in a session.");
	return 0;
}

export async function runConfigCommand(args: CliArgs): Promise<number> {
	const context = await resourceContext(args);
	if (args.commandArgs.includes("--json")) {
		console.log(
			JSON.stringify(
				{
					configFile: context.paths.configFile,
					exists: await pathExists(context.paths.configFile),
					config: context.config,
					paths: {
						home: context.paths.home,
						sessions: context.paths.sessionsDir,
						skills: context.paths.skillsDir,
						agents: context.paths.agentsDir,
						hooks: context.paths.hooksFile,
						mcp: context.paths.mcpFile,
						plans: context.paths.plansDir,
					},
				},
				null,
				2,
			),
		);
		return 0;
	}
	console.log(`Config:   ${shortPath(context.paths.configFile)}`);
	console.log(`Home:     ${shortPath(context.paths.home)}`);
	console.log(`Model:    ${context.config.defaults.provider}/${context.config.defaults.model}`);
	console.log(`Thinking: ${context.config.defaults.thinking}`);
	console.log(`Perms:    ${context.config.permissions.mode} (${context.config.permissions.rules.length} rules)`);
	console.log(`Style:    ${context.config.ui.outputStyle}`);
	console.log(`pi dir:   ${shortPath(context.paths.piAgentDir)}`);
	return 0;
}
