import * as path from "node:path";
import {
	SessionManager,
	copyToClipboard,
	getSelectListTheme,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionCommandContextActions,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	ProcessTerminal,
	ScrollView,
	TuiAltScreen,
	VStack,
	matchesKey,
	type EditorTheme,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AvailableModel } from "../core/models.js";
import {
	parseThinkingLevel,
	formatThinkingLevels,
	listModels,
	modelContextWindow,
	modelKey,
	resolveFlintcodeModel,
	isFreeModel,
} from "../core/models.js";
import type { FlintcodeConfig } from "../core/types.js";
import type { FlintcodePaths } from "../core/paths.js";
import { bootstrap } from "../cli/bootstrap.js";
import type { CliArgs } from "../cli/args.js";
import { createFlintcodeSessionHost, type FlintcodeSessionHost } from "../core/session-host.js";
import { PermissionEngine, type ApprovalChoice, type PermissionRequest } from "../core/permissions.js";
import { PlanController } from "../core/plan.js";
import { createFlintcodeExtensions } from "../extensions/index.js";
import { PERMISSION_MODES, loadHooksFile, patchFlintcodeConfig } from "../core/config.js";
import { HookRunner } from "../core/hooks.js";
import { MemoryService, formatMemory } from "../core/memory.js";
import { GoalService, formatGoals } from "../core/goals.js";
import { TaskManager, formatTaskRecord } from "../core/tasks.js";
import { LoopManager, formatLoops, parseInterval } from "../core/loops.js";
import { formatWorktrees, listWorktrees, createWorktree, removeWorktree } from "../core/worktrees.js";
import { OUTPUT_STYLES } from "../core/output-styles.js";
import { WebService, formatFetchResult, formatSearchResults } from "../core/web.js";
import { discoverAgents } from "../core/agent-runner.js";
import { SessionLock } from "../core/session-lock.js";
import { loadSessionTodos, formatTodos } from "../core/todos.js";
import * as fs from "node:fs/promises";
import { formatCost, formatTokens, oneLine, shortPath, truncateText } from "../util/format.js";
import { Statusline } from "./footer.js";
import { TranscriptView } from "./transcript.js";
import { renderFlintcodeStartLine } from "./logo.js";
import { showChoiceDialog, showInputDialog, showInputDialogAsync, showSelectDialog, type ChoiceDialogHandle } from "./dialogs.js";
import type { FlintcodeUiBridge } from "../core/ui-bridge.js";
import { listDocs, readDoc } from "../core/docs.js";
import { initFlintcodeTheme, TUI_THEMES } from "./theme.js";
import { ANSI } from "./palette.js";
import { VERSION } from "../version.js";

const RESET = ANSI.reset;
const DIM = ANSI.muted;
const CYAN = ANSI.accent;
const YELLOW = ANSI.yellow;
const MAGENTA = ANSI.accentBright;

// Rendering is the main UI cost on arm32. Throttle markdown reparses, tool
// repaints and HUD file polls instead of redrawing on every token/event.
const STREAM_RENDER_MS = 120;
const TOOL_RENDER_MS = 100;
const HUD_INTERVAL_MS = 8_000;

function fg(code: string, text: string): string {
	return `${code}${text}${RESET}`;
}

interface SlashCommandDefinition extends SlashCommand {
	handler: (args: string) => Promise<void> | void;
}

interface BootState {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	modelRuntime: ModelRuntime;
	trusted: boolean;
}

export async function runTui(args: CliArgs): Promise<number> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		throw new Error("Interactive mode needs a TTY. Use `flintcode -p \"...\"` for non-interactive runs.");
	}
	const boot = await bootstrap(args, { interactive: true });
	if (args.permissionMode) boot.config.permissions.mode = args.permissionMode;
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
	const activeTheme = initFlintcodeTheme(boot.config.ui.theme, boot.paths.home);
	if (activeTheme !== boot.config.ui.theme) {
		boot.logger.warn("theme unavailable; using fallback", {
			requested: boot.config.ui.theme,
			active: activeTheme,
		});
	}
	process.stderr.write(`\x1b[1m${renderFlintcodeStartLine()}\x1b[0m — loading models, providers and extensions…\n`);
	const hostStarted = Date.now();
	const permissionEngine = new PermissionEngine({
		cwd: args.cwd,
		mode: boot.config.permissions.mode,
		rules: cliRules,
		interactive: true,
		protectSecrets: boot.config.permissions.protectSecrets,
	});
	const planController = new PlanController(permissionEngine);
	const memory = new MemoryService(boot.paths, args.cwd);
	const goals = new GoalService(boot.paths, args.cwd);
	const uiBridge: FlintcodeUiBridge = {};
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
		selection: {
			resume: args.resume,
			continue: args.continue,
			fork: args.fork,
			sessionId: args.sessionId,
			noSession: args.noSession,
		},
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
			uiBridge,
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
	boot.logger.info("host ready", { ms: Date.now() - hostStarted });
	const state: BootState = {
		paths: boot.paths,
		config: boot.config,
		modelRuntime: boot.modelRuntime,
		trusted: boot.trust.trusted,
	};
	const app = new FlintcodeTui(
		args,
		state,
		host,
		permissionEngine,
		planController,
		memory,
		goals,
		hooksRunner,
		uiBridge,
	);
	try {
		return await app.run();
	} catch (error) {
		await host.dispose().catch(() => undefined);
		throw error;
	}
}

class FlintcodeTui {
	private readonly args: CliArgs;
	private readonly boot: BootState;
	private readonly host: FlintcodeSessionHost;
	private readonly permissions: PermissionEngine;
	private readonly plan: PlanController;
	private readonly memory: MemoryService;
	private readonly goals: GoalService;
	private readonly hooks?: HookRunner;
	private readonly tasks: TaskManager;
	private readonly loops: LoopManager;
	private readonly web: WebService;
	private readonly sessionLock: SessionLock;
	private hudTimer?: NodeJS.Timeout;
	private spinnerTimer?: NodeJS.Timeout;
	private readonly toolUpdateAt = new Map<string, number>();
	private pendingChoice?: ChoiceDialogHandle;
	private modalJobs: Array<{ start: () => Promise<void>; cancel: () => void }> = [];
	private modalRunning = false;
	private modalGeneration = 0;
	private readonly activeModalHandles = new Set<ChoiceDialogHandle>();
	private readonly terminal = new ProcessTerminal();
	private readonly screen: TuiAltScreen;
	private readonly transcriptContainer = new Container();
	private readonly scroll: ScrollView;
	private readonly transcript: TranscriptView;
	private readonly footer: Statusline;
	private readonly editor: Editor;
	private readonly root: VStack;
	private session: AgentSession;
	private unsubscribe?: () => void;
	private inputUnsubscribe?: () => void;
	private binding?: Promise<void>;
	private boundSession?: AgentSession;
	private busy = false;
	private planMode = false;
	private debugMode = false;
	private closing = false;
	private resolveExit?: (code: number) => void;
	private exitRequested = false;
	private exitCode = 0;
	private lastSigint = 0;
	private toastTimer?: NodeJS.Timeout;
	private pendingMessage?: AgentMessage;
	private flushTimer?: NodeJS.Timeout;
	private initialPromptSent = false;
	private signalHandler?: () => void;

	constructor(
		args: CliArgs,
		boot: BootState,
		host: FlintcodeSessionHost,
		permissions: PermissionEngine,
		plan: PlanController,
		memory: MemoryService,
		goals: GoalService,
		hooks: HookRunner | undefined,
		uiBridge: FlintcodeUiBridge,
	) {
		this.args = args;
		this.boot = boot;
		this.host = host;
		this.permissions = permissions;
		this.plan = plan;
		this.memory = memory;
		this.goals = goals;
		this.hooks = hooks;
		this.tasks = new TaskManager(boot.paths);
		this.session = host.runtime.session;
		this.sessionLock = new SessionLock(boot.paths.stateDir);
		this.web = new WebService(boot.config.web);
		this.loops = new LoopManager({
			paths: boot.paths,
			minIntervalMs: boot.config.loops.minIntervalMs,
			maxIterations: boot.config.loops.maxIterations,
			getSession: () => this.session,
			notify: (message, kind) => {
				this.transcript.addNotice(message, kind ?? "info");
			},
		});
		uiBridge.askUser = (question, options) => this.askUser(question, options);
		uiBridge.scheduleWakeup = (prompt, delaySeconds) => this.loops.scheduleOnce(prompt, delaySeconds);
		this.screen = new TuiAltScreen(this.terminal, true, undefined, {
			mouse: true,
			copyOnSelect: true,
			wheelScrollLines: "auto",
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
		this.scroll = new ScrollView(this.transcriptContainer, {
			follow: "end",
			primary: true,
			scrollbar: "auto",
		});
		this.footer = new Statusline({
			cwd: args.cwd,
			session: this.session,
			requestRender: () => this.screen.requestRender(),
			getPermissionMode: () => this.permissions.mode,
			getPlanMode: () => this.planMode,
			getDebugMode: () => this.debugMode,
			segments: boot.config.ui.statusline.segments,
			...(boot.config.ui.statusline.command
				? { command: boot.config.ui.statusline.command }
				: {}),
		});
		const editorTheme: EditorTheme = {
			borderColor: (text) =>
				this.busy ? `${YELLOW}${text}${RESET}` : this.planMode ? `${MAGENTA}${text}${RESET}` : `${DIM}${text}${RESET}`,
			selectList: getSelectListTheme(),
		};
		this.editor = new Editor(this.screen, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};
		this.transcript = new TranscriptView({
			tui: this.screen,
			container: this.transcriptContainer,
			scroll: this.scroll,
			cwd: args.cwd,
			session: this.session,
			hideThinking: boot.config.ui.hideThinking,
			thinkingMode: boot.config.ui.inlineThinkingMode,
			limits: {
				blocks: boot.config.ui.transcriptBlocks,
				historyMessages: boot.config.ui.historyMessages,
				toolOutputChars: boot.config.ui.toolOutputChars,
			},
			stateDir: boot.paths.stateDir,
		});
		this.root = new VStack([
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: this.editor, basis: "auto", shrink: 0, minSize: 3 },
			{ component: this.footer, basis: "auto", shrink: 0, minSize: 1 },
		]);
		this.permissions.setApprovalHandler((request) => this.requestPermission(request));
		this.plan.setApprovalHandler((planText) => this.approvePlan(planText));
		this.plan.setChangeHandler((active) => {
			this.planMode = active;
			this.footer.refresh();
			this.editor.invalidate();
			this.screen.requestRender();
			this.toast(active ? "plan mode on · edits blocked" : "plan mode off", 1_700);
		});
		this.setupAutocomplete();
	}

	async run(): Promise<number> {
		this.screen.setLayoutRoot(this.root);
		this.screen.setFocus(this.editor);
		this.screen.start();
		this.terminal.setTitle(`Flintcode ${VERSION} · ${path.basename(this.args.cwd)}`);
		this.installInputHandlers();
		this.renderStartupTranscript();
		this.editor.disableSubmit = true;
		this.footer.setStatus("loading session…");
		this.screen.requestRender();
		this.screen.renderNow(true);
		const firstPaint = setTimeout(() => {
			if (this.closing) return;
			this.screen.requestRender(true);
			this.screen.renderNow(true);
		}, 350);
		firstPaint.unref?.();
		this.startHud();
		this.signalHandler = () => {
			void this.quit(0);
		};
		process.once("SIGTERM", this.signalHandler);
		void this.bindSession(false).catch((error) => {
			if (this.closing) return;
			this.transcript.addNotice(error instanceof Error ? error.message : String(error), "error");
			this.editor.disableSubmit = false;
			this.footer.setStatus(undefined);
		});
		return new Promise<number>((resolve) => {
			this.resolveExit = resolve;
			if (this.exitRequested) resolve(this.exitCode);
		});
	}

	private renderStartupTranscript(): void {
		this.transcript.setSession(this.session, this.host.runtime.cwd);
		if (this.session.messages.length > 0) {
			this.transcript.renderHistory(this.session, this.host.runtime.cwd);
		} else {
			this.transcript.addWelcome({
				model: this.host.initialModel.model.id,
				...(this.session.sessionManager.getSessionName()
					? { sessionName: this.session.sessionManager.getSessionName() }
					: {}),
			});
		}
	}

	private async bindSession(clearTranscript: boolean): Promise<void> {
		if (this.binding) {
			await this.binding;
			return;
		}
		if (!clearTranscript && this.boundSession === this.host.runtime.session) return;
		this.binding = this.doBind(clearTranscript).finally(() => {
			this.binding = undefined;
		});
		await this.binding;
	}

	private async doBind(clearTranscript: boolean): Promise<void> {
		this.cancelModals();
		this.permissions.setProtectSecrets(this.boot.config.permissions.protectSecrets);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.session = this.host.runtime.session;
		const sessionFile = this.session.sessionManager.getSessionFile?.();
		if (sessionFile) {
			await this.sessionLock.acquire(this.session.sessionId, this.host.runtime.cwd);
		} else {
			await this.sessionLock.release();
		}
		this.plan.attachSession(this.session);
		await this.loops.setSession(this.session);
		this.transcript.setSession(this.session, this.host.runtime.cwd);
		this.footer.setSession(this.session);
		this.footer.setStatus("loading session…");
		this.screen.requestRender();
		await this.session.bindExtensions({
			mode: "tui",
			commandContextActions: this.extensionActions(),
			abortHandler: () => {
				void this.session.abort();
			},
			onError: (error) => {
				if (this.closing) return;
				this.transcript.addNotice(
					`extension ${path.basename(error.extensionPath)}: ${truncateText(error.error, 200)}`,
					"warning",
				);
			},
		});
		this.unsubscribe = this.session.subscribe((event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				if (!this.closing) {
					this.transcript.addNotice(
						`tui event error: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
		});
		if (clearTranscript) {
			this.transcript.reset();
			if (this.session.messages.length > 0) {
				this.transcript.renderHistory(this.session, this.host.runtime.cwd);
				this.transcript.addNotice("session loaded", "info");
			} else {
				this.transcript.addWelcome({ model: this.host.initialModel.model.id });
			}
		}
		this.boundSession = this.session;
		this.setupAutocomplete();
		this.busy = this.session.isStreaming;
		this.footer.setBusy(this.busy);
		this.editor.disableSubmit = false;
		this.footer.setStatus(undefined);
		if (
			!this.host.resumed &&
			this.host.initialModel.note &&
			this.boot.config.defaults.provider &&
			this.session.model?.provider !== this.boot.config.defaults.provider
		) {
			try {
				const desired = await resolveFlintcodeModel(
					this.session.modelRuntime,
					this.boot.config,
				);
				if (
					desired.model.provider === this.boot.config.defaults.provider &&
					modelKey(desired.model) !==
						(this.session.model ? modelKey(this.session.model) : "")
				) {
					await this.session.setModel(desired.model);
					this.toast(`model: ${modelKey(desired.model)}`, 1_800);
				}
			} catch {
				this.transcript.addNotice(
					`${this.boot.config.defaults.provider}/${this.boot.config.defaults.model} is not available yet; staying on ${this.session.model?.id ?? "the fallback model"}.`,
					"warning",
				);
			}
		}
		this.footer.refresh();
		this.screen.requestRender();
		this.screen.renderNow(true);
		const afterBindPaint = setTimeout(() => {
			if (this.closing) return;
			this.screen.requestRender(true);
			this.screen.renderNow(true);
		}, 350);
		afterBindPaint.unref?.();
		if (!this.initialPromptSent && this.args.prompt) {
			this.initialPromptSent = true;
			await this.submitText(this.args.prompt);
		}
	}

	private extensionActions(): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.session.waitForIdle(),
			newSession: async (options) => {
				const result = await this.host.runtime.newSession(options);
				await this.afterReplacement();
				return { cancelled: result.cancelled };
			},
			fork: async (entryId, options) => {
				const result = await this.host.runtime.fork(entryId, options);
				await this.afterReplacement();
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.session.navigateTree(targetId, options);
				this.transcript.reset();
				if (this.session.messages.length > 0) {
					this.transcript.renderHistory(this.session, this.host.runtime.cwd);
				} else {
					this.transcript.addWelcome({ model: this.session.model?.id });
				}
				this.footer.refresh();
				this.screen.requestRender();
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => {
				const result = await this.host.runtime.switchSession(sessionPath, options);
				await this.afterReplacement();
				return { cancelled: result.cancelled };
			},
			reload: async () => {
				await this.session.reload();
				await this.bindSession(true);
			},
		};
	}

	private async afterReplacement(): Promise<void> {
		if (this.host.runtime.session !== this.session) {
			await this.bindSession(true);
		}
	}

	private handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.setBusy(true);
				break;
			case "agent_end":
				this.flushAssistant();
				break;
			case "agent_settled":
				this.flushAssistant();
				this.setBusy(false);
				this.footer.refresh();
				this.screen.requestRender();
				break;
			case "message_start":
				this.transcript.messageStart(event.message);
				break;
			case "message_update":
				this.scheduleAssistant(event.message);
				break;
			case "message_end":
				this.flushAssistant();
				this.transcript.messageEnd(event.message);
				this.footer.refresh();
				this.screen.requestRender();
				break;
			case "tool_execution_start":
				this.toolUpdateAt.delete(event.toolCallId);
				this.transcript.toolStart(event.toolName, event.toolCallId, event.args);
				break;
			case "tool_execution_update": {
				const now = Date.now();
				const last = this.toolUpdateAt.get(event.toolCallId) ?? 0;
				if (now - last >= TOOL_RENDER_MS) {
					this.toolUpdateAt.set(event.toolCallId, now);
					this.transcript.toolUpdate(event.toolCallId, event.partialResult);
				}
				break;
			}
			case "tool_execution_end":
				this.toolUpdateAt.delete(event.toolCallId);
				this.transcript.toolEnd(event.toolCallId, event.result, event.isError, event.durationMs);
				this.footer.refresh();
				break;
			case "queue_update":
				this.footer.setQueued(event.steering.length + event.followUp.length);
				break;
			case "compaction_start":
				this.footer.setStatus("compacting…");
				break;
			case "compaction_end":
				this.footer.setStatus(undefined);
				if (event.errorMessage) this.transcript.addNotice(event.errorMessage, "error");
				else if (!event.aborted) this.transcript.addNotice("context compacted", "success");
				this.footer.refresh();
				break;
			case "auto_retry_start":
				this.footer.setStatus(`retrying ${event.attempt}/${event.maxAttempts}…`);
				break;
			case "auto_retry_end":
				this.footer.setStatus(undefined);
				if (event.success) this.transcript.addNotice("retry succeeded", "success");
				break;
			case "thinking_level_changed":
				this.footer.refresh();
				this.screen.requestRender();
				break;
			case "session_info_changed":
				this.footer.refresh();
				this.screen.requestRender();
				break;
			default:
				break;
		}
	}

	private scheduleAssistant(message: AgentMessage): void {
		this.pendingMessage = message;
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flushAssistant();
		}, STREAM_RENDER_MS);
	}

	private flushAssistant(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const message = this.pendingMessage;
		this.pendingMessage = undefined;
		if (message) {
			this.transcript.messageUpdate(message);
			this.footer.refresh();
			this.screen.requestRender();
		}
	}

	private setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		this.footer.setBusy(busy);
		if (busy) {
			this.startSpinner();
		} else {
			this.stopSpinner();
		}
		this.editor.invalidate();
		this.screen.requestRender();
	}

	private startSpinner(): void {
		this.stopSpinner();
		this.spinnerTimer = setInterval(() => {
			this.transcript.tickTools();
		}, 220);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	private installInputHandlers(): void {
		this.inputUnsubscribe = this.screen.addInputListener((data) => {
			if (matchesKey(data, "ctrl+q")) {
				this.toast("force quitting…", 500);
				void this.quit(0, true);
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				this.cancelModals();
				const now = Date.now();
				if (this.busy) {
					void this.abort();
					this.toast("interrupted", 1_500);
				} else if (now - this.lastSigint < 1_500) {
					void this.quit(0);
				} else {
					this.lastSigint = now;
					this.toast("press Ctrl+C again to exit", 1_500);
				}
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d")) {
				if (!this.editor.getText()) {
					void this.quit(0);
					return { consume: true };
				}
				return undefined;
			}
			if (matchesKey(data, "ctrl+o")) {
				const expanded = this.transcript.toggleTools();
				this.toast(expanded ? "tool output expanded" : "tool output collapsed", 1_200);
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+t")) {
				const mode = this.transcript.cycleThinkingMode();
				void this.patchConfig((config) => {
					config.ui.inlineThinkingMode = mode;
				});
				this.toast(`thinking display: ${mode}`, 1_300);
				return { consume: true };
			}
			if (matchesKey(data, "escape")) {
				if (this.pendingChoice) return undefined;
				if (this.busy) {
					void this.abort();
					return { consume: true };
				}
				return undefined;
			}
			return undefined;
		});
	}

	private async abort(): Promise<void> {
		this.cancelModals();
		try {
			await this.session.abort();
		} catch (error) {
			this.transcript.addNotice(error instanceof Error ? error.message : String(error), "warning");
		}
	}

	private async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.setText("");
		this.editor.addToHistory(text);
		await this.submitText(text);
	}

	private async submitText(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
			const handled = await this.handleSlash(trimmed);
			if (handled) return;
		}
		try {
			if (this.session.isStreaming) {
				await this.session.prompt(trimmed, { streamingBehavior: "followUp", source: "interactive" });
				this.toast("queued after the current turn", 1_500);
			} else {
				this.footer.setStatus("sending…");
				await this.session.prompt(trimmed, { source: "interactive" });
				this.footer.setStatus(undefined);
			}
		} catch (error) {
			this.footer.setStatus(undefined);
			this.transcript.addNotice(error instanceof Error ? error.message : String(error), "error");
		}
	}

	private async handleSlash(text: string): Promise<boolean> {
		const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (!match) return false;
		const name = match[1];
		const argument = match[2]?.trim() ?? "";
		const command = this.commandDefinitions().find((entry) => entry.name === name);
		if (!command) return false;
		try {
			await command.handler(argument);
		} catch (error) {
			this.transcript.addNotice(
				`/${name}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return true;
	}

	private commandDefinitions(): SlashCommandDefinition[] {
		return [
			{ name: "help", description: "Show command help", handler: () => this.transcript.showHelp() },
			{ name: "quit", description: "Exit Flintcode", handler: async () => this.quit(0) },
			{ name: "exit", description: "Exit Flintcode", handler: async () => this.quit(0) },
			{ name: "clear", description: "Clear the transcript", handler: () => {
				this.transcript.reset();
				this.transcript.addWelcome({ model: this.session.model?.id });
			} },
			{ name: "new", description: "Start a new session", handler: async () => {
				await this.host.runtime.newSession();
				await this.afterReplacement();
				this.toast("new session", 1_500);
			} },
			{ name: "resume", description: "Resume a previous session", handler: async () => this.showSessions() },
			{ name: "sessions", description: "List sessions", handler: async () => this.showSessions() },
			{ name: "fork", description: "Fork the current branch", handler: async () => this.forkSession() },
			{ name: "model", description: "Switch model", argumentHint: "<provider|model>", handler: async (argument) => {
				const normalized = argument.trim();
				if (!normalized) await this.showProviderPicker();
				else await this.handleModelArgument(normalized);
			} },
			{ name: "thinking", description: "Set thinking level", argumentHint: "<level>", handler: async (argument) => {
				if (argument) {
					const level = parseThinkingLevel(argument);
					if (!level) throw new Error(`Use one of: ${formatThinkingLevels()}`);
					this.session.setThinkingLevel(level);
					this.footer.refresh();
					this.toast(`thinking: ${level}`, 1_500);
				} else {
					this.showThinkingPicker();
				}
			} },
			{ name: "mode", description: "Select session mode", argumentHint: "ask|auto|accept-edits|dont-ask|yolo|plan|debug", handler: async (argument) => this.handleMode(argument) },
			{ name: "modes", description: "Alias for /mode", handler: async (argument) => this.handleMode(argument) },
			{ name: "plan", description: "Toggle plan mode", argumentHint: "[on|off|task]", handler: async (argument) => this.handlePlan(argument) },
			{ name: "permissions", description: "Set permission mode", argumentHint: "<mode>", handler: async (argument) => this.showPermissionModes(argument) },
			{ name: "loop", description: "Schedule a recurring prompt", argumentHint: "<interval> <prompt> | list | stop <id>", handler: async (argument) => this.handleLoop(argument) },
			{ name: "cron", description: "Alias for /loop", argumentHint: "<interval> <prompt>", handler: async (argument) => this.handleLoop(argument) },
			{ name: "worktree", description: "Manage git worktrees", argumentHint: "[list|create|remove] [name]", handler: async (argument) => this.handleWorktree(argument) },
			{ name: "output-style", description: "Set the output style", argumentHint: "<name>", handler: async (argument) => this.handleOutputStyle(argument) },
			{ name: "theme", description: "Set the terminal theme", argumentHint: "<name>", handler: async (argument) => this.handleTheme(argument) },
			{ name: "docs", description: "Read Flintcode's development docs", argumentHint: "[topic]", handler: async (argument) => this.handleDocs(argument) },
			{ name: "reload", description: "Reload extensions, skills and tools", handler: async () => this.handleReload() },
			{ name: "search", description: "Search the web", argumentHint: "<query>", handler: async (argument) => this.handleSearch(argument) },
			{ name: "fetch", description: "Fetch a URL as text", argumentHint: "<url>", handler: async (argument) => this.handleFetch(argument) },
			{ name: "statusline", description: "Show statusline configuration", handler: async () => {
				const statusline = this.boot.config.ui.statusline;
				this.transcript.addMarkdown(
					[
						fg(CYAN, "Statusline"),
						`  segments: ${statusline.segments.join(", ")}`,
						`  command:  ${statusline.command ?? "(none)"}`,
						`  config:   ${shortPath(this.boot.paths.configFile)}`,
					].join("\n"),
				);
			} },
			{ name: "compact", description: "Compact the conversation", argumentHint: "[instructions]", handler: async (argument) => {
				this.footer.setStatus("compacting…");
				try {
					await this.session.compact(argument || undefined);
					this.transcript.addNotice("context compacted", "success");
				} finally {
					this.footer.setStatus(undefined);
					this.footer.refresh();
				}
			} },
			{ name: "context", description: "Show context usage", handler: async () => this.showContext() },
			{ name: "cost", description: "Show usage and cost", handler: async () => this.showCost() },
			{ name: "status", description: "Show session status", handler: async () => this.showStatus() },
			{ name: "tools", description: "Show active tools", handler: async () => {
				const tools = this.session.getActiveToolNames();
				this.transcript.addMarkdown(
					`${fg(CYAN, "Active tools")} (${tools.length})\n${tools.map((tool) => `  ${tool}`).join("\n")}`,
				);
			} },
			{ name: "rename", description: "Rename this session", argumentHint: "<name>", handler: async (argument) => {
				if (!argument) {
					showInputDialog({
						tui: this.screen,
						title: "Rename session",
						placeholder: "session name",
						value: this.session.sessionManager.getSessionName() ?? "",
						onSubmit: (value) => this.renameSession(value),
						restoreFocus: () => this.screen.setFocus(this.editor),
					});
					return;
				}
				this.renameSession(argument);
			} },
			{ name: "copy", description: "Copy the last response", handler: async () => {
				const text = this.session.getLastAssistantText();
				if (!text) throw new Error("There is no assistant response to copy.");
				await copyToClipboard(text);
				this.toast("copied last response", 1_500);
			} },
			{ name: "todos", description: "Show session todos", handler: async () => {
				const store = await loadSessionTodos(this.boot.paths, this.session.sessionId);
				this.transcript.addMarkdown(formatTodos(store));
			} },
			{ name: "tasks", description: "Show background tasks", handler: async () => {
				const records = await this.tasks.list();
				this.transcript.addMarkdown(
					records.length === 0
						? "No background tasks."
						: `${fg(CYAN, "Background tasks")} (${records.length})\n\n${records.map(formatTaskRecord).join("\n\n")}`,
				);
			} },
			{ name: "agents", description: "List subagent definitions", handler: async () => {
				const agents = await discoverAgents({
					paths: this.boot.paths,
					config: this.boot.config,
					cwd: this.host.runtime.cwd,
					projectTrusted: this.boot.trusted,
				});
				this.transcript.addMarkdown(
					agents
						.map(
							(agent) =>
								`${fg(CYAN, agent.name)} · ${agent.source}\n  ${agent.description}\n  tools: ${(agent.tools ?? ["read", "grep", "find", "ls"]).join(", ")}`,
						)
						.join("\n"),
				);
			} },
			{ name: "memory", description: "Search saved memory", argumentHint: "[query]", handler: async (argument) => {
				const records = argument ? await this.memory.search(argument, 12) : await this.memory.list();
				this.transcript.addMarkdown(formatMemory(records));
			} },
			{ name: "remember", description: "Save a memory", argumentHint: "<text>", handler: async (argument) => {
				if (!argument) throw new Error("Usage: /remember <text>");
				const record = await this.memory.save({
					text: argument,
					scope: "project",
					source: "user",
				});
				this.toast(`saved memory ${record.id.slice(0, 10)}`, 1_500);
			} },
			{ name: "goal", description: "List or manage goals", argumentHint: "[add|pause|resume|complete|delete] [text/id]", handler: async (argument) => this.handleGoal(argument) },
			{ name: "hooks", description: "List configured hooks", handler: async () => {
				const hooks = this.hooks?.list() ?? [];
				if (hooks.length === 0) {
					this.transcript.addMarkdown("No hooks configured. Add them in ~/.flintcode/hooks.json.");
					return;
				}
				this.transcript.addMarkdown(
					hooks
						.map(
							(hook) =>
								`${hook.enabled === false ? "[disabled] " : ""}${hook.id} · ${hook.event}${hook.matcher?.tool ? ` · tool:${hook.matcher.tool}` : ""}\n  ${truncateText(hook.command ?? hook.prompt ?? "", 180)}`,
						)
						.join("\n"),
				);
			} },
			{ name: "mcp", description: "List MCP configuration", handler: async () => {
				const files = [this.boot.paths.mcpFile, path.join(this.host.runtime.cwd, ".pi", "mcp.json")];
				const lines: string[] = [];
				for (const file of files) {
					try {
						const raw = await fs.readFile(file, "utf8");
						const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
						const names = Object.keys(parsed.mcpServers ?? {});
						lines.push(`${shortPath(file)}: ${names.length ? names.join(", ") : "(empty)"}`);
					} catch {
						lines.push(`${shortPath(file)}: not found`);
					}
				}
				this.transcript.addMarkdown([fg(CYAN, "MCP servers"), ...lines].join("\n"));
			} },
		];
	}

	private setupAutocomplete(): void {
		const commands = new Map<string, SlashCommand>();
		for (const command of this.commandDefinitions()) {
			commands.set(command.name, {
				name: command.name,
				description: command.description,
				...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
			});
		}
		const modelCommand = commands.get("model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = async (prefix: string) => {
				const models = await listModels(this.session.modelRuntime);
				const needle = prefix.toLowerCase();
				return models
					.filter((entry) => entry.available && entry.key.toLowerCase().includes(needle))
					.map((entry) => ({
						value: entry.key,
						label: entry.model.id,
						description: `${entry.model.provider}${entry.free ? " · free" : ""}`,
					}));
			};
		}
		const thinkingCommand = commands.get("thinking");
		if (thinkingCommand) {
			thinkingCommand.getArgumentCompletions = (prefix: string) =>
				this.session
					.getAvailableThinkingLevels()
					.filter((level) => level.startsWith(prefix))
					.map((level) => ({ value: level, label: level }));
		}
		try {
			for (const extension of this.session.resourceLoader.getExtensions().extensions) {
				for (const command of extension.commands.values()) {
					if (!commands.has(command.name)) {
						commands.set(command.name, {
							name: command.name,
							description: command.description,
							...(command.getArgumentCompletions
								? { getArgumentCompletions: command.getArgumentCompletions }
								: {}),
						});
					}
				}
			}
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (!commands.has(name)) {
					commands.set(name, { name, description: skill.description });
				}
			}
		} catch {
			// Resource discovery may not be complete before the session binds.
		}
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([...commands.values()], this.host.runtime.cwd, null),
		);
	}

	private async usableModels(): Promise<AvailableModel[]> {
		const current = this.session.model ? modelKey(this.session.model) : undefined;
		const models = await listModels(this.session.modelRuntime);
		return models.filter((entry) => entry.available || entry.key === current);
	}

	private async showProviderPicker(): Promise<void> {
		const models = await this.usableModels();
		const currentProvider = this.session.model?.provider.toLowerCase();
		const providers = new Map<string, { count: number; free: number; current: boolean }>();
		for (const entry of models) {
			const provider = entry.model.provider.toLowerCase();
			const record = providers.get(provider) ?? { count: 0, free: 0, current: provider === currentProvider };
			record.count += 1;
			if (entry.free) record.free += 1;
			record.current ||= provider === currentProvider;
			providers.set(provider, record);
		}
		const items = [...providers.entries()]
			.sort(
				(left, right) =>
					Number(right[1].current) - Number(left[1].current) ||
					right[1].count - left[1].count ||
					left[0].localeCompare(right[0]),
			)
			.map(([provider, record]) => ({
				value: provider,
				label: `${provider}${record.current ? "  ← current" : ""}`,
				description: `${record.count} available${record.free ? ` · ${record.free} free` : ""}`,
			}));
		showSelectDialog({
			tui: this.screen,
			title: `Model provider — ${items.length} providers`,
			items,
			maxVisible: 12,
			onSelect: async (value) => {
				await this.showModelPicker(value);
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async showModelPicker(filter?: string): Promise<void> {
		const allModels = await this.usableModels();
		const current = this.session.model ? modelKey(this.session.model) : undefined;
		const needle = filter?.trim().toLowerCase();
		const filtered = needle
			? allModels.filter((entry) => {
					const provider = entry.model.provider.toLowerCase();
					if (provider === needle) return true;
					const name = entry.model.name.toLowerCase();
					return (
						entry.key.toLowerCase().includes(needle) ||
						entry.model.id.toLowerCase().includes(needle) ||
						name.includes(needle)
					);
				})
			: allModels;
		const sorted = [...filtered].sort((left, right) => {
			const leftScore = (left.available ? 2 : 0) + (left.free ? 1 : 0) + (left.key === current ? 4 : 0);
			const rightScore = (right.available ? 2 : 0) + (right.free ? 1 : 0) + (right.key === current ? 4 : 0);
			return rightScore - leftScore || left.key.localeCompare(right.key);
		});
		if (sorted.length === 1) {
			await this.setModel(sorted[0].key);
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: `Model — ${sorted.length}${filter ? ` matching “${filter}”` : ""}`,
			items: sorted.map((entry) => ({
				value: entry.key,
				label: `${entry.model.id}${entry.key === current ? "  ← current" : ""}`,
				description: [
					entry.model.provider,
					modelContextWindow(entry.model),
					entry.free ? "free" : undefined,
					entry.available ? undefined : "no auth",
				]
					.filter(Boolean)
					.join(" · "),
			})),
			maxVisible: 12,
			onSelect: async (value) => {
				await this.setModel(value);
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async handleModelArgument(argument: string): Promise<void> {
		const normalized = argument.toLowerCase();
		const models = await this.usableModels();
		const exactKey = models.find((entry) => entry.key.toLowerCase() === normalized);
		if (exactKey) {
			await this.setModel(exactKey.key);
			return;
		}
		if (models.some((entry) => entry.model.provider.toLowerCase() === normalized)) {
			await this.showModelPicker(normalized);
			return;
		}
		const exactId = models.filter((entry) => entry.model.id.toLowerCase() === normalized);
		if (exactId.length === 1) {
			await this.setModel(exactId[0].key);
			return;
		}
		const matches = models.filter((entry) => {
			const name = entry.model.name.toLowerCase();
			return (
				entry.key.toLowerCase().includes(normalized) ||
				entry.model.provider.toLowerCase().includes(normalized) ||
				entry.model.id.toLowerCase().includes(normalized) ||
				name.includes(normalized)
			);
		});
		if (matches.length > 1) {
			await this.showModelPicker(argument);
			return;
		}
		await this.setModel(argument);
	}

	private async setModel(spec: string): Promise<void> {
		const resolved = await resolveFlintcodeModel(this.session.modelRuntime, this.boot.config, spec);
		await this.session.setModel(resolved.model);
		if (resolved.thinkingLevel) this.session.setThinkingLevel(resolved.thinkingLevel);
		this.footer.refresh();
		this.toast(`model: ${modelKey(resolved.model)}`, 2_000);
		this.screen.requestRender();
	}

	private showThinkingPicker(): void {
		const levels = this.session.getAvailableThinkingLevels();
		const current = this.session.thinkingLevel;
		showSelectDialog({
			tui: this.screen,
			title: "Thinking level",
			items: levels.map((level) => ({
				value: level,
				label: `${level}${level === current ? "  ← current" : ""}`,
			})),
			onSelect: (value) => {
				const level = parseThinkingLevel(value);
				if (!level) return;
				this.session.setThinkingLevel(level);
				this.footer.refresh();
				this.toast(`thinking: ${level}`, 1_500);
				this.screen.requestRender();
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async showSessions(): Promise<void> {
		const sessions = await SessionManager.listAll(this.boot.paths.sessionsDir);
		sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
		if (sessions.length === 0) {
			this.toast("no sessions yet", 1_500);
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: "Sessions",
			items: sessions.slice(0, 100).map((session) => ({
				value: session.path,
				label: `${session.name || oneLine(session.firstMessage).slice(0, 48) || "(empty)"}`,
				description: `${session.id.slice(0, 8)} · ${session.modified.toISOString().slice(0, 16).replace("T", " ")} · ${session.cwd ? shortPath(session.cwd) : "?"}`,
			})),
			maxVisible: 12,
			onSelect: async (sessionPath) => {
				await this.host.runtime.switchSession(sessionPath);
				await this.afterReplacement();
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async forkSession(): Promise<void> {
		const leafId = this.session.sessionManager.getLeafId();
		if (!leafId) throw new Error("There is no branch to fork yet.");
		await this.host.runtime.fork(leafId, { position: "at" });
		await this.afterReplacement();
		this.toast("session forked", 1_500);
	}

	private renameSession(name: string): void {
		const trimmed = name.trim();
		if (!trimmed) return;
		this.session.setSessionName(trimmed);
		this.footer.refresh();
		this.toast(`renamed: ${trimmed}`, 1_500);
		this.screen.requestRender();
	}

	private async showContext(): Promise<void> {
		const usage = this.session.getContextUsage();
		const stats = this.session.getSessionStats();
		const lines = [
			fg(CYAN, "Context"),
			`  tokens:       ${usage?.tokens == null ? "unknown" : formatTokens(usage.tokens)}`,
			`  window:       ${formatTokens(usage?.contextWindow ?? this.session.model?.contextWindow ?? 0)}`,
			`  used:         ${usage?.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`}`,
			`  messages:     ${stats.totalMessages}`,
			`  auto-compact: ${this.session.autoCompactionEnabled ? "on" : "off"}`,
		];
		this.transcript.addMarkdown(lines.join("\n"));
	}

	private async showCost(): Promise<void> {
		const stats = this.session.getSessionStats();
		const free = this.session.model ? isFreeModel(this.session.model) : false;
		const lines = [
			fg(CYAN, "Usage"),
			`  input:     ${formatTokens(stats.tokens.input)}`,
			`  output:    ${formatTokens(stats.tokens.output)}`,
			`  cache:     ${formatTokens(stats.tokens.cacheRead)} read / ${formatTokens(stats.tokens.cacheWrite)} write`,
			`  total:     ${formatTokens(stats.tokens.total)}`,
			`  cost:      ${free ? "free model · $0.00" : formatCost(stats.cost)}`,
			`  model:     ${this.session.model?.provider ?? "?"}/${this.session.model?.id ?? "?"}`,
		];
		this.transcript.addMarkdown(lines.join("\n"));
	}

	private async showStatus(): Promise<void> {
		const session = this.session;
		const lines = [
			fg(CYAN, "Session"),
			`  id:         ${session.sessionId}`,
			`  name:       ${session.sessionManager.getSessionName() ?? "(unnamed)"}`,
			`  file:       ${session.sessionFile ? shortPath(session.sessionFile) : "(in memory)"}`,
			`  cwd:        ${shortPath(this.host.runtime.cwd)}`,
			`  model:      ${session.model ? modelKey(session.model) : "none"}`,
			`  thinking:   ${session.thinkingLevel}`,
			`  mode:       ${this.planMode ? "plan" : this.debugMode ? "debug" : this.permissions.mode}`,
			`  tools:      ${session.getActiveToolNames().length} active`,
			`  project:    ${this.boot.trusted ? "trusted" : "untrusted"}`,
			`  sessions:   ${shortPath(this.boot.paths.sessionsDir)}`,
		];
		this.transcript.addMarkdown(lines.join("\n"));
	}

	private async handleDocs(argument: string): Promise<void> {
		const topic = argument.trim();
		if (!topic) {
			const docs = listDocs();
			this.transcript.addMarkdown(
				[
					fg(CYAN, "Flintcode development docs"),
					...docs.map(
						(doc) =>
							`  ${doc.key.padEnd(14)} ${doc.title}\n${"".padEnd(16)}${shortPath(doc.path)}\n${"".padEnd(16)}${doc.description}`,
					),
					"",
					"Print one with /docs <topic>; LLMs can read the file directly.",
				].join("\n"),
			);
			return;
		}
		const { info, content } = await readDoc(topic);
		const body = content.length > 12_000
			? `${content.slice(0, 12_000)}\n\n… truncated; read ${shortPath(info.path)} for the rest …`
			: content;
		this.transcript.addMarkdown(body);
	}

	private async handleReload(): Promise<void> {
		this.footer.setStatus("reloading extensions…");
		try {
			await this.session.reload();
			await this.bindSession(true);
			this.transcript.addNotice(
				"resources reloaded. Compiled UI/code changes require quitting and relaunching Flintcode.",
				"info",
			);
			this.toast("extensions and resources reloaded", 2_000);
		} finally {
			this.footer.setStatus(undefined);
			this.screen.requestRender();
		}
	}


	private async handleSearch(argument: string): Promise<void> {
		let query = argument.trim();
		if (!query) {
			const handle = showInputDialogAsync({
				tui: this.screen,
				title: "Web search",
				placeholder: "query",
				restoreFocus: () => this.screen.setFocus(this.editor),
			});
			this.pendingChoice = handle;
			const value = await handle.promise;
			if (this.pendingChoice === handle) this.pendingChoice = undefined;
			if (!value?.trim()) return;
			query = value.trim();
		}
		this.footer.setStatus("searching…");
		try {
			const results = await this.web.search(query);
			this.transcript.addMarkdown(formatSearchResults(query, results));
		} finally {
			this.footer.setStatus(undefined);
		}
	}

	private async handleFetch(argument: string): Promise<void> {
		let url = argument.trim();
		if (!url) {
			const handle = showInputDialogAsync({
				tui: this.screen,
				title: "Fetch URL",
				placeholder: "https://…",
				restoreFocus: () => this.screen.setFocus(this.editor),
			});
			this.pendingChoice = handle;
			const value = await handle.promise;
			if (this.pendingChoice === handle) this.pendingChoice = undefined;
			if (!value?.trim()) return;
			url = value.trim();
		}
		this.footer.setStatus("fetching…");
		try {
			const result = await this.web.fetchPage(url);
			this.transcript.addMarkdown(formatFetchResult(result));
		} finally {
			this.footer.setStatus(undefined);
		}
	}

	private async handleWorktree(argument: string): Promise<void> {
		const trimmed = argument.trim();
		const [action = "list", ...rest] = trimmed.split(/\s+/);
		const cwd = this.host.runtime.cwd;
		if (action === "list" || !trimmed) {
			const worktrees = await listWorktrees(cwd);
			this.transcript.addMarkdown(formatWorktrees(worktrees, cwd));
			return;
		}
		if (action === "create") {
			const created = await createWorktree({
				cwd,
				root: this.boot.config.worktrees.root,
				...(rest[0] ? { name: rest[0] } : {}),
			});
			this.transcript.addNotice(
				`created worktree ${created.path} (${created.branch}). Start Flintcode there with: flintcode -w ${created.path}`,
				"success",
			);
			return;
		}
		if (action === "remove") {
			const target = rest.join(" ").trim();
			if (!target) throw new Error("Usage: /worktree remove <name>");
			const handle = showChoiceDialog({
				tui: this.screen,
				title: "Remove worktree?",
				body: target,
				items: [
					{ value: "remove", label: "Remove worktree", description: "uncommitted changes may be lost" },
					{ value: "cancel", label: "Cancel" },
				],
				maxVisible: 2,
				restoreFocus: () => this.screen.setFocus(this.editor),
			});
			this.pendingChoice = handle;
			const choice = await handle.promise;
			if (this.pendingChoice === handle) this.pendingChoice = undefined;
			if (choice !== "remove") return;
			const removed = await removeWorktree(cwd, target);
			this.transcript.addNotice(`removed worktree ${removed}`, "success");
			return;
		}
		throw new Error("Use /worktree [list|create <name>|remove <name>].");
	}

	private async handleOutputStyle(argument: string): Promise<void> {
		const apply = async (name: string) => {
			const style = OUTPUT_STYLES.find((entry) => entry.name === name);
			if (!style) {
				throw new Error(`Use one of: ${OUTPUT_STYLES.map((entry) => entry.name).join(", ")}`);
			}
			await this.patchConfig((config) => {
				config.ui.outputStyle = style.name;
			});
			this.toast(`output style: ${style.name}`, 1_600);
		};
		if (argument.trim()) {
			await apply(argument.trim());
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: "Output style",
			items: OUTPUT_STYLES.map((style) => ({
				value: style.name,
				label: `${style.name}${style.name === this.boot.config.ui.outputStyle ? "  ← current" : ""}`,
				description: style.description,
			})),
			maxVisible: 5,
			onSelect: async (value) => apply(value),
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async handleTheme(argument: string): Promise<void> {
		const available: string[] = [...TUI_THEMES];
		const apply = (name: string) => {
			if (!available.includes(name)) {
				throw new Error(`Use one of: ${available.join(", ")}`);
			}
			initFlintcodeTheme(name, this.boot.paths.home);
			void this.patchConfig((config) => {
				config.ui.theme = name;
			});
			this.transcript.reset();
			if (this.session.messages.length > 0) {
				this.transcript.renderHistory(this.session, this.host.runtime.cwd);
			} else {
				this.transcript.addWelcome({ model: this.session.model?.id });
			}
			this.toast(`theme: ${name}`, 1_500);
		};
		if (argument.trim()) {
			apply(argument.trim());
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: "Theme",
			items: available.map((name) => ({
				value: name,
				label: `${name}${name === this.boot.config.ui.theme ? "  ← current" : ""}`,
			})),
			maxVisible: 2,
			onSelect: async (value) => apply(value),
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async handleLoop(argument: string): Promise<void> {
		const trimmed = argument.trim();
		const loops = await this.loops.list();
		if (!trimmed || trimmed === "list") {
			this.transcript.addMarkdown(formatLoops(loops));
			return;
		}
		const [first, ...rest] = trimmed.split(/\s+/);
		if (["stop", "pause", "resume", "remove"].includes(first)) {
			const id = rest[0];
			if (!id) throw new Error(`Usage: /loop ${first} <id>`);
			const action = first === "stop" ? "pause" : (first as "pause" | "resume" | "remove");
			const loop = await this.loops.stop(id, action);
			if (!loop) throw new Error(`No loop matched ${id}.`);
			this.toast(`loop ${loop.status}`, 1_500);
			return;
		}
		const interval = parseInterval(first);
		if (!interval) {
			throw new Error("Usage: /loop <30s|5m|1h> <prompt>. Add `list` to inspect loops.");
		}
		const prompt = rest.join(" ").trim();
		if (!prompt) throw new Error("A prompt is required after the interval.");
		const loop = await this.loops.add(prompt, interval);
		this.transcript.addNotice(
			`scheduled ${loop.id.slice(0, 10)} every ${Math.round(interval / 1000)}s`,
			"success",
		);
	}

	private async handleGoal(argument: string): Promise<void> {
		const trimmed = argument.trim();
		if (!trimmed || trimmed === "list") {
			this.transcript.addMarkdown(formatGoals(await this.goals.forWorkspace()));
			return;
		}
		const [action, ...rest] = trimmed.split(/\s+/);
		const value = rest.join(" ").trim();
		if (action === "add") {
			if (!value) throw new Error("Usage: /goal add <title>");
			const goal = await this.goals.create(value);
			this.toast(`created goal ${goal.id.slice(0, 10)}`, 1_600);
			return;
		}
		if (["pause", "resume", "complete", "delete"].includes(action)) {
			if (!value) throw new Error(`Usage: /goal ${action} <id>`);
			if (action === "delete") {
				const removed = await this.goals.remove(value);
				if (!removed) throw new Error(`No goal matched ${value}.`);
				this.toast("goal deleted", 1_500);
				return;
			}
			const status = action === "pause" ? "paused" : action === "resume" ? "active" : "complete";
			const goal = await this.goals.update(value, { status });
			if (!goal) throw new Error(`No goal matched ${value}.`);
			this.toast(`goal ${goal.status}`, 1_500);
			return;
		}
		throw new Error("Use /goal [list|add|pause|resume|complete|delete] ...");
	}

	private async handlePlan(argument: string): Promise<void> {
		const normalized = argument.toLowerCase();
		if (normalized === "off" || normalized === "exit" || normalized === "disable") {
			const message = this.plan.exitByCommand();
			this.toast(message, 1_600);
			return;
		}
		if (this.plan.isActive()) {
			this.toast("plan mode is already active", 1_400);
			return;
		}
		this.plan.enter();
		if (argument && normalized !== "on" && normalized !== "enable") {
			await this.submitText(argument);
		}
	}

	private async patchConfig(mutate: (config: import("../core/types.js").FlintcodeConfig) => void): Promise<void> {
		await patchFlintcodeConfig(this.boot.paths, mutate);
		mutate(this.boot.config);
	}

	private async applyMode(mode: string): Promise<void> {
		const normalized = mode.trim().toLowerCase();
		if (normalized === "plan") {
			this.debugMode = false;
			this.transcript.setToolsExpanded(false);
			if (!this.plan.isActive()) this.plan.enter();
			this.footer.refresh();
			this.screen.requestRender();
			return;
		}
		if (normalized === "debug") {
			if (this.plan.isActive()) this.plan.exitByCommand();
			this.debugMode = true;
			this.transcript.setToolsExpanded(true);
			this.footer.refresh();
			this.screen.requestRender();
			this.transcript.addNotice(
				`debug mode · permissions:${this.permissions.mode} · model:${this.session.model?.id ?? "?"} · tools:${this.session.getActiveToolNames().length}`,
				"info",
			);
			return;
		}
		if (this.plan.isActive()) this.plan.exitByCommand();
		this.debugMode = false;
		this.transcript.setToolsExpanded(false);
		const permission =
			normalized === "ask" || normalized === "default"
				? "default"
				: normalized === "edits"
					? "accept-edits"
					: normalized === "noask"
						? "dont-ask"
						: normalized;
		if (!PERMISSION_MODES.includes(permission as (typeof PERMISSION_MODES)[number])) {
			throw new Error(
				"Use ask, auto, accept-edits, dont-ask, yolo, plan, or debug.",
			);
		}
		this.permissions.setMode(permission as (typeof PERMISSION_MODES)[number]);
		await this.patchConfig((config) => {
			config.permissions.mode = permission as (typeof PERMISSION_MODES)[number];
		});
		this.footer.refresh();
		this.editor.invalidate();
		this.screen.requestRender();
		this.toast(`mode: ${normalized === "default" ? "ask" : normalized}`, 1_500);
	}

	private async handleMode(argument: string): Promise<void> {
		const current = this.plan.isActive()
			? "plan"
			: this.debugMode
				? "debug"
				: this.permissions.mode === "default"
					? "ask"
					: this.permissions.mode;
		if (argument.trim()) {
			await this.applyMode(argument);
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: "Mode",
			items: [
				{ value: "ask", label: `ask${current === "ask" ? "  ← current" : ""}`, description: "approve writes and shell" },
				{ value: "auto", label: `auto${current === "auto" ? "  ← current" : ""}`, description: "low-risk actions proceed; dangerous/outside asks" },
				{ value: "accept-edits", label: `accept-edits${current === "accept-edits" ? "  ← current" : ""}`, description: "auto-allow workspace edits" },
				{ value: "dont-ask", label: `dont-ask${current === "dont-ask" ? "  ← current" : ""}`, description: "deny anything that would ask" },
				{ value: "yolo", label: `yolo${current === "yolo" ? "  ← current" : ""}`, description: "allow everything except plan, deny rules and protected secrets" },
				{ value: "plan", label: `plan${current === "plan" ? "  ← current" : ""}`, description: "read-only planning until approved" },
				{ value: "debug", label: `debug${current === "debug" ? "  ← current" : ""}`, description: "expanded tools and diagnostics" },
			],
			maxVisible: 7,
			onSelect: async (value) => {
				try {
					await this.applyMode(value);
				} catch (error) {
					this.transcript.addNotice(
						error instanceof Error ? error.message : String(error),
						"error",
					);
				}
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private async showPermissionModes(argument: string): Promise<void> {
		const setMode = async (mode: string) => {
			if (!PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number])) {
				throw new Error(`Use one of: ${PERMISSION_MODES.join(", ")}`);
			}
			this.permissions.setMode(mode as (typeof PERMISSION_MODES)[number]);
			await this.patchConfig((config) => {
				config.permissions.mode = mode as (typeof PERMISSION_MODES)[number];
			});
			this.footer.refresh();
			this.editor.invalidate();
			this.screen.requestRender();
			this.toast(`permissions: ${mode}`, 1_600);
		};
		if (argument) {
			await setMode(argument);
			return;
		}
		showSelectDialog({
			tui: this.screen,
			title: "Permission mode",
			items: [
				{
					value: "default",
					label: "default",
					description: "ask for writes and shell commands",
				},
				{
					value: "accept-edits",
					label: "accept-edits",
					description: "auto-allow edits inside the workspace, ask for shell",
				},
				{
					value: "auto",
					label: "auto",
					description: "allow low-risk work, ask for dangerous or outside actions",
				},
				{
					value: "dont-ask",
					label: "dont-ask",
					description: "deny anything that would need a prompt",
				},
				{
					value: "yolo",
					label: "yolo",
					description: "allow everything except protected secrets and plan/deny rules",
				},
			],
			maxVisible: 5,
			onSelect: async (value) => {
				await setMode(value);
			},
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
	}

	private enqueueModal<T>(start: () => Promise<T>, cancelValue: T): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (operation: () => void) => {
				if (settled) return;
				settled = true;
				operation();
			};
			this.modalJobs.push({
				start: async () => {
					try {
						const value = await start();
						finish(() => resolve(value));
					} catch (error) {
						finish(() => reject(error));
					}
				},
				cancel: () => finish(() => resolve(cancelValue)),
			});
			void this.drainModals();
		});
	}

	private async drainModals(): Promise<void> {
		if (this.modalRunning) return;
		this.modalRunning = true;
		try {
			while (this.modalJobs.length > 0) {
				if (this.closing) {
					this.cancelModals();
					break;
				}
				const job = this.modalJobs.shift()!;
				await job.start();
				// Give the overlay hide + focus restore one render turn before the
				// next approval is shown. Overlapping overlays broke focus on the
				// second permission prompt.
				await new Promise((resolve) => setTimeout(resolve, 60));
			}
		} finally {
			this.modalRunning = false;
		}
	}

	private cancelModals(): void {
		this.modalGeneration += 1;
		for (const handle of this.activeModalHandles) {
			try {
				handle.close(null);
			} catch {
				// Already dismissed.
			}
		}
		this.activeModalHandles.clear();
		this.pendingChoice = undefined;
		for (const job of this.modalJobs.splice(0)) job.cancel();
	}

	private modalDeadlineMs(): number {
		return this.boot.config.permissions.approvalTimeoutSeconds * 1_000;
	}

	private async awaitModal(
		handle: ChoiceDialogHandle,
		deadlineAt: number,
		generation: number,
	): Promise<{ value: string | null; expired: boolean; stale: boolean }> {
		this.activeModalHandles.add(handle);
		const remaining = Math.max(0, deadlineAt - Date.now());
		if (remaining === 0) {
			this.activeModalHandles.delete(handle);
			return { value: null, expired: true, stale: this.modalGeneration !== generation };
		}
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<{ value: null; expired: true; stale: boolean }>((resolve) => {
			timer = setTimeout(() => {
				handle.close(null);
				resolve({ value: null, expired: true, stale: this.modalGeneration !== generation });
			}, remaining);
			timer.unref?.();
		});
		try {
			const result = await Promise.race([
				handle.promise.then((value) => ({
					value,
					expired: false,
					stale: this.modalGeneration !== generation,
				})),
				timeout,
			]);
			return result;
		} finally {
			if (timer) clearTimeout(timer);
			this.activeModalHandles.delete(handle);
			if (this.pendingChoice === handle) this.pendingChoice = undefined;
		}
	}

	private describePermission(request: PermissionRequest): string {
		const name = request.toolName.startsWith("mcp__")
			? request.toolName
			: request.toolName.charAt(0).toUpperCase() + request.toolName.slice(1);
		const input = request.input;
		const command = typeof input.command === "string" ? input.command : undefined;
		const file = ["path", "file_path", "filePath"]
			.map((key) => input[key])
			.find((value): value is string => typeof value === "string");
		const lines: string[] = [];
		if (command) {
			lines.push("Command", ...command.split("\n").map((line) => `  ${line}`));
		} else if (name === "Edit" || name === "Write") {
			lines.push("File", `  ${file ?? "(unknown)"}`);
			const oldText = typeof input.old_string === "string" ? input.old_string : "";
			const newText = typeof input.new_string === "string"
				? input.new_string
				: typeof input.content === "string"
					? input.content
					: "";
			const diff = [
				...oldText.split("\n").slice(0, 5).map((line) => `- ${line}`),
				...newText.split("\n").slice(0, 8).map((line) => `+ ${line}`),
			];
			if (diff.length) lines.push("", "Change", ...diff.map((line) => `  ${line}`));
		} else if (name === "Agent") {
			lines.push("Subagent task");
			if (typeof input.description === "string") lines.push(`  ${input.description}`);
			const tasks = Array.isArray(input.tasks) ? input.tasks.length : 1;
			if (tasks > 1) lines.push(`  ${tasks} parallel tasks`);
			if (typeof input.agent === "string") lines.push(`  agent: ${input.agent}`);
			if (typeof input.model === "string") lines.push(`  model: ${input.model}`);
			if (typeof input.thinking === "string") lines.push(`  reasoning: ${input.thinking}`);
		} else if (name === "WebSearch" || name === "WebFetch") {
			const target = typeof input.query === "string" ? input.query : input.url;
			lines.push(name === "WebSearch" ? "Search" : "URL", `  ${String(target ?? request.target)}`);
		} else {
			lines.push("Target", `  ${request.target}`);
			for (const [key, value] of Object.entries(input).slice(0, 5)) {
				if (typeof value === "string") lines.push(`  ${key}: ${value}`);
			}
		}
		if (request.ruleReason) lines.push("", `Rule: ${request.ruleReason}`);
		return lines.join("\n");
	}

	private requestPermission(request: PermissionRequest): Promise<ApprovalChoice> {
		const deadlineAt = Date.now() + this.modalDeadlineMs();
		const generation = this.modalGeneration;
		return this.enqueueModal(async () => {
			if (this.modalGeneration !== generation) return "deny";
			if (Date.now() >= deadlineAt) {
				this.transcript.addNotice(`approval for ${request.toolName} expired`, "warning");
				return "deny";
			}
			const details = this.describePermission(request);
			const handle = showChoiceDialog({
				tui: this.screen,
				title: `Permission · ${request.toolName}`,
				body: details,
				items: [
					{ value: "allow", label: "Allow once", description: "run this call only" },
					{ value: "always", label: "Always allow", description: "remember this tool and target" },
					{ value: "deny", label: "Deny", description: "block this call" },
				],
				maxVisible: 3,
				restoreFocus: () => this.screen.setFocus(this.editor),
			});
			this.pendingChoice = handle;
			const outcome = await this.awaitModal(handle, deadlineAt, generation);
			if (outcome.stale) return "deny";
			if (outcome.expired) {
				this.transcript.addNotice(`approval for ${request.toolName} timed out`, "warning");
				return "deny";
			}
			const value = outcome.value;
			if (value === "allow") {
				this.toast("allowed once", 1_000);
				return "allow";
			}
			if (value === "always") {
				this.toast("always allowed for this target", 1_400);
				return "always";
			}
			this.transcript.addNotice(`permission denied for ${request.toolName}`, "warning");
			return "deny";
		}, "deny");
	}

	private askUser(question: string, options?: string[]): Promise<string | undefined> {
		const deadlineAt = Date.now() + this.modalDeadlineMs();
		const generation = this.modalGeneration;
		return this.enqueueModal(async () => {
			if (this.modalGeneration !== generation) return undefined;
			if (Date.now() >= deadlineAt) {
				this.transcript.addNotice("question approval expired", "warning");
				return undefined;
			}
			if (options && options.length > 0) {
				const handle = showChoiceDialog({
					tui: this.screen,
					title: "Question",
					body: question,
					items: [
						...options.map((option) => ({ value: option, label: option })),
						{ value: "__other__", label: "Other…", description: "type a custom answer" },
						{ value: "__cancel__", label: "Cancel" },
					],
					maxVisible: Math.min(8, options.length + 2),
					restoreFocus: () => this.screen.setFocus(this.editor),
				});
				this.pendingChoice = handle;
				const outcome = await this.awaitModal(handle, deadlineAt, generation);
				if (outcome.stale || outcome.expired) {
					if (outcome.expired) this.transcript.addNotice("question timed out", "warning");
					return undefined;
				}
				const value = outcome.value;
				if (value === "__other__") return this.askUserInput(question, deadlineAt, generation);
				if (!value || value === "__cancel__") return undefined;
				return value;
			}
			return this.askUserInput(question, deadlineAt, generation);
		}, undefined);
	}

	private async askUserInput(
		question: string,
		deadlineAt: number,
		generation: number,
	): Promise<string | undefined> {
		if (this.modalGeneration !== generation) return undefined;
		if (Date.now() >= deadlineAt) {
			this.transcript.addNotice("question approval expired", "warning");
			return undefined;
		}
		const handle = showInputDialogAsync({
			tui: this.screen,
			title: "Question",
			message: question,
			placeholder: "type your answer",
			restoreFocus: () => this.screen.setFocus(this.editor),
		});
		this.pendingChoice = handle;
		const outcome = await this.awaitModal(handle, deadlineAt, generation);
		if (outcome.stale || outcome.expired) {
			if (outcome.expired) this.transcript.addNotice("question timed out", "warning");
			return undefined;
		}
		return outcome.value?.trim() || undefined;
	}

	private approvePlan(planText: string): Promise<boolean> {
		const deadlineAt = Date.now() + this.modalDeadlineMs();
		const generation = this.modalGeneration;
		return this.enqueueModal(async () => {
			if (this.modalGeneration !== generation) return false;
			if (Date.now() >= deadlineAt) {
				this.transcript.addNotice("plan approval expired", "warning");
				return false;
			}
			this.transcript.addPlan(planText);
			const lineCount = planText.split("\n").length;
			const preview = planText.split("\n").slice(0, 5).join("\n");
			const body = `Full plan (${lineCount} lines) is shown in the transcript above and remains after approval.\n\n${preview}${lineCount > 5 ? "\n…" : ""}`;
			const handle = showChoiceDialog({
				tui: this.screen,
				title: "Approve plan?",
				body,
				items: [
					{ value: "approve", label: "Approve and execute", description: "restore tools and continue" },
					{ value: "reject", label: "Keep planning", description: "stay read-only" },
				],
				maxVisible: 2,
				restoreFocus: () => this.screen.setFocus(this.editor),
			});
			this.pendingChoice = handle;
			const outcome = await this.awaitModal(handle, deadlineAt, generation);
			if (outcome.stale) return false;
			if (outcome.expired) {
				this.transcript.addNotice("plan approval timed out · staying read-only", "warning");
				return false;
			}
			if (outcome.value === "approve") {
				this.toast("plan approved", 1_500);
				return true;
			}
			this.toast("plan rejected · staying read-only", 1_800);
			return false;
		}, false);
	}

	private startHud(): void {
		void this.refreshHud();
		this.hudTimer = setInterval(() => {
			void this.refreshHud();
		}, HUD_INTERVAL_MS);
		this.hudTimer.unref?.();
	}

	private async refreshHud(): Promise<void> {
		try {
			const tasks = await this.tasks.list();
			this.footer.setBackgroundCount(tasks.filter((task) => task.status === "running").length);
		} catch {
			// Task metadata may be mid-write.
		}
		try {
			const store = await loadSessionTodos(this.boot.paths, this.session.sessionId);
			const active = store.items.filter(
				(item) => item.status === "pending" || item.status === "in_progress",
			).length;
			const total = store.items.filter((item) => item.status !== "cancelled").length;
			this.footer.setTodoSummary(total > 0 ? `${total - active}/${total}` : "");
		} catch {
			// Ignore unreadable todo state.
		}
	}

	private toast(text: string, milliseconds = 2_000): void {
		this.footer.setStatus(text);
		if (this.toastTimer) clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => {
			this.footer.setStatus(undefined);
			this.screen.requestRender();
		}, milliseconds);
		this.screen.requestRender();
	}

	private async quit(code: number, force = false): Promise<void> {
		if (this.closing) {
			if (force) setTimeout(() => process.exit(code), 150).unref();
			return;
		}
		this.closing = true;
		this.exitRequested = true;
		this.exitCode = code;
		if (this.toastTimer) clearTimeout(this.toastTimer);
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.signalHandler) process.off("SIGTERM", this.signalHandler);
		this.cancelModals();
		this.unsubscribe?.();
		this.inputUnsubscribe?.();
		this.loops.dispose();
		void this.sessionLock.release();
		this.stopSpinner();
		if (this.hudTimer) clearInterval(this.hudTimer);
		this.hudTimer = undefined;
		this.footer.dispose();
		try {
			this.screen.stop();
		} catch {
			// The terminal may already be gone.
		}
		try {
			// A provider/extension shutdown can hang. Never let that keep the
			// terminal process alive forever.
			await Promise.race([
				this.host.dispose().catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, force ? 1_200 : 6_000)),
			]);
		} catch {
			// Shutdown should never block exit.
		}
		if (this.resolveExit) this.resolveExit(code);
		const safety = setTimeout(() => process.exit(code), force ? 300 : 3_000);
		safety.unref?.();
	}
}

