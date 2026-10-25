import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FlintcodeConfig } from "../core/types.js";
import type { FlintcodePaths } from "../core/paths.js";
import type { PermissionEngine } from "../core/permissions.js";
import {
	AgentRunner,
	discoverAgents,
	formatAgentResults,
	sumUsage,
	type AgentProgress,
	type AgentRunRecord,
	type AgentTaskInput,
	type BackgroundAgentRecord,
} from "../core/agent-runner.js";
import { truncateText } from "../util/format.js";

function progressText(progress: AgentProgress[]): string {
	const done = progress.filter((entry) => entry.status === "done").length;
	const lines = [`Subagents ${done}/${progress.length} complete`];
	for (const entry of progress) {
		const activity = entry.activity.slice(-3);
		lines.push(`[${entry.status}] ${entry.agent} · ${entry.description}`);
		for (const line of activity) lines.push(`  ${truncateText(line, 150)}`);
		if (entry.latestText) lines.push(`  “${truncateText(entry.latestText.replace(/\s+/g, " "), 160)}”`);
	}
	return lines.join("\n");
}

function backgroundText(record: BackgroundAgentRecord): string {
	return [
		`Background agent ${record.status}: ${record.agent} · ${record.description}`,
		record.usage
			? `tokens ${record.usage.input} in / ${record.usage.output} out · $${record.usage.cost.total.toFixed(4)}`
			: "",
		record.error ? `error: ${record.error}` : record.output ? truncateText(record.output, 4_000) : "",
	]
		.filter(Boolean)
		.join("\n");
}

function runRecordText(record: AgentRunRecord): string {
	return [
		`${record.kind} agent ${record.status}: ${record.agent} · ${record.description} · ${record.id}`,
		record.usage
			? `tokens ${record.usage.input} in / ${record.usage.output} out · $${record.usage.cost.total.toFixed(4)}`
			: "",
		record.error ? `error: ${record.error}` : record.output ? truncateText(record.output, 4_000) : "",
	]
		.filter(Boolean)
		.join("\n");
}

export function createSubagentExtension(options: {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	cwd: string;
	projectTrusted: boolean;
	modelRuntime: ModelRuntime;
	permissionEngine: PermissionEngine;
}) {
	return async (pi: ExtensionAPI): Promise<void> => {
		const agents = await discoverAgents(options);
		let updateBackgroundCount: (() => void) | undefined;
		const runner = new AgentRunner({
			...options,
			agents,
			notify: (record) => {
				try {
					pi.sendMessage(
						{
							customType: "flintcode.subagent",
							content: backgroundText(record),
							display: true,
							details: {
								id: record.id,
								status: record.status,
								agent: record.agent,
								description: record.description,
								usage: record.usage,
							},
						},
						{ triggerTurn: false },
					);
				} catch {
					// The session may have been replaced or shut down.
				}
				updateBackgroundCount?.();
			},
		});
		pi.on("session_shutdown", () => {
			void runner.dispose();
		});

		const catalog = agents
			.map((agent) => `- ${agent.name}: ${agent.description}`)
			.join("\n");

		const agentTool = defineTool({
			name: "Agent",
			label: "Agent",
			description: `Spawn Flintcode subagents. These run in separate contexts and only their final report returns to you. Multiple independent Agent calls in one message run in parallel; you can also pass tasks[] to fan out explicitly. Each task may override the model and reasoning level. Reasoning must be one of the levels the selected model actually supports; invalid levels are rejected with the supported list. Set background=true to return immediately and receive a message when the agent finishes.\n\nAvailable agents:\n${catalog}`,
			parameters: Type.Object({
				description: Type.String({ description: "Short 3-5 word description of the task" }),
				prompt: Type.Optional(Type.String({ description: "Full task for the subagent" })),
				agent: Type.Optional(Type.String({ description: "Agent name; defaults to general-purpose" })),
				subagent_type: Type.Optional(Type.String({ description: "Alias for agent" })),
				model: Type.Optional(
					Type.String({ description: "Model spec (provider/id) for this call; must exist in the catalog" }),
				),
				thinking: Type.Optional(
					Type.String({ description: "Reasoning level supported by the selected model" }),
				),
				reasoning: Type.Optional(Type.String({ description: "Alias for thinking" })),
				background: Type.Optional(Type.Boolean()),
				tasks: Type.Optional(
					Type.Array(
						Type.Object({
							description: Type.String(),
							prompt: Type.String(),
							agent: Type.Optional(Type.String()),
							subagent_type: Type.Optional(Type.String()),
							model: Type.Optional(Type.String()),
							thinking: Type.Optional(Type.String()),
							reasoning: Type.Optional(Type.String()),
						}),
					),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
			executionMode: "parallel",
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const taskInputs: AgentTaskInput[] = params.tasks?.length
					? params.tasks.map((task) => ({
							description: task.description,
							prompt: task.prompt,
							agent: task.agent ?? task.subagent_type ?? params.agent ?? params.subagent_type,
							...((task.model ?? params.model)
								? { model: task.model ?? params.model }
								: {}),
							...((task.thinking ?? task.reasoning ?? params.thinking ?? params.reasoning)
								? {
										thinking:
											task.thinking ??
											task.reasoning ??
											params.thinking ??
											params.reasoning,
									}
								: {}),
						}))
					: params.prompt
						? [
								{
									description: params.description,
									prompt: params.prompt,
									agent: params.agent ?? params.subagent_type,
									...(params.model ? { model: params.model } : {}),
									...((params.thinking ?? params.reasoning)
										? { thinking: params.thinking ?? params.reasoning }
										: {}),
								},
							]
						: [];
				if (taskInputs.length === 0) {
					throw new Error("Provide prompt, or one or more tasks[].");
				}
				const parentModel = ctx.model;
				const parentThinking = ctx.thinkingLevel ?? "medium";
				if (params.background) {
					const records = runner.startBackground(taskInputs, { parentModel, parentThinking });
					updateBackgroundCount?.();
					return {
						content: [
							{
								type: "text",
								text: [
									`Started ${records.length} background agent(s). Completion will arrive as a message.`,
									...records.map((record) => `- ${record.id} · ${record.agent} · ${record.description}`),
									"Use agent_output to check status or read results.",
								].join("\n"),
							},
						],
						details: {
							background: records.map((record) => ({ id: record.id, agent: record.agent, description: record.description })),
						} as Record<string, unknown>,
					};
				}
				let lastEmit = 0;
				const emit = (progress: AgentProgress[]) => {
					if (!onUpdate) return;
					const now = Date.now();
					if (now - lastEmit < 300) return;
					lastEmit = now;
					onUpdate({
						content: [{ type: "text", text: progressText(progress) }],
						details: { kind: "progress", progress } as Record<string, unknown>,
					});
				};
				const results = await runner.runTasks(taskInputs, {
					parentModel,
					parentThinking,
					signal,
					onProgress: emit,
				});
				const usage = sumUsage(results);
				const allFailed = results.every((result) => result.status !== "done");
				return {
					content: [
						{
							type: "text",
							text: formatAgentResults(results),
						},
					],
					details: { results, usage } as Record<string, unknown>,
					...(usage ? { usage } : {}),
					...(allFailed ? { isError: true } : {}),
				};
			},
		});

		const outputTool = defineTool({
			name: "agent_output",
			label: "Agent Output",
			description: "List background and recently completed foreground subagents, or read one run by id/prefix.",
			parameters: Type.Object({
				id: Type.Optional(Type.String()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				if (params.id) {
					const record = runner.getRunRecord(params.id);
					if (!record) {
						return {
							content: [{ type: "text", text: `No agent run matched "${params.id}".` }],
							details: { record: null, records: [] as AgentRunRecord[] },
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: runRecordText(record) }],
						details: {
							record: record as AgentRunRecord | null,
							records: [] as AgentRunRecord[],
						},
					};
				}
				const records = runner.listRuns();
				if (records.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No background or completed foreground agent runs have been recorded in this Flintcode process.",
							},
						],
						details: { record: null, records: [] as AgentRunRecord[] },
					};
				}
				return {
					content: [{ type: "text", text: records.map(runRecordText).join("\n\n") }],
					details: {
						record: null,
						records: records as AgentRunRecord[],
					},
				};
			},
		});

		pi.registerTool(agentTool);
		pi.registerTool(outputTool);
	};
}
