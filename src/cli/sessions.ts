import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { createFlintcodePaths, ensureFlintcodeLayout, resolveFlintcodeHome } from "../core/paths.js";
import { oneLine, shortPath, truncateText } from "../util/format.js";
import type { CliArgs } from "./args.js";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatDate(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 16);
}

function sessionTitle(info: { name?: string; firstMessage: string }): string {
	return info.name || oneLine(info.firstMessage) || "(empty session)";
}

async function selectSession(sessionsDir: string, query: string): Promise<SessionInfo[]> {
	const sessions = await SessionManager.listAll(sessionsDir);
	const exact = sessions.find((session) => session.id === query);
	if (exact) return [exact];
	const prefix = sessions.filter((session) => session.id.startsWith(query));
	if (prefix.length > 0) return prefix;
	const named = sessions.filter((session) =>
		(session.name ?? "").toLowerCase().includes(query.toLowerCase()),
	);
	return named;
}

export async function runSessionsCommand(args: CliArgs): Promise<number> {
	const home = resolveFlintcodeHome({ configDir: args.configDir });
	const paths = createFlintcodePaths(home, args.cwd);
	await ensureFlintcodeLayout(paths);
	const json = args.commandArgs.includes("--json");
	const all = args.commandArgs.includes("--all");
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const subcommand = positional[0] ?? "list";
	const query = positional[1];

	if (subcommand === "path") {
		console.log(paths.sessionsDir);
		return 0;
	}

	const sessions = (await SessionManager.listAll(paths.sessionsDir))
		.filter((session) => all || !session.cwd || path.resolve(session.cwd) === path.resolve(args.cwd))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	if (subcommand === "show") {
		if (!query) throw new Error("Usage: flintcode sessions show <id|name>");
		const matches = await selectSession(paths.sessionsDir, query);
		if (matches.length === 0) throw new Error(`No session matched "${query}".`);
		if (matches.length > 1) {
			throw new Error(
				`"${query}" matched ${matches.length} sessions: ${matches
					.slice(0, 5)
					.map((session) => `${session.id.slice(0, 8)} (${sessionTitle(session)})`)
					.join(", ")}`,
			);
		}
		const session = matches[0];
		if (json) {
			console.log(
				JSON.stringify(
					{
						id: session.id,
						name: session.name,
						path: session.path,
						cwd: session.cwd,
						created: session.created.toISOString(),
						modified: session.modified.toISOString(),
						messageCount: session.messageCount,
						firstMessage: session.firstMessage,
					},
					null,
					2,
				),
			);
			return 0;
		}
		console.log(`Session:  ${session.id}`);
		console.log(`Name:     ${session.name ?? "(unnamed)"}`);
		console.log(`File:     ${shortPath(session.path)}`);
		console.log(`Cwd:      ${shortPath(session.cwd || args.cwd)}`);
		console.log(`Created:  ${formatDate(session.created)}`);
		console.log(`Modified: ${formatDate(session.modified)}`);
		console.log(`Messages: ${session.messageCount}`);
		console.log(`First:    ${oneLine(session.firstMessage)}`);
		return 0;
	}

	if (subcommand === "delete") {
		if (!query) throw new Error("Usage: flintcode sessions delete <id|name> --yes");
		const confirmed = args.commandArgs.includes("--yes");
		const matches = await selectSession(paths.sessionsDir, query);
		if (matches.length !== 1) {
			throw new Error(matches.length === 0 ? `No session matched "${query}".` : `"${query}" is ambiguous.`);
		}
		if (!confirmed) {
			throw new Error(`Refusing to delete ${matches[0].path} without --yes.`);
		}
		await fs.unlink(matches[0].path);
		console.log(`Deleted ${shortPath(matches[0].path)}`);
		return 0;
	}

	if (subcommand !== "list" && subcommand !== "ls") {
		throw new Error(`Unknown sessions subcommand "${subcommand}". Use list, show, delete, or path.`);
	}

	if (json) {
		console.log(
			JSON.stringify(
				{
					sessionsDir: paths.sessionsDir,
					sessions: sessions.map((session) => ({
						id: session.id,
						name: session.name,
						path: session.path,
						cwd: session.cwd,
						created: session.created.toISOString(),
						modified: session.modified.toISOString(),
						messageCount: session.messageCount,
						firstMessage: session.firstMessage,
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}
	if (sessions.length === 0) {
		console.log(`No sessions in ${all ? shortPath(paths.sessionsDir) : shortPath(args.cwd)} yet.`);
		return 0;
	}
	const rows = sessions.map((session) => ({
		id: session.id.slice(0, 8),
		modified: formatDate(session.modified),
		messages: String(session.messageCount),
		title: truncateText(sessionTitle(session), 52),
		cwd: all ? truncateText(shortPath(session.cwd || "?"), 28) : "",
	}));
	const titleWidth = Math.max(...rows.map((row) => row.title.length), 5);
	console.log(
		`${pad("ID", 8)}  ${pad("MODIFIED", 16)}  ${pad("MSGS", 4)}  ${pad("TITLE", titleWidth)}  ${all ? "CWD" : ""}`,
	);
	for (const row of rows) {
		console.log(
			`${pad(row.id, 8)}  ${pad(row.modified, 16)}  ${pad(row.messages, 4)}  ${pad(row.title, titleWidth)}  ${row.cwd}`,
		);
	}
	console.log(`\n${sessions.length} session(s) in ${shortPath(paths.sessionsDir)}`);
	return 0;
}
