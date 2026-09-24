#!/usr/bin/env node
/**
 * AgentVR Cloud API
 * OpenAI / Anthropic compatible client front → official, unmodified Claude Code
 * (the brain host's own Claude login) + AgentVR body MCP.
 *
 * Model:
 *   Local client conversation id (AAAAA) → persistent map → Claude Code session id (BBBB)
 *   Client only sends AAAAA (header / body / OpenAI user). User never handles BBBB.
 *   First turn: claude --session-id BBBB; later: --resume BBBB.
 *   Clients without any conversation id get stateless turns (full history each time).
 *
 * Not a token proxy: this process never reads, forwards or imitates Claude
 * credentials. Every upstream request is made by the real `claude` binary.
 */

import http from "node:http";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = process.env;
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v ?? "").trim());

const PORT = Number(env.AGENTVR_API_PORT || 18888);
/**
 * One or more listen addresses, comma separated. Each is "host" (uses PORT) or
 * "host:port", e.g. "127.0.0.1,127.0.0.1:8080".
 */
const LISTEN = (env.AGENTVR_API_HOST || "127.0.0.1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(entry);
    return m ? { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) } : { host: entry, port: PORT };
  });
const REPO_ROOT = path.dirname(__dirname);
const SESSION_DIR = env.AGENTVR_SESSION_DIR || path.join(REPO_ROOT, "agentvr-session");
const MCP_CONFIG = env.AGENTVR_MCP_CONFIG || path.join(SESSION_DIR, ".mcp.json");
/**
 * What claude sees as its working directory. It defaults to SESSION_DIR so
 * existing transcripts keep resuming; point it at an empty non-git directory
 * for a stricter island. The model has no local tools either way, so this is
 * only what the base prompt's <env> block reports.
 */
const CLAUDE_CWD = env.AGENTVR_CLAUDE_CWD || SESSION_DIR;
/** Resolved on PATH unless pointed somewhere specific. */
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
const TUNNEL_UP = env.AGENTVR_TUNNEL_UP || path.join(REPO_ROOT, "agentvr", "tunnel-up.sh");
const HEALTH_URL = env.AGENTVR_HEALTH_URL || "http://127.0.0.1:18787/healthz";
const KEYS_FILE = env.AGENTVR_KEYS_FILE || path.join(__dirname, "KEYS.txt");
const MODEL_ID = env.AGENTVR_MODEL_ID || "agentvr-claude";
/** Extra model ids advertised in /v1/models. "agentvr-<alias>" runs `claude --model <alias>`. */
const EXTRA_MODELS = (env.AGENTVR_MODELS ?? "agentvr-opus,agentvr-sonnet,agentvr-haiku")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** Claude model for the default id; empty = whatever Claude Code defaults to. */
const DEFAULT_CLAUDE_MODEL = env.AGENTVR_CLAUDE_MODEL || "";
/** Default --effort when the client does not ask for one; empty = Claude Code default. */
const DEFAULT_EFFORT = env.AGENTVR_EFFORT || "";
const CLAUDE_TIMEOUT_MS = Number(env.AGENTVR_CLAUDE_TIMEOUT_MS || 600_000);
/** Max concurrent in-flight Claude turns (across all sessions). */
const MAX_IN_FLIGHT = Number(env.AGENTVR_MAX_IN_FLIGHT || env.AGENTVR_MAX_CONCURRENT || 4);
/** Cap on live conversation mappings; 0 = unlimited (turns are still bounded by MAX_IN_FLIGHT). */
const MAX_SESSIONS = Number(env.AGENTVR_MAX_SESSIONS || 0);
/** Idle after this many ms → session no longer counted as "live" (Claude resume id kept). */
const IDLE_TIMEOUT_MS = Number(env.AGENTVR_IDLE_TIMEOUT_MS || 45 * 60 * 1000);
const SESSIONS_FILE = env.AGENTVR_SESSIONS_FILE || path.join(__dirname, "sessions.json");
/**
 * Built-in Claude Code tools on the brain host, passed to --tools.
 * "" (the default) removes every built-in tool — files, shell, Task, web —
 * so the model can only act through the island's MCP tools. --tools does not
 * affect MCP tools. "default" restores Claude Code's normal local tool set.
 */
const BUILTIN_TOOLS = env.AGENTVR_BUILTIN_TOOLS ?? "";
/**
 * Experimental: full system-prompt replacement file, passed to
 * --system-prompt-file. The default prompt (with its <env> block) stays unless
 * this is set. A replacement must re-teach tool use; evaluate on the brain
 * before trusting it.
 */
const SYSTEM_PROMPT_FILE = env.AGENTVR_SYSTEM_PROMPT_FILE || "";
/** SSE keepalive comment interval; keeps tunnels / reverse proxies from idling out. */
const HEARTBEAT_MS = Number(env.AGENTVR_HEARTBEAT_MS || 15_000);
/** Delay before answering a failed auth attempt (slows online guessing). */
const AUTH_FAIL_DELAY_MS = Number(env.AGENTVR_AUTH_FAIL_DELAY_MS || 1_000);
/** Stream "[tool] name" notes as reasoning so clients show progress. */
const STREAM_TOOL_NOTES = !falsy(env.AGENTVR_STREAM_TOOL_NOTES);
/** Stream Claude's thinking as reasoning_content / thinking blocks. */
const STREAM_THINKING = !falsy(env.AGENTVR_STREAM_THINKING);
/** Skip the body health probe entirely (e.g. brain and body on the same PC). */
const SKIP_TUNNEL = truthy(env.AGENTVR_SKIP_TUNNEL);
const TUNNEL_OK_CACHE_MS = 15_000;
/** Max characters of client history carried into a new / reseeded / stateless turn. */
const MAX_HISTORY_CHARS = Number(env.AGENTVR_MAX_HISTORY_CHARS || 60_000);
/** What to do when a request carries no conversation id: "stateless" or "auto-session". */
const NO_KEY_MODE = (env.AGENTVR_NO_KEY_MODE || "stateless").toLowerCase();
/** Detect regenerate / edit (client history diverged) and reseed a fresh Claude session. */
const DETECT_DIVERGENCE = !falsy(env.AGENTVR_DETECT_REGENERATE);
/** Open WebUI style background tasks ("### Task:" titles, tags, follow-ups). */
const TASK_DETECT = !falsy(env.AGENTVR_TASK_DETECT);
const TASK_MODEL = env.AGENTVR_TASK_MODEL ?? "haiku";
const MAX_BODY_BYTES = Number(env.AGENTVR_MAX_BODY_BYTES || 50_000_000);
/**
 * How long a finished-but-undelivered turn stays cached, so a client whose
 * connection dropped can retry the same message and get the answer for free.
 */
const TURN_CACHE_MS = Number(env.AGENTVR_TURN_CACHE_MS || 10 * 60_000);
/**
 * Streaming responses hold back the 200 until Claude produces something, so
 * failures before that reach the client as a real HTTP status it can retry on.
 * After this long we open the stream anyway and keepalives start.
 */
const SSE_OPEN_MS = Number(env.AGENTVR_SSE_OPEN_MS || 25_000);

/** How the user's computer is referred to in the default note below. */
const BODY_NAME = env.AGENTVR_BODY_NAME || "the user's computer";
/** MCP server name in .mcp.json; it prefixes every tool that acts on that computer. */
const BODY_MCP = env.AGENTVR_BODY_MCP || "komputer_use";

/**
 * Short working note appended to Claude Code's own system prompt. Island voice:
 * it describes exactly one computer and never hints at anything outside it —
 * no launcher, no second machine, no "local vs remote".
 *
 * AGENTVR_SYSTEM_PROMPT replaces it; set it to an empty string for no note at all.
 */
const DEFAULT_WORK_NOTE = `You work on ${BODY_NAME}. Your shell, files, processes and applications are all there, and the mcp__${BODY_MCP}__* tools are how you reach them: run_command for shell commands, the file tools for reading and writing, start_process for anything long-running. Call system_info first if you need the OS, shell, working roots or limits.`;
const BODY_SYSTEM = env.AGENTVR_SYSTEM_PROMPT ?? DEFAULT_WORK_NOTE;

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** @type {Buffer[]} sha256 digests of accepted API keys */
let apiKeyDigests = [];
let authFailures = 0;
let inFlight = 0;
const waitQueue = [];
/** Running claude children, killed on shutdown. */
const activeChildren = new Set();

/** @type {Map<string, SessionRec>} keyed by client_key (AAAAA) */
const sessions = new Map();
/** Reverse: claude_session_id (BBBB) → client_key (AAAAA) for legacy lookups */
const claudeToClient = new Map();
/** Per-session turn serialization (keyed by client_key): tail promise of the queue. */
const sessionLocks = new Map();

/**
 * @typedef {object} SessionRec
 * @property {string} client_key  AAAAA — local client conversation id
 * @property {string} claude_session_id  BBBB — Claude Code --session-id / --resume UUID
 * @property {string} created_at ISO
 * @property {string} last_used_at ISO
 * @property {number} turn_count
 * @property {boolean} started  true after first successful Claude turn
 * @property {boolean} [history_seen]  client has sent assistant messages back to us
 * @property {string} [last_reply_tail]  fingerprint of our last reply, for regenerate detection
 * @property {number} [reseeds]
 * @property {string} [label]
 */

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function httpError(statusCode, message, type) {
  return Object.assign(new Error(message), { statusCode, type });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

function normalizeKey(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (["undefined", "null", "none", "anonymous", "default"].includes(lower)) return null;
  return t.length > 512 ? t.slice(0, 512) : t;
}

// ---------------------------------------------------------------- auth

function digestKey(s) {
  return createHash("sha256").update(String(s), "utf8").digest();
}

async function loadKeys() {
  const text = await fs.readFile(KEYS_FILE, "utf8");
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    let m = t.match(/^(?:api-key|legacy-api-key|work-api-key|home-api-key)\s*[:=]\s*(.+)$/i);
    if (m) {
      keys.add(m[1].trim());
      continue;
    }
    m = t.match(/^key\s*=\s*(.+)$/i);
    if (m) {
      keys.add(m[1].trim());
      continue;
    }
    if (t.startsWith("sk-")) keys.add(t);
  }
  if (keys.size === 0) throw new Error(`no API keys found in ${KEYS_FILE}`);
  const weak = [...keys].filter((k) => k.length < 32).length;
  if (weak) {
    log(`WARNING: ${weak} API key(s) shorter than 32 chars — regenerate with: openssl rand -hex 32`);
  }
  apiKeyDigests = [...keys].map(digestKey);
  log(`loaded ${apiKeyDigests.length} API key(s) from ${path.basename(KEYS_FILE)}`);
}

function extractApiKey(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

/** Constant-time check against every configured key. */
function isValidKey(key) {
  if (!key) return false;
  const d = digestKey(key);
  let ok = false;
  for (const k of apiKeyDigests) {
    if (timingSafeEqual(k, d)) ok = true;
  }
  return ok;
}

function remoteOf(req) {
  const fwd = req.headers["x-forwarded-for"];
  const ip = req.socket?.remoteAddress || "?";
  return typeof fwd === "string" && fwd ? `${ip} (xff ${fwd.split(",")[0].trim()})` : ip;
}

async function requireAuth(req, res) {
  if (isValidKey(extractApiKey(req))) return true;
  authFailures += 1;
  log(`auth failed from ${remoteOf(req)} ${req.method} ${req.url?.split("?")[0]} (total ${authFailures})`);
  await sleep(AUTH_FAIL_DELAY_MS);
  json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
  return false;
}

// ---------------------------------------------------------------- session store

async function loadSessionStore() {
  try {
    const data = JSON.parse(await fs.readFile(SESSIONS_FILE, "utf8"));
    const list = Array.isArray(data.sessions) ? data.sessions : Object.values(data.sessions || {});
    for (const rec of list) {
      const clientKey = normalizeKey(rec.client_key || rec.id || rec.conversation_id);
      if (!clientKey) continue;
      let claudeId = rec.claude_session_id || null;
      if (!claudeId && isUuid(rec.id)) claudeId = rec.id;
      if (!claudeId || !isUuid(claudeId)) claudeId = randomUUID();
      sessions.set(clientKey, {
        client_key: clientKey,
        claude_session_id: claudeId,
        created_at: rec.created_at || new Date().toISOString(),
        last_used_at: rec.last_used_at || rec.created_at || new Date().toISOString(),
        turn_count: Number(rec.turn_count) || 0,
        started: Boolean(rec.started),
        history_seen: Boolean(rec.history_seen),
        last_reply_tail: rec.last_reply_tail || undefined,
        reseeds: Number(rec.reseeds) || 0,
        label: rec.label,
      });
      claudeToClient.set(claudeId, clientKey);
    }
    log(`loaded ${sessions.size} session map(s) from ${SESSIONS_FILE}`);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      log("no sessions store yet — starting empty");
      return;
    }
    log(`warn: failed to load sessions store: ${e.message}`);
  }
}

let saveChain = Promise.resolve();
/** Serialized so concurrent turns never interleave tmp-file writes. */
function saveSessionStore() {
  saveChain = saveChain.catch(() => {}).then(writeSessionStore);
  return saveChain;
}

async function writeSessionStore() {
  const payload = {
    updated_at: new Date().toISOString(),
    sessions: [...sessions.values()].map((rec) => ({
      client_key: rec.client_key,
      conversation_id: rec.client_key,
      claude_session_id: rec.claude_session_id,
      created_at: rec.created_at,
      last_used_at: rec.last_used_at,
      turn_count: rec.turn_count,
      started: rec.started,
      history_seen: rec.history_seen || undefined,
      last_reply_tail: rec.last_reply_tail || undefined,
      reseeds: rec.reseeds || undefined,
      label: rec.label || undefined,
      id: rec.client_key, // legacy alias
    })),
  };
  const tmp = `${SESSIONS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, SESSIONS_FILE);
}

// ---------------------------------------------------------------- http helpers

function json(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function conversationHeaders(plan) {
  if (plan.kind !== "session") return { "X-AgentVR-Mode": plan.task ? "task" : "stateless" };
  const { rec } = plan;
  return {
    "X-Conversation-Id": rec.client_key,
    "X-Chat-Id": rec.client_key,
    "X-AgentVR-Session": rec.client_key,
    "X-AgentVR-Claude-Session": rec.claude_session_id,
    "X-AgentVR-Mode": "session",
  };
}

function sessionHeaders(rec) {
  return conversationHeaders({ kind: "session", rec });
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req, { allowEmpty = false } = {}) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) {
    if (allowEmpty) return {};
    throw httpError(400, "empty body");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw httpError(400, "invalid JSON body");
  }
}

/** AbortSignal that fires when the client goes away before we finish. */
function clientAbortSignal(res) {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

// ---------------------------------------------------------------- body tunnel

let tunnelOkAt = 0;
let tunnelInflight = null;

/** Single-flight: concurrent requests share one probe / one tunnel-up run. */
function ensureTunnel() {
  if (SKIP_TUNNEL) return Promise.resolve();
  if (Date.now() - tunnelOkAt < TUNNEL_OK_CACHE_MS) return Promise.resolve();
  if (!tunnelInflight) {
    tunnelInflight = probeAndReviveTunnel()
      .then(() => {
        tunnelOkAt = Date.now();
      })
      .finally(() => {
        tunnelInflight = null;
      });
  }
  return tunnelInflight;
}

async function probeAndReviveTunnel() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return;
  } catch {
    /* fall through */
  }
  log("tunnel unhealthy — running tunnel-up.sh");
  await new Promise((resolve, reject) => {
    execFile("/bin/bash", [TUNNEL_UP], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`tunnel-up failed: ${err.message}; stderr=${(stderr || "").slice(0, 400)}`));
        return;
      }
      log("tunnel-up ok:", (stdout || "").trim().slice(0, 200));
      resolve();
    });
  });
  const r2 = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2500) });
  if (!r2.ok) throw new Error(`tunnel still unhealthy after revive: HTTP ${r2.status}`);
}

// ---------------------------------------------------------------- message shaping

function roleOf(msg) {
  return String(msg?.role || "").toLowerCase();
}

const ATTACHMENT_TYPES = new Set(["image_url", "image", "file", "document"]);

/**
 * Text of an OpenAI or Anthropic content value. Attachments become short
 * placeholders; the latest user message's attachments are sent separately.
 */
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "image_url" || part.type === "image") return "[image]";
        if (part.type === "file" || part.type === "document") {
          const name = part.file?.filename || part.title;
          return `[file${name ? `: ${name}` : ""}]`;
        }
        if (part.type === "tool_result") return contentToText(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return String(content);
}

/** Text only, without attachment placeholders (for the message we send with blocks). */
function contentTextOnly(content) {
  if (!Array.isArray(content)) return contentToText(content);
  return contentToText(content.filter((p) => !(p && typeof p === "object" && ATTACHMENT_TYPES.has(p.type))));
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || "");
  if (!m) return null;
  return { mediaType: m[1] || "application/octet-stream", base64: Boolean(m[2]), data: m[3] };
}

/** Convert attachments of one message into Anthropic content blocks for Claude Code. */
function extractAttachments(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "image" || part.type === "document") && part.source) {
      blocks.push({ type: part.type, source: part.source, ...(part.title ? { title: part.title } : {}) });
      continue;
    }
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const d = parseDataUrl(url);
      if (d && d.base64) {
        blocks.push({ type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } });
      } else if (/^https?:\/\//i.test(url || "")) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
      continue;
    }
    if (part.type === "file" && part.file) {
      const raw = part.file.file_data || "";
      const d = parseDataUrl(raw);
      const mediaType = d?.mediaType || "application/pdf";
      const data = d ? d.data : raw;
      if (!data) continue;
      const title = part.file.filename ? { title: part.file.filename } : {};
      if (mediaType === "application/pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, ...title });
      } else if (/^image\//.test(mediaType)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      } else {
        const text = d && !d.base64 ? decodeURIComponent(data) : Buffer.from(data, "base64").toString("utf8");
        blocks.push({ type: "text", text: `File ${part.file.filename || ""}:\n${text}` });
      }
    }
  }
  return blocks;
}

function lastIndexOfRole(messages, role, before = messages?.length ?? 0) {
  if (!Array.isArray(messages)) return -1;
  for (let i = Math.min(before, messages.length) - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === role) return i;
  }
  return -1;
}

function latestUserMessage(messages) {
  const i = lastIndexOfRole(messages, "user");
  return i < 0 ? null : messages[i];
}

function latestUserText(messages) {
  const m = latestUserMessage(messages);
  return m ? contentTextOnly(m.content).trim() : "";
}

function collectSystemText(messages, extraSystem) {
  const parts = [];
  if (extraSystem) parts.push(String(extraSystem));
  for (const msg of messages || []) {
    const role = roleOf(msg);
    if (role === "system" || role === "developer") {
      const t = contentToText(msg.content).trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n");
}

function buildSystemPrompt(messages, extraSystem, { body = true } = {}) {
  return [body ? BODY_SYSTEM : "", collectSystemText(messages, extraSystem)].filter(Boolean).join("\n\n");
}

/** History the client sent before its latest user message, as plain text. */
function priorTranscript(messages) {
  const end = lastIndexOfRole(messages, "user");
  if (end <= 0) return "";
  const lines = [];
  for (const msg of messages.slice(0, end)) {
    const role = roleOf(msg);
    if (role !== "user" && role !== "assistant") continue;
    const t = contentToText(msg.content).trim();
    if (t) lines.push(`${role === "user" ? "User" : "Assistant"}: ${t}`);
  }
  let text = lines.join("\n\n");
  if (text.length > MAX_HISTORY_CHARS) {
    text = `[…earlier history truncated…]\n${text.slice(-MAX_HISTORY_CHARS)}`;
  }
  return text;
}

/** withHistory: the Claude side has no memory of this chat yet (new, reseeded, stateless). */
function buildTurnPrompt(messages, withHistory) {
  const hasAttachments = extractAttachments(latestUserMessage(messages)?.content).length > 0;
  const user = latestUserText(messages) || (hasAttachments ? "(see attachment)" : "(empty)");
  if (!withHistory) return user;
  const prior = priorTranscript(messages);
  if (!prior) return user;
  return `Earlier conversation for context:\n\n${prior}\n\n---\n\n${user}`;
}

/** Whitespace-insensitive fingerprint of the end of a reply. */
function replyTail(text) {
  return String(text || "").replace(/\s+/g, "").slice(-160);
}

/**
 * True when the client's view of the conversation no longer matches what the
 * Claude session holds: regenerate, edited message, retried request, branch.
 */
function historyDiverged(rec, messages) {
  const lastUser = lastIndexOfRole(messages, "user");
  if (lastUser < 0) return false;
  const prevAssistant = lastIndexOfRole(messages, "assistant", lastUser);
  if (prevAssistant < 0) {
    // A client that normally sends history now sends none: first message regenerated / edited.
    return Boolean(rec.history_seen);
  }
  if (!rec.last_reply_tail) return false; // legacy record, nothing to compare
  return replyTail(contentToText(messages[prevAssistant].content)) !== rec.last_reply_tail;
}

// ---------------------------------------------------------------- models

function resolveClaudeModel(requested) {
  const id = String(requested || "").trim();
  if (!id || id === MODEL_ID) return DEFAULT_CLAUDE_MODEL;
  const m = /^agentvr-(.+)$/i.exec(id);
  if (m) return m[1];
  if (/^(claude-|opus|sonnet|haiku|fable|mythos)/i.test(id)) return id;
  return DEFAULT_CLAUDE_MODEL; // unknown ids (e.g. a client's built-in "gpt-4o") → default
}

function resolveEffort(body) {
  let e = String(body.reasoning_effort ?? body.effort ?? body.output_config?.effort ?? "")
    .toLowerCase()
    .trim();
  if (e === "minimal" || e === "none") e = "low";
  if (!e && body.thinking?.type === "enabled") {
    const budget = Number(body.thinking.budget_tokens) || 0;
    e = budget >= 32000 ? "max" : budget >= 16000 ? "xhigh" : "high";
  }
  return EFFORT_LEVELS.has(e) ? e : DEFAULT_EFFORT;
}

function modelList() {
  const ids = [MODEL_ID, ...EXTRA_MODELS.filter((m) => m !== MODEL_ID)];
  return ids.map((id) => ({
    id,
    object: "model",
    type: "model",
    created: 1727000000,
    created_at: "2024-09-22T00:00:00Z",
    display_name: id,
    owned_by: "agentvr",
  }));
}

// ---------------------------------------------------------------- sessions

function isLive(rec, now = Date.now()) {
  const last = Date.parse(rec.last_used_at || rec.created_at || 0);
  return Number.isFinite(last) && now - last < IDLE_TIMEOUT_MS;
}

function liveSessionCount(now = Date.now()) {
  let n = 0;
  for (const rec of sessions.values()) if (isLive(rec, now)) n += 1;
  return n;
}

function publicSession(rec) {
  return {
    conversation_id: rec.client_key,
    client_key: rec.client_key,
    id: rec.client_key,
    created_at: rec.created_at,
    last_used_at: rec.last_used_at,
    turn_count: rec.turn_count,
    started: rec.started,
    reseeds: rec.reseeds || 0,
    live: isLive(rec),
    label: rec.label || null,
    claude_session_id: rec.claude_session_id,
  };
}

async function createSession({ clientKey, label, force = false } = {}) {
  const nowIso = new Date().toISOString();
  let key = normalizeKey(clientKey);
  if (key) {
    const existing = findSession(key);
    if (existing) return existing;
  } else {
    key = `auto-${randomUUID()}`;
  }
  if (!force && MAX_SESSIONS > 0 && liveSessionCount() >= MAX_SESSIONS) {
    throw httpError(
      429,
      `max live sessions (${MAX_SESSIONS}) reached; delete a chat mapping or wait for idle timeout (${Math.round(IDLE_TIMEOUT_MS / 60000)}m)`,
      "rate_limit_error"
    );
  }
  const claudeId = randomUUID();
  const rec = {
    client_key: key,
    claude_session_id: claudeId,
    created_at: nowIso,
    last_used_at: nowIso,
    turn_count: 0,
    started: false,
    label: label || undefined,
  };
  sessions.set(key, rec);
  claudeToClient.set(claudeId, key);
  await saveSessionStore();
  log(`session map created client_key=${key} claude=${claudeId}`);
  return rec;
}

async function deleteSession(idOrKey) {
  const rec = findSession(normalizeKey(idOrKey));
  if (!rec) return false;
  sessions.delete(rec.client_key);
  claudeToClient.delete(rec.claude_session_id);
  await saveSessionStore();
  return true;
}

function rotateClaudeSession(rec) {
  claudeToClient.delete(rec.claude_session_id);
  rec.claude_session_id = randomUUID();
  claudeToClient.set(rec.claude_session_id, rec.client_key);
}

/**
 * Resolve client conversation key (AAAAA) from request. First hit wins.
 *  1. Headers: X-Conversation-Id / X-Chat-Id / X-OpenWebUI-Chat-Id / X-LibreChat-Conversation-Id /
 *              legacy X-AgentVR-Session / X-Session-Id
 *  2. Body: conversation_id / chat_id / thread_id / metadata.* / legacy session_id / agentvr_session
 *  3. OpenAI `user` field; Anthropic metadata.user_id
 */
function resolveClientKey(req, body) {
  const h = req.headers || {};
  for (const v of [
    h["x-conversation-id"],
    h["x-chat-id"],
    h["x-openwebui-chat-id"],
    h["x-librechat-conversation-id"],
    h["x-open-webui-chat-id"],
    h["x-agentvr-session"],
    h["x-agentvr-session-id"],
    h["x-session-id"],
  ]) {
    const k = normalizeKey(typeof v === "string" ? v : Array.isArray(v) ? v[0] : null);
    if (k) return { key: k, source: "header" };
  }
  if (body && typeof body === "object") {
    for (const v of [
      body.conversation_id,
      body.chat_id,
      body.thread_id,
      body.metadata?.chat_id,
      body.metadata?.conversation_id,
      body.metadata?.thread_id,
      body.session_id,
      body.agentvr_session,
      body.agentvr_conversation_id,
    ]) {
      const k = normalizeKey(v);
      if (k) return { key: k, source: "body" };
    }
    const userKey = normalizeKey(body.user) || normalizeKey(body.metadata?.user_id);
    if (userKey) return { key: userKey, source: "user" };
  }
  return { key: null, source: null };
}

function findSession(key) {
  if (!key) return null;
  if (sessions.has(key)) return sessions.get(key);
  const viaClaude = claudeToClient.get(key);
  if (viaClaude && sessions.has(viaClaude)) return sessions.get(viaClaude);
  return null;
}

/** FIFO lock per session key; the map entry is dropped once the queue drains. */
async function acquireSessionLock(sessionKey) {
  const prev = sessionLocks.get(sessionKey) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  sessionLocks.set(sessionKey, tail);
  await prev;
  return () => {
    release();
    if (sessionLocks.get(sessionKey) === tail) sessionLocks.delete(sessionKey);
  };
}

function acquireSlot() {
  return new Promise((resolve) => {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight += 1;
      resolve();
      return;
    }
    waitQueue.push(resolve);
  });
}

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
  const next = waitQueue.shift();
  if (next) {
    inFlight += 1;
    next();
  }
}

/**
 * Decide how to run a request:
 *  - oneshot/task:      Open WebUI style background job → fast model, no tools, no memory
 *  - oneshot/stateless: no conversation id (or X-AgentVR-Ephemeral) → full history each time
 *  - session:           mapped conversation → Claude Code --session-id / --resume
 */
async function planRequest(req, body, messages) {
  const model = resolveClaudeModel(body.model);
  const effort = resolveEffort(body);
  if (TASK_DETECT && /^\s*### Task:/.test(latestUserText(messages))) {
    return { kind: "oneshot", task: true, model: TASK_MODEL || model, effort: "", tools: "", mcp: false };
  }
  const ephemeral = truthy(req.headers["x-agentvr-ephemeral"]) || body.agentvr_ephemeral === true;
  const { key, source } = resolveClientKey(req, body);
  if (ephemeral || (!key && NO_KEY_MODE !== "auto-session")) {
    return { kind: "oneshot", task: false, model, effort, tools: BUILTIN_TOOLS, mcp: true };
  }
  let rec = key ? findSession(key) : null;
  if (rec) {
    log(`session hit client_key=${rec.client_key} via=${source}`);
  } else {
    rec = await createSession({ clientKey: key || undefined });
    log(`session new client_key=${rec.client_key} via=${source || "auto"} claude=${rec.claude_session_id}`);
  }
  return { kind: "session", rec, generated: !key, model, effort, tools: BUILTIN_TOOLS, mcp: true };
}

// ---------------------------------------------------------------- claude runner

function claudeEnv() {
  // The child gets a minimal allowlist, never this process's full environment:
  // wrapper settings (AGENTVR_*, BODY_SSH, key paths, extra secrets) must not
  // be visible from inside the island. HOME stays so Claude Code can read its
  // own login; PATH stays so it can start. A proxy is only set when one is
  // actually configured: inventing a default would send every request into a
  // port nothing is listening on.
  const keepExact = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "FAKE_CLAUDE_STATE", // test double's state dir; absent in production
  ]);
  const keepPrefix = [/^LC_/, /^XDG_/, /^PROCESSOR_/, /^ANTHROPIC_/];
  // GIT_CEILING_DIRECTORIES stops git discovery at the cwd, so a checkout that
  // hosts the session dir never shows up as "Is directory a git repo: Yes"
  // with its status in the base prompt.
  const out = { CI: "1", GIT_CEILING_DIRECTORIES: CLAUDE_CWD };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (keepExact.has(k.toUpperCase()) || keepPrefix.some((re) => re.test(k))) out[k] = v;
  }
  const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
  if (proxy) {
    out.HTTP_PROXY = env.HTTP_PROXY || proxy;
    out.HTTPS_PROXY = env.HTTPS_PROXY || proxy;
    out.http_proxy = out.HTTP_PROXY;
    out.https_proxy = out.HTTPS_PROXY;
    const noProxy = env.NO_PROXY || "127.0.0.1,localhost,::1,*.ts.net,100.64.0.0/10,10.0.0.0/8";
    out.NO_PROXY = noProxy;
    out.no_proxy = noProxy;
  }
  return out;
}

function redact(s) {
  return String(s)
    .replace(/mcp\/[A-Za-z0-9_-]{20,}/g, "mcp/<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-<redacted>");
}

/** Map Claude Code failures to HTTP statuses a client can act on. */
function classifyClaudeError(message) {
  const msg = redact(message).slice(0, 1200);
  if (/oauth|authenticat|not logged in|please run \/login|invalid api key/i.test(msg)) {
    return httpError(
      502,
      `brain host Claude Code login is invalid or expired — run \`claude\` then /login on the brain host. Detail: ${msg}`,
      "upstream_auth_error"
    );
  }
  if (/usage limit|rate.?limit|limit reached|too many requests/i.test(msg)) {
    return httpError(429, `Claude usage limit: ${msg}`, "rate_limit_error");
  }
  if (/overloaded/i.test(msg)) return httpError(503, `Claude overloaded: ${msg}`, "overloaded_error");
  if (/already in use/i.test(msg)) return httpError(409, msg, "session_conflict");
  return httpError(502, msg, "upstream_error");
}

/**
 * @param {{session: {mode: "new"|"resume"|"none", id?: string}, sysFile: string, model?: string,
 *          effort?: string, tools?: string, mcp?: boolean, streamInput?: boolean,
 *          systemPromptFile?: string}} o
 */
function claudeArgs(o) {
  // The prompt goes over stdin: no argv size limit, not visible in `ps`, and a
  // message starting with "-" can never be parsed as a CLI flag.
  const args = ["-p", "--dangerously-skip-permissions", "--strict-mcp-config"];
  if (o.mcp !== false) args.push("--mcp-config", MCP_CONFIG);
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt-file",
    o.sysFile
  );
  if (o.systemPromptFile) args.push("--system-prompt-file", o.systemPromptFile);
  if (o.streamInput) args.push("--input-format", "stream-json");
  if (o.tools !== undefined && o.tools !== "default") args.push("--tools", o.tools);
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.session.mode === "resume") args.push("--resume", o.session.id);
  else if (o.session.mode === "new") args.push("--session-id", o.session.id);
  else args.push("--no-session-persistence");
  return args;
}

/**
 * Run one Claude Code turn, streaming text / thinking / tool notes as they arrive.
 * @returns {Promise<{text: string, thinking: string, session_id: string|null, usage: object|null}>}
 */
async function runClaudeTurn({ session, prompt, attachments = [], systemPrompt, model, effort, tools, mcp, hooks = {} }) {
  const sysFile = path.join(os.tmpdir(), `agentvr-sys-${randomUUID()}.txt`);
  await fs.writeFile(sysFile, systemPrompt, { mode: 0o600 });
  const streamInput = attachments.length > 0;
  const stdin = streamInput
    ? JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }, ...attachments] },
        parent_tool_use_id: null,
        session_id: "",
      }) + "\n"
    : prompt;
  try {
    return await spawnClaude({
      args: claudeArgs({ session, sysFile, model, effort, tools, mcp, streamInput, systemPromptFile: SYSTEM_PROMPT_FILE }),
      stdin,
      sessionId: session.id || null,
      hooks,
    });
  } finally {
    fs.unlink(sysFile).catch(() => {});
  }
}

function spawnClaude({ args, stdin, sessionId, hooks }) {
  const { onText, onThinking, onToolUse } = hooks;
  return new Promise((resolve, reject) => {
    // A .js/.mjs CLAUDE_BIN (used by the test double) is run through node.
    const viaNode = /\.m?js$/i.test(CLAUDE_BIN);
    const child = spawn(viaNode ? process.execPath : CLAUDE_BIN, viaNode ? [CLAUDE_BIN, ...args] : args, {
      cwd: CLAUDE_CWD,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);

    let settled = false;
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish(reject, httpError(504, `claude timed out after ${CLAUDE_TIMEOUT_MS}ms`, "timeout_error"));
    }, CLAUDE_TIMEOUT_MS);
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
    // A dropped client never kills the turn: the work is already paid for, so we
    // let it finish and cache the answer for the retry (see the turn registry).

    child.stdin.on("error", () => {});
    child.stdin.end(stdin);

    let buf = "";
    let stderr = "";
    let result = null;
    let emittedText = false;
    let thinking = "";

    const handleLine = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "stream_event" && ev.event && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e.type === "content_block_start") {
          const t = e.content_block?.type;
          if (t === "text" && emittedText) onText?.("\n\n"); // new text block after tool use
          else if (t === "tool_use" || t === "server_tool_use") onToolUse?.(e.content_block.name);
        } else if (e.type === "content_block_delta") {
          if (e.delta?.type === "text_delta" && e.delta.text) {
            emittedText = true;
            onText?.(e.delta.text);
          } else if (e.delta?.type === "thinking_delta" && e.delta.thinking) {
            thinking += e.delta.thinking;
            onThinking?.(e.delta.thinking);
          }
        }
      } else if (ev.type === "result") {
        result = ev;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-20_000);
      const r = redact(d);
      if (r.trim()) process.stderr.write(`[claude.err] ${r}`);
    });
    child.on("error", (err) => {
      activeChildren.delete(child);
      finish(reject, err);
    });
    child.on("close", (code, sig) => {
      activeChildren.delete(child);
      if (buf.trim()) handleLine(buf.trim());
      if (result) {
        if (result.is_error) {
          finish(reject, classifyClaudeError(String(result.result || result.error || "claude is_error")));
          return;
        }
        finish(resolve, {
          text: String(result.result ?? "").trim(),
          thinking,
          session_id: result.session_id || sessionId,
          usage: result.usage || null,
        });
        return;
      }
      finish(reject, classifyClaudeError(`claude exit ${code}${sig ? ` signal=${sig}` : ""}: ${stderr.slice(-800)}`));
    });
  });
}

async function ensureTunnelOr503() {
  try {
    await ensureTunnel();
  } catch (e) {
    throw httpError(503, `body tunnel unavailable: ${e.message}`, "body_unavailable");
  }
}

/**
 * Execute a planned request. Session turns are serialized per conversation;
 * all turns share the global MAX_IN_FLIGHT slots.
 */
async function executeTurn(plan, messages, extraSystem, hooks = {}) {
  const attachments = extractAttachments(latestUserMessage(messages)?.content);

  if (plan.kind === "oneshot") {
    if (plan.mcp) await ensureTunnelOr503();
    await acquireSlot();
    try {
      log(`oneshot ${plan.task ? "task" : "stateless"} model=${plan.model || "default"} msgs=${messages.length} attachments=${attachments.length}`);
      return await runClaudeTurn({
        session: { mode: "none" },
        prompt: buildTurnPrompt(messages, true),
        attachments,
        systemPrompt: buildSystemPrompt(messages, extraSystem, { body: !plan.task }),
        model: plan.model,
        effort: plan.effort,
        tools: plan.tools,
        mcp: plan.mcp,
        hooks,
      });
    } finally {
      releaseSlot();
    }
  }

  await ensureTunnelOr503();
  const { rec } = plan;
  const unlock = await acquireSessionLock(rec.client_key);
  try {
    await acquireSlot();
  } catch (e) {
    unlock();
    throw e;
  }
  const t0 = Date.now();
  try {
    let mode = rec.started ? "resume" : "new";
    if (mode === "resume" && DETECT_DIVERGENCE && historyDiverged(rec, messages)) {
      // Regenerate / edit / retry: the Claude session holds a different history
      // than the client shows. Start a fresh Claude session seeded from the client.
      mode = "reseed";
      rotateClaudeSession(rec);
      rec.reseeds = (rec.reseeds || 0) + 1;
    }
    const prompt = buildTurnPrompt(messages, mode !== "resume");
    log(
      `turn start client_key=${rec.client_key} claude=${rec.claude_session_id} mode=${mode} turn=${rec.turn_count + 1} model=${plan.model || "default"} effort=${plan.effort || "default"} attachments=${attachments.length} promptChars=${prompt.length}`
    );
    let streamed = "";
    let out;
    try {
      out = await runClaudeTurn({
        session: { mode: mode === "resume" ? "resume" : "new", id: rec.claude_session_id },
        prompt,
        attachments,
        systemPrompt: buildSystemPrompt(messages, extraSystem),
        model: plan.model,
        effort: plan.effort,
        tools: plan.tools,
        mcp: plan.mcp,
        hooks: {
          ...hooks,
          onText: (t) => {
            streamed += t;
            hooks.onText?.(t);
          },
        },
      });
    } catch (e) {
      if (mode !== "resume") {
        // A failed first turn may have left a half-created Claude session under
        // this uuid; a retry with the same --session-id would be refused.
        rotateClaudeSession(rec);
        await saveSessionStore();
      }
      throw e;
    }
    rec.started = true;
    rec.turn_count += 1;
    rec.last_used_at = new Date().toISOString();
    if (messages.some((m) => roleOf(m) === "assistant")) rec.history_seen = true;
    // Fingerprint what the CLIENT will store: streamed text when streaming, else the final result.
    rec.last_reply_tail = replyTail(hooks.onText ? streamed : out.text);
    await saveSessionStore();
    log(`turn done client_key=${rec.client_key} ms=${Date.now() - t0} chars=${out.text.length} turns=${rec.turn_count}`);
    return out;
  } finally {
    releaseSlot();
    unlock();
  }
}

// ---------------------------------------------------------------- turn registry
//
// A turn survives its client. If the connection drops (flaky link, a proxy
// closing an idle socket, a laptop lid), the Claude run keeps going and every
// chunk it produced is recorded. When the client retries the same message it
// attaches to that run instead of paying for a second one: the recorded chunks
// replay instantly, then it follows the live output. A turn that finished while
// nobody was listening is kept for TURN_CACHE_MS and handed to the retry as-is.

/** @type {Map<string, Turn>} */
const turns = new Map();

/**
 * @typedef {object} Turn
 * @property {Array<{k: "text"|"thinking"|"tool", v: string}>} events everything produced so far
 * @property {Set<object>} subs live subscribers
 * @property {{ok: true, out: object} | {ok: false, err: Error} | null} finished
 * @property {boolean} delivered a subscriber saw it through to the end
 * @property {number} at
 */

function sha(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 32);
}

/**
 * Identifies "the same message sent again". Built from what the client sent, so
 * a retry computes the same key before anything runs.
 */
function turnKey(plan, messages) {
  const who = plan.kind === "session" ? `s:${plan.rec.client_key}` : "oneshot";
  const what = plan.kind === "session" ? latestUserMessage(messages)?.content : messages;
  return `${who}|${plan.model || ""}|${plan.effort || ""}|${sha(JSON.stringify(what ?? ""))}`;
}

function sweepTurns(now = Date.now()) {
  for (const [k, t] of turns) {
    if (t.finished && now - t.at > TURN_CACHE_MS) turns.delete(k);
  }
}

function emit(turn, k, v) {
  turn.events.push({ k, v });
  for (const s of turn.subs) s.on?.(k, v);
}

/** Replay what a turn has already produced into one subscriber. */
function replay(turn, sub) {
  for (const e of turn.events) sub.on?.(e.k, e.v);
}

/**
 * Run a turn, or attach to the identical one already running / just finished.
 * @param {{on?: (kind: string, value: string) => void, gone?: AbortSignal}} sub
 */
async function runOrAttach(plan, messages, extraSystem, sub) {
  sweepTurns();
  const key = turnKey(plan, messages);
  const existing = turns.get(key);

  if (existing && !existing.finished) {
    log(`turn attach key=${key.slice(0, 40)} events=${existing.events.length} (retry joined a running turn)`);
    replay(existing, sub);
    existing.subs.add(sub);
    try {
      return await existing.promise;
    } finally {
      existing.subs.delete(sub);
      if (!sub.gone?.aborted) existing.delivered = true;
    }
  }
  if (existing?.finished?.ok && !existing.delivered) {
    // Succeeded while nobody was listening: hand the retry the paid-for answer.
    log(`turn replay key=${key.slice(0, 40)} (cached answer from an abandoned turn)`);
    turns.delete(key);
    replay(existing, sub);
    return existing.finished.out;
  }
  // A failed turn is never replayed: the retry deserves a real attempt, since
  // the usual causes (tunnel down, overloaded, timeout) are transient.
  if (existing) turns.delete(key);

  /** @type {Turn} */
  const turn = { events: [], subs: new Set([sub]), finished: null, delivered: false, at: Date.now(), promise: null };
  turns.set(key, turn);
  turn.promise = executeTurn(plan, messages, extraSystem, {
    onText: (t) => emit(turn, "text", t),
    onThinking: (t) => emit(turn, "thinking", t),
    onToolUse: (n) => emit(turn, "tool", n),
  })
    .then(
      (out) => {
        turn.finished = { ok: true, out };
        turn.at = Date.now();
        return out;
      },
      (err) => {
        turn.finished = { ok: false, err };
        turn.at = Date.now();
        throw err;
      }
    );
  try {
    return await turn.promise;
  } finally {
    turn.subs.delete(sub);
    if (!sub.gone?.aborted) {
      turn.delivered = true;
      turns.delete(key);
    }
  }
}

// ---------------------------------------------------------------- handlers

function openaiUsage(usage) {
  const input =
    (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
  const output = usage?.output_tokens || 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function planKeyFields(plan) {
  if (plan.kind !== "session") return {};
  const k = plan.rec.client_key;
  return { conversation_id: k, chat_id: k, agentvr_conversation_id: k, agentvr_session: k };
}

async function handleCreateSession(req, res) {
  if (!(await requireAuth(req, res))) return;
  const body = await readJsonBody(req, { allowEmpty: true });
  const clientKey =
    normalizeKey(body.conversation_id) ||
    normalizeKey(body.client_key) ||
    normalizeKey(body.chat_id) ||
    normalizeKey(body.id) ||
    normalizeKey(body.session_id) ||
    undefined;
  const rec = await createSession({ clientKey, label: body.label || body.name || undefined });
  json(res, 201, publicSession(rec), sessionHeaders(rec));
}

async function handleListSessions(req, res) {
  if (!(await requireAuth(req, res))) return;
  const list = [...sessions.values()]
    .sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at))
    .map(publicSession);
  json(res, 200, {
    object: "list",
    data: list,
    max_sessions: MAX_SESSIONS,
    max_in_flight: MAX_IN_FLIGHT,
    idle_timeout_ms: IDLE_TIMEOUT_MS,
    live_count: liveSessionCount(),
  });
}

async function handleGetSession(req, res, id) {
  if (!(await requireAuth(req, res))) return;
  const rec = findSession(normalizeKey(id));
  if (!rec) {
    json(res, 404, { error: { message: "session not found" } });
    return;
  }
  json(res, 200, publicSession(rec), sessionHeaders(rec));
}

async function handleDeleteSession(req, res, id) {
  if (!(await requireAuth(req, res))) return;
  if (!(await deleteSession(id))) {
    json(res, 404, { error: { message: "session not found" } });
    return;
  }
  json(res, 200, { deleted: true, conversation_id: id, id });
}

/**
 * An SSE response that holds back its 200 until there is something to send.
 * While it is unopened a failure can still travel as a real HTTP status, which
 * is what lets a client retry on 429 / 503 / 502 instead of seeing a "successful"
 * stream carrying an error. It opens on the first write, or after SSE_OPEN_MS so
 * that a long tool-only phase still gets keepalives.
 */
function deferredSse(res, headers) {
  let stopHeartbeat = null;
  const open = () => {
    if (stopHeartbeat) return;
    stopHeartbeat = startSse(res, headers);
  };
  const timer = setTimeout(open, SSE_OPEN_MS);
  timer.unref?.();
  return {
    get open() {
      return Boolean(stopHeartbeat);
    },
    write(text) {
      open();
      if (!res.writableEnded) res.write(text);
    },
    close(tail) {
      clearTimeout(timer);
      if (tail !== undefined && stopHeartbeat) this.write(tail);
      stopHeartbeat?.();
      if (stopHeartbeat && !res.writableEnded) res.end();
    },
  };
}

/** Open an SSE response with periodic keepalive comments. Returns a stop fn. */
function startSse(res, headers) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...headers,
  });
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keepalive\n\n");
  }, HEARTBEAT_MS);
  return () => clearInterval(heartbeat);
}

async function handleChatCompletions(req, res) {
  if (!(await requireAuth(req, res))) return;
  const body = await readJsonBody(req);
  const model = body.model || MODEL_ID;
  const messages = body.messages || [];
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(400, "messages required");

  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const signal = clientAbortSignal(res);
  const plan = await planRequest(req, body, messages);
  const hdrs = conversationHeaders(plan);
  const keyFields = planKeyFields(plan);
  log(
    `chat id=${id} mode=${plan.kind}${plan.task ? "/task" : ""} key=${plan.rec?.client_key || "-"} model=${model} msgs=${messages.length} stream=${Boolean(body.stream)}`
  );

  if (!body.stream) {
    const out = await runOrAttach(plan, messages, body.system, { gone: signal });
    const message = { role: "assistant", content: out.text };
    if (out.thinking && STREAM_THINKING) message.reasoning_content = out.thinking;
    json(
      res,
      200,
      {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: openaiUsage(out.usage),
        ...keyFields,
      },
      hdrs
    );
    return;
  }

  const sse = deferredSse(res, hdrs);
  const chunk = (delta, finish_reason = null, extra = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
    ...keyFields,
    ...extra,
  });
  const send = (obj) => {
    if (!sse.open) sse.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
    sse.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  try {
    const out = await runOrAttach(plan, messages, body.system, {
      gone: signal,
      on: (kind, v) => {
        if (kind === "text") send(chunk({ content: v }));
        else if (kind === "thinking" && STREAM_THINKING) send(chunk({ reasoning_content: v }));
        else if (kind === "tool" && STREAM_TOOL_NOTES) send(chunk({ reasoning_content: `\n[tool] ${v}\n` }));
      },
    });
    send(chunk({}, "stop", { usage: openaiUsage(out.usage) }));
  } catch (e) {
    // Nothing streamed yet → the client still gets a real status code to retry on.
    if (!sse.open) throw e;
    log(`chat stream error id=${id}: ${e.message}`);
    send({ error: { message: e.message, type: e.type || "server_error", code: e.statusCode || 500 } });
  } finally {
    sse.close("data: [DONE]\n\n");
  }
}

async function handleModels(req, res) {
  if (!(await requireAuth(req, res))) return;
  const data = modelList();
  json(res, 200, { object: "list", data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id });
}

function anthropicSystemText(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  return "";
}

/** Emits Anthropic SSE content blocks, opening a new block when the kind changes. */
function anthropicBlockWriter(send) {
  let index = -1;
  let current = null;
  const close = () => {
    if (current === null) return;
    send("content_block_stop", { type: "content_block_stop", index });
    current = null;
  };
  const open = (kind) => {
    if (current === kind) return;
    close();
    index += 1;
    current = kind;
    const block = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
    send("content_block_start", { type: "content_block_start", index, content_block: block });
  };
  return {
    text(t) {
      open("text");
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
    },
    thinking(t) {
      open("thinking");
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: t },
      });
    },
    finish() {
      if (index < 0) open("text");
      close();
    },
  };
}

async function handleMessages(req, res) {
  if (!(await requireAuth(req, res))) return;
  const body = await readJsonBody(req);
  const model = body.model || MODEL_ID;
  const messages = body.messages || [];
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(400, "messages required");
  const system = anthropicSystemText(body.system);
  const signal = clientAbortSignal(res);
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const plan = await planRequest(req, body, messages);
  const hdrs = conversationHeaders(plan);
  const keyFields = planKeyFields(plan);
  log(
    `messages id=${msgId} mode=${plan.kind}${plan.task ? "/task" : ""} key=${plan.rec?.client_key || "-"} model=${model} stream=${Boolean(body.stream)}`
  );

  if (!body.stream) {
    const out = await runOrAttach(plan, messages, system, { gone: signal });
    const content = [];
    if (out.thinking && STREAM_THINKING) content.push({ type: "thinking", thinking: out.thinking, signature: "" });
    content.push({ type: "text", text: out.text });
    json(
      res,
      200,
      {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: out.usage?.input_tokens || 0, output_tokens: out.usage?.output_tokens || 0 },
        ...keyFields,
      },
      hdrs
    );
    return;
  }

  const sse = deferredSse(res, hdrs);
  const send = (event, data) => {
    if (!sse.open) {
      sse.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`
      );
    }
    sse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const blocks = anthropicBlockWriter(send);
  try {
    const out = await runOrAttach(plan, messages, system, {
      gone: signal,
      on: (kind, v) => {
        if (kind === "text") blocks.text(v);
        else if (kind === "thinking" && STREAM_THINKING) blocks.thinking(v);
        else if (kind === "tool" && STREAM_TOOL_NOTES) blocks.thinking(`\n[tool] ${v}\n`);
      },
    });
    blocks.finish();
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: out.usage?.output_tokens || 0 },
    });
    send("message_stop", { type: "message_stop" });
  } catch (e) {
    // Nothing streamed yet → the client still gets a real status code to retry on.
    if (!sse.open) throw e;
    log(`messages stream error id=${msgId}: ${e.message}`);
    send("error", { type: "error", error: { type: e.type || "api_error", message: e.message } });
  } finally {
    sse.close();
  }
}

/** Rough estimate; Claude Code does not expose a tokenizer. */
async function handleCountTokens(req, res) {
  if (!(await requireAuth(req, res))) return;
  const body = await readJsonBody(req);
  const text = [anthropicSystemText(body.system), ...(body.messages || []).map((m) => contentToText(m.content))].join(
    "\n"
  );
  json(res, 200, { input_tokens: Math.max(1, Math.round(text.length / 3.5)) });
}

async function handleHealth(req, res) {
  const base = { ok: true, service: "agentvr-api" };
  if (!isValidKey(extractApiKey(req))) {
    json(res, 200, base);
    return;
  }
  json(res, 200, {
    ...base,
    model: MODEL_ID,
    models: modelList().map((m) => m.id),
    sessions: sessions.size,
    live_sessions: liveSessionCount(),
    in_flight: inFlight,
    queued: waitQueue.length,
    max_sessions: MAX_SESSIONS || "unlimited",
    max_in_flight: MAX_IN_FLIGHT,
    idle_timeout_ms: IDLE_TIMEOUT_MS,
    auth_failures: authFailures,
    builtin_tools: BUILTIN_TOOLS,
    no_key_mode: NO_KEY_MODE,
    listen: LISTEN.map((l) => `${l.host}:${l.port}`),
  });
}

function errorBody(p, e) {
  const status = e.statusCode || 500;
  const type = e.type || (status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "server_error");
  if (p.includes("/messages")) return { type: "error", error: { type, message: e.message || "internal error" } };
  return { error: { message: e.message || "internal error", type } };
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && (p === "/healthz" || p === "/health")) return await handleHealth(req, res);
    if (req.method === "GET" && (p === "/v1/models" || p === "/models")) return await handleModels(req, res);
    if (req.method === "POST" && p === "/v1/sessions") return await handleCreateSession(req, res);
    if (req.method === "GET" && p === "/v1/sessions") return await handleListSessions(req, res);
    const m = p.match(/^\/v1\/sessions\/([^/]+)$/);
    if (m) {
      let sid;
      try {
        sid = decodeURIComponent(m[1]);
      } catch {
        throw httpError(400, "malformed session id in path");
      }
      if (req.method === "GET") return await handleGetSession(req, res, sid);
      if (req.method === "DELETE") return await handleDeleteSession(req, res, sid);
    }
    if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
      return await handleChatCompletions(req, res);
    }
    if (req.method === "POST" && (p === "/v1/messages/count_tokens" || p === "/messages/count_tokens")) {
      return await handleCountTokens(req, res);
    }
    if (req.method === "POST" && (p === "/v1/messages" || p === "/messages")) return await handleMessages(req, res);
    json(res, 404, { error: { message: `not found: ${req.method} ${p}` } });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 499) return;
    if (status >= 500) log(`error ${req.method} ${p}: ${e.message}`);
    // Tell well-behaved clients when to come back instead of hammering us.
    const retry = status === 429 ? { "Retry-After": "60" } : status === 503 ? { "Retry-After": "10" } : {};
    json(res, status, errorBody(p, e), retry);
  }
}

await loadKeys();
await loadSessionStore();
await fs.mkdir(CLAUDE_CWD, { recursive: true }).catch((e) => log(`warn: cannot prepare claude cwd: ${e.message}`));
if (SYSTEM_PROMPT_FILE) {
  await fs.access(SYSTEM_PROMPT_FILE).catch(() => log(`warn: AGENTVR_SYSTEM_PROMPT_FILE not found: ${SYSTEM_PROMPT_FILE}`));
}
const servers = LISTEN.map(({ host, port }) => {
  const s = http.createServer(route);
  s.on("error", (e) => log(`listen ${host}:${port} failed: ${e.message}`));
  s.listen(port, host, () => log(`AgentVR Cloud API listening on http://${host}:${port}`));
  return s;
});
log(
  `models=${modelList()
    .map((m) => m.id)
    .join(",")} max_in_flight=${MAX_IN_FLIGHT} max_sessions=${MAX_SESSIONS || "unlimited"} builtin_tools=${BUILTIN_TOOLS} no_key_mode=${NO_KEY_MODE}`
);
if (LISTEN.some((l) => !["127.0.0.1", "::1", "localhost"].includes(l.host))) {
  log("WARNING: listening beyond loopback — anyone who can reach this port and holds a key can run commands on the body host");
}

process.on("SIGHUP", () => {
  loadKeys().catch((e) => log(`key reload failed, keeping old keys: ${e.message}`));
});

async function shutdown(sig) {
  log(`shutting down (${sig})`);
  for (const child of activeChildren) child.kill("SIGTERM");
  try {
    await saveSessionStore();
  } catch (e) {
    log(`warn save on shutdown: ${e.message}`);
  }
  let open = servers.length;
  for (const s of servers) s.close(() => --open === 0 && process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
