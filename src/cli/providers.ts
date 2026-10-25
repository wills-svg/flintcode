import * as fs from "node:fs/promises";
import { resolveFlintcodeHome, createFlintcodePaths, ensureFlintcodeLayout } from "../core/paths.js";
import type { CliArgs } from "./args.js";
import {
	DEFAULT_NOUS_MODEL,
	NOUS_INFERENCE,
	type ProviderConfig,
	type ProviderModel,
} from "../core/providers/types.js";
import {
	loadProviderAuth,
	loadProviderRegistry,
	managedModelKey,
	mutateProviderAuth,
	mutateProviderRegistry,
	providerRequestHeaders,
	resolveManagedModel,
	resolveProviderApiKey,
	validateProvider,
} from "../core/providers/store.js";
import { discoverProviderModels, testChatCompletion } from "../core/providers/openai.js";
import { discoverNousModels, ensureNousAccess, loginNous, readPiNousAuth, removeNousAuth } from "../core/providers/nous.js";
import { patchFlintcodeConfig } from "../core/config.js";
import { parseThinkingLevel } from "../core/models.js";
import type { FlintcodePaths } from "../core/paths.js";

interface Parsed {
	flags: Map<string, string[]>;
	positionals: string[];
}

const BOOLEAN_FLAGS = new Set([
	"json",
	"chat",
	"stdin",
	"api-key-stdin",
	"no-discover",
	"discover",
	"yes",
	"all",
	"from-pi",
	"vision",
	"reasoning",
	"free",
	"enabled",
	"no-auth",
]);

function parseFlags(tokens: string[]): Parsed {
	const flags = new Map<string, string[]>();
	const positionals: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--") {
			positionals.push(...tokens.slice(index + 1));
			break;
		}
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const name = token.slice(2, equals === -1 ? undefined : equals).toLowerCase();
		const inline = equals === -1 ? undefined : token.slice(equals + 1);
		let value = inline;
		if (value === undefined) {
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(name)) {
				value = next;
				index += 1;
			} else {
				value = "true";
			}
		}
		const list = flags.get(name) ?? [];
		list.push(value);
		flags.set(name, list);
	}
	return { flags, positionals };
}

function values(parsed: Parsed, name: string): string[] {
	return parsed.flags.get(name) ?? [];
}

function value(parsed: Parsed, name: string): string | undefined {
	return values(parsed, name)[0];
}

function has(parsed: Parsed, name: string): boolean {
	return parsed.flags.has(name);
}

function unknownFlags(parsed: Parsed, allowed: string[]): void {
	const allowedSet = new Set(allowed);
	for (const name of parsed.flags.keys()) {
		if (!allowedSet.has(name)) throw new Error(`Unknown option --${name}`);
	}
}

function requirePositional(parsed: Parsed, index: number, usage: string): string {
	const result = parsed.positionals[index];
	if (!result) throw new Error(`Usage: ${usage}`);
	return result;
}

function usage(line: string): never {
	throw new Error(`Usage: ${line}`);
}

async function cliPaths(args: CliArgs): Promise<FlintcodePaths> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	return paths;
}

async function readSecret(label: string): Promise<string> {
	if (process.stdin.isTTY) {
		throw new Error(`Pipe ${label} on stdin (it is never accepted as a command-line argument).`);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const secret = Buffer.concat(chunks).toString("utf8").trim();
	if (!secret) throw new Error(`No ${label} was provided on stdin`);
	return secret;
}

function parseHeaders(parsed: Parsed): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (const entry of values(parsed, "header")) {
		const colon = entry.indexOf(":");
		if (colon <= 0) throw new Error(`--header must look like "Name: value"; got ${entry}`);
		const name = entry.slice(0, colon).trim().toLowerCase();
		const headerValue = entry.slice(colon + 1).trim();
		if (!name || !headerValue) throw new Error(`--header must look like "Name: value"; got ${entry}`);
		headers[name] = headerValue;
	}
	return Object.keys(headers).length ? headers : undefined;
}

function parseModelFlag(entry: string, parsed: Parsed): ProviderModel {
	const [idPart, upstreamPart] = entry.split("=", 2);
	const id = idPart?.trim();
	if (!id) throw new Error("--model requires a model id");
	const contextWindow = value(parsed, "context-window");
	const maxOutputTokens = value(parsed, "max-output-tokens");
	return {
		id,
		...(upstreamPart?.trim() ? { upstreamId: upstreamPart.trim() } : {}),
		...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
		...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
		...(has(parsed, "vision") ? { vision: true } : {}),
		...(has(parsed, "reasoning") ? { reasoning: true } : {}),
		...(has(parsed, "free") ? { free: true } : {}),
	};
}

function modelFlags(parsed: Parsed): ProviderModel[] {
	const entries = values(parsed, "model").flatMap((entry) => entry.split(",").map((part) => part.trim()).filter(Boolean));
	return entries.map((entry) => parseModelFlag(entry, parsed));
}

function authDescription(provider: ProviderConfig, authConfigured: boolean, nousShared: boolean): string {
	if (provider.auth.type === "nous-oauth") return authConfigured ? "nous session" : nousShared ? "pi session" : "missing";
	if (provider.auth.type === "none") return "no auth";
	if (provider.auth.envVar) return authConfigured ? `env ${provider.auth.envVar}` : `missing ${provider.auth.envVar}`;
	return authConfigured ? "stored key" : "missing";
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function redactedProvider(provider: ProviderConfig): Record<string, unknown> {
	return {
		...provider,
		...(provider.headers
			? { headers: Object.fromEntries(Object.keys(provider.headers).map((name) => [name, "[redacted]"])) }
			: {}),
	};
}

async function printProviders(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["json"]);
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const auth = await loadProviderAuth(paths);
	const piNous = await readPiNousAuth(paths);
	if (has(parsed, "json")) {
		console.log(
			JSON.stringify(
				{
					providers: registry.providers.map((provider) => ({
						...redactedProvider(provider),
						authStatus: authDescription(
							provider,
							provider.auth.type === "nous-oauth"
								? auth.providers[provider.id]?.type === "nous-oauth"
								: provider.auth.type === "none"
									? true
									: provider.auth.envVar
										? Boolean(process.env[provider.auth.envVar])
										: auth.providers[provider.id]?.type === "api-key",
							Boolean(piNous),
						),
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}
	if (!registry.providers.length) {
		console.log("No managed providers. Add one with `flintcode providers add`.");
		return 0;
	}
	const rows = registry.providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		kind: provider.kind,
		enabled: provider.enabled ? "yes" : "no",
		models: String(provider.models.length),
		auth: authDescription(
			provider,
			provider.auth.type === "nous-oauth"
				? auth.providers[provider.id]?.type === "nous-oauth"
				: provider.auth.type === "none"
					? true
					: provider.auth.envVar
						? Boolean(process.env[provider.auth.envVar])
						: auth.providers[provider.id]?.type === "api-key",
			Boolean(piNous),
		),
		url: provider.baseUrl,
	}));
	const widths = {
		id: Math.max(2, ...rows.map((row) => row.id.length)),
		name: Math.max(4, ...rows.map((row) => row.name.length)),
		kind: Math.max(4, ...rows.map((row) => row.kind.length)),
		models: 6,
		auth: Math.max(4, ...rows.map((row) => row.auth.length)),
	};
	console.log(
		`${pad("ID", widths.id)}  ${pad("NAME", widths.name)}  ${pad("KIND", widths.kind)}  ${pad("ON", 3)}  ${pad("MODELS", widths.models)}  ${pad("AUTH", widths.auth)}  BASE URL`,
	);
	for (const row of rows) {
		console.log(
			`${pad(row.id, widths.id)}  ${pad(row.name, widths.name)}  ${pad(row.kind, widths.kind)}  ${pad(row.enabled, 3)}  ${pad(row.models, widths.models)}  ${pad(row.auth, widths.auth)}  ${row.url}`,
		);
	}
	return 0;
}

async function showProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["json"]);
	const id = requirePositional(parsed, 0, "flintcode providers show <id> [--json]");
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const provider = registry.providers.find((entry) => entry.id === id.toLowerCase());
	if (!provider) throw new Error(`No provider named "${id}". Run \`flintcode providers list\`.`);
	const auth = await loadProviderAuth(paths);
	const piNous = await readPiNousAuth(paths);
	const configured =
		provider.auth.type === "nous-oauth"
			? auth.providers[provider.id]?.type === "nous-oauth" || Boolean(piNous)
			: provider.auth.type === "none"
				? true
				: provider.auth.envVar
					? Boolean(process.env[provider.auth.envVar])
					: auth.providers[provider.id]?.type === "api-key";
	if (has(parsed, "json")) {
		console.log(JSON.stringify({ ...redactedProvider(provider), configured }, null, 2));
		return 0;
	}
	console.log(JSON.stringify(redactedProvider(provider), null, 2));
	console.log(`\nAuth: ${authDescription(provider, configured, Boolean(piNous))}`);
	return 0;
}

async function addProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, [
		"base-url",
		"name",
		"kind",
		"api-key-env",
		"auth-header",
		"auth-scheme",
		"header",
		"model",
		"default-model",
		"context-window",
		"max-output-tokens",
		"discovery-path",
		"vision",
		"reasoning",
		"free",
		"api-key-stdin",
		"no-discover",
		"discover",
		"no-auth",
		"json",
	]);
	const id = requirePositional(parsed, 0, "flintcode providers add <id> --base-url <url> [options]").toLowerCase();
	const kind = value(parsed, "kind") ?? "openai-compatible";
	if (kind !== "openai-compatible" && kind !== "nous") throw new Error("--kind must be openai-compatible or nous");
	const baseUrl = value(parsed, "base-url") ?? (kind === "nous" ? NOUS_INFERENCE : undefined);
	if (!baseUrl) usage("flintcode providers add <id> --base-url <url> [options]");
	const headers = parseHeaders(parsed);
	const models = modelFlags(parsed);
	const envVar = value(parsed, "api-key-env");
	if (envVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) throw new Error("--api-key-env must be a valid environment variable name");
	const scheme = value(parsed, "auth-scheme") ?? "bearer";
	if (scheme !== "bearer" && scheme !== "api-key") throw new Error("--auth-scheme must be bearer or api-key");
	const auth = value(parsed, "auth-header")?.toLowerCase();
	const noAuth = has(parsed, "no-auth");
	if (noAuth && kind === "nous") throw new Error("Nous providers require OAuth; --no-auth is only for keyless OpenAI-compatible servers");
	if (noAuth && has(parsed, "api-key-stdin")) throw new Error("--no-auth cannot be combined with --api-key-stdin");
	const authInput =
		kind === "nous"
			? { type: "nous-oauth" as const }
			: noAuth
				? { type: "none" as const }
				: {
						type: "api-key" as const,
						...(envVar ? { envVar } : {}),
						...(auth ? { header: auth } : {}),
						scheme: scheme as "bearer" | "api-key",
					};
	const now = new Date().toISOString();
	let provider: ProviderConfig = validateProvider({
		id,
		name: value(parsed, "name") ?? (kind === "nous" ? "Nous Portal" : id),
		kind,
		enabled: true,
		baseUrl,
		auth: authInput,
		...(headers ? { headers } : {}),
		models: models.length ? models : kind === "nous" ? [{ ...DEFAULT_NOUS_MODEL }] : [],
		discovery: {
			enabled: !has(parsed, "no-discover"),
			...(value(parsed, "discovery-path") ? { path: value(parsed, "discovery-path") } : {}),
		},
		createdAt: now,
		updatedAt: now,
	});
	const paths = await cliPaths(args);
	if (kind === "nous" && has(parsed, "api-key-stdin")) throw new Error("Nous providers sign in with OAuth; use `flintcode login nous` instead");
	const storedKey = kind === "openai-compatible" && has(parsed, "api-key-stdin") ? await readSecret("API key") : undefined;
	if (kind === "openai-compatible" && provider.models.length === 0 && provider.discovery?.enabled !== false && !has(parsed, "no-discover")) {
		const key = storedKey ?? (envVar ? process.env[envVar] : undefined);
		const keyless = provider.auth.type === "none";
		if (keyless || key) {
			try {
				const discoveryKey = key ?? "";
				const discovered = await discoverProviderModels(provider, discoveryKey, providerRequestHeaders(provider, discoveryKey));
				provider = validateProvider({ ...provider, models: discovered, defaultModel: discovered[0]?.id, updatedAt: new Date().toISOString() });
			} catch (error) {
				throw new Error(
					`Provider was not saved: ${error instanceof Error ? error.message : String(error)}. Add at least one --model or pass --no-discover.`,
				);
			}
		} else {
			console.error("flintcode: warning: no API key yet; provider saved without models. Run auth set-key, then providers discover.");
		}
	}
	const requestedDefault = value(parsed, "default-model");
	if (requestedDefault && !provider.models.some((model) => model.id === requestedDefault || model.aliases?.includes(requestedDefault))) {
		throw new Error(`Provider was not saved: default model "${requestedDefault}" is not in its model list`);
	}
	provider = validateProvider({
		...provider,
		...(requestedDefault ? { defaultModel: requestedDefault } : provider.models[0] ? { defaultModel: provider.models[0].id } : {}),
		updatedAt: new Date().toISOString(),
	});
	await mutateProviderRegistry(paths, (registry) => {
		if (registry.providers.some((entry) => entry.id === provider.id)) throw new Error(`Provider ${provider.id} already exists`);
		registry.providers.push(provider);
	});
	if (storedKey) {
		await mutateProviderAuth(paths, (authFile) => {
			authFile.providers[provider.id] = { type: "api-key", apiKey: storedKey, updatedAt: new Date().toISOString() };
		});
	}
	if (has(parsed, "json")) {
		console.log(JSON.stringify({ provider: redactedProvider(provider) }, null, 2));
	} else {
		console.log(`Added provider ${provider.id} (${provider.kind}) with ${provider.models.length} model(s).`);
		if (provider.auth.type === "api-key" && !storedKey && !envVar) {
			console.log(`Next: printf %s "$KEY" | flintcode auth set-key ${provider.id}`);
		}
		if (provider.auth.type === "nous-oauth") console.log(`Next: flintcode login nous`);
		else if (provider.models.length === 0) console.log(`Next: flintcode providers discover ${provider.id}`);
	}
	return 0;
}

async function editProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, [
		"name",
		"base-url",
		"api-key-env",
		"auth-header",
		"auth-scheme",
		"set-header",
		"remove-header",
		"default-model",
		"discovery-path",
		"no-discover",
		"discover",
		"api-key-stdin",
		"no-auth",
		"json",
	]);
	const id = requirePositional(parsed, 0, "flintcode providers edit <id> [options]").toLowerCase();
	const paths = await cliPaths(args);
	let updated: ProviderConfig | undefined;
	await mutateProviderRegistry(paths, (registry) => {
		const provider = registry.providers.find((entry) => entry.id === id);
		if (!provider) throw new Error(`No provider named "${id}"`);
		const existingKeyAuth = provider.auth.type === "api-key" ? provider.auth : { type: "api-key" as const, scheme: "bearer" as const };
		const nextEnv = value(parsed, "api-key-env") ?? existingKeyAuth.envVar;
		const nextHeader = value(parsed, "auth-header")?.toLowerCase() ?? existingKeyAuth.header;
		const nextScheme = (value(parsed, "auth-scheme") ?? existingKeyAuth.scheme ?? "bearer") as "bearer" | "api-key";
		if (nextScheme !== "bearer" && nextScheme !== "api-key") throw new Error("--auth-scheme must be bearer or api-key");
		const keepKeyless =
			provider.auth.type === "none" &&
			!has(parsed, "api-key-env") &&
			!has(parsed, "auth-header") &&
			!has(parsed, "auth-scheme") &&
			!has(parsed, "api-key-stdin");
		const headers = { ...(provider.headers ?? {}) };
		for (const entry of values(parsed, "set-header")) {
			const colon = entry.indexOf(":");
			if (colon <= 0) throw new Error("--set-header must look like \"Name: value\"");
			headers[entry.slice(0, colon).trim().toLowerCase()] = entry.slice(colon + 1).trim();
		}
		for (const name of values(parsed, "remove-header")) delete headers[name.toLowerCase()];
		const next = validateProvider({
			...provider,
			...(value(parsed, "name") ? { name: value(parsed, "name") } : {}),
			...(value(parsed, "base-url") ? { baseUrl: value(parsed, "base-url") } : {}),
			...(value(parsed, "default-model") ? { defaultModel: value(parsed, "default-model") } : {}),
			auth:
				provider.kind === "nous"
					? provider.auth
					: keepKeyless || has(parsed, "no-auth")
						? { type: "none" }
						: {
								type: "api-key",
								...(nextEnv ? { envVar: nextEnv } : {}),
								...(nextHeader ? { header: nextHeader } : {}),
								scheme: nextScheme,
							},
			headers,
			discovery: {
				enabled: has(parsed, "no-discover") ? false : has(parsed, "discover") ? true : provider.discovery?.enabled !== false,
				...(value(parsed, "discovery-path") ?? provider.discovery?.path
					? { path: value(parsed, "discovery-path") ?? provider.discovery?.path }
					: {}),
			},
			updatedAt: new Date().toISOString(),
		});
		const index = registry.providers.findIndex((entry) => entry.id === id);
		registry.providers[index] = next;
		updated = next;
	});
	if (updated?.kind === "nous" && has(parsed, "api-key-stdin")) throw new Error("Nous providers sign in with OAuth; use `flintcode login nous` instead");
	if (updated?.auth.type === "none" && has(parsed, "api-key-stdin")) throw new Error("This provider is keyless; remove --no-auth before storing a key");
	const storedKey = updated?.auth.type === "api-key" && has(parsed, "api-key-stdin") ? await readSecret("API key") : undefined;
	if (storedKey) {
		await mutateProviderAuth(paths, (authFile) => {
			authFile.providers[id] = { type: "api-key", apiKey: storedKey, updatedAt: new Date().toISOString() };
		});
	}
	if (has(parsed, "json")) console.log(JSON.stringify({ provider: updated ? redactedProvider(updated) : null }, null, 2));
	else console.log(`Updated provider ${id}.`);
	return 0;
}

async function removeProviderCommand(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["yes"]);
	const id = requirePositional(parsed, 0, "flintcode providers remove <id> --yes").toLowerCase();
	if (!has(parsed, "yes")) throw new Error("Refusing to delete a provider without --yes");
	const paths = await cliPaths(args);
	await mutateProviderRegistry(paths, (registry) => {
		const index = registry.providers.findIndex((provider) => provider.id === id);
		if (index === -1) throw new Error(`No provider named "${id}"`);
		registry.providers.splice(index, 1);
	});
	await mutateProviderAuth(paths, (auth) => {
		delete auth.providers[id];
	});
	console.log(`Removed provider ${id}.`);
	return 0;
}

async function setEnabled(args: CliArgs, parsed: Parsed, enabled: boolean): Promise<number> {
	unknownFlags(parsed, []);
	const id = requirePositional(parsed, 0, `flintcode providers ${enabled ? "enable" : "disable"} <id>`).toLowerCase();
	const paths = await cliPaths(args);
	await mutateProviderRegistry(paths, (registry) => {
		const provider = registry.providers.find((entry) => entry.id === id);
		if (!provider) throw new Error(`No provider named "${id}"`);
		provider.enabled = enabled;
		provider.updatedAt = new Date().toISOString();
	});
	console.log(`${enabled ? "Enabled" : "Disabled"} provider ${id}.`);
	return 0;
}

interface Credentials {
	token: string;
	headers: Record<string, string>;
}

async function providerCredentials(paths: FlintcodePaths, provider: ProviderConfig): Promise<Credentials> {
	if (provider.kind === "nous") {
		const entry = await ensureNousAccess(paths, provider);
		return {
			token: entry.accessToken,
			headers: { authorization: `Bearer ${entry.accessToken}` },
		};
	}
	if (provider.auth.type === "none") return { token: "", headers: providerRequestHeaders(provider, "") };
	const auth = await loadProviderAuth(paths);
	const key = resolveProviderApiKey(provider, auth);
	return { token: key, headers: providerRequestHeaders(provider, key) };
}

interface DiscoverySummary {
	provider: ProviderConfig;
	models: ProviderModel[];
	added: number;
	updated: number;
	removed: number;
}

async function discoverManagedProvider(paths: FlintcodePaths, provider: ProviderConfig): Promise<DiscoverySummary> {
	if (provider.kind === "nous") {
		const result = await discoverNousModels(paths, provider);
		const registry = await loadProviderRegistry(paths);
		const updated = registry.providers.find((entry) => entry.id === provider.id) ?? provider;
		return { provider: updated, models: result.models, added: result.added, updated: result.updated, removed: 0 };
	}
	const creds = await providerCredentials(paths, provider);
	const models = await discoverProviderModels(provider, creds.token, creds.headers);
	let summary: DiscoverySummary | undefined;
	await mutateProviderRegistry(paths, (registry) => {
		const target = registry.providers.find((entry) => entry.id === provider.id);
		if (!target) throw new Error(`Provider ${provider.id} disappeared while discovering models`);
		const existing = new Map(target.models.map((model) => [model.id, model]));
		const previouslyKnown = new Set(existing.keys());
		let added = 0;
		let updated = 0;
		for (const model of models) {
			const previous = existing.get(model.id);
			if (previous) updated += 1;
			else added += 1;
			existing.set(model.id, {
				...model,
				name: previous?.name && previous.name !== previous.id ? previous.name : model.name,
				...(previous?.aliases?.length ? { aliases: previous.aliases } : {}),
				...(previous?.upstreamId ? { upstreamId: previous.upstreamId } : {}),
				...(previous?.free !== undefined ? { free: previous.free } : {}),
				...(previous?.contextWindow !== undefined && model.contextWindow === undefined ? { contextWindow: previous.contextWindow } : {}),
			});
		}
		target.models = [...existing.values()];
		if (!target.defaultModel || !target.models.some((model) => model.id === target.defaultModel)) {
			target.defaultModel = target.models[0]?.id;
		}
		target.updatedAt = new Date().toISOString();
		summary = {
			provider: target,
			models: target.models,
			added,
			updated,
			removed: [...previouslyKnown].filter((id) => !target.models.some((model) => model.id === id)).length,
		};
	});
	if (!summary) throw new Error(`Could not persist models for provider ${provider.id}`);
	return summary;
}

async function testProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["chat", "json"]);
	const id = requirePositional(parsed, 0, "flintcode providers test <id> [--chat] [--json]").toLowerCase();
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const provider = registry.providers.find((entry) => entry.id === id);
	if (!provider) throw new Error(`No provider named "${id}"`);
	let discovery: DiscoverySummary;
	try {
		discovery = await discoverManagedProvider(paths, provider);
	} catch (error) {
		throw new Error(`Provider ${id} test failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const modelId = discovery.provider.defaultModel ?? discovery.provider.models[0]?.id;
	let chat: Awaited<ReturnType<typeof testChatCompletion>> | undefined;
	if (has(parsed, "chat")) {
		if (!modelId) throw new Error(`Provider ${id} has no models to chat with`);
		const creds = await providerCredentials(paths, discovery.provider);
		chat = await testChatCompletion(discovery.provider, modelId, creds.token, creds.headers);
	}
	const result = {
		ok: chat ? chat.ok : true,
		provider: discovery.provider.id,
		models: discovery.models.length,
		added: discovery.added,
		updated: discovery.updated,
		...(chat ? { chat: { ok: chat.ok, status: chat.status, model: chat.model, detail: chat.detail } } : {}),
	};
	if (has(parsed, "json")) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(`Provider ${discovery.provider.id}: ${discovery.models.length} model(s) (${discovery.added} new, ${discovery.updated} updated).`);
		if (chat) console.log(`Chat test ${chat.ok ? "OK" : "FAILED"} (HTTP ${chat.status}, model ${chat.model})${chat.ok ? "" : `: ${chat.detail}`}`);
	}
	return chat && !chat.ok ? 1 : 0;
}

async function discoverProviders(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["all", "json"]);
	const id = parsed.positionals[0]?.toLowerCase();
	if (!id && !has(parsed, "all")) usage("flintcode providers discover <id> | --all");
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const targets = id ? registry.providers.filter((provider) => provider.id === id) : registry.providers.filter((provider) => provider.enabled);
	if (id && targets.length === 0) throw new Error(`No provider named "${id}"`);
	if (!targets.length) throw new Error("No enabled providers to discover");
	let failed = 0;
	const results: unknown[] = [];
	for (const provider of targets) {
		try {
			const summary = await discoverManagedProvider(paths, provider);
			results.push({ provider: provider.id, ok: true, models: summary.models.length, added: summary.added, updated: summary.updated });
			if (!has(parsed, "json")) {
				console.log(`${provider.id}: ${summary.models.length} model(s), ${summary.added} new, ${summary.updated} updated.`);
			}
		} catch (error) {
			failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			results.push({ provider: provider.id, ok: false, error: message });
			if (!has(parsed, "json")) console.error(`${provider.id}: ${message}`);
		}
	}
	if (has(parsed, "json")) console.log(JSON.stringify({ results }, null, 2));
	return failed ? 1 : 0;
}

async function authSetKey(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["stdin"]);
	const id = requirePositional(parsed, 0, "flintcode auth set-key <provider>").toLowerCase();
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const provider = registry.providers.find((entry) => entry.id === id);
	if (!provider) throw new Error(`No provider named "${id}"`);
	if (provider.auth.type === "nous-oauth") throw new Error(`Provider ${id} uses OAuth; run \`flintcode login ${id}\``);
	if (provider.auth.type === "none") throw new Error(`Provider ${id} is keyless and does not need an API key`);
	const key = await readSecret("API key");
	await mutateProviderAuth(paths, (auth) => {
		auth.providers[id] = { type: "api-key", apiKey: key, updatedAt: new Date().toISOString() };
	});
	console.log(`Stored an API key for ${id} in ${paths.home} (0600).`);
	if (provider.auth.envVar) console.log(`Note: ${provider.auth.envVar} takes precedence over the stored key when set.`);
	return 0;
}

async function authStatus(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["json"]);
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	const auth = await loadProviderAuth(paths);
	const piNous = await readPiNousAuth(paths);
	const rows = registry.providers.map((provider) => {
		const entry = auth.providers[provider.id];
		let kind = "none";
		let detail = "";
		if (provider.auth.type === "nous-oauth") {
			if (entry?.type === "nous-oauth") {
				kind = "nous session";
				detail = `expires ${new Date(entry.expiresAt).toISOString()}${entry.accountId ? ` account ${entry.accountId}` : ""}`;
			} else if (piNous) {
				kind = "pi session";
				detail = `shared from ${paths.piAgentDir}`;
			} else {
				detail = "run flintcode login nous";
			}
		} else if (provider.auth.type === "none") {
			kind = "no auth";
			detail = "keyless endpoint";
		} else if (provider.auth.envVar) {
			kind = process.env[provider.auth.envVar] ? "env key" : "env missing";
			detail = provider.auth.envVar;
		} else if (entry?.type === "api-key") {
			kind = "stored key";
			detail = "in providers-auth.json";
		} else {
			detail = `run flintcode auth set-key ${provider.id}`;
		}
		return {
			provider: provider.id,
			kind,
			configured: kind === "nous session" || kind === "pi session" || kind === "env key" || kind === "stored key" || kind === "no auth",
			detail,
			models: provider.models.length,
			defaultModel: provider.defaultModel ?? null,
			enabled: provider.enabled,
		};
	});
	if (has(parsed, "json")) {
		console.log(JSON.stringify({ providers: rows }, null, 2));
		return 0;
	}
	if (!rows.length) {
		console.log("No managed providers configured.");
		return 0;
	}
	for (const row of rows) {
		console.log(`${row.provider}: ${row.kind}${row.detail ? ` (${row.detail})` : ""} · ${row.models} model(s) · ${row.enabled ? "enabled" : "disabled"}`);
	}
	return 0;
}

async function authRemove(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, []);
	const id = requirePositional(parsed, 0, "flintcode auth remove <provider>").toLowerCase();
	const paths = await cliPaths(args);
	const existed = await withAuthRemoval(paths, id);
	console.log(existed ? `Removed stored credentials for ${id}.` : `No stored credentials for ${id}.`);
	return 0;
}

async function withAuthRemoval(paths: FlintcodePaths, id: string): Promise<boolean> {
	return mutateProviderAuth(paths, (auth) => {
		const existed = Boolean(auth.providers[id]);
		delete auth.providers[id];
		return existed;
	});
}

async function loginProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["from-pi"]);
	const id = (parsed.positionals[0] ?? "nous").toLowerCase();
	const paths = await cliPaths(args);
	let registry = await loadProviderRegistry(paths);
	let provider = registry.providers.find((entry) => entry.id === id);
	if (!provider) {
		if (id !== "nous") throw new Error(`No provider named "${id}". Add it first with \`flintcode providers add\`.`);
		const created = validateProvider({
			...defaultModelNous(id),
			models: [{ ...DEFAULT_NOUS_MODEL }],
			defaultModel: DEFAULT_NOUS_MODEL.id,
		});
		await mutateProviderRegistry(paths, (current) => {
			if (!current.providers.some((entry) => entry.id === id)) current.providers.push(created);
		});
		registry = await loadProviderRegistry(paths);
		provider = registry.providers.find((entry) => entry.id === id);
	}
	if (!provider) throw new Error(`Could not create provider ${id}`);
	if (provider.kind !== "nous") throw new Error(`Provider ${id} is not a Nous provider`);
	if (has(parsed, "from-pi")) {
		const imported = await readPiNousAuth(paths);
		if (!imported) throw new Error(`No Nous sign-in found in ${paths.piAgentDir}/auth.json. Run the pi login first.`);
		await mutateProviderAuth(paths, (auth) => {
			auth.providers[id] = imported;
		});
		console.log(`Imported the shared pi Nous sign-in for ${id}.`);
	} else {
		const entry = await loginNous(paths, id, {
			onInstruction: ({ url, userCode }) => {
				console.log(`Open this URL in your browser and approve the Nous Portal sign-in:\n\n  ${url}\n\nVerification code: ${userCode}\nWaiting for authorization...`);
			},
		});
		console.log(
			`Signed in to Nous Portal${entry.accountId ? ` as ${entry.accountId}` : ""}. Agent key expires ${new Date(entry.expiresAt).toISOString()}.`,
		);
	}
	try {
		const summary = await discoverNousModels(paths, provider);
		console.log(`Discovered ${summary.models.length} Nous model(s) (${summary.added} new).`);
	} catch (error) {
		console.error(`flintcode: warning: signed in, but model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	console.log(`Next: flintcode use ${id}/<model> or flintcode models --provider ${id}`);
	return 0;
}

async function logoutProvider(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, []);
	const id = requirePositional(parsed, 0, "flintcode logout <provider>").toLowerCase();
	const paths = await cliPaths(args);
	const removed = await removeNousAuth(paths, id);
	const keyRemoved = await withAuthRemoval(paths, id);
	const piNous = id === "nous" ? await readPiNousAuth(paths) : undefined;
	if (removed || keyRemoved) console.log(`Removed stored credentials for ${id}.`);
	else console.log(`No stored credentials for ${id}.`);
	if (piNous) {
		console.log(
			`A shared pi Nous sign-in remains in ${paths.piAgentDir}/auth.json; Flintcode may reuse it on the next request. Remove it with pi's auth tools if needed.`,
		);
	}
	return 0;
}

function defaultModelNous(id: string): ProviderConfig {
	const now = new Date().toISOString();
	return {
		id,
		name: "Nous Portal",
		kind: "nous",
		enabled: true,
		baseUrl: NOUS_INFERENCE,
		auth: { type: "nous-oauth" },
		models: [],
		discovery: { enabled: true },
		createdAt: now,
		updatedAt: now,
	};
}

async function useModel(args: CliArgs, parsed: Parsed): Promise<number> {
	unknownFlags(parsed, ["thinking"]);
	const spec = requirePositional(parsed, 0, "flintcode use <provider/model> [--thinking <level>]").trim();
	const paths = await cliPaths(args);
	const registry = await loadProviderRegistry(paths);
	let providerId = "";
	let modelId = "";
	const thinkingFlag = value(parsed, "thinking");
	if (thinkingFlag && !parseThinkingLevel(thinkingFlag)) throw new Error(`Invalid thinking level "${thinkingFlag}". Use off, minimal, low, medium, high, xhigh or max.`);
	let thinking = parseThinkingLevel(thinkingFlag);
	let raw = spec.replace(/^flintcode\//, "");
	const colon = raw.lastIndexOf(":");
	if (colon > 0) {
		const level = parseThinkingLevel(raw.slice(colon + 1));
		if (level) {
			raw = raw.slice(0, colon);
			thinking = thinking ?? level;
		}
	}
	try {
		const resolved = resolveManagedModel(registry, raw);
		providerId = "flintcode";
		modelId = managedModelKey(resolved.provider, resolved.model.id);
	} catch {
		const modelsResult = await fs.readFile(paths.modelsFile, "utf8").catch(() => undefined);
		if (!modelsResult) throw new Error(`Unknown model "${spec}". Run \`flintcode models\`.`);
		let parsedModels: { providers?: Record<string, { models?: Array<{ id?: string }> }> } = {};
		try {
			parsedModels = JSON.parse(modelsResult);
		} catch {
			throw new Error(`Generated ${paths.modelsFile} is not valid JSON; run flintcode models.`);
		}
		const match: Array<{ provider: string; id: string }> = [];
		for (const [provider, entry] of Object.entries(parsedModels.providers ?? {})) {
			for (const model of entry.models ?? []) {
				if (typeof model.id !== "string") continue;
				if (`${provider}/${model.id}` === raw) match.push({ provider, id: model.id });
			}
		}
		if (match.length !== 1) {
			const candidates = match.map((entry) => `${entry.provider}/${entry.id}`).join(", ");
			throw new Error(`Unknown or ambiguous model "${spec}".${candidates ? ` Matches: ${candidates}` : ""} Run \`flintcode models\`.`);
		}
		providerId = match[0].provider;
		modelId = match[0].id;
	}
	const config = await patchFlintcodeConfig(paths, (current) => {
		current.defaults.provider = providerId;
		current.defaults.model = modelId;
		if (thinking) current.defaults.thinking = thinking;
	});
	console.log(`Default model set to ${providerId}/${modelId}${config.defaults.thinking ? ` (thinking: ${config.defaults.thinking})` : ""}.`);
	return 0;
}

export async function runProvidersCommand(args: CliArgs): Promise<number> {
	const parsed = parseFlags(args.commandArgs);
	const sub = parsed.positionals.shift();
	switch (sub) {
		case "list":
			return printProviders(args, parsed);
		case "show":
			return showProvider(args, parsed);
		case "add":
			return addProvider(args, parsed);
		case "edit":
			return editProvider(args, parsed);
		case "remove":
		case "rm":
			return removeProviderCommand(args, parsed);
		case "enable":
			return setEnabled(args, parsed, true);
		case "disable":
			return setEnabled(args, parsed, false);
		case "test":
			return testProvider(args, parsed);
		case "discover":
		case "refresh":
			return discoverProviders(args, parsed);
		default:
			usage("flintcode providers <list|show|add|edit|remove|enable|disable|test|discover>");
	}
}

export async function runAuthCommand(args: CliArgs): Promise<number> {
	const parsed = parseFlags(args.commandArgs);
	const sub = parsed.positionals.shift();
	switch (sub) {
		case "set-key":
		case "set":
			return authSetKey(args, parsed);
		case "status":
		case "list":
			return authStatus(args, parsed);
		case "remove":
		case "delete":
			return authRemove(args, parsed);
		default:
			usage("flintcode auth <set-key|status|remove>");
	}
}

export async function runLoginCommand(args: CliArgs): Promise<number> {
	return loginProvider(args, parseFlags(args.commandArgs));
}

export async function runLogoutCommand(args: CliArgs): Promise<number> {
	return logoutProvider(args, parseFlags(args.commandArgs));
}

export async function runUseCommand(args: CliArgs): Promise<number> {
	return useModel(args, parseFlags(args.commandArgs));
}

export async function runManagedModelsCommand(args: CliArgs, sub: string): Promise<number> {
	const parsed = parseFlags(args.commandArgs);
	parsed.positionals.shift();
	const paths = await cliPaths(args);
	if (sub === "add") {
		unknownFlags(parsed, [
			"name",
			"upstream-id",
			"context-window",
			"max-output-tokens",
			"vision",
			"reasoning",
			"free",
			"alias",
		]);
		const providerId = requirePositional(parsed, 0, "flintcode models add <provider> <model> [options]").toLowerCase();
		const modelId = requirePositional(parsed, 1, "flintcode models add <provider> <model> [options]");
		const model: ProviderModel = {
			id: modelId,
			...(value(parsed, "name") ? { name: value(parsed, "name") } : {}),
			...(value(parsed, "upstream-id") ? { upstreamId: value(parsed, "upstream-id") } : {}),
			...(value(parsed, "context-window") ? { contextWindow: Number(value(parsed, "context-window")) } : {}),
			...(value(parsed, "max-output-tokens") ? { maxOutputTokens: Number(value(parsed, "max-output-tokens")) } : {}),
			...(has(parsed, "vision") ? { vision: true } : {}),
			...(has(parsed, "reasoning") ? { reasoning: true } : {}),
			...(has(parsed, "free") ? { free: true } : {}),
			...(values(parsed, "alias").length ? { aliases: values(parsed, "alias") } : {}),
		};
		await mutateProviderRegistry(paths, (registry) => {
			const provider = registry.providers.find((entry) => entry.id === providerId);
			if (!provider) throw new Error(`No provider named "${providerId}"`);
			if (provider.models.some((entry) => entry.id === model.id || entry.aliases?.includes(model.id))) {
				throw new Error(`Provider ${providerId} already has a model or alias "${model.id}"`);
			}
			provider.models.push(model);
			provider.defaultModel ??= model.id;
			provider.updatedAt = new Date().toISOString();
		});
		console.log(`Added model ${providerId}/${model.id}.`);
		return 0;
	}
	if (sub === "remove" || sub === "rm") {
		unknownFlags(parsed, []);
		const providerId = requirePositional(parsed, 0, "flintcode models remove <provider> <model>").toLowerCase();
		const modelId = requirePositional(parsed, 1, "flintcode models remove <provider> <model>");
		await mutateProviderRegistry(paths, (registry) => {
			const provider = registry.providers.find((entry) => entry.id === providerId);
			if (!provider) throw new Error(`No provider named "${providerId}"`);
			provider.models = provider.models.filter((model) => model.id !== modelId && !model.aliases?.includes(modelId));
			if (provider.defaultModel === modelId) provider.defaultModel = provider.models[0]?.id;
			provider.updatedAt = new Date().toISOString();
		});
		console.log(`Removed model ${providerId}/${modelId}.`);
		return 0;
	}
	if (sub === "alias") {
		unknownFlags(parsed, []);
		const providerId = requirePositional(parsed, 0, "flintcode models alias <provider> <model> <alias>").toLowerCase();
		const modelId = requirePositional(parsed, 1, "flintcode models alias <provider> <model> <alias>");
		const alias = requirePositional(parsed, 2, "flintcode models alias <provider> <model> <alias>");
		await mutateProviderRegistry(paths, (registry) => {
			const provider = registry.providers.find((entry) => entry.id === providerId);
			if (!provider) throw new Error(`No provider named "${providerId}"`);
			const model = provider.models.find((entry) => entry.id === modelId);
			if (!model) throw new Error(`Provider ${providerId} has no model "${modelId}"`);
			if (provider.models.some((entry) => entry.id === alias || entry.aliases?.includes(alias))) {
				throw new Error(`Alias "${alias}" is already used`);
			}
			model.aliases = [...(model.aliases ?? []), alias];
			provider.updatedAt = new Date().toISOString();
		});
		console.log(`Added alias ${providerId}/${alias} -> ${modelId}.`);
		return 0;
	}
	usage("flintcode models <add|remove|alias>");
}
