import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	UserMessageComponent,
	getMarkdownTheme,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, ScrollView, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FlintcodeAssistantMessage, FlintcodeToolCard, type ThinkingDisplayMode } from "./flintcode-components.js";
import { FlintcodeWelcomeComponent } from "./logo.js";
import { shortPath, truncateText } from "../util/format.js";
import { VERSION } from "../version.js";
import { ANSI } from "./palette.js";

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

export type NoticeKind = "info" | "success" | "warning" | "error";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			const typed = block as { type: string; text?: string };
			if (typed.type === "text" && typed.text) parts.push(typed.text);
			if (typed.type === "image") parts.push("[image]");
		}
	}
	return parts.join("\n");
}

export interface TranscriptOptions {
	tui: TUI;
	container: Container;
	scroll: ScrollView;
	cwd: string;
	session: AgentSession;
	hideThinking: boolean;
	thinkingMode?: ThinkingDisplayMode;
	limits?: {
		blocks?: number;
		historyMessages?: number;
		toolOutputChars?: number;
	};
	stateDir?: string;
}

export class TranscriptView {
	private readonly tui: TUI;
	private readonly container: Container;
	private readonly scroll: ScrollView;
	private cwd: string;
	private session: AgentSession;
	private hideThinking: boolean;
	private thinkingMode: ThinkingDisplayMode;
	private readonly assistantComponents: FlintcodeAssistantMessage[] = [];
	private liveAssistant?: FlintcodeAssistantMessage;
	private liveMessage?: AssistantMessage;
	private readonly toolCards = new Map<string, FlintcodeToolCard>();
	private toolsExpanded = false;
	private readonly maxBlocks: number;
	private readonly maxHistoryMessages: number;
	private readonly toolOutputChars: number;
	private readonly stateDir?: string;

	constructor(options: TranscriptOptions) {
		this.tui = options.tui;
		this.container = options.container;
		this.scroll = options.scroll;
		this.cwd = options.cwd;
		this.session = options.session;
		this.hideThinking = options.hideThinking;
		this.thinkingMode = options.thinkingMode ?? (options.hideThinking ? "hidden" : "compact");
		this.maxBlocks = options.limits?.blocks ?? 800;
		this.maxHistoryMessages = options.limits?.historyMessages ?? 400;
		this.toolOutputChars = options.limits?.toolOutputChars ?? 32_000;
		this.stateDir = options.stateDir;
	}

	setSession(session: AgentSession, cwd: string): void {
		this.session = session;
		this.cwd = cwd;
	}

	setHideThinking(hide: boolean): void {
		this.hideThinking = hide;
		this.setThinkingMode(hide ? "hidden" : "compact");
	}

	setThinkingMode(mode: ThinkingDisplayMode): void {
		this.thinkingMode = mode;
		this.hideThinking = mode === "hidden";
		for (const component of this.assistantComponents) component.setThinkingMode(mode);
		this.liveAssistant?.setThinkingMode(mode);
		this.tui.requestRender();
	}

	cycleThinkingMode(): ThinkingDisplayMode {
		const next =
			this.thinkingMode === "compact"
				? "full"
				: this.thinkingMode === "full"
					? "hidden"
					: "compact";
		this.setThinkingMode(next);
		return next;
	}

	private beforeEntry(): void {
		this.trimIfNeeded();
		if (this.container.children.length > 0) this.container.addChild(new Spacer(1));
	}

	private trimIfNeeded(): void {
		if (this.container.children.length <= this.maxBlocks) return;
		const keep = Math.max(50, Math.floor(this.maxBlocks * 0.75));
		const removeCount = this.container.children.length - keep;
		const removed = this.container.children.slice(0, removeCount);
		for (const child of removed) this.container.removeChild(child);
		const visible = new Set(this.container.children);
		const keptAssistants = this.assistantComponents.filter((component) => visible.has(component));
		this.assistantComponents.splice(0, this.assistantComponents.length, ...keptAssistants);
		for (const [id, card] of [...this.toolCards]) {
			if (!visible.has(card)) this.toolCards.delete(id);
		}
		if (this.liveAssistant && !visible.has(this.liveAssistant)) this.liveAssistant = undefined;
	}

	private offloadToolOutput(toolCallId: string, card: FlintcodeToolCard, content: unknown): void {
		if (!this.stateDir) return;
		const blocks = Array.isArray(content) ? content : [];
		const text = blocks
			.filter(
				(block): block is { type: string; text: string } =>
					Boolean(block) &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join("\n");
		if (text.length <= this.toolOutputChars) return;
		const safeSession = (this.session.sessionId || "session").replace(/[^a-zA-Z0-9._-]/g, "_");
		const safeCall = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_");
		const directory = path.join(this.stateDir, "tool-output", safeSession);
		const file = path.join(directory, `${safeCall}.txt`);
		void fs
			.mkdir(directory, { recursive: true })
			.then(() => fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 }))
			.then(() => {
				card.setOverflowNote(`full output: ${shortPath(file)}`);
				this.tui.requestRender();
			})
			.catch(() => undefined);
	}

	reset(): void {
		this.container.clear();
		this.assistantComponents.length = 0;
		this.liveAssistant = undefined;
		this.liveMessage = undefined;
		this.toolCards.clear();
	}

	clear(): void {
		this.reset();
		this.tui.requestRender();
	}

	addUser(text: string): void {
		if (!text.trim()) return;
		this.beforeEntry();
		this.container.addChild(new UserMessageComponent(truncateText(text.trim(), 64_000)));
		this.trimIfNeeded();
		this.tui.requestRender();
	}

	addNotice(text: string, kind: NoticeKind = "info"): void {
		const style =
			kind === "error" ? RED : kind === "warning" ? YELLOW : kind === "success" ? GREEN : DIM;
		const label = kind === "error" ? "error" : kind === "warning" ? "warn" : "flintcode";
		this.beforeEntry();
		this.container.addChild(new Text(fg(style, `${label}  ${text}`), 1, 0));
		this.tui.requestRender();
	}

	addMarkdown(text: string): void {
		this.beforeEntry();
		this.container.addChild(new Text(truncateText(text, 100_000), 1, 0));
		this.trimIfNeeded();
		this.tui.requestRender();
	}

	addPlan(planText: string): void {
		this.beforeEntry();
		this.container.addChild(new Text(fg(CYAN + BOLD, "◆ Plan"), 1, 0));
		this.container.addChild(new Markdown(truncateText(planText.trim(), 64_000), 1, 0, getMarkdownTheme()));
		this.trimIfNeeded();
		this.scroll.scrollToEnd();
		this.tui.requestRender();
	}

	addWelcome(options?: { resumed?: boolean; model?: string; sessionName?: string }): void {
		this.beforeEntry();
		this.container.addChild(
			new FlintcodeWelcomeComponent({
				version: VERSION,
				model: options?.model ?? this.session.model?.id ?? "no model",
				cwd: shortPath(this.cwd),
				resumed: options?.resumed,
				...(options?.sessionName ? { sessionName: options.sessionName } : {}),
				messageCount: options?.resumed
					? this.session.messages.filter((message) => message.role === "user" || message.role === "assistant").length
					: undefined,
			}),
		);
		this.trimIfNeeded();
		this.tui.requestRender();
	}

	messageStart(message: AgentMessage): void {
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text) this.addUser(text);
			return;
		}
		if (message.role === "custom") {
			if (message.display) {
				const text = contentText(message.content);
				if (text) this.addNotice(text, "info");
			}
			return;
		}
		if (message.role !== "assistant") return;
		const assistant = message as AssistantMessage;
		this.liveAssistant = new FlintcodeAssistantMessage(assistant, this.thinkingMode);
		this.assistantComponents.push(this.liveAssistant);
		this.liveMessage = assistant;
		this.beforeEntry();
		this.container.addChild(this.liveAssistant);
		this.tui.requestRender();
	}

	messageUpdate(message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const assistant = message as AssistantMessage;
		this.liveMessage = assistant;
		if (!this.liveAssistant) {
			this.liveAssistant = new FlintcodeAssistantMessage(assistant, this.thinkingMode);
			this.assistantComponents.push(this.liveAssistant);
			this.beforeEntry();
			this.container.addChild(this.liveAssistant);
		} else {
			this.liveAssistant.updateContent(assistant, true);
		}
	}

	messageEnd(message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const assistant = message as AssistantMessage;
		if (this.liveAssistant) {
			this.liveAssistant.updateContent(assistant, false);
		} else {
			this.liveAssistant = new FlintcodeAssistantMessage(assistant, this.thinkingMode);
			this.assistantComponents.push(this.liveAssistant);
			this.beforeEntry();
			this.container.addChild(this.liveAssistant);
		}
		if (assistant.stopReason === "error" && assistant.errorMessage) {
			this.addNotice(truncateText(assistant.errorMessage, 240), "error");
		} else if (assistant.stopReason === "aborted") {
			this.addNotice("response interrupted", "warning");
		}
		this.liveAssistant = undefined;
		this.liveMessage = undefined;
		this.tui.requestRender();
	}

	toolStart(toolName: string, toolCallId: string, args: unknown): void {
		const existing = this.toolCards.get(toolCallId);
		if (existing) {
			existing.updateArgs((args ?? {}) as Record<string, unknown>);
			existing.markExecutionStarted();
			existing.setArgsComplete();
			this.tui.requestRender();
			return;
		}
		const card = new FlintcodeToolCard(
			toolName,
			toolCallId,
			(args ?? {}) as Record<string, unknown>,
			this.toolOutputChars,
		);
		card.setExpanded(this.toolsExpanded);
		card.markExecutionStarted();
		card.setArgsComplete();
		this.toolCards.set(toolCallId, card);
		this.beforeEntry();
		this.container.addChild(card);
		this.tui.requestRender();
	}

	toolUpdate(toolCallId: string, partialResult: unknown): void {
		const card = this.toolCards.get(toolCallId);
		if (!card) return;
		const result = partialResult as {
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
		};
		card.updateResult(
			{
				content: result?.content ?? [],
				details: result?.details,
				isError: false,
			},
			true,
		);
		this.tui.requestRender();
	}

	toolEnd(
		toolCallId: string,
		result: unknown,
		isError: boolean,
		durationMs?: number,
	): void {
		const card = this.toolCards.get(toolCallId);
		if (!card) return;
		const value = result as {
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
		};
		this.offloadToolOutput(toolCallId, card, value?.content);
		card.updateResult(
			{
				content: value?.content ?? [],
				details: value?.details,
				isError,
				...(durationMs !== undefined ? { durationMs } : {}),
			},
			false,
		);
		if (isError) card.setExpanded(true);
		this.tui.requestRender();
	}

	setToolsExpanded(expanded: boolean): void {
		this.toolsExpanded = expanded;
		for (const card of this.toolCards.values()) card.setExpanded(expanded);
		this.tui.requestRender();
	}

	tickTools(): boolean {
		let running = false;
		for (const card of this.toolCards.values()) {
			if (card.tick()) running = true;
		}
		if (running) this.tui.requestRender();
		return running;
	}

	toggleTools(): boolean {
		this.setToolsExpanded(!this.toolsExpanded);
		return this.toolsExpanded;
	}

	renderHistory(session: AgentSession, cwd: string): void {
		this.setSession(session, cwd);
		this.reset();
		const allMessages = session.messages;
		const start = Math.max(0, allMessages.length - this.maxHistoryMessages);
		const messages = start > 0 ? allMessages.slice(start) : allMessages;
		if (start > 0) {
			this.container.addChild(
				new Text(
					fg(DIM, `… ${start} earlier messages not rendered (the full session remains on disk)`),
					1,
					0,
				),
			);
		}
		const results = new Map<
			string,
			{ content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean; durationMs?: number }
		>();
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const result = message as unknown as {
				toolCallId: string;
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
				isError: boolean;
				durationMs?: number;
			};
			results.set(result.toolCallId, {
				content: Array.isArray(result.content) ? result.content : [],
				details: result.details,
				isError: result.isError === true,
				...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
			});
		}
		for (const message of messages) {
			if (message.role === "user") {
				const text = contentText(message.content);
				if (text.trim()) {
					this.beforeEntry();
					this.container.addChild(new UserMessageComponent(text.trim()));
				}
			} else if (message.role === "custom") {
				if (message.display) {
					const text = contentText(message.content);
					if (text.trim()) {
						this.beforeEntry();
						this.container.addChild(new Text(fg(DIM, `flintcode  ${text}`), 1, 0));
					}
				}
			} else if (message.role === "assistant") {
				const assistant = message as AssistantMessage;
				const hasText = assistant.content.some(
					(block) =>
						(block.type === "text" && block.text.trim()) ||
						(block.type === "thinking" && block.thinking.trim()),
				);
				if (hasText) {
					this.beforeEntry();
					const component = new FlintcodeAssistantMessage(assistant, this.thinkingMode);
					this.assistantComponents.push(component);
					this.container.addChild(component);
				}
				for (const block of assistant.content) {
					if (block.type !== "toolCall") continue;
					const result = results.get(block.id);
					const card = new FlintcodeToolCard(
						block.name,
						block.id,
						(block.arguments ?? {}) as Record<string, unknown>,
						this.toolOutputChars,
					);
					if (result) {
						card.updateResult(result, false);
					} else {
						card.updateResult(
							{
								content: [
									{
										type: "text",
										text: "No result recorded (session ended or the tool was interrupted).",
									},
								],
								isError: true,
							},
							false,
						);
					}
					card.setExpanded(this.toolsExpanded);
					this.toolCards.set(block.id, card);
					this.beforeEntry();
					this.container.addChild(card);
				}
			}
		}
		if (this.container.children.length === 0) {
			this.addWelcome({ resumed: true, model: session.model?.id });
		}
		this.trimIfNeeded();
		this.scroll.scrollToEnd();
		this.tui.requestRender();
	}

	showHelp(): void {
		this.addMarkdown(
			[
				fg(BOLD, "Commands"),
				"  /help                 this help",
				"  /new                  start a new session",
				"  /resume               pick a previous session",
				"  /fork                 fork the current branch",
				"  /model [id]           switch model",
				"  /thinking [level]     switch thinking level",
				"  /compact [note]       compact the conversation",
				"  /context              context usage",
				"  /cost                 usage and cost",
				"  /status               session details",
				"  /tools                active tools",
				"  /mode [name]          select ask/auto/edits/noask/yolo/plan/debug",
				"  /search <query>       web search (no model call)",
				"  /fetch <url>          fetch a page as readable text",
				"  /docs [topic]         read Flintcode development docs",
				"  /reload               reload extensions/skills (not compiled UI)",
				"  /rename <name>        name this session",
				"  /clear                clear the transcript",
				"  /quit                 exit",
				"",
				fg(
					DIM,
					"Keys: Enter send · Alt+Enter newline · Ctrl+O tools · Ctrl+T thinking · Ctrl+C abort/exit · Ctrl+Q force quit",
				),
			].join("\n"),
		);
	}
}
