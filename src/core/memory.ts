import * as path from "node:path";
import type { FlintcodePaths } from "./paths.js";
import type { MemoryRecord } from "./types.js";
import { readJsonl, writeJsonlAtomic } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import { newId } from "../util/ids.js";

export interface MemoryInput {
	text: string;
	tags?: string[];
	scope?: "user" | "project" | "session";
	pinned?: boolean;
	source?: string;
}

export class MemoryService {
	private readonly filePath: string;
	private readonly cwd: string;

	constructor(paths: FlintcodePaths, cwd: string) {
		this.filePath = paths.memoryFile;
		this.cwd = path.resolve(cwd);
	}

	async list(): Promise<MemoryRecord[]> {
		return readJsonl<MemoryRecord>(this.filePath);
	}

	async save(input: MemoryInput): Promise<MemoryRecord> {
		return withFileLock(this.filePath, async () => {
			const records = await this.list();
			const now = new Date().toISOString();
			const record: MemoryRecord = {
				id: newId("mem"),
				scope: input.scope ?? "project",
				text: input.text.trim(),
				tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
				source: input.source ?? "model",
				pinned: input.pinned === true,
				...(input.scope === "project" || !input.scope ? { cwd: this.cwd } : {}),
				createdAt: now,
				updatedAt: now,
			};
			records.push(record);
			await writeJsonlAtomic(this.filePath, records);
			return record;
		});
	}

	async delete(idOrPrefix: string): Promise<MemoryRecord | undefined> {
		return withFileLock(this.filePath, async () => {
			const records = await this.list();
			const index = records.findIndex(
				(record) => record.id === idOrPrefix || record.id.startsWith(idOrPrefix),
			);
			if (index === -1) return undefined;
			const [removed] = records.splice(index, 1);
			await writeJsonlAtomic(this.filePath, records);
			return removed;
		});
	}

	async search(query: string, limit = 8): Promise<MemoryRecord[]> {
		const records = (await this.list()).filter((record) => this.visible(record));
		if (!query.trim()) return this.rank(records, []).slice(0, limit);
		const tokens = tokenize(query);
		return this.rank(records, tokens).slice(0, limit);
	}

	async pinned(): Promise<MemoryRecord[]> {
		return (await this.list()).filter((record) => record.pinned && this.visible(record));
	}

	async relevantForPrompt(prompt: string, limit = 5): Promise<MemoryRecord[]> {
		const pinned = await this.pinned();
		const matches = await this.search(prompt, limit);
		const seen = new Set<string>();
		const combined: MemoryRecord[] = [];
		for (const record of [...pinned, ...matches]) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			combined.push(record);
			if (combined.length >= limit + pinned.length) break;
		}
		return combined;
	}

	private visible(record: MemoryRecord): boolean {
		if (record.scope === "user" || record.scope === "session") return true;
		return !record.cwd || path.resolve(record.cwd) === this.cwd;
	}

	private rank(records: MemoryRecord[], tokens: string[]): MemoryRecord[] {
		const now = Date.now();
		return [...records].sort((left, right) => this.score(right, tokens, now) - this.score(left, tokens, now));
	}

	private score(record: MemoryRecord, tokens: string[], now: number): number {
		const haystack = `${record.text} ${record.tags.join(" ")}`.toLowerCase();
		let score = record.pinned ? 5 : 0;
		for (const token of tokens) {
			if (haystack.includes(token)) score += token.length > 4 ? 3 : 2;
		}
		const ageDays = Math.max(0, (now - Date.parse(record.updatedAt)) / 86_400_000);
		score += Math.max(0, 2 - ageDays / 30);
		return score;
	}
}

function tokenize(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}_-]+/u)
				.filter((token) => token.length >= 3)
				.slice(0, 16),
		),
	];
}

export function formatMemory(records: MemoryRecord[]): string {
	if (records.length === 0) return "No memories.";
	return records
		.map((record) => {
			const tags = record.tags.length ? ` [${record.tags.join(", ")}]` : "";
			const pinned = record.pinned ? " pinned" : "";
			return `- ${record.id.slice(0, 12)} · ${record.scope}${pinned}${tags}\n  ${record.text}`;
		})
		.join("\n");
}
