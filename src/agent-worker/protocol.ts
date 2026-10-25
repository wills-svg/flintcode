import type { FlintcodeConfig } from "../core/types.js";
import type { FlintcodePaths } from "../core/paths.js";

export interface WorkerAgentSpec {
	name: string;
	systemPrompt: string;
	tools: string[];
}

export interface WorkerInitMessage {
	type: "init";
	description: string;
	prompt: string;
	agent: WorkerAgentSpec;
	cwd: string;
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	projectTrusted: boolean;
	model: unknown;
	modelKey: string;
	thinking?: string;
}

export type ParentToWorker =
	| WorkerInitMessage
	| { type: "run"; prompt: string }
	| { type: "abort"; reason?: string }
	| { type: "permission_response"; id: string; allow: boolean; reason?: string };

export type AgentReportSource = "text" | "thinking" | "partial";

export type WorkerToParent =
	| { type: "ready"; pid: number }
	| { type: "activity"; line: string }
	| { type: "text"; text: string }
	| { type: "permission_request"; id: string; toolName: string; input: Record<string, unknown> }
	| {
			type: "result";
			status: "done" | "aborted" | "error";
			output?: string;
			error?: string;
			usage?: unknown;
			durationMs: number;
			reportSource?: AgentReportSource;
		}
	| { type: "fatal"; error: string };

export function isWorkerMessage(value: unknown): value is WorkerToParent {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "ready" ||
		type === "activity" ||
		type === "text" ||
		type === "permission_request" ||
		type === "result" ||
		type === "fatal"
	);
}
