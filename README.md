# @agentic-thinking/hookbus-publisher-openclaw

OpenClaw publisher plugin for **HookBus**, the vendor-neutral runtime governance bus for AI agents. Forwards OpenClaw lifecycle events (`before_tool_call`, `after_tool_call`, `llm_output`) to a HookBus endpoint and enforces the consolidated decision on tool calls. **Fail-closed by default** — bus unreachable means deny.

## Install (60 seconds)

One shell command installs the full HookBus stack and this OpenClaw publisher plugin. For the OpenClaw-specific path, use the `--runtime openclaw` flag below.

```bash
curl -fsSL https://hookbus.com/install.sh | bash
```

Non-interactive variants:

```bash
# OpenClaw users
curl -fsSL https://hookbus.com/install.sh | bash -s -- --runtime openclaw

# Hermes-agent users
curl -fsSL https://hookbus.com/install.sh | bash -s -- --runtime hermes

# Bus + subscribers only, skip publisher
curl -fsSL https://hookbus.com/install.sh | bash -s -- --runtime skip --noninteractive
```

The script prints the bus API URL + bearer token on completion. Re-run any time, it is idempotent.

_Prefer not to pipe curl to bash? Inspect first:_ `curl -fsSL https://hookbus.com/install.sh > install.sh && less install.sh && bash install.sh`

---

## Manual install

If you prefer to see every step, or you are building an immutable / reproducible deployment, here is the full manual install.

The installer writes the plugin into `~/.openclaw/extensions/cre/` and stores HookBus credentials in `hookbus.env`, so normal `openclaw` and the OpenClaw gateway can load the publisher:

```bash
git clone https://github.com/agentic-thinking/hookbus-publisher-openclaw
cd hookbus-publisher-openclaw
./install.sh
```

Verify it loaded:

```bash
openclaw plugins list | grep cre
# Expected: HookBus Publisher | cre | loaded | ... | 0.5.1
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

OpenClaw ships with a background **gateway** process that serves the TUI and `openclaw agent` commands. The installer configures `gateway.mode=local`, installs/starts the systemd user service, and pins HookBus credentials in a service drop-in. If you rotate the bus token manually, update `~/.config/systemd/user/openclaw-gateway.service.d/hookbus.conf`:

```ini
[Service]
Environment="HOOKBUS_URL=http://localhost:18800/event"
Environment="HOOKBUS_TOKEN=<paste token here>"
Environment="HOOKBUS_FAIL_MODE=closed"
Environment="HOOKBUS_SOURCE=openclaw"
```

Then run `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`. Stale tokens produce 401s and events will not reach HookBus.

## Model auth is separate

This publisher wires OpenClaw events into HookBus. It does not configure OpenClaw's model provider credentials. Configure OpenClaw normally first, then install this publisher.

If `openclaw tui` reports a missing Anthropic key even though you use Kimi or another provider, check for stale OpenClaw session/default model state. The active model should match your configured provider, for example `kimi-coding/k2p5`, before you test HookBus events.

## Verify end-to-end

```bash
openclaw capability model run --prompt \"Reply with: PONG\"
# Expected: PONG

curl -s -H \"Authorization: Bearer $HOOKBUS_TOKEN\" http://localhost:18800/api/events
# Expected: recent event with source=openclaw
```

## Pairs with

- **HookBus Light** (Apache 2.0, free Docker) — bus broker
- **CRE-AgentProtect Light** (MIT) — Microsoft AGT adapter subscriber
- **HookBus Enterprise** (commercial) — see [agenticthinking.uk](https://agenticthinking.uk).

## Licence

MIT. See LICENSE.
