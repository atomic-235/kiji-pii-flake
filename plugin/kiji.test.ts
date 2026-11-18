import { describe, expect, mock, test } from "bun:test"

// The plugin imports the opencode SDK; stub it so the pure logic can be tested standalone.
mock.module("@opencode/plugin", () => ({ Plugin: { define: (plugin: unknown) => plugin } }))

const { applyStrings, collectStrings, parseCommand, redactBody } = await import("./index.ts")

describe("parseCommand", () => {
  test("bare command toggles", () => {
    expect(parseCommand("/kiji")).toBe("toggle")
    expect(parseCommand("kiji")).toBe("toggle")
    expect(parseCommand("  /kiji  ")).toBe("toggle")
  })

  test("explicit on/off", () => {
    expect(parseCommand("/kiji on")).toBe("on")
    expect(parseCommand("/kiji OFF")).toBe("off")
    expect(parseCommand("/kiji enable")).toBe("on")
    expect(parseCommand("/kiji disable")).toBe("off")
    expect(parseCommand("kiji on")).toBe("on")
    expect(parseCommand("kiji off")).toBe("off")
  })

  test("status", () => {
    expect(parseCommand("/kiji status")).toBe("status")
    expect(parseCommand("kiji status")).toBe("status")
  })

  test("natural language toggles", () => {
    expect(parseCommand("enable kiji")).toBe("on")
    expect(parseCommand("turn on kiji")).toBe("on")
    expect(parseCommand("turn kiji off")).toBe("off")
    expect(parseCommand("disable kiji")).toBe("off")
  })

  test("extra words after the argument are ignored", () => {
    expect(parseCommand("/kiji on now")).toBe("on")
  })

  test("unknown arguments leave the state alone", () => {
    expect(parseCommand("/kiji maybe")).toBeNull()
    expect(parseCommand("/kiji onn")).toBeNull()
  })

  test("unrelated text is not a command", () => {
    expect(parseCommand("")).toBeNull()
    expect(parseCommand("hello")).toBeNull()
    expect(parseCommand("the kijiji listing")).toBeNull()
    expect(parseCommand("/compact")).toBeNull()
  })
})

describe("collectStrings", () => {
  test("collects message content and skips metadata", () => {
    const payload = {
      model: "deepseek-v4-1-flash-1017",
      providerID: "venice",
      messages: [{ role: "user", content: "mail me at a@b.com" }],
    }
    expect(collectStrings(payload)).toEqual(["mail me at a@b.com"])
  })

  test("skips binary payloads", () => {
    const payload = { messages: [{ content: "hello" }], data: "AAAA", image: "base64", media: "x" }
    expect(collectStrings(payload)).toEqual(["hello"])
  })

  test("deduplicates while preserving order", () => {
    const payload = { messages: [{ content: "same" }, { content: "same" }, { content: "other" }] }
    expect(collectStrings(payload)).toEqual(["same", "other"])
  })

  test("ignores short and oversized strings", () => {
    const payload = { messages: [{ content: "abc" }, { content: "x".repeat(20_001) }] }
    expect(collectStrings(payload)).toEqual([])
  })
})

describe("applyStrings", () => {
  test("replaces exact matches and leaves structure intact", () => {
    const payload = { model: "m", messages: [{ role: "user", content: "call a@b.com" }] }
    const map = new Map([["call a@b.com", "call [REDACTED:EMAIL]"]])
    expect(applyStrings(payload, map)).toEqual({
      model: "m",
      messages: [{ role: "user", content: "call [REDACTED:EMAIL]" }],
    })
  })

  test("does not modify the input", () => {
    const payload = { messages: [{ content: "a@b.com" }] }
    const map = new Map([["a@b.com", "[REDACTED:EMAIL]"]])
    applyStrings(payload, map)
    expect(payload.messages[0].content).toBe("a@b.com")
  })
})

describe("redactBody", () => {
  const body = JSON.stringify({ model: "m", messages: [{ content: "mail a@b.com" }] })

  test("returns rewritten body when the service masks something", async () => {
    const out = await redactBody(body, async (texts) => texts.map((t) => t.replace("a@b.com", "[REDACTED:EMAIL]")))
    expect(out).not.toBeNull()
    expect(JSON.parse(out!)).toEqual({ model: "m", messages: [{ content: "mail [REDACTED:EMAIL]" }] })
  })

  test("returns null when nothing changes", async () => {
    expect(await redactBody(body, async (texts) => texts)).toBeNull()
  })

  test("returns null when the service fails", async () => {
    expect(await redactBody(body, async () => null)).toBeNull()
  })

  test("returns null for non-JSON or empty-string bodies", async () => {
    expect(await redactBody("not json", async (texts) => texts)).toBeNull()
    expect(await redactBody(JSON.stringify({ model: "m" }), async (texts) => texts)).toBeNull()
  })

  test("never touches structural fields even if the service returns a mapping", async () => {
    const out = await redactBody(body, async (texts) => texts.map(() => "CHANGED"))
    expect(JSON.parse(out!).model).toBe("m")
  })
})
