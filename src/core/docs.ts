import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface DocInfo {
	key: string;
	title: string;
	description: string;
	path: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const docsDirectory = path.join(projectRoot, "docs");

export function docsRoot(): string {
	return docsDirectory;
}

export function listDocs(): DocInfo[] {
	return [
		{
			key: "index",
			title: "Documentation index",
			description: "Reading order and documentation map",
			path: path.join(docsDirectory, "README.md"),
		},
		{
			key: "architecture",
			title: "Architecture",
			description: "Runtime flow, module map, permissions, plan, agents, TUI, state",
			path: path.join(docsDirectory, "ARCHITECTURE.md"),
		},
		{
			key: "extending",
			title: "Extending Flintcode",
			description: "Tools, services, commands, permissions, hooks, MCP, providers, UI, tests",
			path: path.join(docsDirectory, "EXTENDING.md"),
		},
		{
			key: "providers",
			title: "Providers",
			description: "OpenAI-compatible providers, discovery, model selection, gateway and security",
			path: path.join(docsDirectory, "PROVIDERS.md"),
		},
		{
			key: "nous",
			title: "Nous Portal",
			description: "Nous OAuth device flow, shared pi/tau sign-in, Hermes models and status",
			path: path.join(docsDirectory, "NOUS.md"),
		},
		{
			key: "plugins",
			title: "Plugins, MCP and skills",
			description: "pi extension plugins, plugin packs, MCP servers and skills",
			path: path.join(docsDirectory, "PLUGINS.md"),
		},
		{
			key: "limitations",
			title: "Limitations",
			description: "QoderCLI investigation, blocked items, live verification status",
			path: path.join(docsDirectory, "LIMITATIONS.md"),
		},
		{
			key: "agent",
			title: "Agent guide",
			description: "Self-modification workflow, debugging, verification, guardrails",
			path: path.join(docsDirectory, "AGENT-GUIDE.md"),
		},
		{
			key: "agents",
			title: "AGENTS.md",
			description: "Mandatory project rules for LLM agents",
			path: path.join(projectRoot, "AGENTS.md"),
		},
		{
			key: "skill",
			title: "Flintcode extension creator skill",
			description: "Loadable SKILL.md for adding Flintcode tools/features",
			path: path.join(docsDirectory, "skills", "flintcode-extension-creator", "SKILL.md"),
		},
		{
			key: "readme",
			title: "README",
			description: "User-facing features, install, commands, config",
			path: path.join(projectRoot, "README.md"),
		},
	];
}

export async function readDoc(topic: string): Promise<{ info: DocInfo; content: string }> {
	const normalized = topic.trim().toLowerCase().replace(/\.md$/, "");
	const info =
		listDocs().find(
			(entry) => entry.key === normalized || path.basename(entry.path, ".md").toLowerCase() === normalized,
		) ?? listDocs().find((entry) => entry.title.toLowerCase().includes(normalized));
	if (!info) {
		throw new Error(
			`Unknown document "${topic}". Topics: ${listDocs()
				.map((entry) => entry.key)
				.join(", ")}`,
		);
	}
	return { info, content: await fs.readFile(info.path, "utf8") };
}
