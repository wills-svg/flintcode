// Nous Portal device-code login for pi and tau.
//
// The pi Nous provider (@ravshansbox/pi-nous) stores its credentials in
// ~/.pi/agent/auth.json. This helper performs the same public device flow and
// mints the inference agent key, so both pi and tau can use one sign-in.
// It never prints tokens.
import { readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PORTAL = "https://portal.nousresearch.com"
const INFERENCE = "https://inference-api.nousresearch.com/v1"
const CLIENT_ID = "hermes-cli"
const SCOPE = "inference:mint_agent_key"
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json")
const now = () => Date.now()
const text = (value) => (typeof value === "string" ? value.trim() : "")

async function request(path, init = {}, timeoutMs = 20_000) {
  const response = await fetch(PORTAL + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.text()
  let json
  try {
    json = JSON.parse(body)
  } catch {}
  return { response, body, json }
}

async function deviceCode() {
  const { response, body, json } = await request("/api/oauth/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  })
  if (!response.ok || !json || !text(json.device_code) || !text(json.user_code)) {
    const hint = /vercel|challenge|html/i.test(body) || response.status === 403
      ? "The portal returned a browser checkpoint. Open https://portal.nousresearch.com/login in your normal browser, sign in, and use pi's /login fallback to paste an inference agent key."
      : "The Nous Portal device-code endpoint did not return a usable response."
    throw new Error(`${hint} (HTTP ${response.status})`)
  }
  return json
}

async function pollToken(device) {
  const deadline = now() + Math.min(Number(device.expires_in) * 1000, 30 * 60 * 1000)
  let interval = Math.max(1, Number(device.interval) || 5)
  for (;;) {
    if (now() >= deadline) throw new Error("Nous device code expired; run the login again.")
    await new Promise((resolve) => setTimeout(resolve, interval * 1000))
    if (now() >= deadline) throw new Error("Nous device code expired; run the login again.")
    let answer
    try {
      answer = await request("/api/oauth/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLIENT_ID,
          device_code: device.device_code,
        }).toString(),
      })
    } catch (error) {
      interval = Math.min(30, interval * 2)
      process.stderr.write(`nous-login: token endpoint unavailable (${error instanceof Error ? error.message : error}); retrying\n`)
      continue
    }
    const { response, body, json } = answer
    if (response.ok && json && text(json.access_token)) return json
    const code = text(json?.error)
    if (code === "authorization_pending") {
      interval = Math.max(1, Number(device.interval) || interval)
      continue
    }
    if (code === "slow_down") {
      interval = Math.min(30, interval + 5)
      continue
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      interval = Math.min(30, interval * 2)
      continue
    }
    throw new Error(`Nous authorization failed: ${code || `HTTP ${response.status}`}`)
  }
}

async function mintAgentKey(accessToken) {
  const { response, body, json } = await request("/api/oauth/agent-key", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ min_ttl_seconds: 1800 }),
  })
  if (!response.ok || !json || !text(json.api_key)) {
    throw new Error(`Nous agent-key mint failed (HTTP ${response.status}); credentials were not written`)
  }
  return json
}

async function optionalFreeTier(accessToken) {
  try {
    const response = await fetch(PORTAL + "/api/oauth/account", {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const account = await response.json()
    const charge = account?.subscription?.monthly_charge
    if (charge === undefined || charge === null) return undefined
    return Number(charge) <= 0
  } catch {
    return undefined
  }
}

function writeAuth(credentials) {
  const dir = join(homedir(), ".pi", "agent")
  mkdirSync(dir, { recursive: true })
  const current = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {}
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("pi auth.json is not a JSON object")
  if (existsSync(AUTH_FILE)) copyFileSync(AUTH_FILE, `${AUTH_FILE}.bak-nous-${Date.now()}`)
  const next = { ...current, nous: credentials }
  const temporary = `${AUTH_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, AUTH_FILE)
}

async function main() {
  if (process.env.NOUS_API_KEY?.trim()) {
    throw new Error("NOUS_API_KEY is set; pi will use it directly, so no login is needed.")
  }
  const device = await deviceCode()
  const url = text(device.verification_uri_complete) || text(device.verification_uri)
  if (!url) throw new Error("Nous did not return a verification URL")
  const parsed = new URL(url)
  if (parsed.origin !== PORTAL) throw new Error("Nous returned a verification URL outside the portal; refusing it.")
  process.stdout.write(`\nOpen this URL in your browser and approve the Nous Portal sign-in:\n\n  ${url}\n\n`)
  process.stdout.write(`Verification code: ${device.user_code}\n`)
  process.stdout.write("Waiting for authorization...\n")
  const token = await pollToken(device)
  const oauthExpires = now() + (Number(token.expires_in) || 3600) * 1000
  const agent = await mintAgentKey(token.access_token)
  const freeTier = await optionalFreeTier(token.access_token)
  const agentExpiresAt = text(agent.expires_at)
  const credentials = {
    type: "oauth",
    access: agent.api_key,
    refresh: token.refresh_token || "",
    expires: oauthExpires,
    enterpriseUrl: INFERENCE,
    metadata: {
      refreshToken: token.refresh_token || "",
      tokenType: token.token_type || "Bearer",
      scope: token.scope || SCOPE,
      oauthAccessToken: token.access_token,
      oauthAccessExpiresAt: oauthExpires,
      agentKey: agent.api_key,
      ...(agentExpiresAt ? { agentKeyExpiresAt: agentExpiresAt } : {}),
      ...(agent.key_id ? { keyId: agent.key_id } : {}),
      ...(freeTier === undefined ? {} : { freeTier, freeTierCheckedAt: now() }),
    },
  }
  writeAuth(credentials)
  const until = agentExpiresAt ? ` Agent key valid until ${agentExpiresAt}.` : ""
  process.stdout.write(`\nSigned in to Nous Portal. Wrote ${AUTH_FILE} (0600).${until}\n`)
  process.stdout.write("Try: pi auth check --provider nous   and   tau models --provider nous\n")
}

main().catch((error) => {
  process.stderr.write(`nous-login: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
