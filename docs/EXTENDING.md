# Extending Flintcode

This is the practical guide for adding tools, services, commands, permissions,
UI, providers and tests. Read `ARCHITECTURE.md` first for the runtime flow.

There are two ways to add a tool:

| Way | Best for | Load path |
|---|---|---|
| **Runtime extension** | experiments and user-local tools | write `~/.flintcode/extensions/<name>.ts`, run `/reload` |
| **Compiled extension** | shipped features, tests, permissions, documentation | add `src/extensions/<name>.ts`, wire in `src/extensions/index.ts`, rebuild |

## 1. Runtime tool in five minutes

Create `~/.flintcode/extensions/word-count.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const wordCount = defineTool({
  name: "word_count",
  label: "Word Count",
  description: "Count words and lines in a text file inside the workspace.",
  parameters: Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
  }),
  annotations: { readOnlyHint: true },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (signal?.aborted) throw new Error("aborted");
    const filePath = path.resolve(ctx.cwd, params.path);
    const text = await fs.readFile(filePath, "utf8");
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    return {
      content: [
        { type: "text", text: `${words} words, ${text.split("\n").length} lines` },
      ],
      details: { path: filePath, words },
    };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(wordCount);
}
```

In an interactive Flintcode session run `/reload`. `/tools` should now include
`word_count`. Runtime extensions are loaded by pi's jiti loader, so TypeScript
and imports from `@earendil-works/*` work without a Flintcode build.

Limits of runtime tools:

- They are `unknown` to Flintcode's permission classifier, so approval modes ask by
  default. Tick `readOnlyHint` but do not expect plan mode to allow them.
- They cannot change `PermissionEngine`/`PlanController` sets, the TUI, or the
  CLI. To make a tool plan-safe or add UI/commands, make it a compiled feature.
- They still execute with the user's OS permissions. Never treat the UI as a
  sandbox.

## 2. Compiled tool

### 2.1 Create the factory

Add `src/extensions/word-count.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function createWordCountExtension(cwd: string) {
  return (pi: ExtensionAPI): void => {
    const tool = defineTool({
      name: "word_count",
      label: "Word Count",
      description: "Count words in a workspace file.",
      parameters: Type.Object({
        path: Type.String(),
      }),
      annotations: { readOnlyHint: true },
      async execute(_id, params) {
        const absolute = new URL(params.path, `file://${cwd}/`).pathname;
        const text = await import("node:fs/promises").then((fs) =>
          fs.readFile(absolute, "utf8"),
        );
        return {
          content: [{ type: "text", text: `${text.split(/\s+/u).length} words` }],
          details: { path: absolute },
        };
      },
    });
    pi.registerTool(tool);
  };
}
```

Prefer putting real filesystem or storage logic in `src/core/<feature>.ts` and
keeping the extension a thin adapter. That makes it unit-testable.

### 2.2 Register it

In `src/extensions/index.ts`:

```ts
import { createWordCountExtension } from "./word-count.js";

// inside createFlintcodeExtensions, after the permission/plan entries:
extensions.push(createWordCountExtension(options.cwd));
```

Order matters for `tool_call` handlers, not for most tool registration. Keep
policy hooks early.

### 2.3 Classify it

In `src/core/permissions.ts`:

- read-only: add to `READ_ONLY_TOOLS`
- file mutation: add to `EDIT_TOOLS` (or let it ask)
- shell: add to `SHELL_TOOLS`
- safe in plan mode: add to `PLAN_SAFE_TOOLS`

In `src/core/plan.ts`, add to `PLAN_SAFE_TOOL_NAMES` only if the tool is truly
read-only/research/notification safe.

In `src/core/agent-runner.ts` or agent definitions, consider whether subagents
may use it. Agent tasks run in isolated worker processes and receive an explicit
tool allowlist; they never get the Agent tool. Every worker tool call is relayed
to the parent `PermissionEngine`, so new tools must be classified there rather
than relying on an in-process child extension.

### 2.4 Test and verify

Add a unit test for the service. A TUI run is not a unit test.

```bash
npm run build
npm run test:unit
node bin/flintcode            # fresh process; /tools should list word_count
```

## 3. Tool contract reference

`defineTool` from `@earendil-works/pi-coding-agent` accepts:

| Field | Notes |
|---|---|
| `name` | exact, case-sensitive; permission sets use this name |
| `label` | short UI title |
| `description` | model-facing; explain when to use it |
| `parameters` | Typebox schema; use `Type.Object`, `Type.Optional` |
| `annotations` | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| `executionMode` | `"parallel"` or `"sequential"` when order/concurrency matters |
| `expose`/`namespace` | for deferred/tool-search/MCP-style tools; not needed for normal tools |
| `async execute(id, params, signal, onUpdate, ctx)` | returns `AgentToolResult` |

Result:

```ts
return {
  content: [{ type: "text", text: "visible to the model" }],
  details: { structured: "for UI/logs" },  // keep JSON-serializable
  usage: undefined,                         // include child-model usage if any
  isError: false,                           // report failure without throwing
};
```

- Throw for fatal errors; return `isError: true` for expected tool failures.
- Use `onUpdate({content, details})` for streaming progress.
- Respect `signal`; abort child work and model calls.
- Long output should be truncated and written to a file/log. Flintcode's transcript
  caps each card at `ui.toolOutputChars` and offloads larger final results under
  `state/tool-output/<session>/<toolCallId>.txt`; tools should still avoid
  returning multi-megabyte strings to the model.
- Tool results can include image content blocks, but this device does not
  render terminal images.
- If `details` shapes vary across return branches, TypeScript may infer a
  narrow type from the first return. Either keep a consistent details shape or
  annotate/cast explicitly.

### Existing tool catalog

| Tool | Class | Plan-safe |
|---|---|---|
| `read`, `grep`, `find`, `ls` | read-only | yes |
| `bash`, `bash_background`, `bash_kill` | shell | no |
| `edit`, `write` | edit | no |
| `WebSearch`, `WebFetch` | read-only/open-world | yes |
| `ask_user` | read-only/session UI | yes |
| `TodoWrite`, `todo_read` | read-only/session state | yes |
| `memory_search`, `memory_list` | read-only | yes |
| `memory_save`, `memory_delete` | state mutation | no |
| `goal_get` | read-only | yes |
| `goal_update` | state mutation | no |
| `bash_output`, `task_list` | read-only | yes |
| `agent_output` | read-only | yes |
| `ScheduleWakeup` | session control | no |
| `EnterPlanMode`, `ExitPlanMode` | session control | yes |
| `Agent` | can call write/shell via children | no |
| MCP `mcp__server__tool` | unknown → ask | no |

`Agent` asks by default; in plan mode it is removed from active tools.

## 4. Slash commands (TUI)

Host-side commands live in `FlintcodeTui.commandDefinitions` in `src/tui/app.ts`:

```ts
{
  name: "words",
  description: "Count words in a file",
  argumentHint: "<path>",
  handler: async (argument) => {
    if (!argument) throw new Error("Usage: /words <path>");
    const text = await fs.readFile(path.resolve(this.host.runtime.cwd, argument), "utf8");
    this.transcript.addMarkdown(`${text.split(/\s+/u).length} words`);
  },
}
```

Autocomplete is built from these definitions. To add argument completions,
attach `getArgumentCompletions` in `setupAutocomplete`. Add the command to
`TranscriptView.showHelp`. Commands that need user input can use
`showChoiceDialog`, `showInputDialogAsync`, or `askUser`; store the handle in
`this.pendingChoice` so Ctrl+C can dismiss it.

If a command should also work headless, add a CLI command (below). Unknown
slash input is forwarded to `session.prompt`, which handles skills, extension
commands and prompt templates.

`/reload` calls `session.reload()` and rebinds the runtime; use it after adding
a runtime extension, skill or prompt template.

## 5. CLI command

1. Add the name to `KNOWN_COMMANDS` in `src/cli/args.ts`.
2. Add help text in `src/cli/help.ts` and the command list.
3. Add a case in `runCommand` in `src/cli/main.ts`.
4. Implement a `runXCommand(args: CliArgs): Promise<number>` in `src/cli/`.
5. Use `resourceContext` from `resources.ts` when you need paths/config/trust,
   or `bootstrap` when you need models. Avoid bootstrapping models for commands
   that do not need them.
6. Print machine-readable JSON with `--json` where practical.
7. Test in a temporary `FLINTCODE_HOME`.

CLI commands run outside a session. They must not assume extension state, a
bound TUI or an active model.

## 6. Config fields

To add a config option:

1. Extend the interface in `src/core/types.ts`.
2. Add a default in `defaultConfig` and normalization/validation in
   `normalizeConfig` (`src/core/config.ts`).
3. Use it in the relevant service.
4. Document it in `README.md` and `docs/`.
5. Add a config unit test.

Config is merged user → project (trusted only) for loading. Runtime code should
call `patchFlintcodeConfig`, which takes a cross-process lock, rereads the user file,
normalizes it, applies the mutation and writes atomically. Do not load the
merged effective config and save it back to `flintcode.json`; that would persist
project overrides into user settings. Arrays replace, objects merge. `~` is
expanded for directory paths.

## 7. Hooks

Hooks are shell commands in `~/.flintcode/hooks.json`:

```json
{
  "hooks": [
    {
      "id": "lint-on-write",
      "event": "PostToolUse",
      "matcher": { "tool": "write" },
      "type": "command",
      "command": "npm run lint --silent",
      "timeoutMs": 15000,
      "onError": "allow"
    }
  ]
}
```

Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`,
`SessionStart`, `SessionEnd`, `Stop`, `PreCompact`, `PermissionRequest`,
`SubagentStart`, `SubagentStop` (the runner currently wires the first group;
subagent hooks are roadmap).

Input: JSON on stdin with `event`, `cwd`, `timestamp`, `toolName`, `input`,
`sessionId`, plus any extra payload fields. Env contains `FLINTCODE_HOOK_*`.

Output: a single JSON object (last line is also considered):

```json
{ "decision": "deny", "reason": "blocked" }
{ "decision": "allow" }
{ "text": "rewritten prompt" }
{ "input": { "command": "patched" } }
```

`PreToolUse` can deny or patch input. `UserPromptSubmit` can rewrite or block.
`PermissionRequest` can allow/deny an ask without showing the dialog. Hooks run
sequentially; timeouts kill the process group. `PermissionRequest` hook
failures fail closed.

Add hooks in code only if the event is new; normal user hooks do not require a
build.

## 8. MCP servers

```bash
flintcode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
flintcode mcp add docs --url https://example.com/mcp
flintcode mcp list
```

User config is `~/.flintcode/mcp.json`; pi's MCP extension reads it and, for trusted
projects, `.pi/mcp.json`. Tools appear as `mcp__<server>__<tool>` and go through
Flintcode's permission engine as unknown tools (ask by default). Use `/mcp` or
`flintcode mcp list` to inspect. Adding an MCP server does not require a rebuild; use
`/reload` or restart.

## 8b. Agent definitions and per-task overrides

Markdown agents accept:

```yaml
---
name: deepseek-reviewer
description: Deep code review on Logfare DeepSeek
tools: read, grep, find, ls
model: logfare/deepseek-v4.1-flash-1017
thinking: low        # or reasoning: low; must be supported by the model
---
Your system prompt...
```

`Agent` calls and each `tasks[]` entry accept the same `model` and `thinking`
(alias `reasoning`) overrides. Flintcode resolves the model through the loaded
catalog and validates the level with
`supportedThinkingLevels()`/pi's session capabilities. Non-reasoning models
support only `off`; `xhigh`/`max` exist only when the model maps them. Invalid
levels are rejected with the actual supported list — never silently invented.

The main session behaves the same way: the picker uses
`session.getAvailableThinkingLevels()`, explicit `--thinking` is validated
against the selected model, and the configured default is only applied to new
sessions (clamped with a log entry if the model cannot honor it).

Each Agent task runs in a worker process capped by
`agents.workerHeapMb`, started within `agents.workerStartupSeconds`, limited
to `agents.maxDurationSeconds`, and stopped after `agents.maxToolCalls` completed
tool calls. Worker tool output is capped at `agents.maxToolOutputChars`, and
runner activity is intentionally bounded.
Changing these defaults does not alter model capability validation.

## 9. Model providers

There are two ways to add a provider:

1. **Managed provider** (recommended for any OpenAI-compatible endpoint).
   Use the CLI; no core changes are needed:

   ```bash
   flintcode providers add my-provider --base-url https://api.example/v1 \
     --api-key-env MY_PROVIDER_KEY
   flintcode providers test my-provider --chat
   flintcode use my-provider/<model>
   ```

   Registry, credentials, discovery, gateway routing and the generated pi
   catalog live in `src/core/providers/`. Do not add provider-specific branches
   to the session or TUI. See [PROVIDERS.md](PROVIDERS.md).

2. **pi provider extension** (native protocols, OAuth providers with custom
   APIs, or providers that need custom streaming). The installed Kilo provider
   is loaded as an explicit path in config:

```json
"compat": {
  "piExtensions": ["/data/.../kilo-pi-provider/src/index.ts"]
}
```

For a new provider:

1. Install it as a pi package or keep a local extension path.
2. Add its path to `compat.piExtensions`.
3. Provide credentials via env or pi's `auth.json`; do not hardcode secrets.
4. `flintcode models` and `flintcode doctor` use `createFlintcodeInspectionServices` to load
   provider extensions without creating a session.
5. `resolveFlintcodeModel` will see registered models. The configured default wins;
   otherwise free models are preferred.
6. If the provider registers asynchronously, add a post-bind retry similar to
   `FlintcodeTui.doBind` or ensure it registers during loader reload.

Do not modify `node_modules` or copy pi's provider internals unless there is no
public API. Provider extensions are third-party code with full process access.
Managed providers must remain in the OpenAI-compatible gateway; do not bypass
the provider registry or write provider secrets into tracks/config/session files.

## 10. UI components and dialogs

Flintcode uses pi-tui's `TuiAltScreen`, `VStack`, `ScrollView`, `Editor`,
`SelectList`, `Input`, `Text`, `Spacer`, markdown and message/tool components.
Overlays need a solid background on this terminal; use the `SolidPanel` in
`src/tui/dialogs.ts` or wrap your component with it.

Pattern for an async dialog:

```ts
const deadlineAt = Date.now() + this.modalDeadlineMs();
const generation = this.modalGeneration;
return this.enqueueModal(async () => {
  if (this.modalGeneration !== generation) return defaultValue;
  const handle = showChoiceDialog({
    tui: this.screen,
    title: "Pick one",
    items: [
      { value: "a", label: "Option A" },
      { value: "b", label: "Option B" },
    ],
    restoreFocus: () => this.screen.setFocus(this.editor),
  });
  this.pendingChoice = handle;
  const outcome = await this.awaitModal(handle, deadlineAt, generation);
  if (outcome.stale || outcome.expired) return defaultValue;
  return outcome.value ?? defaultValue;
}, defaultValue);
```

Never await `handle.promise` directly from host policy code. The shared queue,
generation counter and deadline ensure multiple requests do not overlap, a
session switch/reload/abort/quit cancels pending dialogs, and an unattended
approval eventually resolves instead of wedging the tool pipeline.

The base conversation is intentionally stable. Prefer adding new HUD segments
or transcript notices over rewriting the layout. Always test at 110x34 and a
narrow width.

## 11. Tests

Unit tests are under `tests/unit/*.test.ts` and use `node:test`. Create a
temporary workspace with `fs.mkdtemp(os.tmpdir())`, build `FlintcodePaths` with
`createFlintcodePaths`, and clean up in `finally`. Test services and pure policy
functions; do not require the network or a model. Current coverage includes
concurrent config/state locking, session leases, permission protections,
worker protocol types, transcript trimming and output offloading.

Example:

```ts
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flintcode-test-"));
const paths = createFlintcodePaths(path.join(root, "home"), path.join(root, "work"));
await ensureFlintcodeLayout(paths);
// ... call service ...
await fs.rm(root, { recursive: true, force: true });
```

For the TUI, use `bash scripts/smoke-tui.sh` (isolated tmux session). When
driving tmux manually, send text, wait, then send Enter; do not batch key
events.

Run:

```bash
npm run typecheck
npm run test
bash scripts/smoke-tui.sh
```

## 12. Common pitfalls

- **Stale TUI:** the running process has loaded `dist`/extensions. Rebuild and
  start a fresh TUI, or use `/reload` for `~/.flintcode/extensions`.
- **Permission classification is name-based.** Renaming a tool without updating
  the sets silently changes policy.
- **Plan mode is a second guard.** A tool missing from the plan-safe list cannot
  run even if a rule allows it.
- **Details types:** heterogeneous `details` objects break inference; use a
  consistent shape or explicit type/cast.
- **No `.bin` on this filesystem.** Use the npm scripts or
  `node node_modules/typescript/bin/tsc`.
- **No symlinks on `/storage`.** npm installs use `bin-links=false`.
- **Kilo catalog latency:** provider models may appear after session services
  load; use the inspection helper or the post-bind retry.
- **Don't copy credentials** into config, docs, hook logs or session entries.
- **State updates need locks.** Read-modify-write code must use
  `withFileLock`/the service's transaction helper, not only `writeJsonAtomic`,
  or another Flintcode process can lose its update.
- **Never save effective project config into user config.** Use
  `patchFlintcodeConfig` so only user settings are rewritten.
- **One session writer.** Bound sessions hold a lease; do not weaken it or edit
  the same JSONL from another Flintcode process.
- **Agents are out of process.** Worker code must not depend on the parent TUI
  objects; communicate through `src/agent-worker/protocol.ts` messages and the
  permission bridge.
- **Never trust `done` alone as evidence of a report.** The Agent tool must
  extract a final assistant report and fail closed when none can be recovered.
- **Sessions are user data.** Deleting a session requires `--yes`; do not delete
  state you did not create without asking.
