import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, watch, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  checkNodeVersion,
  developmentOptions,
  developmentNetwork,
  developmentURLs,
  belongsToProject,
  freePort,
  launcherLock,
  probe,
  projectID,
  readJSON,
  writeJSON,
  waitReady,
  stopGateway,
  processOwnsPort,
} from "./dev-support.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "dev",
  acceptance = process.argv.includes("--acceptance");
const home = process.env.LINKOS_DEV_HOME
    ? path.resolve(process.env.LINKOS_DEV_HOME)
    : path.join(root, ".local", acceptance ? "acceptance" : "linkos"),
  id =
    process.env.LINKOS_LEGACY_PROJECT_ID ??
    (await projectID(root)) +
      (home === path.join(root, ".local/linkos")
        ? ""
        : "-" + path.basename(home));
const configFile = path.join(home, "linkos.json"),
  registry = path.join(home, "dev.json");
const vite = path.join(root, "apps/web/node_modules/vite/bin/vite.js"),
  go = process.env.LINKOS_GO ?? "go";
const env = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? path.join(root, ".local", "go-cache"),
};
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    c.once("error", reject);
    c.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
function checkTools() {
  checkNodeVersion();
  const v = execFileSync(go, ["version"], {
    env,
    windowsHide: true,
    encoding: "utf8",
  }).trim();
  if (!/go1\.(25|26)\./.test(v))
    throw new Error("Go 1.25 or compatible 1.26 required");
  console.log(`Node ${process.versions.node}; ${v}`);
}
let sequence = 0;
async function buildGateway() {
  const dir = path.join(root, ".local", "bin");
  await mkdir(dir, { recursive: true });
  const binary = path.join(
    dir,
    `gateway-${process.pid}-${sequence++}${process.platform === "win32" ? ".exe" : ""}`,
  );
  await run(go, ["build", "-o", binary, "./services/gateway"]);
  return binary;
}
async function setup() {
  checkTools();
  const win = process.platform === "win32";
  const localCLI = path.join(
    root,
    ".local/tooling/node_modules/pnpm/bin/pnpm.cjs",
  );
  const command = existsSync(localCLI)
    ? process.execPath
    : win
      ? "cmd.exe"
      : "pnpm";
  const prefix = existsSync(localCLI) ? [localCLI] : win ? ["/d", "/c"] : [];
  const v = execFileSync(
    command,
    existsSync(localCLI)
      ? [...prefix, "--version"]
      : win
        ? [...prefix, "pnpm --version"]
        : ["--version"],
    { env, windowsHide: true, encoding: "utf8" },
  ).trim();
  if (v !== "9.15.5") throw new Error(`pnpm 9.15.5 required: ${v}`);
  await run(
    command,
    existsSync(localCLI)
      ? [...prefix, "install", "--frozen-lockfile"]
      : win
        ? [...prefix, "pnpm install --frozen-lockfile"]
        : ["install", "--frozen-lockfile"],
    {
      env: { ...env, CI: "true" },
    },
  );
  for (const service of ["gateway", "runner"])
    await run(go, ["mod", "download"], {
      cwd: path.join(root, "services", service),
    });
  const binary = await buildGateway();
  await mkdir(home, { recursive: true });
  if (!existsSync(configFile))
    await run(binary, ["init", "--dev", "--home", home, "--project-id", id]);
  console.log(`Prepared ${home}; run pnpm dev`);
}
async function status() {
  developmentNetwork(developmentOptions(process.argv.slice(3)));
  const saved = (await readJSON(registry)) ?? {};
  const ca = saved.webCA
    ? await readFile(saved.webCA).catch(() => undefined)
    : undefined;
  const [web, gateway] = await Promise.all([
    saved.webURL ? probe(saved.webURL + "/__linkos/dev", { ca }) : null,
    saved.gatewayURL ? probe(saved.gatewayURL + "/api/v1/healthz") : null,
  ]);
  console.log(
    JSON.stringify(
      {
        web: belongsToProject(web, id, "web") ? saved.webURL : "not found",
        lan: belongsToProject(web, id, "web") ? (web.lanURLs ?? []) : [],
        certificate: belongsToProject(web, id, "web") ? saved.webCA : undefined,
        gateway: belongsToProject(gateway, id, "gateway")
          ? { url: saved.gatewayURL, storage: gateway.storage }
          : "not found",
        home,
        logs: path.join(home, "logs"),
      },
      null,
      2,
    ),
  );
}
async function development() {
  checkTools();
  const preferred = developmentOptions(process.argv.slice(3));
  const network = developmentNetwork(preferred);
  if (!existsSync(vite) || !existsSync(configFile))
    throw new Error("Run pnpm run setup:dev first");
  const releaseLock = await launcherLock(path.join(home, "dev.lock"), id);
  if (!releaseLock) {
    await status();
    console.log(
      "Workspace launcher already active; reusing its existing ports. No duplicate started.",
    );
    return;
  }
  const children = new Set(),
    watchers = [];
  let closing = false,
    restarting = false,
    buildPending = false,
    timer,
    gatewayChild,
    webChild;
  const logs = path.join(home, "logs");
  await mkdir(logs, { recursive: true });
  const instanceId = randomBytes(24).toString("hex"),
    token = randomBytes(32).toString("hex");
  const controlFile = path.join(home, "dev-control.json");
  const controller = createServer((request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers["x-linkos-instance"] !== instanceId
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "POST" && request.url === "/stop") {
      response.end("stopping");
      setImmediate(() => shutdown());
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    controller.once("error", reject);
    controller.listen(0, "127.0.0.1", resolve);
  });
  await writeJSON(controlFile, {
    projectId: id,
    launcherPID: process.pid,
    instanceId,
    token,
    url: `http://127.0.0.1:${controller.address().port}`,
  });
  function start(command, args, name, childEnv = env) {
    const log = createWriteStream(path.join(logs, name + ".log"), {
      flags: "a",
      mode: 0o600,
    });
    const child = spawn(command, args, {
      cwd: root,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        log.write(data);
        process.stdout.write(`[${name}] ${data}`);
      });
    child.once("error", (e) => {
      console.error(e);
      shutdown(1);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      log.end();
      if (!closing && !(restarting && child === gatewayChild)) {
        console.error(`${name} exited (${code ?? signal})`);
        shutdown(1);
      }
    });
    return child;
  }
  async function exited(c) {
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise((resolve) => c.once("exit", resolve));
  }
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    watchers.forEach((w) => w.close());
    try {
      if (gatewayChild && children.has(gatewayChild)) {
        await stopGateway(home, gatewayChild.pid);
        await exited(gatewayChild);
      }
      if (webChild && children.has(webChild)) {
        webChild.kill("SIGTERM");
        await exited(webChild);
      }
    } catch (e) {
      console.error(
        `Shutdown: ${e.message}; no existing service was force-killed.`,
      );
      code = 1;
    }
    await releaseLock();
    controller.closeAllConnections();
    await new Promise((resolve) => controller.close(resolve));
    const control = await readJSON(controlFile);
    if (control?.instanceId === instanceId)
      await rm(controlFile, { force: true });
    process.exitCode = code;
    if (process.connected) process.disconnect();
  }
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  if (process.send)
    process.on("message", (message) => {
      if (message?.type === "linkos.stop") {
        shutdown().finally(() => {
          if (process.connected) process.disconnect();
        });
      }
    });
  try {
    const saved = await readJSON(registry);
    const runtime = await readJSON(path.join(home, "run.json"));
    let gatewayURL, webURL, gatewayPort, webCA, ca, webInfo;
    async function choosePort(
      preferredPort,
      previousURL,
      service,
      excluded = [],
      host = "127.0.0.1",
    ) {
      const previous = previousURL ? Number(new URL(previousURL).port) : 0;
      const requested = preferredPort || previous;
      const port = await freePort(requested, excluded, host).catch((error) => {
        if (preferredPort) throw error;
        return freePort(0, excluded, host);
      });
      if (preferredPort && port !== preferredPort)
        console.log(
          `${service}: preferred port ${preferredPort} is occupied or reserved; using ${port}.`,
        );
      else if (!preferredPort)
        console.log(
          `${service}: automatic port ${port}${port === previous ? " (previous address retained)" : ""}.`,
        );
      return port;
    }
    for (const url of [
      ...new Set(
        [
          saved?.gatewayURL,
          runtime?.url,
          ...(preferred.gatewayPort
            ? [`http://127.0.0.1:${preferred.gatewayPort}`]
            : []),
          ...(acceptance || process.env.LINKOS_DEV_HOME
            ? []
            : ["http://127.0.0.1:8787"]),
        ].filter(Boolean),
      ),
    ]) {
      const h = await probe(url + "/api/v1/healthz");
      const legacy =
        h?.service === "gateway" &&
        !h.projectId &&
        !acceptance &&
        (url === process.env.LINKOS_LEGACY_GATEWAY_URL ||
          (!process.env.LINKOS_DEV_HOME &&
            (await processOwnsPort(Number(new URL(url).port), root))));
      if (belongsToProject(h, id, "gateway") || legacy) {
        gatewayURL = url;
        console.log(
          `Reusing Gateway ${url} (${h.storage ?? "legacy memory/unknown storage"}); no automatic restart or shutdown.`,
        );
        break;
      }
    }
    if (!gatewayURL) {
      if (process.env.LINKOS_LEGACY_GATEWAY_URL)
        throw new Error(
          "The verified legacy Gateway exited before adoption; run linkos dev again. No replacement was started.",
        );
      gatewayPort = await choosePort(
        preferred.gatewayPort,
        saved?.gatewayURL,
        "Gateway",
      );
      gatewayURL = `http://127.0.0.1:${gatewayPort}`;
    }
    for (const url of [
      ...new Set(
        [
          saved?.webURL,
          ...(preferred.webPort
            ? [
                `http://127.0.0.1:${preferred.webPort}`,
                `https://127.0.0.1:${preferred.webPort}`,
              ]
            : []),
          ...(acceptance || process.env.LINKOS_DEV_HOME
            ? []
            : ["http://127.0.0.1:5173"]),
        ].filter(Boolean),
      ),
    ]) {
      const savedCA = saved?.webCA
        ? await readFile(saved.webCA).catch(() => undefined)
        : undefined;
      const h = await probe(url + "/__linkos/dev", { ca: savedCA });
      if (belongsToProject(h, id, "web") && h.gatewayURL === gatewayURL) {
        webURL = url;
        webInfo = h;
        webCA = saved?.webCA;
        ca = savedCA;
        console.log(`Reusing Web ${url}`);
        break;
      }
    }
    const webPort = webURL
      ? Number(new URL(webURL).port)
      : await choosePort(
          preferred.webPort,
          saved?.webURL,
          "Web",
          [Number(new URL(gatewayURL).port)],
          network.host,
        );
    const reuseWeb = !!webURL;
    const urls = developmentURLs(network, webPort);
    webURL ??= urls.webURL;
    let binary;
    if (gatewayPort || (!reuseWeb && network.https))
      binary = await buildGateway();
    if (!reuseWeb && network.https) {
      await run(binary, [
        "tls",
        "dev",
        "--home",
        home,
        "--host",
        network.addresses.join(","),
      ]);
      webCA = path.join(home, "dev-web/tls/ca.crt");
      ca = await readFile(webCA);
    }
    const gatewayArgs = [
      "serve",
      "--home",
      home,
      "--listen",
      `127.0.0.1:${new URL(gatewayURL).port}`,
      "--public-url",
      gatewayURL,
      "--allowed-origins",
      [
        ...new Set([
          gatewayURL,
          webURL,
          ...urls.origins,
          ...(webInfo?.lanURLs ?? []),
        ]),
      ].join(","),
      "--project-id",
      id,
      "--discovery-port",
      String(acceptance ? 18888 : 8788),
    ];
    if (gatewayPort) {
      gatewayChild = start(binary, gatewayArgs, "gateway-process", {
        ...env,
        LINKOS_DEV_PUBLIC_URL: urls.lanURLs[0] ?? webURL,
      });
      await waitReady(gatewayURL + "/api/v1/readyz", gatewayChild);
    }
    if (!reuseWeb) {
      webChild = start(
        process.execPath,
        [vite, path.join(root, "apps/web")],
        "web",
        {
          ...env,
          LINKOS_WEB_PORT: String(webPort),
          LINKOS_WEB_HOST: network.host,
          LINKOS_WEB_LAN_URLS: JSON.stringify(urls.lanURLs),
          LINKOS_WEB_TLS_CERT: network.https
            ? path.join(home, "dev-web/tls/server.crt")
            : "",
          LINKOS_WEB_TLS_KEY: network.https
            ? path.join(home, "dev-web/tls/server.key")
            : "",
          LINKOS_GATEWAY_URL: gatewayURL,
          LINKOS_PROJECT_ID: id,
        },
      );
      webInfo = await waitReady(webURL + "/__linkos/dev", webChild, 30000, {
        ca,
      });
    }
    await writeJSON(registry, {
      projectId: id,
      webURL,
      gatewayURL,
      lanURLs: webInfo?.lanURLs ?? [],
      webCA,
      launcherPID: process.pid,
      gatewayPID: gatewayChild?.pid,
      webPID: webChild?.pid,
    });
    console.log(
      `\nLinkOS: ${webURL}\n${(webInfo?.lanURLs ?? []).map((url) => `LAN: ${url}\n`).join("")}${webCA ? `LAN client trust: ${webCA}\nTrust instructions: ${path.join(home, "dev-web/tls/TRUST.txt")}\n` : ""}Gateway (local proxy target): ${gatewayURL}\nData: ${home}\nLogs: ${logs}\nAdministrator passcode: ${path.join(home, "ADMIN-PASSCODE.txt")}\nCtrl+C stops only services created by this launcher.`,
    );
    if (reuseWeb && network.addresses.length && !webInfo?.lanURLs?.length)
      console.log(
        "Existing Web is loopback-only; LAN settings take effect on its next normal start. It was not restarted.",
      );
    async function rebuild() {
      if (closing || !gatewayChild) return;
      if (restarting) {
        buildPending = true;
        return;
      }
      restarting = true;
      try {
        const binary = await buildGateway();
        if (closing) return;
        const old = gatewayChild;
        await stopGateway(home, old.pid);
        await exited(old);
        gatewayChild = start(binary, gatewayArgs, "gateway-process", {
          ...env,
          LINKOS_DEV_PUBLIC_URL: urls.lanURLs[0] ?? webURL,
        });
        await waitReady(gatewayURL + "/api/v1/readyz", gatewayChild);
        console.log("Gateway reloaded; persistent data restored.");
      } catch (e) {
        console.error(
          `Build/reload failed: ${e.message}. Compilation failures keep the old Gateway running.`,
        );
        if (!children.has(gatewayChild)) await shutdown(1);
      } finally {
        restarting = false;
        if (buildPending && !closing) {
          buildPending = false;
          timer = setTimeout(rebuild, 250);
        }
      }
    }
    if (gatewayChild)
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
  } catch (e) {
    console.error(e.message);
    await shutdown(1);
  }
}
try {
  if (mode === "setup") await setup();
  else if (mode === "status") await status();
  else if (mode === "doctor") {
    checkTools();
    console.log(
      `Dependencies: ${existsSync(vite) ? "installed" : "missing"}; config: ${existsSync(configFile) ? "initialized" : "missing"}`,
    );
    await status();
  } else if (mode === "dev") await development();
  else throw new Error(`Unknown mode: ${mode}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
