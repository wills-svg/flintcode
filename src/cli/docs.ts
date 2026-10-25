import { listDocs, readDoc } from "../core/docs.js";
import { shortPath } from "../util/format.js";
import type { CliArgs } from "./args.js";

export async function runDocsCommand(args: CliArgs): Promise<number> {
	const json = args.commandArgs.includes("--json");
	const positional = args.commandArgs.filter((entry) => !entry.startsWith("-"));
	const topic = positional[0];
	if (!topic) {
		const docs = listDocs();
		if (json) {
			console.log(JSON.stringify({ docs }, null, 2));
			return 0;
		}
		console.log("Flintcode documentation\n");
		for (const doc of docs) {
			console.log(`${doc.key.padEnd(14)} ${doc.title}`);
			console.log(`${"".padEnd(14)} ${doc.description}`);
			console.log(`${"".padEnd(14)} ${shortPath(doc.path)}\n`);
		}
		console.log("Print one with: flintcode docs <topic>");
		return 0;
	}
	const { info, content } = await readDoc(topic);
	if (json) {
		console.log(JSON.stringify({ key: info.key, title: info.title, path: info.path, content }, null, 2));
		return 0;
	}
	console.log(content);
	return 0;
}
