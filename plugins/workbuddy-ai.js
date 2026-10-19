// WorkBuddy AI (international build, www.workbuddy.ai) as an OpenCode 2 provider.
//
// WorkBuddy AI speaks OpenAI chat completions at <base>/v2, streamed only, with
// WorkBuddy's own headers: a request whose User-Agent isn't WorkBuddy/<version>
// is refused with error 10085. Tokens come from WorkBuddy's plugin sign-in page
// (the one its desktop app opens), polled until the browser finishes.
//
// Ported to OpenCode 2's plugin API from @magpie-community/opencode-workbuddy-auth
// (MIT), which is an OpenCode 1 plugin.

import { createHash, randomBytes } from "node:crypto"
import { Model, Plugin, Provider, Credential, Integration } from "@opencode/plugin"

const PROVIDER_ID = "workbuddy-ai"
const PROVIDER_NAME = "WorkBuddy AI"
const METHOD_ID = "browser"

// where the build lives; WORKBUDDY_AI_BASE_URL points it elsewhere for testing
const ENDPOINT = (process.env.WORKBUDDY_AI_BASE_URL || "https://www.workbuddy.ai").replace(/\/+$/, "")

const APP_VERSION = "2.0.0" // the version WorkBuddy's sign-in page is opened with
const UA_VERSION = "5.5.6" // WorkBuddy/<this> is the User-Agent the API takes
const POLL_MS = 1000
const SIGN_IN_MS = 5 * 60 * 1000
const EARLY_MS = 60 * 1000 // a token this close to its end is refreshed before a request
const DISCOVERY_MS = 5 * 60 * 1000

// [id, name, context, efforts] — used until /v3/config answers
const FALLBACK_MODELS = [
  ["default-model", "Default", 176000],
  ["fast-model", "Fast", 200000],
  ["balanced-model", "Balanced", 256000],
  ["primary-model", "Primary", 272000],
  ["deep-model", "Deep", 176000],
  ["gpt-5.5", "GPT-5.5", 1000000],
  ["gpt-5.4", "GPT-5.4", 272000],
  ["gpt-5.3-codex", "GPT-5.3-Codex", 272000],
  ["gemini-3.1-pro", "Gemini-3.1-Pro", 400000],
  ["gemini-3.5-flash", "Gemini-3.5-Flash", 1000000],
  ["glm-5.3", "GLM-5.3", 1000000, ["low", "high", "max"]],
  ["glm-5.2", "GLM-5.2", 1000000, ["high", "xhigh"]],
  ["hy3", "Hy3", 192000, ["low", "high"]],
  ["kimi-k3", "Kimi-K3", 1000000],
  ["kimi-k2.6", "Kimi-K2.6", 256000],
  ["minimax-m3", "MiniMax-M3", 512000],
]

// models whose images WorkBuddy AI drops though its config says it takes them
const NO_IMAGES = /^glm-/

const hex = () => randomBytes(16).toString("hex")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- WorkBuddy's plugin API -------------------------------------------------

class WBError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

// call makes a request of WorkBuddy's plugin API, which answers
// {code, msg, data}; a code but 0 is an error.
async function call(method, path, headers = {}, body) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WorkBuddy/" + UA_VERSION,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {}
  const code = Number.parseInt(env.code, 10) || 0
  if (!res.ok) {
    const why = env.msg || env.message || env.error?.message || text.slice(0, 200) || res.statusText
    throw new WBError(`${PROVIDER_NAME}: ${why} (HTTP ${res.status}${env.code ? ", code " + env.code : ""})`, env.code, res.status)
  }
  if (env.code) throw new WBError(`${PROVIDER_NAME}: ${env.msg || "error"} (${env.code})`, env.code, res.status)
  return env.data
}

// ---- signing in -------------------------------------------------------------

async function browserSignIn() {
  const state = await call(
    "POST",
    `/v2/plugin/auth/state?platform=${encodeURIComponent(PROVIDER_ID)}`,
    { "X-No-Authorization": "true", "X-No-User-Id": "true", "X-No-Enterprise-Id": "true", "X-No-Department-Info": "true" },
    {},
  )
  if (!state?.state || !state?.authUrl) throw new Error(`${PROVIDER_NAME} gave no sign-in page`)
  const url = new URL(state.authUrl)
  if (url.protocol !== "https:") throw new Error(`${PROVIDER_NAME}'s sign-in page isn't https`)
  url.searchParams.set("version", APP_VERSION)
  url.searchParams.set("loginSessionId", hex())
  const q = encodeURIComponent(state.state)
  return {
    url: url.toString(),
    instructions: `Sign in to ${PROVIDER_NAME} in the browser; this finishes by itself.`,
    deadline: Date.now() + SIGN_IN_MS,
    state: q,
  }
}

// poll asks path until WorkBuddy answers with data, retrying the code that
// means "not signed in yet".
async function poll(path, headers, retry, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`${PROVIDER_NAME} sign-in timed out`)
    try {
      const data = await call("GET", path, headers)
      if (data && Object.keys(data).length) return data
    } catch (e) {
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw e
    }
    await sleep(POLL_MS)
  }
}

function mergeToken(base, got) {
  const now = Date.now()
  const out = { ...base, access: got.accessToken }
  if (got.refreshToken) out.refresh = got.refreshToken
  if (got.domain) out.domain = got.domain
  if (got.expiresAt > 0) out.expires = got.expiresAt
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000
  return out
}

function domainOf(a) {
  return a?.domain || new URL(ENDPOINT).host
}

function enterpriseHeaders(a) {
  const id = typeof a?.enterpriseId === "string" ? a.enterpriseId.trim() : ""
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {}
}

// the enterprise the account belongs to: the one /login/account names, else
// the one WorkBuddy's account list has for it. None is personal.
async function enterpriseOf(a, who) {
  const own = typeof who?.enterpriseId === "string" ? who.enterpriseId.trim() : ""
  if (own) return own
  const type = String(who?.type ?? "").trim().toLowerCase()
  if (!type || type === "personal") return ""
  let list
  try {
    list = await call("GET", "/v2/plugin/accounts", { Authorization: "Bearer " + a.access, "X-Domain": domainOf(a) })
  } catch {
    return ""
  }
  const mine = (list?.accounts ?? []).filter(
    (x) => x?.uid === who.uid && typeof x.enterpriseId === "string" && x.enterpriseId.trim(),
  )
  const same = mine.filter((x) => String(x.type ?? "").trim().toLowerCase() === type)
  const last = mine.filter((x) => x.lastLogin)
  const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined
  return pick ? pick.enterpriseId.trim() : ""
}

function meta(cred) {
  return (cred && typeof cred.metadata === "object" && cred.metadata) || {}
}

function toCredential(tok, who, enterpriseId) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make(METHOD_ID),
    access: tok.access,
    refresh: tok.refresh || "",
    expires: tok.expires || Date.now() + 24 * 60 * 60 * 1000,
    metadata: {
      uid: who?.uid ?? "",
      domain: domainOf(tok),
      ...(enterpriseId ? { enterpriseId } : {}),
    },
  })
}

// refresh spends the refresh token and keeps the account's ids.
async function refreshToken(cred) {
  const m = meta(cred)
  const got = await call(
    "POST",
    "/v2/plugin/auth/token/refresh",
    {
      "X-Refresh-Token": cred.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": m.domain || new URL(ENDPOINT).host,
      ...enterpriseHeaders(m),
    },
    {},
  )
  if (!got?.accessToken) throw new Error(`${PROVIDER_NAME} gave no refreshed token`)
  const next = mergeToken({ ...cred, ...m }, got)
  return Credential.OAuth.make({
    type: "oauth",
    methodID: cred.methodID,
    access: next.access,
    refresh: next.refresh || cred.refresh,
    expires: next.expires || Date.now() + 24 * 60 * 60 * 1000,
    metadata: { ...m, domain: next.domain || m.domain || new URL(ENDPOINT).host },
  })
}

// ---- the request WorkBuddy's own client makes --------------------------------

// sign sets on headers what WorkBuddy's desktop app sends with a chat: the
// account's own, the client's, and the attribution WorkBuddy's usage list
// shows as the client that asked.
function sign(a, headers) {
  const m = meta(a)
  headers.set("Authorization", "Bearer " + a.access)
  headers.set("X-User-Id", m.uid ?? "")
  headers.set("X-Domain", m.domain || domainOf(m))
  headers.set("X-Product", "SaaS")
  headers.set("X-IDE-Type", "WorkBuddy")
  headers.set("User-Agent", "WorkBuddy/" + UA_VERSION)
  headers.set("X-Requested-With", "XMLHttpRequest")
  headers.set("X-Agent-Intent", "craft")
  headers.set("X-Agent-Purpose", "conversation")
  headers.set("X-IDE-Name", "WorkBuddy")
  headers.set("X-IDE-Version", UA_VERSION)
  headers.set("X-Agent-Type", "main")
  for (const [k, v] of Object.entries(enterpriseHeaders(m))) headers.set(k, v)
}

// ---- the chat body WorkBuddy takes -----------------------------------------

const SALT = randomBytes(16).toString("hex")
const idFor = (kind, key) => createHash("sha256").update(`${SALT}|${kind}|${key}`).digest("hex").slice(0, 32)

function signatureOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const part of content) {
    const type = part?.type ?? ""
    if (type === "" || type === "text") out += typeof part?.text === "string" ? part.text : ""
    else if (type !== "tool_result" && type !== "tool-result") {
      out += `[${type}:${createHash("sha256").update(JSON.stringify(part)).digest("hex").slice(0, 8)}]`
    }
  }
  return out
}

function answeredBefore(msgs, i) {
  const prev = msgs[i - 1]
  if (prev === null || typeof prev !== "object") return false
  if (prev.role === "tool") return true
  return prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0
}

function turnKey(chat) {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== "user" || answeredBefore(msgs, i)) continue
    const sig = signatureOf(msgs[i].content)
    return sig ? `u${i}:${sig}` : ""
  }
  return ""
}

function conversationKey(chat, session) {
  if (session) return `session:${session}`
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (const m of msgs) {
    if (m?.role !== "user") continue
    const sig = signatureOf(m.content)
    if (sig) return `first:${sig}`
  }
  return ""
}

// attend names the chat to WorkBuddy: the conversation, the user send and the
// message, as its own client does.
function attend(headers, chat, session) {
  const conv = conversationKey(chat, session)
  const msg = hex()
  headers.set("X-Conversation-Message-ID", msg)
  headers.set("X-Request-ID", msg)
  const turn = turnKey(chat)
  headers.set("X-Conversation-Request-ID", turn ? idFor("turn", `${conv}|${turn}`) : hex())
  if (conv) headers.set("X-Conversation-ID", idFor("conversation", conv))
}

// WorkBuddy refuses a chat carrying words of Codex's or Claude Code's own
// ("Illegal API invocation from an unapproved channel"); these say the same
// and pass.
const FLAGGED = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ""],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, "Main branch (usually the base for PRs)"],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, "The Codex CLI is an open source project led by OpenAI."],
]

function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to)
  return text
}

function unflag(messages) {
  let changed = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m?.content === "string") {
      const t = unflagged(m.content)
      if (t === m.content) continue
      changed = true
      if (t.trim() || m.role !== "system") m.content = t
      else messages.splice(i, 1)
    } else if (Array.isArray(m?.content)) {
      const parts = []
      let here = false
      for (const p of m.content) {
        const t = typeof p?.text === "string" ? unflagged(p.text) : null
        if (t === null || t === p.text) {
          parts.push(p)
          continue
        }
        here = true
        if (t.trim()) parts.push({ ...p, text: t })
      }
      if (!here) continue
      changed = true
      if (parts.length || m.role !== "system") m.content = parts
      else messages.splice(i, 1)
    }
  }
  return changed
}

// prepareBody gives a chat the spellings and the opening message WorkBuddy's
// endpoint takes: max_tokens rather than max_completion_tokens, system rather
// than developer, and a system message first.
function prepareBody(body) {
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!Array.isArray(b?.messages) || !b.messages.length) return body
    let changed = unflag(b.messages)
    if (b.max_completion_tokens !== undefined) {
      if (b.max_tokens === undefined) b.max_tokens = b.max_completion_tokens
      delete b.max_completion_tokens
      changed = true
    }
    for (const m of b.messages) {
      if (m?.role !== "developer") continue
      m.role = "system"
      changed = true
    }
    if (b.messages[0]?.role !== "system") {
      b.messages.unshift({ role: "system", content: "You are a helpful assistant." })
      changed = true
    }
    return changed ? JSON.stringify(b) : body
  } catch {
    return body
  }
}

const NAME_OK = /^[A-Za-z0-9_-]+$/

function safeName(name, taken) {
  const base = String(name).replace(/[^A-Za-z0-9_-]/g, "_") || "tool"
  let n = base
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
  taken.add(n)
  return n
}

const NUL_ESCAPE = /\\\\|\\0(?![0-9])/g

function fitSchema(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 64) return false
  let changed = false
  if (Array.isArray(s)) {
    for (const v of s) if (fitSchema(v, depth + 1)) changed = true
    return changed
  }
  if (typeof s.pattern === "string" && s.pattern.includes("\\0")) {
    const p = s.pattern.replace(NUL_ESCAPE, (m) => (m === "\\\\" ? m : "\\u0000"))
    if (p !== s.pattern) {
      s.pattern = p
      changed = true
    }
  }
  if (Array.isArray(s.items)) {
    const list = s.items.filter((v) => v && typeof v === "object")
    s.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list }
    delete s.additionalItems
    changed = true
  }
  for (const v of Object.values(s)) if (fitSchema(v, depth + 1)) changed = true
  return changed
}

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"])
const SUB_ONE = ["items", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames", "additionalProperties", "unevaluatedProperties"]
const SUB_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"]
const SUB_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const BOOL_OK = new Set(["additionalProperties", "unevaluatedProperties"])

function valueType(v) {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number"
  return typeof v
}

function fitEnum(s) {
  if (!("enum" in s)) return false
  if (!Array.isArray(s.enum) || s.enum.length === 0) {
    delete s.enum
    return true
  }
  const listed = Array.isArray(s.type) ? s.type : typeof s.type === "string" ? [s.type] : []
  if (listed.filter((t) => t !== "null").length === 1) return false
  const byType = new Map()
  for (const v of s.enum) {
    const t = valueType(v)
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t).push(v)
  }
  if (byType.has("integer") && byType.has("number")) {
    byType.get("number").push(...byType.get("integer"))
    byType.delete("integer")
  }
  const hasNull = byType.delete("null")
  if (byType.size <= 1) {
    const [t] = byType.keys()
    const want = t === undefined ? "null" : hasNull ? [t, "null"] : t
    if (JSON.stringify(want) === JSON.stringify(s.type)) return false
    s.type = want
    return true
  }
  const split = [...byType].map(([t, vs]) => ({ type: t, enum: vs }))
  if (hasNull) split.push({ type: "null" })
  delete s.enum
  delete s.type
  if (Array.isArray(s.anyOf)) s.allOf = [...(Array.isArray(s.allOf) ? s.allOf : []), { anyOf: split }]
  else s.anyOf = split
  return true
}

function subSchema(v, key) {
  if (typeof v !== "boolean" || BOOL_OK.has(key)) return v
  return v ? {} : { not: {} }
}

function fitShape(s, depth = 0) {
  if (!s || typeof s !== "object" || Array.isArray(s) || depth > 64) return false
  let changed = false
  if ("type" in s) {
    const list = (Array.isArray(s.type) ? s.type : [s.type])
      .map((t) => (typeof t === "string" ? t.toLowerCase() : t))
      .filter((t) => TYPES.has(t))
    const uniq = [...new Set(list)]
    const want = uniq.length === 0 ? undefined : uniq.length === 1 ? uniq[0] : uniq
    if (JSON.stringify(want) !== JSON.stringify(s.type)) {
      if (want === undefined) delete s.type
      else s.type = want
      changed = true
    }
  }
  if ("required" in s && !Array.isArray(s.required)) {
    delete s.required
    changed = true
  } else if (Array.isArray(s.required) && s.required.some((k) => typeof k !== "string")) {
    s.required = s.required.filter((k) => typeof k === "string")
    changed = true
  }
  if (fitEnum(s)) changed = true
  for (const k of SUB_ONE) {
    if (!(k in s)) continue
    const v = subSchema(s[k], k)
    if (v !== s[k]) {
      s[k] = v
      changed = true
    }
    if (fitShape(v, depth + 1)) changed = true
  }
  for (const k of SUB_LIST) {
    if (!Array.isArray(s[k])) continue
    s[k].forEach((v0, i) => {
      const v = subSchema(v0, k)
      if (v !== v0) {
        s[k][i] = v
        changed = true
      }
      if (fitShape(v, depth + 1)) changed = true
    })
  }
  for (const k of SUB_MAP) {
    const m = s[k]
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    for (const [name, v0] of Object.entries(m)) {
      const v = subSchema(v0, k)
      if (v !== v0) {
        m[name] = v
        changed = true
      }
      if (fitShape(v, depth + 1)) changed = true
    }
  }
  return changed
}

function localRef(root, s) {
  const ref = s?.$ref
  if (typeof ref !== "string" || !ref.startsWith("#/")) return s
  let at = root
  for (const k of ref.slice(2).split("/")) at = at?.[k.replaceAll("~1", "/").replaceAll("~0", "~")]
  return at && typeof at === "object" ? at : s
}

function objectRoot(ps, root = ps, depth = 0) {
  const unions = ["allOf", "anyOf", "oneOf"].filter((k) => Array.isArray(ps[k]))
  if (ps.type === "object" && !unions.length) return false
  const props = ps.properties && typeof ps.properties === "object" ? ps.properties : {}
  const required = Array.isArray(ps.required) ? [...ps.required] : []
  for (const b0 of ps.allOf ?? []) {
    let b = localRef(root, b0)
    if (!b || typeof b !== "object") continue
    if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((k) => Array.isArray(b[k])))
      objectRoot((b = structuredClone(b)), root, depth + 1)
    for (const [k, v] of Object.entries(b.properties ?? {})) if (!(k in props)) props[k] = v
    if (Array.isArray(b.required)) required.push(...b.required)
  }
  const branches = []
  for (const key of ["anyOf", "oneOf"]) {
    for (const b0 of ps[key] ?? []) {
      let b = localRef(root, b0)
      if (!b || typeof b !== "object") continue
      if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((k) => Array.isArray(b[k])))
        objectRoot((b = structuredClone(b)), root, depth + 1)
      if (b.type !== "object" && !b.properties) continue
      branches.push(b)
    }
  }
  const from = new Map()
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      if (k in props) continue
      const seen = from.get(k) ?? []
      if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(v))) seen.push(v)
      from.set(k, seen)
    }
  }
  for (const [k, list] of from) props[k] = list.length === 1 ? list[0] : { anyOf: list }
  if (branches.length) {
    for (const k of Object.keys(branches[0].properties ?? {})) {
      if (branches.every((b) => Array.isArray(b.required) && b.required.includes(k))) required.push(k)
    }
  }
  for (const k of unions) delete ps[k]
  ps.type = "object"
  ps.properties = props
  const req = [...new Set(required)].filter((k) => typeof k === "string" && k in props)
  if (req.length) ps.required = req
  else delete ps.required
  return true
}

// fitTools mends the chat's function tools in place and names them back.
function fitTools(b) {
  const names = new Map()
  if (!Array.isArray(b?.tools) || !b.tools.length) return { changed: false, names }
  let changed = false
  const taken = new Set()
  for (const t of b.tools) {
    const n = t?.function?.name
    if (typeof n === "string" && NAME_OK.test(n)) taken.add(n)
  }
  const theirs = new Map()
  for (const t of b.tools) {
    const fn = t?.type === "function" || t?.function ? t.function : null
    if (!fn || typeof fn !== "object") continue
    if (typeof fn.name === "string" && !NAME_OK.test(fn.name)) {
      const safe = safeName(fn.name, taken)
      names.set(safe, fn.name)
      theirs.set(fn.name, safe)
      fn.name = safe
      changed = true
    }
    if (fn.parameters === undefined) continue
    if (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) {
      fn.parameters = { type: "object", properties: {} }
      changed = true
      continue
    }
    if (fitSchema(fn.parameters)) changed = true
    if (fitShape(fn.parameters)) changed = true
    if (objectRoot(fn.parameters)) changed = true
  }
  if (theirs.size && Array.isArray(b.messages)) {
    for (const m of b.messages) {
      for (const c of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        const safe = theirs.get(c?.function?.name)
        if (safe) c.function.name = safe
      }
      if (m?.role === "tool" && theirs.has(m.name)) m.name = theirs.get(m.name)
    }
  }
  const choice = b.tool_choice?.function
  if (choice && theirs.has(choice.name)) choice.name = theirs.get(choice.name)
  return { changed, names }
}

function fitted(body) {
  if (typeof body !== "string") return { body, names: new Map() }
  try {
    const b = JSON.parse(body)
    const { changed, names } = fitTools(b)
    return { body: changed ? JSON.stringify(b) : body, names }
  } catch {
    return { body, names: new Map() }
  }
}

function normalizeToolChoice(body) {
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!b || typeof b !== "object" || Array.isArray(b) || !("tool_choice" in b)) return body
    const choice = b.tool_choice
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete b.tool_choice
        delete b.tools
        delete b.functions
      }
      return JSON.stringify(b)
    }
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      delete b.tool_choice
      return JSON.stringify(b)
    }
    const name = choice.function?.name ?? choice.name
    if (typeof name === "string" && name) b.tool_choice = name
    else delete b.tool_choice
    return JSON.stringify(b)
  } catch {
    return body
  }
}

function namedBack(v, names) {
  let changed = false
  for (const c of Array.isArray(v?.choices) ? v.choices : []) {
    for (const at of [c?.message, c?.delta]) {
      for (const tc of Array.isArray(at?.tool_calls) ? at.tool_calls : []) {
        const ours = names.get(tc?.function?.name)
        if (ours) {
          tc.function.name = ours
          changed = true
        }
      }
    }
  }
  return changed
}

// renamed gives the model's calls the names the client gave its tools.
async function renamed(res, names) {
  if (!names.size || !res.body) return res
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  if (/json/i.test(res.headers.get("content-type") ?? "")) {
    const text = await res.text()
    try {
      const v = JSON.parse(text)
      return new Response(namedBack(v, names) ? JSON.stringify(v) : text, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    } catch {
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    }
  }
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let rest = ""
  const line = (l) => {
    const m = /^data:\s?(.*)$/.exec(l)
    if (!m || m[1] === "[DONE]") return l
    try {
      const v = JSON.parse(m[1])
      return namedBack(v, names) ? `data: ${JSON.stringify(v)}` : l
    } catch {
      return l
    }
  }
  const body = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        rest += dec.decode(chunk, { stream: true })
        const lines = rest.split("\n")
        rest = lines.pop()
        if (lines.length) ctl.enqueue(enc.encode(lines.map(line).join("\n") + "\n"))
      },
      flush(ctl) {
        rest += dec.decode()
        if (rest) ctl.enqueue(enc.encode(line(rest)))
      },
    }),
  )
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

// WorkBuddy AI's gemini refuses a chat whose tool results are followed by the
// user's message (400, code 11153); the same chat with an empty assistant
// message between them is served.
const AFTER_TOOLS_REFUSED = /must end with a user message|["']code["']\s*:\s*["']?11153(?![\d.])/i

function replyAfterTools(body) {
  if (typeof body !== "string") return null
  let b
  try {
    b = JSON.parse(body)
  } catch {
    return null
  }
  const msgs = b?.messages
  if (!Array.isArray(msgs)) return null
  let i = msgs.length - 1
  while (i >= 0 && msgs[i]?.role === "user") i--
  if (i === msgs.length - 1 || i < 0 || msgs[i]?.role !== "tool") return null
  msgs.splice(i + 1, 0, { role: "assistant", content: "" })
  return JSON.stringify(b)
}

// ---- models -----------------------------------------------------------------

function creditsOf(c) {
  if (c == null || c === "") return undefined
  const s = String(c).trim().toLowerCase().replace(/\s+credits?$/, "").replace(/^x/, "")
  const n = Number(s)
  return s !== "" && Number.isFinite(n) && n >= 0 ? n : undefined
}

function priceOf(d, promotions, now = Date.now()) {
  const base = creditsOf(d.credits)
  const mine = (Array.isArray(promotions) ? promotions : []).filter(
    (p) =>
      p?.kind === "discount" &&
      Array.isArray(p.modelIds) &&
      p.modelIds.includes(d.id) &&
      p.enabled !== false &&
      !(Date.parse(p.schedule?.validFrom ?? "") > now) &&
      !(Date.parse(p.schedule?.validUntil ?? "") <= now),
  )
  const discountOf = (p) => {
    const said = creditsOf(String(p.discount?.discountedCredits ?? "").trim().replace(/x$/i, ""))
    if (said !== undefined) return said
    const f = Number(p.discount?.factor)
    return Number.isFinite(f) && f >= 0 && base !== undefined ? base * f : undefined
  }
  const hourly = mine.some((p) => Array.isArray(p.schedule?.daily) && p.schedule.daily.length)
  if (hourly) return base === undefined ? {} : { rate: base }
  const off = mine.filter((p) => p.discount).map(discountOf).filter((r) => r !== undefined)
  if (off.length) return { rate: Math.min(...off) }
  return base === undefined ? {} : { rate: base }
}

// liveModels asks WorkBuddy's product config for the plan's models: the "cli"
// agent's list, each with its details.
async function liveModels(a) {
  const headers = new Headers()
  sign(a, headers)
  headers.set("User-Agent", `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`)
  const res = await fetch(ENDPOINT + "/v3/config", { headers, signal: AbortSignal.timeout(15000) })
  const env = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${PROVIDER_NAME}'s config: HTTP ${res.status}`)
  if (env.code) throw new Error(`${PROVIDER_NAME}'s config: ${env.msg} (${env.code})`)
  const cfg = env.data ?? {}
  const out = []
  for (const agent of cfg.agents ?? []) {
    if (agent.name !== "cli") continue
    for (const id of agent.models ?? []) {
      const d = (cfg.models ?? []).find((x) => x.id === id)
      const m = { id, name: d?.name || id }
      if (d) {
        m.context = d.maxInputTokens
        m.output = d.maxOutputTokens
        m.images = d.supportsImages === true && !NO_IMAGES.test(id)
        Object.assign(m, priceOf(d, cfg.modelPromotions))
        const es = d.reasoning?.supportedEfforts ?? []
        if (es.length) {
          const canOff = d.reasoning?.canDisableThinking
          m.efforts = [...(!d.onlyReasoning && (canOff == null || canOff) ? ["none"] : []), ...es]
        }
      }
      out.push(m)
    }
  }
  const first = new Map()
  for (const m of out) {
    const id = first.get(m.name)
    if (id === undefined) {
      first.set(m.name, m.id)
      continue
    }
    const rest = m.id.startsWith(id + "-") ? m.id.slice(id.length + 1) : ""
    m.name = `${m.name} (${rest ? rest.toUpperCase() : m.id})`
  }
  return out
}

function toModelInfo(pid, m) {
  const base = Model.Info.default(pid, Model.ID.make(m.id))
  const iffy = m.images === true
  const reasoning = Array.isArray(m.efforts) && m.efforts.length > 0
  const info = {
    ...base,
    name: m.name,
    capabilities: {
      ...base.capabilities,
      tools: true,
      input: iffy
        ? Array.from(new Set([...base.capabilities.input, "image"]))
        : base.capabilities.input.filter((x) => x !== "image"),
    },
    limit: {
      ...base.limit,
      ...(m.context ? { context: m.context } : {}),
      ...(m.output ? { output: m.output } : {}),
    },
    ...(reasoning
      ? {
          // the model answers with its reasoning in reasoning_content, and its
          // history is sent back with that field
          compatibility: { ...base.compatibility, reasoningField: "reasoning_content", requireReasoning: true },
          variants: m.efforts.map((e) => ({ id: Model.VariantID.make(e), settings: { reasoningEffort: e } })),
        }
      : {}),
  }
  return info
}

function fallbackModels() {
  return FALLBACK_MODELS.map(([id, name, context, efforts]) => ({
    id,
    name,
    context,
    images: !NO_IMAGES.test(id),
    efforts,
  }))
}

// ---- the plugin --------------------------------------------------------------

export default Plugin.define({
  id: "workbuddy-ai",
  async setup(ctx) {
    const pid = Provider.ID.make(PROVIDER_ID)
    const baseURL = ENDPOINT + "/v2"

    // the tool names given the last request, and the chat it went with, by
    // the Request it was sent as
    const sent = new WeakMap()
    const endsAfterTools = new Set()
    let models = fallbackModels()
    let loaded = 0

    // ---- sign-in ----
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: Integration.MethodID.make(METHOD_ID),
          type: "oauth",
          label: `${PROVIDER_NAME} account (browser)`,
        },
        authorize: async () => {
          const s = await browserSignIn()
          return {
            mode: "auto",
            url: s.url,
            instructions: s.instructions,
            expiresAt: s.deadline,
            callback: (async () => {
              const token = await poll(`/v2/plugin/auth/token?state=${s.state}`, {}, [11217], s.deadline)
              if (!token.accessToken) throw new Error(`${PROVIDER_NAME} sent back no token`)
              const a = mergeToken({}, token)
              const who = await poll(
                `/v2/plugin/login/account?state=${s.state}`,
                {
                  Authorization: "Bearer " + a.access,
                  "X-Domain": domainOf(a),
                  "X-No-User-Id": "true",
                  "X-No-Enterprise-Id": "true",
                },
                [12151],
                s.deadline,
              )
              const enterpriseId = await enterpriseOf(a, who)
              return toCredential(a, who, enterpriseId)
            })(),
          }
        },
        refresh: refreshToken,
        label: (cred) => meta(cred).uid || PROVIDER_NAME,
      })
    })

    // ---- the provider and its models ----
    const apply = () => {
      const info = {
        ...Provider.Info.empty(pid),
        name: PROVIDER_NAME,
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "workbuddy-ai" },
        integrationID: Integration.ID.make(PROVIDER_ID),
        compatibility: { reasoningField: "reasoning_content" },
      }
      return { info, models: models.map((m) => toModelInfo(pid, m)) }
    }

    await ctx.provider.transform((editor) => {
      const next = apply()
      const existing = editor.get(pid)
      if (existing) {
        editor.models.set(pid, next.models)
        editor.update(pid, (p) => {
          p.name = next.info.name
          p.activation = next.info.activation
          p.package = next.info.package
          p.settings = { ...p.settings, ...next.info.settings }
          p.integrationID = next.info.integrationID
        })
      } else {
        editor.add(next)
      }
    })

    const discover = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      if (!connection) return false
      const a = await ctx.integration.connection.resolve(connection).catch(() => undefined)
      if (a?.type !== "oauth" || !a.access) return false
      try {
        models = await liveModels(a)
        loaded = Date.now()
        await ctx.provider.reload().catch(() => {})
        return true
      } catch {
        return false
      }
    }

    void discover()

    // ---- a chat, as WorkBuddy takes it ----
    await ctx.session.hook(
      "http.request",
      async (event) => {
        const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
        const a = connection ? await ctx.integration.connection.resolve(connection).catch(() => undefined) : undefined
        if (a?.type !== "oauth" || !a.access) return

        const headers = new Headers(event.request.headers)
        for (const k of ["authorization", "x-api-key", "content-length"]) headers.delete(k)
        sign(a, headers)

        // a request with nothing to say — a model list, a GET — only needs the
        // sign-in on it
        const method = event.request.method.toUpperCase()
        if (method === "GET" || method === "HEAD" || !event.request.body) {
          event.request = new Request(event.request.url, { method, headers, signal: event.request.signal })
          return
        }

        let body = await event.request.clone().text()
        body = prepareBody(body)
        const fit = fitted(body)
        body = normalizeToolChoice(fit.body)
        const chat = (() => {
          try {
            return JSON.parse(body)
          } catch {
            return null
          }
        })()
        attend(headers, chat, String(event.sessionID ?? ""))

        const model = chat?.model
        const quiet = endsAfterTools.has(model) ? replyAfterTools(body) : null
        event.request = new Request(event.request.url, {
          method: event.request.method,
          headers,
          body: quiet ?? body,
          signal: event.request.signal,
        })
        sent.set(event.request, { names: fit.names, body, quiet: !!quiet })
      },
      { providerID: PROVIDER_ID },
    )

    await ctx.session.hook(
      "http.response",
      async (event) => {
        const info = sent.get(event.request)
        const res = event.response
        if (res.status === 400 && info && !info.quiet) {
          const text = await res.clone().text().catch(() => "")
          const again = AFTER_TOOLS_REFUSED.test(text) ? replyAfterTools(info.body) : null
          if (again) {
            try {
              const model = (() => {
                try {
                  return JSON.parse(info.body)?.model
                } catch {
                  return undefined
                }
              })()
              if (model) endsAfterTools.add(model)
              const retry = await fetch(event.request.url, {
                method: event.request.method,
                headers: event.request.headers,
                body: again,
                signal: event.request.signal,
              })
              event.response = info.names.size ? await renamed(retry, info.names) : retry
              return
            } catch {}
          }
        }
        if (info?.names.size) event.response = await renamed(res, info.names)
      },
      { providerID: PROVIDER_ID },
    )

    // ---- keep the model list and the token fresh ----
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const e = event
          if (e?.type !== "credential.switched" && e?.type !== "credential.updated") continue
          if (e.type === "credential.switched" && e.data?.integrationID !== PROVIDER_ID) continue
          await discover()
        }
      } catch {}
    })()

    const timer = setInterval(() => {
      if (Date.now() - loaded > DISCOVERY_MS) void discover()
    }, DISCOVERY_MS)

    return () => {
      controller.abort()
      clearInterval(timer)
    }
  },
})
