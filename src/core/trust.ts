import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { ProjectTrustStore, hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { readJson, writeJsonAtomic, pathExists } from "../util/atomic-json.js";
import { withFileLock } from "../util/lock.js";
import type { FlintcodePaths } from "./paths.js";

export type TrustDecision = boolean | null;

interface TrustFile {
	version: 1;
	directories: Record<string, { trusted: boolean; updatedAt: string }>;
}

const EMPTY_TRUST: TrustFile = { version: 1, directories: {} };

export class FlintcodeTrustStore {
	private readonly trustFile: string;

	constructor(paths: FlintcodePaths) {
		this.trustFile = paths.trustFile;
	}

	private async load(): Promise<TrustFile> {
		const raw = await readJson<unknown>(this.trustFile, EMPTY_TRUST);
		if (typeof raw === "object" && raw !== null && "directories" in raw) {
			const directories = (raw as TrustFile).directories;
			if (directories && typeof directories === "object") {
				return { version: 1, directories };
			}
		}
		return { ...EMPTY_TRUST, directories: {} };
	}

	async get(cwd: string): Promise<TrustDecision> {
		const normalized = await normalizeCwd(cwd);
		const file = await this.load();
		const entry = file.directories[normalized];
		return entry ? entry.trusted : null;
	}

	async set(cwd: string, trusted: boolean | null): Promise<void> {
		const normalized = await normalizeCwd(cwd);
		await withFileLock(this.trustFile, async () => {
			const file = await this.load();
			if (trusted === null) {
				delete file.directories[normalized];
			} else {
				file.directories[normalized] = { trusted, updatedAt: new Date().toISOString() };
			}
			await writeJsonAtomic(this.trustFile, file);
		});
	}

	async list(): Promise<Array<{ path: string; trusted: boolean; updatedAt: string }>> {
		const file = await this.load();
		return Object.entries(file.directories)
			.map(([entryPath, value]) => ({ path: entryPath, trusted: value.trusted, updatedAt: value.updatedAt }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}
}

async function normalizeCwd(cwd: string): Promise<string> {
	const resolved = path.resolve(cwd);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}

async function piTrustDecision(paths: FlintcodePaths, cwd: string): Promise<TrustDecision> {
	try {
		if (!(await pathExists(paths.piTrustFile))) return null;
		const store = new ProjectTrustStore(paths.piAgentDir);
		return store.get(cwd);
	} catch {
		return null;
	}
}

export async function projectHasResources(cwd: string): Promise<boolean> {
	const candidates = [
		path.join(cwd, ".flintcode"),
		path.join(cwd, ".pi"),
		path.join(cwd, "AGENTS.md"),
		path.join(cwd, "CLAUDE.md"),
		path.join(cwd, ".agents", "skills"),
	];
	for (const candidate of candidates) {
		if (await pathExists(candidate)) return true;
	}
	try {
		return hasTrustRequiringProjectResources(cwd);
	} catch {
		return false;
	}
}

export interface TrustResolution {
	trusted: boolean;
	needsPrompt: boolean;
	hasResources: boolean;
	reason: string;
}

export interface ResolveTrustOptions {
	cwd: string;
	paths: FlintcodePaths;
	interactive: boolean;
	assumeTrusted?: boolean;
	assumeUntrusted?: boolean;
	usePiTrustStore?: boolean;
	save?: boolean;
}

export async function resolveProjectTrust(options: ResolveTrustOptions): Promise<TrustResolution> {
	const hasResources = await projectHasResources(options.cwd);
	if (!hasResources) {
		return {
			trusted: true,
			needsPrompt: false,
			hasResources: false,
			reason: "no project resources",
		};
	}
	if (options.assumeUntrusted) {
		return {
			trusted: false,
			needsPrompt: false,
			hasResources,
			reason: "trust disabled by flag",
		};
	}
	const store = new FlintcodeTrustStore(options.paths);
	const stored = await store.get(options.cwd);
	if (stored !== null) {
		return { trusted: stored, needsPrompt: false, hasResources, reason: "saved decision" };
	}
	if (options.usePiTrustStore) {
		const piDecision = await piTrustDecision(options.paths, options.cwd);
		if (piDecision !== null) {
			return { trusted: piDecision, needsPrompt: false, hasResources, reason: "pi trust store" };
		}
	}
	if (options.assumeTrusted) {
		await store.set(options.cwd, true);
		return { trusted: true, needsPrompt: false, hasResources, reason: "trusted by flag" };
	}
	if (!options.interactive || !process.stdin.isTTY) {
		return {
			trusted: false,
			needsPrompt: false,
			hasResources,
			reason: "not trusted and no interactive terminal",
		};
	}
	const trusted = await promptForTrust(options.cwd);
	if (options.save !== false) await store.set(options.cwd, trusted);
	return {
		trusted,
		needsPrompt: false,
		hasResources,
		reason: trusted ? "trusted by user" : "declined by user",
	};
}

async function promptForTrust(cwd: string): Promise<boolean> {
	const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await terminal.question(
			`\nFlintcode can load project skills, prompts, agents, hooks and instructions from:\n  ${cwd}\n\nTrust this folder? [y/N] `,
		);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		terminal.close();
	}
}
