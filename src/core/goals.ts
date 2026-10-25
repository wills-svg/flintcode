import * as path from "node:path";
import type { FlintcodePaths } from "./paths.js";
import type { GoalRecord } from "./types.js";
import { readJson, writeJsonAtomic } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import { newId } from "../util/ids.js";

interface GoalFile {
	version: 1;
	goals: GoalRecord[];
}

const EMPTY: GoalFile = { version: 1, goals: [] };

export class GoalService {
	private readonly filePath: string;
	private readonly cwd: string;

	constructor(paths: FlintcodePaths, cwd: string) {
		this.filePath = paths.goalsFile;
		this.cwd = path.resolve(cwd);
	}

	async all(): Promise<GoalRecord[]> {
		const raw = await readJson<unknown>(this.filePath, EMPTY);
		if (!raw || typeof raw !== "object") return [];
		const file = raw as Partial<GoalFile>;
		return Array.isArray(file.goals) ? file.goals : [];
	}

	async forWorkspace(): Promise<GoalRecord[]> {
		return (await this.all()).filter(
			(goal) => !goal.cwd || path.resolve(goal.cwd) === this.cwd,
		);
	}

	async active(): Promise<GoalRecord[]> {
		return (await this.forWorkspace()).filter((goal) => goal.status === "active");
	}

	async create(title: string, description?: string): Promise<GoalRecord> {
		return withFileLock(this.filePath, async () => {
			const goals = await this.all();
			const now = new Date().toISOString();
			const goal: GoalRecord = {
				id: newId("goal"),
				title: title.trim(),
				...(description ? { description } : {}),
				status: "active",
				cwd: this.cwd,
				createdAt: now,
				updatedAt: now,
			};
			goals.push(goal);
			await this.save(goals);
			return goal;
		});
	}

	async update(
		idOrPrefix: string,
		patch: Partial<Pick<GoalRecord, "title" | "description" | "status">>,
	): Promise<GoalRecord | undefined> {
		return withFileLock(this.filePath, async () => {
			const goals = await this.all();
			const goal = goals.find(
				(entry) => entry.id === idOrPrefix || entry.id.startsWith(idOrPrefix),
			);
			if (!goal) return undefined;
			if (patch.title !== undefined) goal.title = patch.title;
			if (patch.description !== undefined) goal.description = patch.description;
			if (patch.status !== undefined) goal.status = patch.status;
			goal.updatedAt = new Date().toISOString();
			await this.save(goals);
			return goal;
		});
	}

	async remove(idOrPrefix: string): Promise<boolean> {
		return withFileLock(this.filePath, async () => {
			const goals = await this.all();
			const index = goals.findIndex(
				(entry) => entry.id === idOrPrefix || entry.id.startsWith(idOrPrefix),
			);
			if (index === -1) return false;
			goals.splice(index, 1);
			await this.save(goals);
			return true;
		});
	}

	private async save(goals: GoalRecord[]): Promise<void> {
		await writeJsonAtomic(this.filePath, { version: 1, goals } satisfies GoalFile);
	}
}

export function formatGoals(goals: GoalRecord[]): string {
	if (goals.length === 0) return "No goals for this workspace.";
	return goals
		.map((goal) => {
			const marker =
				goal.status === "active" ? ">" : goal.status === "complete" ? "+" : goal.status === "blocked" ? "!" : "-";
			return `${marker} ${goal.id.slice(0, 12)}  ${goal.title}  [${goal.status}]${
				goal.description ? `\n    ${goal.description}` : ""
			}`;
		})
		.join("\n");
}
