# Flintcode

**An extensible terminal coding agent with interchangeable model backends.**

Flintcode is a rebranded, independently maintained fork of the MIT
Tau harness, which composes the MIT
[`@earendil-works/pi-*`](https://pi.dev) libraries. It keeps the Qoder-style
terminal workflow (streamed tool cards, plan mode, approvals, parallel agents,
memory, goals, loops and worktrees) and adds a user-owned provider layer:
OpenAI-compatible APIs, keyless local servers, and Nous Portal OAuth.

Flintcode is **not affiliated with or endorsed by Qoder AI / Alibaba**. Qoder
is referenced only as the source of the UX inspiration.

## Important provenance and limitation

A literal source fork of Qoder CLI is not possible: Qoder CLI is distributed
only as a 35 MB minified/obfuscated Apache-2.0 npm bundle, with no public source
repository. I also tested the official Qoder Agent SDK's host `resolveModel`
custom-provider path. The CLI sends custom models to Qoder's own server, which
rejected arbitrary providers with:

```
{"code":"100400","errMessage":"Failed to generate custom pool"}
```

Therefore the Qoder runtime cannot host a local Nous or arbitrary
OpenAI-compatible provider. Flintcode is the practical, working alternative:
a rebranded fork of the MIT Tau/pi harness with its own provider gateway.
See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full investigation.

## Feature status

| Area | Status |
|---|---|
| Rebrand, build, existing agent features | Implemented and tested (57 tests pass) |
| Provider registry, config, remove/disable, persistence | Implemented and tested |
| Any OpenAI-compatible provider (API key, env key, keyless) | Implemented and tested; live agent E2E verified against a local mock upstream |
| Model discovery, manual models, aliases, switching | Implemented and tested |
| Provider gateway (headers, streaming, auth, 401 refresh for Nous) | Implemented and tested |
| Nous Portal OAuth device flow + agent key + refresh | Implemented and tested with mocked services; live sign-in awaits your browser approval |
| Nous live inference | Not verified (no completed authorization) |
| Nous in pi and tau | Provider extension installed; both list 28 Nous models; login pending |
| MCP support | Inherited and present (`flintcode mcp`) |
| Skills install/list/remove/path | Implemented; list path inherited |
| Plugins (pi ExtensionAPI files and plugin packs) | Implemented; not OpenCode API-compatible |
| QoderCLI source fork | Blocked: no public source, SDK custom models are server-side |

## Install (Termux / Android)

Requirements: Node.js >= 22.19, npm, bash, git.

```bash
cd /storage/emulated/0/Tools/flintcode
npm install --no-bin-links --no-audit --no-fund
npm run build
bash scripts/install.sh
flintcode doctor
```

`/storage` is mounted `noexec` and lacks symlink support. The installer writes
a wrapper to `$PREFIX/bin/flintcode` that runs `node <project>/bin/flintcode`,
so the command still works.

On a normal Linux/macOS machine:

```bash
npm install
npm run build
npm link        # optional, installs the `flintcode` bin
flintcode doctor
```

Run the checks:

```bash
npm test              # build + 57 unit tests
bash scripts/check.sh # build + tests + CLI smoke
```

Runtime state lives in `~/.flintcode` on ext4. Source and `node_modules` stay
on `/storage`.

## Quick start

### OpenAI-compatible provider

```bash
flintcode providers add openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY

# If the key was not in the environment during add:
printf %s "$OPENROUTER_API_KEY" | flintcode auth set-key openrouter
flintcode providers discover openrouter

flintcode providers test openrouter --chat
flintcode use openrouter/<model-id>
flintcode -p "Explain this repository."
```

The key is read from stdin, never from argv, and stored in
`~/.flintcode/providers-auth.json` with mode 0600. Prefer `--api-key-env` so
the key stays in your environment.

### Keyless local server (Ollama, LM Studio, vLLM)

```bash
flintcode providers add ollama \
  --base-url http://127.0.0.1:11434/v1 \
  --no-auth

flintcode providers test ollama
flintcode use ollama/<model-id>
```

If the local server does not expose `/v1/models`, add models manually:

```bash
flintcode providers add local --base-url http://127.0.0.1:8000/v1 \
  --no-auth --no-discover --model my-model
```

### Nous Portal (no API key)

```bash
flintcode login nous
flintcode use nous/<model-id>
flintcode -p "Hello"
```

`login` starts the public Nous Portal device flow, prints a URL and code,
waits for browser approval, mints an inference agent key, and discovers the
account's models. `flintcode login nous --from-pi` imports the shared pi/tau
sign-in instead. See [docs/NOUS.md](docs/NOUS.md).

### Interactive use

```bash
flintcode                 # TUI
flintcode -p "prompt"     # one-shot print mode
flintcode -m nous/<model> # override the model for this run
flintcode /plan           # in-session commands work as before
```

## Provider commands

```text
flintcode providers list [--json]
flintcode providers show <id> [--json]
flintcode providers add <id> --base-url <url> [options]
flintcode providers edit <id> [options]
flintcode providers remove <id> --yes
flintcode providers enable|disable <id>
flintcode providers discover <id> | --all [--json]
flintcode providers test <id> [--chat] [--json]

flintcode auth set-key <provider>
flintcode auth status [--json]
flintcode auth remove <provider>

flintcode login [nous] [--from-pi]
flintcode logout <provider>

flintcode models [--provider <id>] [--available] [--json]
flintcode models add <provider> <model> [options]
flintcode models remove <provider> <model>
flintcode models alias <provider> <model> <alias>
flintcode use <provider/model> [--thinking <level>]
```

`providers add` options include `--name`, `--api-key-env`, `--api-key-stdin`,
`--auth-header`, `--auth-scheme bearer|api-key`, repeatable
`--header "Name: value"`, repeatable `--model id[=upstream-id]`,
`--default-model`, `--context-window`, `--max-output-tokens`, `--vision`,
`--reasoning`, `--discovery-path`, `--no-discover`, and `--no-auth`.

Managed providers are presented to the agent as
`flintcode/<provider>/<model>`; `flintcode use provider/model` sets the
underlying defaults for you.

## Plugins, MCP and skills

- **Plugins**: pi runtime extensions in `~/.flintcode/extensions` (single
  `.ts`/`.js`/`.mjs` files, auto-loaded) or plugin packs installed under
  `~/.flintcode/plugins` with a `plugin.json`. Plugins use pi's
  `ExtensionAPI` (register tools/hooks). This is functionally similar to
  OpenCode plugins but not binary-compatible with their JS API.

  ```bash
  flintcode plugins list
  flintcode plugins install ./my-extension.ts
  flintcode plugins install ./my-plugin-pack
  flintcode plugins remove my-extension --yes
  ```

- **MCP**: `flintcode mcp add`, `list`, `remove`, `enable`, `disable`, `path`.
- **Skills**: `flintcode skills list`, `path`, `install <dir>`, `remove <name>`.
- Hook, agent and worktree commands from the upstream harness are retained.

See [docs/PLUGINS.md](docs/PLUGINS.md) for a working extension example.
Plugins run with the same OS permissions as Flintcode. Do not install
untrusted plugins.

## Configuration

| Path | Purpose |
|---|---|
| `~/.flintcode/flintcode.json` | User configuration/defaults |
| `~/.flintcode/providers.json` | Provider registry (no secrets, mode 0600) |
| `~/.flintcode/providers-auth.json` | API keys and Nous tokens (0600) |
| `~/.flintcode/models.json` | Generated pi model catalog; do not edit |
| `~/.flintcode/sessions` | pi-compatible session JSONL |
| `~/.flintcode/extensions` | Runtime extension plugins |
| `~/.flintcode/plugins` | Installed plugin packs |
| `~/.flintcode/skills` | Installed skills |
| `~/.pi/agent` | pi models/auth/resources reused in place |

Environment: `FLINTCODE_HOME`, `FLINTCODE_CONFIG_DIR`,
`FLINTCODE_PI_AGENT_DIR`, `FLINTCODE_PYTHON`. Legacy `TAU_HOME`,
`TAU_CONFIG_DIR`, `TAU_PI_AGENT_DIR` are accepted. A legacy `~/.tau/tau.json`
is read and migrated to `flintcode.json` on the next config write; use
`--config-dir ~/.tau` to keep everything in the old home. Project `.tau`
directories are used in place when `.flintcode` is absent.

The managed provider gateway binds only to `127.0.0.1` on a random port with a
random per-process key. Provider secrets never appear in `models.json`; it
references `$FLINTCODE_GATEWAY_KEY`. One active Flintcode process per home is
recommended because the generated model catalog is rewritten at startup.

## Architecture and tests

Flintcode's startup path is:

```
bootstrap -> provider runtime (registry, auth, localhost gateway, generated models)
          -> pi ModelRuntime -> session/TUI or print mode
```

The provider gateway forwards OpenAI chat-completion requests to the selected
upstream, injects provider headers/auth, streams the response back, and refreshes
Nous agent keys on 401. Models are exposed to pi as one `flintcode` provider, so
the existing agent/tools/session layer needs no provider-specific code.

Run `npm test`. The suite covers provider CRUD/validation/persistence, API-key
storage and permissions, OpenAI model discovery/merge, gateway routing/headers/
streaming/keyless upstreams, Nous device login/refresh/import, generated model
catalogs, and legacy config migration. A separate live E2E run drove a real
agent query through the gateway to a local mock upstream (`MOCK_OK`).

## Known limitations

- Flintcode is a fork of the MIT Tau/pi harness, **not** a QoderCLI source fork.
  Qoder-specific cloud/sites features are absent.
- Managed providers support OpenAI-compatible chat completions only. Anthropic
  and other native protocols can be configured through pi's own provider
  extensions, not through Flintcode's managed registry.
- Model cost metadata for managed providers is set to zero; the UI may label
  them "free" even for paid upstreams.
- The local gateway rewrites the generated `models.json`; do not run multiple
  Flintcode processes against the same home concurrently.
- Plugins are pi extensions, not OpenCode plugins; see docs/PLUGINS.md.
- Nous live inference is not verified until the device-flow approval completes.
  Hermes model availability depends on the Nous account's live catalog.
- No Windows testing; Termux arm64/aarch64 and Node 26 are the tested platform.

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for evidence and unresolved items.

## License and attribution

Flintcode's own changes are MIT. This is a fork of Tau (MIT), built on the
pi libraries (MIT). The Nous OAuth design is informed by
`@magpie-community/opencode-nous-auth` (MIT) and `@ravshansbox/pi-nous` (MIT).
Qoder CLI is not included or modified. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
