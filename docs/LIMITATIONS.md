# Known limitations and investigation record

## QoderCLI cannot be forked as source

Verified on 2026-10-25/26 with the installed `@qoder-ai/qodercli` 1.1.78:

- The package is Apache-2.0, but it ships only a 35 MB minified/obfuscated
  `bundle/qodercli.js`; there are no source maps or readable modules.
- The QoderAI GitHub organization has no `qodercli` source repository. The npm
  package has no `repository` field.
- Therefore a maintainable source fork, provider manager and plugin surface
  cannot be built from QoderCLI itself. Patching the bundle is possible in
  principle but would be reverse engineering, not a maintainable fork.

## The Qoder runtime cannot host arbitrary providers

The official Qoder Agent SDK exposes a host `resolveModel` callback and a
`CustomModel` wire shape with `provider`, `api_key`, `model`, `url` and
`style`. I exercised that path with a real SDK query and a local
OpenAI-compatible mock:

- The Qoder CLI accepted the model-policy callback but sent the custom model to
  its own server:
  `POST https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`
  with `custom_model: {provider, model, parameters.api_key}`.
- The server returned:
  `{"code":"100400","errMessage":"Failed to generate custom pool"}`.
- No request ever reached the local mock. BYOK/custom models are dispatched by
  Qoder's server against a curated catalog, not by the local CLI, so a local
  Nous or arbitrary OpenAI-compatible endpoint cannot be used through the
  supported Qoder path.
- Qoder's documentation also describes Custom Models as a curated,
  account/plan-gated catalog with a warning not to hand-edit BYOK settings.

Consequently Flintcode is a fork of the MIT Tau harness (which composes pi),
not of QoderCLI. Qoder-specific cloud, sites and enterprise features are not
part of this project. This is the main requirement that remains blocked.

## Managed provider limitations

- OpenAI-compatible chat completions only. Anthropic, Bedrock, Google native
  protocols, Azure's query-string APIs and provider-specific non-chat features
  are not translated by the gateway. Use pi native provider extensions for
  those.
- The gateway is local and per-process. It rewrites
  `~/.flintcode/models.json` at startup, so concurrent Flintcode processes on
  one home can invalidate each other's model catalog/port. Use separate
  `--config-dir` homes or one process per home.
- Custom header values and API keys are secrets; `providers show` redacts header
  values, but plugins or local filesystem access can still read the credential
  file.
- Cost metadata for managed models is zero, so the UI may label paid models as
  free. Set pricing upstream in pi if this matters.
- Model context defaults to 128k when discovery does not report a context
  window.
- The managed gateway is not a sandbox and does not validate provider response
  semantics beyond HTTP status; upstream errors are surfaced to the agent.

## Nous Portal limitations

- Device-flow approval, account plan, free-tier model access and Vercel browser
  checkpoints are controlled by Nous Portal.
- The public `hermes-cli` OAuth client is reused, matching the existing Hermes
  CLI/pi/Magpie integrations. Confirm Nous's terms for third-party clients. A
  custom/registered OAuth client ID is not exposed by the current CLI.
- Enterprise VPC inference hosts are not supported by the managed provider
  validation (official inference/welcome hosts only).
- Live login was not completed in this session. Real device codes were issued
  but expired before browser approval. Automated tests mock the login, refresh,
  agent-key mint and pi-credential import. No live Nous inference is claimed.
- Hermes model availability depends on the live Nous catalog; the fallback model
  is `Hermes-4-70B`, but a different account may expose different IDs.

## Plugin limitations

- Flintcode plugins use pi's `ExtensionAPI`, not OpenCode's plugin API. They
  are functionally similar but not drop-in compatible.
- Plugins execute with full process permissions. There is no sandbox or
  capability restriction.
- Plugin packs support extension entry points. MCP servers and skills have
  their own commands; a pack is not a complete replacement for OpenCode's
  plugin package manager.
- Skills are copied into `~/.flintcode/skills`; there is no per-project skill
  installation command yet.

## Platform and verification

- Tested on Termux Android aarch64 with Node 26.12.1, npm and the pi 1.3.0
  libraries. Source lives on FUSE `/storage` (noexec, no symlinks); state is on
  ext4 under `~/.flintcode`.
- Windows is untested. macOS/Linux should work with Node >= 22.19, but were not
  exercised here.
- `npm test` runs 57 unit tests and passes. A separate live E2E run drove a real
  agent query through Flintcode's gateway to a local OpenAI-compatible mock and
  received `MOCK_OK`; the upstream logged `model=mock-1`, the provider key and
  24 tool schemas.
- Live tests against paid third-party providers were not run because no keys
  were available.
- The pi/tau Nous extension is installed and Tau lists 28 Nous models.
  `pi auth check --provider nous` is `not_ready` until the device flow is
  approved.

## Unresolved items

1. A live Nous Portal sign-in and one real inference request.
2. A source-available QoderCLI fork (blocked by upstream distribution).
3. Managed Anthropic/Bedrock/Google adapters (use pi native providers).
4. Multi-process gateway coordination and a shared model catalog.
5. OpenCode plugin API compatibility (not attempted; pi ExtensionAPI is used).
