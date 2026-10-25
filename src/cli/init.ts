import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureFlintcodeLayout, createFlintcodePaths, resolveFlintcodeHome } from "../core/paths.js";
import { ensureFlintcodeConfig, loadFlintcodeConfig } from "../core/config.js";
import { defaultConfig } from "../core/config.js";
import { writeJsonAtomic, pathExists } from "../util/atomic-json.js";
import { shortPath } from "../util/format.js";
import type { CliArgs } from "./args.js";

export async function runInit(args: CliArgs): Promise<number> {
	const json = args.commandArgs.includes("--json");
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const hadConfig = await pathExists(paths.configFile);
	const { created, config } = await ensureFlintcodeConfig(paths);
	if (created) {
		const seed = defaultConfig(paths.piAgentDir);
		await writeJsonAtomic(paths.configFile, { ...seed, ...config, version: 1 });
	}
	const loaded = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: false });
	const result = {
		home: paths.home,
		configFile: paths.configFile,
		created: !hadConfig,
		piAgentDir: paths.piAgentDir,
		piCompatible: true,
		warnings: loaded.warnings,
	};
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return 0;
	}
	console.log(`Flintcode home:     ${shortPath(paths.home)}`);
	console.log(`Config:       ${shortPath(paths.configFile)}${created ? " (created)" : " (unchanged)"}`);
	console.log(`Sessions:     ${shortPath(paths.sessionsDir)}`);
	console.log(`pi resources: ${shortPath(paths.piAgentDir)}`);
	console.log("");
	if (hadConfig) {
		console.log("Flintcode was already initialized; existing files were left untouched.");
	} else {
		console.log("Created a fresh Flintcode configuration.");
	}
	console.log("Models and credentials are read from pi in place; nothing sensitive was copied.");
	console.log("Next: run `flintcode doctor`, then `flintcode`.");
	const binDir = path.join(process.env.PREFIX ?? "/usr", "bin");
	if (await fs.access(binDir).then(() => true).catch(() => false)) {
		console.log(`Tip: add the project bin to PATH, or symlink bin/flintcode into ${shortPath(binDir)}.`);
	}
	return 0;
}
