import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionAction, PermissionMode, PermissionRule } from "./types.js";
import { oneLine, truncateText } from "../util/format.js";

export type ApprovalChoice = "allow" | "always" | "deny";

export interface PermissionRequest {
	toolName: string;
	input: Record<string, unknown>;
	target: string;
	targetKind: "path" | "command" | "tool" | "unknown";
	description: string;
	mode: PermissionMode;
	planMode: boolean;
	ruleReason?: string;
}

export interface PermissionDecision {
	action: "allow" | "deny";
	reason?: string;
	cacheKey?: string;
}

export type ApprovalHandler = (request: PermissionRequest) => Promise<ApprovalChoice | null>;
export type PermissionHook = (
	request: PermissionRequest,
) => Promise<{ decision?: "allow" | "deny"; reason?: string } | undefined>;

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"WebSearch",
	"WebFetch",
	"ask_user",
	"TodoWrite",
	"todo_write",
	"todo_read",
	"todo_list",
	"memory_search",
	"memory_list",
	"goal_get",
	"Goal",
	"EnterPlanMode",
	"ExitPlanMode",
	"bash_output",
	"task_list",
	"agent_output",
	"ScheduleWakeup",
]);

const EDIT_TOOLS = new Set(["edit", "write", "NotebookEdit", "notebook_edit", "ApplyPatch"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "Bash", "bash_background", "bash_kill"]);
const PLAN_SAFE_TOOLS = new Set([
	...READ_ONLY_TOOLS,
	"Skill",
	"skill",
]);

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
	/(^|\s)rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f?|--recursive)/,
	/(^|\s)(sudo|doas|su)\b/,
	/(^|\s)(mkfs|fdisk|parted|dd)\b/,
	/(^|\s)(shutdown|reboot|halt|poweroff)\b/,
	/(^|\s)chmod\s+(-R\s+)?777\b/,
	/(^|\s)git\s+push\s+.*--force/,
	/(^|\s)git\s+reset\s+--hard/,
	/(^|\s)git\s+clean\s+.*-[a-zA-Z]*f[a-zA-Z]*x/,
	/(^|\s)(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/,
	/>\s*\/dev\/(sd|block|mmcblk)/,
	/(^|\s):\(\)\s*\{/,
	/(^|\s)find\b.*-delete\b/,
	/(^|\s)(pkill|killall)\b/,
	/(^|\s)npm\s+publish\b/,
	/(^|\s)crontab\b/,
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
	/(?:^|\/)\.ssh(?:\/|$)/i,
	/(?:^|\/)\.aws(?:\/|$)/i,
	/(?:^|\/)\.gnupg(?:\/|$)/i,
	/(?:^|\/)\.kube(?:\/|$)/i,
	/(?:^|\/|\.)env(?:\.[^/]+)?$/i,
	/(?:^|\/)auth\.json$/i,
	/(?:^|\/)\.npmrc$/i,
	/(?:^|\/)\.netrc$/i,
	/(?:^|\/)\.docker\/config\.json$/i,
	/\.(?:pem|key|p12|pfx|jks|keystore)$/i,
	/id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
	/(?:^|\/)\.flintcode\/(?:flintcode|hooks|trust|mcp)\.json$/i,
	/(?:^|\/)\.pi\/agent\/(?:auth|settings|trust)\.json$/i,
];

const NETWORK_EXFIL_PATTERN = /\b(curl|wget|nc|ncat|netcat|scp|sftp|rsync|ssh|ftp|openssl)\b/i;

function escapeRegex(value: string): string {
	return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index += 1;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += ".";
		} else {
			pattern += escapeRegex(char);
		}
	}
	return new RegExp(`^${pattern}$`, "i");
}

function matchesGlob(value: string, pattern: string): boolean {
	return globToRegex(pattern).test(value) || globToRegex(pattern).test(path.basename(value));
}

function matchesCommandPattern(command: string, pattern: string): boolean {
	try {
		return new RegExp(pattern, "i").test(command);
	} catch {
		return command.toLowerCase().includes(pattern.toLowerCase());
	}
}

function isSensitivePath(candidate: string): boolean {
	const normalized = path.normalize(candidate).replace(/\\/g, "/");
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function commandLooksExfiltrative(command: string): boolean {
	if (!NETWORK_EXFIL_PATTERN.test(command)) return false;
	const normalized = command.replace(/\\/g, "/");
	return (
		SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) ||
		/(?:^|[\s'"`/])\.env(?:[\s'"`.]|$)/i.test(normalized)
	);
}

function isOutsideWorkspace(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative.startsWith("..") || path.isAbsolute(relative);
}

async function symlinksEscapeWorkspace(cwd: string, candidates: string[]): Promise<boolean> {
	if (candidates.length === 0) return false;
	let realCwd: string;
	try {
		realCwd = await fs.realpath(cwd);
	} catch {
		return false;
	}
	for (const candidate of candidates) {
		const lexical = path.resolve(cwd, candidate);
		if (isOutsideWorkspace(cwd, lexical)) continue;
		let target = lexical;
		for (;;) {
			try {
				const real = await fs.realpath(target);
				if (isOutsideWorkspace(realCwd, real)) return true;
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") break;
				const parent = path.dirname(target);
				if (parent === target) break;
				target = parent;
			}
		}
	}
	return false;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function pathCandidates(input: Record<string, unknown>): string[] {
	const values: string[] = [];
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"file",
		"filename",
		"target",
		"dir",
		"directory",
		"dir_path",
		"notebook_path",
		"notebookPath",
		"new_path",
		"old_path",
		"source",
		"destination",
	]) {
		const value = input[key];
		if (typeof value === "string" && value) values.push(value);
	}
	for (const key of ["paths", "files"]) {
		const value = input[key];
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string") values.push(entry);
				else if (entry && typeof entry === "object" && "path" in entry) {
					const candidate = (entry as { path?: unknown }).path;
					if (typeof candidate === "string") values.push(candidate);
				}
			}
		}
	}
	return values;
}

function mcpServerFromTool(toolName: string): string | undefined {
	if (!toolName.startsWith("mcp__")) return undefined;
	const [, server] = toolName.split("__");
	return server;
}

export class PermissionEngine {
	private modeValue: PermissionMode;
	private plan = false;
	private rules: PermissionRule[];
	private readonly cwd: string;
	private interactive: boolean;
	private protectSecrets: boolean;
	private approvalHandler?: ApprovalHandler;
	private permissionHook?: PermissionHook;
	private readonly allowedCache = new Set<string>();

	constructor(options: {
		cwd: string;
		mode: PermissionMode;
		rules?: PermissionRule[];
		interactive: boolean;
		protectSecrets?: boolean;
		approvalHandler?: ApprovalHandler;
	}) {
		this.cwd = path.resolve(options.cwd);
		this.modeValue = options.mode;
		this.rules = options.rules ?? [];
		this.interactive = options.interactive;
		this.protectSecrets = options.protectSecrets ?? true;
		this.approvalHandler = options.approvalHandler;
	}

	get mode(): PermissionMode {
		return this.modeValue;
	}

	setMode(mode: PermissionMode): void {
		if (this.modeValue !== mode) this.allowedCache.clear();
		this.modeValue = mode;
	}

	get planMode(): boolean {
		return this.plan;
	}

	setPlanMode(active: boolean): void {
		if (this.plan !== active) this.allowedCache.clear();
		this.plan = active;
	}

	setRules(rules: PermissionRule[]): void {
		this.rules = rules;
	}

	setProtectSecrets(protect: boolean): void {
		this.protectSecrets = protect;
	}

	setInteractive(interactive: boolean): void {
		this.interactive = interactive;
	}

	setApprovalHandler(handler: ApprovalHandler | undefined): void {
		this.approvalHandler = handler;
	}

	setPermissionHook(hook: PermissionHook | undefined): void {
		this.permissionHook = hook;
	}

	clearCache(): void {
		this.allowedCache.clear();
	}

	describe(toolName: string, input: Record<string, unknown>): PermissionRequest {
		const command = firstString(input, ["command", "cmd", "script"]);
		const candidates = pathCandidates(input);
		const server = mcpServerFromTool(toolName);
		let targetKind: PermissionRequest["targetKind"] = "unknown";
		let target = "";
		if (command) {
			targetKind = "command";
			target = command;
		} else if (candidates.length > 0) {
			targetKind = "path";
			target = candidates.join(", ");
		} else if (server) {
			targetKind = "tool";
			target = server;
		}
		if (!target) target = toolName;
		const pretty = safeJson(input);
		return {
			toolName,
			input,
			target,
			targetKind,
			description: truncateText(oneLine(pretty), 800),
			mode: this.modeValue,
			planMode: this.plan,
		};
	}

	async check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
		const request = this.describe(toolName, input);
		if (this.plan && !PLAN_SAFE_TOOLS.has(toolName)) {
			return { action: "deny", reason: "Blocked: plan mode is read-only." };
		}
		const cacheKey = `${toolName}\0${request.target}`;
		if (this.allowedCache.has(cacheKey)) return { action: "allow", cacheKey };

		const rule = this.evaluateRules(request);
		if (rule?.action === "deny") {
			return { action: "deny", reason: rule.reason ?? rule.rule.reason ?? "Blocked by permission rule." };
		}
		if (rule?.action === "allow") {
			return { action: "allow", reason: rule.rule.reason, cacheKey };
		}
		if (rule?.action === "ask") {
			return this.ask({ ...request, ruleReason: rule.rule.reason });
		}

		const protection = await this.protectionReason(toolName, request);
		if (protection) {
			return this.ask({ ...request, ruleReason: protection });
		}
		const modeDecision = this.modeDecision(toolName, request);
		if (modeDecision === "allow") return { action: "allow", cacheKey };
		if (modeDecision === "deny") {
			return { action: "deny", reason: "Blocked by the current permission mode." };
		}
		return this.ask(request);
	}

	private async protectionReason(
		toolName: string,
		request: PermissionRequest,
	): Promise<string | undefined> {
		if (!this.protectSecrets || this.plan) return undefined;
		const candidates = pathCandidates(request.input);
		const sensitivePath = candidates.find(isSensitivePath);
		if (sensitivePath) {
			const normalized = path.normalize(sensitivePath).replace(/\\/g, "/");
			const label = /(?:^|\/)(?:\.flintcode|\.pi\/agent)\/(?:flintcode|hooks|trust|mcp|auth|settings)\.json$/i.test(normalized)
				? "harness configuration"
				: "credentials";
			return `Flintcode protects ${label}: ${sensitivePath}`;
		}
		const command = firstString(request.input, ["command", "cmd", "script"]);
		if (command && commandLooksExfiltrative(command)) {
			return "Flintcode blocks credential reads combined with network transfer tools";
		}
		if (
			(EDIT_TOOLS.has(toolName) || toolName === "NotebookEdit" || toolName === "notebook_edit") &&
			(await symlinksEscapeWorkspace(this.cwd, candidates))
		) {
			return "The edit target resolves through a symlink to a path outside the workspace";
		}
		return undefined;
	}

	private modeDecision(
		toolName: string,
		request: PermissionRequest,
	): "allow" | "ask" | "deny" {
		if (this.modeValue === "yolo") return "allow";
		if (this.modeValue === "dont-ask") {
			if (READ_ONLY_TOOLS.has(toolName)) return "allow";
			return "deny";
		}
		if (READ_ONLY_TOOLS.has(toolName)) return "allow";
		if (this.modeValue === "default") {
			if (EDIT_TOOLS.has(toolName)) return "ask";
			if (SHELL_TOOLS.has(toolName)) return "ask";
			return "ask";
		}
		if (this.modeValue === "accept-edits") {
			if (EDIT_TOOLS.has(toolName)) {
				return this.pathsInsideWorkspace(request.input) ? "allow" : "ask";
			}
			if (SHELL_TOOLS.has(toolName)) return "ask";
			return "ask";
		}
		if (this.modeValue === "auto") {
			if (EDIT_TOOLS.has(toolName)) {
				return this.pathsInsideWorkspace(request.input) ? "allow" : "ask";
			}
			if (SHELL_TOOLS.has(toolName)) {
				const command = firstString(request.input, ["command", "cmd", "script"]) ?? "";
				if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return "ask";
				return "allow";
			}
			return "ask";
		}
		return "ask";
	}

	private pathsInsideWorkspace(input: Record<string, unknown>): boolean {
		const candidates = pathCandidates(input);
		if (candidates.length === 0) return true;
		return candidates.every((candidate) => {
			const resolved = path.resolve(this.cwd, candidate);
			const relative = path.relative(this.cwd, resolved);
			return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
		});
	}

	private evaluateRules(
		request: PermissionRequest,
	): { action: PermissionAction; rule: PermissionRule; reason?: string } | undefined {
		const matches = this.rules.filter((rule) => this.ruleMatches(rule, request));
		const deny = matches.find((rule) => rule.action === "deny");
		if (deny) return { action: "deny", rule: deny };
		const allow = matches.find((rule) => rule.action === "allow");
		if (allow) return { action: "allow", rule: allow };
		const ask = matches.find((rule) => rule.action === "ask");
		if (ask) return { action: "ask", rule: ask };
		return undefined;
	}

	private ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
		const match = rule.match ?? {};
		if (match.tools?.length && !match.tools.some((pattern) => matchesGlob(request.toolName, pattern))) {
			return false;
		}
		const server = mcpServerFromTool(request.toolName);
		if (match.mcpServers?.length) {
			if (!server || !match.mcpServers.some((pattern) => matchesGlob(server, pattern))) return false;
		}
		const command = firstString(request.input, ["command", "cmd", "script"]);
		if (match.commands?.length) {
			if (!command || !match.commands.some((pattern) => matchesCommandPattern(command, pattern))) {
				return false;
			}
		}
		const candidates = pathCandidates(request.input);
		if (match.paths?.length) {
			if (candidates.length === 0) return false;
			const absolute = candidates.map((candidate) => path.resolve(this.cwd, candidate));
			const matched = absolute.some((candidate) =>
				match.paths!.some(
					(pattern) =>
						matchesGlob(candidate, pattern) ||
						matchesGlob(path.relative(this.cwd, candidate), pattern),
				),
			);
			if (!matched) return false;
		}
		return true;
	}

	private async ask(request: PermissionRequest): Promise<PermissionDecision> {
		if (this.permissionHook) {
			try {
				const hooked = await this.permissionHook(request);
				if (hooked?.decision === "allow") return { action: "allow" };
				if (hooked?.decision === "deny") {
					return { action: "deny", reason: hooked.reason ?? "Denied by a PermissionRequest hook." };
				}
			} catch (error) {
				return {
					action: "deny",
					reason: `PermissionRequest hook failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		if (this.modeValue === "dont-ask") {
			return { action: "deny", reason: "Approval needed, but the mode is dont-ask." };
		}
		if (!this.interactive || !this.approvalHandler) {
			return {
				action: "deny",
				reason: "Approval needed, but no interactive approval handler is available.",
			};
		}
		let choice: ApprovalChoice | null;
		try {
			choice = await this.approvalHandler(request);
		} catch (error) {
			return {
				action: "deny",
				reason: `Approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (choice === "allow") return { action: "allow" };
		if (choice === "always") {
			const cacheKey = `${request.toolName}\0${request.target}`;
			this.allowedCache.add(cacheKey);
			return { action: "allow", cacheKey };
		}
		return { action: "deny", reason: "Denied by the user." };
	}
}

export function createPermissionExtension(engine: PermissionEngine) {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_call", async (event) => {
			const decision = await engine.check(event.toolName, event.input as Record<string, unknown>);
			if (decision.action === "deny") {
				return { block: true, reason: decision.reason ?? "Blocked by Flintcode permissions." };
			}
			return undefined;
		});
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
