import { createServer } from "node:net";
import { get as httpsGet } from "node:https";
import { networkInterfaces } from "node:os";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  readdir,
  readlink,
  rename,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function checkNodeVersion(
  version = process.versions.node,
  executable = process.execPath,
) {
  const stable = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!stable || Number(stable[1]) < 24)
    throw new Error(
      `Node.js 24 or newer (stable) required; detected ${version} at ${executable}. Recommended: Node.js 24 LTS.`,
    );
}
function parsePort(value, label) {
  if (value === "auto" || String(value) === "0") return 0;
  const port = Number(value);
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      `${label} must be auto, 0, or an integer from 1 to 65535; received ${JSON.stringify(value)}`,
    );
  return port;
}
export function developmentPorts(args = [], environment = process.env) {
  const options = developmentOptions(args, environment);
  return { webPort: options.webPort, gatewayPort: options.gatewayPort };
}
export function developmentOptions(args = [], environment = process.env) {
  let web = environment.LINKOS_WEB_PORT,
    gateway = environment.LINKOS_GATEWAY_PORT,
    host = environment.LINKOS_WEB_HOST,
    lanIP = environment.LINKOS_LAN_IP;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--" || argument === "--acceptance") continue;
    const separator = argument.indexOf("="),
      option = separator < 0 ? argument : argument.slice(0, separator);
    if (
      ![
        "--port",
        "--web-port",
        "--gateway-port",
        "--host",
        "--lan-ip",
      ].includes(option)
    )
      throw new Error(
        `Unknown option: ${argument}. Use --web-port, --gateway-port, --host or --lan-ip.`,
      );
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--"))
      throw new Error(
        `${option} requires a value (ports: auto, 0, or 1 to 65535)`,
      );
    if (option === "--gateway-port") gateway = value;
    else if (option === "--host") host = value;
    else if (option === "--lan-ip") lanIP = value;
    else web = value;
  }
  const acceptance = args.includes("--acceptance");
  return {
    webPort: parsePort(
      web ?? "auto",
      "Web port (--web-port / LINKOS_WEB_PORT)",
    ),
    gatewayPort: parsePort(
      gateway ?? "auto",
      "Gateway port (--gateway-port / LINKOS_GATEWAY_PORT)",
    ),
    host:
      !host || host === "auto" ? (acceptance ? "127.0.0.1" : "0.0.0.0") : host,
    lanIP,
  };
}

const virtualAdapter =
  /vmware|vbox|virtual|hyper-v|vethernet|wsl|docker|podman|loopback|vpn|wintun|wireguard|tailscale|zerotier|utun|^tun\d|^tap\d/i;
function ipv4(value) {
  return (
    typeof value === "string" &&
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value
      .split(".")
      .every((part) => Number(part) <= 255 && String(Number(part)) === part)
  );
}
export function localIPv4s(interfaces = networkInterfaces()) {
  const result = [];
  for (const [name, entries] of Object.entries(interfaces))
    for (const item of entries ?? [])
      if (
        (item.family === "IPv4" || item.family === 4) &&
        !item.internal &&
        ipv4(item.address) &&
        !/^(0\.|127\.|169\.254\.)/.test(item.address)
      )
        result.push({
          name,
          address: item.address,
          virtual: virtualAdapter.test(name),
        });
  return result.sort(
    (a, b) =>
      Number(a.virtual) - Number(b.virtual) ||
      a.name.localeCompare(b.name) ||
      a.address.localeCompare(b.address),
  );
}
export function developmentNetwork(options, interfaces = networkInterfaces()) {
  const { host, lanIP } = options;
  const local = localIPv4s(interfaces);
  if (host !== "localhost" && !ipv4(host))
    throw new Error(
      "--host must be auto, 0.0.0.0, localhost, 127.0.0.1 or an assigned local IPv4 address",
    );
  const loopback = host === "localhost" || host.startsWith("127.");
  if (
    !loopback &&
    host !== "0.0.0.0" &&
    !local.some((item) => item.address === host)
  )
    throw new Error(
      `--host ${host} is not assigned to a local network interface`,
    );
  if (lanIP && (!ipv4(lanIP) || !local.some((item) => item.address === lanIP)))
    throw new Error(
      `--lan-ip ${lanIP} is not assigned to a local network interface`,
    );
  if (lanIP && (loopback || (host !== "0.0.0.0" && host !== lanIP)))
    throw new Error("--lan-ip must match --host, or use --host 0.0.0.0");
  const addresses = loopback
    ? []
    : host !== "0.0.0.0"
      ? [host]
      : [
          ...new Set([
            ...(lanIP ? [lanIP] : []),
            ...local
              .filter((item) => !item.virtual)
              .map((item) => item.address),
          ]),
        ];
  return {
    host:
      host === "localhost" || (host === "0.0.0.0" && !addresses.length)
        ? "127.0.0.1"
        : host,
    addresses,
    primary: addresses[0],
    https: addresses.length > 0,
  };
}
export function developmentURLs(network, port) {
  const scheme = network.https ? "https" : "http";
  return {
    webURL: `${scheme}://${network.host === "0.0.0.0" || network.host === "localhost" ? "127.0.0.1" : network.host}:${port}`,
    lanURLs: network.addresses.map(
      (address) => `${scheme}://${address}:${port}`,
    ),
    origins: [
      ...new Set([
        `${scheme}://127.0.0.1:${port}`,
        `${scheme}://localhost:${port}`,
        ...network.addresses.map((address) => `${scheme}://${address}:${port}`),
      ]),
    ],
  };
}
export async function projectID(root) {
  const value = await realpath(root);
  return createHash("sha256")
    .update(process.platform === "win32" ? value.toLowerCase() : value)
    .digest("hex")
    .slice(0, 24);
}
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
export async function probe(url, { ca } = {}) {
  if (url.startsWith("https:") && ca) {
    return new Promise((resolve) => {
      const request = httpsGet(url, { ca, timeout: 1200 }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) response.destroy();
          else chunks.push(chunk);
        });
        response.on("error", () => resolve(null));
        response.on("end", () => {
          try {
            resolve(
              response.statusCode === 200
                ? JSON.parse(Buffer.concat(chunks))
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => resolve(null));
    });
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export function belongsToProject(h, id, service) {
  return h?.projectId === id && h?.service === service;
}
export async function processOwnsPort(port, root) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const matches = (value) => {
    const candidate = value?.replaceAll("\\", "/").toLowerCase(),
      repo = root.replaceAll("\\", "/").toLowerCase();
    return candidate?.includes(repo + "/");
  };
  try {
    if (process.platform === "win32") {
      const script = `$owner=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess; $item=Get-CimInstance Win32_Process -Filter "ProcessId=$owner"; $item.CommandLine; $item.ExecutablePath; if($item.ParentProcessId){(Get-CimInstance Win32_Process -Filter "ProcessId=$($item.ParentProcessId)").CommandLine}`;
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 5000 },
      );
      return matches(stdout);
    }
    if (process.platform === "linux") {
      const hex = port.toString(16).toUpperCase().padStart(4, "0");
      const inodes = new Set();
      for (const table of ["tcp", "tcp6"]) {
        const rows = (await readFile("/proc/net/" + table, "utf8"))
          .trim()
          .split("\n")
          .slice(1);
        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          if (parts[1]?.endsWith(":" + hex) && parts[3] === "0A")
            inodes.add(parts[9]);
        }
      }
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          for (const fd of await readdir(`/proc/${pid}/fd`)) {
            const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(
              () => null,
            );
            const inode = link?.match(/^socket:\[(\d+)\]$/)?.[1];
            if (inodes.has(inode)) {
              const cwd = await readlink(`/proc/${pid}/cwd`);
              return (
                cwd === root ||
                matches(cwd + "/") ||
                matches(await readFile(`/proc/${pid}/cmdline`, "utf8"))
              );
            }
          }
        } catch {}
      }
    }
  } catch {}
  return false;
}
export async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function writeJSON(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export async function freePort(
  preferred = 0,
  excluded = [],
  host = "127.0.0.1",
) {
  preferred = parsePort(preferred, "Preferred port");
  // Windows can allow wildcard and specific-address listeners on one port.
  // Probe every local IPv4 too, so a LAN or loopback-only owner is respected.
  const hosts = [
    ...new Set(
      host === "0.0.0.0"
        ? [host, "127.0.0.1", ...localIPv4s().map((item) => item.address)]
        : [host],
    ),
  ];
  const available = async (port) => {
    for (const address of hosts) {
      const free = await new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen({ port, host: address, exclusive: true }, () =>
          server.close(() => resolve(true)),
        );
      });
      if (!free) return false;
    }
    return true;
  };
  if (preferred === 0) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, host, () => {
          const port = server.address().port;
          server.close(() => resolve(port));
        });
      });
      if (!excluded.includes(port) && (await available(port))) return port;
    }
    throw new Error("Unable to allocate an unreserved development port");
  }
  const last = Math.min(preferred + 99, 65535);
  for (let port = preferred; port <= last; port++) {
    if (excluded.includes(port)) continue;
    if (await available(port)) return port;
  }
  throw new Error(
    `No free port in ${preferred}–${last}; choose another preferred port with --web-port or --gateway-port`,
  );
}
export async function launcherLock(dir, id) {
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const owner = await readJSON(path.join(dir, "owner.json"));
    if (!owner || owner.projectId !== id || isAlive(owner.pid)) return null;
    await rm(dir, { recursive: true });
    return launcherLock(dir, id);
  }
  await writeJSON(path.join(dir, "owner.json"), {
    pid: process.pid,
    projectId: id,
  });
  return async () => {
    const owner = await readJSON(path.join(dir, "owner.json"));
    if (owner?.pid === process.pid) await rm(dir, { recursive: true });
  };
}
export async function waitReady(url, child, timeout = 30000, options = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child?.startError) throw child.startError;
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`Service exited: ${child.exitCode}`);
    const h = await probe(url, options);
    if (h) return h;
    await delay(150);
  }
  throw new Error(`Not ready: ${url}`);
}
export async function stopGateway(home, pid) {
  const s = await readJSON(path.join(home, "run.json"));
  if (
    s?.pid !== pid ||
    !s.controlToken ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(s.controlURL)
  )
    throw new Error("Ownership changed; refusing shutdown");
  const r = await fetch(s.controlURL + "/stop", {
    method: "POST",
    headers: { authorization: `Bearer ${s.controlToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error("Gateway refused graceful shutdown");
}
