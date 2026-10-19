// Source-checkout bootstrap only. The installed Go CLI does not need Node or Go.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNodeVersion,
  delay,
  launcherLock,
  readJSON,
  writeJSON,
} from "./dev-support.mjs";

export const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
process.env.LINKOS_BOOTSTRAP_NODE = process.execPath;
export function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: sourceRoot,
      windowsHide: true,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
export async function ensureCLI(args = []) {
  checkNodeVersion();
  let go = process.env.LINKOS_GO;
  if (!go) {
    let file = path.join(sourceRoot, "linkos.config.json");
    const index = args.indexOf("--project-config");
    if (index >= 0) file = path.resolve(args[index + 1]);
    try {
      go = JSON.parse(await readFile(file, "utf8")).tools?.go;
    } catch {}
    if (go?.includes("/") || go?.includes("\\"))
      go = path.resolve(path.dirname(file), go);
  }
  const goArg = args.findIndex((a) => a === "--go" || a.startsWith("--go="));
  if (goArg >= 0)
    go = args[goArg].includes("=") ? args[goArg].slice(5) : args[goArg + 1];
  go ??= "go";
  const hash = createHash("sha256");
  const directory = path.join(sourceRoot, "services/gateway");
  async function hashSources(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "bundle") await hashSources(file);
      } else if (
        (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) ||
        entry.name === "go.mod" ||
        entry.name === "go.sum"
      ) {
        hash.update(path.relative(directory, file));
        hash.update(await readFile(file));
      }
    }
  }
  await hashSources(directory);
  hash.update(await readFile(path.join(sourceRoot, "go.work")));
  hash.update(
    await readFile(path.join(sourceRoot, "go.work.sum")).catch(() => ""),
  );
  const binary = path.join(
    sourceRoot,
    ".local/bin",
    `linkos-cli-${hash.digest("hex").slice(0, 20)}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (existsSync(binary)) {
    await writeJSON(path.join(sourceRoot, ".local/bin/cli-current.json"), {
      binary,
    });
    return binary;
  }
  await mkdir(path.dirname(binary), { recursive: true });
  let release;
  const deadline = Date.now() + 180000;
  while (
    !(release = await launcherLock(binary + ".lock", "linkos-cli-build"))
  ) {
    if (existsSync(binary)) return binary;
    if (Date.now() > deadline)
      throw new Error("CLI build already in progress; try again shortly");
    await delay(250);
  }
  try {
    if (!existsSync(binary))
      await execute(go, ["build", "-o", binary, "./services/gateway"], {
        env: {
          ...process.env,
          GOCACHE:
            process.env.GOCACHE ?? path.join(sourceRoot, ".local/go-cache"),
        },
      });
    await writeJSON(path.join(sourceRoot, ".local/bin/cli-current.json"), {
      binary,
    });
  } catch (error) {
    const previous = await readJSON(
      path.join(sourceRoot, ".local/bin/cli-current.json"),
    );
    if (
      previous?.binary &&
      path.dirname(previous.binary) === path.join(sourceRoot, ".local/bin") &&
      existsSync(previous.binary)
    ) {
      console.error(
        `Source CLI compilation failed; using the previous CLI for diagnostics and service reuse. ${error.message}`,
      );
      return previous.binary;
    }
    throw new Error(
      `Cannot prepare the source CLI: ${error.message}. Go 1.25/1.26 must be installed; configure LINKOS_GO if needed.`,
    );
  } finally {
    await release();
  }
  return binary;
}

export async function adapterOptions(command, args = []) {
  if (process.env.LINKOS_CLI_OPTIONS)
    return JSON.parse(process.env.LINKOS_CLI_OPTIONS);
  const binary = await ensureCLI(args);
  process.env.LINKOS_CLI_BINARY = binary;
  const { execFile } = await import("node:child_process");
  const raw = await new Promise((resolve, reject) =>
    execFile(
      binary,
      ["_project", command, ...args],
      {
        cwd: sourceRoot,
        env: process.env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    ),
  );
  return JSON.parse(raw);
}

async function main() {
  const args = process.argv.slice(2);
  const binary = await ensureCLI(args);
  await execute(binary, args);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
