/**
 * HookBus publisher for OpenClaw.
 *
 * Registers three lifecycle hooks and forwards them as HookBus events:
 *   before_tool_call -> PreToolUse    (sync, enforces consolidated verdict)
 *   after_tool_call  -> PostToolUse   (observation, fire-and-forget)
 *   llm_output       -> PostLLMCall   (observation, carries model + token usage)
 *
 * The most recent model/provider from llm_output is cached and auto-injected
 * into metadata on tool-call events, so subscribers that only see tool events
 * still get model attribution (matches Hermes publisher behaviour).
 *
 * Fail mode (PreToolUse only):
 *   HOOKBUS_FAIL_MODE=closed (default) -> bus unreachable => deny (fail-safe)
 *   HOOKBUS_FAIL_MODE=open             -> bus unreachable => allow (dev mode)
 */
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const BUS_URL = process.env.HOOKBUS_URL || "http://localhost:18800/event";
const TIMEOUT_MS = parseInt(process.env.HOOKBUS_TIMEOUT_MS || "60000", 10);
const FAIL_MODE = (process.env.HOOKBUS_FAIL_MODE || "closed").toLowerCase();
const SOURCE = process.env.HOOKBUS_SOURCE || "openclaw";
const TOKEN = process.env.HOOKBUS_TOKEN || "";
const VERSION = "0.4.0";

// Cached from most recent llm_output so tool-call events get model attribution.
let _lastModel = "";
let _lastProvider = "";

function postEvent(envelope, { silent = false } = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(BUS_URL); } catch (e) {
      resolve({ decision: FAIL_MODE === "open" ? "allow" : "deny", reason: `Invalid HOOKBUS_URL: ${e.message}` });
      return;
    }
    const body = JSON.stringify(envelope);
    const req = request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
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
        try {
          const data = JSON.parse(buf);
          resolve({ decision: data.decision || "deny", reason: data.reason || "" });
        } catch {
          resolve({ decision: FAIL_MODE === "open" ? "allow" : "deny", reason: "HookBus returned non-JSON" });
        }
      });
    });
    req.on("error", (e) => {
      if (silent) { resolve(null); return; }
      resolve({ decision: FAIL_MODE === "open" ? "allow" : "deny", reason: `HookBus unreachable: ${e.message}` });
    });
    req.on("timeout", () => {
      req.destroy();
      if (silent) { resolve(null); return; }
      resolve({ decision: FAIL_MODE === "open" ? "allow" : "deny", reason: "HookBus timeout" });
    });
    req.write(body);
    req.end();
  });
}

function isoNow() {
  return new Date().toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

function sessionOf(ctx) {
  return (ctx && ctx.sessionId) || process.env.OPENCLAW_SESSION_ID || `openclaw-${hostname()}-${process.pid}`;
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
    const err = new Error(`HookBus ${decision}: ${reason || "no reason given"}`);
    err.code = "HOOKBUS_BLOCKED";
    throw err;
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
    });
    await postEvent(envelope, { silent: true });
  });
}

// exported for tests / direct invocation from the sequencer harness
export { buildEnvelope, postEvent };
