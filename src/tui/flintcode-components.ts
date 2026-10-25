import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { ANSI } from "./palette.js";
import { spinnerFrame } from "./spinner.js";
import { formatDuration, oneLine, truncateText } from "../util/format.js";

const RESET = ANSI.reset;

function color(code: string, text: string): string {
	return `${code}${text}${RESET}`;
}

interface ProgressItem {
	agent: string;
	description: string;
	status: string;
	activity: string[];
	latestText: string;
	model?: string;
	thinking?: string;
}

interface AgentResultItem {
	agent: string;
	description: string;
	status: string;
	model?: string;
	thinking?: string;
	durationMs: number;
	output: string;
	error?: string;
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		cost: { total: number };
	};
}

function wrapCardLines(lines: string[], width: number): string[] {
	const output: string[] = [];
	for (const line of lines) {
		const leading = /^(\s*)/.exec(line)?.[1].length ?? 0;
		const body = line.slice(leading);
		const available = Math.max(12, width - leading);
		const pieces = wrapTextWithAnsi(body, available);
		pieces.forEach((piece, index) => {
			const indent = index === 0 ? leading : Math.min(leading + 2, Math.max(0, width - 3));
			output.push(`${" ".repeat(indent)}${piece}`);
		});
	}
	return output;
}

function statusColor(status: string): string {
	if (status === "done") return ANSI.green;
	if (status === "error" || status === "aborted") return ANSI.red;
	if (status === "running") return ANSI.accent;
	return ANSI.dim;
}

function statusGlyph(status: string): string {
	if (status === "done") return "●";
	if (status === "error" || status === "aborted") return "✕";
	if (status === "running") return spinnerFrame();
	return "○";
}

function usageLine(usage: AgentResultItem["usage"]): string | undefined {
	if (!usage) return undefined;
	return `${usage.input} in / ${usage.output} out · ${usage.cost.total === 0 ? "free" : `$${usage.cost.total.toFixed(4)}`}`;
}

const TOOL_LABELS: Record<string, string> = {
	bash: "Bash",
	bash_background: "Bash",
	bash_output: "BashOutput",
	bash_kill: "BashKill",
	edit: "Edit",
	write: "Write",
	read: "Read",
	grep: "Grep",
	find: "Find",
	ls: "LS",
	Agent: "Agent",
	agent_output: "AgentOutput",
	WebSearch: "WebSearch",
	WebFetch: "WebFetch",
	TodoWrite: "TodoWrite",
	todo_read: "TodoRead",
	EnterPlanMode: "EnterPlanMode",
	ExitPlanMode: "ExitPlanMode",
	ask_user: "AskUser",
	ScheduleWakeup: "ScheduleWakeup",
};

function toolLabel(name: string): string {
	return TOOL_LABELS[name] ?? name;
}

function firstArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!args) return undefined;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function toolArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const firstString = (): string | undefined => {
		for (const value of Object.values(args)) {
			if (typeof value === "string" && value) return value;
		}
		return undefined;
	};
	const value =
		firstArg(args, "command", "cmd") ??
		firstArg(args, "path", "file_path", "filePath") ??
		firstArg(args, "url", "query", "description", "text", "title", "pattern") ??
		firstString();
	if (name === "Agent") {
		const tasks = Array.isArray(args.tasks) ? args.tasks.length : 1;
		const description = firstArg(args, "description") ?? "agent task";
		return tasks > 1 ? `${description} · ${tasks} tasks` : description;
	}
	if (!value) {
		const keys = Object.keys(args).slice(0, 2);
		return keys.map((key) => `${key}=${String(args[key])}`).join(" ");
	}
	return oneLine(value);
}

export type ThinkingDisplayMode = "full" | "compact" | "hidden";

export class FlintcodeAssistantMessage extends Container {
	private thinkingMode: ThinkingDisplayMode;
	private streaming = false;
	private last?: AssistantMessage;

	constructor(message: AssistantMessage | undefined, thinkingMode: ThinkingDisplayMode = "compact") {
		super();
		this.thinkingMode = thinkingMode;
		if (message) this.updateContent(message, false);
	}

	setThinkingMode(mode: ThinkingDisplayMode): void {
		this.thinkingMode = mode;
		if (this.last) this.updateContent(this.last, this.streaming);
	}

	updateContent(message: AssistantMessage, isStreaming = false): void {
		this.last = message;
		this.streaming = isStreaming;
		this.clear();
		const parts: Array<{ kind: "thinking"; text: string } | { kind: "text"; text: string }> = [];
		for (const block of message.content) {
			if (block.type === "thinking" && block.thinking.trim()) {
				const last = parts[parts.length - 1];
				if (last?.kind === "thinking") last.text += `\n\n${block.thinking}`;
				else parts.push({ kind: "thinking", text: block.thinking });
			} else if (block.type === "text" && block.text.trim()) {
				const last = parts[parts.length - 1];
				if (last?.kind === "text") last.text += block.text;
				else parts.push({ kind: "text", text: block.text });
			}
		}
		for (const part of parts) {
			if (part.kind === "text") {
				this.addChild(new Markdown(part.text, 1, 0, getMarkdownTheme()));
				continue;
			}
			if (this.thinkingMode === "hidden") continue;
			const header = color(ANSI.accent, `${this.streaming ? spinnerFrame() : "◇"} Thinking`);
			const raw = part.text.trim();
			if (this.thinkingMode === "compact") {
				const preview = raw.split("\n").filter(Boolean).slice(0, 3).join("\n");
				const suffix = raw.split("\n").filter(Boolean).length > 3 ? `\n${color(ANSI.dim, "… Ctrl+T for full thinking")}` : "";
				this.addChild(new Text(`${header}\n${color(ANSI.muted, truncateText(preview, 600))}${suffix}`, 1, 0));
				continue;
			}
			const text = truncateText(raw, 8_000);
			this.addChild(new Text(`${header}\n${color(ANSI.muted, text)}`, 1, 0));
		}
	}

	invalidate(): void {
		super.invalidate();
		if (this.last) this.updateContent(this.last, false);
	}
}

export class FlintcodeToolCard extends Container {
	readonly toolName: string;
	readonly toolCallId: string;
	private args: Record<string, unknown>;
	private result?: {
		content?: Array<{ type: string; text?: string }>;
		details?: unknown;
		isError?: boolean;
		durationMs?: number;
	};
	private partial?: {
		content?: Array<{ type: string; text?: string }>;
		details?: unknown;
		isError?: boolean;
	};
	private expanded = false;
	private running = false;
	private startedAt?: number;
	private durationMs?: number;
	private overflowNote?: string;
	private readonly maxOutputChars: number;

	constructor(name: string, id: string, args: Record<string, unknown>, maxOutputChars = 32_000) {
		super();
		this.toolName = name;
		this.toolCallId = id;
		this.args = args;
		this.maxOutputChars = maxOutputChars;
		this.rebuild();
	}

	setOverflowNote(note: string): void {
		this.overflowNote = note;
	}

	private capResult<T extends { content?: Array<{ type: string; text?: string }> }>(result: T): T {
		if (!result.content?.length) return result;
		let remaining = this.maxOutputChars;
		let truncated = false;
		const content: Array<{ type: string; text?: string }> = [];
		for (const block of result.content) {
			if (block.type !== "text" || typeof block.text !== "string") {
				content.push(block);
				continue;
			}
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			if (block.text.length > remaining) {
				content.push({ ...block, text: truncateText(block.text, remaining) });
				remaining = 0;
				truncated = true;
			} else {
				content.push(block);
				remaining -= block.text.length;
			}
		}
		if (!truncated) return result;
		content.push({
			type: "text",
			text: `[output capped at ${this.maxOutputChars.toLocaleString()} chars to protect memory]`,
		});
		return { ...result, content };
	}

	updateArgs(args: Record<string, unknown>): void {
		this.args = args;
		this.rebuild();
	}

	markExecutionStarted(): void {
		this.running = true;
		this.startedAt = Date.now();
		this.rebuild();
	}

	setArgsComplete(): void {
		this.rebuild();
	}

	updateResult(
		result: {
			content?: Array<{ type: string; text?: string }>;
			details?: unknown;
			isError?: boolean;
			durationMs?: number;
		},
		isPartial = false,
	): void {
		const capped = this.capResult(result);
		if (isPartial) this.partial = capped;
		else {
			this.result = capped;
			this.running = false;
			this.durationMs = result.durationMs ?? (this.startedAt ? Date.now() - this.startedAt : undefined);
		}
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.rebuild();
	}

	invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	isRunning(): boolean {
		return this.running;
	}

	tick(): boolean {
		if (!this.running) return false;
		this.rebuild();
		return true;
	}

	override render(width: number): string[] {
		return wrapCardLines(this.renderLines(), width);
	}

	private rebuild(): void {
		// Rendering is computed with the current width in render().
	}

	private renderLines(): string[] {
		const lines = this.renderLinesInner();
		if (this.overflowNote) {
			lines.push(`  ${color(ANSI.dim, this.overflowNote)}`);
		}
		return lines;
	}

	private renderLinesInner(): string[] {
		if (this.toolName === "Agent") return this.renderAgent();
		const state = this.result?.isError ? "error" : this.running ? "running" : "done";
		const marker = color(statusColor(state), this.running ? spinnerFrame() : "▪");
		const label = color(ANSI.accentBright, toolLabel(this.toolName));
		const argument = truncateText(toolArg(this.toolName, this.args), 180);
		const duration = this.durationMs !== undefined ? `  ${color(ANSI.dim, formatDuration(this.durationMs))}` : "";
		const lines = [`${marker} ${label}(${color(ANSI.text, argument)})${duration}`];
		const text = this.outputText();
		const outputLines = text ? text.split("\n") : [];
		const isEdit = this.toolName === "edit" || this.toolName === "write";
		if (this.result?.isError) {
			const reason = outputLines[0] ?? "tool failed";
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.red, truncateText(reason, 180))}`);
			const rest = outputLines.slice(1, this.expanded ? undefined : 4);
			for (const line of rest) lines.push(`    ${color(ANSI.red, truncateText(line, 180))}`);
			return lines;
		}
		if (this.running) {
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.dim, "Running…")}`);
			if (outputLines[0]) lines.push(`    ${color(ANSI.muted, truncateText(outputLines[0], 180))}`);
			return lines;
		}
		if (isEdit) {
			const file = firstArg(this.args, "path", "file_path", "filePath");
			const name = file ? path.basename(file) : "file";
			const verb = this.toolName === "edit" ? "Accepted" : "Wrote";
			const hint = outputLines.length > 0 ? ` ${color(ANSI.dim, "(Ctrl+O to expand)")}` : "";
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.green, `${verb} ${name}`)}${hint}`);
			if (this.expanded) {
				for (const line of outputLines.slice(0, 80)) lines.push(`    ${color(ANSI.muted, line)}`);
			}
			return lines;
		}
		if (outputLines.length > 0) {
			const visible = this.expanded ? outputLines.slice(0, 200) : outputLines.slice(0, 4);
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.muted, truncateText(visible[0], 190))}`);
			for (const line of visible.slice(1)) lines.push(`    ${color(ANSI.muted, truncateText(line, 190))}`);
			if (!this.expanded && outputLines.length > 4) {
				lines.push(`    ${color(ANSI.dim, `… ${outputLines.length - 4} more lines (Ctrl+O to expand)`)}`);
			}
		} else {
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.dim, "Done")}`);
		}
		return lines;
	}

	private renderAgent(): string[] {
		const details = (this.result?.details ?? this.partial?.details) as
			| {
					kind?: string;
					progress?: ProgressItem[];
					results?: AgentResultItem[];
					usage?: AgentResultItem["usage"];
					background?: Array<{ id: string; agent: string; description: string }>;
			  }
			| undefined;
		const progress = details?.progress;
		const results = details?.results;
		const state = this.result?.isError
			? "error"
			: this.running
				? "running"
				: "done";
		const duration = this.durationMs !== undefined ? `  ${color(ANSI.dim, formatDuration(this.durationMs))}` : "";
		const description =
			typeof this.args.description === "string"
				? this.args.description
				: progress?.[0]?.description ?? "agent task";
		const marker = color(statusColor(state), this.running ? spinnerFrame() : "▪");
		const lines = [
			`${marker} ${color(ANSI.accentBright, "Agent")}(${color(ANSI.text, description)})${duration}`,
		];
		if (details?.background) {
			lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.green, `started ${details.background.length} background agent(s)`)}`);
			for (const record of details.background) {
				lines.push(
					`    ${color(ANSI.accentBright, record.agent)} · ${color(ANSI.muted, record.description)} · ${color(ANSI.dim, record.id)}`,
				);
			}
			return lines;
		}
		if (progress?.length) {
			const done = progress.filter((task) => task.status === "done").length;
			lines.push(
				`  ${color(ANSI.dim, "└")} ${color(ANSI.accent, `${done}/${progress.length} agents complete`)}`,
			);
			for (const task of progress) {
				const taskColor = statusColor(task.status);
				lines.push(
					`    ${color(taskColor, statusGlyph(task.status))} ${color(ANSI.accentBright, task.agent)}  ${color(ANSI.muted, task.description)}${task.model ? color(ANSI.dim, `  ${task.model}${task.thinking ? ` · reasoning:${task.thinking}` : ""}`) : ""}`,
				);
				for (const activity of task.activity.slice(this.expanded ? -12 : -2)) {
					lines.push(`      ${color(ANSI.dim, truncateText(activity, 160))}`);
				}
				if (task.latestText) {
					lines.push(
						`      ${color(ANSI.muted, `“${truncateText(task.latestText.replace(/\s+/g, " "), 170)}”`)}`,
					);
				}
			}
			return lines;
		}
		if (results?.length) {
			const usage = details?.usage ?? results[0]?.usage;
			const meta = [usageLine(usage)].filter(Boolean);
			lines.push(
				`  ${color(ANSI.dim, "└")} ${color(ANSI.green, `${results.filter((result) => result.status === "done").length}/${results.length} agents complete`)}${meta.length ? color(ANSI.dim, ` · ${meta.join(" · ")}`) : ""}`,
			);
			for (const result of results) {
				const taskColor = statusColor(result.status);
				lines.push(
					`    ${color(taskColor, statusGlyph(result.status))} ${color(ANSI.accentBright, result.agent)}  ${color(ANSI.muted, result.description)}  ${color(ANSI.dim, formatDuration(result.durationMs))}`,
				);
				const taskMeta = [
					result.model,
					result.thinking ? `reasoning:${result.thinking}` : undefined,
					usageLine(result.usage),
				].filter(Boolean);
				if (taskMeta.length) {
					lines.push(`      ${color(ANSI.dim, taskMeta.join(" · "))}`);
				}
				if (result.error) {
					lines.push(`      ${color(ANSI.red, truncateText(result.error, 200))}`);
				}
				const output = result.output.split("\n");
				const visible = this.expanded ? output : output.slice(0, 5);
				for (const line of visible) {
					lines.push(`      ${color(ANSI.muted, truncateText(line, 180))}`);
				}
				if (!this.expanded && output.length > 5) {
					lines.push(`      ${color(ANSI.dim, `… ${output.length - 5} more lines (Ctrl+O to expand)`)}`);
				}
			}
			return lines;
		}
		if (this.running) lines.push(`  ${color(ANSI.dim, "└")} ${color(ANSI.dim, "starting agents…")}`);
		return lines;
	}

	private outputText(): string {
		const source = this.result ?? this.partial;
		if (!source?.content) return "";
		return source.content
			.filter((block) => block.type === "text" && block.text)
			.map((block) => block.text!.trimEnd())
			.join("\n")
			.trim();
	}
}
