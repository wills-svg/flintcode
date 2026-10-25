import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FlintcodePaths } from "./paths.js";
import { ensureDir } from "../util/atomic-json.js";
import { shortPath } from "../util/format.js";

export async function savePlan(paths: FlintcodePaths, cwd: string, plan: string): Promise<string> {
	await ensureDir(paths.plansDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filePath = path.join(paths.plansDir, `${stamp}.md`);
	const content = [
		"---",
		`created: ${new Date().toISOString()}`,
		`cwd: ${cwd}`,
		"source: flintcode-plan-mode",
		"---",
		"",
		"# Flintcode plan",
		"",
		plan.trim(),
		"",
	].join("\n");
	await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return shortPath(filePath);
}
