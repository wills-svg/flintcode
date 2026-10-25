import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HookRunner } from "../core/hooks.js";
import { truncateText } from "../util/format.js";

export function createHooksExtension(runner: HookRunner) {
	return (pi: ExtensionAPI): void => {
		pi.on("session_start", async (_event, ctx) => {
			await runner.run("SessionStart", {
				sessionId: ctx.sessionManager.getSessionId(),
				model: ctx.model?.id,
			});
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			await runner.run("SessionEnd", {
				sessionId: ctx.sessionManager.getSessionId(),
			});
		});

		pi.on("agent_settled", async (_event, ctx) => {
			await runner.run("Stop", {
				sessionId: ctx.sessionManager.getSessionId(),
				model: ctx.model?.id,
			});
		});

		pi.on("tool_call", async (event, ctx) => {
			const result = await runner.run("PreToolUse", {
				toolName: event.toolName,
				input: event.input,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (result.input) {
				Object.assign(event.input, result.input);
			}
			if (result.blocked) {
				return { block: true, reason: result.reason ?? "Blocked by a PreToolUse hook." };
			}
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const eventName = event.isError ? "PostToolUseFailure" : "PostToolUse";
			const result = await runner.run(eventName, {
				toolName: event.toolName,
				input: event.input,
				result: event.content,
				isError: event.isError,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			return undefined;
		});

		pi.on("input", async (event, ctx) => {
			const result = await runner.run("UserPromptSubmit", {
				text: event.text,
				source: event.source,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (result.blocked) {
				pi.sendMessage(
					{
						customType: "flintcode.hook",
						content: `Prompt blocked by hook: ${result.reason ?? "no reason"}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return { action: "handled" };
			}
			if (result.text !== undefined) {
				return { action: "transform", text: result.text };
			}
			return undefined;
		});

		pi.on("session_before_compact", async (_event, ctx) => {
			const result = await runner.run("PreCompact", {
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (result.blocked) return { cancel: true };
			return undefined;
		});
	};
}

export function formatHookResultForUi(output: string): string {
	return truncateText(output, 500);
}
