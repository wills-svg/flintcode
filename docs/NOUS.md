# Nous Portal

Flintcode supports Nous Portal without a separate API key by using its public
OAuth device flow. No token is hardcoded, and no other application's session is
read except the explicitly shared pi/tau credential described below.

## How authentication works

Flintcode uses the same public client flow as the Hermes CLI and the pi Nous
provider:

- Portal: `https://portal.nousresearch.com`
- OAuth client: `hermes-cli`
- Scope: `inference:mint_agent_key`
- Device code: `POST /api/oauth/device/code`
- Polling: `POST /api/oauth/token` with the device-code grant
- Inference key: `POST /api/oauth/agent-key` with the OAuth access token
- Inference: `https://inference-api.nousresearch.com/v1` (OpenAI-compatible)
- Refresh: `POST /api/oauth/token` with the rotating refresh token

The OAuth access token is exchanged for a short-lived inference **agent key**.
When the key or OAuth access expires, Flintcode refreshes the OAuth token and
mints a new agent key. Rotated credentials are saved before they are used.
Verification URLs are restricted to the portal origin; inference base URLs are
restricted to the official Nous hosts.

## Login

```bash
flintcode login nous
```

This prints a verification URL and code, waits for browser approval, mints the
agent key, saves credentials to `~/.flintcode/providers-auth.json` (0600), and
discovers the account's model catalog. If the portal presents a Vercel browser
checkpoint, sign in at the portal in your normal browser and use pi's login
fallback or an inference agent key.

If pi or tau already completed the same Nous sign-in, import it without a new
browser flow:

```bash
flintcode login nous --from-pi
```

Flintcode also imports a valid shared pi/tau Nous credential automatically on
first use (`~/.pi/agent/auth.json`, provider `nous`). This reuse is limited to
that explicit file and never reads other applications' files.

## Status and logout

```bash
flintcode auth status
flintcode auth status --json
flintcode logout nous
```

`logout nous` removes Flintcode's stored copy. A shared pi/tau credential is
left in place and may be reused on the next request; remove it with pi's own
auth tools if you want a global sign-out.

## Models and Hermes

The Nous Portal catalog is discovered after login. Flintcode also keeps a
fallback entry for `Hermes-4-70B`; if the live account catalog exposes Hermes
models under different IDs, those IDs are listed after discovery. Add another
ID manually if needed:

```bash
flintcode models add nous <model-id>
flintcode use nous/<model-id>
```

Availability depends on the Nous account/plan and the current catalog. A free
account may only be offered the free model subset.

## Sharing with pi and tau (side integration)

The pi Nous provider package is installed:

```bash
pi install npm:@ravshansbox/pi-nous
```

It registers a `nous` provider in pi. The same extension path is added to
`~/.tau/tau.json` under `compat.piExtensions`, so Tau loads the provider too.
Both tools list the Nous models:

```bash
pi auth check --provider nous       # not_ready until sign-in
tau models --provider nous
```

To sign in for pi and tau, run the shared helper and approve the displayed URL:

```bash
node /storage/emulated/0/Tools/tau/scripts/nous-login.mjs
```

The helper performs the public device flow, mints the agent key, and writes the
credential to `~/.pi/agent/auth.json` (0600). pi, tau and Flintcode can then use
the same sign-in. It never prints tokens. A copy of the helper is also in
`/storage/emulated/0/Tools/flintcode/scripts/nous-login.mjs`.

## Verification status

- OAuth login, refresh, key minting, rotation and pi-credential import are
  covered by automated tests with mocked Nous services.
- Real device-code requests were issued successfully, but the code expired
  before browser approval. **Live Nous inference has not been verified.**
- pi/tau list the 28 fallback Nous models; `pi auth check --provider nous`
  correctly reports `not_ready` while no sign-in exists.
- No claim of a working live Nous request should be made until a device-flow
  approval completes and a real completion is exercised.

## Security, terms and limitations

- This is a public OAuth device flow, not an API-key bypass. It requires the
  account holder to approve the code in a browser.
- The `hermes-cli` client ID is the public client used by the Hermes CLI and the
  existing pi/Magpie integrations. Confirm Nous Portal's terms for third-party
  clients before relying on it in production. A custom/registered OAuth client
  ID is not exposed by the current CLI; that would require a source change and
  a matching refresh flow.
- Enterprise VPC inference hosts are not enabled by the managed provider
  validation; the official inference/welcome hosts are allowed.
- The browser checkpoint path and paid-plan model access depend on the Nous
  account. They cannot be resolved by the CLI.
