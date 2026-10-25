import { APP_NAME, APP_TAGLINE, VERSION } from "../version.js";

export function generalHelp(): string {
	return `${APP_NAME} ${VERSION} — ${APP_TAGLINE}.

Usage:
  flintcode [options] [prompt]
  flintcode <command> [options]

The default invocation opens the interactive TUI. Use -p for one-shot output.

Core options:
  -p, --print                    Print the final response and exit
  -i, --prompt-interactive <t>   Start with a prompt, then stay interactive
  --mode <mode>                  interactive | print | json | rpc
  -o, --output-format <fmt>      text | json | stream-json
  -m, --model <model>            Model by id or provider/id (supports :thinking)
  --thinking <level>             off | minimal | low | medium | high | xhigh | max
  --permission-mode <mode>       default | accept-edits | auto | dont-ask | yolo
  --dangerously-skip-permissions Alias for --permission-mode yolo
  --tools <list>                 Restrict the exposed tools (comma separated)
  --allowed-tools <list>         Permission rules: allow these tools
  --disallowed-tools <list>      Permission rules: deny these tools
  -c, --continue                 Continue the most recent session
  -r, --resume [id]              Resume a session by id, name, or path
  --fork                         Fork the resumed/recent session
  -n, --name <name>              Name the session
  --session-id <id>              Use a specific session id
  --no-session-persistence       Keep the session in memory only
  --trust / --no-trust           Trust or reject project resources
  --worktree [name]              Create and enter a git worktree
  -w, --cwd <dir>                Working directory
  --config-dir <dir>             Flintcode config directory (default ~/.flintcode)
  --add-dir <dir>                Additional directory available to the session
  --agent <name>                 Start with a named subagent definition
  --system-prompt <text>         Replace the base system prompt
  --append-system-prompt <text>  Append to the system prompt
  -v, --version                  Print the version
  -h, --help                     Show help

Commands:
  init        Create ~/.flintcode, configuration, and the directory layout
  doctor      Diagnose installation, models, credentials, state, and terminal
  models      List models, or add/remove/alias managed models
  providers   Add, edit, test, discover, enable, disable or remove providers
  auth        Store API keys and inspect provider sign-in status
  login       Sign in to a provider (Nous Portal device flow)
  logout      Remove stored provider credentials
  use         Set the default provider/model
  plugins     List, install or remove runtime extension plugins
  sessions    List, inspect, or delete sessions
  mcp         Manage MCP servers
  skills      List and inspect skills
  agents      List agent definitions
  hooks       List, test, and manage hooks
  worktree    Manage git worktrees
  trust       Show or change project trust decisions
  cron        Inspect scheduled prompts
  config      Show resolved configuration and paths
  search      Search the web directly (DuckDuckGo + fourget fallback)
  fetch       Fetch a URL and print readable text
  docs        List or print Flintcode's own documentation
  print       One-shot print mode (same as -p)

Examples:
  flintcode
  flintcode "Find and fix the failing tests"
  flintcode -p "Summarize this repository"
  flintcode -m litepod/deepseek/deepseek-v4.1-flash --thinking high
  flintcode providers add openrouter --base-url https://openrouter.ai/api/v1 --model openai/gpt-4o-mini
  printf %s "$OPENROUTER_API_KEY" | flintcode auth set-key openrouter
  flintcode providers test openrouter --chat
  flintcode login nous
  flintcode use nous/Hermes-4-70B
  flintcode plugins install ./my-plugin --yes
  flintcode -c
  flintcode doctor

State lives in ~/.flintcode. Flintcode reuses pi models/auth and your pi skills, agents,
prompts and instructions by default. Project resources require trust.
`;
}

const COMMAND_HELP: Record<string, string> = {
	init: `Usage: flintcode init [--no-import]

Creates ~/.flintcode and writes the default flintcode.json. Existing files are never
overwritten. Flintcode reads models/auth and user resources from ~/.pi/agent in place;
nothing sensitive is copied.`,
	doctor: `Usage: flintcode doctor [--json] [--network]

Checks the runtime, architecture, state directories, pi compatibility, model
configuration, credentials (without printing secrets), available free models,
hooks, MCP, tmux, and project trust.`,
	models: `Usage: flintcode models [--available] [--provider <id>] [--json]
       flintcode models add <provider> <model> [--name <name>] [--upstream-id <id>]
       flintcode models remove <provider> <model>
       flintcode models alias <provider> <model> <alias>

Lists configured chat models, their provider/id, context window, free status,
and whether credentials are configured. Managed OpenAI-compatible models are
registered here; run \`flintcode providers discover\` for automatic discovery.`,
	providers: `Usage: flintcode providers list [--json]
       flintcode providers show <id> [--json]
       flintcode providers add <id> --base-url <url> [options]
       flintcode providers edit <id> [options]
       flintcode providers remove <id> --yes
       flintcode providers enable|disable <id>
       flintcode providers discover <id> | --all [--json]
       flintcode providers test <id> [--chat] [--json]

Add any OpenAI-compatible endpoint with --base-url, optional --api-key-env,
--auth-header/--auth-scheme, --header "Name: value", --model, --default-model,
--context-window, --vision and --reasoning. The API key itself is read from
stdin (never argv) with \`flintcode auth set-key <id>\`, or from its env var.
Providers are stored in ~/.flintcode/providers.json; secrets live separately in
~/.flintcode/providers-auth.json (0600).

Examples:
  flintcode providers add openrouter --base-url https://openrouter.ai/api/v1 \
    --api-key-env OPENROUTER_API_KEY --model openai/gpt-4o-mini
  flintcode providers add local --base-url http://127.0.0.1:11434/v1 \
    --model qwen3-coder --no-discover
  printf %s "$KEY" | flintcode auth set-key local
  flintcode providers test local --chat`,
	auth: `Usage: flintcode auth set-key <provider>
       flintcode auth status [--json]
       flintcode auth remove <provider>

Keys are read from stdin and written to ~/.flintcode/providers-auth.json with
mode 0600. Environment variables configured for a provider take precedence.
Nous Portal credentials are managed by \`flintcode login\`; Flintcode can also
reuse a shared pi/tau Nous sign-in from ~/.pi/agent/auth.json.`,
	login: `Usage: flintcode login [nous] [--from-pi]

Starts the Nous Portal device flow, prints a URL and code, waits for browser
approval, mints an inference agent key, and discovers the account's models.
\`--from-pi\` imports the shared pi/tau Nous credential instead of starting a
new flow. Credentials are stored in ~/.flintcode/providers-auth.json (0600).`,
	logout: `Usage: flintcode logout <provider>

Removes Flintcode's stored credential. A shared pi/tau Nous sign-in is not
deleted; Flintcode may reuse it on the next request.`,
	use: `Usage: flintcode use <provider/model> [--thinking <level>]

Stores the default provider/model in ~/.flintcode/flintcode.json. Managed
providers use the flintcode/<provider>/<model> key under the hood.`,

	sessions: `Usage: flintcode sessions [list] [--all] [--json]
       flintcode sessions show <id>
       flintcode sessions delete <id>

Lists Flintcode sessions. Session JSONL remains pi-compatible.`,
	mcp: `Usage: flintcode mcp add [--local] <name> -- <command...>
       flintcode mcp add --url <url> <name>
       flintcode mcp list
       flintcode mcp remove <name>

User MCP servers live in ~/.flintcode/mcp.json; project servers in .flintcode/mcp.json.`,
	skills: `Usage: flintcode skills [list] [--json]
       flintcode skills path
       flintcode skills install <dir> [--name <name>] [--force]
       flintcode skills remove <name> --yes

Lists user, project and pi-compatible skills. Installed skills are copied into
~/.flintcode/skills and are discovered on the next session (or /reload).`,
	plugins: `Usage: flintcode plugins list [--json]
       flintcode plugins path
       flintcode plugins install <file-or-dir> [--name <name>] [--force]
       flintcode plugins remove <name> --yes

Installs pi runtime extension plugins. A single .ts/.js/.mjs file goes into
~/.flintcode/extensions and is loaded automatically. A plugin pack directory
needs a plugin.json with a name and an extensions array (default: index.ts);
its extension paths are added to compat.piExtensions. Plugins run with full
process permissions. OpenCode's plugin API is not binary-compatible; Flintcode
uses pi's ExtensionAPI (registerTool, hooks, commands).`,

	agents: `Usage: flintcode agents [list] [--json]

Lists agent definitions from ~/.flintcode/agents, ~/.pi/agent/agents, and .flintcode/agents.`,
	hooks: `Usage: flintcode hooks list
       flintcode hooks test <event> [--tool <tool>] [--json]
       flintcode hooks path

Hooks are configured in ~/.flintcode/hooks.json.`,
	worktree: `Usage: flintcode worktree list
       flintcode worktree create [name]
       flintcode worktree remove <name>
       flintcode worktree path

Worktrees are created under ~/.flintcode/worktrees unless configured otherwise.`,
	trust: `Usage: flintcode trust
       flintcode trust allow [path]
       flintcode trust deny [path]
       flintcode trust clear [path]

Project trust gates project skills, agents, prompts, settings, extensions,
hooks, and instructions.`,
	cron: `Usage: flintcode cron [list]

Shows scheduled prompts. Loops are created and managed inside a session with
/loop or ScheduleWakeup. A detached cron daemon arrives in Phase 2.`,
	config: `Usage: flintcode config [--json]

Shows the resolved Flintcode configuration, model defaults, permission mode, output
style, and all state paths.`,
	search: `Usage: flintcode search [--limit N] [--json] <query>

Search the web without a model call. DuckDuckGo HTML is used first; the local
fourget backend is the fallback.`,
	fetch: `Usage: flintcode fetch [--max-chars N] [--json] <url>

Fetch an http(s) URL and print readable text, title, status and links.`,
	docs: `Usage: flintcode docs [topic] [--json]

List Flintcode's development manuals or print one. Topics: index, architecture,
extending, providers, nous, plugins, limitations, agent, agents, skill, readme. These are intended for both humans and
LLM agents extending Flintcode.`,
	print: `Usage: flintcode print [options] <prompt>

Print mode. Equivalent to flintcode -p. Add --output-format json for events.`,
	help: `Usage: flintcode help [command]

Show general help or help for a command.`,
	version: `Usage: flintcode version

Print the Flintcode version.`,
};

export function commandHelp(command: string): string {
	return COMMAND_HELP[command] ?? generalHelp();
}

export function formatVersion(): string {
	return `${APP_NAME} ${VERSION}`;
}
