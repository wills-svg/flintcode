# Plugins, MCP and skills

## Plugins are pi extensions

Flintcode uses pi's `ExtensionAPI` for runtime plugins. This is functionally
similar to OpenCode plugins (a JS/TS module that runs inside the agent and can
register tools or hooks), but it is **not** binary-compatible with OpenCode's
plugin API. OpenCode plugins should be ported to this API or run in OpenCode
itself.

Plugins run with the same OS permissions as Flintcode. Install only code you
trust.

## Single-file extension

Create `~/.flintcode/extensions/word-count.ts`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const wordCount = defineTool({
  name: "word_count",
  label: "Word Count",
  description: "Count words in a workspace file.",
  parameters: Type.Object({ path: Type.String() }),
  annotations: { readOnlyHint: true },
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const file = path.resolve(ctx.cwd, params.path);
    const text = await fs.readFile(file, "utf8");
    return {
      content: [{ type: "text", text: `${text.trim().split(/\s+/u).length} words` }],
      details: {},
    };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(wordCount);
}
```

Start a new session or run `/reload`; `/tools` should list `word_count`.
`flintcode plugins install ./word-count.ts` copies a file into the user
extensions directory. `plugins list` and `plugins path` show what is loaded.

## Plugin packs

A directory plugin needs a `plugin.json`:

```json
{
  "name": "example-pack",
  "version": "0.1.0",
  "description": "Example Flintcode extension pack",
  "extensions": ["index.ts"]
}
```

```bash
flintcode plugins install ./example-pack
flintcode plugins remove example-pack --yes
```

Installation copies the pack to `~/.flintcode/plugins/<name>` and adds the
absolute extension entry paths to `compat.piExtensions` in
`~/.flintcode/flintcode.json`. Missing extension entries abort installation.
Plugin packs cannot rename themselves with `--name`; the manifest name wins.

## MCP

```bash
flintcode mcp add --local context7 -- npx -y @upstash/context7-mcp
flintcode mcp add --url remote-mcp https://mcp.example/mcp
flintcode mcp list
flintcode mcp enable context7
flintcode mcp disable context7
flintcode mcp remove context7
```

User servers live in `~/.flintcode/mcp.json`; project servers live in
`.flintcode/mcp.json` and require project trust. The existing pi MCP client
handles transport, tool exposure and status.

## Skills

```bash
flintcode skills list
flintcode skills path
flintcode skills install ./my-skill --name my-skill
flintcode skills remove my-skill --yes
```

A skill is a directory with a `SKILL.md` (frontmatter `name` and
`description`). Installed skills are copied into `~/.flintcode/skills` and are
discovered on the next session. Skills inherited from `~/.pi/agent/skills`
remain available.

## Agents and hooks

The upstream agent, hook and worktree features remain:

```bash
flintcode agents
flintcode hooks list
flintcode hooks test PreToolUse --tool Bash
flintcode worktree list
```

## Security

- There is no sandbox. A plugin can read files, spawn processes and exfiltrate
  data with your OS permissions.
- Do not install plugins from untrusted sources; Flintcode only installs local
  paths, never remote URLs.
- Provider API keys are not exposed to plugins through the provider registry
  API; plugins with filesystem access can still read `providers-auth.json`.
- Keep `~/.flintcode/providers-auth.json` at mode 0600.
