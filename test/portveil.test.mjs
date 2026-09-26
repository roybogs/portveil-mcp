import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { wgKeypair, agentSetup, Portveil, resolveDevice, resolveLocation, nextLocation, PortveilError, describeDevice } from "../dist/portveil.js";

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
      if (!["Bearer clt_good", "Bearer clt_read", "Bearer clt_admin"].includes(req.headers.authorization)) return send(401, { detail: "invalid token" });
      const u = req.url;
      if (u === "/v1/servers") return send(200, { servers: SERVERS });
      if (u === "/v1/accounts/acct_0123456789abcdef/devices" && req.method === "GET") return send(200, { devices: state.devices });
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
      if (u === "/v1/accounts/acct_0123456789abcdef/devices" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer clt_admin") return send(401, { detail: "invalid token" });
        const b = JSON.parse(body);
        state.registered = b;
        state.devices.push(dev({ device_id: "dev_new", name: b.name, platform: b.platform, allow_remote: b.allow_remote, connected: false }));
        return send(201, { device_id: "dev_new", device_token: "cld_x", expires_at: b.ttl_minutes ? 1790300000 : null,
          addresses: { "srv-us-1": "10.8.0.9/32", "srv-eu-1": "10.9.0.9/32" },
          servers: SERVERS.map((x, i) => ({ ...x, endpoint_host: `exit${i}.example`, endpoint_port: 51820, pubkey: `PUB${i}=`, health_url: "" })) });
      }
      m = u.match(/^\/v1\/accounts\/acct_0123456789abcdef\/devices\/(dev_\w+)$/);
      if (m && (req.method === "PATCH" || req.method === "DELETE")) {
        if (req.headers.authorization !== "Bearer clt_admin") return send(403, { detail: "insufficient scope for this action" });
        const i = state.devices.findIndex((x) => x.device_id === m[1]);
        if (req.method === "DELETE") { state.devices.splice(i, 1); res.writeHead(204); return res.end(); }
        const b = JSON.parse(body);
        if (b.name !== undefined) state.devices[i].name = b.name;
        if (b.allow_remote !== undefined) state.devices[i].allow_remote = b.allow_remote;
        return send(200, { device_id: m[1], name: state.devices[i].name, allow_remote: state.devices[i].allow_remote });
      }
      m = u.match(/^\/v1\/accounts\/acct_0123456789abcdef\/devices\/(dev_\w+)\/rotation$/);
      if (m && req.method === "PUT") {
        const d = state.devices.find((x) => x.device_id === m[1]);
        const b = JSON.parse(body);
        if (b.every_minutes !== null && (b.servers?.length ?? 2) < 2) return send(400, { detail: "rotation needs at least two locations" });
        d.rotation = b.every_minutes === null ? null : { every_minutes: b.every_minutes, servers: b.servers ?? null };
        return send(200, { device_id: d.device_id, rotation: d.rotation, next_rotation_at: b.every_minutes === null ? null : 1790300000 });
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

test("device descriptions include live speed only while connected", () => {
  const speed = { server_id: "srv-us-1", down_mbps: 42.34, up_mbps: 6.1, measured_at: 1 };
  assert.match(describeDevice(dev({ speed }), SERVERS), /speed ↓ 42\.3 Mbps ↑ 6\.1 Mbps/);
  assert.match(describeDevice(dev({ speed: { ...speed, down_mbps: 0, up_mbps: 0.04 } }), SERVERS), /speed idle/);
  assert.doesNotMatch(describeDevice(dev({ speed: null }), SERVERS), /speed/);
  assert.doesNotMatch(describeDevice(dev({ connected: false, speed }), SERVERS), /speed/);
  assert.doesNotMatch(describeDevice(dev({}), SERVERS), /speed/); // older API without the field
});

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
    assert.deepEqual(tools.map((t) => t.name).sort(), ["add_device", "disconnect_device", "get_account", "get_device", "list_activity",
      "list_devices", "list_locations", "move_device", "reconnect_device", "remove_device", "rotate_device", "start_rotation",
      "stop_rotation", "update_device"]);
    for (const t of tools) assert.match(t.name, /^[a-z]+_[a-z]+$/, `verb_noun: ${t.name}`);
    assert.equal(tools.find((t) => t.name === "remove_device").annotations.destructiveHint, true);
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
    assert.match((await c.callTool({ name: "list_activity", arguments: {} })).content[0].text, /command:switch_server {2}Scraper box/);
    const sched = await c.callTool({ name: "start_rotation", arguments: { device: "scraper", every_minutes: 15, locations: ["US", "Finland"] } });
    assert.equal(sched.isError, undefined, sched.content[0].text);
    assert.match(sched.content[0].text, /every 15 minutes, cycling through United States \(US West\) → Finland \(Helsinki\)/);
    assert.deepEqual(state.devices[0].rotation, { every_minutes: 15, servers: ["srv-us-1", "srv-eu-1"] });
    assert.match((await c.callTool({ name: "list_devices", arguments: {} })).content[0].text, /rotates every 15 min/);
    const tooFew = await c.callTool({ name: "start_rotation", arguments: { device: "scraper", every_minutes: 15, locations: ["US"] } });
    assert.equal(tooFew.isError, true);
    assert.match(tooFew.content[0].text, /at least two locations/);
    assert.match((await c.callTool({ name: "stop_rotation", arguments: { device: "scraper" } })).content[0].text, /no longer rotate/);
    assert.equal(state.devices[0].rotation, null);
  } finally { await c.close(); srv.close(); }
});

test("rename, remote control and removal need an admin token and say so", async () => {
  const { srv, state, base } = await fakeApi();
  const start = (token) => new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { ...process.env, PORTVEIL_ACCOUNT_ID: "acct_0123456789abcdef", PORTVEIL_TOKEN: token, PORTVEIL_API: base } });
  const control = new Client({ name: "test", version: "1" });
  const admin = new Client({ name: "test", version: "1" });
  try {
    await control.connect(start("clt_good"));
    const refused = await control.callTool({ name: "remove_device", arguments: { device: "scraper" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /"admin" scope/);
    assert.equal(state.devices.length, 2);
    await admin.connect(start("clt_admin"));
    const nothing = await admin.callTool({ name: "update_device", arguments: { device: "scraper" } });
    assert.equal(nothing.isError, true);
    const upd = await admin.callTool({ name: "update_device", arguments: { device: "scraper", name: "Crawler", remote_control: false } });
    assert.equal(upd.isError, undefined, upd.content[0].text);
    assert.match(upd.content[0].text, /renamed to "Crawler", remote control off/);
    assert.equal(state.devices[0].name, "Crawler");
    assert.equal(state.devices[0].allow_remote, false);
    const gone = await admin.callTool({ name: "remove_device", arguments: { device: "crawler" } });
    assert.match(gone.content[0].text, /was removed/);
    assert.deepEqual(state.devices.map((d) => d.device_id), ["dev_b"]);
  } finally { await control.close(); await admin.close(); srv.close(); }
});

test("WireGuard keys are a real X25519 pair", () => {
  const { priv, pub } = wgKeypair();
  assert.equal(Buffer.from(priv, "base64").length, 32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(priv, "base64")]);
  const derivedPub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  assert.equal(derivedPub.subarray(-32).toString("base64"), pub);
});

test("agent setup commands quote the name and verify the download", () => {
  const cmd = agentSetup("https://api.portveil.com", "acct_0123456789abcdef", "Bob's box", true);
  assert.match(cmd, /sha256sum -c -/);
  assert.match(cmd, /--name 'Bob'\\''s box' --split-tunnel/);
  assert.doesNotMatch(agentSetup("https://api.portveil.com", "acct_0123456789abcdef", "x", false), /split-tunnel/);
});

test("add_device saves private tunnel files for apps and gives Linux the setup commands", async () => {
  const { srv, state, base } = await fakeApi();
  const start = (token) => new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { ...process.env, PORTVEIL_ACCOUNT_ID: "acct_0123456789abcdef", PORTVEIL_TOKEN: token, PORTVEIL_API: base } });
  const control = new Client({ name: "test", version: "1" });
  const admin = new Client({ name: "test", version: "1" });
  const dir = join(await mkdtemp(join(tmpdir(), "pv-")), "phone");
  try {
    await control.connect(start("clt_good"));
    const refused = await control.callTool({ name: "add_device", arguments: { name: "Phone 2", kind: "phone_or_computer", folder: dir } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /"admin" scope/);
    const linux = await control.callTool({ name: "add_device", arguments: { name: "scraper-2", kind: "linux_machine" } });
    assert.equal(linux.isError, undefined, linux.content[0].text);
    assert.match(linux.content[0].text, /--account-id acct_0123456789abcdef --name 'scraper-2' --split-tunnel/);
    assert.equal(state.registered, undefined, "linux setup must not register from here");

    await admin.connect(start("clt_admin"));
    const added = await admin.callTool({ name: "add_device", arguments: { name: "Phone 2", kind: "phone_or_computer", folder: dir, temporary_minutes: 60 } });
    assert.equal(added.isError, undefined, added.content[0].text);
    assert.deepEqual({ ...state.registered, peer_pubkey: undefined }, { name: "Phone 2", platform: "wireguard-app", allow_remote: false, ttl_minutes: 60, peer_pubkey: undefined });
    assert.doesNotMatch(added.content[0].text, /PrivateKey/);
    const us = join(dir, "Portveil-United States (US West).conf");
    assert.ok(added.content[0].text.includes(us));
    const conf = await readFile(us, "utf8");
    assert.match(conf, /Address = 10\.8\.0\.9\/32/);
    assert.match(conf, /Endpoint = exit0\.example:51820/);
    const key = conf.match(/PrivateKey = (.+)/)[1];
    assert.doesNotMatch(added.content[0].text, new RegExp(key.replace(/[+/=]/g, "\\$&")));
    assert.equal((await stat(us)).mode & 0o777, 0o600);
    assert.match(await readFile(join(dir, "Portveil-Finland (Helsinki).conf"), "utf8"), /PublicKey = PUB1=/);
  } finally { await control.close(); await admin.close(); srv.close(); }
});

test("an idle WireGuard-app device reads as idle, not unconfirmed", () => {
  const d = dev({ platform: "wireguard-app", quality: "fair", server_id: "srv-eu-1" });
  assert.match(describeDevice(d, SERVERS), /idle: tunnel to Finland \(Helsinki\) confirmed but no traffic/);
});
