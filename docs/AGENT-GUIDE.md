# Flintcode agent guide

This is the working manual for an LLM asked to improve Flintcode itself. `AGENTS.md`
contains the mandatory rules; `EXTENDING.md` has API recipes; this file is the
execution workflow.

## 1. Start with reconnaissance

```bash
cd /storage/emulated/0/Tools/flintcode
node bin/flintcode --version
node bin/flintcode config
node bin/flintcode doctor
git status 2>/dev/null || true
find src -type f | sort
```

Read only the docs you need:

- runtime/session changes → `docs/ARCHITECTURE.md`
- tools/commands/permissions/UI → `docs/EXTENDING.md`
- user behavior → `README.md`

Do not assume a feature from the README is implemented. Check the code and
exercise it. Do not assume the device is healthy: `uptime`, `free -m` and
`ps aux | sort -k3 -nr | head` explain most unexpected slowness.

## 2. Choose the smallest mechanism

| Need | Use |
|---|---|
| new model-callable capability | tool extension |
| reusable instructions/workflow | skill or prompt template |
| user-triggered action in the TUI | host slash command |
| shell/script automation | CLI command |
| event reaction | pi extension event / hook |
| policy change | `PermissionEngine` / plan sets |
| model/provider | pi provider extension + config path |
| UI presentation | pi-tui component or solid dialog |

If a workflow can be a skill instead of code, prefer the skill. If a tool is
user-local and experimental, start as `~/.flintcode/extensions/<name>.ts` and use
`/reload`; promote it to `src/extensions` when it needs permissions, tests, UI or
shipping.

## 3. Self-improvement loop

1. **Locate** the smallest affected files. Use the module map in
   `ARCHITECTURE.md`.
2. **Plan** the change and its verification before editing. For multi-file
   changes, write a short plan in your reasoning or use your task tool.
3. **Edit** in small steps. Keep policy in `src/core`, adapters in
   `src/extensions`, UI in `src/tui`.
4. **Type/build**: `npm run build` (incremental). `npm run typecheck` is slower
   under heavy device load.
5. **Test** pure logic with `npm run test:unit`; use `scripts/check.sh` for
   build + tests.
6. **Exercise the feature**:
   - CLI: run it with a temporary `FLINTCODE_HOME` and capture stdout/stderr.
   - TUI: run an isolated tmux session and inspect `capture-pane`.
   - Model/tool behavior: use a low thinking level and explicit prompts; beware
     provider latency.
7. **Clean up** temp homes, worktrees, background tasks and tmux sessions.
8. **Document** user-visible changes in `README.md` and the relevant `docs/`.
9. **Report** exact verification commands and any limitation. Do not claim
   unexercised behavior.

### Runtime tool experiment

Write `~/.flintcode/extensions/<name>.ts`, then in a running TUI:

```
/tools
/reload
/tools
```

`/reload` reloads resources/extensions and rebinds the session. Compiled Flintcode
changes cannot be hot-reloaded; start a new `node bin/flintcode` process.

### Compiled feature experiment

Add the extension factory, wire it in `src/extensions/index.ts`, classify the
tool in `permissions.ts`/`plan.ts`, add tests, build, then start a new TUI. The
old process keeps using the old modules.

## 4. Verification recipes

### CLI with isolated state

```bash
H=$(mktemp -d /data/data/com.termux/files/home/flintcode-agent-test-XXXX)
FLINTCODE_HOME="$H" node bin/flintcode config
FLINTCODE_HOME="$H" node bin/flintcode mcp add demo -- echo hi
FLINTCODE_HOME="$H" node bin/flintcode mcp list
rm -rf "$H"
```

### Web tools without a model

```bash
node bin/flintcode search "termux android" --limit 3
node bin/flintcode fetch https://example.com
```

### TUI smoke

```bash
bash scripts/smoke-tui.sh
```

Manual TUI test with a unique session:

```bash
S=flintcode-agent-$$
tmux new-session -d -s "$S" -x 110 -y 34 \
  'cd /storage/emulated/0/Tools/flintcode && node bin/flintcode'
sleep 20
tmux send-keys -t "$S" -l "/tools"; sleep 1
tmux send-keys -t "$S" Enter
sleep 2
tmux capture-pane -p -t "$S" | tail -40
tmux send-keys -t "$S" -l "/quit"; sleep 1
tmux send-keys -t "$S" Enter
```

Input discipline matters: send text, wait ~0.5–1s, then send Enter. Sending
text and Enter together can concatenate with the previous input under load.

To test a prompt and approvals, use `/permissions yolo` for ordinary writes/shell
or approve each dialog. Protected secrets and symlink workspace escapes can still
prompt in YOLO; disable `permissions.protectSecrets` only deliberately. Use
`/thinking low` to reduce model latency. Always close with `/quit` and kill only
your own tmux session. A bound persisted session holds a lease; opening another
Flintcode process on the same session should fail with owner information—use `/new`,
`/fork`, or quit the first process.

### Background services

```bash
node --input-type=module # see tests/unit/services.test.ts for TaskManager/LoopManager patterns
```

For background shell tasks, verify `status`, `output`, `kill`, log paths and
cleanup. Do not leave `sleep 30` tasks running after tests.

## 5. Debugging

- **Flintcode log:** `~/.flintcode/logs/flintcode.log` (JSONL; debug logs when `--debug` is set).
- **Sessions:** `~/.flintcode/sessions/*.jsonl`; inspect `session`, `model_change`,
  `message`, `tool` entries. Never publish credentials from auth. Lease files are
  under `~/.flintcode/state/session-locks/`, and capped tool results can be found under
  `~/.flintcode/state/tool-output/`.
- **Doctor:** `flintcode doctor` checks runtime, state, trust, pi paths, provider
  extensions, model selection, skills/agents, hooks, MCP, git/tmux.
- **Models:** `flintcode models` loads provider extensions; use `--json` for parsing.
- **Config:** `flintcode config --json` shows resolved config and paths.
- **TUI rendering:** tmux `capture-pane -p -S -100`; check the footer and the
  editor layout. Overlays must use `SolidPanel` to avoid bleed-through.
- **Permissions:** reproduce with a single tool call in print mode and
  `--permission-mode default`; check the block reason in the tool result.
- **Hooks:** `flintcode hooks test PreToolUse --tool bash --input '{"command":"ls"}'`.
- **Kilo/provider latency:** the provider fetches its catalog at extension load
  and session start. `flintcode doctor`/TUI use the configured fallback if it fails;
  do not treat a slow start as a logic bug without timing it.
- **High system load:** unrelated apps can make a 20s startup or 30s tsc normal.
  Measure `uptime`/`free` before optimizing.

## 6. Policy and safety

- Never bypass or weaken `PermissionEngine`, plan mode, trust checks, secret
  protection or session leases to make a test pass.
- Never mark a destructive tool read-only or plan-safe.
- Child agents run in separate worker processes and relay every tool call to the
  shared parent permission engine; do not give them an unguarded shell. Worker
  heap, startup, duration and output limits must remain bounded.
- Hooks and extensions are arbitrary code with full process access. Do not load
  untrusted ones automatically.
- Never print, copy or commit `~/.pi/agent/auth.json`, env API keys, session
  tokens or OAuth material.
- Do not delete user sessions, worktrees or state without explicit confirmation.
- Do not kill unrelated processes; use unique tmux/task names and clean up only
  what you created.
- No network-heavy work in tests unless explicitly required. Web tools are
  optional and should fail gracefully.

## 7. Code conventions

- ESM NodeNext; relative TypeScript imports end in `.js`.
- Tabs and double quotes; follow neighboring code.
- Headless `src/core` modules must not import pi-tui. UI code lives in
  `src/tui`.
- Atomic state writes use `src/util/atomic-json.ts`; any read-modify-write
  sequence uses `src/util/lock.ts` or a service transaction helper.
- Host dialogs must use `FlintcodeTui.enqueueModal`/`awaitModal` with generation and
  deadline handling rather than awaiting a raw overlay promise.
- JSON details/content must be serializable.
- Tools should be idempotent when practical, and should report usage if they
  call models.
- Keep behavior within the requested scope; do not refactor unrelated modules.
- Comments only for non-obvious constraints/workarounds.

## 8. Definition of done

- Build passes: `npm run build`.
- Unit tests pass; new pure logic has tests.
- A fresh process exercises the changed path (CLI or isolated TUI).
- Documentation/help is updated for user-visible changes.
- Temp state is cleaned up.
- The final report lists: files changed, commands run, what was verified, what
  was not, and known limitations.

If a task cannot be completed safely (missing credentials, blocked network,
unrelated system load), stop at a coherent state, explain the blocker and leave
the repository buildable.
