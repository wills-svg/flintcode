# Flintcode documentation

Start with `../README.md` for the user-facing feature set and install steps.

| Document | Audience | What it covers |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | contributors and LLMs | boot/runtime flow, modules, extension order, permissions, plan mode, subagents, TUI, persistence |
| [EXTENDING.md](EXTENDING.md) | contributors and LLMs | adding tools, services, slash commands, CLI commands, permissions, hooks, MCP, providers, UI, tests |
| [AGENT-GUIDE.md](AGENT-GUIDE.md) | LLM agents | self-modification workflow, debugging recipes, guardrails, verification |
| [PROVIDERS.md](PROVIDERS.md) | users and contributors | OpenAI-compatible providers, discovery, model selection, gateway, security |
| [NOUS.md](NOUS.md) | users | Nous Portal device flow, shared pi/tau sign-in, Hermes models, status |
| [PLUGINS.md](PLUGINS.md) | users and plugin authors | pi extension plugins, plugin packs, MCP and skills |
| [LIMITATIONS.md](LIMITATIONS.md) | everyone | QoderCLI investigation, blocked items, live verification status |
| [skills/flintcode-extension-creator/SKILL.md](skills/flintcode-extension-creator/SKILL.md) | Flintcode skills | a loadable skill for extending Flintcode |
| [../AGENTS.md](../AGENTS.md) | LLM agents | mandatory project rules and build commands |

Useful commands:

```bash
flintcode docs                 # list these documents
flintcode docs extending       # print a document
flintcode doctor               # environment/model/state diagnostics
flintcode config --json        # resolved config and paths
bash scripts/smoke-tui.sh
```

Runtime-only tools live in `~/.flintcode/extensions/`; run `/reload` in an
interactive session to load them without rebuilding.
