# Flintcode — instructions for agents

Flintcode is a terminal coding harness built on the MIT `@earendil-works/pi-*`
libraries. The user is running it on Termux/Android. You are allowed to modify
this repository, add tools, commands and services, and extend the harness.

**You are Flintcode, not pi.** This session is Flintcode. Never run `pi`
commands, never inspect pi's processes/docs as a substitute for Flintcode's own
tools, and never present pi's interface as Flintcode's. pi is an implementation
dependency; `flintcode` is the CLI and `flintcode docs` is the documentation entrypoint.

Flintcode is a fork of the MIT Tau harness, not a QoderCLI source fork.
QoderCLI source is unavailable; see `docs/LIMITATIONS.md` before proposing
Qoder-specific work. Provider work goes through `src/core/providers/` and the
managed provider gateway; do not scatter provider conditionals through the core.

## Read these before changing behavior

1. `docs/ARCHITECTURE.md` — runtime flow, modules, extension order, persistence.
2. `docs/EXTENDING.md` — exact recipes for tools, slash commands, CLI commands,
   permissions, hooks, providers, UI and tests.
3. `docs/AGENT-GUIDE.md` — self-modification workflow, debugging and guardrails.
4. `README.md` — user-facing feature set and limitations.

Read only what you need, but **read `docs/EXTENDING.md` before adding any tool**.

## Commands

Run from `/storage/emulated/0/Tools/flintcode`:

```bash
npm run build          # incremental tsc -> dist/
npm test               # build + all unit tests
npm run test:unit      # node:test suite
bash scripts/check.sh  # build + tests + CLI smoke
bash scripts/smoke-tui.sh  # isolated tmux TUI smoke (no model call)
node bin/flintcode --help
node bin/flintcode doctor
node bin/flintcode config
node bin/flintcode providers list
node bin/flintcode plugins list
```

Provider tests must not hit live paid services. Use local mock upstreams or the
existing tests; state clearly when a live provider or Nous request was not
exercised.

`npm` installs must use `bin-links=false` (already in `.npmrc`). Invoke
`node_modules/typescript/bin/tsc` through the npm scripts; `.bin` does not
exist on this filesystem.

## Hard constraints

- Source and `node_modules` are on FUSE `/storage`; it is `noexec` and does not
  support symlinks. Never create symlinks or put runtime state here.
- Runtime state lives in `~/.flintcode` (ext4). pi credentials/models live in
  `~/.pi/agent`. Never copy credentials into the repo, logs or sessions.
- The device is often heavily loaded. Do not run parallel builds; use timeouts
  and background jobs for long commands. Do not kill unrelated processes.
- Do not edit `node_modules` or the installed pi packages. Treat pi as
  third-party API; pin it to 1.3.0.
- Keep modules ESM NodeNext. Relative imports in TypeScript use `.js`.
- Never commit `~/.flintcode/providers-auth.json` or any key/token. Provider
  secrets are read from stdin/env and stored only in the 0600 auth file.
- Do not edit the generated `~/.flintcode/models.json`; it is rebuilt at every
  bootstrap from `providers.json` and pi's models. Add providers through the
  registry/CLI instead.
- The provider gateway is loopback-only and must keep its random per-process
  key. Do not log requests, prompts, API keys or tokens.
- Never add a raw API key to `providers.json`, `models.json`, docs or tests.
  Managed providers must remain OpenAI-compatible; native protocols belong in
  pi provider extensions, not the gateway.
- Prefer tabs, double quotes and the existing file structure.
- The running TUI has already loaded its modules. Rebuild and start a new TUI
  (or use `/reload` for a `~/.flintcode/extensions` change) to test modifications.
- Do not use destructive git commands. This project may not be a git repo.
- No comments unless they explain a non-obvious reason or workaround.

## Architecture at a glance

```
bootstrap -> trust -> config -> provider runtime (registry/auth/gateway/models.json)
          -> ModelRuntime -> DefaultResourceLoader
          -> extension factories -> AgentSessionRuntime -> TUI bind/subscribe
```

- `src/core/session-host.ts` composes pi sessions. `createFlintcodeInspectionServices`
  loads provider extensions without creating a session.
- `src/core/providers/` owns provider CRUD, credentials, OpenAI discovery,
  Nous OAuth, the loopback gateway and the generated pi model catalog. Managed
  models are exposed as `flintcode/<provider>/<model>`.
- `src/cli/providers.ts` and `src/cli/plugins.ts` own the provider/auth/login/use
  and plugin/plugin-pack command surfaces.
- `src/extensions/index.ts` is the canonical extension order. Add a new
  extension factory there.
- `src/core/permissions.ts` is the policy engine. New tools must be classified
  as read-only / edit / shell / unknown and added to `PLAN_SAFE_TOOLS` only if
  safe in plan mode.
- `src/core/plan.ts` enforces plan-mode tool confinement.
- `src/core/agent-runner.ts` supervises one worker process per Agent task and
  relays its tool approvals to the shared parent permission engine.
- `src/core/session-lock.ts` holds a heartbeat lease per persisted session; do
  not bind the same session in two Flintcode processes.
- `src/util/lock.ts` protects cross-process read-modify-write operations. Use it
  in addition to atomic writes for config/trust/todos/memory/goals/loops.
- `src/tui/app.ts` owns session binding, slash commands, dialogs, HUD and
  event-driven transcript updates.
- Tools are pi `ToolDefinition`s registered by extension factories
  (`src/extensions/*.ts`). Runtime-only tools can also live in
  `~/.flintcode/extensions/*.ts` and are loaded with `/reload`.

## Tool classification checklist

For every new tool answer:

- Is it read-only? Add the name to `READ_ONLY_TOOLS` in
  `src/core/permissions.ts` and likely `PLAN_SAFE_TOOL_NAMES` in
  `src/core/plan.ts`.
- Does it modify files or run shell commands? Do not mark it read-only; let the
  mode/rule pipeline decide. Add its name to the relevant set if it behaves
  like an existing class (`EDIT_TOOLS`, `SHELL_TOOLS`).
- Is it safe while planning? Only read-only/research/session-notification tools
  belong in the plan-safe list. Agent tools that can write must stay out.
- Add `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) and a
  correct `executionMode` when needed.

## Definition of done

- `npm run build` succeeds.
- `npm test` passes (add tests for new pure logic and provider/auth/gateway
  behavior; mock external services).
- New provider work includes a gateway/registry test and does not require a
  live third-party key.
- Relevant CLI/TUI smoke test passes. For UI changes use a unique tmux session
  and verify at 110x34 and a narrow width.
- `README.md` and the relevant `docs/` page are updated when behavior, commands,
  tools, configuration or limitations change.
- State an explicit verification list and any known limitation in the final
  report. Do not claim a feature works if it was not exercised.

## Do not

- Bypass permissions or silently mark risky tools read-only.
- Remove trust checks, secret protection, session leases or the plan-mode guard.
- Save merged project configuration back into `~/.flintcode/flintcode.json`; patch the user
  file through `patchFlintcodeConfig`.
- Add npm dependencies without a clear reason and a documented alternative.
- Depend on Flintcode cloud APIs for local features.
- Put sessions, logs, plans, todos or task data in the repository.
