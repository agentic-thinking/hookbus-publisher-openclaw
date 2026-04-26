// One-shot test: verify OpenClaw publisher honours ASK by returning { block: true }
// instead of throwing an Error (which OpenClaw catches and ignores).
import { createServer } from "node:http";
import assert from "node:assert/strict";

async function startMockBus(verdict) {
  const srv = createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(verdict));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

async function loadPublisher(url) {
  process.env.HOOKBUS_URL = url;
  const mod = await import(`./index.js?cachebust=${Math.random()}`);
  return mod.default;
}

async function testAskBlocksTool() {
  const bus = await startMockBus({ decision: "ask", reason: "hookbus-llm returned ASK" });
  try {
    const register = await loadPublisher(`http://127.0.0.1:${bus.port}/event`);
    const hooks = {};
    const api = {
      on: (name, handler) => { hooks[name] = handler; }
    };
    register(api);

    const event = { toolName: "Bash", params: { command: "echo benign" } };
    const ctx = { sessionId: "test-session" };
    const result = await hooks.before_tool_call(event, ctx);

    assert.equal(result.block, true, "ASK must return block: true");
    assert.match(result.blockReason, /approval required/, "ASK must surface 'approval required'");
    assert.match(result.blockReason, /hookbus-llm returned ASK/, "ASK must include the reason verbatim");
    console.log("OK: ASK verdict returns { block: true, blockReason:", result.blockReason, "}");
  } finally {
    await bus.close();
  }
}

async function testDenyBlocksTool() {
  const bus = await startMockBus({ decision: "deny", reason: "blocked by policy" });
  try {
    const register = await loadPublisher(`http://127.0.0.1:${bus.port}/event`);
    const hooks = {};
    const api = {
      on: (name, handler) => { hooks[name] = handler; }
    };
    register(api);

    const event = { toolName: "Bash", params: { command: "echo benign" } };
    const ctx = { sessionId: "test-session" };
    const result = await hooks.before_tool_call(event, ctx);

    assert.equal(result.block, true, "DENY must return block: true");
    assert.match(result.blockReason, /blocked by policy/, "DENY must include the reason");
    console.log("OK: DENY verdict returns { block: true, blockReason:", result.blockReason, "}");
  } finally {
    await bus.close();
  }
}

async function testAskBlocksLLM() {
  const bus = await startMockBus({ decision: "ask", reason: "budget exceeded" });
  try {
    const register = await loadPublisher(`http://127.0.0.1:${bus.port}/event`);
    const hooks = {};
    const api = {
      on: (name, handler) => { hooks[name] = handler; }
    };
    register(api);

    const event = { sessionId: "test-session", runId: "test-run", model: "gpt-4", provider: "openai", prompt: "hello" };
    const ctx = { sessionId: "test-session" };
    const result = await hooks.llm_input(event, ctx);

    assert.equal(result.block, true, "ASK on llm_input must return block: true");
    assert.match(result.blockReason, /approval required/, "ASK must surface 'approval required'");
    assert.match(result.blockReason, /budget exceeded/, "ASK must include the reason verbatim");
    console.log("OK: ASK verdict on llm_input returns { block: true, blockReason:", result.blockReason, "}");
  } finally {
    await bus.close();
  }
}

(async () => {
  await testAskBlocksTool();
  await testDenyBlocksTool();
  await testAskBlocksLLM();
  console.log("\nALL ASK BLOCK TESTS PASSED");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
