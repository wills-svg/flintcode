# Flintcode architecture

Flintcode is a new terminal harness built on the MIT-licensed pi packages. It does not
fork the pi CLI or shell out to it. It composes pi's agent, session, model and
TUI primitives and adds Flintcode's own configuration, extension pack, governance,
agent runtime, commands, persistence and UI.

Key library packages (pinned 1.3.0):

- `@earendil-works/pi-coding-agent` — sessions, runtime, tools, resources,
  extensions, UI components, model runtime.
- `@earendil-works/pi-agent-core` — agent loop and message/usage types.
- `@earendil-works/pi-ai` — model/provider abstraction, Typebox schemas.
- `@earendil-works/pi-tui` — terminal rendering, editor, layout, overlays.
- `@earendil-works/pi-mcp` — MCP client used by pi's MCP extension.

## Design principles

1. **Headless core.** Files in `src/core/` must not import `pi-tui` or own
   terminal state. They are testable with `node:test`.
2. **Extensions are the integration boundary.** Model-callable tools and pi
   lifecycle hooks are registered by `src/extensions/*.ts` factories. The
   canonical order is in `src/extensions/index.ts`.
3. **Policy is separate from execution.** `PermissionEngine` decides; tool
   execute functions perform. Plan mode is a second guard on top of policy.
4. **Sessions are pi sessions.** JSONL under `~/.flintcode/sessions` remains
   pi-compatible. Flintcode stores auxiliary state outside session context.
5. **Own config, imported resources.** Flintcode writes only `~/.flintcode`; pi models,
   credentials, skills, agents, prompts and instructions are read in place.
6. **Android-first operational rules.** All state is on ext4 under `~/.flintcode`;
   source is on FUSE `/storage`, which is `noexec` and rejects symlinks.

## Boot and runtime flow

The interactive path (`src/tui/app.ts`, `runTui`) and non-interactive path
(`src/cli/main.ts`, `runNonInteractive`) share the same composition:

1. **CLI parse** (`src/cli/args.ts`). Produces cwd, mode, model/thinking,
   permission overrides, tool allow/deny lists, session selection, worktree and
   trust flags.
2. **`prepareWorktree`** (main only) optionally creates a git worktree and
   replaces `cwd` before any config/trust/session work.
3. **`bootstrap`** (`src/cli/bootstrap.ts`):
   - resolve `FLINTCODE_HOME` / `--config-dir` / `~/.flintcode`
   - create the state directory layout
   - resolve project trust *before* loading project config/resources
   - load and normalize `flintcode.json` (`src/core/config.ts`)
   - prepare the provider runtime: load `providers.json`/`providers-auth.json`,
     start the loopback provider gateway when managed models exist, write the
     generated `models.json`, set `FLINTCODE_GATEWAY_KEY`
   - create `ModelRuntime` with pi `auth.json` and the generated model catalog
   - create the Flintcode logger
4. **Build services**:
   - `PermissionEngine` with mode/rules/approval handler
   - `PlanController`
   - `MemoryService`, `GoalService`, optional `HookRunner`
   - the inline extension list from `createFlintcodeExtensions`
5. **`createFlintcodeSessionHost`** (`src/core/session-host.ts`):
   - select the `SessionManager` (new/continue/resume/fork/in-memory)
   - `createAgentSessionRuntime` with a factory that recreates cwd-bound
     services on `/new`, resume, fork and switches
   - the factory creates `SettingsManager`, `DefaultResourceLoader`
     (skills/prompts/themes/context/extension paths), then
     `createAgentSessionFromServices`
   - model resolution happens *after* services load, so provider extensions
     such as Kilo can register their models first
   - resumed sessions restore their saved model unless `--model` is explicit
6. **TUI**:
   - initialize theme and components
   - `TuiAltScreen` + `ScrollView` + `Editor` + custom `Statusline`
   - `session.bindExtensions({mode:"tui", ...})`
   - `session.subscribe` drives transcript, tool cards, footer and HUD
   - slash commands are host-side; unknown commands (skills, pi prompt
     templates, extension commands) are forwarded through `session.prompt`
7. **Non-interactive**:
   - `runPrintMode` (text/JSONL) or `runRpcMode` owns binding and disposal
   - permission asks are denials unless a rule/mode allows them
   - the permission and plan extensions are still active

## Module map

| Path | Responsibility |
|---|---|
| `src/cli/main.ts` | entrypoint, command dispatch, print/RPC, worktree prep |
| `src/cli/args.ts` | argument model/parser (known commands are passed through) |
| `src/cli/bootstrap.ts` | path/trust/config/model-logger bootstrap |
| `src/cli/doctor.ts` | diagnostics, provider loading, redacted model/auth report |
| `src/cli/models.ts` | model listing with provider extensions loaded |
| `src/cli/providers.ts` | provider/auth/login/use commands and managed model commands |
| `src/cli/plugins.ts` | pi extension plugins and plugin packs |
| `src/core/providers/store.ts` | provider registry, validation, credential store, model resolution |
| `src/core/providers/openai.ts` | OpenAI-compatible discovery and connection tests |
| `src/core/providers/nous.ts` | Nous Portal device flow, agent-key mint, refresh, pi/tau credential import |
| `src/core/providers/gateway.ts` | loopback OpenAI-compatible gateway |
| `src/core/providers/runtime.ts` | gateway startup and generated pi model catalog |
| `src/cli/sessions.ts` | list/show/delete sessions |
| `src/cli/trust-cmd.ts` | trust store CLI |
| `src/cli/resources.ts` | skills/agents/hooks/mcp/worktree/cron/config commands |
| `src/cli/search.ts` | direct web search/fetch commands |
| `src/cli/init.ts` | state layout/config initialization |
| `src/core/paths.ts` | `FlintcodePaths`, expansion, required directories |
| `src/core/config.ts` | defaults, deep merge, normalized config, locked patches, hooks file |
| `src/core/trust.ts` | Flintcode trust store + pi trust fallback + prompt |
| `src/core/models.ts` | runtime creation, model lookup/free detection/selection |
| `src/core/session-host.ts` | runtime composition, resume model restore, inspection services |
| `src/core/session-lock.ts` | heartbeat lease that prevents concurrent session writers |
| `src/core/permissions.ts` | modes, rules, approvals, secret/workspace protection, PermissionRequest hook |
| `src/core/plan.ts` | plan state, tool snapshot/restore, plan approval |
| `src/core/agent-runner.ts` | built-in/custom agents, worker supervision, parallel/background |
| `src/agent-worker/worker.ts` | isolated subagent process, IPC progress and approval relay |
| `src/core/hooks.ts` | shell hook execution, matching, JSON decisions |
| `src/core/tasks.ts` | detached background shell tasks/logs |
| `src/core/todos.ts` | per-session todo store |
| `src/core/memory.ts` | durable memory JSONL + relevance |
| `src/core/goals.ts` | durable workspace goals |
| `src/core/loops.ts` | recurring/one-shot in-session prompts |
| `src/core/web.ts` | DDG HTML search, fourget fallback, readable fetch |
| `src/core/worktrees.ts` | git worktree list/create/remove |
| `src/core/output-styles.ts` | prompt-preset definitions |
| `src/core/plans.ts` | saved plan files |
| `src/core/ui-bridge.ts` | host callbacks for ask_user/ScheduleWakeup |
| `src/extensions/index.ts` | canonical extension order |
| `src/extensions/*.ts` | tool/event factories |
| `src/tui/app.ts` | interactive controller, commands, dialogs, HUD wiring |
| `src/tui/transcript.ts` | message/tool cards, custom notices, history |
| `src/tui/footer.ts` | statusline segments, spinner, git/task/todo counters |
| `src/tui/dialogs.ts` | solid overlays, select/input/approval panels |
| `src/util/*` | atomic JSON, ids, formatting, logging |

## Extension order

`createFlintcodeExtensions` loads in this order. Order matters for event handlers and
system-prompt composition:

1. **hooks** — PreToolUse runs before Flintcode's permission policy.
2. **output-style** — appends style instructions.
3. **context** — appends relevant memory and active goals.
4. **permission** — blocks/permits through `tool_call`.
5. **plan** — plan tools and plan system-prompt instructions.
6. **ask_user / ScheduleWakeup** — host UI callbacks.
7. **todos, memory tools, goals** — state tools.
8. **web** — `WebSearch`, `WebFetch`.
9. **background bash** — detached tasks.
10. **subagents** — Agent/agent_output; async factory discovers agents first.
11. **MCP** — pi MCP extension reads `mcp.json` and connects on session start.

Provider extensions configured in `compat.piExtensions` (for example the Kilo
provider) are loaded in addition to this list.

Before-agent system-prompt handlers compose in this order. Memory/context
returns a new prompt, then the plan extension appends its instructions.

## Session runtime and resume

`createFlintcodeSessionHost` builds an `AgentSessionRuntime` whose factory recreates
services for a target cwd. This is the supported way to handle `/new`, resume,
fork, import and session switches without reusing stale extension contexts.

Important rules:

- Unsubscribe old session listeners and call `bindExtensions` again after a
  replacement (`FlintcodeTui.doBind`).
- `runtime.setRebindSession` is not used by Flintcode; host commands explicitly call
  `bindSession(true)` after runtime replacements. Extension command actions also
  rebind.
- `SessionManager` is pi's JSONL tree. `getEntries().length > 0` marks a resumed
  session; Flintcode does not force the configured model onto it. Explicit `--model`
  wins.
- Session files live in `~/.flintcode/sessions`; `flintcode sessions` and `/sessions` read
  the same store.
- A persisted bound session holds `~/.flintcode/state/session-locks/<id>.lock` with
  pid/cwd metadata and a 10-second heartbeat. Another live process gets a clear
  conflict; locks older than 45 seconds or owned by dead pids are reclaimed.
- `doBind` first cancels queued/active modals and moves the lease before binding,
  so approvals from a replaced session cannot leak into the new one.

## Permission pipeline

For every tool call, the inline permission extension calls
`PermissionEngine.check(toolName, input)`:

1. **Plan guard** — if plan mode is active and the tool is not plan-safe, deny.
2. **Allowed cache** — “always allow” decisions keyed by tool + canonical target.
3. **Rules** — match tool globs, path globs, command regexes and MCP servers.
   Any matching deny wins; then allow; then ask. Rules are evaluated before the
   mode.
4. **Secret and workspace protection** — with
   `permissions.protectSecrets`, credentials, `.env`, private keys and
   Flintcode/pi configuration files force approval even in `yolo`. Network commands
   that reference sensitive material and edit targets whose lexical workspace
   path resolves through a symlink outside the project are also forced to ask.
5. **Mode policy**:
   - `default`: read-only allow, edit/write/shell/unknown ask
   - `accept-edits`: workspace edits allow; shell/outside ask
   - `auto`: workspace edits and low-risk shell allow; dangerous/outside ask
   - `dont-ask`: asks become denials
   - `yolo`: automatic except plan mode, deny rules and protected secrets
6. **PermissionRequest hook** — optional `~/.flintcode/hooks.json` shell hook can
   allow or deny without the UI.
7. **Approval** — TUI shows a solid dialog (Allow once / Always allow / Deny)
   with a deadline from `permissions.approvalTimeoutSeconds`. Cancelled or expired
   decisions deny. Non-interactive asks are denials.

Tool classes live in `src/core/permissions.ts` (`READ_ONLY_TOOLS`,
`EDIT_TOOLS`, `SHELL_TOOLS`, `PLAN_SAFE_TOOLS`). Adding a tool without updating
these sets gives it conservative “unknown” behavior.

### Paths and commands

- Paths are resolved against the session cwd for workspace checks and rule
  matching. Edit policy additionally resolves existing ancestors with `realpath`
  to detect symlink escapes.
- Shell commands are matched against dangerous patterns in `auto` mode and
  sensitive-file/network combinations when secret protection is enabled.
- MCP tools are named `mcp__<server>__<tool>`.

## Plan mode

`PlanController` (`src/core/plan.ts`) owns the state:

- `enter()` snapshots active tools, enables only `PLAN_SAFE_TOOL_NAMES` plus
  `ExitPlanMode`, sets `PermissionEngine.planMode`, and notifies the UI.
- `ExitPlanMode` executes with the plan text, asks the host for approval, and on
  approval restores the snapshot.
- `/plan` is a host command; `/plan <task>` enters plan mode and submits the
  task. `/plan off` exits without model approval.
- The plan extension appends `PLAN_SYSTEM_PROMPT` via `before_agent_start` while
  active.
- Approved plans are written to `~/.flintcode/plans/<timestamp>.md` and recorded as
  custom session entries.
- The permission engine enforces read-only even if the mode is `yolo`, so a
  stale tool set cannot bypass the plan guard.

Plan state is reset on session replacement (`attachSession`). It is not
currently restored from session entries after resume; tools revert to normal.

## Subagent runtime

The `Agent` tool (`src/extensions/subagent.ts`) uses `AgentRunner`:

- Agent definitions are built-in (`general-purpose`, `explore`, `plan`,
  `reviewer`) or markdown files from `~/.flintcode/agents`, `~/.pi/agent/agents` and
  trusted `.flintcode/agents`.
- Each task starts `src/agent-worker/worker.js` as a Node child process using
  `child_process.fork` with `--max-old-space-size=<agents.workerHeapMb>`. The
  worker creates an isolated pi `AgentSession` using:
  - in-memory session storage
  - a newly created `ModelRuntime` from the same Flintcode/pi credential configuration
  - configured provider extensions from `compat.piExtensions`, so dynamic
    providers such as Kilo remain available out of process
  - an agent-specific system prompt and tool allowlist
  - an IPC permission bridge and tool-output guard extension
- The parent resolves and validates model/reasoning before spawn. The worker's
  every tool call sends its tool/input over IPC; the parent
  `PermissionEngine.check` applies hooks, rules, mode, plan mode, approval UI and
  “always allow” cache. The worker waits for the decision and then executes.
- `AgentRunner` has a concurrency semaphore (`agents.maxConcurrent`, default 4),
  max 8 tasks per call, a `/proc/meminfo` reservation gate, startup deadline,
  runtime deadline, per-worker tool-call budget, abort relay and
  SIGTERM→SIGKILL cleanup.
- The worker sends bounded activity/text IPC messages, which the parent maps into
  the tool card's progress. Final assistant text is extracted from all assistant
  messages, with a thinking-block fallback and one plain-text recovery prompt if
  the model returns `done` without a report. An aborted worker preserves partial
  streamed output instead of returning an empty success.
- Background workers return immediately and a completion message is sent through
  the owning session. Worker processes end when their parent exits or aborts
  them; Flintcode does not currently re-attach workers across a new parent process.
- There is intentionally no nested Agent tool in child sessions.

## Models and providers

- Flintcode uses pi's `ModelRuntime` with pi's `auth.json` and a generated
  `~/.flintcode/models.json`.
- The generated catalog merges the user's pi model providers with a single
  `flintcode` provider whose models are the enabled managed providers. The
  provider entry points at a loopback gateway and references
  `$FLINTCODE_GATEWAY_KEY`; no provider secrets are written to models.json.
- `src/core/providers/` owns the registry, credential store, OpenAI discovery,
  Nous OAuth, the gateway and model-catalog generation. Core session/TUI code
  never branches on a specific third-party provider.
- The gateway forwards OpenAI chat completions, rewrites the model to the
  provider's upstream ID, injects custom headers/auth, streams the response and
  refreshes Nous credentials on 401. It binds only to 127.0.0.1 and uses a
  per-process random key.
- Managed models are addressed as `flintcode/<provider>/<model>`. The
  `flintcode use` command writes those defaults into config.
- Model selection precedence: explicit `--model`/agent model → config default →
  first available free Kilo auto → first available free model → first available.
- Reasoning is capability-validated: Flintcode mirrors pi's rule (reasoning models
  support off/minimal/low/medium/high; xhigh/max only when explicitly mapped;
  non-reasoning models only off). Child agents validate task/agent levels
  against the selected model and return the supported list on error. The main
  session applies the config default only to new sessions and preserves saved
  levels on resume.
- The Kilo provider is an optional pi extension path in
  `compat.piExtensions`. It registers models from Kilo's catalog and OAuth from
  pi's auth store. Flintcode retries the configured provider after session bind if
  the catalog arrived too late. The same mechanism loads the pi Nous extension
  used by the pi/tau side integration.
- Free models are marked with `free` using cost and catalog metadata.
- Provider loading for `flintcode models`/`flintcode doctor` uses
  `createFlintcodeInspectionServices`, which loads provider extensions without
  creating an agent session.

## TUI architecture

- `TuiAltScreen` owns the alternate buffer, layout, scrolling, mouse selection
  and search. `VStack` allocates transcript/editor/statusline.
- `TranscriptView` wraps user/assistant/tool components. Assistant deltas are
  throttled before updating markdown. It retains at most
  `ui.transcriptBlocks` components, removes older assistant/tool references, and
  renders only the newest `ui.historyMessages` entries from a resumed session.
- Tool cards are created on `tool_execution_start`; partial/final results update
  the same card. Ctrl+O expands/collapses. Result text is capped to
  `ui.toolOutputChars`; an oversized final result is offloaded to
  `state/tool-output/<session>/<toolCallId>.txt` and the card shows its path.
- `Statusline` renders configurable segments (mode, cwd, git, model, thinking,
  context, tokens, cost, background tasks, todos, session, clock, command
  output). It refreshes git/statusline commands asynchronously.
- `dialogs.ts` wraps `SelectList`/`Input` in a `SolidPanel` that repaints the
  whole overlay area with a background, preventing transcript bleed-through.
- Permission, question and plan dialogs share one modal queue. Each request has
  an absolute deadline; the queue, active overlay and pending callbacks are all
  invalidated by a modal generation counter when the session changes, aborts or
  quits. Expired dialogs resolve as deny/cancel rather than blocking forever.
- Host-side slash commands are defined in `FlintcodeTui.commandDefinitions`; unknown
  commands and `/skill:*` are forwarded to `session.prompt`.
- The TUI binds extensions without a pi UI context. Host dialogs are invoked by
  Flintcode services/bridges, not by extension `ctx.ui`.

## Persistence layout

All runtime state is under `~/.flintcode` (ext4):

| Path | Contents |
|---|---|
| `flintcode.json` | normalized configuration |
| `sessions/` | pi-compatible session JSONL |
| `agents/` | user agent definitions |
| `skills/`, `prompts/`, `themes/`, `extensions/` | user resources |
| `hooks.json` | hook definitions |
| `mcp.json` | MCP server configuration |
| `logs/flintcode.log` | JSONL application log |
| `state/session-locks/` | lifetime leases for open sessions |
| `state/tool-output/` | full copies of oversized tool results |
| `state/todos/` | per-session todos |
| `tasks/bash/` | background task metadata + logs |
| `subagents/` | reserved; worker sessions are in-memory and isolated per process |
| `memory/memory.jsonl` | durable memories |
| `goals.json` | durable goals |
| `loops.json` | scheduled prompt records |
| `plans/` | approved plan markdown |
| `worktrees/` | default git worktree root |
| `trust.json` | project trust decisions |
| `checkpoints/` | reserved for Phase 2 file checkpoints |

Atomic JSON writes live in `src/util/atomic-json.ts`: serialize per path,
write a same-directory temp file, fsync, rename. `src/util/lock.ts` adds
cross-process lock directories for read-modify-write operations. Config
`patchFlintcodeConfig`, trust, todos, memory, goals and loops acquire the relevant
lock before reading the latest value, so concurrent Flintcode processes cannot clobber
fields written by another process. Never put these files in the repository.

## CLI and modes

- Interactive TUI: default.
- Print: `-p` / `--mode print` / `flintcode print`; `runPrintMode` returns the final
  response, exit code 1 on model/tool failure.
- JSONL: `--mode json` / `--json`; pi event stream.
- RPC: `--mode rpc`; pi RPC protocol with extension UI messages.
- Resource commands never start an agent session except `models`/`doctor`,
  which need provider extension registration.

## Performance and Android notes

- `tsc` parses a large pi type graph. `skipLibCheck` and incremental builds are
  enabled. The device is frequently CPU/RAM-saturated by other apps, so measure
  before attributing slowness to code.
- `/storage` is FUSE and noexec. Do not place state or executable bits there.
  Use `node bin/flintcode` or the installed wrapper in `$PREFIX/bin`.
- Streaming markdown is throttled to 120 ms; per-tool updates to 100 ms; the HUD
  polls every 8 s; the working spinner renders once per second and session stats
  every 3 s. Tool output is collapsed by default and capped/offloaded, while the
  transcript trims retained UI components instead of holding an unbounded
  session view in memory.
- TUI smoke tests use tmux and should use a unique session name. Input sent too
  quickly can concatenate; wait 0.5–1s between text and Enter.

## Known limitations and roadmap

Phase 1 (implemented) covers the TUI, sessions with cross-process leases,
permissions with secret/workspace guards, plan mode, skills/agents/prompts,
process-isolated parallel/background subagents, hooks, MCP, todos,
goals, memory, web, background bash, loops, worktrees, output styles, statusline,
print/JSON/RPC and resource CLIs.

Not implemented yet: a detached supervisor that lets agents survive after their
parent Flintcode process exits, workflow scripts, teams/messaging, file
checkpoint/rewind, detached cron daemon, vim mode, kanban, voice, image
generation, plugin marketplace, usage insights, review/diff/commit flows and
session sharing.
Flintcode account inference, remote sessions, cloud security scan, Sites and wiki
are intentionally out of scope.

