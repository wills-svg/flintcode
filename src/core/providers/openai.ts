import type { ProviderConfig, ProviderModel } from "./types.js";

export type FetchLike = typeof fetch;

export interface DiscoveryResult {
	models: ProviderModel[];
	added: number;
	updated: number;
	removed: number;
}

function normalized(provider: ProviderConfig): string {
	return provider.baseUrl.replace(/\/+$/, "");
}

export function discoveryUrl(provider: ProviderConfig): string {
	const base = normalized(provider);
	const configured = provider.discovery?.path?.trim();
	if (configured) return `${base}${configured.startsWith("/") ? configured : `/${configured}`}`;
	if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, "/models");
	if (/\/models$/i.test(base)) return base;
	return `${base}/models`;
}

export function chatCompletionsUrl(provider: ProviderConfig): string {
	const base = normalized(provider);
	return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function safeMessage(text: string, secrets: string[] = []): string {
	let result = text.trim().replace(/\s+/g, " ").slice(0, 300);
	for (const secret of secrets) {
		if (secret) result = result.split(secret).join("[redacted]");
	}
	return result;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed = optionalNumber(value);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

function inputModalities(raw: Record<string, unknown>): string[] {
	const direct = raw.input_modalities;
	const architecture = raw.architecture;
	const nested =
		architecture && typeof architecture === "object" && !Array.isArray(architecture)
			? (architecture as Record<string, unknown>).input_modalities
			: undefined;
	const values = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [];
	return values.filter((entry): entry is string => typeof entry === "string");
}

function toProviderModel(raw: unknown): ProviderModel | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) return undefined;
	const nameValue =
		typeof record.name === "string"
			? record.name
			: typeof record.display_name === "string"
				? record.display_name
				: undefined;
	const topProvider =
		record.top_provider && typeof record.top_provider === "object" && !Array.isArray(record.top_provider)
			? (record.top_provider as Record<string, unknown>)
			: undefined;
	const contextWindow = firstNumber(
		record.context_window,
		record.context_length,
		record.contextWindow,
		record.max_context_length,
		record.max_input_tokens,
		topProvider?.context_length,
	);
	const maxOutputTokens = firstNumber(
		record.max_output_tokens,
		record.maxTokens,
		record.max_completion_tokens,
		topProvider?.max_completion_tokens,
	);
	const inputs = inputModalities(record);
	const vision =
		inputs.includes("image") ||
		optionalBoolean(record.supports_vision) === true ||
		(record.architecture as { modality?: string } | undefined)?.modality?.includes("image") === true;
	const supported = Array.isArray(record.supported_parameters)
		? record.supported_parameters.filter((entry): entry is string => typeof entry === "string")
		: [];
	const reasoning =
		optionalBoolean(record.reasoning) ?? (supported.includes("reasoning") || supported.includes("include_reasoning"));
	return {
		id,
		name: nameValue?.trim() || id,
		...(contextWindow ? { contextWindow } : {}),
		...(maxOutputTokens ? { maxOutputTokens } : {}),
		vision,
		reasoning,
	};
}

export function mergeDiscoveredModels(existing: ProviderModel[], discovered: ProviderModel[]): DiscoveryResult {
	const byId = new Map(existing.map((model) => [model.id, model]));
	let added = 0;
	let updated = 0;
	for (const model of discovered) {
		const previous = byId.get(model.id);
		if (!previous) {
			byId.set(model.id, model);
			added += 1;
			continue;
		}
		byId.set(model.id, {
			...model,
			name: previous.name && previous.name !== previous.id ? previous.name : model.name,
			...(previous.aliases?.length ? { aliases: previous.aliases } : {}),
			...(previous.free !== undefined ? { free: previous.free } : {}),
			...(previous.contextWindow !== undefined && model.contextWindow === undefined
				? { contextWindow: previous.contextWindow }
				: {}),
			...(previous.maxOutputTokens !== undefined && model.maxOutputTokens === undefined
				? { maxOutputTokens: previous.maxOutputTokens }
				: {}),
		});
		updated += 1;
	}
	return {
		models: [...byId.values()],
		added,
		updated,
		removed: Math.max(0, existing.length - discovered.filter((model) => existing.some((entry) => entry.id === model.id)).length),
	};
}

export async function discoverProviderModels(
	provider: ProviderConfig,
	token: string,
	headers: Record<string, string>,
	options?: { fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ProviderModel[]> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const response = await fetchImpl(discoveryUrl(provider), {
		method: "GET",
		headers: {
			...headers,
			accept: "application/json",
		},
		signal: options?.signal ?? AbortSignal.timeout(20_000),
		redirect: "error",
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Model discovery for ${provider.id} failed: HTTP ${response.status}${text ? ` — ${safeMessage(text, [token])}` : ""}`,
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`Model discovery for ${provider.id} returned non-JSON data`);
	}
	const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const items = Array.isArray(body) ? body : Array.isArray(record.data) ? record.data : undefined;
	if (!items) throw new Error(`Model discovery for ${provider.id} returned no model list`);
	const models: ProviderModel[] = [];
	const seen = new Set<string>();
	for (const item of items.slice(0, 500)) {
		const model = toProviderModel(item);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	if (!models.length) throw new Error(`Model discovery for ${provider.id} returned an empty model list`);
	return models;
}

export interface ChatTestResult {
	ok: boolean;
	status: number;
	model: string;
	detail: string;
}

export async function testChatCompletion(
	provider: ProviderConfig,
	modelId: string,
	token: string,
	headers: Record<string, string>,
	options?: { fetchImpl?: FetchLike; signal?: AbortSignal },
): Promise<ChatTestResult> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const model = provider.models.find((entry) => entry.id === modelId || entry.aliases?.includes(modelId));
	const upstreamId = model?.upstreamId ?? model?.id ?? modelId;
	const response = await fetchImpl(chatCompletionsUrl(provider), {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({
			model: upstreamId,
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
			max_tokens: 8,
			stream: false,
		}),
		signal: options?.signal ?? AbortSignal.timeout(45_000),
		redirect: "error",
	});
	const text = await response.text();
	return {
		ok: response.ok,
		status: response.status,
		model: upstreamId,
		detail: response.ok ? safeMessage(text) : safeMessage(text, [token]),
	};
}
