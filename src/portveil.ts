// Portveil API client and the logic behind the MCP tools. No MCP types here,
// so it can be tested against a fake API.

export const VERSION = "0.2.1";

export interface Device {
  device_id: string;
  name: string;
  platform: string;
  allow_remote: boolean;
  server_id: string | null;
  connected: boolean;
  exit_confirmed: boolean;
  quality: string;
  handshake_age_s: number | null;
  last_seen_s_ago: number | null;
  /** Temporary devices are deleted automatically at this time (unix seconds). */
  expires_at?: number | null;
  rotation?: Rotation | null;
  /** Live speed through the connected exit (about a 15 s average); null when offline or not measured yet. */
  speed?: Speed | null;
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
const KNOWN: Record<string, { country: string; code: string; place: string; aliases: string[] }> = {
  "srv-us-1": { country: "United States", code: "US", place: "US West", aliases: ["usa", "america", "united states", "us", "us west", "west"] },
  "srv-eu-1": { country: "Finland", code: "FI", place: "Helsinki", aliases: ["finland", "fi", "helsinki", "eu", "europe"] },
};

export function locationLabel(s: Pick<Server, "id" | "name">): string {
  const k = KNOWN[s.id];
  return k ? `${k.country} (${k.place})` : s.name;
}

export function describeDevice(d: Device, servers: Server[]): string {
  const where = d.server_id ? servers.find((s) => s.id === d.server_id) : undefined;
  const place = where ? locationLabel(where) : d.server_id ?? "none";
  let state: string;
  if (!d.connected) state = "offline";
  else if (d.exit_confirmed && d.quality === "good") state = `protected, exiting in ${place}`;
  else state = `connected to ${place}, not yet confirmed by the exit`;
  const remote = d.platform === "wireguard-app" ? "view only (WireGuard app)" : d.allow_remote ? "remote control on" : "remote control off";
  const extras: string[] = [];
  if (d.connected && d.speed) extras.push(`speed ${describeSpeed(d.speed)}`);
  if (d.rotation) extras.push(`rotates every ${d.rotation.every_minutes} min`);
  if (d.expires_at) extras.push(`temporary, deleted ${new Date(d.expires_at * 1000).toISOString().replace(".000Z", "Z")}`);
  return `${d.name} [${d.device_id}] (${d.platform}): ${state}; ${remote}${extras.length ? `; ${extras.join("; ")}` : ""}`;
}

/** Match a device by id, exact name, or a unique partial name (case-insensitive). */
export function resolveDevice(query: string, devices: Device[]): Device {
  const q = query.trim().toLowerCase();
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
    this.o = { ackTimeoutMs: 45_000, confirmTimeoutMs: 45_000, ...opts, apiBase: opts.apiBase.replace(/\/+$/, "") };
  }

  private get doFetch() { return this.o.fetch ?? fetch; }
  private sleep(ms: number) { return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(this.o.apiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.o.token}`,
        "Content-Type": "application/json",
        // Cloudflare in front of the API rejects generic clients (error 1010).
        "User-Agent": `portveil-mcp/${VERSION} (+https://portveil.com)`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
    if (res.ok) return data as T;
    const detail = typeof data?.detail === "string" ? data.detail : data?.detail?.reason ?? "";
    switch (res.status) {
      // The control endpoints answer 401 both for a bad token and for one without enough scope.
      case 401: throw new PortveilError(method === "GET"
        ? "Portveil rejected the token. Check PORTVEIL_TOKEN (an API token from the dashboard)."
        : 'Portveil refused this with your token. Moving, reconnecting or disconnecting devices needs an API token with "control" scope; a "read" token can only look.');
      case 403: throw new PortveilError(`This token isn't allowed to do that${detail ? ` (${detail})` : ""}. Moving or reconnecting devices needs a token with "control" scope.`);
      case 400: throw new PortveilError(detail || "Portveil rejected the request.");
      case 404: throw new PortveilError("Not found. Check PORTVEIL_ACCOUNT_ID matches the token's account.");
      case 409: throw new PortveilError(detail === "remote_disabled" ? "That device has remote control turned off, so it can't be controlled from here." : `Conflict: ${detail || text}`);
      case 429: throw new PortveilError(`Portveil is rate limiting requests; try again in ${res.headers.get("retry-after") ?? "a few"} seconds.`);
      default: throw new PortveilError(`Portveil returned HTTP ${res.status}${detail ? `: ${detail}` : ""}.`);
    }
  }

  private acct() { return `/v1/accounts/${encodeURIComponent(this.o.accountId)}`; }

  async devices(): Promise<Device[]> { return (await this.call<{ devices: Device[] }>("GET", `${this.acct()}/devices`)).devices; }
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

  async commandState(id: string): Promise<CommandState> {
    return this.call("GET", `${this.acct()}/commands/${encodeURIComponent(id)}`);
  }

  /** Send a command and wait for the device to pick it up (it polls about every 10 s). */
  async runCommand(device: Device, type: "switch_server" | "reconnect" | "disconnect", server?: Server): Promise<CommandState> {
    if (device.platform === "wireguard-app") throw new PortveilError(`${device.name} uses the WireGuard app, which can't be controlled remotely. Install the Portveil agent or app on it for that.`);
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
      if (d && d.server_id === serverId && d.exit_confirmed) return d;
      if (Date.now() >= deadline) return undefined;
      await this.sleep(3000);
    }
  }

  /** Move a device and report plainly what actually happened. */
  async move(device: Device, target: Server): Promise<string> {
    const place = locationLabel(target);
    if (device.server_id === target.id && device.exit_confirmed) return `${device.name} is already exiting in ${place}; nothing to do.`;
    const st = await this.runCommand(device, "switch_server", target);
    if (st.status === "delivered") {
      return `${device.name} is switching to ${place} but hasn't reported back yet. Check with device_status in a minute.`;
    }
    if (isWaiting(st.status)) {
      return `Sent. ${device.name} hasn't picked up the move to ${place} yet (it may be offline); it will when it's next online, until the command expires.`;
    }
    if (st.status !== "acked") return `${device.name} did not move: ${st.status}${st.result ? ` (${st.result})` : ""}. It is still on its previous location.`;
    const confirmed = await this.waitConfirmed(device.device_id, target.id);
    return confirmed
      ? `Done. ${device.name} now exits in ${place}, confirmed by the ${place} exit server.`
      : `${device.name} switched to ${place}, but that exit hasn't confirmed the connection yet. Check again with device_status in a minute.`;
  }
}
