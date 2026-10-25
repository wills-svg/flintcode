import { bootstrap } from "./bootstrap.js";
import { createFlintcodeInspectionServices } from "../core/session-host.js";
import { isFreeModel, listModels, modelContextWindow, modelKey, resolveFlintcodeModel } from "../core/models.js";
import type { CliArgs } from "./args.js";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export async function runModelsCommand(args: CliArgs): Promise<number> {
	const json = args.commandArgs.includes("--json");
	const onlyAvailable = args.commandArgs.includes("--available");
	const onlyFree = args.commandArgs.includes("--free");
	let provider: string | undefined;
	for (let index = 0; index < args.commandArgs.length; index += 1) {
		if (args.commandArgs[index] === "--provider") {
			provider = args.commandArgs[index + 1];
			index += 1;
		}
	}
	const boot = await bootstrap(args, { interactive: false });
	const services = await createFlintcodeInspectionServices({
		cwd: args.cwd,
		paths: boot.paths,
		config: boot.config,
		projectTrusted: boot.trust.trusted,
		modelRuntime: boot.modelRuntime,
	});
	const selected = await resolveFlintcodeModel(services.modelRuntime, boot.config);
	const selectedKey = modelKey(selected.model);
	let models = await listModels(services.modelRuntime);
	if (onlyAvailable) models = models.filter((model) => model.available);
	if (onlyFree) models = models.filter((model) => model.free);
	if (provider) models = models.filter((model) => model.model.provider === provider);
	if (json) {
		console.log(
			JSON.stringify(
				{
					default: selectedKey,
					authSource: boot.modelPaths.authPath ? (boot.modelPaths.piAuthUsed ? "pi" : "flintcode") : "none",
					modelsSource: boot.modelPaths.modelsPath
						? boot.modelPaths.piModelsUsed
							? "pi"
							: "flintcode"
						: "builtin",
					models: models.map((entry) => ({
						key: entry.key,
						provider: entry.model.provider,
						id: entry.model.id,
						name: entry.model.name,
						contextWindow: entry.model.contextWindow,
						free: entry.free,
						available: entry.available,
						default: entry.key === selectedKey,
					})),
				},
				null,
				2,
			),
		);
		return models.length ? 0 : 1;
	}
	console.log(
		`Models from ${boot.modelPaths.modelsPath ? (boot.modelPaths.piModelsUsed ? "pi models.json" : "flintcode models.json") : "built-in providers"}` +
			`  auth: ${boot.modelPaths.authPath ? (boot.modelPaths.piAuthUsed ? "pi auth.json" : "flintcode auth.json") : "none"}`,
	);
	console.log(`Default: ${selectedKey}${selected.note ? `  (${selected.note})` : ""}\n`);
	if (models.length === 0) {
		console.log("No models matched.");
		return 1;
	}
	const rows = models.map((entry) => ({
		available: entry.available ? "*" : " ",
		model: entry.key,
		free: entry.free ? "free" : "",
		context: modelContextWindow(entry.model),
		name: entry.model.name ?? "",
		isDefault: entry.key === selectedKey,
	}));
	const modelWidth = Math.min(48, Math.max(...rows.map((row) => row.model.length), 5));
	const contextWidth = Math.max(...rows.map((row) => row.context.length), 7);
	console.log(`  ${pad("MODEL", modelWidth)}  ${pad("CONTEXT", contextWidth)}  FLAGS     NAME`);
	for (const row of rows) {
		console.log(
			`${row.available} ${pad(row.model, modelWidth)}  ${pad(row.context, contextWidth)}  ${pad(
				[row.free, row.isDefault ? "default" : ""].filter(Boolean).join(","),
				9,
			)} ${row.name}`,
		);
	}
	console.log(`\n${models.length} model(s). * = credentials configured.`);
	return 0;
}

export function modelFreeLabel(key: string, free: boolean): string {
	return free ? `${key} (free)` : key;
}

export function modelSummary(entry: Parameters<typeof isFreeModel>[0]): string {
	return `${modelKey(entry)}${isFreeModel(entry) ? " (free)" : ""}`;
}
