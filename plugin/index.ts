import { Plugin } from "@opencode/plugin"

// Toggleable PII masking through the local Kiji service (kiji-pii-flake, port 8788).
//
// `/kiji` toggles, `/kiji on|off` sets, `/kiji status` reports. The state is durable
// across restarts in plugin storage; masking only runs while it is on.
//
// Fail-open by design: when the service is down or slow, the request goes out unchanged.
//
// Single file on purpose: the plugin loader resolves files in the plugins directory as
// entries, so a sibling import is one more thing that can silently drop the plugin.

const BINARY_KEYS = new Set(["data", "media", "base64", "image"])

// Fields that identify the request itself. Masking any of these breaks the call:
// a masked top-level `model` produced "Specified model not found: [REDACTED:...]".
const STRUCTURAL_KEYS = new Set([
  "model",
  "modelID",
  "providerID",
  "provider",
  "variant",
  "agent",
  "id",
  "sessionID",
  "messageID",
  "callID",
  "tool",
  "toolName",
  "name",
  "role",
  "type",
  "mime",
  "filename",
  "filePath",
  "path",
  "directory",
  "worktree",
  "version",
  "baseURL",
])

const MIN_LENGTH = 4
const MAX_LENGTH = 20_000

const ON_WORDS = new Set(["on", "enable", "true", "start"])
const OFF_WORDS = new Set(["off", "disable", "false", "stop"])

export type Command = "on" | "off" | "toggle" | "status"

/** Parse a user message for a Kiji toggle. Returns null when it is not a command. */
export function parseCommand(text: string): Command | null {
  const normalized = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  if (!normalized) return null

  // A markdown command body arrives as "Kiji PII masking: <arg>".
  const template = /^kiji pii masking:[ \t]*(\S*)/.exec(normalized)
  if (template) {
    const argument = template[1]
    if (!argument) return "toggle"
    if (argument === "status") return "status"
    if (argument === "on" || argument === "enable" || argument === "true" || argument === "start") return "on"
    if (argument === "off" || argument === "disable" || argument === "false" || argument === "stop") return "off"
    return null
  }

  if (/^(enable|activate|turn on) kiji\b/.test(normalized)) return "on"
  if (/^(disable|deactivate|turn off|stop) kiji\b/.test(normalized)) return "off"
  if (/^turn kiji (on|off)\b/.test(normalized)) return normalized.includes(" kiji on") ? "on" : "off"
  if (/^kiji status$/.test(normalized)) return "status"

  const parts = normalized.replace(/^\//, "").split(" ")
  if (parts[0] !== "kiji") return null

  const argument = parts[1]
  if (!argument) return "toggle"
  if (argument === "status") return "status"
  if (ON_WORDS.has(argument)) return "on"
  if (OFF_WORDS.has(argument)) return "off"
  // Unknown argument: leave the state alone rather than guessing.
  return null
}

/** Collect every maskable string in a request body, deduplicated and in order. */
export function collectStrings(value: unknown): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node.length >= MIN_LENGTH && node.length <= MAX_LENGTH && !seen.has(node)) {
        seen.add(node)
        found.push(node)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        if (BINARY_KEYS.has(key) || STRUCTURAL_KEYS.has(key)) continue
        walk(item)
      }
    }
  }

  walk(value)
  return found
}

/** Return a copy of the payload with every exact match in `map` replaced. */
export function applyStrings(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => applyStrings(item, map))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = BINARY_KEYS.has(key) || STRUCTURAL_KEYS.has(key) ? item : applyStrings(item, map)
    }
    return out
  }
  return value
}

/**
 * Mask an outgoing JSON request body.
 *
 * `redact` receives the unique strings in the body and returns their replacements, or null
 * when masking is unavailable. Returns the rewritten body, or null when nothing changed.
 */
export async function redactBody(
  body: string,
  redact: (texts: string[]) => Promise<string[] | null>,
): Promise<string | null> {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return null
  }

  const texts = collectStrings(payload)
  if (texts.length === 0) return null

  const redacted = await redact(texts)
  if (!redacted || redacted.length !== texts.length) return null

  const map = new Map<string, string>()
  for (let index = 0; index < texts.length; index += 1) {
    if (redacted[index] !== texts[index]) map.set(texts[index], redacted[index])
  }
  if (map.size === 0) return null

  return JSON.stringify(applyStrings(payload, map))
}

const SERVICE_URL = (process.env.KIJI_PII_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "")
const REQUEST_TIMEOUT_MS = 5_000
const BATCH_SIZE = 200
const MAX_TEXTS = 2_000
const STORAGE_KEY = "kiji.enabled"

let enabled = false

async function redactBatch(texts: string[]): Promise<string[] | null> {
  try {
    const response = await fetch(`${SERVICE_URL}/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { redacted?: unknown }
    const redacted = payload.redacted
    if (!Array.isArray(redacted) || redacted.length !== texts.length) return null
    if (!redacted.every((item) => typeof item === "string")) return null
    return redacted
  } catch {
    return null
  }
}

async function redactTexts(texts: string[]): Promise<string[] | null> {
  if (texts.length > MAX_TEXTS) return null
  const out: string[] = []
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = await redactBatch(texts.slice(start, start + BATCH_SIZE))
    if (!batch) return null
    out.push(...batch)
  }
  return out
}

export default Plugin.define({
  id: "local.kiji-filter",
  async setup(ctx) {
    enabled = (await ctx.storage.get(STORAGE_KEY)) === true

    const setEnabled = async (next: boolean) => {
      enabled = next
      await ctx.storage.set(STORAGE_KEY, enabled)
    }

    const statusLine = () => `Kiji PII masking is ${enabled ? "on" : "off"}.`

    // A real command, so the TUI hands the text to us instead of rejecting an unknown
    // slash command. `execute` runs without a model turn.
    let commandRegistered = false
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "kiji",
          description: "Toggle Kiji PII masking (on|off|status)",
          execute: async ({ sessionID, prompt }) => {
            const argument = (prompt?.text ?? "").trim()
            const command =
              parseCommand(argument) ?? parseCommand(`/kiji ${argument}`) ?? "toggle"

            if (command !== "status") {
              await setEnabled(command === "toggle" ? !enabled : command === "on")
            }

            try {
              await ctx.session.synthetic({ sessionID, text: statusLine() })
            } catch {
              // Feedback is best-effort; the flag change is the part that matters.
            }
          },
        })
      })
      commandRegistered = true
    } catch {
      // Older server without the command API: the prompt hook still handles text commands.
    }

    // Fallback only: a registered command already reports through synthetic.
    if (commandRegistered) return

    // Natural language ("enable kiji", "turn kiji off") arrives as ordinary text.
    await ctx.session.hook("prompt", async (event) => {
      const command = parseCommand(event.prompt.text)
      if (!command) return

      // Status is observational: rewrite the prompt so the model reports it verbatim,
      // exactly like caveman does, and leave the flag alone.
      if (command === "status") {
        event.prompt.text =
          `Report this status verbatim without changing mode: Kiji PII masking: ${enabled ? "on" : "off"}`
        return
      }

      // Mode changes are not rewritten: the model answers the user's message normally.
      await setEnabled(command === "toggle" ? !enabled : command === "on")
    })

    await ctx.session.hook("http.request", async (event) => {
      if (!enabled) return

      const contentType = event.request.headers.get("content-type") ?? ""
      if (!contentType.includes("json")) return

      const body = await event.request.clone().text()
      const masked = await redactBody(body, redactTexts)
      if (!masked) return

      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.request = new Request(event.request, { headers, body: masked })
    })
  },
})
