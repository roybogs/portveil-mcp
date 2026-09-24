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
import {
  Portveil, PortveilError, VERSION, describeDevice, isWaiting, locationLabel, nextLocation, resolveDevice, resolveLocation,
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

const pv = new Portveil({ apiBase: process.env.PORTVEIL_API || "https://api.portveil.com", accountId, token });
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

const deviceArg = z.string().min(1).describe('Device name (or part of it, e.g. "scraper") or its device ID (dev_…)');

server.registerTool("list_devices", {
  title: "List devices",
  description: "List every device on the Portveil account: whether each is protected, which country its traffic exits from, and whether it accepts remote control.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  if (devices.length === 0) return "No devices on this account yet. Add one at https://portveil.com/start/";
  return devices.map((d) => "- " + describeDevice(d, servers)).join("\n");
}));

server.registerTool("list_locations", {
  title: "List locations",
  description: "List the VPN exit locations (countries) a device can be moved to.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => (await pv.servers()).map((s) => `- ${locationLabel(s)} [${s.id}]`).join("\n")));

server.registerTool("device_status", {
  title: "Device status",
  description: "Show one device's current state: connected or not, the location it exits from, and whether the exit server confirms it.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  const d = resolveDevice(device, devices);
  const seen = d.last_seen_s_ago == null ? "never" : `${Math.round(d.last_seen_s_ago)}s ago`;
  return `${describeDevice(d, servers)}\nLast report: ${seen}.`;
}));

server.registerTool("move_device", {
  title: "Move device to a location",
  description: "Move a device's VPN traffic to exit from another country. Waits until the device switches and the new exit server confirms it (usually 10–30 s). Needs a token with control scope and remote control enabled on the device.",
  inputSchema: {
    device: deviceArg,
    location: z.string().min(1).describe('Where to exit: a country or city ("Finland", "US", "Helsinki") or a location ID (srv-eu-1)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, ({ device, location }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  return pv.move(resolveDevice(device, devices), resolveLocation(location, servers));
}));

server.registerTool("rotate_device", {
  title: "Rotate device to the next location",
  description: "Move a device to the next available location, so its traffic exits from somewhere new. Waits for the move to be confirmed.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, ({ device }) => run(async () => {
  const [devices, servers] = await Promise.all([pv.devices(), pv.servers()]);
  const d = resolveDevice(device, devices);
  return pv.move(d, nextLocation(d.server_id, servers));
}));

server.registerTool("reconnect_device", {
  title: "Reconnect device",
  description: "Tell a device to re-establish its VPN tunnel at its current location. Useful when it shows as connected but not confirmed.",
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
  description: "Turn off a device's VPN tunnel. Its traffic stops going through Portveil until it reconnects. Confirm with the user before using this.",
  inputSchema: { device: deviceArg },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, ({ device }) => run(async () => {
  const d = resolveDevice(device, await pv.devices());
  const st = await pv.runCommand(d, "disconnect");
  if (st.status === "acked") return `${d.name} is disconnected. Its traffic no longer goes through Portveil.`;
  if (isWaiting(st.status)) return `Sent. ${d.name} hasn't picked it up yet (it may be offline).`;
  return `${d.name} did not disconnect: ${st.status}${st.result ? ` (${st.result})` : ""}.`;
}));

server.registerTool("recent_activity", {
  title: "Recent activity",
  description: "Show recent actions on the account (moves, reconnects, renames, tokens created), newest first, with who issued each.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("How many entries (1–100)") },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ limit }) => run(async () => {
  const [{ entries }, devices] = await Promise.all([pv.audit(limit), pv.devices()]);
  if (entries.length === 0) return "No activity yet.";
  const name = (id: string | null) => (id ? devices.find((d) => d.device_id === id)?.name ?? id : "account");
  return entries.map((e) => `- ${new Date(e.created_at * 1000).toISOString().replace(".000Z", "Z")}  ${e.action}  ${name(e.device_id)}  (by ${e.issued_by})`).join("\n");
}));

server.registerTool("account_info", {
  title: "Account info",
  description: "Show the account's plan and how many devices it uses out of its limit.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => run(async () => {
  const a = await pv.account();
  return `Plan: ${a.plan ?? "none"}. Devices: ${a.device_count}${a.device_limit ? ` of ${a.device_limit}` : ""}.`;
}));

await server.connect(new StdioServerTransport());
