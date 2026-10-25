import * as path from "node:path";
import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome } from "../core/paths.js";
import { FlintcodeTrustStore } from "../core/trust.js";
import { shortPath } from "../util/format.js";
import type { CliArgs } from "./args.js";

export async function runTrustCommand(args: CliArgs): Promise<number> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const store = new FlintcodeTrustStore(paths);
	const json = args.commandArgs.includes("--json");
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const action = positional[0] ?? "list";
	const target = positional[1] ? path.resolve(args.cwd, positional[1]) : args.cwd;

	if (action === "list" || action === "status") {
		const entries = await store.list();
		const current = await store.get(args.cwd);
		if (json) {
			console.log(JSON.stringify({ current: { path: args.cwd, decision: current }, entries }, null, 2));
			return 0;
		}
		console.log(`Current: ${shortPath(args.cwd)} -> ${current === null ? "not decided" : current ? "trusted" : "denied"}`);
		if (entries.length === 0) {
			console.log("No saved trust decisions.");
			return 0;
		}
		console.log("\nSaved decisions:");
		for (const entry of entries) {
			console.log(`  ${entry.trusted ? "allow" : "deny "}  ${shortPath(entry.path)}  ${entry.updatedAt.slice(0, 10)}`);
		}
		return 0;
	}
	if (action === "allow" || action === "yes") {
		await store.set(target, true);
		console.log(`Trusted ${shortPath(target)}. Project resources will load on the next run.`);
		return 0;
	}
	if (action === "deny" || action === "no") {
		await store.set(target, false);
		console.log(`Denied trust for ${shortPath(target)}.`);
		return 0;
	}
	if (action === "clear" || action === "reset") {
		await store.set(target, null);
		console.log(`Cleared the trust decision for ${shortPath(target)}.`);
		return 0;
	}
	throw new Error(`Unknown trust action "${action}". Use list, allow, deny, or clear.`);
}
