import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome } from "../core/paths.js";
import { loadFlintcodeConfig } from "../core/config.js";
import {
	WebService,
	formatFetchResult,
	formatSearchResults,
} from "../core/web.js";
import type { CliArgs } from "./args.js";

function positional(args: CliArgs): string[] {
	const valueFlags = new Set(["--limit", "--max-chars"]);
	const values: string[] = [];
	for (let index = 0; index < args.commandArgs.length; index += 1) {
		const entry = args.commandArgs[index];
		if (entry.startsWith("-")) {
			if (valueFlags.has(entry)) index += 1;
			continue;
		}
		values.push(entry);
	}
	return values;
}

function flagValue(args: CliArgs, name: string): string | undefined {
	const index = args.commandArgs.indexOf(name);
	return index >= 0 ? args.commandArgs[index + 1] : undefined;
}

async function webConfig(args: CliArgs) {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const loaded = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: false });
	return new WebService(loaded.config.web);
}

export async function runSearchCommand(args: CliArgs): Promise<number> {
	const query = positional(args).join(" ").trim();
	if (!query) throw new Error("Usage: flintcode search [--limit N] [--json] <query>");
	const limitRaw = flagValue(args, "--limit");
	const limit = limitRaw ? Number(limitRaw) : undefined;
	if (limitRaw && (!Number.isFinite(limit) || limit! < 1)) {
		throw new Error("--limit must be a positive number");
	}
	const web = await webConfig(args);
	const results = await web.search(query, limit);
	if (args.commandArgs.includes("--json")) {
		console.log(JSON.stringify({ query, results }, null, 2));
		return 0;
	}
	console.log(formatSearchResults(query, results));
	return 0;
}

export async function runFetchCommand(args: CliArgs): Promise<number> {
	const url = positional(args)[0];
	if (!url) throw new Error("Usage: flintcode fetch [--max-chars N] [--json] <url>");
	const maxCharsRaw = flagValue(args, "--max-chars");
	const maxChars = maxCharsRaw ? Number(maxCharsRaw) : undefined;
	const web = await webConfig(args);
	const result = await web.fetchPage(url, maxChars);
	if (args.commandArgs.includes("--json")) {
		console.log(JSON.stringify(result, null, 2));
		return 0;
	}
	console.log(formatFetchResult(result));
	return 0;
}
