import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_PREAMBLE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const FLINTCODE_PREAMBLE =
	"You are Flintcode, an extensible standalone terminal coding agent built on the pi SDK. You help the user by reading files, executing commands, editing code, and writing files. This session is Flintcode. You are not pi.";

const FLINTCODE_DOCS = `<docs>
Flintcode documentation (read only when the user asks about Flintcode itself or needs extension guidance):
- Run \`flintcode docs\` or \`flintcode docs <topic>\` (topics: architecture, extending, agent, agents, skill, readme).
- Flintcode's CLI is \`flintcode\`. Its in-session commands include /help, /plan, /permissions, /model, /thinking, /todos, /tasks, /agents, /loop, /worktree, /docs and /reload.
- Provider, plugin, MCP and skill management is available through the \`flintcode\` CLI and documented in the local docs.
</docs>`;

const FLINTCODE_POLICY = `<harness_identity>
This terminal session is Flintcode, not pi. Never describe yourself as pi, and never treat pi documentation or pi commands as Flintcode's interface. Use Flintcode's tools and the \`flintcode\` CLI. If a context file mentions pi as an implementation dependency, keep that as background only.
</harness_identity>`;

export function applyFlintcodeIdentity(systemPrompt: string): string {
	let prompt = systemPrompt;
	if (prompt.includes(PI_PREAMBLE)) {
		prompt = prompt.replace(PI_PREAMBLE, FLINTCODE_PREAMBLE);
	} else if (!prompt.includes("You are Flintcode")) {
		prompt = `${FLINTCODE_PREAMBLE}\n\n${prompt}`;
	}
	prompt = prompt.replace(/<docs>[\s\S]*?<\/docs>/g, FLINTCODE_DOCS);
	if (!prompt.includes("<harness_identity>")) {
		prompt = `${prompt}\n\n${FLINTCODE_POLICY}`;
	}
	return prompt;
}

export function createFlintcodeIdentityExtension() {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", (event) => {
			return { systemPrompt: applyFlintcodeIdentity(event.systemPrompt) };
		});
	};
}
