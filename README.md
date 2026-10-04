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
| `add_device` | Add a device. Phones and laptops (WireGuard app): creates it and saves its tunnel files locally, key never shown in chat. Linux servers and agent machines: gives the exact commands to run on that machine, which makes its own key and registers itself | admin (phones/laptops) |
| `update_device` | Rename a device and/or turn its remote control on or off | admin |
| `remove_device` | Remove a device for good (flagged destructive) | admin |

Tool names changed in 0.3.0 to one verb_noun pattern: `device_status` → `get_device`, `account_info` → `get_account`, `recent_activity` → `list_activity`, `set_rotation` → `start_rotation`.

Devices can be named loosely ("scraper" finds "Scraper box"); an ambiguous name returns the choices instead of guessing.

## Setup

No account yet? [Start free](https://portveil.com/free/) with just an email, no card.

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

**Hermes Agent**: Hermes only installs npm packages older than 14 days, so install into its own folder and run it with node:
```bash
cd ~ && npm install --prefix ~/.hermes/mcp-servers/portveil portveil-mcp@0.4.3
echo 'PORTVEIL_TOKEN=clt_…' >> ~/.hermes/.env
hermes mcp add portveil --command node \
  --env PORTVEIL_ACCOUNT_ID=acct_… 'PORTVEIL_TOKEN=${PORTVEIL_TOKEN}' \
  --args ~/.hermes/mcp-servers/portveil/node_modules/portveil-mcp/dist/index.js
```
For Hermes to use it well (when to act, what to confirm first, how to add devices), also install the Portveil skill from [ClawHub](https://clawhub.ai/roybogs/portveil):
```bash
hermes skills install roybogs/portveil
```
(Source: [`skills/portveil/SKILL.md`](skills/portveil/SKILL.md).)

Devices must be running the Portveil app or the Portveil agent with remote control on. Devices using the plain WireGuard app are shown but can't be moved.

## Security

- Use a scoped API token. Every action it takes is recorded in your account's activity log with the token that made it, and you can revoke it in the dashboard at any time.
- The server defaults to `https://api.portveil.com`; `PORTVEIL_API` overrides must use HTTPS (HTTP is accepted only for loopback fixtures). Redirects are refused; requests time out after 15 seconds and mutations are not automatically retried.
- It does not persist the account/API token. `add_device` deliberately stores newly generated device keys and tunnel files in a new private directory; they are never included in tool replies. Existing folders and files are never reused or overwritten.
- “Protected”/move/reconnect confirmation requires connected status, a fresh handshake and exit confirmation, with observations aged from their actual receipt. This is tunnel evidence, **not DNS privacy proof**. An exit IP, resolver list, or simulator UI alone is insufficient.

## Local device recovery

For phone/computer provisioning, choose a **new** folder. It is created with mode 0700, with 0600 `private-key`, `device.json` and per-exit `.conf` files. The key is saved and synced **before** registration; registration metadata excludes the device token. If registration's response is lost or export fails, the reply identifies the retained recovery directory and (when known) the exact device ID. Check `list_devices`/the dashboard before adding another device: the server may have committed the first registration. No automatic device deletion or blind retry occurs.

Back up the whole private directory securely. Restore into a separate private directory and verify file permissions, device ID, and that the private key derives the registered public key. `device.json` plus `private-key` can regenerate the configs using the existing `wgConfig` helper; no new registration is needed. `npm test` exercises actual fixture backup/restore, byte-identical config regeneration, interrupted registration and symlink/write failures. This does **not** establish that production infrastructure backups are current or restorable.

Linux setup instructions are Bash commands, not actions executed by this server. Full tunnel is designed to preserve inbound connections, but verify SSH and DNS separately in an approved isolated environment. Split tunnel reaches only Portveil's internal network: internet traffic is **not protected**. Never use setup commands to switch a working remote machine without independent management access and a guarded rollback plan.

## Development

```bash
npm install
npm test        # builds, then runs the tests against a fake Portveil API
```
