import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../../util/logger.js";
import type { FlintcodePaths } from "../paths.js";
import {
	gatewayModels,
	loadProviderAuth,
	loadProviderRegistry,
	providerRequestHeaders,
	resolveManagedModel,
	resolveProviderApiKey,
} from "./store.js";
import { chatCompletionsUrl, type FetchLike } from "./openai.js";
import { ensureNousAccess } from "./nous.js";
import type { ProviderConfig } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

export interface ProviderGateway {
	readonly url: string;
	readonly token: string;
	readonly port: number;
	close(): Promise<void>;
}

export interface ProviderGatewayOptions {
	logger?: Logger;
	fetchImpl?: FetchLike;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const payload = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	});
	res.end(payload);
}

function errorBody(message: string): unknown {
	return { error: { message, type: "flintcode_gateway_error" } };
}

function sameToken(received: string, expected: string): boolean {
	const left = Buffer.from(received);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(req: IncomingMessage, token: string): boolean {
	const header = req.headers.authorization;
	if (typeof header === "string" && header.startsWith("Bearer ") && sameToken(header.slice(7), token)) return true;
	const apiKey = req.headers["x-api-key"];
	return typeof apiKey === "string" && sameToken(apiKey, token);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("Request body is too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function responseHeaders(upstream: Response, provider: ProviderConfig): Record<string, string> {
	const headers: Record<string, string> = {};
	const blocked = new Set([
		"connection",
		"content-length",
		"content-encoding",
		"transfer-encoding",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"upgrade",
		"set-cookie",
	]);
	upstream.headers.forEach((value, name) => {
		if (!blocked.has(name.toLowerCase())) headers[name] = value;
	});
	headers["x-flintcode-provider"] = provider.id;
	return headers;
}

function forwardedRequestHeaders(req: IncomingMessage, provider: ProviderConfig, token: string): Record<string, string> {
	const headers: Record<string, string> = {};
	const blocked = new Set([
		"authorization",
		"x-api-key",
		"cookie",
		"host",
		"content-length",
		"connection",
		"transfer-encoding",
		"upgrade",
		"accept-encoding",
		"proxy-authorization",
		"x-flintcode-gateway-key",
	]);
	for (const [name, value] of Object.entries(req.headers)) {
		if (blocked.has(name.toLowerCase()) || value === undefined) continue;
		headers[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	headers["accept-encoding"] = "identity";
	return { ...headers, ...providerRequestHeaders(provider, token) };
}

async function sendUpstream(
	provider: ProviderConfig,
	body: string,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
	controller: AbortController,
): Promise<Response> {
	const timer = setTimeout(() => controller.abort(new Error("upstream connection timed out")), CONNECT_TIMEOUT_MS);
	try {
		return await fetchImpl(chatCompletionsUrl(provider), {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
			redirect: "error",
		});
	} finally {
		clearTimeout(timer);
	}
}

function abortOnClose(res: ServerResponse, controller: AbortController): void {
	res.once("close", () => {
		if (!res.writableEnded) controller.abort(new Error("client disconnected"));
	});
}

export async function startProviderGateway(
	paths: FlintcodePaths,
	options?: ProviderGatewayOptions,
): Promise<ProviderGateway | undefined> {
	const initial = await loadProviderRegistry(paths);
	if (!gatewayModels(initial).length) return undefined;
	const token = randomBytes(24).toString("hex");
	const fetchImpl = options?.fetchImpl ?? fetch;

	const server: Server = createServer((req, res) => {
		void handle(req, res).catch((error) => {
			options?.logger?.warn("provider gateway request failed", {
				message: error instanceof Error ? error.message : String(error),
			});
			json(res, 500, errorBody("Internal provider gateway error"));
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.url === "/health") {
			json(res, 200, { ok: true, service: "flintcode-provider-gateway" });
			return;
		}
		if (!authorized(req, token)) {
			json(res, 401, errorBody("Unauthorized: missing or invalid local gateway key"));
			return;
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			const registry = await loadProviderRegistry(paths);
			const models = gatewayModels(registry).map((entry) => ({
				id: entry.key,
				object: "model",
				owned_by: entry.provider.id,
			}));
			json(res, 200, { object: "list", data: models });
			return;
		}
		if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
			json(res, 404, errorBody("Only /v1/models and /v1/chat/completions are served"));
			return;
		}
		const raw = await readBody(req);
		let parsed: Record<string, unknown>;
		try {
			const value = JSON.parse(raw.toString("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			parsed = value as Record<string, unknown>;
		} catch {
			json(res, 400, errorBody("Request body must be a JSON object"));
			return;
		}
		const requested = typeof parsed.model === "string" ? parsed.model.trim() : "";
		if (!requested) {
			json(res, 400, errorBody("Request body must include a model"));
			return;
		}
		const registry = await loadProviderRegistry(paths);
		let resolved;
		try {
			resolved = resolveManagedModel(registry, requested);
		} catch (error) {
			json(res, 400, errorBody(error instanceof Error ? error.message : String(error)));
			return;
		}
		const { provider, model } = resolved;
		const auth = await loadProviderAuth(paths);
		let tokenForUpstream: string;
		try {
			tokenForUpstream =
				provider.kind === "nous"
					? (await ensureNousAccess(paths, provider)).accessToken
					: provider.auth.type === "none"
						? ""
						: resolveProviderApiKey(provider, auth);
		} catch (error) {
			json(res, 401, errorBody(error instanceof Error ? error.message : String(error)));
			return;
		}
		const upstreamBody = JSON.stringify({ ...parsed, model: model.upstreamId ?? model.id });
		const controller = new AbortController();
		abortOnClose(res, controller);
		let headers = forwardedRequestHeaders(req, provider, tokenForUpstream);
		let upstream: Response;
		try {
			upstream = await sendUpstream(provider, upstreamBody, headers, fetchImpl, controller);
		} catch (error) {
			json(res, 502, errorBody(`Provider ${provider.id} request failed: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		if (upstream.status === 401 && provider.kind === "nous") {
			await upstream.body?.cancel().catch(() => undefined);
			try {
				const renewed = await ensureNousAccess(paths, provider, { force: true, fetchImpl });
				tokenForUpstream = renewed.accessToken;
				headers = forwardedRequestHeaders(req, provider, tokenForUpstream);
				controller.abort();
				const retryController = new AbortController();
				abortOnClose(res, retryController);
				upstream = await sendUpstream(provider, upstreamBody, headers, fetchImpl, retryController);
			} catch (error) {
				json(res, 401, errorBody(`Provider ${provider.id} authentication failed: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
		}
		if (!upstream.ok) {
			const detail = (await upstream.text().catch(() => "")).trim().slice(0, 2_000);
			json(
				res,
				upstream.status,
				errorBody(`Provider ${provider.id} returned HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`),
			);
			return;
		}
		try {
			res.writeHead(upstream.status, responseHeaders(upstream, provider));
			if (upstream.body) {
				await pipeline(Readable.fromWeb(upstream.body as never), res);
			} else {
				res.end();
			}
		} catch (error) {
			if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Provider gateway did not bind a TCP port");
	}
	const port = address.port;
	return {
		url: `http://127.0.0.1:${port}`,
		token,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
