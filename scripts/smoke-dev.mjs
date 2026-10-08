import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  delay,
  probe,
  readJSON,
  projectID,
  freePort,
  waitReady,
  stopGateway,
} from "./dev-support.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".local"), { recursive: true });
const home = await mkdtemp(path.join(root, ".local", "dev-smoke-"));
const port = await freePort(18887),
  id = (await projectID(root)) + "-" + path.basename(home);
await writeFile(
  path.join(home, "linkos.json"),
  JSON.stringify({
    schemaVersion: 1,
    environment: "development",
    listen: `127.0.0.1:${port}`,
    publicURL: `http://127.0.0.1:${port}`,
    dataDir: path.join(home, "data"),
    uploadDir: path.join(home, "data", "uploads"),
    tlsMode: "local",
    adminPasscode: "test-only-development-passcode",
    allowedOrigins: `http://127.0.0.1:${port}`,
    discoveryPort: 18888,
    projectId: id,
  }),
);
const blockers = [];
async function occupyPort() {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ service: "unrelated" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  blockers.push(server);
  return server.address().port;
}
const blockedWebPort = await occupyPort(),
  blockedGatewayPort = await occupyPort();
const env = {
  ...process.env,
  LINKOS_DEV_HOME: home,
  LINKOS_WEB_PORT: "1", // The CLI preference must override this environment value.
  LINKOS_GATEWAY_PORT: String(blockedGatewayPort),
};
let output = "";
function launcher() {
  const child = fork(
    path.join(root, "scripts/dev.mjs"),
    ["dev", "--acceptance", "--web-port", String(blockedWebPort)],
    { cwd: root, env, silent: true },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
      process.stdout.write(data);
    });
  return child;
}
async function until(predicate, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(200);
  }
  throw new Error(message);
}
const child = launcher();
let sentinel;
try {
  await until(async () => {
    const state = await readJSON(path.join(home, "dev.json"));
    return state && (await probe(state.webURL + "/__linkos/dev"));
  }, "launcher did not start");
  const before = await readJSON(path.join(home, "run.json")),
    registry = await readJSON(path.join(home, "dev.json"));
  assert.notEqual(Number(new URL(registry.webURL).port), blockedWebPort);
  assert.notEqual(Number(new URL(registry.webURL).port), 1);
  assert.notEqual(
    Number(new URL(registry.gatewayURL).port),
    blockedGatewayPort,
  );
  assert.ok(
    output.includes(`Web: preferred port ${blockedWebPort} is occupied`),
  );
  assert.ok(
    output.includes(
      `Gateway: preferred port ${blockedGatewayPort} is occupied`,
    ),
  );
  assert.equal(
    (await probe(registry.webURL + "/api/v1/healthz")).projectId,
    id,
  );
  for (const port of [blockedWebPort, blockedGatewayPort])
    assert.equal(
      (await probe(`http://127.0.0.1:${port}/`)).service,
      "unrelated",
    );
  const duplicate = launcher();
  const code = await new Promise((resolve) => duplicate.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal((await readJSON(path.join(home, "run.json"))).pid, before.pid);
  sentinel = path.join(
    root,
    "services/gateway",
    `reload_smoke_${process.pid}.go`,
  );
  await writeFile(sentinel, "package main\nTHIS IS NOT VALID GO\n", {
    flag: "wx",
  });
  await until(
    () => output.includes("Compilation failures keep the old Gateway running"),
    "compilation failure was not handled",
  );
  assert.equal((await readJSON(path.join(home, "run.json"))).pid, before.pid);
  assert.equal(
    (await probe(registry.gatewayURL + "/api/v1/healthz")).status,
    "ok",
  );
  await unlink(sentinel);
  sentinel = null;
  await until(async () => {
    const state = await readJSON(path.join(home, "run.json"));
    return (
      state &&
      state.pid !== before.pid &&
      output.includes("Gateway reloaded; persistent data restored.") &&
      (await probe(registry.gatewayURL + "/api/v1/readyz"))
    );
  }, "Go change did not reload");
  child.send({ type: "linkos.stop" });
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  assert.equal(await probe(registry.gatewayURL + "/api/v1/healthz"), null);
  assert.equal(await probe(registry.webURL + "/__linkos/dev"), null);

  // A standalone persistent Gateway must survive the adopting launcher's exit.
  const binary = path.join(
    home,
    process.platform === "win32" ? "fixture.exe" : "fixture",
  );
  await new Promise((resolve, reject) => {
    const compile = spawn(
      process.env.LINKOS_GO ?? "go",
      ["build", "-o", binary, "./services/gateway"],
      { cwd: root, env, stdio: "inherit", windowsHide: true },
    );
    compile.once("error", reject);
    compile.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("fixture build failed")),
    );
  });
  const standalone = spawn(
    binary,
    [
      "serve",
      "--home",
      home,
      "--public-url",
      registry.gatewayURL,
      "--listen",
      `127.0.0.1:${new URL(registry.gatewayURL).port}`,
      "--allowed-origins",
      `${registry.gatewayURL},${registry.webURL}`,
    ],
    { cwd: root, env, stdio: "inherit", windowsHide: true },
  );
  let adopter;
  try {
    await waitReady(registry.gatewayURL + "/api/v1/readyz", standalone);
    adopter = launcher();
    await until(async () => {
      const state = await readJSON(path.join(home, "dev.json"));
      return (
        state?.launcherPID === adopter.pid &&
        (await probe(registry.webURL + "/__linkos/dev"))
      );
    }, "adopter Web did not start");
    assert.equal(
      (await readJSON(path.join(home, "run.json"))).pid,
      standalone.pid,
    );
    adopter.send({ type: "linkos.stop" });
    assert.equal(
      await new Promise((resolve) => adopter.once("exit", resolve)),
      0,
    );
    assert.equal(
      (await probe(registry.gatewayURL + "/api/v1/healthz")).status,
      "ok",
    );
  } finally {
    if (adopter?.connected) {
      adopter.send({ type: "linkos.stop" });
      await new Promise((resolve) => adopter.once("exit", resolve));
    }
    if (standalone.exitCode === null) {
      await stopGateway(home, standalone.pid);
      await new Promise((resolve) => standalone.once("exit", resolve));
    }
  }
  console.log(
    "PASS: unified launch, custom CLI/environment ports, occupied-port fallback, synchronized proxy, duplicate prevention, compilation failure preservation, successful Go reload, graceful owned shutdown and adopted-service preservation",
  );
} finally {
  if (sentinel) await unlink(sentinel);
  if (child.exitCode === null && child.connected) {
    child.send({ type: "linkos.stop" });
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (const server of blockers) {
    assert.equal(server.listening, true);
    await new Promise((resolve) => server.close(resolve));
  }
}
