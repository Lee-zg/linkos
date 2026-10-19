import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkNodeVersion,
  launcherLock,
  delay,
  readJSON,
  writeJSON,
  projectID,
} from "./dev-support.mjs";
import { execute } from "./linkos.mjs";

export function toolEnvironment(o) {
  return {
    ...process.env,
    GOCACHE: process.env.GOCACHE ?? path.join(o.root, ".local/go-cache"),
  };
}
export function pnpmTool(o) {
  const local = path.join(
    o.root,
    ".local/tooling/node_modules/pnpm/bin/pnpm.cjs",
  );
  if (existsSync(local)) return [o.config.tools.node, [local]];
  if (process.platform === "win32") return ["cmd.exe", ["/d", "/c", "pnpm"]];
  return ["pnpm", []];
}
export function checkTools(o) {
  const failures = [];
  for (const [label, command, args, verify] of [
    [
      "Node",
      o.config.tools.node,
      ["--version"],
      (v) => checkNodeVersion(v.trim().replace(/^v/, ""), o.config.tools.node),
    ],
    [
      "Go",
      o.config.tools.go,
      ["version"],
      (v) => {
        if (!/go1\.(25|26)\./.test(v)) throw new Error("Go 1.25/1.26 required");
      },
    ],
    [
      "pnpm",
      pnpmTool(o)[0],
      [...pnpmTool(o)[1], "--version"],
      (v) => {
        if (v.trim() !== o.config.tools.pnpmVersion)
          throw new Error(`pnpm ${o.config.tools.pnpmVersion} required`);
      },
    ],
  ]) {
    try {
      const version = execFileSync(command, args, {
        cwd: o.root,
        env: toolEnvironment(o),
        windowsHide: true,
        timeout: 10000,
        encoding: "utf8",
      });
      verify(version);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  if (failures.length)
    throw new Error(
      failures.join("\n") +
        "\nRun linkos doctor for diagnostics. System toolchains are not installed automatically.",
    );
}

export async function preparationFingerprint(o) {
  const hash = createHash("sha256");
  for (const file of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "apps/web/package.json",
    "packages/protocol/package.json",
    "packages/plugin-sdk/package.json",
    "go.work",
    "services/gateway/go.mod",
    "services/gateway/go.sum",
    "services/runner/go.mod",
    "services/runner/go.sum",
  ]) {
    hash.update(file);
    try {
      hash.update(await readFile(path.join(o.root, file)));
    } catch (error) {
      if (error.code !== "ENOENT" || !file.endsWith("go.sum")) throw error;
      hash.update("<absent>");
    }
  }
  hash.update(JSON.stringify(o.config.tools));
  hash.update(`${process.platform}/${process.arch}/${process.versions.node}`);
  return hash.digest("hex");
}

export async function prepareProject(o, initialize = true) {
  checkTools(o);
  let unlock;
  const id = await projectID(o.root),
    deadline = Date.now() + 180000;
  while (
    !(unlock = await launcherLock(path.join(o.root, ".local/setup.lock"), id))
  ) {
    if (Date.now() > deadline)
      throw new Error(
        "Project preparation is still running; inspect the other launcher",
      );
    await delay(250);
  }
  try {
    const file = path.join(o.root, ".local/setup.json");
    const fingerprint = await preparationFingerprint(o);
    const saved = await readJSON(file);
    const vite = path.join(o.root, "apps/web/node_modules/vite/bin/vite.js");
    if (
      saved?.fingerprint !== fingerprint ||
      !existsSync(vite) ||
      !existsSync(path.join(o.root, "node_modules/.modules.yaml"))
    ) {
      const [command, prefix] = pnpmTool(o);
      console.log("Preparing locked dependencies…");
      // Preserve an existing pnpm store instead of purging working modules just
      // because a restricted shell resolves a different default store location.
      const modules = await readFile(
        path.join(o.root, "node_modules/.modules.yaml"),
        "utf8",
      ).catch(() => "");
      const store = /^storeDir: (.+)$/m.exec(modules)?.[1];
      const storeArgs = store
        ? ["--store-dir", store.replace(/^['"]|['"]$/g, "")]
        : [];
      await execute(
        command,
        [
          ...prefix,
          "install",
          "--frozen-lockfile",
          "--config.confirmModulesPurge=false",
          "--fetch-retries=1",
          "--fetch-timeout=30000",
          ...storeArgs,
        ],
        { cwd: o.root, env: { ...toolEnvironment(o), CI: "true" } },
      );
      for (const service of ["gateway", "runner"])
        await execute(o.config.tools.go, ["mod", "download"], {
          cwd: path.join(o.root, "services", service),
          env: toolEnvironment(o),
        });
      await writeJSON(file, {
        fingerprint,
        preparedAt: new Date().toISOString(),
      });
    } else console.log("Dependencies unchanged; preparation reused.");
  } finally {
    await unlock();
  }
  if (!initialize) return;
  const home = o.config.dev.home;
  await mkdir(home, { recursive: true });
  if (!existsSync(path.join(home, "linkos.json"))) {
    const binary = process.env.LINKOS_CLI_BINARY;
    if (!binary) throw new Error("CLI binary unavailable");
    await execute(
      binary,
      ["init", "--dev", "--home", home, "--project-id", await developmentID(o)],
      { cwd: o.root, env: toolEnvironment(o) },
    );
  }
}
export async function developmentID(o) {
  const normalHome = path.join(o.root, ".local/linkos");
  const home = o.config.dev.home;
  return (
    (await projectID(o.root)) +
    (path.resolve(home).toLowerCase() === normalHome.toLowerCase()
      ? ""
      : "-" + path.basename(home))
  );
}

let buildSequence = 0;
export async function buildGateway(o) {
  const directory = path.join(o.root, ".local/bin");
  await mkdir(directory, { recursive: true });
  const binary = path.join(
    directory,
    `gateway-${process.pid}-${buildSequence++}${process.platform === "win32" ? ".exe" : ""}`,
  );
  await execute(
    o.config.tools.go,
    ["build", "-o", binary, "./services/gateway"],
    { cwd: o.root, env: toolEnvironment(o) },
  );
  return binary;
}
