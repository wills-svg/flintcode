import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createFlintcodePaths, ensureFlintcodeLayout, type FlintcodePaths } from "../../src/core/paths.js";
import { loadFlintcodeConfig, patchFlintcodeConfig } from "../../src/core/config.js";
import {
	loadProviderAuth,
	loadProviderRegistry,
	managedModelKey,
	mutateProviderAuth,
	mutateProviderRegistry,
	providerAuthFile,
	providerRequestHeaders,
	providerRegistryFile,
	resolveManagedModel,
	resolveProviderApiKey,
	validateProvider,
} from "../../src/core/providers/store.js";
import { discoverProviderModels, mergeDiscoveredModels } from "../../src/core/providers/openai.js";
import { ensureNousAccess, loginNous, readPiNousAuth } from "../../src/core/providers/nous.js";
import { startProviderGateway } from "../../src/core/providers/gateway.js";
import { prepareProviderRuntime } from "../../src/core/providers/runtime.js";
import { NOUS_INFERENCE, type ProviderConfig } from "../../src/core/providers/types.js";

async function tempSetup(prefix: string): Promise<{ root: string; home: string; pi: string; cwd: string; paths: FlintcodePaths }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `flintcode-${prefix}-`));
	const home = path.join(root, "home");
	const pi = path.join(root, "pi");
	const cwd = path.join(root, "cwd");
	await fs.mkdir(cwd, { recursive: true });
	const paths = createFlintcodePaths(home, cwd, pi);
	await ensureFlintcodeLayout(paths);
	return { root, home, pi, cwd, paths };
}

function mockProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
	return validateProvider({
		id: "mock",
		name: "Mock",
		kind: "openai-compatible",
		enabled: true,
		baseUrl: "http://127.0.0.1:9/v1",
		auth: { type: "api-key" },
		models: [{ id: "mock-1", name: "Mock 1" }],
		defaultModel: "mock-1",
		discovery: { enabled: true },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	});
}

test("provider registry validates, persists and resolves aliases", async (t) => {
	const setup = await tempSetup("registry");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const provider = mockProvider({ models: [{ id: "mock-1", aliases: ["fast"] }] });
	await mutateProviderRegistry(setup.paths, (registry) => {
		registry.providers.push(provider);
	});
	const registry = await loadProviderRegistry(setup.paths);
	assert.equal(registry.providers.length, 1);
	assert.equal(registry.providers[0].id, "mock");
	assert.equal(managedModelKey(registry.providers[0], "mock-1"), "mock/mock-1");
	assert.equal(resolveManagedModel(registry, "mock/mock-1").model.id, "mock-1");
	assert.equal(resolveManagedModel(registry, "mock/fast").model.id, "mock-1");
	assert.equal(resolveManagedModel(registry, "fast").model.id, "mock-1");
	assert.throws(() => resolveManagedModel(registry, "missing"), /Unknown managed model/);
	const mode = (await fs.stat(providerRegistryFile(setup.paths))).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("provider validation rejects unsafe values", () => {
	assert.throws(() => mockProvider({ id: "flintcode" }), /reserved/);
	assert.throws(() => mockProvider({ baseUrl: "file:///tmp/model" }), /http|https/);
	assert.throws(() => mockProvider({ models: [{ id: "a" }, { id: "a" }] }), /Duplicate model/);
	assert.throws(() => mockProvider({ defaultModel: "missing" }), /defaultModel/);
	assert.throws(
		() => mockProvider({ headers: { authorization: "secret" } }),
		/managed by Flintcode/,
	);
	assert.throws(
		() =>
			validateProvider({
				id: "nous-test",
				kind: "nous",
				baseUrl: "https://evil.example/v1",
				auth: { type: "nous-oauth" },
				models: [],
			}),
		/must use https:\/\/inference-api\.nousresearch\.com\/v1/,
	);
});

test("API key storage is 0600 and env precedence works", async (t) => {
	const setup = await tempSetup("auth");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const provider = mockProvider();
	await mutateProviderAuth(setup.paths, (auth) => {
		auth.providers[provider.id] = { type: "api-key", apiKey: "stored-key", updatedAt: new Date().toISOString() };
	});
	const auth = await loadProviderAuth(setup.paths);
	assert.equal(resolveProviderApiKey(provider, auth), "stored-key");
	assert.equal((await fs.stat(providerAuthFile(setup.paths))).mode & 0o777, 0o600);
	const withEnv = mockProvider({ auth: { type: "api-key", envVar: "FLINTCODE_TEST_KEY" } });
	assert.equal(resolveProviderApiKey(withEnv, auth, { FLINTCODE_TEST_KEY: "env-key" }), "env-key");
	assert.throws(() => resolveProviderApiKey(withEnv, auth, {}), /FLINTCODE_TEST_KEY/);
});

test("OpenAI model discovery parses metadata and preserves aliases", async () => {
	const provider = mockProvider({ baseUrl: "https://provider.example/v1" });
	const fetchImpl = (async (input: string | URL | Request) => {
		assert.equal(String(input), "https://provider.example/v1/models");
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{ id: "model-a", name: "Model A", context_length: 65536, supported_parameters: ["reasoning"] },
					{ id: "model-b", architecture: { input_modalities: ["text", "image"] }, top_provider: { max_completion_tokens: 4096 } },
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
	const models = await discoverProviderModels(provider, "secret", { authorization: "Bearer secret" }, { fetchImpl });
	assert.equal(models.length, 2);
	assert.equal(models[0].contextWindow, 65536);
	assert.equal(models[0].reasoning, true);
	assert.equal(models[1].vision, true);
	assert.equal(models[1].maxOutputTokens, 4096);
	const merged = mergeDiscoveredModels([{ id: "model-a", name: "Custom A", aliases: ["a"], contextWindow: 1000 }], models);
	assert.equal(merged.added, 1);
	assert.equal(merged.updated, 1);
	assert.equal(merged.models.find((model) => model.id === "model-a")?.name, "Custom A");
	assert.deepEqual(merged.models.find((model) => model.id === "model-a")?.aliases, ["a"]);
});

test("gateway routes, injects provider headers and streams responses", async (t) => {
	const setup = await tempSetup("gateway");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const requests: Array<{ url?: string; auth?: string; header?: string; body: Record<string, unknown> }> = [];
	const upstream = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		requests.push({ url: req.url, auth: req.headers.authorization, header: req.headers["x-test-header"] as string, body });
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "mock-1" }] }));
			return;
		}
		if (req.url === "/v1/chat/completions") {
			if (req.headers.authorization !== "Bearer upstream-key") {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "bad auth" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "MOCK_OK" } }] })}\n\n`);
			res.end("data: [DONE]\n\n");
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
	const port = (upstream.address() as AddressInfo).port;
	const provider = mockProvider({
		baseUrl: `http://127.0.0.1:${port}/v1`,
		headers: { "x-test-header": "injected" },
	});
	await mutateProviderRegistry(setup.paths, (registry) => {
		registry.providers.push(provider);
	});
	await mutateProviderAuth(setup.paths, (auth) => {
		auth.providers[provider.id] = { type: "api-key", apiKey: "upstream-key", updatedAt: new Date().toISOString() };
	});
	const gateway = await startProviderGateway(setup.paths);
	assert.ok(gateway);
	t.after(() => gateway.close());
	assert.equal((await fetch(`${gateway.url}/v1/models`)).status, 401);
	const modelsResponse = await fetch(`${gateway.url}/v1/models`, { headers: { authorization: `Bearer ${gateway.token}` } });
	assert.equal(modelsResponse.status, 200);
	assert.deepEqual(await modelsResponse.json(), { object: "list", data: [{ id: "mock/mock-1", object: "model", owned_by: "mock" }] });
	const response = await fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "mock/mock-1", messages: [{ role: "user", content: "hi" }], stream: true }),
	});
	assert.equal(response.status, 200);
	assert.match(await response.text(), /MOCK_OK/);
	const last = requests.at(-1);
	assert.equal(last?.body.model, "mock-1");
	assert.equal(last?.auth, "Bearer upstream-key");
	assert.equal(last?.header, "injected");
	const unknown = await fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "mock/missing", messages: [] }),
	});
	assert.equal(unknown.status, 400);
});

test("generated models file exposes managed models to pi", async (t) => {
	const setup = await tempSetup("runtime");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const provider = mockProvider();
	await mutateProviderRegistry(setup.paths, (registry) => {
		registry.providers.push(provider);
	});
	const runtime = await prepareProviderRuntime(setup.paths);
	t.after(() => runtime.gateway?.close());
	assert.ok(runtime.gateway);
	const file = JSON.parse(await fs.readFile(setup.paths.modelsFile, "utf8")) as {
		providers: Record<string, { models?: Array<{ id?: string }> }>;
	};
	assert.equal(file.providers.flintcode.models?.[0]?.id, "mock/mock-1");
	assert.equal(process.env.FLINTCODE_GATEWAY_KEY, runtime.gateway.token);
});

function jwt(expSeconds: number, sub = "account-1"): string {
	return `e30.${Buffer.from(JSON.stringify({ exp: expSeconds, sub })).toString("base64url")}.sig`;
}

function nousFetch(options: {
	tokenPolls?: () => Response;
	onRefresh?: () => Response;
	agentKey?: string;
	refreshToken?: string;
}): typeof fetch {
	let pending = 0;
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/oauth/device/code")) {
			return new Response(
				JSON.stringify({
					device_code: "device-1",
					user_code: "CODE-1",
					verification_uri: "https://portal.nousresearch.com/device",
					verification_uri_complete: "https://portal.nousresearch.com/device?user_code=CODE-1",
					expires_in: 600,
					interval: 1,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url.endsWith("/api/oauth/token")) {
			const body = String(init?.body ?? "");
			if (body.includes("refresh_token")) {
				return options.onRefresh
					? options.onRefresh()
					: new Response(
							JSON.stringify({
								access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
								refresh_token: "refresh-2",
								expires_in: 3600,
								scope: "inference:mint_agent_key",
								token_type: "Bearer",
								inference_base_url: NOUS_INFERENCE,
							}),
							{ status: 200, headers: { "content-type": "application/json" } },
						);
			}
			pending += 1;
			if (pending === 1) {
				return new Response(JSON.stringify({ error: "authorization_pending" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
					refresh_token: "refresh-1",
					expires_in: 3600,
					scope: "inference:mint_agent_key",
					token_type: "Bearer",
					inference_base_url: NOUS_INFERENCE,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url.endsWith("/api/oauth/agent-key")) {
			const key = options.agentKey ?? "sk-agent-1";
			return new Response(
				JSON.stringify({
					api_key: key,
					key_id: "key-1",
					expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
					inference_base_url: NOUS_INFERENCE,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
	}) as typeof fetch;
}


test("keyless providers omit the authorization header", async () => {
	const provider = mockProvider({ auth: { type: "none" }, headers: { "x-test": "value" } });
	assert.deepEqual(providerRequestHeaders(provider, ""), { "x-test": "value" });
	assert.throws(() => resolveProviderApiKey(provider, { version: 1, providers: {} }), /does not use an API key/);
});

test("gateway supports keyless OpenAI-compatible upstreams", async (t) => {
	const setup = await tempSetup("keyless-gateway");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	let sawAuthorization: string | undefined = "not-called";
	const upstream = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		sawAuthorization = req.headers.authorization;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"choices":[{"index":0,"delta":{"content":"KEYLESS_OK"}}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
	const port = (upstream.address() as AddressInfo).port;
	const provider = mockProvider({ auth: { type: "none" }, baseUrl: `http://127.0.0.1:${port}/v1` });
	await mutateProviderRegistry(setup.paths, (registry) => {
		registry.providers.push(provider);
	});
	const gateway = await startProviderGateway(setup.paths);
	assert.ok(gateway);
	t.after(() => gateway.close());
	const response = await fetch(`${gateway.url}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "mock/mock-1", messages: [{ role: "user", content: "hi" }], stream: true }),
	});
	assert.equal(response.status, 200);
	assert.match(await response.text(), /KEYLESS_OK/);
	assert.equal(sawAuthorization, undefined);
});

test("Nous login performs device flow, mints a key and persists 0600 credentials", async (t) => {
	const setup = await tempSetup("nous-login");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const provider = validateProvider({
		id: "nous",
		kind: "nous",
		baseUrl: NOUS_INFERENCE,
		auth: { type: "nous-oauth" },
		models: [],
	});
	await mutateProviderRegistry(setup.paths, (registry) => {
		registry.providers.push(provider);
	});
	let instruction: { url?: string; userCode?: string } = {};
	const entry = await loginNous(setup.paths, "nous", {
		fetchImpl: nousFetch({}),
		sleep: async () => undefined,
		now: () => Date.now(),
		onInstruction: (info) => {
			instruction = { url: info.url, userCode: info.userCode };
		},
	});
	assert.match(instruction.url ?? "", /portal\.nousresearch\.com/);
	assert.equal(instruction.userCode, "CODE-1");
	assert.equal(entry.accessToken, "sk-agent-1");
	assert.equal(entry.refreshToken, "refresh-1");
	assert.equal(entry.accountId, "account-1");
	assert.equal((await fs.stat(providerAuthFile(setup.paths))).mode & 0o777, 0o600);
	const auth = await loadProviderAuth(setup.paths);
	assert.equal(auth.providers.nous?.type, "nous-oauth");
	const noNetwork = nousFetch({ agentKey: "should-not-be-used" });
	const reused = await ensureNousAccess(setup.paths, provider, { fetchImpl: noNetwork });
	assert.equal(reused.accessToken, "sk-agent-1");
});

test("Nous forced refresh rotates the refresh token and re-mints", async (t) => {
	const setup = await tempSetup("nous-refresh");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const provider = validateProvider({
		id: "nous",
		kind: "nous",
		baseUrl: NOUS_INFERENCE,
		auth: { type: "nous-oauth" },
		models: [],
	});
	const expired = Date.now() - 1000;
	await mutateProviderAuth(setup.paths, (auth) => {
		auth.providers.nous = {
			type: "nous-oauth",
			accessToken: "old-agent",
			refreshToken: "refresh-1",
			expiresAt: expired,
			tokenType: "Bearer",
			scope: "inference:mint_agent_key",
			baseUrl: NOUS_INFERENCE,
			oauthAccessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
			oauthExpiresAt: Date.now() + 3600_000,
			updatedAt: new Date().toISOString(),
		};
	});
	const entry = await ensureNousAccess(setup.paths, provider, {
		fetchImpl: nousFetch({ agentKey: "sk-agent-2" }),
		force: true,
	});
	assert.equal(entry.accessToken, "sk-agent-2");
	assert.equal(entry.refreshToken, "refresh-2");
	const auth = await loadProviderAuth(setup.paths);
	assert.equal(auth.providers.nous?.type === "nous-oauth" ? auth.providers.nous.refreshToken : "", "refresh-2");
});

test("Nous imports a shared pi sign-in without a second OAuth flow", async (t) => {
	const setup = await tempSetup("nous-pi");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	await fs.mkdir(setup.paths.piAgentDir, { recursive: true });
	await fs.writeFile(
		path.join(setup.paths.piAgentDir, "auth.json"),
		JSON.stringify({
			nous: {
				type: "oauth",
				access: "sk-pi-agent",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
				metadata: {
					agentKey: "sk-pi-agent",
					agentKeyExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
					oauthAccessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
					oauthAccessExpiresAt: Date.now() + 3600_000,
					refreshToken: "pi-refresh",
					scope: "inference:mint_agent_key",
				},
			},
		}),
	);
	const imported = await readPiNousAuth(setup.paths);
	assert.equal(imported?.accessToken, "sk-pi-agent");
	const provider = validateProvider({
		id: "nous",
		kind: "nous",
		baseUrl: NOUS_INFERENCE,
		auth: { type: "nous-oauth" },
		models: [],
	});
	const entry = await ensureNousAccess(setup.paths, provider, {
		fetchImpl: (async () => {
			throw new Error("network must not be used for a usable shared sign-in");
		}) as typeof fetch,
	});
	assert.equal(entry.accessToken, "sk-pi-agent");
});

test("legacy tau config is read and migrated on the next write", async (t) => {
	const setup = await tempSetup("legacy");
	t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
	const legacy = path.join(setup.home, "tau.json");
	await fs.mkdir(setup.home, { recursive: true });
	await fs.writeFile(legacy, JSON.stringify({ version: 1, defaults: { provider: "legacy", model: "model" } }));
	const loaded = await loadFlintcodeConfig(setup.paths, setup.cwd, { projectTrusted: false });
	assert.equal(loaded.config.defaults.provider, "legacy");
	assert.ok(loaded.warnings.some((warning) => /legacy config/.test(warning)));
	await patchFlintcodeConfig(setup.paths, (config) => {
		config.defaults.thinking = "high";
	});
	const migrated = JSON.parse(await fs.readFile(setup.paths.configFile, "utf8")) as { defaults?: { provider?: string; thinking?: string } };
	assert.equal(migrated.defaults?.provider, "legacy");
	assert.equal(migrated.defaults?.thinking, "high");
});
