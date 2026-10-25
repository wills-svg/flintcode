import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDir, pathExists } from "../util/atomic-json.js";

export interface FlintcodePaths {
	home: string;
	configFile: string;
	sessionsDir: string;
	skillsDir: string;
	promptsDir: string;
	themesDir: string;
	agentsDir: string;
	extensionsDir: string;
	hooksFile: string;
	mcpFile: string;
	tasksDir: string;
	subagentsDir: string;
	loopsFile: string;
	memoryDir: string;
	memoryFile: string;
	goalsFile: string;
	checkpointsDir: string;
	logsDir: string;
	logFile: string;
	trustFile: string;
	modelsFile: string;
	authFile: string;
	stateDir: string;
	worktreesDir: string;
	plansDir: string;
	piAgentDir: string;
	piAuthFile: string;
	piModelsFile: string;
	piSettingsFile: string;
	piTrustFile: string;
	piSkillsDir: string;
	piAgentsDir: string;
	piPromptsDir: string;
	piAgentsFile: string;
	projectFlintcodeDir: string;
	projectConfigFile: string;
	projectSkillsDir: string;
	projectPromptsDir: string;
	projectAgentsDir: string;
	projectMcpFile: string;
}

export function expandHome(value: string, home = os.homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

export function resolveFlintcodeHome(options?: { configDir?: string; env?: NodeJS.ProcessEnv }): string {
	const env = options?.env ?? process.env;
	const explicit =
		options?.configDir ??
		env.FLINTCODE_HOME ??
		env.FLINTCODE_CONFIG_DIR ??
		env.TAU_HOME ??
		env.TAU_CONFIG_DIR;
	if (explicit) return path.resolve(expandHome(explicit));
	return path.join(os.homedir(), ".flintcode");
}

export function resolvePiAgentDir(current: FlintcodePaths | undefined, env = process.env): string {
	if (current) return current.piAgentDir;
	const explicit = env.FLINTCODE_PI_AGENT_DIR ?? env.TAU_PI_AGENT_DIR;
	if (explicit) return path.resolve(expandHome(explicit));
	return path.join(os.homedir(), ".pi", "agent");
}

export function createFlintcodePaths(home: string, cwd = process.cwd(), piAgentDir?: string): FlintcodePaths {
	const resolvedHome = path.resolve(home);
	const piDir = path.resolve(piAgentDir ?? resolvePiAgentDir(undefined));
	const sessionsDir = path.join(resolvedHome, "sessions");
	const memoryDir = path.join(resolvedHome, "memory");
	// A project created with the upstream Tau harness keeps working in place;
	// new projects always use .flintcode.
	const modernProjectDir = path.join(cwd, ".flintcode");
	const legacyProjectDir = path.join(cwd, ".tau");
	const projectFlintcodeDir =
		!fs.existsSync(modernProjectDir) && fs.existsSync(legacyProjectDir)
			? legacyProjectDir
			: modernProjectDir;
	return {
		home: resolvedHome,
		configFile: path.join(resolvedHome, "flintcode.json"),
		sessionsDir,
		skillsDir: path.join(resolvedHome, "skills"),
		promptsDir: path.join(resolvedHome, "prompts"),
		themesDir: path.join(resolvedHome, "themes"),
		agentsDir: path.join(resolvedHome, "agents"),
		extensionsDir: path.join(resolvedHome, "extensions"),
		hooksFile: path.join(resolvedHome, "hooks.json"),
		mcpFile: path.join(resolvedHome, "mcp.json"),
		tasksDir: path.join(resolvedHome, "tasks"),
		subagentsDir: path.join(resolvedHome, "subagents"),
		loopsFile: path.join(resolvedHome, "loops.json"),
		memoryDir,
		memoryFile: path.join(memoryDir, "memory.jsonl"),
		goalsFile: path.join(resolvedHome, "goals.json"),
		checkpointsDir: path.join(resolvedHome, "checkpoints"),
		logsDir: path.join(resolvedHome, "logs"),
		logFile: path.join(resolvedHome, "logs", "flintcode.log"),
		trustFile: path.join(resolvedHome, "trust.json"),
		modelsFile: path.join(resolvedHome, "models.json"),
		authFile: path.join(resolvedHome, "auth.json"),
		stateDir: path.join(resolvedHome, "state"),
		worktreesDir: path.join(resolvedHome, "worktrees"),
		plansDir: path.join(resolvedHome, "plans"),
		piAgentDir: piDir,
		piAuthFile: path.join(piDir, "auth.json"),
		piModelsFile: path.join(piDir, "models.json"),
		piSettingsFile: path.join(piDir, "settings.json"),
		piTrustFile: path.join(piDir, "trust.json"),
		piSkillsDir: path.join(piDir, "skills"),
		piAgentsDir: path.join(piDir, "agents"),
		piPromptsDir: path.join(piDir, "prompts"),
		piAgentsFile: path.join(piDir, "AGENTS.md"),
		projectFlintcodeDir,
		projectConfigFile: path.join(projectFlintcodeDir, "flintcode.json"),
		projectSkillsDir: path.join(projectFlintcodeDir, "skills"),
		projectPromptsDir: path.join(projectFlintcodeDir, "prompts"),
		projectAgentsDir: path.join(projectFlintcodeDir, "agents"),
		projectMcpFile: path.join(projectFlintcodeDir, "mcp.json"),
	};
}

export async function ensureFlintcodeLayout(paths: FlintcodePaths): Promise<void> {
	const directories = [
		paths.home,
		paths.sessionsDir,
		paths.skillsDir,
		paths.promptsDir,
		paths.themesDir,
		paths.agentsDir,
		paths.extensionsDir,
		paths.tasksDir,
		paths.subagentsDir,
		paths.memoryDir,
		paths.checkpointsDir,
		paths.logsDir,
		paths.stateDir,
		paths.worktreesDir,
		paths.plansDir,
	];
	await Promise.all(directories.map((directory) => ensureDir(directory)));
}

export async function isFlintcodeInitialized(paths: FlintcodePaths): Promise<boolean> {
	return pathExists(paths.configFile);
}

export function flintcodeBinSuggestion(): string {
	return path.join(process.env.PREFIX ?? "/usr", "bin", "flintcode");
}
