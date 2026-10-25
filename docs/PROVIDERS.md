# Providers

Flintcode has two provider layers:

1. **pi providers** — the providers and auth already configured in
   `~/.pi/agent/models.json` / `auth.json`. They are still available.
2. **Managed providers** — Flintcode's own registry. Any OpenAI-compatible
   endpoint is routed through a local gateway and exposed to the pi runtime as
   `flintcode/<provider>/<model>`.

Managed providers never require provider-specific code in the agent.

## Registry and credentials

| File | Contents |
|---|---|
| `~/.flintcode/providers.json` | IDs, names, base URLs, model metadata, headers, auth mode (0600, no secrets) |
| `~/.flintcode/providers-auth.json` | API keys and Nous tokens (0600) |
| `~/.flintcode/models.json` | Generated pi model catalog; rewritten on every startup |

Provider configs are validated before they are written. Provider IDs are
lowercase letters/digits/`.`/`_`/`-`; `flintcode` is reserved. Model IDs and
aliases may contain `/` but not whitespace or control characters. Managed
headers cannot override `authorization`, `host`, `content-length`, connection
headers or `x-flintcode-*`.

## Add a provider

### API key from an environment variable (recommended)

```bash
export OPENROUTER_API_KEY=...
flintcode providers add openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY
```

The provider is discovered immediately if the endpoint exposes
`GET <base-url>/models`. Its first model becomes the default.

### API key stored by Flintcode

Keys are read from stdin, never from argv:

```bash
printf %s "$DEEPSEEK_API_KEY" | flintcode auth set-key deepseek
flintcode providers discover deepseek
```

`auth set-key` requires a provider that already exists and uses `api-key`
auth. If an env var is configured on the provider, it takes precedence.

### Keyless local provider

```bash
flintcode providers add ollama \
  --base-url http://127.0.0.1:11434/v1 \
  --no-auth

flintcode providers add mlx \
  --base-url http://127.0.0.1:8080/v1 \
  --no-auth --no-discover \
  --model mlx-community/Qwen3-Coder-30B
```

Keyless providers send no `Authorization` header. If discovery is not
available, pass one or more `--model` values and `--no-discover`.

### Manual models

```bash
flintcode providers add proxy \
  --base-url https://llm.example.net/v1 \
  --api-key-env PROXY_KEY \
  --no-discover \
  --model gpt-5.4 \
  --model claude-sonnet-4.6=custom-upstream-id \
  --default-model gpt-5.4 \
  --context-window 400000 \
  --vision --reasoning
```

`--model id=upstream-id` keeps a friendly local ID while sending another ID
upstream. Add models later:

```bash
flintcode models add proxy extra-model --context-window 200000
flintcode models alias proxy extra-model fast
flintcode models remove proxy extra-model
```

### Custom auth headers

```bash
flintcode providers add gateway \
  --base-url https://gateway.example/v1 \
  --api-key-env GATEWAY_KEY \
  --auth-scheme api-key \
  --auth-header x-api-key \
  --header "X-Project: flintcode"
```

`--auth-scheme bearer` (default) sends `Authorization: Bearer <key>`.
`--auth-scheme api-key` sends `x-api-key: <key>` by default, or the header
named by `--auth-header`. Header values may use `$ENV_VAR` or `${ENV_VAR}`;
missing variables are reported at request time. Secret header values are
redacted by `providers show`.

### Discovery

```bash
flintcode providers discover openrouter
flintcode providers discover --all
```

Discovery calls `GET <base-url>/models` (or the path set with
`--discovery-path`), merges the result into the provider, and keeps existing
aliases and manual metadata. Discovery failures are reported with the upstream
status and a redacted body. A provider that returns no model list can still be
used with manual models.

### Test

```bash
flintcode providers test openrouter
flintcode providers test openrouter --chat
flintcode providers test openrouter --chat --json
```

`--chat` sends a tiny non-streaming completion using the provider's default
model. Testing does not print the API key. Testing also updates the discovered
model list.

## Select a model

```bash
flintcode use openrouter/qwen/qwen3.5-plus-02-15
flintcode -m flintcode/openrouter/qwen/qwen3.5-plus-02-15 -p "Hello"
flintcode models --provider flintcode
```

`use` writes `defaults.provider = "flintcode"` and
`defaults.model = "<provider>/<model>"` in `~/.flintcode/flintcode.json`.
The agent-facing key is therefore `flintcode/<provider>/<model>`. An optional
`:thinking` suffix or `--thinking` sets the reasoning level when the model
supports it.

The TUI `/model` selector also lists the generated `flintcode/*` entries.
Provider changes made from another process require a new session or restart,
because `models.json` is generated at startup.

## Gateway behavior

```
agent (pi ModelRuntime)
   -> http://127.0.0.1:<random>/v1/chat/completions   (per-process random key)
      -> provider base URL + auth/headers
         -> streamed SSE back to the agent
```

- Binds only to `127.0.0.1`, with a random key stored in
  `FLINTCODE_GATEWAY_KEY` for the current process.
- Rewrites the request model to the provider's `upstreamId` and preserves
  tools, tool calls, streaming and usage data.
- Passes custom provider headers; strips the local gateway key and hop-by-hop
  headers.
- Supports keyless upstreams.
- For Nous, refreshes the OAuth token and mints a new agent key on 401, then
  retries once.
- Errors include the provider ID and upstream status; response bodies are
  limited. Credentials are never logged.

Only OpenAI chat-completions endpoints are managed. Anthropic, Bedrock, Google
native protocols, Azure query-string APIs and provider-specific non-chat
features should use pi's native provider extensions instead.

## Examples

```bash
# OpenRouter
flintcode providers add openrouter --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY

# DeepSeek
flintcode providers add deepseek --base-url https://api.deepseek.com/v1 \
  --api-key-env DEEPSEEK_API_KEY

# Groq
flintcode providers add groq --base-url https://api.groq.com/openai/v1 \
  --api-key-env GROQ_API_KEY

# Local Ollama
flintcode providers add ollama --base-url http://127.0.0.1:11434/v1 --no-auth

# LiteLLM / vLLM / LM Studio with a custom header
flintcode providers add litellm --base-url http://127.0.0.1:4000/v1 \
  --no-auth --header "X-Team: local"
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `HTTP 401` on test | Wrong key, env var not exported, or wrong auth scheme |
| `HTTP 404` on discovery | Base URL path is wrong or the server has no `/models`; use `--no-discover --model` |
| `base URL is not a valid URL` | Missing scheme; use `https://...` or `http://127.0.0.1:...` |
| `Unknown managed model` | Run `flintcode providers discover <id>` or add the model manually |
| Model list changes do not appear | Start a new session; the model catalog is generated at bootstrap |
| Second Flintcode process behaves oddly | Both processes rewrite `~/.flintcode/models.json`; use separate `--config-dir` homes |
