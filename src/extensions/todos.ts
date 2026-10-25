import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodePaths } from "../core/paths.js";
import {
	formatTodos,
	loadSessionTodos,
	replaceTodos,
	updateSessionTodos,
	type TodoInput,
} from "../core/todos.js";

const STATUS = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("cancelled"),
]);

export function createTodoExtension(paths: FlintcodePaths) {
	return (pi: ExtensionAPI): void => {
		const todoWrite = defineTool({
			name: "TodoWrite",
			label: "Todos",
			description:
				"Replace the session todo list. Use it to plan multi-step work and keep status current (pending, in_progress, completed, cancelled). Each item has content, status, and optional priority/id/notes.",
			parameters: Type.Object({
				todos: Type.Array(
					Type.Object({
						id: Type.Optional(Type.String()),
						content: Type.String(),
						status: STATUS,
						priority: Type.Optional(
							Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
						),
						notes: Type.Optional(Type.String()),
					}),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = ctx.sessionManager.getSessionId();
				const inputs: TodoInput[] = params.todos.map((todo) => ({
					content: todo.content,
					status: todo.status,
					...(todo.id ? { id: todo.id } : {}),
					...(todo.priority ? { priority: todo.priority } : {}),
					...(todo.notes ? { notes: todo.notes } : {}),
				}));
				const next = await updateSessionTodos(paths, sessionId, (store) =>
					replaceTodos(store, inputs),
				);
				pi.appendEntry("flintcode.todos", next);
				return {
					content: [{ type: "text", text: formatTodos(next) }],
					details: next,
				};
			},
		});

		const todoRead = defineTool({
			name: "todo_read",
			label: "Read Todos",
			description: "Read the current session todo list.",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const store = await loadSessionTodos(paths, ctx.sessionManager.getSessionId());
				return {
					content: [{ type: "text", text: formatTodos(store) }],
					details: store,
				};
			},
		});

		pi.registerTool(todoWrite);
		pi.registerTool(todoRead);
	};
}
