export type PermissionMode =
	| "default"
	| "accept-edits"
	| "auto"
	| "dont-ask"
	| "yolo";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
	id: string;
	match: {
		tools?: string[];
		paths?: string[];
		commands?: string[];
		mcpServers?: string[];
	};
	action: PermissionAction;
	scope?: "user" | "project" | "session";
	reason?: string;
}

export type HookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "UserPromptSubmit"
	| "SessionStart"
	| "SessionEnd"
	| "Stop"
	| "PermissionRequest"
	| "PreCompact"
	| "ConfigChange"
	| "SubagentStart"
	| "SubagentStop";

export interface HookConfig {
	id: string;
	event: HookEvent;
	enabled?: boolean;
	matcher?: {
		tool?: string;
		path?: string;
	};
	type?: "command" | "prompt";
	command?: string;
	prompt?: string;
	model?: string;
	tools?: string[];
	timeoutMs?: number;
	onError?: "allow" | "deny";
}

export interface StatuslineConfig {
	segments: string[];
	separator: string;
	command?: string;
}

export interface CompatConfig {
	piAgentDir: string;
	piAuth: boolean;
	piModels: boolean;
	piSkills: boolean;
	piAgents: boolean;
	piPrompts: boolean;
	piInstructions: boolean;
	piExtensions: string[];
}

export interface FlintcodeConfig {
	version: 1;
	defaults: {
		provider: string;
		model: string;
		thinking: string;
	};
	compat: CompatConfig;
	ui: {
		theme: string;
		tuiMode: "fullscreen" | "inline";
		hideThinking: boolean;
		inlineThinkingMode: "full" | "compact" | "hidden";
		outputStyle: string;
		transcriptBlocks: number;
		historyMessages: number;
		toolOutputChars: number;
		statusline: StatuslineConfig;
	};
	permissions: {
		mode: PermissionMode;
		rules: PermissionRule[];
		approvalTimeoutSeconds: number;
		protectSecrets: boolean;
	};
	agents: {
		maxDepth: number;
		maxConcurrent: number;
		maxDurationSeconds: number;
		maxToolCalls: number;
		maxToolOutputChars: number;
		workerHeapMb: number;
		workerStartupSeconds: number;
	};
	hooks: {
		enabled: boolean;
		timeoutMs: number;
	};
	loops: {
		minIntervalMs: number;
		maxIterations: number;
	};
	worktrees: {
		root: string;
	};
	web: {
		enabled: boolean;
		searchCommand: string;
		maxResults: number;
	};
}

export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "builtin" | "user" | "project" | "pi";
	filePath: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	priority?: "low" | "medium" | "high";
	notes?: string;
	parentId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TodoStore {
	version: 1;
	nextId: number;
	items: TodoItem[];
}

export type BackgroundTaskStatus = "running" | "done" | "failed" | "killed";

export interface BackgroundTask {
	id: string;
	kind: "bash" | "agent";
	status: BackgroundTaskStatus;
	pid?: number;
	pgid?: number;
	command?: string;
	description?: string;
	agent?: string;
	cwd: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	logPath: string;
	tail?: string;
	sessionId?: string;
	usage?: unknown;
}

export interface GoalRecord {
	id: string;
	title: string;
	description?: string;
	status: "active" | "paused" | "complete" | "blocked";
	cwd?: string;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryRecord {
	id: string;
	scope: "user" | "project" | "session";
	text: string;
	tags: string[];
	source: string;
	pinned: boolean;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
}

export interface LoopRecord {
	id: string;
	sessionId?: string;
	prompt: string;
	intervalMs: number;
	dynamic: boolean;
	maxIterations: number;
	iterations: number;
	createdAt: string;
	lastRun?: number;
	status: "active" | "paused" | "done";
}
