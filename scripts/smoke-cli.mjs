import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  access,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "./dev-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.resolve(process.argv[2]);
const dailyFile = path.join(root, ".local/linkos/dev.json");
const dailyBefore = await readFile(dailyFile, "utf8").catch(() => null);
if (dailyBefore) {
  const daily = JSON.parse(dailyBefore),
    ca = daily.webCA
      ? await readFile(daily.webCA).catch(() => undefined)
      : undefined;
  if (daily.gatewayURL)
    await probe(daily.gatewayURL + "/api/v1/healthz", { ca });
}
await mkdir(path.join(root, ".local"), { recursive: true });
const fixture = await mkdtemp(path.join(root, ".local/cli smoke-"));
const install = path.join(fixture, "installation with spaces"),
  home = path.join(fixture, "workspace");
const cleanEnv = { ...process.env, PATH: "", Path: "" };
delete cleanEnv.LINKOS_BOOTSTRAP_NODE;
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: fixture,
      env: cleanEnv,
      windowsHide: true,
      ...options,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const success = async (args, command = binary, options) => {
  const result = await run(command, args, options);
  assert.equal(result.code, 0, JSON.stringify(result));
  return result;
};
await success(["cli", "install", "--install-dir", install]);
const registration = JSON.parse(
  await readFile(path.join(install, "install.json"), "utf8"),
);
const installed = registration.binary;
assert.ok(JSON.parse((await success(["version"], installed)).stdout).version);
if (process.platform === "win32") {
  const command = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/cmd.exe",
  );
  await success(
    ["/d", "/s", "/c", `""${registration.launcher}" version"`],
    command,
    { windowsVerbatimArguments: true },
  );
} else await success(["version"], registration.launcher);
const checksumBefore = (await stat(installed)).mtimeMs;
await success(["cli", "install", "--install-dir", install]);
assert.equal(
  (await stat(installed)).mtimeMs,
  checksumBefore,
  "Immutable binary must not be rewritten on reinstall",
);

const config = path.join(fixture, "project settings.json");
await writeFile(config, await readFile(path.join(root, "linkos.config.json")));
await success(
  [
    "--project",
    root,
    "--project-config",
    config,
    "config",
    "set",
    "dev.port",
    "61234",
  ],
  installed,
);
assert.equal(
  JSON.parse(
    (
      await success(
        [
          "config",
          "get",
          "dev.port",
          "--project",
          root,
          "--project-config",
          config,
        ],
        installed,
      )
    ).stdout,
  ),
  "61234",
);
const configBefore = await readFile(config, "utf8");
assert.notEqual(
  (
    await run(installed, [
      "config",
      "set",
      "dev.port",
      "99999",
      "--project",
      root,
      "--project-config",
      config,
    ])
  ).code,
  0,
);
assert.equal(await readFile(config, "utf8"), configBefore);

const doctor = await run(installed, [
  "doctor",
  "--project",
  root,
  "--node",
  "missing-linkos-node",
  "--go",
  "missing-linkos-go",
  "--json",
]);
assert.notEqual(doctor.code, 0);
const checks = JSON.parse(doctor.stdout).checks;
assert.ok(checks.some((c) => c.id === "node" && c.status === "fail"));
assert.ok(checks.some((c) => c.id === "go" && c.status === "fail"));
await success(["init", "--home", home], installed);
await success(["doctor", "--runtime", "--home", home, "--json"], installed);

const launcherBefore = await readFile(registration.launcher);
await writeFile(registration.launcher, "unrelated replacement");
assert.notEqual(
  (await run(installed, ["cli", "install", "--install-dir", install])).code,
  0,
);
assert.equal(
  await readFile(registration.launcher, "utf8"),
  "unrelated replacement",
);
await writeFile(registration.launcher, launcherBefore);
await success(["cli", "uninstall", "--install-dir", install], installed);
await assert.rejects(access(registration.launcher));
await access(installed);
await access(path.join(home, "linkos.json"));
assert.equal(await readFile(dailyFile, "utf8").catch(() => null), dailyBefore);
console.log(
  "PASS: standalone CLI without Node/Go, spaced install paths and launcher, immutable reinstall, config mutation/precedence, aggregated diagnostics, conflict protection, uninstall preserving workspace and versions",
);
