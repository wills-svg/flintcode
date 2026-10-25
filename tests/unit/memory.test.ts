import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Container, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import { initTheme, type AgentSession } from "@earendil-works/pi-coding-agent";
import { FlintcodeToolCard } from "../../src/tui/flintcode-components.js";
import { TranscriptView } from "../../src/tui/transcript.js";

initTheme("dark", false);

function fakeSession(overrides?: Partial<AgentSession>): AgentSession {
	return {
		sessionId: "session-memory",
		messages: [],
		model: undefined,
		...overrides,
	} as unknown as AgentSession;
}

const fakeTui = { requestRender: () => undefined } as unknown as TUI;
const fakeScroll = { scrollToEnd: () => undefined } as unknown as ScrollView;

test("tool cards cap stored output and show the cap note", () => {
	const card = new FlintcodeToolCard("read", "call-1", { path: "big.txt" }, 1_000);
	card.updateResult(
		{ content: [{ type: "text", text: "x".repeat(5_000) }], isError: false },
		false,
	);
	const rendered = card.render(120).join("\n");
	assert.match(rendered, /capped at 1,000 chars/);
});

test("transcript trims old blocks instead of growing without bound", () => {
	const container = new Container();
	const transcript = new TranscriptView({
		tui: fakeTui,
		container,
		scroll: fakeScroll,
		cwd: "/tmp",
		session: fakeSession(),
		hideThinking: true,
		limits: { blocks: 60, historyMessages: 400, toolOutputChars: 1_000 },
	});
	for (let index = 0; index < 500; index += 1) {
		transcript.addNotice(`notice ${index}`);
	}
	assert.ok(container.children.length <= 61, `children: ${container.children.length}`);
	const rendered = container.render(80).join("\n");
	assert.match(rendered, /notice 499/);
	assert.doesNotMatch(rendered, /notice 0\b/);
});

test("large tool output is offloaded to disk", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "flintcode-transcript-"));
	try {
		const container = new Container();
		const transcript = new TranscriptView({
			tui: fakeTui,
			container,
			scroll: fakeScroll,
			cwd: root,
			session: fakeSession(),
			hideThinking: true,
			limits: { blocks: 100, historyMessages: 100, toolOutputChars: 500 },
			stateDir: path.join(root, "state"),
		});
		transcript.toolStart("bash", "call-big", { command: "seq 1 10000" });
		transcript.toolEnd("call-big", { content: [{ type: "text", text: "y".repeat(20_000) }] }, false, 12);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const directory = path.join(root, "state", "tool-output", "session-memory");
		const files = await fs.readdir(directory);
		assert.deepEqual(files, ["call-big.txt"]);
		const stored = await fs.readFile(path.join(directory, "call-big.txt"), "utf8");
		assert.equal(stored.length, 20_000);
		const rendered = container.render(100).join("\n");
		assert.match(rendered, /capped at 500 chars/);
		assert.match(rendered, /full output:/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("history rendering is limited to the newest messages", () => {
	const container = new Container();
	const messages = Array.from({ length: 120 }, (_, index) => ({
		role: "user" as const,
		content: [{ type: "text" as const, text: `message ${index}` }],
		timestamp: Date.now(),
	}));
	const transcript = new TranscriptView({
		tui: fakeTui,
		container,
		scroll: fakeScroll,
		cwd: "/tmp",
		session: fakeSession(),
		hideThinking: true,
		limits: { blocks: 400, historyMessages: 20, toolOutputChars: 1_000 },
	});
	transcript.renderHistory(fakeSession({ messages: messages as never }), "/tmp");
	const rendered = container.render(100).join("\n");
	assert.match(rendered, /100 earlier messages not rendered/);
	assert.match(rendered, /message 119/);
	assert.doesNotMatch(rendered, /message 0\b/);
});
