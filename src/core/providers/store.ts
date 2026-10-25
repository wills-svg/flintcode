import * as path from "node:path";
import { readJsonResult, writeJsonAtomic } from "../../util/atomic-json.js";
import { withFileLock } from "../../util/lock.js";
import type { FlintcodePaths } from "../paths.js";
import {
	DEFAULT_NOUS_MODEL,
	NOUS_INFERENCE,
	NOUS_WELCOME,
	RESERVED_PROVIDER_IDS,
	type GatewayModelEntry,
	type ProviderAuthEntry,
	type ProviderAuthFile,
	type ProviderConfig,
	type ProviderRegistry,
	type ResolvedManagedModel,
} from "./types.js";

export const GATEWAY_KEY_ENV = "FLINTCODE_GATEWAY_KEY";
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MODEL_ID_RE = /^[^\s\x00-\x1f\x7f]+$/;
const BLOCKED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"upgrade",
	"cookie",
	"set-cookie",
]);

export function providerRegistryFile(paths: FlintcodePaths): string {
	return path.join(paths.home, "providers.json");
}

export function providerAuthFile(paths: FlintcodePaths): string {
	return path.join(paths.home, "providers-auth.json");
}

function emptyRegistry(): ProviderRegistry {
	return { version: 1, providers: [] };
}

function emptyAuth(): ProviderAuthFile {
	return { version: 1, providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

export function normalizeBaseUrl(value: string, label = "Base URL"): string {
	const raw = value.trim();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} must be a valid http(s) URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use http or https`);
	if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
	if (url.hash) throw new Error(`${label} must not contain a fragment`);
	return url.toString().replace(/\/+$/, "");
}

function validateHeaders(headers: unknown): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	if (!isRecord(headers)) throw new Error("headers must be an object of string values");
	const output: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const header = name.trim().toLowerCase();
		if (!HEADER_NAME_RE.test(header)) throw new Error(`Invalid header name: ${name}`);
		if (BLOCKED_HEADERS.has(header) || header.startsWith("x-flintcode-")) {
			throw new Error(`Header ${name} is managed by Flintcode and cannot be set by a provider`);
		}
		if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
			throw new Error(`Header ${name} must be a non-empty single-line string`);
		}
		output[header] = value.trim();
	}
	return Object.keys(output).length ? output : undefined;
}

function validateModel(raw: unknown, index: number, seen: Set<string>, providerId: string): ProviderConfig["models"][number] {
	if (!isRecord(raw)) throw new Error(`models[${index}] must be an object`);
	const id = optionalString(raw.id);
	if (!id) throw new Error(`models[${index}].id is required`);
	if (!MODEL_ID_RE.test(id)) throw new Error(`Model id ${JSON.stringify(id)} contains whitespace or control characters`);
	const upstreamId = optionalString(raw.upstreamId);
	if (upstreamId && !MODEL_ID_RE.test(upstreamId)) {
		throw new Error(`models[${index}].upstreamId contains whitespace or control characters`);
	}
	const aliases = Array.isArray(raw.aliases)
		? raw.aliases.map((alias, aliasIndex) => {
				if (typeof alias !== "string" || !MODEL_ID_RE.test(alias.trim())) {
					throw new Error(`models[${index}].aliases[${aliasIndex}] is not a valid model id`);
				}
				return alias.trim();
			})
		: undefined;
	for (const key of [id, ...(aliases ?? [])]) {
		const full = `${providerId}/${key}`;
		if (seen.has(full)) throw new Error(`Duplicate model id or alias: ${key}`);
		seen.add(full);
	}
	return {
		id,
		...(optionalString(raw.name) ? { name: optionalString(raw.name) } : {}),
		...(upstreamId ? { upstreamId } : {}),
		...(positiveInt(raw.contextWindow, `models[${index}].contextWindow`) !== undefined
			? { contextWindow: raw.contextWindow as number }
			: {}),
		...(positiveInt(raw.maxOutputTokens, `models[${index}].maxOutputTokens`) !== undefined
			? { maxOutputTokens: raw.maxOutputTokens as number }
			: {}),
		...(typeof raw.vision === "boolean" ? { vision: raw.vision } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...(aliases?.length ? { aliases } : {}),
		...(typeof raw.free === "boolean" ? { free: raw.free } : {}),
	};
}

export function validateProvider(raw: unknown): ProviderConfig {
	if (!isRecord(raw)) throw new Error("provider must be an object");
	const id = optionalString(raw.id)?.toLowerCase();
	if (!id || !PROVIDER_ID_RE.test(id)) throw new Error(`Invalid provider id: ${String(raw.id ?? "")}`);
	if (RESERVED_PROVIDER_IDS.has(id)) throw new Error(`Provider id "${id}" is reserved`);
	const kind = raw.kind;
	if (kind !== "openai-compatible" && kind !== "nous") throw new Error(`Invalid provider kind for ${id}`);
	const baseUrl = normalizeBaseUrl(
		optionalString(raw.baseUrl) ?? "",
		`Provider ${id} base URL`,
	);
	if (kind === "nous" && baseUrl !== NOUS_INFERENCE && baseUrl !== NOUS_WELCOME) {
		throw new Error(
			`Nous providers must use ${NOUS_INFERENCE} (or the welcome API for enterprise accounts); refusing ${baseUrl}`,
		);
	}
	const authRaw = raw.auth;
	if (!isRecord(authRaw)) throw new Error(`Provider ${id} auth is required`);
	let auth: ProviderConfig["auth"];
	if (kind === "nous") {
		if (authRaw.type !== "nous-oauth") throw new Error(`Provider ${id} uses OAuth; auth.type must be nous-oauth`);
		auth = { type: "nous-oauth" };
	} else if (authRaw.type === "none") {
		auth = { type: "none" };
	} else {
		if (authRaw.type !== "api-key") throw new Error(`Provider ${id} auth.type must be api-key or none`);
		const envVar = optionalString(authRaw.envVar);
		if (envVar && !ENV_RE.test(envVar)) throw new Error(`Provider ${id} auth.envVar is not a valid environment variable name`);
		const header = optionalString(authRaw.header)?.toLowerCase();
		if (header && !HEADER_NAME_RE.test(header)) throw new Error(`Provider ${id} auth.header is invalid`);
		if (header && BLOCKED_HEADERS.has(header) && header !== "authorization") {
			throw new Error(`Provider ${id} auth.header ${header} is not allowed`);
		}
		const scheme = authRaw.scheme ?? "bearer";
		if (scheme !== "bearer" && scheme !== "api-key") throw new Error(`Provider ${id} auth.scheme must be bearer or api-key`);
		auth = {
			type: "api-key",
			...(envVar ? { envVar } : {}),
			...(header ? { header } : {}),
			scheme,
		};
	}
	const headers = validateHeaders(raw.headers);
	if (!Array.isArray(raw.models)) throw new Error(`Provider ${id} models must be an array`);
	if (raw.models.length > 500) throw new Error(`Provider ${id} has too many models (max 500)`);
	const seen = new Set<string>();
	const models = raw.models.map((model, index) => validateModel(model, index, seen, id));
	const defaultModel = optionalString(raw.defaultModel);
	if (defaultModel && !models.some((model) => model.id === defaultModel || model.aliases?.includes(defaultModel))) {
		throw new Error(`Provider ${id} defaultModel ${defaultModel} is not one of its models`);
	}
	const discoveryRaw = isRecord(raw.discovery) ? raw.discovery : {};
	const discoveryPath = optionalString(discoveryRaw.path);
	if (discoveryPath && !discoveryPath.startsWith("/")) throw new Error(`Provider ${id} discovery.path must start with /`);
	const now = new Date().toISOString();
	return {
		id,
		name: optionalString(raw.name) ?? id,
		kind,
		enabled: raw.enabled !== false,
		baseUrl,
		auth,
		...(headers ? { headers } : {}),
		models,
		...(defaultModel ? { defaultModel } : {}),
		discovery: {
			enabled: discoveryRaw.enabled !== false,
			...(discoveryPath ? { path: discoveryPath } : {}),
		},
		createdAt: optionalString(raw.createdAt) ?? now,
		updatedAt: optionalString(raw.updatedAt) ?? now,
	};
}

export function parseProviderRegistry(raw: unknown): ProviderRegistry {
	if (!isRecord(raw)) throw new Error("providers.json must contain an object");
	if (raw.version !== undefined && raw.version !== 1) throw new Error("providers.json version must be 1");
	if (!Array.isArray(raw.providers)) throw new Error("providers.json providers must be an array");
	const seen = new Set<string>();
	const providers = raw.providers.map((provider, index) => {
		let validated: ProviderConfig;
		try {
			validated = validateProvider(provider);
		} catch (error) {
			throw new Error(`providers[${index}]: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (seen.has(validated.id)) throw new Error(`Duplicate provider id: ${validated.id}`);
		seen.add(validated.id);
		return validated;
	});
	return { version: 1, providers };
}

export async function loadProviderRegistry(paths: FlintcodePaths): Promise<ProviderRegistry> {
	const result = await readJsonResult<unknown>(providerRegistryFile(paths), emptyRegistry());
	if (result.error) throw new Error(result.error);
	if (!result.exists) return emptyRegistry();
	return parseProviderRegistry(result.value);
}

export async function saveProviderRegistry(paths: FlintcodePaths, registry: ProviderRegistry): Promise<void> {
	const validated = parseProviderRegistry(registry);
	await writeJsonAtomic(providerRegistryFile(paths), validated, { mode: 0o600 });
}

export async function mutateProviderRegistry<T>(
	paths: FlintcodePaths,
	mutate: (registry: ProviderRegistry) => T | Promise<T>,
): Promise<T> {
	return withFileLock(
		providerRegistryFile(paths),
		async () => {
			const registry = await loadProviderRegistry(paths);
			const value = await mutate(registry);
			await saveProviderRegistry(paths, registry);
			return value;
		},
		{ timeoutMs: 15_000 },
	);
}

export function parseProviderAuth(raw: unknown): ProviderAuthFile {
	if (!isRecord(raw)) throw new Error("providers-auth.json must contain an object");
	if (raw.version !== undefined && raw.version !== 1) throw new Error("providers-auth.json version must be 1");
	if (!isRecord(raw.providers)) throw new Error("providers-auth.json providers must be an object");
	const providers: Record<string, ProviderAuthEntry> = {};
	for (const [id, entry] of Object.entries(raw.providers)) {
		if (!isRecord(entry)) throw new Error(`Auth entry for ${id} must be an object`);
		if (entry.type === "api-key") {
			if (typeof entry.apiKey !== "string" || !entry.apiKey) throw new Error(`Auth entry for ${id} is missing apiKey`);
			providers[id] = { type: "api-key", apiKey: entry.apiKey, updatedAt: optionalString(entry.updatedAt) ?? new Date().toISOString() };
		} else if (entry.type === "nous-oauth") {
			if (
				typeof entry.accessToken !== "string" ||
				!entry.accessToken ||
				typeof entry.refreshToken !== "string" ||
				typeof entry.expiresAt !== "number" ||
				typeof entry.tokenType !== "string" ||
				typeof entry.scope !== "string" ||
				typeof entry.baseUrl !== "string"
			) {
				throw new Error(`Auth entry for ${id} is incomplete`);
			}
			providers[id] = {
				type: "nous-oauth",
				accessToken: entry.accessToken,
				refreshToken: entry.refreshToken,
				expiresAt: entry.expiresAt,
				tokenType: entry.tokenType,
				scope: entry.scope,
				baseUrl: normalizeBaseUrl(entry.baseUrl, `Auth entry for ${id} baseUrl`),
				...(optionalString(entry.oauthAccessToken) ? { oauthAccessToken: optionalString(entry.oauthAccessToken) } : {}),
				...(typeof entry.oauthExpiresAt === "number" ? { oauthExpiresAt: entry.oauthExpiresAt } : {}),
				...(typeof entry.agentKeyExpiresAt === "number" ? { agentKeyExpiresAt: entry.agentKeyExpiresAt } : {}),
				...(optionalString(entry.keyId) ? { keyId: optionalString(entry.keyId) } : {}),
				...(optionalString(entry.accountId) ? { accountId: optionalString(entry.accountId) } : {}),
				updatedAt: optionalString(entry.updatedAt) ?? new Date().toISOString(),
			};
		} else {
			throw new Error(`Auth entry for ${id} has an unsupported type`);
		}
	}
	return { version: 1, providers };
}

export async function loadProviderAuth(paths: FlintcodePaths): Promise<ProviderAuthFile> {
	const result = await readJsonResult<unknown>(providerAuthFile(paths), emptyAuth());
	if (result.error) throw new Error(result.error);
	if (!result.exists) return emptyAuth();
	return parseProviderAuth(result.value);
}

export async function saveProviderAuth(paths: FlintcodePaths, auth: ProviderAuthFile): Promise<void> {
	const validated = parseProviderAuth(auth);
	await writeJsonAtomic(providerAuthFile(paths), validated, { mode: 0o600 });
}

export async function mutateProviderAuth<T>(
	paths: FlintcodePaths,
	mutate: (auth: ProviderAuthFile) => T | Promise<T>,
): Promise<T> {
	return withFileLock(
		providerAuthFile(paths),
		async () => {
			const auth = await loadProviderAuth(paths);
			const value = await mutate(auth);
			await saveProviderAuth(paths, auth);
			return value;
		},
		{ timeoutMs: 30_000 },
	);
}

export function findProvider(registry: ProviderRegistry, id: string): ProviderConfig | undefined {
	const normalized = id.trim().toLowerCase();
	return registry.providers.find((provider) => provider.id === normalized);
}

export function managedModelKey(provider: ProviderConfig, modelId: string): string {
	return `${provider.id}/${modelId}`;
}

export function resolveManagedModel(
	registry: ProviderRegistry,
	spec: string,
	options?: { enabledOnly?: boolean },
): ResolvedManagedModel {
	const enabledOnly = options?.enabledOnly ?? true;
	const text = spec.trim().replace(/^flintcode\//, "");
	const candidates = registry.providers.filter((provider) => !enabledOnly || provider.enabled);
	const matchIn = (provider: ProviderConfig, value: string) =>
		provider.models.find((model) => model.id === value || model.aliases?.includes(value));
	const slash = text.indexOf("/");
	if (slash > 0) {
		const providerId = text.slice(0, slash).toLowerCase();
		const modelId = text.slice(slash + 1);
		const provider = candidates.find((entry) => entry.id === providerId);
		if (provider) {
			const model = matchIn(provider, modelId);
			if (model) return { provider, model };
			throw new Error(`Provider ${provider.id} has no model "${modelId}". Run \`flintcode providers show ${provider.id}\`.`);
		}
	}
	const matches: ResolvedManagedModel[] = [];
	for (const provider of candidates) {
		const model = matchIn(provider, text);
		if (model) matches.push({ provider, model });
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(
			`Model "${spec}" is ambiguous: ${matches.map((entry) => managedModelKey(entry.provider, entry.model.id)).join(", ")}`,
		);
	}
	throw new Error(
		`Unknown managed model "${spec}". Use a provider/model key or run \`flintcode providers list\`.`,
	);
}

export function gatewayModels(registry: ProviderRegistry): GatewayModelEntry[] {
	const entries: GatewayModelEntry[] = [];
	const seen = new Set<string>();
	for (const provider of registry.providers) {
		if (!provider.enabled) continue;
		for (const model of provider.models) {
			const key = managedModelKey(provider, model.id);
			if (seen.has(key)) throw new Error(`Duplicate managed model key: ${key}`);
			seen.add(key);
			entries.push({ provider, model, key });
		}
	}
	return entries;
}

export function expandEnvValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
		const name = braced ?? bare;
		const resolved = env[name];
		if (resolved === undefined) throw new Error(`Environment variable ${name} is not set (referenced by a provider header)`);
		return resolved;
	});
}

export function resolveProviderApiKey(
	provider: ProviderConfig,
	auth: ProviderAuthFile,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (provider.auth.type !== "api-key") throw new Error(`Provider ${provider.id} does not use an API key`);
	if (provider.auth.envVar) {
		const value = env[provider.auth.envVar];
		if (!value) {
			throw new Error(`Provider ${provider.id} expects its API key in ${provider.auth.envVar}, which is not set`);
		}
		return value;
	}
	const stored = auth.providers[provider.id];
	if (stored?.type === "api-key" && stored.apiKey) return stored.apiKey;
	throw new Error(`No API key for provider ${provider.id}. Run \`flintcode auth set-key ${provider.id}\` and pipe the key on stdin.`);
}

export function providerRequestHeaders(
	provider: ProviderConfig,
	token: string,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(provider.headers ?? {})) headers[name] = expandEnvValue(value, env);
	if (provider.auth.type === "none") return headers;
	if (provider.auth.type === "nous-oauth") {
		headers["authorization"] = `Bearer ${token}`;
		return headers;
	}
	const scheme = provider.auth.scheme ?? "bearer";
	const header = provider.auth.header ?? (scheme === "api-key" ? "x-api-key" : "authorization");
	headers[header] = scheme === "api-key" ? token : `Bearer ${token}`;
	return headers;
}

export function defaultNousProvider(id = "nous"): ProviderConfig {
	const now = new Date().toISOString();
	return {
		id,
		name: "Nous Portal",
		kind: "nous",
		enabled: true,
		baseUrl: NOUS_INFERENCE,
		auth: { type: "nous-oauth" },
		models: [{ ...DEFAULT_NOUS_MODEL }],
		defaultModel: DEFAULT_NOUS_MODEL.id,
		discovery: { enabled: true },
		createdAt: now,
		updatedAt: now,
	};
}
