import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodeUiBridge } from "../core/ui-bridge.js";

export function createAskUserExtension(bridge: FlintcodeUiBridge) {
	return (pi: ExtensionAPI): void => {
		const askUser = defineTool({
			name: "ask_user",
			label: "Ask User",
			description:
				"Ask the user a question and wait for an answer. Use options when the choice is discrete; the user can also type a custom answer. Use sparingly for decisions that materially change the work.",
			parameters: Type.Object({
				question: Type.String({ description: "The question to ask" }),
				options: Type.Optional(
					Type.Array(Type.String(), { description: "Optional discrete choices" }),
				),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				if (!bridge.askUser) {
					throw new Error("ask_user requires an interactive Flintcode session.");
				}
				const answer = await bridge.askUser(params.question, params.options);
				return {
					content: [
						{
							type: "text",
							text: answer ? `User answer: ${answer}` : "The user did not answer.",
						},
					],
					details: { question: params.question, answer: answer ?? null },
					...(answer ? {} : { isError: true }),
				};
			},
		});
		pi.registerTool(askUser);
	};
}
