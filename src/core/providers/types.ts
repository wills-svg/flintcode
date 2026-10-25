export const NOUS_PORTAL = "https://portal.nousresearch.com";
export const NOUS_INFERENCE = "https://inference-api.nousresearch.com/v1";
export const NOUS_WELCOME = "https://welcome-api.nousresearch.com/v1";
export const NOUS_CLIENT_ID = "hermes-cli";
export const NOUS_SCOPE = "inference:mint_agent_key";
export const NOUS_AGENT_KEY_MIN_TTL_SECONDS = 1800;

export type ProviderKind = "openai-compatible" | "nous";
export type AuthScheme = "bearer" | "api-key";

export type ProviderAuth =
	| {
			type: "api-key";
			envVar?: string;
			header?: string;
			scheme?: AuthScheme;
	  }
	| { type: "none" }
	| { type: "nous-oauth" };

export interface ProviderModel {
	id: string;
	name?: string;
	upstreamId?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
	aliases?: string[];
	free?: boolean;
}

export interface ProviderConfig {
	id: string;
	name: string;
	kind: ProviderKind;
	enabled: boolean;
	baseUrl: string;
	auth: ProviderAuth;
	headers?: Record<string, string>;
	models: ProviderModel[];
	defaultModel?: string;
	discovery?: {
		enabled: boolean;
		path?: string;
	};
	createdAt: string;
	updatedAt: string;
}
export interface ProviderRegistry {
	version: 1;
	providers: ProviderConfig[];
}

export interface NousAuthEntry {
	type: "nous-oauth";
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	tokenType: string;
	scope: string;
	baseUrl: string;
	oauthAccessToken?: string;
	oauthExpiresAt?: number;
	agentKeyExpiresAt?: number;
	keyId?: string;
	accountId?: string;
	updatedAt: string;
}

export interface ApiKeyAuthEntry {
	type: "api-key";
	apiKey: string;
	updatedAt: string;
}

export type ProviderAuthEntry = NousAuthEntry | ApiKeyAuthEntry;

export interface ProviderAuthFile {
	version: 1;
	providers: Record<string, ProviderAuthEntry>;
}

export interface ResolvedManagedModel {
	provider: ProviderConfig;
	model: ProviderModel;
}

export interface GatewayModelEntry extends ResolvedManagedModel {
	key: string;
}

export const DEFAULT_NOUS_MODEL: ProviderModel = {
	id: "Hermes-4-70B",
	name: "Hermes 4 70B",
	contextWindow: 131072,
	maxOutputTokens: 32768,
	reasoning: true,
	vision: false,
};

export const RESERVED_PROVIDER_IDS = new Set(["flintcode"]);
