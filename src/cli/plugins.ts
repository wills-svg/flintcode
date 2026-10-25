import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome, type FlintcodePaths } from "../core/paths.js";
import { loadFlintcodeConfig, patchFlintcodeConfig } from "../core/config.js";
import { pathExists } from "../util/atomic-json.js";
import type { CliArgs } from "./args.js";

interface PluginManifest {
	name?: string;
	version?: string;
	description?: string;
	extensions?: string[];
}

interface InstalledPlugin {
	name: string;
	kind: "extension" | "pack" | "configured" | "pi-extension";
	path: string;
	configured: boolean;
	description?: string;
}

function option(args: CliArgs, name: string): string | undefined {
	const index = args.commandArgs.indexOf(name);
	if (index === -1) return undefined;
	const value = args.commandArgs[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function pluginUsage(): never {
	throw new Error(
		"Usage: flintcode plugins <list|path|install <file-or-dir>|remove <name>> [--name <name>] [--force] [--yes] [--json]",
	);
}

async function pluginPaths(args: CliArgs): Promise<{ paths: FlintcodePaths; configured: string[] }> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const config = await loadFlintcodeConfig(paths, args.cwd, { projectTrusted: false });
	return { paths, configured: config.config.compat.piExtensions };
}

async function extensionFiles(directory: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /\.(?:ts|js|mjs)$/i.test(entry.name))
			.map((entry) => path.join(directory, entry.name))
			.sort();
	} catch {
		return [];
	}
}

async function packManifests(root: string): Promise<Array<{ dir: string; manifest: PluginManifest }>> {
	const output: Array<{ dir: string; manifest: PluginManifest }> = [];
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				const manifest = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as PluginManifest;
				output.push({ dir, manifest });
			} catch {
				// Not a plugin pack.
			}
		}
	} catch {
		// Missing plugins directory.
	}
	return output.sort((left, right) => left.dir.localeCompare(right.dir));
}

function packName(dir: string, manifest: PluginManifest): string {
	const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : path.basename(dir);
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid plugin name: ${name}`);
	return name;
}

function resolveExtensionPaths(dir: string, manifest: PluginManifest): string[] {
	if (manifest.extensions !== undefined && !Array.isArray(manifest.extensions)) {
		throw new Error("plugin.json extensions must be an array of paths");
	}
	const entries = manifest.extensions?.length ? manifest.extensions : ["index.ts"];
	if (entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
		throw new Error("plugin.json extensions must contain non-empty paths");
	}
	return entries.map((entry) => path.resolve(dir, entry));
}

async function addConfiguredPaths(args: CliArgs, additions: string[]): Promise<void> {
	if (!additions.length) return;
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await patchFlintcodeConfig(paths, (config) => {
		const current = new Set(config.compat.piExtensions);
		for (const addition of additions) current.add(path.resolve(addition));
		config.compat.piExtensions = [...current];
	});
}

async function removeConfiguredPaths(args: CliArgs, removed: string[]): Promise<void> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await patchFlintcodeConfig(paths, (config) => {
		const remove = new Set(removed.map((entry) => path.resolve(entry)));
		config.compat.piExtensions = config.compat.piExtensions.filter((entry) => !remove.has(path.resolve(entry)));
	});
}

async function listPlugins(args: CliArgs): Promise<number> {
	const { paths, configured } = await pluginPaths(args);
	const userExtensions = await extensionFiles(paths.extensionsDir);
	const projectExtensions = await extensionFiles(path.join(paths.projectFlintcodeDir, "extensions"));
	const packs = await packManifests(path.join(paths.home, "plugins"));
	const piExtensions = await extensionFiles(path.join(paths.piAgentDir, "extensions"));
	const configuredResolved = new Set(configured.map((entry) => path.resolve(paths.home, entry)));
	const installed: InstalledPlugin[] = [
		...userExtensions.map((file) => ({
			name: path.basename(file).replace(/\.(?:ts|js|mjs)$/i, ""),
			kind: "extension" as const,
			path: file,
			configured: true,
		})),
		...projectExtensions.map((file) => ({
			name: path.basename(file).replace(/\.(?:ts|js|mjs)$/i, ""),
			kind: "extension" as const,
			path: file,
			configured: true,
		})),
		...packs.map((pack) => ({
			name: packName(pack.dir, pack.manifest),
			kind: "pack" as const,
			path: pack.dir,
			configured: resolveExtensionPaths(pack.dir, pack.manifest).every((entry) => configuredResolved.has(path.resolve(entry))),
			...(typeof pack.manifest.description === "string" ? { description: pack.manifest.description } : {}),
		})),
		...configured
			.filter((entry) => !userExtensions.includes(path.resolve(entry)) && !projectExtensions.includes(path.resolve(entry)))
			.map((entry) => ({
				name: path.basename(entry) || entry,
				kind: "configured" as const,
				path: path.resolve(paths.home, entry),
				configured: true,
			})),
		...piExtensions.map((file) => ({
			name: path.basename(file).replace(/\.(?:ts|js|mjs)$/i, ""),
			kind: "pi-extension" as const,
			path: file,
			configured: false,
		})),
	];
	const json = args.commandArgs.includes("--json");
	if (json) {
		console.log(JSON.stringify({ extensionsDir: paths.extensionsDir, projectExtensionsDir: path.join(paths.projectFlintcodeDir, "extensions"), pluginsDir: path.join(paths.home, "plugins"), configured, plugins: installed }, null, 2));
		return 0;
	}
	if (!installed.length) {
		console.log("No plugins or extensions discovered.");
		console.log(`Install a pi extension file or a plugin pack: flintcode plugins install <path>`);
		return 0;
	}
	for (const plugin of installed) {
		console.log(`${plugin.name}  [${plugin.kind}${plugin.kind === "pack" && !plugin.configured ? ", not enabled" : ""}]`);
		if (plugin.description) console.log(`  ${plugin.description}`);
		console.log(`  ${plugin.path}`);
	}
	console.log(`\n${installed.length} plugin/extension entr${installed.length === 1 ? "y" : "ies"}.`);
	return 0;
}

async function installPlugin(args: CliArgs): Promise<number> {
	const source = args.commandArgs[1];
	if (!source) pluginUsage();
	const stat = await fs.stat(source).catch(() => undefined);
	if (!stat) throw new Error(`Plugin source does not exist: ${source}`);
	const { paths } = await pluginPaths(args);
	const force = args.commandArgs.includes("--force");
	const named = option(args, "--name");
	if (stat.isFile()) {
		if (!/\.(?:ts|js|mjs)$/i.test(source)) throw new Error("Extension plugins must be .ts, .js or .mjs files");
		const name = named ?? path.basename(source).replace(/\.(?:ts|js|mjs)$/i, "");
		if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid plugin name: ${name}`);
		const destination = path.join(paths.extensionsDir, `${name}${path.extname(source)}`);
		if ((await pathExists(destination)) && !force) throw new Error(`${destination} already exists; pass --force to replace it`);
		await fs.mkdir(paths.extensionsDir, { recursive: true });
		await fs.copyFile(source, destination);
		console.log(`Installed extension plugin ${name} at ${destination}.`);
		console.log("Plugins run with the same OS permissions as Flintcode. Start a new session (or use /reload) to load it.");
		return 0;
	}
	if (!stat.isDirectory()) throw new Error("Plugin source must be a file or directory");
	let manifest: PluginManifest;
	try {
		manifest = JSON.parse(await fs.readFile(path.join(source, "plugin.json"), "utf8")) as PluginManifest;
	} catch {
		throw new Error("Plugin pack directories require a valid plugin.json");
	}
	const name = packName(source, manifest);
	if (named && named !== name) throw new Error("--name cannot rename a plugin pack declared in plugin.json");
	const destination = path.join(paths.home, "plugins", name);
	if ((await pathExists(destination)) && !force) throw new Error(`${destination} already exists; pass --force to replace it`);
	if (force) await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.join(paths.home, "plugins"), { recursive: true });
	await fs.cp(source, destination, { recursive: true });
	const extensions = resolveExtensionPaths(destination, manifest);
	for (const extension of extensions) {
		if (!(await pathExists(extension))) {
			await fs.rm(destination, { recursive: true, force: true });
			throw new Error(`Plugin pack is missing extension entry ${path.relative(destination, extension)}`);
		}
	}
	await addConfiguredPaths(args, extensions);
	console.log(`Installed plugin pack ${name} at ${destination} with ${extensions.length} extension(s).`);
	console.log("Plugins run with the same OS permissions as Flintcode. Start a new session to load them.");
	return 0;
}

async function removePlugin(args: CliArgs): Promise<number> {
	const name = args.commandArgs[1];
	if (!name) pluginUsage();
	if (!args.commandArgs.includes("--yes")) throw new Error("Refusing to delete a plugin without --yes");
	const { paths, configured } = await pluginPaths(args);
	let removed = false;
	for (const suffix of [".ts", ".js", ".mjs"]) {
		const file = path.join(paths.extensionsDir, `${name}${suffix}`);
		if (await pathExists(file)) {
			await fs.rm(file, { force: true });
			await removeConfiguredPaths(args, [file]);
			removed = true;
		}
	}
	for (const projectSuffix of [".ts", ".js", ".mjs"]) {
		const file = path.join(paths.projectFlintcodeDir, "extensions", `${name}${projectSuffix}`);
		if (await pathExists(file)) {
			await fs.rm(file, { force: true });
			removed = true;
		}
	}
	const packDir = path.join(paths.home, "plugins", name);
	if (await pathExists(packDir)) {
		const manifests = await packManifests(path.join(paths.home, "plugins"));
		const pack = manifests.find((entry) => path.basename(entry.dir) === name);
		const extensions = pack ? resolveExtensionPaths(pack.dir, pack.manifest) : [];
		await removeConfiguredPaths(args, [...extensions, ...configured.filter((entry) => path.resolve(paths.home, entry).startsWith(path.resolve(packDir) + path.sep))]);
		await fs.rm(packDir, { recursive: true, force: true });
		removed = true;
	}
	if (!removed) throw new Error(`No plugin or extension named "${name}"`);
	console.log(`Removed plugin ${name}.`);
	return 0;
}

export async function runPluginsCommand(args: CliArgs): Promise<number> {
	const sub = args.commandArgs[0];
	if (sub === "list" || sub === undefined) {
		return listPlugins(args);
	}
	if (sub === "path") {
		const { paths, configured } = await pluginPaths(args);
		console.log(`extensions: ${paths.extensionsDir}`);
		console.log(`project:    ${path.join(paths.projectFlintcodeDir, "extensions")}`);
		console.log(`packs:      ${path.join(paths.home, "plugins")}`);
		console.log(`pi:         ${path.join(paths.piAgentDir, "extensions")}`);
		if (configured.length) console.log(`configured: ${configured.join(", ")}`);
		return 0;
	}
	if (sub === "install" || sub === "add") return installPlugin(args);
	if (sub === "remove" || sub === "rm" || sub === "uninstall") return removePlugin(args);
	pluginUsage();
}
