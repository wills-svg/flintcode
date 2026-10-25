import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../util/format.js";

const NOTE = "\n\n… [Flintcode subagent guard: tool output truncated to protect memory]";

/**
 * Agent workers can still accumulate huge read/bash results in their child
 * context. Cap tool output in the worker process so one task cannot exhaust its
 * bounded V8 heap on a long research run.
 */
export function createAgentGuardExtension(maxChars: number) {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_result", (event) => {
			let changed = false;
			let remaining = maxChars;
			const content = event.content.map((block) => {
				if (block.type !== "text" || typeof block.text !== "string") return block;
				if (remaining <= 0) {
					changed = true;
					return { ...block, text: NOTE };
				}
				if (block.text.length <= remaining) {
					remaining -= block.text.length;
					return block;
				}
				changed = true;
				const text = truncateText(block.text, Math.max(1, remaining));
				remaining = 0;
				return { ...block, text: `${text}${NOTE}` };
			});
			return changed ? { content } : undefined;
		});
	};
}
