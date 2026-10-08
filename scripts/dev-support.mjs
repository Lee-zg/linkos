import { createServer } from "node:net";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  readdir,
  readlink,
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
  const port = Number(value);
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      `${label} must be an integer from 1 to 65535; received ${JSON.stringify(value)}`,
    );
  return port;
}
export function developmentPorts(args = [], environment = process.env) {
  let web = environment.LINKOS_WEB_PORT,
    gateway = environment.LINKOS_GATEWAY_PORT;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--" || argument === "--acceptance") continue;
    const separator = argument.indexOf("="),
      option = separator < 0 ? argument : argument.slice(0, separator);
    if (!["--port", "--web-port", "--gateway-port"].includes(option))
      throw new Error(
        `Unknown option: ${argument}. Use --web-port and --gateway-port.`,
      );
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${option} requires a port from 1 to 65535`);
    if (option === "--gateway-port") gateway = value;
    else web = value;
  }
  const acceptance = args.includes("--acceptance");
  return {
    webPort: parsePort(
      web ?? (acceptance ? 15173 : 5173),
      "Web port (--web-port / LINKOS_WEB_PORT)",
    ),
    gatewayPort: parsePort(
      gateway ?? (acceptance ? 18887 : 8787),
      "Gateway port (--gateway-port / LINKOS_GATEWAY_PORT)",
    ),
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
export async function probe(url) {
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
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
export async function freePort(preferred, excluded = []) {
  preferred = parsePort(preferred, "Preferred port");
  const last = Math.min(preferred + 99, 65535);
  for (let port = preferred; port <= last; port++) {
    if (excluded.includes(port)) continue;
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return port;
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
export async function waitReady(url, child, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`Service exited: ${child.exitCode}`);
    const h = await probe(url);
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
