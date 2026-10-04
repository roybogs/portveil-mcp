// Portveil API client and the logic behind the MCP tools. No MCP types here,
// so it can be tested against a fake API.

import { generateKeyPairSync } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIP } from "node:net";

export const VERSION = "0.4.3";

export interface Device {
  device_id: string;
  name: string;
  platform: string;
  allow_remote: boolean;
  server_id: string | null;
  connected: boolean;
  exit_confirmed: boolean;
  quality: string;
  /** Plain-English status from the API: label (Protected, Idle, Verifying, Stale, Offline) and an explanation. */
  status_label?: string;
  status_detail?: string;
  handshake_age_s: number | null;
  last_seen_s_ago: number | null;
  /** Local receipt time, overwritten by devices(); not an API trust signal. */
  observed_at_ms?: number;
  /** Temporary devices are deleted automatically at this time (unix seconds). */
  expires_at?: number | null;
  rotation?: Rotation | null;
  /** Live speed through the connected exit (about a 15 s average); null when offline or not measured yet. */
  speed?: Speed | null;
  /** The machine's own timezone, reported by the Portveil agent (null for the WireGuard app or older agents). */
  timezone?: string | null;
}

export interface Speed {
  server_id: string;
  down_mbps: number;
  up_mbps: number;
  measured_at: number;
}

/** "↓ 42.3 Mbps ↑ 6.1 Mbps", or "idle" when nothing is moving. */
export function describeSpeed(speed: Speed): string {
  if (speed.down_mbps < 0.1 && speed.up_mbps < 0.1) return "idle";
  return `↓ ${speed.down_mbps.toFixed(1)} Mbps ↑ ${speed.up_mbps.toFixed(1)} Mbps`;
}

export interface Rotation {
  every_minutes: number;
  /** Location ids to cycle through; null means every location. */
  servers: string[] | null;
}

export interface Server {
  id: string;
  name: string;
  region: string;
  endpoint_host?: string;
  endpoint_port?: number;
  pubkey?: string;
  timezone?: string;
  locale?: string;
  accept_language?: string;
}

/** What the API returns for a newly registered device. */
export interface NewDevice {
  device_id: string;
  addresses: Record<string, string>;
  expires_at: number | null;
  servers: Required<Server>[];
}

/** A fresh WireGuard keypair (base64), made locally: the private key never leaves this machine. */
export function wgKeypair(): { priv: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = (der: Buffer) => der.subarray(der.length - 32).toString("base64");
  return { priv: raw(privateKey.export({ format: "der", type: "pkcs8" })), pub: raw(publicKey.export({ format: "der", type: "spki" })) };
}

/** The WireGuard app tunnel file for one exit, the same as the setup page makes. */
export function wgConfig(priv: string, address: string, s: Required<Server>): string {
  const validKey = (key: string) => typeof key === "string" && Buffer.from(key, "base64").length === 32 && Buffer.from(key, "base64").toString("base64") === key;
  if (!validKey(priv) || !validKey(s.pubkey)) throw new PortveilError("Invalid WireGuard key in tunnel export.");
  const parts = typeof address === "string" ? address.split("/") : [];
  if (parts.length < 1 || parts.length > 2 || isIP(parts[0]) !== 4 ||
      (parts.length === 2 && (!/^\d{1,2}$/.test(parts[1]) || Number(parts[1]) > 32))) {
    throw new PortveilError("Invalid device address in tunnel export.");
  }
  if (!Number.isInteger(s.endpoint_port) || s.endpoint_port < 1 || s.endpoint_port > 65535) throw new PortveilError("Invalid endpoint port in tunnel export.");
  const host = s.endpoint_host?.replace(/^\[(.*)\]$/, "$1") ?? "";
  if (!host || host.length > 253 || (!isIP(host) && !host.replace(/\.$/, "").split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) {
    throw new PortveilError("Invalid endpoint host in tunnel export.");
  }
  const endpoint = isIP(host) === 6 ? `[${host}]` : host;
  return `[Interface]\nPrivateKey = ${priv}\nAddress = ${parts[0]}/32\nDNS = 1.1.1.1, 9.9.9.9\nMTU = 1420\n\n` +
    `[Peer]\nPublicKey = ${s.pubkey}\nEndpoint = ${endpoint}:${s.endpoint_port}\n` +
    `AllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
}

/** Commands that set up a Linux machine as a Portveil device. It makes its own key, so they run on that machine. */
export function agentSetup(apiBase: string, accountId: string, name: string, splitTunnel: boolean): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return "(\n" + [
    "apt install -y wireguard-tools curl nftables",
    "curl -fsSLO https://portveil.com/downloads/portveil-agent",
    "(set -o pipefail; curl -fsSL https://portveil.com/downloads/portveil-agent.sha256 | sha256sum -c -)",
    "chmod +x portveil-agent",
    "read -rsp 'Admin API token or account key: ' PORTVEIL_ACCOUNT_TOKEN && export PORTVEIL_ACCOUNT_TOKEN && echo",
    `./portveil-agent register --control ${q(apiBase)} --account-id ${q(accountId)} --name ${q(name)}${splitTunnel ? " --split-tunnel" : ""}`,
    "./portveil-agent daemon",
  ].join(" &&\n") + "\n)";
}

export interface CommandState {
  command_id: string;
  status: string; // queued → delivered → acked | failed | rejected | expired
  result: string | null;
}

export class PortveilError extends Error {}

/** A command the device hasn't finished yet: queued (not picked up) or delivered (working on it). */
export const isWaiting = (status: string) => status === "queued" || status === "delivered" || status === "pending";

export interface Options {
  apiBase: string;
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a device to pick up a command, and then for its exit to confirm it. */
  ackTimeoutMs?: number;
  confirmTimeoutMs?: number;
}

// Friendly names for the exits we run; anything new falls back to the server's own name.
const KNOWN: Record<string, { country: string; code: string; place: string; aliases: string[]; timezone: string; locale: string; accept_language: string }> = {
  "srv-us-1": { country: "United States", code: "US", place: "US West", aliases: ["usa", "america", "united states", "us", "us west", "west"],
    timezone: "America/Los_Angeles", locale: "en-US", accept_language: "en-US,en;q=0.9" },
  "srv-eu-1": { country: "Finland", code: "FI", place: "Helsinki", aliases: ["finland", "fi", "helsinki", "eu", "europe"],
    timezone: "Europe/Helsinki", locale: "fi-FI", accept_language: "en-US,en;q=0.9,fi;q=0.8" },
};

/** What a local browser at this exit looks like: the API's values, else the built-in ones. */
export function localProfile(s: Server): { timezone: string; locale: string; accept_language: string } | undefined {
  const k = KNOWN[s.id];
  const timezone = s.timezone ?? k?.timezone;
  if (!timezone) return undefined;
  return { timezone, locale: s.locale ?? k?.locale ?? "", accept_language: s.accept_language ?? k?.accept_language ?? "" };
}

/** One line an agent can act on so its browser matches the exit. Match the timezone;
 *  keep the language English-first so pages stay readable. */
export function localHint(s: Server): string {
  const p = localProfile(s);
  if (!p) return "";
  const lang = p.accept_language ? `; keep the browser's language English-first (Accept-Language: ${p.accept_language})` : "";
  const local = p.locale && !p.locale.startsWith("en") ? `; the local language is ${p.locale}, only for pages that should be in it` : "";
  return `timezone ${p.timezone}${lang}${local}`;
}

/** Whether the machine's own clock matches its exit (agent machines only). */
export function clockNote(d: Device, where: Server | undefined): string {
  if (!d.connected || !d.timezone || !where) return "";
  const want = localProfile(where)?.timezone;
  if (!want) return "";
  return d.timezone === want
    ? `clock ${d.timezone}, matching the exit`
    : `clock set to ${d.timezone}, not the exit's ${want}: sites can see the mismatch, so set a browser on it to ${want}`;
}

export function locationLabel(s: Pick<Server, "id" | "name">): string {
  const k = KNOWN[s.id];
  return k ? `${k.country} (${k.place})` : s.name;
}

/** Tunnel confirmation only; this does not measure DNS routing or privacy. */
export function isProtectedDevice(d: Device, now = Date.now()): boolean {
  const elapsed = d.observed_at_ms === undefined ? 0 : (now - d.observed_at_ms) / 1000;
  return d.connected && !!d.server_id && d.exit_confirmed && d.quality === "good" &&
    Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 60 &&
    d.handshake_age_s !== null && Number.isFinite(d.handshake_age_s) && d.handshake_age_s >= 0 && d.handshake_age_s + elapsed <= 180 &&
    d.last_seen_s_ago !== null && Number.isFinite(d.last_seen_s_ago) && d.last_seen_s_ago >= 0 && d.last_seen_s_ago + elapsed <= 90;
}

export function describeDevice(d: Device, servers: Server[]): string {
  const where = d.server_id ? servers.find((s) => s.id === d.server_id) : undefined;
  const place = where ? locationLabel(where) : d.server_id ?? "none";
  let state: string;
  if (!d.connected) state = "offline";
  else if (isProtectedDevice(d)) state = `protected, exiting in ${place}`;
  else if (d.exit_confirmed && d.quality === "fair") state = `idle: tunnel to ${place} confirmed but no traffic right now (it resumes on the device's next use)`;
  else state = `connected to ${place}, not yet confirmed by the exit`;
  const remote = d.platform === "wireguard-app" ? "view only (WireGuard app)" : d.allow_remote ? "remote control on" : "remote control off";
  const extras: string[] = [];
  if (d.connected && d.speed) extras.push(`speed ${describeSpeed(d.speed)}`);
  if (d.rotation) extras.push(`rotates every ${d.rotation.every_minutes} min`);
  const clock = clockNote(d, where);
  if (clock) extras.push(clock);
  if (d.expires_at) extras.push(`temporary, deleted ${new Date(d.expires_at * 1000).toISOString().replace(".000Z", "Z")}`);
  return `${d.name} [${d.device_id}] (${d.platform}): ${state}; ${remote}${extras.length ? `; ${extras.join("; ")}` : ""}`;
}

/** Match a device by id, exact name, or a unique partial name (case-insensitive). */
export function resolveDevice(query: string, devices: Device[]): Device {
  const q = query.trim().toLowerCase();
  if (!q) throw new PortveilError("Give a device name or ID; a blank selector cannot choose a device.");
  const byId = devices.find((d) => d.device_id.toLowerCase() === q);
  if (byId) return byId;
  const exact = devices.filter((d) => d.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = devices.filter((d) => d.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  const names = devices.map((d) => `"${d.name}"`).join(", ") || "none";
  if (exact.length > 1 || partial.length > 1) {
    throw new PortveilError(`"${query}" matches more than one device (${(exact.length > 1 ? exact : partial).map((d) => `"${d.name}" [${d.device_id}]`).join(", ")}). Use the device ID.`);
  }
  throw new PortveilError(`No device matches "${query}". Devices on this account: ${names}.`);
}

/** Match a location by server id, country, code, city or region (case-insensitive). */
export function resolveLocation(query: string, servers: Server[]): Server {
  const q = query.trim().toLowerCase();
  if (!q) throw new PortveilError("Give a location name or ID; a blank selector cannot choose a location.");
  const hits = servers.filter((s) => {
    if (s.id.toLowerCase() === q) return true;
    const k = KNOWN[s.id];
    const words = [s.name, s.region, ...(k ? [k.country, k.code, k.place, ...k.aliases] : [])].map((w) => w.toLowerCase());
    return words.some((w) => w === q) || words.some((w) => w.length > 3 && (w.includes(q) || q.includes(w)));
  });
  if (hits.length === 1) return hits[0];
  const all = servers.map((s) => `${locationLabel(s)} [${s.id}]`).join(", ");
  if (hits.length > 1) throw new PortveilError(`"${query}" matches more than one location: ${hits.map((s) => s.id).join(", ")}. Available: ${all}.`);
  throw new PortveilError(`No location matches "${query}". Available: ${all}.`);
}

/** The next location after the current one, wrapping around. */
export function nextLocation(current: string | null, servers: Server[]): Server {
  if (servers.length === 0) throw new PortveilError("No locations are available.");
  const i = current ? servers.findIndex((s) => s.id === current) : -1;
  if (i === -1) return servers[0];
  if (servers.length === 1) throw new PortveilError("There's only one location, so there's nowhere to rotate to.");
  return servers[(i + 1) % servers.length];
}

export class Portveil {
  private readonly o: Required<Omit<Options, "fetch" | "sleep">> & Pick<Options, "fetch" | "sleep">;

  constructor(opts: Options) {
    let base: URL;
    try { base = new URL(opts.apiBase); } catch { throw new PortveilError("Invalid Portveil API URL."); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash ||
        (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))) {
      throw new PortveilError("Portveil API URL must use HTTPS (HTTP is allowed only for loopback fixtures), without credentials, query or fragment.");
    }
    this.o = { ackTimeoutMs: 45_000, confirmTimeoutMs: 45_000, ...opts, apiBase: base.href.replace(/\/+$/, "") };
  }

  private get doFetch() { return this.o.fetch ?? fetch; }
  private sleep(ms: number) { return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try { res = await this.doFetch(this.o.apiBase + path, {
      method,
      redirect: "error",  // never forward a bearer token to a redirect target
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${this.o.token}`,
        "Content-Type": "application/json",
        // Cloudflare in front of the API rejects generic clients (error 1010).
        "User-Agent": `portveil-mcp/${VERSION} (+https://portveil.com)`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }); } catch {
      throw new PortveilError("Can't reach Portveil securely. The request was not retried; check device/activity state before repeating an action.");
    }
    let text: string;
    try { text = await res.text(); } catch { throw new PortveilError("Portveil's response was interrupted. Check current state before retrying an action."); }
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch {
      if (res.ok) throw new PortveilError("Portveil returned an invalid JSON response.");
    }
    if (res.ok) return data as T;
    const raw = typeof data?.detail === "string" ? data.detail : typeof data?.detail?.reason === "string" ? data.detail.reason : "";
    const detail = this.o.token ? raw.replaceAll(this.o.token, "[redacted]").slice(0, 200) : raw.slice(0, 200);
    switch (res.status) {
      // The control endpoints answer 401 both for a bad token and for one without enough scope.
      case 401: throw new PortveilError(method === "GET"
        ? "Portveil rejected the token. Check PORTVEIL_TOKEN (an API token from the dashboard)."
        : 'Portveil refused this with your token. Moving, reconnecting or disconnecting devices needs an API token with "control" scope; a "read" token can only look.');
      case 403: throw new PortveilError(`This token isn't allowed to do that${detail ? ` (${detail})` : ""}. Moving or reconnecting devices needs a token with "control" scope.`);
      case 400: throw new PortveilError(detail || "Portveil rejected the request.");
      case 404: throw new PortveilError("Not found. Check PORTVEIL_ACCOUNT_ID matches the token's account.");
      case 409: throw new PortveilError(detail === "remote_disabled" ? "That device has remote control turned off, so it can't be controlled from here." : `Conflict: ${detail || "request conflicts with current state"}`);
      case 429: throw new PortveilError(`Portveil is rate limiting requests; try again in ${res.headers.get("retry-after") ?? "a few"} seconds.`);
      default: throw new PortveilError(`Portveil returned HTTP ${res.status}${detail ? `: ${detail}` : ""}.`);
    }
  }

  private acct() { return `/v1/accounts/${encodeURIComponent(this.o.accountId)}`; }

  async devices(): Promise<Device[]> {
    const result = await this.call<{ devices: Device[] }>("GET", `${this.acct()}/devices`);
    if (!Array.isArray(result?.devices)) throw new PortveilError("Portveil returned an invalid devices response.");
    const receivedAt = Date.now();
    return result.devices.map((device) => ({ ...device, observed_at_ms: receivedAt }));
  }
  async servers(): Promise<Server[]> { return (await this.call<{ servers: Server[] }>("GET", "/v1/servers")).servers; }
  async account(): Promise<{ plan: string | null; device_limit: number | null; device_count: number }> { return this.call("GET", this.acct()); }
  async audit(limit: number): Promise<{ entries: { action: string; device_id: string | null; issued_by: string; created_at: number }[] }> {
    return this.call("GET", `${this.acct()}/audit-log?limit=${Math.max(1, Math.min(limit, 100))}`);
  }

  async command(deviceId: string, type: "switch_server" | "reconnect" | "disconnect", serverId?: string): Promise<CommandState> {
    const c = await this.call<{ command_id: string; status: string }>("POST", `${this.acct()}/devices/${encodeURIComponent(deviceId)}/commands`,
      serverId ? { type, server_id: serverId } : { type });
    return { command_id: c.command_id, status: c.status, result: null };
  }

  /** Turn scheduled rotation on (every N minutes, optionally among some locations) or off (null). */
  async setRotation(deviceId: string, everyMinutes: number | null, servers?: string[]): Promise<{ rotation: Rotation | null; next_rotation_at: number | null }> {
    const body = everyMinutes === null ? { every_minutes: null } : servers?.length ? { every_minutes: everyMinutes, servers } : { every_minutes: everyMinutes };
    return this.call("PUT", `${this.acct()}/devices/${encodeURIComponent(deviceId)}/rotation`, body);
  }

  /** Rename a device and/or switch remote control. Needs an admin-scope token. */
  async updateDevice(deviceId: string, change: { name?: string; allow_remote?: boolean }): Promise<{ name?: string; allow_remote?: boolean }> {
    const body = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
    return this.adminOnly(() => this.call("PATCH", `${this.acct()}/devices/${encodeURIComponent(deviceId)}`, body));
  }

  /** Register a device with a public key made elsewhere. Needs an admin-scope token. */
  async addDevice(name: string, platform: string, pubkey: string, allowRemote: boolean, ttlMinutes?: number): Promise<NewDevice> {
    const body: Record<string, unknown> = { name, platform, peer_pubkey: pubkey, allow_remote: allowRemote };
    if (ttlMinutes !== undefined) body.ttl_minutes = ttlMinutes;
    return this.adminOnly(() => this.call("POST", `${this.acct()}/devices`, body));
  }

  /** Provision into a NEW private directory. Persist the key before the remote
   * registration: an interrupted response or disk error must not lose it. */
  async addDeviceFiles(name: string, dir: string, ttlMinutes?: number): Promise<{ device: NewDevice; files: string[] }> {
    try {
      await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
      await mkdir(dir, { mode: 0o700 });  // exclusive: never reuse a folder or follow its symlink
    } catch {
      throw new PortveilError("Choose a new, writable private folder. No device was registered and no existing tunnel files were changed.");
    }
    let keySaved = false;
    let deviceId: string | undefined;
    try {
      const keys = wgKeypair();
      const keyFile = await open(join(dir, "private-key"), "wx", 0o600);
      try {
        await keyFile.writeFile(keys.priv + "\n");
        await keyFile.sync();
        keySaved = true;
      } finally { await keyFile.close(); }
      const d = await this.addDevice(name, "wireguard-app", keys.pub, false, ttlMinutes);
      deviceId = d.device_id;
      // Only public registration fields, NOT the API's device_token. The key
      // stays in private-key and the importable .conf files, never in replies.
      await writeFile(join(dir, "device.json"), JSON.stringify({ device_id: d.device_id, addresses: d.addresses,
        expires_at: d.expires_at, servers: d.servers.map(({ id, name, region, endpoint_host, endpoint_port, pubkey }) =>
          ({ id, name, region, endpoint_host, endpoint_port, pubkey })) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      if (!d.servers.length) throw new PortveilError("No exit locations were returned for the new device.");
      const configs = new Map<string, string>();
      for (const server of d.servers) {
        const address = d.addresses[server.id];
        if (!address) throw new PortveilError("An exit address is missing from the new device registration.");
        const file = join(dir, `Portveil-${locationLabel(server).replace(/[^\w .()-]+/g, "_")}.conf`);
        if (configs.has(file)) throw new PortveilError("Exit names collide; tunnel files were not overwritten.");
        configs.set(file, wgConfig(keys.priv, address, server));
      }
      for (const [file, config] of configs) await writeFile(file, config, { mode: 0o600, flag: "wx" });
      return { device: d, files: [...configs.keys()] };
    } catch (e) {
      if (!keySaved) throw new PortveilError("Could not save new keys securely. Device registration was not attempted.");
      const why = e instanceof PortveilError ? e.message : "Registration or local export did not finish.";
      throw new PortveilError(`${why} Setup incomplete${deviceId ? ` for [${deviceId}]` : " (registration outcome unknown)"}. ` +
        `The private key is retained in ${join(dir, "private-key")}; keep this directory private. ` +
        "Check list_devices before adding another device; use device.json to recover configs when present, or remove the exact device in the dashboard. Existing files were not overwritten.");
    }
  }

  /** Remove a device for good (its key stops working everywhere). Needs an admin-scope token. */
  async removeDevice(deviceId: string): Promise<void> {
    await this.adminOnly(() => this.call("DELETE", `${this.acct()}/devices/${encodeURIComponent(deviceId)}`));
  }

  private async adminOnly<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PortveilError && /refused this with your token|isn't allowed to do that/.test(e.message)) {
        throw new PortveilError('Adding, renaming, changing remote control or removing devices needs an API token with "admin" scope. Create one in the dashboard, or make the change there.');
      }
      throw e;
    }
  }

  async commandState(id: string): Promise<CommandState> {
    return this.call("GET", `${this.acct()}/commands/${encodeURIComponent(id)}`);
  }

  /** Send a command and wait for the device to pick it up (it polls about every 10 s). */
  async runCommand(device: Device, type: "switch_server" | "reconnect" | "disconnect", server?: Server): Promise<CommandState> {
    if (device.platform === "wireguard-app") throw new PortveilError(`${device.name} uses the WireGuard app, which can't be controlled remotely. Install the Portveil agent or app on it for that.`);
    if (!device.allow_remote) throw new PortveilError("That device has remote control turned off, so it can't be controlled from here.");
    let st = await this.command(device.device_id, type, server?.id);
    const deadline = Date.now() + this.o.ackTimeoutMs;
    while (isWaiting(st.status) && Date.now() < deadline) {
      await this.sleep(2500);
      st = await this.commandState(st.command_id);
    }
    return st;
  }

  /** After a switch is acknowledged, wait for the new exit to confirm it sees the device. */
  async waitConfirmed(deviceId: string, serverId: string): Promise<Device | undefined> {
    const deadline = Date.now() + this.o.confirmTimeoutMs;
    for (;;) {
      const d = (await this.devices()).find((x) => x.device_id === deviceId);
      if (d && d.server_id === serverId && isProtectedDevice(d)) return d;
      if (Date.now() >= deadline) return undefined;
      await this.sleep(3000);
    }
  }

  /** Reconnect needs the exit's current confirmation too, not just an ack. */
  async reconnect(device: Device): Promise<string> {
    const st = await this.runCommand(device, "reconnect");
    if (st.status === "delivered") return `${device.name} is reconnecting but hasn't reported completion yet. Check get_device.`;
    if (isWaiting(st.status)) return `Sent. ${device.name} hasn't picked it up yet (it may be offline).`;
    if (st.status !== "acked") return `${device.name} did not reconnect: ${st.status}${st.result ? ` (${st.result})` : ""}. Check get_device.`;
    const confirmed = device.server_id ? await this.waitConfirmed(device.device_id, device.server_id) : undefined;
    return confirmed ? `${device.name} reconnected, confirmed by the exit server.`
      : `${device.name} acknowledged reconnect, but its exit has not confirmed a fresh connection. Check get_device before retrying.`;
  }

  /** Move a device and report plainly what actually happened. */
  async move(device: Device, target: Server): Promise<string> {
    const place = locationLabel(target);
    if (device.server_id === target.id && isProtectedDevice(device)) return `${device.name} is already exiting in ${place}; nothing to do.`;
    const st = await this.runCommand(device, "switch_server", target);
    if (st.status === "delivered") {
      return `${device.name} is switching to ${place} but hasn't reported back yet. Check with get_device in a minute.`;
    }
    if (isWaiting(st.status)) {
      return `Sent. ${device.name} hasn't picked up the move to ${place} yet (it may be offline); it will when it's next online, until the command expires.`;
    }
    if (st.status !== "acked") return `${device.name} did not move: ${st.status}${st.result ? ` (${st.result})` : ""}. Check its current state with get_device before retrying.`;
    const confirmed = await this.waitConfirmed(device.device_id, target.id);
    return confirmed
      ? `Done. ${device.name} now exits in ${place}, confirmed by the ${place} exit server.${localHint(target) ? ` If a browser on it should look local, use ${localHint(target)}.` : ""}`
      : `${device.name} switched to ${place}, but that exit hasn't confirmed the connection yet. Check again with get_device in a minute.`;
  }
}
