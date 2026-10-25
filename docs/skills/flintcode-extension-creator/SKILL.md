---
name: flintcode-extension-creator
description: Add or change Flintcode tools, slash commands, CLI commands, permissions, services, hooks, providers or TUI dialogs. Use when asked to extend Flintcode itself, add a tool to the harness, or make Flintcode improve its own codebase.
---

# Flintcode extension creator

Use this skill when the task is to modify **Flintcode**, not the user's project.

## Read first

- `docs/ARCHITECTURE.md` for the runtime and module map.
- `docs/EXTENDING.md` for exact recipes and the tool contract.
- `AGENTS.md` for mandatory commands and constraints.

## Decide the mechanism

1. **Runtime tool (fastest):** write `~/.flintcode/extensions/<name>.ts`, then run
   `/reload` in Flintcode. Use for experiments and user-local tools.
2. **Compiled tool:** add `src/extensions/<name>.ts`, register it in
   `src/extensions/index.ts`, classify it, add tests and docs, rebuild, start a
   new Flintcode process. Use for shipped features.
3. **Skill only:** if no executable behavior is needed, add a `SKILL.md`.
4. **CLI / slash command:** add to `src/cli` / `FlintcodeTui.commandDefinitions`.
5. **Policy:** change `src/core/permissions.ts` and `src/core/plan.ts` only with
   tests and a clear safety rationale.

## Runtime tool template

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const tool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "What it does and when to use it.",
  parameters: Type.Object({ input: Type.String() }),
  annotations: { readOnlyHint: true },
  async execute(_toolCallId, params, signal) {
    if (signal?.aborted) throw new Error("aborted");
    return {
      content: [{ type: "text", text: `Hello ${params.input}` }],
      details: { input: params.input },
    };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(tool);
}
```

Then `/reload` and check `/tools`.

## Compiled feature checklist

- [ ] Service logic in `src/core/<feature>.ts` (no `pi-tui` imports).
- [ ] Extension factory in `src/extensions/<feature>.ts`.
- [ ] Factory added in `src/extensions/index.ts` (order matters for events).
- [ ] Tool name added to the right sets in `src/core/permissions.ts`.
- [ ] Plan-safe only if genuinely read-only/research-safe (`src/core/plan.ts`).
- [ ] TUI slash command + help if user-facing (`src/tui/app.ts`,
      `src/tui/transcript.ts`).
- [ ] CLI command if headless (`src/cli/args.ts`, `help.ts`, `main.ts`, module).
- [ ] Unit test for pure logic in `tests/unit/`.
- [ ] Docs/README updated for user-visible changes.
- [ ] `npm run build` and `npm run test:unit` pass.
- [ ] Fresh-process verification (CLI or isolated tmux TUI).

## Permissions

Read-only tools may join `READ_ONLY_TOOLS` and `PLAN_SAFE_TOOLS`. File edits,
shell, network mutation and agent orchestration are **not** read-only. Unknown
tools ask by default. Never weaken plan mode or approvals to make a test pass.

## Verification

```bash
npm run build
npm run test:unit
bash scripts/smoke-tui.sh
node bin/flintcode doctor
```

For live model checks use `/thinking low` and an isolated tmux session; send
text, wait ~1s, then Enter. Clean up temp `FLINTCODE_HOME` dirs, worktrees and tasks.
Report what actually ran and any remaining limitation.
