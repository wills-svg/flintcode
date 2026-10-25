export interface OutputStyle {
	name: string;
	description: string;
	instructions: string;
}

export const OUTPUT_STYLES: OutputStyle[] = [
	{
		name: "default",
		description: "Balanced answers and actions.",
		instructions: "",
	},
	{
		name: "concise",
		description: "Short answers, minimal narration.",
		instructions:
			"Prefer concise answers. Lead with the result, avoid restating the plan, and keep explanations to the minimum needed to be actionable.",
	},
	{
		name: "explanatory",
		description: "Explain reasoning and tradeoffs while working.",
		instructions:
			"Explain the reasoning behind significant decisions, call out tradeoffs, and teach the underlying concepts as you work. Keep actions grounded in the code.",
	},
	{
		name: "review",
		description: "Review-oriented: prioritize risks, bugs and tests.",
		instructions:
			"Adopt a code-review posture. Prioritize concrete bugs, regressions, security risks, edge cases and missing tests. Cite files and line numbers. Avoid unnecessary edits.",
	},
	{
		name: "architect",
		description: "Design-oriented: focus on structure and contracts.",
		instructions:
			"Focus on architecture, interfaces, data flow and invariants. Before editing, state the design and its constraints. Prefer small, well-bounded changes.",
	},
];

export function getOutputStyle(name: string | undefined): OutputStyle {
	return OUTPUT_STYLES.find((style) => style.name === name) ?? OUTPUT_STYLES[0];
}
