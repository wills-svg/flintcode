import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodePaths } from "../core/paths.js";
import { TaskManager, formatTaskRecord } from "../core/tasks.js";
import { truncateText } from "../util/format.js";

export function createBackgroundBashExtension(paths: FlintcodePaths) {
	return (pi: ExtensionAPI): void => {
		const tasks = new TaskManager(paths);

		const bashBackground = defineTool({
			name: "bash_background",
			label: "Background Shell",
			description:
				"Run a shell command in a detached background process. Returns a task id immediately. Use bash_output to read output and bash_kill to stop it.",
			parameters: Type.Object({
				command: Type.String({ description: "Shell command to run" }),
				description: Type.Optional(Type.String({ description: "Short label" })),
				cwd: Type.Optional(Type.String({ description: "Working directory" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const record = await tasks.start(params.command, {
					...(params.description ? { description: params.description } : {}),
					...(params.cwd ? { cwd: params.cwd } : {}),
					sessionId: ctx.sessionManager.getSessionId(),
				});
				return {
					content: [
						{
							type: "text",
							text: `Started background task ${record.id} (pid ${record.pid}).\nlog: ${record.logPath}\nUse bash_output with id ${record.id} to read it.`,
						},
					],
					details: record,
				};
			},
		});

		const bashOutput = defineTool({
			name: "bash_output",
			label: "Shell Output",
			description: "Read the status and recent output of a background shell task.",
			parameters: Type.Object({
				id: Type.String(),
				tailLines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				const result = await tasks.output(params.id, params.tailLines ?? 80);
				return {
					content: [
						{
							type: "text",
							text: [
								`Task ${result.record.id} is ${result.record.status}${result.record.exitCode !== undefined ? ` (exit ${result.record.exitCode})` : ""}.`,
								result.output ? `\n${result.output}` : "\n(no output yet)",
							].join(""),
						},
					],
					details: result,
				};
			},
		});

		const bashKill = defineTool({
			name: "bash_kill",
			label: "Kill Shell",
			description: "Terminate a running background shell task and its process group.",
			parameters: Type.Object({ id: Type.String() }),
			annotations: { readOnlyHint: false, destructiveHint: true },
			async execute(_toolCallId, params) {
				const record = await tasks.kill(params.id);
				return {
					content: [
						{
							type: "text",
							text: `Task ${record.id} is ${record.status}.`,
						},
					],
					details: record,
				};
			},
		});

		const taskList = defineTool({
			name: "task_list",
			label: "Background Tasks",
			description: "List background shell tasks.",
			parameters: Type.Object({
				all: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				const records = await tasks.list();
				const visible = params.all === false ? records.filter((record) => record.status === "running") : records;
				return {
					content: [
						{
							type: "text",
							text: visible.length === 0 ? "No background tasks." : visible.map(formatTaskRecord).join("\n\n"),
						},
					],
					details: { records: visible },
				};
			},
		});

		pi.registerTool(bashBackground);
		pi.registerTool(bashOutput);
		pi.registerTool(bashKill);
		pi.registerTool(taskList);
		void truncateText;
	};
}
