import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkNodeVersion,
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
