import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodeUiBridge } from "../core/ui-bridge.js";

export function createLoopExtension(bridge: FlintcodeUiBridge) {
	return (pi: ExtensionAPI): void => {
		const scheduleWakeup = defineTool({
			name: "ScheduleWakeup",
			label: "Schedule Wakeup",
			description:
				"Schedule a prompt to run in this session after a delay, then continue working. Use for follow-ups, polling, or timed checks.",
			parameters: Type.Object({
				delaySeconds: Type.Number({ minimum: 5, maximum: 86_400 }),
				prompt: Type.String({ description: "Prompt to run when the wakeup fires" }),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				if (!bridge.scheduleWakeup) {
					throw new Error("ScheduleWakeup requires an interactive Flintcode session.");
				}
				const record = await bridge.scheduleWakeup(params.prompt, params.delaySeconds);
				return {
					content: [
						{
							type: "text",
							text: `Scheduled wakeup ${record.id} in ${params.delaySeconds}s. It will run as a prompt in this session when Flintcode is idle.`,
						},
					],
					details: { loop: record },
				};
			},
		});
		pi.registerTool(scheduleWakeup);
	};
}
