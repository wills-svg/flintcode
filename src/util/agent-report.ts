import { truncateText } from "./format.js";

function messageContent(message: unknown): unknown[] {
	if (!message || typeof message !== "object") return [];
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content : [];
}

export function blocksText(message: unknown, type: "text" | "thinking"): string {
	return messageContent(message)
		.filter(
			(block): block is Record<string, unknown> =>
				Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === type,
		)
		.map((block) =>
			typeof block.text === "string"
				? block.text
				: typeof block.thinking === "string"
					? block.thinking
					: "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}

export type ReportSource = "text" | "thinking";

export interface AgentReport {
	text: string;
	source: ReportSource;
}

export function findReport(messages: readonly unknown[]): AgentReport | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if ((message as { role?: string }).role !== "assistant") continue;
		const text = blocksText(message, "text");
		if (text) return { text, source: "text" };
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if ((message as { role?: string }).role !== "assistant") continue;
		const thinking = blocksText(message, "thinking");
		if (thinking) {
			return {
				text: `[Flintcode recovered the final reasoning block because the subagent emitted no assistant text]\n\n${truncateText(thinking, 16_000)}`,
				source: "thinking",
			};
		}
	}

	return undefined;
}

export function extractReport(messages: readonly unknown[]): string {
	return findReport(messages)?.text ?? "";
}

export function reportShape(messages: readonly unknown[]): string {
	const assistantMessages = messages.filter((message) => (message as { role?: string }).role === "assistant");
	const blocks: string[] = [];
	for (const message of assistantMessages) {
		for (const block of messageContent(message)) {
			if (block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string") {
				blocks.push((block as { type: string }).type);
			}
		}
	}
	const counts = new Map<string, number>();
	for (const block of blocks) counts.set(block, (counts.get(block) ?? 0) + 1);
	const last = assistantMessages.at(-1) as { stopReason?: unknown } | undefined;
	return `${assistantMessages.length} assistant messages · blocks ${[...counts].map(([type, count]) => `${type}:${count}`).join(", ") || "none"} · last stop ${JSON.stringify(last?.stopReason ?? "none")}`;
}
