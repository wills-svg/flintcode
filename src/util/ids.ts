import { randomBytes } from "node:crypto";

export function newId(prefix?: string): string {
	const random = randomBytes(8).toString("hex");
	const stamp = Date.now().toString(36);
	return `${prefix ? `${prefix}_` : ""}${stamp}${random}`;
}

export function newTaskId(): string {
	return randomBytes(4).toString("hex");
}
