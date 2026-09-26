#!/usr/bin/env node
// Portveil MCP server (stdio). Lets an AI assistant see the devices on a
// Portveil account and move them between VPN locations.
//
// Configuration (environment):
//   PORTVEIL_ACCOUNT_ID  acct_…  (dashboard → Settings)
//   PORTVEIL_TOKEN       an API token from the dashboard. "read" scope can look;
//                        "control" scope can also move, reconnect and disconnect.
//   PORTVEIL_API         optional, defaults to https://api.portveil.com

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  Portveil, PortveilError, VERSION, agentSetup, describeDevice, wgConfig, wgKeypair, isWaiting, locationLabel, nextLocation, resolveDevice, resolveLocation,
} from "./portveil.js";

const accountId = process.env.PORTVEIL_ACCOUNT_ID?.trim() ?? "";
const token = process.env.PORTVEIL_TOKEN?.trim() ?? "";
if (!/^acct_[0-9a-f]{16}$/.test(accountId) || !token) {
  console.error("portveil-mcp: set PORTVEIL_ACCOUNT_ID (acct_…) and PORTVEIL_TOKEN (an API token from https://portveil.com/dashboard/).");
  process.exit(1);
}
if (token.startsWith("cla_")) {
  console.error("portveil-mcp: warning: that's your account key. Create a scoped API token in the dashboard instead, so an assistant never holds full access.");
}

const apiBase = (process.env.PORTVEIL_API || "https://api.portveil.com").replace(/\/+$/, "");
const pv = new Portveil({ apiBase, accountId, token });
const server = new McpServer({ name: "portveil", version: VERSION });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
async function run(fn: () => Promise<string>): Promise<Result> {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof PortveilError ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const deviceArg = z.string().min(1).describe('Which device: its name, a unique part of its name (e.g. "scraper"), or its device ID (dev_…). Case-insensitive. Get names and IDs from list_devices.');

// Tool names follow one verb_noun pattern: list_*, get_*, and an action verb + device/rotation.
// Scopes: "read" tokens can use the list_/get_ tools; "control" adds moving, rotating, reconnecting
// and disconnecting; "admin" adds adding, renaming, remote-control settings and removal.

server.registerTool("list_devices", {
  title: "List devices",
  description: "List every device on the Portveil account, one line each: whether it's protected (connected AND confirmed by the exit server), which country it exits from, its live download/upload speed while connected, and whether it accepts remote control. Use this first to see what's there or to find a device's exact name; use get_device for one device. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  if (devices.length === 0) return "No devices on this account yet. Add one at https://portveil.com/start/";
  return devices.map((d) => "- " + describeDevice(d, servers)).join("\n");
}));

server.registerTool("list_locations", {
  title: "List locations",
  description: "List the exit locations (country, city and location ID) that devices can be moved to. Use it before move_device or start_rotation when you're unsure what's available. Every plan can use every location. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => (await pv.servers()).map((s) => `- ${locationLabel(s)} [${s.id}]`).join("\n")));

server.registerTool("get_device", {
  title: "Get device",
  description: "Get one device's current state: online or offline, the location it exits from, whether that exit server confirms the tunnel, its live speed, any rotation schedule, and when it last reported. Use it to check a device before or after an action. Read-only.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  const d = resolveDevice(device, devices);
  const seen = d.last_seen_s_ago == null ? "never" : `${Math.round(d.last_seen_s_ago)}s ago`;
  return `${describeDevice(d, servers)}\nLast report: ${seen}.${d.status_detail ? `\n${d.status_detail}` : ""}`;
}));

server.registerTool("get_account", {
  title: "Get account",
  description: "Get the account's plan and how many devices it uses out of its limit. Use it when asked about the plan or before suggesting adding devices. Read-only.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => {
  const a = await pv.account();
  return `Plan: ${a.plan ?? "none"}. Devices: ${a.device_count}${a.device_limit ? ` of ${a.device_limit}` : ""}.`;
}));

server.registerTool("list_activity", {
  title: "List activity",
  description: "List recent actions on the account (moves, reconnects, rotations, renames, tokens created), newest first, with the token that made each. Use it to answer \"what changed?\" or to audit an assistant's actions. Read-only.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("How many entries to return, newest first (1–100, default 20)") },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ limit }) => run(async () => {
  const [{ entries }, devices] = await Promise.all([pv.audit(limit), pv.devices()]);
  if (entries.length === 0) return "No activity yet.";
  const name = (id: string | null) => (id ? devices.find((d) => d.device_id === id)?.name ?? id : "account");
  return entries.map((e) => `- ${new Date(e.created_at * 1000).toISOString().replace(".000Z", "Z")}  ${e.action}  ${name(e.device_id)}  (by ${e.issued_by})`).join("\n");
}));

server.registerTool("move_device", {
  title: "Move device",
  description: "Move a device's traffic to exit from a chosen location. Waits until the device switches and the new exit server confirms it (usually 10–30 s), and says plainly if that didn't happen. Safe to repeat: moving to where it already is does nothing. Only works on machines running the Portveil agent with remote control on (phones using the WireGuard app switch on the device itself). Needs a control-scope token. To just go somewhere different, use rotate_device.",
  inputSchema: {
    device: deviceArg,
    location: z.string().min(1).describe('Where to exit: a country, city or region ("Finland", "US", "Helsinki") or a location ID from list_locations (e.g. srv-eu-1)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device, location }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  return pv.move(resolveDevice(device, devices), resolveLocation(location, servers));
}));

server.registerTool("rotate_device", {
  title: "Rotate device",
  description: "Move a device once to the next location in the list, so its traffic exits from somewhere new. Same checks and waiting as move_device. Each call moves again, so it isn't idempotent. For repeated automatic moves use start_rotation instead. Needs a control-scope token.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, ({ device }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  const d = resolveDevice(device, devices);
  return pv.move(d, nextLocation(d.server_id, servers));
}));

server.registerTool("start_rotation", {
  title: "Start rotation",
  description: "Make Portveil move a device to the next location automatically every N minutes, optionally cycling through chosen locations only. Portveil runs the schedule itself, so the assistant doesn't need to stay running. Calling it again replaces the schedule. Stop it with stop_rotation. Needs a control-scope token and a Portveil-agent device.",
  inputSchema: {
    device: deviceArg,
    every_minutes: z.number().int().min(5).max(10080).describe("Minutes between moves: 5 to 10080 (one week)"),
    locations: z.array(z.string().min(1)).optional().describe('Locations to cycle through, e.g. ["US", "Finland"]; at least two. Omit to cycle through every location.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device, every_minutes, locations }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  const d = resolveDevice(device, devices);
  const chosen = locations?.map((l) => resolveLocation(l, servers));
  const r = await pv.setRotation(d.device_id, every_minutes, chosen?.map((s) => s.id));
  const where = chosen ? chosen.map(locationLabel).join(" → ") : "every location";
  const next = r.next_rotation_at ? ` First move around ${new Date(r.next_rotation_at * 1000).toISOString().replace(".000Z", "Z")}.` : "";
  return `${d.name} will now move every ${every_minutes} minutes, cycling through ${where}.${next}`;
}));

server.registerTool("stop_rotation", {
  title: "Stop rotation",
  description: "Turn off a device's automatic rotation. The device stays at its current location. Safe to call when no rotation is set. Needs a control-scope token.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const d = resolveDevice(device, await pv.devices());
  await pv.setRotation(d.device_id, null);
  return `${d.name} will no longer rotate automatically. It stays where it is.`;
}));

server.registerTool("reconnect_device", {
  title: "Reconnect device",
  description: "Tell a device to re-establish its VPN tunnel at its current location, without moving it. Use when it shows connected but not confirmed, or traffic seems stuck. Traffic may pause for a few seconds. Needs a control-scope token and a Portveil-agent device.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const d = resolveDevice(device, await pv.devices());
  const st = await pv.runCommand(d, "reconnect");
  if (st.status === "acked") return `${d.name} reconnected.`;
  if (isWaiting(st.status)) return `Sent. ${d.name} hasn't picked it up yet (it may be offline).`;
  return `${d.name} did not reconnect: ${st.status}${st.result ? ` (${st.result})` : ""}.`;
}));

server.registerTool("disconnect_device", {
  title: "Disconnect device",
  description: "Turn off a device's VPN tunnel. Its traffic stops going through Portveil (and loses VPN protection) until it reconnects. The device stays on the account. Confirm with the user first. Needs a control-scope token and a Portveil-agent device.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const d = resolveDevice(device, await pv.devices());
  const st = await pv.runCommand(d, "disconnect");
  if (st.status === "acked") return `${d.name} is disconnected. Its traffic no longer goes through Portveil.`;
  if (isWaiting(st.status)) return `Sent. ${d.name} hasn't picked it up yet (it may be offline).`;
  return `${d.name} did not disconnect: ${st.status}${st.result ? ` (${st.result})` : ""}.`;
}));

server.registerTool("add_device", {
  title: "Add device",
  description: "Add a new device to the account. kind \"phone_or_computer\" (iPhone, Android, Mac, Windows using the WireGuard app): creates the device now and saves one WireGuard tunnel file per location, with a private key made locally, into a folder on the machine running this MCP server; the key is never shown in the reply. Import a file in the WireGuard app to connect. These devices are view-only: they can't be moved remotely. kind \"linux_machine\" (a server or the machine an agent runs on): returns the exact commands to run as root on that machine; it makes its own key and registers itself, and can then be moved, rotated and switched with the other tools. Uses one device slot (see get_account). Needs an admin-scope token for phone_or_computer.",
  inputSchema: {
    name: z.string().trim().min(1).max(64).describe('Display name for the new device, e.g. "Miguel iPhone" or "scraper-box"'),
    kind: z.enum(["phone_or_computer", "linux_machine"]).describe("phone_or_computer: WireGuard app on a phone or laptop. linux_machine: a Linux server or agent machine running the Portveil agent"),
    temporary_minutes: z.number().int().min(5).max(43200).optional().describe("phone_or_computer only: delete the device automatically after this many minutes (5 to 43200, i.e. 30 days). Omit for a permanent device"),
    folder: z.string().min(1).optional().describe("phone_or_computer only: folder to save the tunnel files in. Default ~/Portveil/<name>"),
    split_tunnel: z.boolean().optional().describe("linux_machine only: default true, so a remote server keeps its SSH session. false sends all of its traffic through Portveil"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, ({ name, kind, temporary_minutes, folder, split_tunnel }) => run(async () => {
  const acct = await pv.account();
  const slots = acct.device_limit === null ? "" : ` (${acct.device_count} of ${acct.device_limit} devices used)`;
  if (acct.device_limit !== null && acct.device_count >= acct.device_limit) {
    throw new PortveilError(`The plan's device limit is reached${slots}. Remove a device or upgrade first.`);
  }
  if (kind === "linux_machine") {
    return `Run these as root on the machine you're adding. It makes its own VPN key, so this can't be done from here. The token prompt doesn't echo; use an admin-scope API token or the account key, and never paste it into a chat.\n\n` +
      agentSetup(apiBase, accountId, name, split_tunnel ?? true) +
      `\n\nThe daemon keeps running; install it as a service to survive reboots. "${name}" then appears in list_devices, and can be moved once its exit confirms it${slots}.`;
  }
  const dir = resolve(folder?.replace(/^~(?=$|\/)/, homedir()) ?? join(homedir(), "Portveil", name.replace(/[^\w .-]+/g, "_")));
  const k = wgKeypair();
  const d = await pv.addDevice(name, "wireguard-app", k.pub, false, temporary_minutes);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const s of d.servers) {
    const addr = d.addresses[s.id];
    if (!addr) continue;
    const file = join(dir, `Portveil-${locationLabel(s).replace(/[^\w .()-]+/g, "_")}.conf`);
    await writeFile(file, wgConfig(k.priv, addr, s), { mode: 0o600 });
    files.push(file);
  }
  const expires = d.expires_at ? ` It deletes itself at ${new Date(d.expires_at * 1000).toISOString().replace(".000Z", "Z")}.` : "";
  return `Added "${name}" [${d.device_id}].${expires} Its tunnel files are saved on the machine running this MCP server, one per location:\n` +
    files.map((f) => `- ${f}`).join("\n") +
    `\n\nOn a Mac or PC: WireGuard → Import tunnel(s) from file. On a phone: send the files to it (AirDrop, or save to Files) and open them with WireGuard. The files hold the device's private key: keep them private and delete copies once imported. Switch countries by turning on a different tunnel in the app.`;
}));

server.registerTool("update_device", {
  title: "Update device",
  description: "Rename a device and/or turn remote control on or off for it. Turning remote control off stops move, rotate, reconnect and disconnect for that device until it's turned back on. Change only what's given; safe to repeat. Needs an admin-scope token.",
  inputSchema: {
    device: deviceArg,
    name: z.string().min(1).max(64).optional().describe("New display name, 1–64 characters"),
    remote_control: z.boolean().optional().describe("true lets tokens move and control this device; false blocks it"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device, name, remote_control }) => run(async () => {
  if (name === undefined && remote_control === undefined) throw new PortveilError("Nothing to change: give a new name, remote_control, or both.");
  const d = resolveDevice(device, await pv.devices());
  const u = await pv.updateDevice(d.device_id, { name, allow_remote: remote_control });
  const parts = [name !== undefined ? `renamed to "${u.name ?? name}"` : "", remote_control !== undefined ? `remote control ${remote_control ? "on" : "off"}` : ""].filter(Boolean);
  return `${d.name}: ${parts.join(", ")}.`;
}));

server.registerTool("remove_device", {
  title: "Remove device",
  description: "Permanently remove a device from the account: its VPN key stops working at every exit and its slot is freed. It can't be undone; the device would have to be set up again. Confirm with the user first, naming the device. Needs an admin-scope token.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, ({ device }) => run(async () => {
  const d = resolveDevice(device, await pv.devices());
  await pv.removeDevice(d.device_id);
  return `${d.name} was removed from the account. Its VPN key no longer works.`;
}));

await server.connect(new StdioServerTransport());
