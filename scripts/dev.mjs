import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createWriteStream, createReadStream, watch } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { adapterOptions, execute } from "./linkos.mjs";
import {
  prepareProject,
  developmentID,
  buildGateway,
  toolEnvironment,
} from "./project-tools.mjs";
import {
  developmentNetwork,
  developmentURLs,
  belongsToProject,
  freePort,
  launcherLock,
  probe,
  readJSON,
  writeJSON,
  waitReady,
  stopGateway,
  processOwnsPort,
  delay,
} from "./dev-support.mjs";

let direct = process.argv.slice(2);
if (["status", "logs", "stop"].includes(direct[0])) direct = ["dev", ...direct];
const o = await adapterOptions(direct[0] ?? "dev", direct.slice(1));
const root = o.root,
  home = o.config.dev.home,
  registry = path.join(home, "dev.json");
const id = await developmentID(o),
  environment = toolEnvironment(o);
const logs = path.join(home, "logs");
const controlFile = path.join(home, "dev-control.json");

async function registered() {
  const saved = await readJSON(registry);
  let ca;
  if (saved?.webCA) ca = await readFile(saved.webCA).catch(() => undefined);
  return { saved, ca };
}
async function status() {
  const { saved, ca } = await registered();
  const [web, gateway] = await Promise.all([
    saved?.webURL ? probe(saved.webURL + "/__linkos/dev", { ca }) : null,
    saved?.gatewayURL
      ? probe(saved.gatewayURL + "/api/v1/healthz", { ca })
      : null,
  ]);
  const own = belongsToProject(gateway, id, "gateway");
  console.log(
    JSON.stringify(
      {
        running: own,
        topology: saved?.topology ?? "legacy",
        web: belongsToProject(web, id, "web") ? saved.webURL : "not found",
        gateway: own ? saved.gatewayURL : "not found",
        lan: own ? saved.lanURLs : [],
        certificate: saved?.webCA,
        home,
        logs,
      },
      null,
      2,
    ),
  );
}
async function stop() {
  const state = await readJSON(controlFile);
  if (state?.projectId !== id || !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.url))
    throw new Error(
      "No owned launcher controller found; existing services were not stopped",
    );
  const headers = {
    authorization: `Bearer ${state.token}`,
    "x-linkos-instance": state.instanceId,
  };
  const response = await fetch(state.url + "/stop", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Development controller refused stop");
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const current = await readJSON(controlFile);
    if (!current || current.instanceId !== state.instanceId) return;
    await delay(150);
  }
  throw new Error("Development services are still draining; inspect the logs");
}
async function displayLogs() {
  const file = path.join(logs, "launcher.log");
  let offset = Math.max(0, (await stat(file)).size - 65536);
  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
  });
  process.once("SIGTERM", () => {
    stopped = true;
  });
  do {
    const size = (await stat(file)).size;
    if (size < offset) offset = 0;
    if (size > offset) {
      for await (const block of createReadStream(file, {
        start: offset,
        end: size - 1,
      }))
        process.stdout.write(block);
      offset = size;
    }
    if (o.follow && !stopped) await delay(200);
  } while (o.follow && !stopped);
}

async function reuseLegacy(saved, ca) {
  const runtime = await readJSON(path.join(home, "run.json"));
  const candidates = [
    ...new Set(
      [
        saved?.gatewayURL,
        runtime?.url,
        !o.acceptance && home === path.join(root, ".local/linkos")
          ? "http://127.0.0.1:8787"
          : null,
      ].filter(Boolean),
    ),
  ];
  for (const url of candidates) {
    const health = await probe(url + "/api/v1/healthz", { ca });
    const legacy =
      health?.service === "gateway" &&
      !health.projectId &&
      !o.acceptance &&
      (await processOwnsPort(Number(new URL(url).port), root));
    if (!belongsToProject(health, id, "gateway") && !legacy) continue;
    const info = await probe(url + "/__linkos/dev", { ca });
    if (info?.topology === "gateway") {
      if (!belongsToProject(info, id, "web"))
        throw new Error(
          "Existing Gateway core is running but its Vite is unavailable. Inspect linkos dev logs; no running service was restarted.",
        );
      console.log(
        `Reusing project Gateway ${url}; no duplicate services started.`,
      );
      return true;
    }
    if (new URL(url).protocol !== "http:")
      throw new Error(
        "Existing HTTPS Gateway has no development proxy; keep it running and use a separate --acceptance workspace for development",
      );
    console.log(
      `Reusing existing Gateway ${url} (${health.storage ?? "memory/unknown"}); retaining the legacy Web entry until its next normal stop.`,
    );
    process.env.LINKOS_DEV_HOME = home;
    // Pass the identity already verified above. Historical launchers derived a
    // different suffix when the default home was supplied explicitly.
    process.env.LINKOS_LEGACY_PROJECT_ID = id;
    process.env.LINKOS_LEGACY_GATEWAY_URL = url;
    process.argv = [
      process.execPath,
      path.join(root, "scripts/dev-legacy.mjs"),
      "dev",
      ...(o.acceptance ? ["--acceptance"] : []),
      "--gateway-port",
      new URL(url).port,
      "--web-port",
      saved?.webURL ? new URL(saved.webURL).port : String(o.config.dev.port),
      "--host",
      o.config.dev.host,
      ...(o.config.dev.lanIP !== "auto"
        ? ["--lan-ip", o.config.dev.lanIP]
        : []),
    ];
    await import("./dev-legacy.mjs");
    return true;
  }
  // A legacy launcher may still own its Web while the managed Gateway rebuilds.
  if (saved?.webURL) {
    const info = await probe(saved.webURL + "/__linkos/dev", { ca });
    if (belongsToProject(info, id, "web") && info.topology !== "gateway") {
      console.log(
        `Existing legacy Web is active at ${saved.webURL}; inspect its launcher while Gateway reconnects.`,
      );
      return true;
    }
  }
  return false;
}

async function development() {
  const { saved, ca: previousCA } = await registered();
  if (await reuseLegacy(saved, previousCA)) return;
  const unlock = await launcherLock(path.join(home, "dev.lock"), id);
  if (!unlock) {
    await status();
    console.log(
      "Workspace launcher already active or preparing; no duplicate started.",
    );
    return;
  }
  const children = new Set(),
    watchers = [];
  let closing = false,
    initializing = true,
    restarting = false,
    pending = false,
    timer;
  let gatewayChild, viteChild, controller, aggregate;
  const instanceId = randomBytes(24).toString("hex"),
    token = randomBytes(32).toString("hex");
  function message(value) {
    console.log(value);
    aggregate?.write(value + "\n");
  }
  function start(command, args, name, env) {
    const log = createWriteStream(path.join(logs, name + ".log"), {
      flags: "a",
      mode: 0o600,
    });
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.output = "";
    children.add(child);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        log.write(data);
        aggregate?.write(`[${name}] ${data}`);
        process.stdout.write(`[${name}] ${data}`);
        child.output = (child.output + data).slice(-8192);
      });
    child.once("error", (error) => {
      child.startError = error;
      if (!initializing) shutdown(1);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      log.end();
      if (
        !closing &&
        !initializing &&
        !(restarting && child === gatewayChild)
      ) {
        message(`${name} exited (${code ?? signal})`);
        shutdown(1);
      }
    });
    return child;
  }
  async function exited(child) {
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.startError
    )
      return;
    await new Promise((resolve) => child.once("exit", resolve));
  }
  async function stopOwned() {
    if (gatewayChild && children.has(gatewayChild)) {
      await stopGateway(home, gatewayChild.pid);
      await exited(gatewayChild);
    }
    if (viteChild && children.has(viteChild)) {
      viteChild.kill("SIGTERM");
      await exited(viteChild);
    }
  }
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    watchers.forEach((w) => w.close());
    try {
      await stopOwned();
    } catch (error) {
      console.error(
        `Shutdown: ${error.message}. No unrelated service was stopped.`,
      );
      code = 1;
    }
    if (controller) {
      controller.closeAllConnections();
      await new Promise((resolve) => controller.close(resolve));
    }
    const control = await readJSON(controlFile);
    if (control?.instanceId === instanceId)
      await rm(controlFile, { force: true });
    await unlock();
    aggregate?.end();
    process.exitCode = code;
    if (process.connected) process.disconnect();
  }
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  process.on("message", (value) => {
    if (value?.type === "linkos.stop") shutdown();
  });
  try {
    await prepareProject(o);
    if (closing) return;
    await mkdir(logs, { recursive: true });
    aggregate = createWriteStream(path.join(logs, "launcher.log"), {
      flags: "a",
      mode: 0o600,
    });
    controller = createServer((request, response) => {
      if (
        request.headers.authorization !== `Bearer ${token}` ||
        request.headers["x-linkos-instance"] !== instanceId
      ) {
        response.writeHead(403).end();
        return;
      }
      if (request.url === "/stop" && request.method === "POST") {
        response.end("stopping");
        setImmediate(() => shutdown());
      } else if (request.url === "/status") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ instanceId, projectId: id }));
      } else response.writeHead(404).end();
    });
    controller.headersTimeout = 5000;
    controller.requestTimeout = 5000;
    await new Promise((resolve, reject) => {
      controller.once("error", reject);
      controller.listen(0, "127.0.0.1", resolve);
    });
    await writeJSON(controlFile, {
      projectId: id,
      launcherPID: process.pid,
      instanceId,
      url: `http://127.0.0.1:${controller.address().port}`,
      token,
    });
    const network = developmentNetwork({
      host: o.config.dev.host === "auto" ? "0.0.0.0" : o.config.dev.host,
      lanIP: o.config.dev.lanIP === "auto" ? undefined : o.config.dev.lanIP,
    });
    if (!o.config.dev.https && network.addresses.length)
      throw new Error(
        "LAN development requires HTTPS; set dev.https true or use --host 127.0.0.1",
      );
    network.https = o.config.dev.https;
    const publicHost =
      o.config.dev.publicHost === "auto"
        ? (network.primary ?? "127.0.0.1")
        : o.config.dev.publicHost;
    if (
      /^\d+\./.test(publicHost) &&
      !["127.0.0.1", ...network.addresses].includes(publicHost)
    )
      throw new Error(
        "dev.publicHost IP must belong to the selected local interfaces",
      );
    const binary = await buildGateway(o);
    let webCA, ca;
    if (network.https) {
      const hosts = [...new Set([publicHost, ...network.addresses])];
      await execute(
        binary,
        ["tls", "dev", "--home", home, "--host", hosts.join(",")],
        { cwd: root, env: environment },
      );
      webCA = path.join(home, "dev-web/tls/ca.crt");
      ca = await readFile(webCA);
    }
    let webURL, viteURL, urls, publicURL, gatewayArgs, childEnv, record;
    const excluded = [];
    async function entryPort() {
      const configured = Number(o.config.dev.port) || 0;
      const previous = saved?.webURL ? Number(new URL(saved.webURL).port) : 0;
      for (const candidate of [
        ...new Set(
          configured ? [configured] : [previous, o.acceptance ? 0 : 8443],
        ),
      ].filter(Boolean)) {
        if (excluded.includes(candidate)) continue;
        const free = await freePort(candidate, excluded, network.host).catch(
          () => 0,
        );
        if (free === candidate) return free;
        message(
          `Gateway: preferred port ${candidate} is occupied or reserved; coordinating a free port.`,
        );
      }
      return freePort(0, excluded, network.host);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await entryPort();
      urls = developmentURLs(network, port);
      webURL = urls.webURL;
      publicURL = `${network.https ? "https" : "http"}://${publicHost}:${port}`;
      if (!urls.origins.includes(publicURL)) {
        urls.origins.push(publicURL);
        if (network.addresses.length) urls.lanURLs.unshift(publicURL);
      }
      const vitePort = await freePort(
        Number(o.config.dev.vitePort) || 0,
        [port],
        "127.0.0.1",
      );
      viteURL = `http://127.0.0.1:${vitePort}`;
      childEnv = {
        ...environment,
        LINKOS_DEV_ENTRY_URL: webURL,
        LINKOS_WEB_LAN_URLS: JSON.stringify(urls.lanURLs),
        LINKOS_DEV_PUBLIC_URL: publicURL,
      };
      gatewayArgs = [
        "serve",
        "--home",
        home,
        "--listen",
        `${network.host}:${port}`,
        "--public-url",
        publicURL,
        "--tls-mode",
        network.https ? "direct" : "local",
        "--tls-cert-file",
        network.https ? path.join(home, "dev-web/tls/server.crt") : "",
        "--tls-key-file",
        network.https ? path.join(home, "dev-web/tls/server.key") : "",
        "--allowed-origins",
        urls.origins.join(","),
        "--project-id",
        id,
        "--discovery-port",
        String(o.acceptance ? 18888 : 8788),
        "--dev-upstream",
        viteURL,
      ];
      viteChild = start(
        o.config.tools.node,
        [
          path.join(root, "apps/web/node_modules/vite/bin/vite.js"),
          path.join(root, "apps/web"),
        ],
        "web",
        {
          ...childEnv,
          LINKOS_WEB_PORT: String(vitePort),
          LINKOS_WEB_HOST: "127.0.0.1",
          LINKOS_WEB_GATEWAY_ENTRY: "1",
          LINKOS_WEB_ENTRY_URL: webURL,
          LINKOS_WEB_TLS_CERT: "",
          LINKOS_WEB_TLS_KEY: "",
          LINKOS_GATEWAY_URL: webURL,
          LINKOS_PROJECT_ID: id,
        },
      );
      try {
        await waitReady(viteURL + "/__linkos/dev", viteChild);
        gatewayChild = start(binary, gatewayArgs, "gateway-process", childEnv);
        await waitReady(webURL + "/__linkos/dev", gatewayChild, 30000, { ca });
        break;
      } catch (error) {
        const output = (gatewayChild?.output ?? "") + (viteChild?.output ?? "");
        if (
          !/EADDRINUSE|address already in use|Only one usage|port.*already in use/i.test(
            output,
          ) ||
          attempt === 2
        )
          throw error;
        if (gatewayChild && children.has(gatewayChild)) {
          await stopGateway(home, gatewayChild.pid);
          await exited(gatewayChild);
        }
        if (viteChild && children.has(viteChild)) {
          viteChild.kill("SIGTERM");
          await exited(viteChild);
        }
        excluded.push(port);
        message(
          "Port changed between probing and binding; retrying owned services.",
        );
      }
    }
    record = {
      schemaVersion: 2,
      topology: "gateway",
      projectId: id,
      webURL,
      gatewayURL: webURL,
      viteURL,
      lanURLs: urls.lanURLs,
      webCA,
      launcherPID: process.pid,
      gatewayPID: gatewayChild.pid,
      webPID: viteChild.pid,
    };
    await writeJSON(registry, record);
    initializing = false;
    message(
      `\nLinkOS: ${webURL}\n${urls.lanURLs.map((url) => `LAN: ${url}\n`).join("")}${webCA ? `LAN client trust: ${webCA}\nTrust instructions: ${path.join(home, "dev-web/tls/TRUST.txt")}\n` : ""}Vite (internal): ${viteURL}\nData: ${home}\nLogs: ${logs}\nAdministrator passcode: ${path.join(home, "ADMIN-PASSCODE.txt")}\nCtrl+C stops only services created by this launcher.`,
    );
    async function rebuild() {
      if (closing) return;
      if (restarting) {
        pending = true;
        return;
      }
      restarting = true;
      try {
        const next = await buildGateway(o);
        if (closing) return;
        const old = gatewayChild;
        await stopGateway(home, old.pid);
        await exited(old);
        gatewayChild = start(next, gatewayArgs, "gateway-process", childEnv);
        await waitReady(webURL + "/__linkos/dev", gatewayChild, 30000, { ca });
        record.gatewayPID = gatewayChild.pid;
        await writeJSON(registry, record);
        message("Gateway reloaded; persistent data restored.");
      } catch (error) {
        message(
          `Build/reload failed: ${error.message}. Compilation failures keep the old Gateway running.`,
        );
        if (!children.has(gatewayChild)) await shutdown(1);
      } finally {
        restarting = false;
        if (pending && !closing) {
          pending = false;
          timer = setTimeout(rebuild, 250);
        }
      }
    }
    watchers.push(
      watch(
        path.join(root, "services/gateway"),
        { recursive: true },
        (_event, file) => {
          if (
            file &&
            /\.(go|mod|sum)$/.test(file) &&
            !file.includes("bundle")
          ) {
            clearTimeout(timer);
            timer = setTimeout(rebuild, 500);
          }
        },
      ),
    );
  } catch (error) {
    console.error(error.message);
    await shutdown(1);
  }
}

try {
  if (o.command === "setup") await prepareProject(o);
  else if (o.action === "status") await status();
  else if (o.action === "stop") await stop();
  else if (o.action === "logs") await displayLogs();
  else await development();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
