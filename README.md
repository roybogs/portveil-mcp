# Portveil MCP server

Let an AI assistant see the devices on your [Portveil](https://portveil.com) account and move them between VPN locations.

> "Move my scraper box to Finland."
> "Rotate every agent to a new location."
> "Which of my devices aren't protected right now?"
> "Rotate the scraper between the US and Finland every 15 minutes."

Moves are verified: a tool only reports success after the device has switched **and** the exit server in the new location confirms it sees that device.

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `list_devices` | Every device: protected or not, where it exits, live speed (↓/↑ Mbps), remote control on/off | read |
| `list_locations` | The locations you can move to | read |
| `get_device` | One device's current state, including live speed and any rotation | read |
| `get_account` | Plan and devices used | read |
| `list_activity` | Recent moves, reconnects and changes, and which token made them | read |
| `move_device` | Move a device to a country or city ("Finland", "US", "Helsinki") | control |
| `rotate_device` | Move a device once to the next location | control |
| `start_rotation` | Move a device automatically every N minutes (5–10080), optionally among chosen locations. Portveil runs the schedule, so the assistant can close | control |
| `stop_rotation` | Turn scheduled rotation off | control |
| `reconnect_device` | Re-establish a device's tunnel | control |
| `disconnect_device` | Turn a device's VPN off (flagged destructive: a hint that tells well-behaved assistants to check with you first) | control |
| `update_device` | Rename a device and/or turn its remote control on or off | admin |
| `remove_device` | Remove a device for good (flagged destructive) | admin |

Tool names changed in 0.3.0 to one verb_noun pattern: `device_status` → `get_device`, `account_info` → `get_account`, `recent_activity` → `list_activity`, `set_rotation` → `start_rotation`.

Devices can be named loosely ("scraper" finds "Scraper box"); an ambiguous name returns the choices instead of guessing.

## Setup

1. In the [Portveil dashboard](https://portveil.com/dashboard/), create an **API token**. Choose **control** scope to let the assistant move devices, or **read** to let it only look. Don't give it your account key.
2. Note your account ID (`acct_…`).
3. Add the server to your assistant:

**Claude Code**
```bash
claude mcp add portveil -e PORTVEIL_ACCOUNT_ID=acct_… -e PORTVEIL_TOKEN=clt_… -- npx -y portveil-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and most other clients:
```json
{
  "mcpServers": {
    "portveil": {
      "command": "npx",
      "args": ["-y", "portveil-mcp"],
      "env": { "PORTVEIL_ACCOUNT_ID": "acct_…", "PORTVEIL_TOKEN": "clt_…" }
    }
  }
}
```

Devices must be running the Portveil app or the Portveil agent with remote control on. Devices using the plain WireGuard app are shown but can't be moved.

## Security

- Use a scoped API token. Every action it takes is recorded in your account's activity log with the token that made it, and you can revoke it in the dashboard at any time.
- The server talks only to `https://api.portveil.com` (override with `PORTVEIL_API`). It stores nothing.

## Development

```bash
npm install
npm test        # builds, then runs the tests against a fake Portveil API
```
