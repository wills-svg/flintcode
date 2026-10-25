import * as path from "node:path";
import type { FlintcodePaths } from "./paths.js";
import type { TodoItem, TodoStatus, TodoStore } from "./types.js";
import { readJson, writeJsonAtomic } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import { newId } from "../util/ids.js";

const EMPTY_STORE: TodoStore = { version: 1, nextId: 1, items: [] };

function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function todoFilePath(paths: FlintcodePaths, sessionId: string): string {
	return path.join(paths.stateDir, "todos", `${safeSessionId(sessionId)}.json`);
}

export async function loadSessionTodos(paths: FlintcodePaths, sessionId: string): Promise<TodoStore> {
	const raw = await readJson<unknown>(todoFilePath(paths, sessionId), EMPTY_STORE);
	if (!raw || typeof raw !== "object") return { ...EMPTY_STORE, items: [] };
	const store = raw as Partial<TodoStore>;
	return {
		version: 1,
		nextId: typeof store.nextId === "number" ? store.nextId : 1,
		items: Array.isArray(store.items) ? (store.items as TodoItem[]) : [],
	};
}

export async function saveSessionTodos(
	paths: FlintcodePaths,
	sessionId: string,
	store: TodoStore,
): Promise<void> {
	await writeJsonAtomic(todoFilePath(paths, sessionId), store);
}

export async function updateSessionTodos(
	paths: FlintcodePaths,
	sessionId: string,
	mutate: (store: TodoStore) => TodoStore | Promise<TodoStore>,
): Promise<TodoStore> {
	const filePath = todoFilePath(paths, sessionId);
	return withFileLock(filePath, async () => {
		const current = await loadSessionTodos(paths, sessionId);
		const next = await mutate(current);
		await writeJsonAtomic(filePath, next);
		return next;
	});
}

export interface TodoInput {
	id?: string;
	content: string;
	status: TodoStatus;
	priority?: "low" | "medium" | "high";
	notes?: string;
}

export function replaceTodos(store: TodoStore, inputs: TodoInput[]): TodoStore {
	const now = new Date().toISOString();
	let nextId = store.nextId;
	const previous = new Map(store.items.map((item) => [item.id, item]));
	const items = inputs.map((input) => {
		const existing = input.id ? previous.get(input.id) : undefined;
		const id = input.id ?? `todo-${nextId++}`;
		return {
			id,
			title: input.content,
			status: input.status,
			...(input.priority ?? existing?.priority
				? { priority: input.priority ?? existing?.priority }
				: {}),
			...(input.notes ?? existing?.notes ? { notes: input.notes ?? existing?.notes } : {}),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		} satisfies TodoItem;
	});
	return { version: 1, nextId, items };
}

const MARKERS: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
	cancelled: "[-]",
};

export function formatTodos(store: TodoStore): string {
	if (store.items.length === 0) return "No todos.";
	const counts = store.items.reduce<Record<TodoStatus, number>>(
		(acc, item) => {
			acc[item.status] += 1;
			return acc;
		},
		{ pending: 0, in_progress: 0, completed: 0, cancelled: 0 },
	);
	const lines = [
		`Todos: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed${
			counts.cancelled ? `, ${counts.cancelled} cancelled` : ""
		}`,
		"",
		...store.items.map((item) => {
			const priority = item.priority && item.priority !== "medium" ? ` (${item.priority})` : "";
			const notes = item.notes ? `\n    ${item.notes}` : "";
			return `${MARKERS[item.status]} ${item.id}  ${item.title}${priority}${notes}`;
		}),
	];
	return lines.join("\n");
}

export function newTodoId(): string {
	return newId("todo");
}
