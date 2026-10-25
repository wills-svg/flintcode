import * as path from "node:path";
import { PERMISSION_MODES } from "../core/config.js";
import type { PermissionMode } from "../core/types.js";

export const KNOWN_COMMANDS = new Set([
	"init",
	"doctor",
	"models",
	"providers",
	"auth",
	"login",
	"logout",
	"use",
	"plugins",
	"sessions",
	"mcp",
	"skills",
	"agents",
	"hooks",
	"worktree",
	"trust",
	"cron",
	"config",
	"search",
	"fetch",
	"docs",
	"print",
	"help",
	"version",
]);

export type CliMode = "interactive" | "print" | "json" | "rpc";
export type OutputFormat = "text" | "json" | "stream-json";

export interface CliArgs {
	command?: string;
	commandArgs: string[];
	positionals: string[];
	prompt?: string;
	mode: CliMode;
	outputFormat: OutputFormat;
	debug: boolean;
	help: boolean;
	version: boolean;
	cwd: string;
	configDir?: string;
	model?: string;
	thinking?: string;
	permissionMode?: PermissionMode;
	tools?: string[];
	allowedTools: string[];
	disallowedTools: string[];
	resume?: string | true;
	continue: boolean;
	fork: boolean;
	sessionId?: string;
	sessionName?: string;
	noSession: boolean;
	trust?: boolean;
	worktree?: string | true;
	addDirs: string[];
	agent?: string;
	systemPrompt?: string;
	appendSystemPrompt: string[];
	attachments: string[];
	maxOutputTokens?: number;
	initialPrompt?: string;
	rpc: boolean;
}

export interface ParseResult {
	args: CliArgs;
	errors: string[];
}

function valueAfter(
	argv: string[],
	index: number,
	option: string,
	errors: string[],
	optional = false,
): { value?: string; consumed: number } {
	const next = argv[index + 1];
	if (next === undefined || next.startsWith("-")) {
		if (!optional) errors.push(`${option} requires a value`);
		return { consumed: 0 };
	}
	return { value: next, consumed: 1 };
}

function addList(target: string[], value: string): void {
	for (const part of value.split(",")) {
		const trimmed = part.trim();
		if (trimmed) target.push(trimmed);
	}
}

function optionValue(token: string): { name: string; inline?: string } {
	const equals = token.indexOf("=");
	if (equals === -1) return { name: token };
	return { name: token.slice(0, equals), inline: token.slice(equals + 1) };
}

export function parseArgs(argv: string[], defaults?: { cwd?: string }): ParseResult {
	const errors: string[] = [];
	const args: CliArgs = {
		commandArgs: [],
		positionals: [],
		mode: "interactive",
		outputFormat: "text",
		debug: false,
		help: false,
		version: false,
		cwd: path.resolve(defaults?.cwd ?? process.cwd()),
		allowedTools: [],
		disallowedTools: [],
		continue: false,
		fork: false,
		noSession: false,
		addDirs: [],
		appendSystemPrompt: [],
		attachments: [],
		rpc: false,
	};

	let printRequested = false;
	let modeRequested = false;
	let index = 0;
	if (argv[0] && !argv[0].startsWith("-") && KNOWN_COMMANDS.has(argv[0])) {
		args.command = argv[0];
		args.commandArgs = argv.slice(1);
		while (args.commandArgs.includes("--help") || args.commandArgs.includes("-h")) {
			args.help = true;
			break;
		}
		if (args.command === "print") args.mode = "print";
		return { args, errors };
	}

	let positionalOnly = false;
	for (; index < argv.length; index += 1) {
		const raw = argv[index];
		if (positionalOnly) {
			args.positionals.push(raw);
			continue;
		}
		if (raw === "--") {
			positionalOnly = true;
			continue;
		}
		if (!raw.startsWith("-") || raw === "-") {
			args.positionals.push(raw);
			continue;
		}
		const { name, inline } = optionValue(raw);
		const nextValue = (option: string, optional = false) => {
			if (inline !== undefined) return inline;
			const result = valueAfter(argv, index, option, errors, optional);
			index += result.consumed;
			return result.value;
		};
		const setOptionList = (target: string[], option: string) => {
			const value = nextValue(option);
			if (value) addList(target, value);
		};
		switch (name) {
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-v":
			case "--version":
				args.version = true;
				break;
			case "-p":
			case "--print":
				printRequested = true;
				break;
			case "--rpc":
				args.rpc = true;
				modeRequested = true;
				args.mode = "rpc";
				break;
			case "--json":
				modeRequested = true;
				args.mode = "json";
				args.outputFormat = "stream-json";
				break;
			case "-i":
			case "--prompt-interactive": {
				const value = nextValue(name);
				if (value) args.initialPrompt = value;
				break;
			}
			case "--prompt": {
				const value = nextValue(name);
				if (value) args.initialPrompt = value;
				break;
			}
			case "-m":
			case "--model":
				args.model = nextValue(name);
				break;
			case "--thinking":
			case "--reasoning-effort":
				args.thinking = nextValue(name);
				break;
			case "--permission-mode": {
				const value = nextValue(name);
				if (value) {
					if (PERMISSION_MODES.includes(value as PermissionMode)) {
						args.permissionMode = value as PermissionMode;
					} else {
						errors.push(
							`Invalid --permission-mode "${value}". Use one of: ${PERMISSION_MODES.join(", ")}`,
						);
					}
				}
				break;
			}
			case "--dangerously-skip-permissions":
			case "--yolo":
				args.permissionMode = "yolo";
				break;
			case "--tools":
				setOptionList((args.tools ??= []), name);
				break;
			case "--allowed-tools":
				setOptionList(args.allowedTools, name);
				break;
			case "--disallowed-tools":
			case "--excluded-tools":
				setOptionList(args.disallowedTools, name);
				break;
			case "-w":
			case "--cwd": {
				const value = nextValue(name);
				if (value) args.cwd = path.resolve(args.cwd, value);
				break;
			}
			case "--config-dir": {
				const value = nextValue(name);
				if (value) args.configDir = path.resolve(args.cwd, value);
				break;
			}
			case "-r":
			case "--resume": {
				const value = nextValue(name, true);
				args.resume = value ?? true;
				break;
			}
			case "-c":
			case "--continue":
				args.continue = true;
				break;
			case "--fork":
			case "--fork-session":
				args.fork = true;
				break;
			case "--session-id":
				args.sessionId = nextValue(name);
				break;
			case "-n":
			case "--name":
			case "--session-name":
				args.sessionName = nextValue(name);
				break;
			case "--no-session-persistence":
			case "--no-session":
				args.noSession = true;
				break;
			case "--trust":
			case "--approve":
				args.trust = true;
				break;
			case "--no-trust":
			case "--no-approve":
				args.trust = false;
				break;
			case "--worktree": {
				const value = nextValue(name, true);
				args.worktree = value ?? true;
				break;
			}
			case "--add-dir": {
				const value = nextValue(name);
				if (value) args.addDirs.push(path.resolve(args.cwd, value));
				break;
			}
			case "--agent":
				args.agent = nextValue(name);
				break;
			case "--system-prompt":
				args.systemPrompt = nextValue(name);
				break;
			case "--append-system-prompt":
				setOptionList(args.appendSystemPrompt, name);
				break;
			case "--attachment": {
				const value = nextValue(name);
				if (value) args.attachments.push(path.resolve(args.cwd, value));
				break;
			}
			case "--max-output-tokens": {
				const value = nextValue(name);
				if (value && Number.isFinite(Number(value))) args.maxOutputTokens = Number(value);
				else errors.push("--max-output-tokens requires a number");
				break;
			}
			case "-o":
			case "--output-format": {
				const value = nextValue(name);
				if (value === "text" || value === "json" || value === "stream-json") {
					args.outputFormat = value;
					modeRequested = true;
					args.mode = value === "text" ? "print" : "json";
				} else {
					errors.push(`Invalid --output-format "${value}". Use text, json, or stream-json.`);
				}
				break;
			}
			case "--mode": {
				const value = nextValue(name);
				if (value === "interactive" || value === "print" || value === "json" || value === "rpc") {
					args.mode = value;
					modeRequested = true;
				} else {
					errors.push(`Invalid --mode "${value}". Use interactive, print, json, or rpc.`);
				}
				break;
			}
			case "--list-sessions":
				args.command = "sessions";
				break;
			case "--list-models":
				args.command = "models";
				break;
			case "--debug":
				args.debug = true;
				break;
			case "--max-turns":
			case "--thinking-budget":
			case "--context-window":
			case "--setting-sources":
			case "--strict-mcp-config":
				nextValue(name, true);
				break;
			default:
				errors.push(`Unknown option: ${name}`);
				break;
		}
	}
	if (!modeRequested) args.mode = printRequested ? "print" : "interactive";
	if (args.initialPrompt && args.mode === "interactive" && args.positionals.length > 0) {
		args.positionals.unshift(args.initialPrompt);
		args.initialPrompt = undefined;
	}
	const joined = args.positionals.join(" ").trim();
	args.prompt = args.initialPrompt ?? (joined || undefined);
	if (args.continue && args.resume) errors.push("Use either --continue or --resume, not both.");
	return { args, errors };
}
