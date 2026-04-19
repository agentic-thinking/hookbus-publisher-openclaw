# @agentic-thinking/hookbus-publisher-openclaw

OpenClaw publisher plugin for **HookBus**, the vendor-neutral runtime governance bus for AI agents. Forwards OpenClaw lifecycle events (`before_tool_call`, `after_tool_call`, `llm_output`) to a HookBus endpoint and enforces the consolidated decision on tool calls. **Fail-closed by default** — bus unreachable means deny.

## Install (60 seconds)

One shell command installs the full HookBus stack and this OpenClaw publisher plugin. For the OpenClaw-specific path, use the `--runtime openclaw` flag below.

```bash
curl -fsSL https://agenticthinking.uk/install.sh | bash
```

Non-interactive variants:

```bash
# OpenClaw users
curl -fsSL https://agenticthinking.uk/install.sh | bash -s -- --runtime openclaw

# Hermes-agent users
curl -fsSL https://agenticthinking.uk/install.sh | bash -s -- --runtime hermes

# Bus + subscribers only, skip publisher
curl -fsSL https://agenticthinking.uk/install.sh | bash -s -- --runtime skip --noninteractive
```

The script prints the dashboard URL + bearer token on completion. Re-run any time, it is idempotent.

_Prefer not to pipe curl to bash? Inspect first:_ `curl -fsSL https://agenticthinking.uk/install.sh > install.sh && less install.sh && bash install.sh`

---

## Manual install

If you prefer to see every step, or you are building an immutable / reproducible deployment, here is the full manual install.

The plugin directory name must match the `id` field in `openclaw.plugin.json` (`"id": "cre"`), so it installs into `~/.openclaw/extensions/cre/`:

```bash
npm install @agentic-thinking/hookbus-publisher-openclaw
mkdir -p ~/.openclaw/extensions/cre
cp -r node_modules/@agentic-thinking/hookbus-publisher-openclaw/* ~/.openclaw/extensions/cre/
```

Verify it loaded:

```bash
openclaw plugins list | grep cre
# Expected: HookBus | cre | openclaw | loaded | ... | 0.4.0
```

## Config

| Env var | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | HookBus endpoint |
| `HOOKBUS_TOKEN` | *(empty)* | Bearer token. **Required** if the bus has auth enabled (default since v0.4). Without it every POST gets 401. Read from `docker exec hookbus cat /root/.hookbus/.token` |
| `HOOKBUS_TIMEOUT_MS` | `60000` | ms to wait for bus verdict |
| `HOOKBUS_FAIL_MODE` | `closed` | `closed` = deny on bus failure, `open` = allow (dev only) |
| `HOOKBUS_SOURCE` | `openclaw` | Source label in event envelope |
| `OPENCLAW_SESSION_ID` | auto | Session identifier |

## Gateway deployment (IMPORTANT)

OpenClaw ships with a background **gateway** process that serves the TUI and `openclaw agent` commands. It runs as a systemd user service installed by `openclaw doctor --fix`. **The gateway does not inherit your shell env**, so you must pin HookBus credentials in its unit file or every event will silently 401 against the bus.

Create `~/.config/systemd/user/openclaw-gateway.service.d/hookbus.conf`:

```ini
[Service]
Environment="HOOKBUS_URL=http://localhost:18800/event"
Environment="HOOKBUS_TOKEN=<paste token here>"
Environment="HOOKBUS_FAIL_MODE=closed"
Environment="HOOKBUS_SOURCE=openclaw"
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway
systemctl --user is-active openclaw-gateway  # expect: active
```

If you rotate the bus token, you **must** update this file and restart the gateway — stale tokens produce silent 401s (events vanish upstream of the dashboards).

## Verify end-to-end

```bash
openclaw capability model run --prompt \"Reply with: PONG\"
# Expected: PONG

curl -s -H \"Authorization: Bearer $HOOKBUS_TOKEN\" http://localhost:8883/api/recent?limit=1
# Expected: latest event with source=openclaw, model=<your-model>
```

## Pairs with

- **HookBus Light** (Apache 2.0, free Docker) — bus broker
- **CRE-AgentProtect** (MIT) — Microsoft AGT adapter subscriber
- **HookBus-AgentSpend** (MIT) — token-cost subscriber
- **HookBus Enterprise** (commercial) — see [agenticthinking.uk](https://agenticthinking.uk).

## Licence

MIT. See LICENSE.
