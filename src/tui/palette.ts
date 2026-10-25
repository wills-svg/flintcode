function rgb(hex: string): string {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `${r};${g};${b}`;
}

function fgHex(hex: string, text: string): string {
	return `\x1b[38;2;${rgb(hex)}m${text}\x1b[0m`;
}

function bgHex(hex: string, text: string): string {
	return `\x1b[48;2;${rgb(hex)}m${text}\x1b[0m`;
}

export const FLINTCODE = {
	bg: "#090A0B",
	panel: "#1A1B22",
	panelAlt: "#111217",
	text: "#E7E9EE",
	muted: "#9AA0AA",
	dim: "#6B7280",
	accent: "#8B5CF6",
	accentBright: "#A78BFA",
	blue: "#60A5FA",
	green: "#34D399",
	yellow: "#FBBF24",
	red: "#F87171",
	border: "#2A2C33",
	violetBg: "#241B36",
} as const;

export function ansiFg(hex: string): string {
	return `\x1b[38;2;${rgb(hex)}m`;
}

export function ansiBg(hex: string): string {
	return `\x1b[48;2;${rgb(hex)}m`;
}

export { fgHex, bgHex };

export const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: `\x1b[38;2;${rgb(FLINTCODE.dim)}m`,
	text: `\x1b[38;2;${rgb(FLINTCODE.text)}m`,
	muted: `\x1b[38;2;${rgb(FLINTCODE.muted)}m`,
	accent: `\x1b[38;2;${rgb(FLINTCODE.accent)}m`,
	accentBright: `\x1b[38;2;${rgb(FLINTCODE.accentBright)}m`,
	blue: `\x1b[38;2;${rgb(FLINTCODE.blue)}m`,
	green: `\x1b[38;2;${rgb(FLINTCODE.green)}m`,
	yellow: `\x1b[38;2;${rgb(FLINTCODE.yellow)}m`,
	red: `\x1b[38;2;${rgb(FLINTCODE.red)}m`,
	panelBg: `\x1b[48;2;${rgb(FLINTCODE.panel)}m`,
	bg: `\x1b[48;2;${rgb(FLINTCODE.bg)}m`,
} as const;
