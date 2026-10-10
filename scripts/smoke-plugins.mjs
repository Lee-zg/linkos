// CI/local acceptance owns an isolated home and child processes only.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, waitReady, stopGateway } from "./dev-support.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  web = path.join(root, "apps/web");
await mkdir(path.join(root, ".local"), { recursive: true });
const home = await mkdtemp(path.join(root, ".local", "plugins-ci-"));
const releaseBinary = process.env.LINKOS_PLUGIN_SMOKE_BINARY;
const binary = releaseBinary
  ? path.resolve(releaseBinary)
  : path.join(home, process.platform === "win32" ? "linkos.exe" : "linkos");
const gatewayPort = await freePort(18890),
  webPort = await freePort(5182);
const gateway = `${releaseBinary ? "https" : "http"}://127.0.0.1:${gatewayPort}`;
const base = releaseBinary ? gateway : `http://127.0.0.1:${webPort}`;
const spawnChild = (command, args, options = {}) =>
  spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnChild(command, args, options);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed: ${code}`)),
    );
  });
if (!releaseBinary)
  await run("go", ["build", "-o", binary, "."], {
    cwd: path.join(root, "services/gateway"),
  });
const passcode = "isolated-plugin-ci-passcode";
const keyFile = path.join(home, "plugin-test-key.pem");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), {
  mode: 0o600,
});
const trustedKey = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
await run(
  binary,
  [
    "init",
    ...(releaseBinary ? ["--lan", "--host", "127.0.0.1"] : ["--dev"]),
    "--home",
    home,
    "--listen",
    `127.0.0.1:${gatewayPort}`,
    "--public-url",
    gateway,
    "--allowed-origins",
    `${base},${gateway}`,
    ...(releaseBinary ? [] : ["--plugin-dir", path.join(root, "plugins")]),
    "--admin-passcode",
    passcode,
  ],
  { env: { ...process.env, LINKOS_PLUGIN_TRUSTED_KEYS: trustedKey } },
);
let server, vite;
try {
  server = spawnChild(binary, ["serve", "--home", home], {
    // Each browser case signs in with a fresh device; session throttling has its
    // own Go contract tests. Keep production defaults outside this isolated home.
    env: {
      ...process.env,
      LINKOS_SESSION_RATE_CAPACITY: "120",
      LINKOS_SESSION_RATE_REFILL: "30",
    },
  });
  if (releaseBinary) {
    const ca = await readFile(path.join(home, "tls/ca.crt"));
    let ready = false;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      ready = await new Promise((done) => {
        const request = https.get(
          gateway + "/api/v1/readyz",
          { ca },
          (response) => {
            response.resume();
            done(response.statusCode === 200);
          },
        );
        request.on("error", () => done(false));
        request.setTimeout(1000, () => request.destroy());
      });
      if (ready) break;
      await new Promise((done) => setTimeout(done, 150));
    }
    if (!ready) throw new Error("Release Gateway did not become ready");
  } else await waitReady(gateway + "/api/v1/readyz", server);
  if (!releaseBinary)
    vite = spawnChild(
      process.execPath,
      [path.join(web, "node_modules/vite/bin/vite.js")],
      {
        cwd: web,
        env: {
          ...process.env,
          LINKOS_PROJECT_ID: `plugins-ci-${path.basename(home)}`,
          LINKOS_GATEWAY_URL: gateway,
          LINKOS_WEB_PORT: String(webPort),
        },
      },
    );
  const until = Date.now() + 30000;
  let available = !!releaseBinary;
  while (!available && Date.now() < until) {
    try {
      const response = await fetch(base + "/__linkos/dev");
      if (response.ok) {
        available = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 150));
  }
  if (!available) throw new Error("Acceptance Web did not start");
  await run(
    process.execPath,
    [
      path.join(web, "node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/plugins.spec.ts",
      "e2e/mvp.spec.ts",
      "--workers=1",
      "--reporter=line",
    ],
    {
      cwd: web,
      env: {
        ...process.env,
        LINKOS_E2E_BASE_URL: base,
        LINKOS_E2E_ADMIN_PASSCODE: passcode,
        LINKOS_E2E_PLUGIN_SIGNING_KEY: keyFile,
        LINKOS_E2E_IGNORE_HTTPS: releaseBinary ? "1" : "0",
      },
    },
  );
} finally {
  if (vite?.exitCode === null) vite.kill();
  if (server?.exitCode === null) await stopGateway(home, server.pid);
}
