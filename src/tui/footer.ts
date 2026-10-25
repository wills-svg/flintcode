import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isFreeModel } from "../core/models.js";
import { formatCost, formatTokens, truncateText } from "../util/format.js";
import type { PermissionMode } from "../core/types.js";
import { ANSI } from "./palette.js";
import { spinnerFrame } from "./spinner.js";

const execFileAsync = promisify(execFile);
const RESET = ANSI.reset;
const DIM = ANSI.muted;
const CYAN = ANSI.accent;
const GREEN = ANSI.green;
const YELLOW = ANSI.yellow;
const RED = ANSI.red;
const MAGENTA = ANSI.accentBright;
const BOLD = ANSI.bold;

function fg(code: string, text: string): string {
	return `${code}${text}${RESET}`;
}


const MODE_LABEL: Record<PermissionMode, string> = {
	default: "ask",
	"accept-edits": "edits",
	auto: "auto",
	"dont-ask": "noask",
	yolo: "yolo",
};

export interface StatuslineOptions {
	cwd: string;
	session: AgentSession;
	requestRender: () => void;
	getPermissionMode: () => PermissionMode;
	getPlanMode: () => boolean;
	getDebugMode?: () => boolean;
	segments?: string[];
	command?: string;
}

export class Statusline implements Component {
	private session: AgentSession;
	private readonly cwd: string;
	private readonly requestRender: () => void;
	private readonly getPermissionMode: () => PermissionMode;
	private readonly getPlanMode: () => boolean;
	private readonly getDebugMode: () => boolean;
	private readonly segments: string[];
	private readonly command?: string;
	private busy = false;
	private busySince = 0;
	private statusText: string | undefined;
	private queued = 0;
	private gitBranch = "";
	private statsTokens = 0;
	private statsCost = 0;
	private contextText = "";
	private sessionName: string | undefined;
	private freeModel = false;
	private backgroundCount = 0;
	private todoSummary = "";
	private commandText = "";
	private busyTimer?: NodeJS.Timeout;
	private busyTick = 0;
	private gitTimer?: NodeJS.Timeout;
	private commandTimer?: NodeJS.Timeout;
	private disposed = false;

	constructor(options: StatuslineOptions) {
		this.cwd = options.cwd;
		this.session = options.session;
		this.requestRender = options.requestRender;
		this.getPermissionMode = options.getPermissionMode;
		this.getPlanMode = options.getPlanMode;
		this.getDebugMode = options.getDebugMode ?? (() => false);
		this.segments = options.segments ?? ["mode", "cwd", "git", "model", "thinking", "ctx", "cost"];
		this.command = options.command;
		this.refresh();
		this.startGitRefresh();
		this.startCommandRefresh();
	}

	setBackgroundCount(count: number): void {
		if (this.backgroundCount === count) return;
		this.backgroundCount = count;
		this.requestRender();
	}

	setTodoSummary(summary: string): void {
		if (this.todoSummary === summary) return;
		this.todoSummary = summary;
		this.requestRender();
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.busy = false;
		this.busySince = 0;
		this.refresh();
		this.requestRender();
	}

	setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		this.busySince = busy ? Date.now() : 0;
		if (busy) {
			this.statusText = undefined;
			this.startBusyTimer();
		} else {
			this.stopBusyTimer();
			this.refresh();
		}
		this.requestRender();
	}

	setStatus(text: string | undefined): void {
		this.statusText = text;
		this.requestRender();
	}

	setQueued(count: number): void {
		if (this.queued === count) return;
		this.queued = count;
		this.requestRender();
	}

	refresh(): void {
		try {
			const stats = this.session.getSessionStats();
			this.statsTokens = stats.tokens.total;
			this.statsCost = stats.cost;
			const usage = this.session.getContextUsage();
			this.contextText = usage?.percent == null ? "ctx ?" : `ctx ${usage.percent.toFixed(0)}%`;
			this.sessionName = this.session.sessionManager.getSessionName();
			this.freeModel = this.session.model ? isFreeModel(this.session.model) : false;
		} catch {
			this.contextText = "ctx ?";
		}
	}

	private startBusyTimer(): void {
		this.stopBusyTimer();
		this.busyTick = 0;
		this.busyTimer = setInterval(() => {
			this.busyTick += 1;
			if (this.busyTick % 3 === 0) this.refresh();
			this.requestRender();
		}, 1_000);
		this.busyTimer.unref?.();
	}

	private stopBusyTimer(): void {
		if (this.busyTimer) clearInterval(this.busyTimer);
		this.busyTimer = undefined;
	}

	private startGitRefresh(): void {
		void this.refreshGit();
		const schedule = () => {
			if (this.disposed) return;
			this.gitTimer = setTimeout(async () => {
				await this.refreshGit();
				schedule();
			}, 20_000);
			this.gitTimer.unref?.();
		};
		schedule();
	}

	private startCommandRefresh(): void {
		if (!this.command) return;
		const run = async () => {
			try {
				const { stdout } = await execFileAsync("bash", ["-lc", this.command!], {
					timeout: 5_000,
					maxBuffer: 64 * 1024,
				});
				const text = stdout
					.replace(/\x1b\[[0-9;]*m/g, "")
					.split("\n")
					.map((line) => line.trim())
					.find(Boolean);
				const next = text ? text.slice(0, 60) : "";
				if (next !== this.commandText) {
					this.commandText = next;
					this.requestRender();
				}
			} catch {
				if (this.commandText) {
					this.commandText = "";
					this.requestRender();
				}
			}
		};
		void run();
		const schedule = () => {
			if (this.disposed) return;
			this.commandTimer = setTimeout(async () => {
				await run();
				schedule();
			}, 10_000);
			this.commandTimer.unref?.();
		};
		schedule();
	}

	private async refreshGit(): Promise<void> {
		try {
			const { stdout } = await execFileAsync("git", ["-C", this.cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
				timeout: 2_000,
			});
			const branch = stdout.trim();
			if (branch && branch !== "HEAD" && branch !== this.gitBranch) {
				this.gitBranch = branch;
				this.requestRender();
			}
		} catch {
			if (this.gitBranch) {
				this.gitBranch = "";
				this.requestRender();
			}
		}
	}

	private elapsed(): string {
		if (!this.busy || !this.busySince) return "";
		const seconds = Math.max(0, (Date.now() - this.busySince) / 1_000);
		if (seconds < 60) return `${seconds.toFixed(0)}s`;
		return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)
			.toString()
			.padStart(2, "0")}s`;
	}

	render(width: number): string[] {
		const model = this.session.model;
		const modelText = model ? model.id : "no-model";
		const thinking = this.session.thinkingLevel;
		const plan = this.getPlanMode();
		const permission = this.getPermissionMode();
		const has = (name: string) => this.segments.includes(name);
		const debug = this.getDebugMode();
		const modeText = plan
			? fg(MAGENTA + BOLD, "PLAN")
			: debug
				? fg(MAGENTA, "DEBUG")
				: fg(CYAN, MODE_LABEL[permission]);
		const spinner = this.busy
			? fg(YELLOW, `${spinnerFrame()} ${this.elapsed()}`)
			: fg(DIM, "idle");

		const leftCore: string[] = [spinner];
		if (has("mode")) leftCore.unshift(modeText);
		if (this.statusText) leftCore.push(fg(YELLOW, truncateText(this.statusText, 36)));
		if (this.queued > 0) leftCore.push(fg(DIM, `${this.queued} queued`));

		const rightCore: string[] = [];
		if (has("model")) rightCore.push(fg(GREEN, `${modelText}${this.freeModel ? "*" : ""}`));
		if (has("thinking")) rightCore.push(fg(DIM, thinking));
		if (has("ctx")) rightCore.push(fg(DIM, this.contextText));

		const leftExtras: string[] = [];
		const cwdLabel = path.basename(this.cwd) || this.cwd;
		if (has("cwd")) leftExtras.push(fg(DIM, cwdLabel));
		if (has("git") && this.gitBranch) leftExtras.push(fg(DIM, `git:${truncateText(this.gitBranch, 22)}`));
		if (has("bg") && this.backgroundCount > 0) leftExtras.push(fg(YELLOW, `bg ${this.backgroundCount}`));
		if (has("todos") && this.todoSummary) leftExtras.push(fg(DIM, `todo ${this.todoSummary}`));
		if (has("command") && this.commandText) leftExtras.push(fg(DIM, this.commandText));

		const rightExtras: string[] = [];
		if (has("tokens")) rightExtras.push(fg(DIM, `${formatTokens(this.statsTokens)} tok`));
		if (has("cost")) rightExtras.push(fg(DIM, this.freeModel ? "free" : formatCost(this.statsCost)));
		if (has("session") && this.sessionName) {
			rightExtras.push(fg(DIM, truncateText(this.sessionName, 20)));
		}
		if (has("clock")) {
			rightExtras.push(fg(DIM, new Date().toTimeString().slice(0, 5)));
		}

		const sep = `  ${fg(DIM, "·")}  `;
		let left = [...leftCore, ...leftExtras];
		let right = [...rightCore, ...rightExtras];
		if (left.length === 1) left = [spinner];
		if (right.length === 0) right = [fg(GREEN, modelText)];
		if (width < 76) {
			return [
				truncateAnsi(left.join(sep), width),
				truncateAnsi(right.join(sep), width),
			];
		}
		const measure = () => {
			const leftWidth = left.reduce((sum, part, index) => sum + visibleWidth(part) + (index ? 5 : 0), 0);
			const rightWidth = right.reduce((sum, part, index) => sum + visibleWidth(part) + (index ? 5 : 0), 0);
			return leftWidth + rightWidth + 2;
		};
		while (measure() > width && right.length > Math.min(2, rightCore.length || 1)) right.pop();
		while (measure() > width && left.length > Math.min(2, leftCore.length)) left.pop();
		while (measure() > width && right.length > 1) right.pop();
		const leftText = left.join(sep);
		const rightText = right.join(sep);
		const leftWidth = visibleWidth(leftText);
		const rightWidth = visibleWidth(rightText);
		const gap = width - leftWidth - rightWidth;
		let line: string;
		if (gap >= 0) {
			line = leftText + " ".repeat(gap) + rightText;
		} else {
			line = truncateAnsi(`${leftText}  ${rightText}`, width);
		}
		if (visibleWidth(line) < width) line += " ".repeat(width - visibleWidth(line));
		return [line];
	}

	invalidate(): void {
		// Values are read live on each render.
	}

	dispose(): void {
		this.disposed = true;
		this.stopBusyTimer();
		if (this.gitTimer) clearTimeout(this.gitTimer);
		if (this.commandTimer) clearTimeout(this.commandTimer);
		this.gitTimer = undefined;
		this.commandTimer = undefined;
	}
}

function truncateAnsi(text: string, width: number): string {
	const match = /\x1b\[[0-9;]*m/.exec(text);
	const prefix = match ? match[0] : "";
	let visible = 0;
	let output = "";
	let index = 0;
	while (index < text.length && visible < width) {
		if (text[index] === "\x1b") {
			const end = text.indexOf("m", index);
			if (end !== -1) {
				output += text.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		output += text[index];
		visible += 1;
		index += 1;
	}
	return prefix ? `${output}${RESET}` : output;
}
