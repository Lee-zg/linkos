import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkNodeVersion,
  developmentPorts,
  freePort,
  launcherLock,
  belongsToProject,
} from "./dev-support.mjs";
test("Node 24 and newer stable releases pass the launcher version check", () => {
  for (const version of ["24.0.0", "24.19.0", "25.0.0", "26.4.0", "30.0.0"])
    assert.doesNotThrow(() => checkNodeVersion(version));
  assert.doesNotThrow(() => checkNodeVersion());
});
test("unsupported Node versions report the version, executable and requirement", () => {
  const executable = path.join("custom-node", "node.exe");
  for (const version of [
    "18.20.8",
    "22.18.0",
    "23.11.0",
    "26.0.0-rc.1",
    "invalid",
  ])
    assert.throws(
      () => checkNodeVersion(version, executable),
      (error) =>
        error.message.includes("Node.js 24 or newer (stable) required") &&
        error.message.includes(version) &&
        error.message.includes(executable),
    );
});
test("occupied ports are skipped without stopping their owner", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const used = server.address().port;
    assert.notEqual(await freePort(used), used);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("development ports use CLI, environment and mode defaults in order", () => {
  assert.deepEqual(developmentPorts([], {}), {
    webPort: 5173,
    gatewayPort: 8787,
  });
  assert.deepEqual(developmentPorts(["--acceptance"], {}), {
    webPort: 15173,
    gatewayPort: 18887,
  });
  const environment = { LINKOS_WEB_PORT: "5180", LINKOS_GATEWAY_PORT: "8790" };
  assert.deepEqual(developmentPorts([], environment), {
    webPort: 5180,
    gatewayPort: 8790,
  });
  assert.deepEqual(
    developmentPorts(
      ["--", "--web-port=6000", "--gateway-port", "9000"],
      environment,
    ),
    { webPort: 6000, gatewayPort: 9000 },
  );
  assert.deepEqual(developmentPorts(["--port", "6001"], environment), {
    webPort: 6001,
    gatewayPort: 8790,
  });
  assert.deepEqual(
    developmentPorts(["--web-port", "1", "--gateway-port=65535"], {
      LINKOS_WEB_PORT: "invalid",
    }),
    { webPort: 1, gatewayPort: 65535 },
  );
});
test("invalid port settings fail before a service starts", () => {
  for (const value of ["0", "-1", "65536", "1.5", "1e4", "", "auto"])
    assert.throws(
      () => developmentPorts([], { LINKOS_WEB_PORT: value }),
      /1 to 65535/,
    );
  assert.throws(
    () => developmentPorts(["--gateway-port=65536"], {}),
    /Gateway port/,
  );
  assert.throws(() => developmentPorts(["--web-port"], {}), /requires a port/);
  assert.throws(
    () => developmentPorts(["--web-port", "--gateway-port", "8790"], {}),
    /requires a port/,
  );
  assert.throws(
    () => developmentPorts(["--unknown=5180"], {}),
    /Unknown option/,
  );
});
test("port selection excludes reserved ports and stays within the TCP range", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const used = server.address().port;
  await new Promise((r) => server.close(r));
  assert.notEqual(await freePort(used, [used]), used);
  await assert.rejects(freePort(65535, [65535]), /65535–65535/);
  await assert.rejects(freePort(65536), /1 to 65535/);
});
test("concurrent launchers cannot acquire the same lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "linkos-lock-"));
  try {
    const lock = path.join(dir, "dev.lock"),
      release = await launcherLock(lock, "test");
    assert.equal(await launcherLock(lock, "test"), null);
    await release();
    const next = await launcherLock(lock, "test");
    assert.equal(typeof next, "function");
    await next();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("health identity must match both project and service", () => {
  assert.equal(
    belongsToProject(
      { service: "gateway", projectId: "other" },
      "ours",
      "gateway",
    ),
    false,
  );
  assert.equal(
    belongsToProject({ service: "web", projectId: "ours" }, "ours", "gateway"),
    false,
  );
  assert.equal(
    belongsToProject(
      { service: "gateway", projectId: "ours" },
      "ours",
      "gateway",
    ),
    true,
  );
});
