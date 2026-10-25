import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FlintcodeConfig } from "../core/types.js";
import {
	WebService,
	formatFetchResult,
	formatSearchResults,
} from "../core/web.js";

export function createWebExtension(config: FlintcodeConfig) {
	return (pi: ExtensionAPI): void => {
		const web = new WebService(config.web);

		const webSearch = defineTool({
			name: "WebSearch",
			label: "Web Search",
			description:
				"Search the web with DuckDuckGo, falling back to the local keyless fourget backend. Returns titles, URLs, snippets, and engine provenance. Use WebFetch to read a result.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_toolCallId, params) {
				const results = await web.search(params.query, params.maxResults ?? config.web.maxResults);
				return {
					content: [{ type: "text", text: formatSearchResults(params.query, results) }],
					details: { query: params.query, results },
				};
			},
		});

		const webFetch = defineTool({
			name: "WebFetch",
			label: "Web Fetch",
			description:
				"Fetch a URL and return readable text, title, status, and links. HTML is converted to text. Use this after WebSearch.",
			parameters: Type.Object({
				url: Type.String({ description: "http(s) URL" }),
				maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 60_000 })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_toolCallId, params) {
				const result = await web.fetchPage(params.url, params.maxChars ?? 20_000);
				return {
					content: [{ type: "text", text: formatFetchResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool(webSearch);
		pi.registerTool(webFetch);
	};
}
