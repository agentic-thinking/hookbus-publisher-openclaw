/**
 * HookBus publisher for OpenClaw.
 *
 * Registers four lifecycle hooks and forwards them as HookBus events:
 *   before_tool_call -> PreToolUse    (sync, enforces consolidated verdict)
 *   after_tool_call  -> PostToolUse   (observation, fire-and-forget)
 *   llm_input        -> PreLLMCall    (sync, enforces consolidated verdict)
 *   llm_output       -> PostLLMCall   (observation, carries model + token usage)
 *
 * The most recent model/provider from llm_output is cached and auto-injected
 * into metadata on tool-call events, so subscribers that only see tool events
 * still get model attribution (matches Hermes publisher behaviour).
 *
 * Environment:
 *   HOOKBUS_URL         default http://localhost:18800/event
 *   HOOKBUS_TOKEN       bearer token, optional
 *   HOOKBUS_SOURCE      default 'openclaw'
 *   HOOKBUS_TIMEOUT_MS  default 60000
 *   HOOKBUS_FAIL_MODE   'closed' (default for openclaw, fail-safe deny) or 'open'
 *   HOOKBUS_DEBUG       '1' to emit diagnostic logs on stderr
 *
 * Licence: MIT. Copyright 2026 Agentic Thinking Limited.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.5.1";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const FILE_ENV = loadEnvFile(join(PLUGIN_DIR, "hookbus.env"));
const cfg = (name, fallback = "") => process.env[name] || FILE_ENV[name] || fallback;

const BUS_URL = cfg("HOOKBUS_URL", "http://localhost:18800/event");
const TIMEOUT_MS = parseInt(cfg("HOOKBUS_TIMEOUT_MS", "60000"), 10);
const FAIL_MODE_RAW = cfg("HOOKBUS_FAIL_MODE", "closed").toLowerCase();
const FAIL_MODE = FAIL_MODE_RAW === "open" ? "open" : "closed";
const SOURCE = cfg("HOOKBUS_SOURCE", "openclaw");
const TOKEN = cfg("HOOKBUS_TOKEN", "");
const DEBUG = cfg("HOOKBUS_DEBUG", "") === "1";

function log(level, msg) {
  if (!DEBUG && level === "info") return;
  process.stderr.write(`[hookbus-openclaw] ${level}: ${msg}\n`);
}

// Startup validation: warn on obviously-broken config. Never crash.
(function validateStartup() {
  try {
    const u = new URL(BUS_URL);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      log("error", `HOOKBUS_URL has unsupported protocol '${u.protocol}', only http/https allowed`);
    } else if (!u.hostname) {
      log("error", `HOOKBUS_URL missing host: ${BUS_URL}`);
    }
  } catch (e) {
    log("error", `HOOKBUS_URL is not a valid URL (${BUS_URL}): ${e.message}`);
  }
  if (!TOKEN) log("warn", "HOOKBUS_TOKEN is empty; authenticated buses will reject requests");
  log("info", `started v${VERSION} (source=${SOURCE}, fail_mode=${FAIL_MODE}, bus=${BUS_URL}, config=${Object.keys(FILE_ENV).length ? "hookbus.env" : "env only"})`);
})();

// Cached from most recent llm_output so tool-call events get model attribution.
let _lastModel = "";
let _lastProvider = "";

function failVerdict(reason) {
  return {
    decision: FAIL_MODE === "open" ? "allow" : "deny",
    reason,
  };
}

function postEvent(envelope, { silent = false } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(BUS_URL);
    } catch (e) {
      if (silent) { resolve(null); return; }
      resolve(failVerdict(`Invalid HOOKBUS_URL: ${e.message}`));
      return;
    }

    // Envelope serialisation guard: circular refs in tool_input should not crash the plugin.
    let body;
    try {
      body = JSON.stringify(envelope);
    } catch (e) {
      log("warn", `envelope serialisation failed: ${e.message}`);
      if (silent) { resolve(null); return; }
      resolve(failVerdict(`envelope serialisation failed: ${e.message}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const defaultPort = isHttps ? 443 : 80;

    const req = requestFn({
      hostname: url.hostname,
      port: url.port || defaultPort,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers: (() => {
        const h = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
        if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
        return h;
      })(),
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (silent) { resolve(null); return; }

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          log("warn", `bus returned HTTP ${res.statusCode} for ${envelope.event_type}`);
          resolve(failVerdict(`HookBus HTTP ${res.statusCode}`));
          return;
        }

        const ctype = (res.headers["content-type"] || "").toLowerCase();
        if (!ctype.includes("json")) {
          log("warn", `bus returned non-JSON content-type '${ctype}' for ${envelope.event_type}`);
          resolve(failVerdict(`HookBus returned non-JSON (${ctype || "unknown"})`));
          return;
        }

        let data;
        try {
          data = JSON.parse(buf);
        } catch (e) {
          log("warn", `bus response JSON parse failed: ${e.message}`);
          resolve(failVerdict("HookBus response not valid JSON"));
          return;
        }

        if (!data || typeof data !== "object") {
          log("warn", "bus response is not an object");
          resolve(failVerdict("HookBus response was not an object"));
          return;
        }

        resolve({ decision: data.decision || "deny", reason: data.reason || "" });
      });
    });

    req.on("error", (e) => {
      log("warn", `bus unreachable: ${e.message}`);
      if (silent) { resolve(null); return; }
      resolve(failVerdict(`HookBus unreachable: ${e.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      log("warn", "bus timeout");
      if (silent) { resolve(null); return; }
      resolve(failVerdict("HookBus timeout"));
    });
    req.write(body);
    req.end();
  });
}

function isoNow() {
  return new Date().toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

function sessionOf(ctx) {
  return (ctx && ctx.sessionId) || cfg("OPENCLAW_SESSION_ID", "") || `openclaw-${hostname()}-${process.pid}`;
}

function mergeModelMeta(extra) {
  const m = { ...extra };
  if (_lastModel && !m.model) m.model = _lastModel;
  if (_lastProvider && !m.provider) m.provider = _lastProvider;
  return m;
}

function buildEnvelope(eventType, toolName, toolInput, ctx, extraMeta = {}) {
  // Auto-cache model/provider when a PostLLMCall envelope carries them, so
  // subsequent tool events pick them up even when the caller bypasses the
  // llm_output hook (e.g. direct invocation from tests or the sequencer).
  if (eventType === "PostLLMCall") {
    if (extraMeta.model) _lastModel = extraMeta.model;
    if (extraMeta.provider) _lastProvider = extraMeta.provider;
  }
  return {
    event_id: randomUUID(),
    event_type: eventType,
    timestamp: isoNow(),
    source: SOURCE,
    session_id: sessionOf(ctx),
    tool_name: toolName || "unknown",
    tool_input: typeof toolInput === "object" && toolInput !== null ? toolInput : { value: toolInput },
    metadata: mergeModelMeta({
      publisher: "hookbus-openclaw-publisher",
      publisher_version: VERSION,
      host: hostname(),
      run_id: (ctx && ctx.runId) || "",
      tool_call_id: (ctx && ctx.toolCallId) || "",
      ...extraMeta,
    }),
  };
}

function truncate(val, max = 2000) {
  if (val == null) return null;
  const s = typeof val === "string" ? val : JSON.stringify(val);
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

export default function register(api) {
  // --- PreToolUse: sync, enforces verdict ---------------------------------
  api.on("before_tool_call", async (event, ctx) => {
    const envelope = buildEnvelope("PreToolUse", event.toolName, event.params, ctx);
    const { decision, reason } = await postEvent(envelope);
    if (decision === "allow") return;
    if (decision !== "deny" && decision !== "ask") {
      log("warn", `unknown verdict decision '${decision}' for PreToolUse, treating as deny`);
    }
    const blockReason = decision === "ask"
      ? `approval required: ${reason || "no reason given"}`
      : (reason || "Blocked by HookBus subscriber (no reason given).");
    return { block: true, blockReason };
  });

  // --- PostToolUse: fire-and-forget, carries result + duration ------------
  api.on("after_tool_call", async (event, ctx) => {
    const envelope = buildEnvelope("PostToolUse", event.toolName, event.params, ctx, {
      duration_ms: event.durationMs || 0,
      tool_result: truncate(event.result),
      error: event.error || null,
      success: !event.error,
    });
    await postEvent(envelope, { silent: true });
  });

  // --- PreLLMCall: sync, enforces verdict ---------------------------------
  api.on("llm_input", async (event, ctx) => {
    const envelope = buildEnvelope("PreLLMCall", "llm.api_request", {}, {
      sessionId: event.sessionId,
      runId: event.runId,
    }, {
      model: event.model || "",
      provider: event.provider || "",
      prompt_preview: truncate(event.prompt || event.messages || ""),
    });
    const { decision, reason } = await postEvent(envelope);
    if (decision === "allow") return;
    if (decision !== "deny" && decision !== "ask") {
      log("warn", `unknown verdict decision '${decision}' for PreLLMCall, treating as deny`);
    }
    const blockReason = decision === "ask"
      ? `approval required: ${reason || "no reason given"}`
      : (reason || "Blocked by HookBus subscriber (no reason given).");
    return { block: true, blockReason };
  });

  // --- PostLLMCall: fire-and-forget, carries model + token usage ----------
  api.on("llm_output", async (event, ctx) => {
    _lastModel = event.model || _lastModel;
    _lastProvider = event.provider || _lastProvider;
    const usage = event.usage || {};
    const envelope = buildEnvelope("PostLLMCall", "llm.api_request", {}, {
      sessionId: event.sessionId,
      runId: event.runId,
    }, {
      model: event.model || "",
      provider: event.provider || "",
      tokens_input: usage.input || 0,
      tokens_output: usage.output || 0,
      tokens_cache_read: usage.cacheRead || 0,
      tokens_cache_write: usage.cacheWrite || 0,
      total_tokens: usage.total || (usage.input || 0) + (usage.output || 0),
      assistant_content_chars: (event.assistantTexts || []).reduce((n, t) => n + (t ? t.length : 0), 0),
      response_content: (event.assistantTexts || []).join("\n").slice(0, 4000),
    });
    await postEvent(envelope, { silent: true });
  });
}

// exported for tests / direct invocation from the sequencer harness
export { buildEnvelope, postEvent };
