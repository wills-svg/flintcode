import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PLAN_SYSTEM_PROMPT,
	type PlanController,
} from "../core/plan.js";

export function createPlanExtension(
	controller: PlanController,
	options?: { savePlan?: (plan: string) => Promise<string> },
) {
	return (pi: ExtensionAPI): void => {
		const enterPlanMode = defineTool({
			name: "EnterPlanMode",
			label: "Enter Plan Mode",
			description:
				"Switch Flintcode into read-only plan mode. Use when a task needs investigation and a plan before changes. Writes and state-changing commands are blocked until ExitPlanMode is approved.",
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ description: "Why plan mode is needed" })),
			}),
			async execute() {
				const text = controller.enter();
				pi.appendEntry("flintcode.plan", { active: true });
				return { content: [{ type: "text", text }], details: { active: true } };
			},
		});

		const exitPlanMode = defineTool({
			name: "ExitPlanMode",
			label: "Exit Plan Mode",
			description:
				"Present the completed plan to the user for approval. On approval, plan mode ends and the previous tools are restored. On rejection, stay in plan mode.",
			parameters: Type.Object({
				plan: Type.String({ description: "The complete implementation plan" }),
			}),
			async execute(_toolCallId, params) {
				const wasActive = controller.isActive();
				const text = await controller.exitByModel(params.plan);
				const approved = wasActive && !controller.isActive();
				let finalText = text;
				let savedPath: string | undefined;
				if (approved && options?.savePlan) {
					try {
						savedPath = await options.savePlan(params.plan);
						finalText += `\nPlan saved to ${savedPath}`;
					} catch {
						// Saving is best effort.
					}
				}
				pi.appendEntry("flintcode.plan", {
					active: controller.isActive(),
					plan: params.plan,
					...(savedPath ? { path: savedPath } : {}),
				});
				return {
					content: [{ type: "text", text: finalText }],
					details: { active: controller.isActive(), savedPath },
					...(controller.isActive() ? { isError: true } : {}),
				};
			},
		});

		pi.registerTool(enterPlanMode);
		pi.registerTool(exitPlanMode);

		pi.on("before_agent_start", (event) => {
			if (!controller.isActive()) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_SYSTEM_PROMPT}` };
		});
	};
}
