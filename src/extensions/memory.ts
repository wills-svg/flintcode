import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodePaths } from "../core/paths.js";
import { MemoryService, formatMemory } from "../core/memory.js";

export function createMemoryExtension(paths: FlintcodePaths, cwd: string) {
	return (pi: ExtensionAPI): void => {
		const memory = new MemoryService(paths, cwd);

		const memorySave = defineTool({
			name: "memory_save",
			label: "Save Memory",
			description:
				"Save a durable fact, preference, or lesson for future sessions. Use scope=project for repository-specific facts and scope=user for general preferences. Keep entries short and self-contained.",
			parameters: Type.Object({
				text: Type.String({ description: "The memory to save" }),
				tags: Type.Optional(Type.Array(Type.String())),
				scope: Type.Optional(
					Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("session")]),
				),
				pinned: Type.Optional(Type.Boolean({ description: "Always inject into context" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false },
			async execute(_toolCallId, params) {
				const record = await memory.save({
					text: params.text,
					...(params.tags ? { tags: params.tags } : {}),
					...(params.scope ? { scope: params.scope } : {}),
					...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
					source: "model",
				});
				return {
					content: [
						{
							type: "text",
							text: `Saved memory ${record.id} (${record.scope}${record.pinned ? ", pinned" : ""}).`,
						},
					],
					details: record,
				};
			},
		});

		const memorySearch = defineTool({
			name: "memory_search",
			label: "Search Memory",
			description: "Search saved memories by keywords and tags. Returns the most relevant entries.",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				const records = await memory.search(params.query, params.limit ?? 8);
				return {
					content: [{ type: "text", text: formatMemory(records) }],
					details: { records },
				};
			},
		});

		const memoryList = defineTool({
			name: "memory_list",
			label: "List Memory",
			description: "List saved memories without searching.",
			parameters: Type.Object({
				pinnedOnly: Type.Optional(Type.Boolean()),
			}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, params) {
				const records = params.pinnedOnly ? await memory.pinned() : await memory.list();
				return {
					content: [{ type: "text", text: formatMemory(records) }],
					details: { records },
				};
			},
		});

		const memoryDelete = defineTool({
			name: "memory_delete",
			label: "Delete Memory",
			description: "Delete a memory by id or unique id prefix.",
			parameters: Type.Object({ id: Type.String() }),
			annotations: { readOnlyHint: false, destructiveHint: true },
			async execute(_toolCallId, params) {
				const removed = await memory.delete(params.id);
				return {
					content: [
						{
							type: "text",
							text: removed ? `Deleted memory ${removed.id}.` : `No memory matched "${params.id}".`,
						},
					],
					details: { removed },
					...(removed ? {} : { isError: true }),
				};
			},
		});

		pi.registerTool(memorySave);
		pi.registerTool(memorySearch);
		pi.registerTool(memoryList);
		pi.registerTool(memoryDelete);
	};
}
