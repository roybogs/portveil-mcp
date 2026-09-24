import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Portveil, resolveDevice, resolveLocation, nextLocation, PortveilError } from "../dist/portveil.js";

const SERVERS = [
  { id: "srv-us-1", name: "US West", region: "us" },
  { id: "srv-eu-1", name: "EU – Finland", region: "eu" },
];
const dev = (o) => ({ device_id: "dev_a", name: "Scraper box", platform: "linux", allow_remote: true, server_id: "srv-us-1",
  connected: true, exit_confirmed: true, quality: "good", handshake_age_s: 5, last_seen_s_ago: 3, ...o });

// A tiny fake Portveil API. `state` is mutated by commands like the real one.
function fakeApi({ remote = true, ackAfterPolls = 1, confirm = true } = {}) {
  const state = { devices: [dev({ allow_remote: remote }), dev({ device_id: "dev_b", name: "Phone", platform: "wireguard-app", allow_remote: false })],
    commands: {}, seen: [] };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.seen.push({ method: req.method, url: req.url, ua: req.headers["user-agent"], auth: req.headers.authorization });
      const send = (code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer clt_good" && req.headers.authorization !== "Bearer clt_read") return send(401, { detail: "invalid token" });
      const u = req.url;
      if (u === "/v1/servers") return send(200, { servers: SERVERS });
      if (u === "/v1/accounts/acct_0123456789abcdef/devices") return send(200, { devices: state.devices });
      if (u === "/v1/accounts/acct_0123456789abcdef") return send(200, { plan: "builder", device_limit: 25, device_count: 2 });
      let m = u.match(/^\/v1\/accounts\/acct_0123456789abcdef\/devices\/(dev_\w+)\/commands$/);
      if (m && req.method === "POST") {
        // Like the live API (scoped_auth_strict since 2026-09-24): read-only token → 403.
        if (req.headers.authorization === "Bearer clt_read") return send(403, { detail: "insufficient scope for this action" });
        const d = state.devices.find((x) => x.device_id === m[1]);
        if (!d.allow_remote) return send(409, { detail: { reason: "remote_disabled", command_id: "cmd_r" } });
        const b = JSON.parse(body);
        const id = `cmd_${Object.keys(state.commands).length + 1}`;
        state.commands[id] = { ...b, device: d, polls: 0 };
        return send(202, { command_id: id, status: "queued" });
      }
      m = u.match(/^\/v1\/accounts\/acct_0123456789abcdef\/commands\/(cmd_\w+)$/);
      if (m) {
        const c = state.commands[m[1]];
        c.polls += 1;
        if (c.polls >= ackAfterPolls) {
          if (c.type === "switch_server") { c.device.server_id = c.server_id; c.device.exit_confirmed = confirm; }
          return send(200, { command_id: m[1], status: "acked", result: "ok" });
        }
        return send(200, { command_id: m[1], status: c.polls === 1 ? "queued" : "delivered", result: null });
      }
      if (u.startsWith("/v1/accounts/acct_0123456789abcdef/audit-log")) return send(200, { entries: [{ action: "command:switch_server", device_id: "dev_a", issued_by: "api-token:t1", created_at: 1790280000 }] });
      send(404, { detail: "not found" });
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

const client = (base, token = "clt_good") => new Portveil({ apiBase: base, accountId: "acct_0123456789abcdef", token,
  sleep: async () => {}, ackTimeoutMs: 1000, confirmTimeoutMs: 50 });

test("device and location matching", () => {
  const devices = [dev(), dev({ device_id: "dev_b", name: "Scraper two" }), dev({ device_id: "dev_c", name: "MacBook" })];
  assert.equal(resolveDevice("macbook", devices).device_id, "dev_c");
  assert.equal(resolveDevice("dev_b", devices).device_id, "dev_b");
  assert.throws(() => resolveDevice("scraper", devices), /more than one device/);
  assert.throws(() => resolveDevice("toaster", devices), /No device matches "toaster"/);
  for (const q of ["Finland", "fi", "helsinki", "EU", "srv-eu-1", "europe"]) assert.equal(resolveLocation(q, SERVERS).id, "srv-eu-1", q);
  for (const q of ["US", "usa", "United States", "america"]) assert.equal(resolveLocation(q, SERVERS).id, "srv-us-1", q);
  assert.throws(() => resolveLocation("Japan", SERVERS), /No location matches "Japan"/);
});

test("rotation wraps and refuses when there's nowhere to go", () => {
  assert.equal(nextLocation("srv-us-1", SERVERS).id, "srv-eu-1");
  assert.equal(nextLocation("srv-eu-1", SERVERS).id, "srv-us-1");
  assert.equal(nextLocation(null, SERVERS).id, "srv-us-1");
  assert.throws(() => nextLocation("srv-us-1", [SERVERS[0]]), /only one location/);
});

test("move waits for the ack and the exit's confirmation", async () => {
  const { srv, state, base } = await fakeApi({ ackAfterPolls: 3 });
  try {
    const pv = client(base);
    const d = (await pv.devices())[0];
    const out = await pv.move(d, SERVERS[1]);
    assert.match(out, /now exits in Finland \(Helsinki\), confirmed/);
    assert.equal(state.devices[0].server_id, "srv-eu-1");
    assert.ok(state.seen.every((r) => r.ua.startsWith("portveil-mcp/")), "every request names itself (Cloudflare 1010)");
  } finally { srv.close(); }
});

test("move is honest when the exit hasn't confirmed", async () => {
  const { srv, base } = await fakeApi({ confirm: false });
  try {
    const pv = client(base);
    assert.match(await pv.move((await pv.devices())[0], SERVERS[1]), /hasn't confirmed the connection yet/);
  } finally { srv.close(); }
});

test("clear errors for remote off, WireGuard app, read-only token, bad token", async () => {
  const { srv, base } = await fakeApi({ remote: false });
  try {
    const pv = client(base);
    const [box, phone] = await pv.devices();
    await assert.rejects(pv.move(box, SERVERS[1]), /remote control turned off/);
    await assert.rejects(pv.move(phone, SERVERS[1]), /WireGuard app/);
    await assert.rejects(client(base, "clt_read").runCommand(dev(), "reconnect"), /needs a token with "control" scope/);
    await assert.rejects(client(base, "clt_bad").devices(), (e) => e instanceof PortveilError && /rejected the token/.test(e.message));
  } finally { srv.close(); }
});

test("the MCP server lists its tools and answers through the protocol", async () => {
  const { srv, state, base } = await fakeApi();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { ...process.env, PORTVEIL_ACCOUNT_ID: "acct_0123456789abcdef", PORTVEIL_TOKEN: "clt_good", PORTVEIL_API: base } });
  const c = new Client({ name: "test", version: "1" });
  try {
    await c.connect(transport);
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["account_info", "device_status", "disconnect_device", "list_devices",
      "list_locations", "move_device", "recent_activity", "reconnect_device", "rotate_device"]);
    assert.equal(tools.find((t) => t.name === "disconnect_device").annotations.destructiveHint, true);
    const list = await c.callTool({ name: "list_devices", arguments: {} });
    assert.match(list.content[0].text, /Scraper box \[dev_a\] \(linux\): protected, exiting in United States/);
    assert.match(list.content[0].text, /view only \(WireGuard app\)/);
    const moved = await c.callTool({ name: "rotate_device", arguments: { device: "scraper" } });
    assert.equal(moved.isError, undefined, moved.content[0].text);
    assert.match(moved.content[0].text, /now exits in Finland/);
    assert.equal(state.devices[0].server_id, "srv-eu-1");
    const bad = await c.callTool({ name: "move_device", arguments: { device: "toaster", location: "US" } });
    assert.equal(bad.isError, true);
    assert.match((await c.callTool({ name: "recent_activity", arguments: {} })).content[0].text, /command:switch_server {2}Scraper box/);
  } finally { await c.close(); srv.close(); }
});
