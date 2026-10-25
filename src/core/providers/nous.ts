import * as fs from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../util/lock.js";
import { loadProviderRegistry, saveProviderRegistry, providerAuthFile, loadProviderAuth, saveProviderAuth } from "./store.js";
import { discoverProviderModels, type FetchLike } from "./openai.js";
import {
	NOUS_AGENT_KEY_MIN_TTL_SECONDS,
	NOUS_CLIENT_ID,
	NOUS_INFERENCE,
	NOUS_PORTAL,
	NOUS_SCOPE,
	NOUS_WELCOME,
	type NousAuthEntry,
	type ProviderConfig,
	type ProviderModel,
} from "./types.js";
import type { FlintcodePaths } from "../paths.js";

const REFRESH_LEAD_MS = 2 * 60 * 1000;
const AGENT_KEY_LEAD_MS = 60 * 1000;

interface NousTokenResponse {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
	inference_base_url?: string;
	error?: string;
}

interface NousAgentKeyResponse {
	api_key?: string;
	key_id?: string;
	expires_at?: string;
	expires_in?: number;
	inference_base_url?: string;
}

export interface NousLoginOptions {
	onInstruction?: (info: { url: string; userCode: string; expiresInSeconds: number }) => void;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
	clientId?: string;
	scope?: string;
}

export interface NousAccessOptions {
	fetchImpl?: FetchLike;
	now?: () => number;
	force?: boolean;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function safeInferenceBase(value: unknown): string {
	const candidate = text(value).replace(/\/+$/, "");
	return candidate === NOUS_INFERENCE || candidate === NOUS_WELCOME ? candidate : NOUS_INFERENCE;
}

function claims(token: string): Record<string, unknown> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => !part)) return {};
		const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function accountId(oauthAccess: string | undefined): string | undefined {
	if (!oauthAccess) return undefined;
	const subject = claims(oauthAccess).sub;
	return typeof subject === "string" && subject ? subject : undefined;
}

function parseIso(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function expiresFrom(started: number, seconds: unknown, oauthAccess?: string): number {
	const fromResponse = positive(seconds);
	const content = oauthAccess ? claims(oauthAccess) : {};
	const fromJwt = positive(content.exp);
	if (fromResponse !== undefined) return started + fromResponse * 1000;
	if (fromJwt !== undefined) return fromJwt * 1000;
	return started + 60 * 60 * 1000;
}

async function requestJson(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<{ response: Response; body: string; json?: Record<string, unknown> }> {
	const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
	const body = await response.text();
	let json: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
	} catch {
		// The caller reports the HTTP status without echoing an unknown body.
	}
	return { response, body, json };
}

function tokenForm(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

function buildEntry(
	oauth: NousTokenResponse,
	started: number,
	agent?: NousAgentKeyResponse,
	previous?: NousAuthEntry,
): NousAuthEntry {
	const oauthAccess = text(oauth.access_token) || previous?.oauthAccessToken || "";
	if (!oauthAccess) throw new Error("Nous token response did not include an access token");
	const oauthExpiresAt = expiresFrom(started, oauth.expires_in, oauthAccess);
	const agentKey = text(agent?.api_key);
	const agentKeyExpiresAt = parseIso(agent?.expires_at) ?? (positive(agent?.expires_in) ? started + Number(agent?.expires_in) * 1000 : undefined);
	const accessToken = agentKey || previous?.accessToken || oauthAccess;
	const expiresAt = agentKeyExpiresAt ?? previous?.expiresAt ?? oauthExpiresAt;
	const refreshToken = text(oauth.refresh_token) || previous?.refreshToken || "";
	return {
		type: "nous-oauth",
		accessToken,
		refreshToken,
		expiresAt,
		tokenType: text(oauth.token_type) || previous?.tokenType || "Bearer",
		scope: text(oauth.scope) || previous?.scope || NOUS_SCOPE,
		baseUrl: safeInferenceBase(agent?.inference_base_url ?? oauth.inference_base_url ?? previous?.baseUrl),
		oauthAccessToken: oauthAccess,
		oauthExpiresAt,
		...(agentKeyExpiresAt ? { agentKeyExpiresAt } : {}),
		...(text(agent?.key_id) ? { keyId: text(agent?.key_id) } : {}),
		...(accountId(oauthAccess) ? { accountId: accountId(oauthAccess) } : previous?.accountId ? { accountId: previous.accountId } : {}),
		updatedAt: new Date(started).toISOString(),
	};
}

async function refreshOAuth(
	entry: NousAuthEntry,
	fetchImpl: FetchLike,
	now: () => number,
): Promise<NousAuthEntry> {
	if (!entry.refreshToken) {
		throw new Error("Nous Portal sign-in has no refresh token; run `flintcode login nous` again");
	}
	const started = now();
	const { response, json } = await requestJson(
		fetchImpl,
		`${NOUS_PORTAL}/api/oauth/token`,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
				"x-nous-refresh-token": entry.refreshToken,
			},
			body: tokenForm({ grant_type: "refresh_token", client_id: NOUS_CLIENT_ID, refresh_token: entry.refreshToken }),
		},
		20_000,
	);
	if (!response.ok || !json || !text(json.access_token)) {
		if (response.status === 400 || response.status === 401 || response.status === 403) {
			throw new Error(`Nous Portal sign-in expired (HTTP ${response.status}); run \`flintcode login nous\``);
		}
		throw new Error(`Nous token refresh failed (HTTP ${response.status}); credentials kept`);
	}
	return buildEntry(json as NousTokenResponse, started, undefined, entry);
}

async function mintAgentKey(
	entry: NousAuthEntry,
	fetchImpl: FetchLike,
	now: () => number,
): Promise<NousAuthEntry> {
	if (!entry.oauthAccessToken) {
		throw new Error("Nous Portal sign-in is missing its OAuth access token; run `flintcode login nous` again");
	}
	const started = now();
	const { response, json } = await requestJson(
		fetchImpl,
		`${NOUS_PORTAL}/api/oauth/agent-key`,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${entry.oauthAccessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ min_ttl_seconds: NOUS_AGENT_KEY_MIN_TTL_SECONDS }),
		},
		20_000,
	);
	if (!response.ok || !json || !text(json.api_key)) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Nous agent key mint was refused (HTTP ${response.status}); run \`flintcode login nous\``);
		}
		throw new Error(`Nous agent key mint failed (HTTP ${response.status})`);
	}
	return buildEntry(
		{
			access_token: entry.oauthAccessToken,
			refresh_token: entry.refreshToken,
			token_type: entry.tokenType,
			scope: entry.scope,
			inference_base_url: entry.baseUrl,
		},
		started,
		json as NousAgentKeyResponse,
		entry,
	);
}

export async function readPiNousAuth(paths: FlintcodePaths): Promise<NousAuthEntry | undefined> {
	try {
		const raw = await fs.readFile(join(paths.piAgentDir, "auth.json"), "utf8");
		const parsed = JSON.parse(raw) as { nous?: Record<string, unknown> };
		const nous = parsed.nous;
		if (!nous || nous.type !== "oauth") return undefined;
		const metadata =
			nous.metadata && typeof nous.metadata === "object" && !Array.isArray(nous.metadata)
				? (nous.metadata as Record<string, unknown>)
				: {};
		const agentKey = text(metadata.agentKey) || text(nous.access);
		const refreshToken = text(metadata.refreshToken) || text(nous.refresh);
		const oauthAccess = text(metadata.oauthAccessToken) || (text(metadata.agentKey) ? "" : text(nous.access));
		const oauthExpires = positive(metadata.oauthAccessExpiresAt) ?? positive(nous.expires);
		const agentExpires = parseIso(metadata.agentKeyExpiresAt);
		if (!agentKey || !refreshToken) return undefined;
		const started = Date.now();
		return {
			type: "nous-oauth",
			accessToken: agentKey,
			refreshToken,
			expiresAt: agentExpires ?? positive(nous.expires) ?? started + 30 * 60 * 1000,
			tokenType: "Bearer",
			scope: text(metadata.scope) || NOUS_SCOPE,
			baseUrl: safeInferenceBase(nous.enterpriseUrl),
			...(oauthAccess ? { oauthAccessToken: oauthAccess } : {}),
			...(oauthExpires ? { oauthExpiresAt: oauthExpires } : {}),
			...(agentExpires ? { agentKeyExpiresAt: agentExpires } : {}),
			...(text(metadata.keyId) ? { keyId: text(metadata.keyId) } : {}),
			...(accountId(oauthAccess) ? { accountId: accountId(oauthAccess) } : {}),
			updatedAt: new Date(started).toISOString(),
		};
	} catch {
		return undefined;
	}
}

function usable(entry: NousAuthEntry, now: number): boolean {
	return entry.expiresAt > now + AGENT_KEY_LEAD_MS;
}

export async function ensureNousAccess(
	paths: FlintcodePaths,
	provider: ProviderConfig,
	options?: NousAccessOptions,
): Promise<NousAuthEntry> {
	if (provider.kind !== "nous") throw new Error(`Provider ${provider.id} is not a Nous provider`);
	const fetchImpl = options?.fetchImpl ?? fetch;
	const now = options?.now ?? Date.now;
	return withFileLock(
		providerAuthFile(paths),
		async () => {
			const auth = await loadProviderAuth(paths);
			let entry = auth.providers[provider.id];
			if (!entry || entry.type !== "nous-oauth") {
				const imported = await readPiNousAuth(paths);
				if (imported) {
					auth.providers[provider.id] = imported;
					await saveProviderAuth(paths, auth);
					entry = imported;
				}
			}
			if (!entry || entry.type !== "nous-oauth") {
				throw new Error(
					`Not signed in to Nous Portal for provider ${provider.id}. Run \`flintcode login nous\` or sign in with pi's /login and retry.`,
				);
			}
			if (!options?.force && usable(entry, now())) return entry;
			let current = entry;
			const oauthExpiry = current.oauthExpiresAt ?? current.expiresAt;
			let refreshed = false;
			if (options?.force || !current.oauthAccessToken || oauthExpiry <= now() + REFRESH_LEAD_MS) {
				current = await refreshOAuth(current, fetchImpl, now);
				refreshed = true;
			}
			try {
				current = await mintAgentKey(current, fetchImpl, now);
			} catch (error) {
				if (!refreshed) {
					current = await refreshOAuth(current, fetchImpl, now);
					current = await mintAgentKey(current, fetchImpl, now);
				} else {
					throw error;
				}
			}
			auth.providers[provider.id] = current;
			await saveProviderAuth(paths, auth);
			return current;
		},
		{ timeoutMs: 45_000 },
	);
}

async function deviceCode(fetchImpl: FetchLike, clientId: string, scope: string) {
	const { response, body, json } = await requestJson(
		fetchImpl,
		`${NOUS_PORTAL}/api/oauth/device/code`,
		{
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: tokenForm({ client_id: clientId, scope }),
		},
		20_000,
	);
	const deviceCodeValue = text(json?.device_code);
	const userCode = text(json?.user_code);
	const verification = text(json?.verification_uri_complete) || text(json?.verification_uri);
	const expires = positive(json?.expires_in);
	if (!response.ok || !json || !deviceCodeValue || !userCode || !verification || !expires) {
		const checkpoint = /vercel|challenge|html/i.test(body) || response.status === 403;
		throw new Error(
			checkpoint
				? "Nous Portal returned a browser checkpoint. Sign in at https://portal.nousresearch.com/login and use pi's /login fallback, then run Flintcode again."
				: `Nous device-code request failed (HTTP ${response.status})`,
		);
	}
	const parsed = new URL(verification);
	if (parsed.origin !== NOUS_PORTAL) throw new Error("Nous returned a verification URL outside the portal; refusing it");
	return {
		deviceCode: deviceCodeValue,
		userCode,
		url: parsed.href,
		expiresIn: expires,
		interval: positive(json?.interval) ?? 5,
	};
}

async function pollDeviceCode(
	device: Awaited<ReturnType<typeof deviceCode>>,
	clientId: string,
	fetchImpl: FetchLike,
	now: () => number,
	sleep: (ms: number) => Promise<void>,
	signal?: AbortSignal,
): Promise<NousTokenResponse> {
	const deadline = now() + Math.min(device.expiresIn * 1000, 30 * 60 * 1000);
	let interval = Math.max(1, device.interval);
	for (;;) {
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		if (now() >= deadline) throw new Error("Nous device code expired; run `flintcode login nous` again");
		await sleep(Math.min(interval * 1000, deadline - now()));
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		const { response, json } = await requestJson(
			fetchImpl,
			`${NOUS_PORTAL}/api/oauth/token`,
			{
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
				body: tokenForm({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: clientId,
					device_code: device.deviceCode,
				}),
			},
			20_000,
		);
		if (response.ok && json && text(json.access_token)) return json as NousTokenResponse;
		const code = text(json?.error);
		if (code === "authorization_pending") {
			interval = Math.max(1, device.interval);
			continue;
		}
		if (code === "slow_down") {
			interval = Math.min(30, interval + 5);
			continue;
		}
		if (response.status === 408 || response.status === 429 || response.status >= 500) {
			interval = Math.min(30, interval * 2);
			continue;
		}
		throw new Error(`Nous authorization failed: ${code || `HTTP ${response.status}`}`);
	}
}

export async function loginNous(
	paths: FlintcodePaths,
	providerId: string,
	options?: NousLoginOptions,
): Promise<NousAuthEntry> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const now = options?.now ?? Date.now;
	const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const clientId = options?.clientId ?? NOUS_CLIENT_ID;
	const scope = options?.scope ?? NOUS_SCOPE;
	const device = await deviceCode(fetchImpl, clientId, scope);
	options?.onInstruction?.({ url: device.url, userCode: device.userCode, expiresInSeconds: device.expiresIn });
	const token = await pollDeviceCode(device, clientId, fetchImpl, now, sleep, options?.signal);
	const started = now();
	let entry = buildEntry(token, started);
	entry = await mintAgentKey(entry, fetchImpl, now);
	await withFileLock(
		providerAuthFile(paths),
		async () => {
			const auth = await loadProviderAuth(paths);
			auth.providers[providerId] = entry;
			await saveProviderAuth(paths, auth);
		},
		{ timeoutMs: 20_000 },
	);
	return entry;
}

export async function removeNousAuth(paths: FlintcodePaths, providerId: string): Promise<boolean> {
	return withFileLock(
		providerAuthFile(paths),
		async () => {
			const auth = await loadProviderAuth(paths);
			const existed = Boolean(auth.providers[providerId]);
			delete auth.providers[providerId];
			await saveProviderAuth(paths, auth);
			return existed;
		},
		{ timeoutMs: 20_000 },
	);
}

export async function discoverNousModels(
	paths: FlintcodePaths,
	provider: ProviderConfig,
	options?: NousAccessOptions,
): Promise<{ models: ProviderModel[]; added: number; updated: number }> {
	const entry = await ensureNousAccess(paths, provider, options);
	const fetchImpl = options?.fetchImpl ?? fetch;
	let models: ProviderModel[];
	try {
		models = await discoverProviderModels(provider, entry.accessToken, {
			...(entry.accessToken ? { authorization: `Bearer ${entry.accessToken}` } : {}),
		}, { fetchImpl });
	} catch (first) {
		// Some accounts expose the catalog only to the OAuth token rather than
		// the minted agent key. Try the OAuth token once before surfacing the error.
		if (!entry.oauthAccessToken || entry.oauthAccessToken === entry.accessToken) throw first;
		models = await discoverProviderModels(provider, entry.oauthAccessToken, {
			authorization: `Bearer ${entry.oauthAccessToken}`,
		}, { fetchImpl });
	}
	const existing = new Map(provider.models.map((model) => [model.id, model]));
	let added = 0;
	let updated = 0;
	for (const model of models) {
		const previous = existing.get(model.id);
		if (!previous) added += 1;
		else updated += 1;
		existing.set(model.id, {
			...model,
			...(previous?.aliases?.length ? { aliases: previous.aliases } : {}),
			...(previous?.upstreamId ? { upstreamId: previous.upstreamId } : {}),
			...(previous?.free !== undefined ? { free: previous.free } : {}),
		});
	}
	const registry = await loadProviderRegistry(paths);
	const target = registry.providers.find((entryProvider) => entryProvider.id === provider.id);
	if (!target) throw new Error(`Provider ${provider.id} disappeared while discovering models`);
	target.models = [...existing.values()];
	if (!target.defaultModel || !target.models.some((model) => model.id === target.defaultModel)) {
		target.defaultModel = target.models[0]?.id;
	}
	target.updatedAt = new Date().toISOString();
	await saveProviderRegistry(paths, registry);
	return { models: target.models, added, updated };
}
