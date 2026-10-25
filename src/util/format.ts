export function formatTokens(count: number | undefined): string {
	if (count === undefined || Number.isNaN(count)) return "0";
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

export function formatCost(cost: number | undefined): string {
	if (cost === undefined || Number.isNaN(cost)) return "$0.00";
	if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0s";
	if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
	const seconds = milliseconds / 1_000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m ${rest}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${value.slice(0, maxLength - 1)}…`;
}

export function shortPath(filePath: string, home = process.env.HOME): string {
	if (home && (filePath === home || filePath.startsWith(`${home}/`))) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
