import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodePaths } from "../core/paths.js";
import type { GoalRecord } from "../core/types.js";
import { GoalService, formatGoals } from "../core/goals.js";

const STATUS = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("complete"),
	Type.Literal("blocked"),
]);

export function createGoalExtension(paths: FlintcodePaths, cwd: string) {
	return (pi: ExtensionAPI): void => {
		const goals = new GoalService(paths, cwd);

		const goalGet = defineTool({
			name: "goal_get",
			label: "Goals",
			description: "List the durable goals for this workspace, including their status.",
			parameters: Type.Object({
				includeCompleted: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				const all = await goals.forWorkspace();
				const visible = params.includeCompleted ? all : all.filter((goal) => goal.status !== "complete");
				return {
					content: [{ type: "text", text: formatGoals(visible) }],
					details: { goals: visible },
				};
			},
		});

		const goalUpdate = defineTool({
			name: "goal_update",
			label: "Update Goal",
			description:
				"Create or update a durable workspace goal. Actions: create, update, pause, resume, complete, delete.",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("create"),
					Type.Literal("update"),
					Type.Literal("pause"),
					Type.Literal("resume"),
					Type.Literal("complete"),
					Type.Literal("delete"),
				]),
				id: Type.Optional(Type.String()),
				title: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false },
			async execute(_toolCallId, params) {
				if (params.action === "create") {
					if (!params.title) throw new Error("title is required for create");
					const goal = await goals.create(params.title, params.description);
					return {
						content: [{ type: "text", text: `Created goal ${goal.id}: ${goal.title}` }],
						details: { goal: goal as GoalRecord | null, removed: false },
					};
				}
				if (!params.id) throw new Error("id is required for this action");
				if (params.action === "delete") {
					const removed = await goals.remove(params.id);
					return {
						content: [
							{ type: "text", text: removed ? `Deleted ${params.id}.` : `No goal matched ${params.id}.` },
						],
						details: { goal: null, removed },
						...(removed ? {} : { isError: true }),
					};
				}
				const status =
					params.action === "pause"
						? "paused"
						: params.action === "resume"
							? "active"
							: params.action === "complete"
								? "complete"
								: undefined;
				const goal = await goals.update(params.id, {
					...(params.title !== undefined ? { title: params.title } : {}),
					...(params.description !== undefined ? { description: params.description } : {}),
					...(status ? { status } : {}),
				});
				if (!goal) {
					return {
						content: [{ type: "text", text: `No goal matched ${params.id}.` }],
						details: { goal: null, removed: false },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Updated goal ${goal.id} (${goal.status}).` }],
					details: { goal: goal as GoalRecord | null, removed: false },
				};
			},
		});

		pi.registerTool(goalGet);
		pi.registerTool(goalUpdate);
	};
}
