import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FlintcodeConfig } from "./types.js";
import { truncateText } from "../util/format.js";

const execFileAsync = promisify(execFile);

export interface SearchResult {
	title: string;
	url: string;
	description?: string;
	engines?: string[];
}

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	title?: string;
	text: string;
	links?: Array<{ text: string; url: string }>;
}

function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		mdash: "-",
		ndash: "-",
		hellip: "...",
	};
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
			const code = Number.parseInt(hex, 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : "";
		})
		.replace(/&#(\d+);/g, (_match, decimal: string) => {
			const code = Number(decimal);
			return Number.isFinite(code) ? String.fromCodePoint(code) : "";
		})
		.replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

export function htmlToText(html: string): { title?: string; text: string; links: Array<{ text: string; url: string }> } {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : undefined;
	const links: Array<{ text: string; url: string }> = [];
	for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const href = decodeEntities(match[1]).trim();
		const label = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
		if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
		links.push({ text: truncateText(label || href, 120), url: href });
		if (links.length >= 40) break;
	}
	let text = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
		.replace(/<(p|div|section|article|header|footer|main|aside|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, " ");
	text = decodeEntities(text)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text, links };
}

export class WebService {
	private readonly config: FlintcodeConfig["web"];

	constructor(config: FlintcodeConfig["web"]) {
		this.config = config;
	}

	private async fourgetPath(): Promise<string | undefined> {
		const candidates = [
			this.config.searchCommand,
			"/storage/emulated/0/Tools/fourget/fourget.py",
			path.join(process.env.HOME ?? "", "storage/shared/Tools/fourget/fourget.py"),
		].filter(Boolean) as string[];
		for (const candidate of candidates) {
			try {
				await fs.access(candidate, constants.R_OK);
				return candidate;
			} catch {
				// Try the next candidate.
			}
		}
		return undefined;
	}

	async search(query: string, limit = this.config.maxResults): Promise<SearchResult[]> {
		if (!this.config.enabled) throw new Error("Web tools are disabled in Flintcode config.");
		let ddgError: string | undefined;
		try {
			const results = await searchDuckDuckGo(query, limit);
			if (results.length > 0) return results;
		} catch (error) {
			ddgError = error instanceof Error ? error.message : String(error);
		}
		let fourgetError: string | undefined;
		try {
			const results = await this.searchFourget(query, limit);
			if (results.length > 0) return results;
		} catch (error) {
			fourgetError = error instanceof Error ? error.message : String(error);
		}
		throw new Error(
			`Web search failed. ${[ddgError, fourgetError].filter(Boolean).join(" ")}`.trim() ||
				"Web search returned no results.",
		);
	}

	private async searchFourget(query: string, limit: number): Promise<SearchResult[]> {
		const script = await this.fourgetPath();
		if (!script) throw new Error("No fourget fallback is configured.");
		const python = process.env.FLINTCODE_PYTHON ?? process.env.TAU_PYTHON ?? "python3";
		try {
			const { stdout } = await execFileAsync(
				python,
				[
					script,
					query,
					"--json",
					"--limit",
					String(Math.max(1, Math.min(limit, 20))),
					"--timeout",
					"35",
				],
				{
					cwd: path.dirname(script),
					timeout: 60_000,
					maxBuffer: 8 * 1024 * 1024,
					env: { ...process.env, PYTHONIOENCODING: "utf8" },
				},
			);
			const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
			if (!Array.isArray(parsed)) throw new Error("fourget returned an unexpected payload.");
			return parsed.slice(0, limit).map((entry) => ({
				title: String(entry.title ?? entry.url ?? "(untitled)"),
				url: String(entry.url ?? ""),
				description: entry.description ? String(entry.description) : undefined,
				engines: Array.isArray(entry.engines) ? entry.engines.map(String) : undefined,
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`fourget: ${truncateText(message, 300)}`);
		}
	}

	async fetchPage(url: string, maxChars = 20_000): Promise<FetchResult> {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			throw new Error(`Invalid URL: ${url}`);
		}
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			throw new Error("Only http and https URLs are supported.");
		}
		const response = await fetch(parsedUrl, {
			redirect: "follow",
			signal: AbortSignal.timeout(25_000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Flintcode/0.1",
				Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
			},
		});
		const contentType = response.headers.get("content-type") ?? "";
		const length = Number(response.headers.get("content-length") ?? 0);
		if (length > 4_000_000) throw new Error(`Response is too large (${length} bytes).`);
		const raw = await response.text();
		if (contentType.includes("application/json")) {
			return {
				url,
				finalUrl: response.url,
				status: response.status,
				contentType,
				text: truncateText(raw, maxChars),
			};
		}
		if (contentType.includes("html") || raw.trimStart().startsWith("<")) {
			const extracted = htmlToText(raw);
			const text = truncateText(extracted.text, maxChars);
			return {
				url,
				finalUrl: response.url,
				status: response.status,
				contentType,
				...(extracted.title ? { title: extracted.title } : {}),
				text,
				links: extracted.links.slice(0, 20),
			};
		}
		return {
			url,
			finalUrl: response.url,
			status: response.status,
			contentType,
			text: truncateText(raw, maxChars),
		};
	}
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
	const blocks = html.split(/<div class="result results_links/i).slice(1);
	const results: SearchResult[] = [];
	for (const block of blocks) {
		const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) continue;
		const snippet = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		const url = decodeDuckDuckGoUrl(decodeEntities(anchor[1]));
		const title = decodeEntities(anchor[2].replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim();
		if (!url || !title) continue;
		results.push({
			title,
			url,
			...(snippet
				? {
						description: decodeEntities(snippet[1].replace(/<[^>]+>/g, " "))
							.replace(/\s+/g, " ")
							.trim(),
					}
				: {}),
			engines: ["duckduckgo"],
		});
		if (results.length >= limit) break;
	}
	return results;
}

function decodeDuckDuckGoUrl(value: string): string {
	let decoded = value;
	if (decoded.startsWith("//")) decoded = `https:${decoded}`;
	try {
		const parsed = new URL(decoded);
		const target = parsed.searchParams.get("uddg");
		if (target) return decodeURIComponent(target);
		return parsed.toString();
	} catch {
		return decoded;
	}
}

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const response = await fetch(url, {
		signal: AbortSignal.timeout(20_000),
		headers: {
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
			Accept: "text/html",
		},
	});
	if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);
	const html = await response.text();
	if (/anomaly|captcha/i.test(html.slice(0, 5_000))) {
		throw new Error("DuckDuckGo returned an anti-bot page");
	}
	const results = parseDuckDuckGoResults(html, limit);
	if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results");
	return results;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No results for "${query}".`;
	return [
		`Search: ${query}`,
		`${results.length} result(s)`,
		"",
		...results.flatMap((result, index) => [
			`${index + 1}. ${result.title}`,
			`   ${result.url}`,
			...(result.description ? [`   ${truncateText(result.description.replace(/\s+/g, " "), 400)}`] : []),
			...(result.engines?.length ? [`   engines: ${result.engines.join(", ")}`] : []),
		]),
	].join("\n");
}

export function formatFetchResult(result: FetchResult): string {
	const header = [
		`URL: ${result.finalUrl}`,
		`Status: ${result.status}`,
		`Type: ${result.contentType || "unknown"}`,
		...(result.title ? [`Title: ${result.title}`] : []),
	].join("\n");
	const links = result.links?.length
		? `\n\nLinks:\n${result.links.slice(0, 12).map((link) => `- ${link.text}: ${link.url}`).join("\n")}`
		: "";
	return `${header}\n\n${result.text}${links}`;
}
