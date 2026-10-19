// Own an isolated home and launcher; never change or stop daily services.
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  delay,
  probe,
  readJSON,
  projectID,
  localIPv4s,
} from "./dev-support.mjs";
import { packPlugin } from "./plugin-package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dailyRegistry = path.join(root, ".local/linkos/dev.json");
const dailyBefore = await readFile(dailyRegistry, "utf8").catch(() => null);
// Read-only service inspection precedes creating any acceptance process.
const daily = dailyBefore ? JSON.parse(dailyBefore) : null;
if (daily?.gatewayURL) await probe(daily.gatewayURL + "/api/v1/healthz");
if (daily?.webURL) {
  const ca = daily.webCA
    ? await readFile(daily.webCA).catch(() => undefined)
    : undefined;
  await probe(daily.webURL + "/__linkos/dev", { ca });
}
await mkdir(path.join(root, ".local"), { recursive: true });
const home = await mkdtemp(path.join(root, ".local/network-smoke-"));
const projectId = (await projectID(root)) + "-" + path.basename(home);
const passcode = "isolated-development-network-passcode";
await writeFile(
  path.join(home, "linkos.json"),
  JSON.stringify({
    schemaVersion: 1,
    environment: "development",
    listen: "127.0.0.1:8787",
    publicURL: "http://127.0.0.1:8787",
    tlsMode: "local",
    adminPasscode: passcode,
    dataDir: path.join(home, "data"),
    uploadDir: path.join(home, "data/uploads"),
    allowedOrigins: "http://127.0.0.1:8787",
    discoveryPort: 18888,
    projectId,
  }),
);
const environment = {
  ...process.env,
  LINKOS_DEV_HOME: home,
  LINKOS_WEB_PORT: "auto",
  LINKOS_GATEWAY_PORT: "auto",
  LINKOS_WEB_HOST: "auto",
};
delete environment.LINKOS_LAN_IP;
let output = "";
const owned = new Set();
function launch(args = []) {
  const child = fork(path.join(root, "scripts/dev.mjs"), ["dev", ...args], {
    cwd: root,
    env: environment,
    silent: true,
  });
  owned.add(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
      process.stdout.write(data);
    });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.send({ type: "linkos.stop" });
  assert.equal(await exited, 0);
}
async function ready(child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Launcher exited: ${child.exitCode}`);
    const state = await readJSON(path.join(home, "dev.json"));
    if (state?.launcherPID === child.pid) {
      const ca = state.webCA ? await readFile(state.webCA) : undefined;
      if (await probe(state.webURL + "/__linkos/dev", { ca }))
        return { ...state, ca };
    }
    await delay(200);
  }
  throw new Error(`Network launcher did not become ready: ${output}`);
}
let browser;
try {
  const child = launch();
  const first = await ready(child);
  const doctor = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [path.join(root, "scripts/linkos.mjs"), "doctor", "--json"],
      { cwd: root, env: environment, windowsHide: true, timeout: 60000 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr + stdout))
          : resolve(JSON.parse(stdout)),
    ),
  );
  assert.equal(
    doctor.checks.some((check) => check.status === "fail"),
    false,
  );
  assert.equal(
    first.webURL,
    first.gatewayURL,
    "Gateway is the only browser entry",
  );
  assert.notEqual(new URL(first.webURL).port, new URL(first.viteURL).port);
  const physical = localIPv4s().filter((item) => !item.virtual);
  if (physical.length) {
    assert.ok(first.webURL.startsWith("https://"));
    for (const item of physical)
      assert.ok(
        first.lanURLs.some((url) => new URL(url).hostname === item.address),
      );
  }
  for (const url of [first.webURL, ...first.lanURLs]) {
    const info = await probe(url + "/__linkos/dev", { ca: first.ca });
    assert.equal(info?.ready, true, `Unreachable development address: ${url}`);
    if (url === first.webURL) assert.equal(info?.projectId, projectId);
  }
  const duplicate = launch();
  assert.equal(
    await new Promise((resolve) => duplicate.once("exit", resolve)),
    0,
  );
  assert.equal(
    (await readJSON(path.join(home, "dev.json"))).gatewayPID,
    first.gatewayPID,
  );

  const require = createRequire(path.join(root, "apps/web/package.json"));
  const { chromium } = require("@playwright/test");
  browser = await chromium.launch();
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  let hmrConnected = false;
  page.on("console", (message) => {
    if (message.text().includes("[vite] connected")) hmrConnected = true;
  });
  const base = first.lanURLs[0] ?? first.webURL;
  await page.goto(base);
  assert.equal(
    await page.evaluate(
      () => window.isSecureContext && !!crypto.subtle && !!crypto.randomUUID,
    ),
    true,
  );
  await page.getByLabel("显示名").fill("LAN acceptance");
  await page.getByLabel(/口令/).fill(passcode);
  await page.getByRole("button", { name: "登录进入" }).click();
  await page
    .locator(".desktop-icons")
    .getByRole("button", { name: "应用管理", exact: true })
    .waitFor();
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem("linkos.access_token");
    const response = await fetch("/api/v1/plugins", {
      headers: { authorization: `Bearer ${token}` },
    });
    const websocket = await new Promise((resolve, reject) => {
      const url = new URL("/api/v1/ws", location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("access_token", token);
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("LAN WebSocket timeout"));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("LAN WebSocket rejected"));
      };
    });
    return { status: response.status, websocket };
  });
  assert.deepEqual(result, { status: 200, websocket: true });
  const pluginFile = path.join(home, "viewer.linkos-plugin");
  await packPlugin(
    path.join(root, "examples/plugins/resource-viewer"),
    pluginFile,
  );
  await page
    .locator(".desktop-icons")
    .getByRole("button", { name: "应用管理", exact: true })
    .dblclick();
  const manager = page.getByRole("dialog", { name: "应用管理", exact: true });
  await manager.locator('input[type="file"]').setInputFiles(pluginFile);
  await page.getByRole("button", { name: "确认权限，验证并安装" }).click();
  await page
    .getByRole("dialog", { name: "安装 资源阅读器", exact: true })
    .waitFor({ state: "hidden" });
  await manager.getByRole("button", { name: "选择应用 资源阅读器" }).click();
  await manager.getByRole("button", { name: "启用应用" }).click();
  await page.getByRole("button", { name: "确认操作" }).click();
  await manager.getByRole("button", { name: "打开应用" }).click();
  await page
    .frameLocator('iframe[title="资源阅读器 插件沙箱"]')
    .getByText("资源已加载", { exact: true })
    .waitFor();
  assert.equal(
    hmrConnected,
    true,
    "Vite HMR must connect using the LAN host and secure WebSocket",
  );
  await browser.close();
  browser = undefined;
  await stop(child);
  const nextChild = launch();
  const next = await ready(nextChild);
  assert.equal(
    next.webURL,
    first.webURL,
    "Keep the last free origin so browser drafts and identity survive restart",
  );
  assert.equal(next.gatewayURL, first.gatewayURL);
  if (first.ca)
    assert.deepEqual(next.ca, first.ca, "Keep the trusted development CA");
  await stop(nextChild);
  if (physical.length) {
    const pinnedChild = launch(["--host", physical[0].address]);
    const pinned = await ready(pinnedChild);
    assert.equal(new URL(pinned.webURL).hostname, physical[0].address);
    const duplicatePinned = launch(["--host", physical[0].address]);
    assert.equal(
      await new Promise((resolve) => duplicatePinned.once("exit", resolve)),
      0,
    );
    assert.equal(
      (await readJSON(path.join(home, "dev.json"))).gatewayPID,
      pinned.gatewayPID,
    );
    await stop(pinnedChild);
  }
  assert.equal(
    await readFile(dailyRegistry, "utf8").catch(() => null),
    dailyBefore,
  );
  console.log(
    "PASS: automatic ports, LAN HTTPS/SAN, secure-context login, same-origin API/WebSocket, HMR, plugin sandbox/SDK, duplicate reuse, stable restart ports/CA, daily workspace untouched",
  );
} finally {
  await browser?.close();
  for (const child of owned) await stop(child);
}
