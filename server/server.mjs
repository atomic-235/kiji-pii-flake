#!/usr/bin/env node
import fs from "node:fs"
import http from "node:http"
import path from "node:path"

import { Tokenizer } from "@huggingface/tokenizers"
import ort from "onnxruntime-node"

const MODEL_DIR =
  process.env.KIJI_MODEL_DIR ?? path.join(path.dirname(new URL(import.meta.url).pathname), "model")
const HOST = process.env.KIJI_HOST ?? "127.0.0.1"
const PORT = Number(process.env.KIJI_PORT ?? 8788)
const THREADS = Number(process.env.KIJI_THREADS ?? 1)
const MAX_BODY = 16 * 1024 * 1024
const MAX_TEXTS = 2000
const TIMEOUT_MS = Number(process.env.KIJI_REQUEST_TIMEOUT_MS ?? 15_000)
const SEPARATOR = "\n\n"

const labels = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "label_mappings.json"), "utf8")).pii.label2id
const id2label = Object.fromEntries(Object.entries(labels).map(([name, id]) => [id, name]))
const tokenizer = new Tokenizer(
  JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "tokenizer.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "tokenizer_config.json"), "utf8")),
)

const session = await ort.InferenceSession.create(path.join(MODEL_DIR, "model_quantized.onnx"), {
  executionProviders: ["cpu"],
  intraOpNumThreads: THREADS,
  interOpNumThreads: 1,
  extra: {
    session: {
      intra_op: { allow_spinning: "0" },
      inter_op: { allow_spinning: "0" },
    },
  },
})

let queue = Promise.resolve()

function exclusive(task) {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function withWatchdog(task, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error("kiji-pii: request timed out, exiting for restart")
      process.exit(1)
    }, ms)
    task().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function offsetsFor(text, tokens) {
  let pos = 0
  return tokens.map((token) => {
    if (/^\[.*\]$/.test(token)) return [0, 0]
    const piece = token.replace(/^##/, "")
    if (!piece) return [0, 0]
    const index = text.toLowerCase().indexOf(piece.toLowerCase(), pos)
    if (index < 0) return [0, 0]
    pos = index + piece.length
    return [index, pos]
  })
}

function trimSpan(text, start, end) {
  while (start < end && /["'=:;,\[\]{}<>]/.test(text[start])) start += 1
  while (end > start && /["'=:;,\[\]{}<>]/.test(text[end - 1])) end -= 1
  return [start, end]
}

function benign(text, start, end, label) {
  ;[start, end] = trimSpan(text, start, end)
  if (end - start < 2) return true
  let left = start
  let right = end
  while (left > 0 && /[\w.\-@:/]/.test(text[left - 1])) left -= 1
  while (right < text.length && /[\w.\-@:/]/.test(text[right])) right += 1
  const word = text.slice(left, right)
  if (/^[0-9a-f]{32,64}$/i.test(word)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(word)) return true
  if (/^\d+\.\d+\.\d+/.test(word)) return true
  if (/^(\{\{.*\}\}|<.*>)$/.test(word)) return true
  if (/(os\.environ|os\.getenv|process\.env|getenv)/.test(word)) return true
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(word) && /USERNAME|PASSWORD|SECURITYTOKEN/.test(label)) return true
  if (word === "AKIAIOSFODNN7EXAMPLE") return true
  if (/example\.(com|org|net)/.test(word)) return true
  if (/^left-pad@/.test(word)) return true
  return false
}

function decode(tags, offsets, base, text) {
  const spans = []
  let label = null
  let start = 0
  const emit = (first, last, name) => {
    const a = offsets[base + first]?.[0]
    const b = offsets[base + last]?.[1]
    if (a === undefined || b === undefined || b <= a) return
    const [s, e] = trimSpan(text, a, b)
    if (e > s) spans.push([s, e, name])
  }
  tags.forEach((tagId, index) => {
    const tag = id2label[tagId]
    if (tag === "O") {
      if (label) emit(start, index - 1, label)
      label = null
      return
    }
    const kind = tag[0]
    const name = tag.slice(2)
    if (kind === "B" || label !== name) {
      if (label) emit(start, index - 1, label)
      label = name
      start = index
    }
  })
  if (label) emit(start, tags.length - 1, label)
  return spans
}

async function spansFor(text) {
  const encoding = tokenizer.encode(text)
  const ids = encoding.ids
  const offsets = offsetsFor(text, encoding.tokens)
  const spans = []
  const size = 512
  const step = 448
  for (let base = 0; base < ids.length; base += step) {
    const window = ids.slice(base, base + size)
    if (window.length === 0) break
    const feeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(window.map(BigInt)), [1, window.length]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(window.map(() => 1n)), [1, window.length]),
    }
    const output = await session.run(feeds)
    const logits = output.pii_logits.data
    const classes = output.pii_logits.dims[2]
    const tags = new Array(window.length)
    for (let i = 0; i < window.length; i++) {
      let best = 0
      let bestValue = -Infinity
      for (let c = 0; c < classes; c++) {
        const value = logits[i * classes + c]
        if (value > bestValue) {
          bestValue = value
          best = c
        }
      }
      tags[i] = best
    }
    spans.push(...decode(tags, offsets, base, text))
  }
  const unique = new Map()
  const merged = []
  for (const [a, b, label] of spans.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const prev = merged[merged.length - 1]
    if (prev && prev[2] === label && /^[\s\-().\/]*$/.test(text.slice(prev[1], a))) prev[1] = b
    else merged.push([a, b, label])
  }
  for (const [a, b, label] of merged) {
    if (!benign(text, a, b, label)) unique.set(`${a}:${b}:${label}`, [a, b, label])
  }
  return [...unique.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])
}

function apply(text, spans) {
  const pieces = []
  let cursor = 0
  for (const [start, end, label] of spans) {
    if (start < cursor || end > text.length) continue
    pieces.push(text.slice(cursor, start), `[REDACTED:${label}]`)
    cursor = end
  }
  pieces.push(text.slice(cursor))
  return pieces.join("")
}

async function redact(texts) {
  const out = []
  for (const text of texts) out.push(apply(text, await spansFor(text)))
  return out
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { ok: true, ready: true })
    return
  }
  if (request.method !== "POST" || request.url !== "/redact") {
    send(response, 404, { error: "not found" })
    return
  }
  const chunks = []
  let size = 0
  request.on("data", (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) request.destroy()
    else chunks.push(chunk)
  })
  request.on("end", async () => {
    let texts
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      texts = payload.texts
      if (!Array.isArray(texts) || !texts.every((text) => typeof text === "string"))
        throw new Error("texts must be a list of strings")
      if (texts.length > MAX_TEXTS) throw new Error("too many texts")
    } catch (error) {
      send(response, 400, { error: String(error) })
      return
    }
    try {
      const redacted = await exclusive(() => withWatchdog(() => redact(texts)))
      send(response, 200, { redacted })
    } catch (error) {
      console.error(`kiji-pii: redaction failed: ${error}`)
      send(response, 500, { error: String(error) })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.error(`kiji-pii: listening on ${HOST}:${PORT}`)
})
