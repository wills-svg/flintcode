import { type Component } from "@earendil-works/pi-tui";
import { FLINTCODE } from "./palette.js";

interface WelcomeOptions {
	version: string;
	model?: string;
	cwd?: string;
	resumed?: boolean;
	sessionName?: string;
	messageCount?: number;
}

const SPECTRUM = [
	"#F472B6",
	"#C084FC",
	"#A78BFA",
	"#8B5CF6",
	"#60A5FA",
	"#38BDF8",
	"#22D3EE",
	"#34D399",
	"#FBBF24",
	"#FB923C",
];

const WORDMARK = "FLINTCODE";
const SPARK = "✦";

function rgbOf(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	];
}

function mix(left: string, right: string, amount: number): string {
	const a = rgbOf(left);
	const b = rgbOf(right);
	const result = a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount));
	return `\x1b[38;2;${result[0]};${result[1]};${result[2]}m`;
}

function gradient(text: string): string {
	const characters = [...text];
	const visibleCount = characters.filter((character) => character !== " ").length;
	let visibleIndex = 0;
	return characters
		.map((character) => {
			if (character === " ") return character;
			const position = visibleCount <= 1 ? 0 : visibleIndex / (visibleCount - 1);
			const scaled = position * (SPECTRUM.length - 1);
			const index = Math.min(SPECTRUM.length - 2, Math.floor(scaled));
			const amount = scaled - index;
			visibleIndex += 1;
			return `\x1b[1m${mix(SPECTRUM[index], SPECTRUM[index + 1], amount)}${character}\x1b[0m`;
		})
		.join("");
}

function color(hex: string, text: string): string {
	const [r, g, b] = rgbOf(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function muted(text: string): string {
	return color(FLINTCODE.muted, text);
}

function dim(text: string): string {
	return color(FLINTCODE.dim, text);
}

function truncate(value: string, width: number): string {
	if (width <= 1) return "…";
	return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

export class FlintcodeWelcomeComponent implements Component {
	private readonly options: WelcomeOptions;

	constructor(options: WelcomeOptions) {
		this.options = options;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 34) {
			return [
				`${color(FLINTCODE.accentBright, SPARK)} ${color(FLINTCODE.text, "FC")} ${muted(this.options.version)}`,
			];
		}

		const icon = color(FLINTCODE.accentBright, SPARK);
		const logoWidth = 1 + 1 + WORDMARK.length;
		const availableAfterLogo = Math.max(0, width - logoWidth - 3);
		const versionLine =
			availableAfterLogo >= this.options.version.length
				? `  ${muted(this.options.version)}`
				: "";

		const metadata = [
			this.options.model,
			this.options.cwd,
		]
			.filter(Boolean)
			.join("  ·  ");
		const resumed = this.options.resumed
			? color(
					FLINTCODE.accentBright,
					`resumed ${this.options.sessionName ? `“${this.options.sessionName}” ` : ""}${this.options.messageCount ?? 0} messages`,
				)
			: undefined;

		return [
			`${icon} ${gradient(WORDMARK)}${versionLine}`,
			"",
			`${color(FLINTCODE.blue, "many providers")} ${dim("·")} ${color(FLINTCODE.green, "parallel agents")} ${dim("·")} ${color(FLINTCODE.accentBright, "plan mode")}`,
			metadata ? dim(truncate(metadata, width)) : undefined,
			resumed,
			dim("Enter send  ·  /help  ·  Ctrl+O tools  ·  Ctrl+T thinking  ·  Ctrl+C abort"),
		].filter((line): line is string => line !== undefined);
	}
}

export function renderFlintcodeStartLine(): string {
	return `${color("#C084FC", SPARK)} ${gradient(WORDMARK)} ${muted("loading")}`;
}
