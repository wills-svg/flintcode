import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getOutputStyle } from "../core/output-styles.js";

export function createOutputStyleExtension(getStyleName: () => string) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", (event) => {
			const style = getOutputStyle(getStyleName());
			if (!style.instructions) return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n## Output style: ${style.name}\n${style.instructions}`,
			};
		});
	};
}
