import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readdir,
  writeFile,
  rm,
  chmod,
  stat,
  mkdtemp,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stagePlugins } from "./stage-plugins.mjs";
import { adapterOptions } from "./linkos.mjs";
import { prepareProject, toolEnvironment } from "./project-tools.mjs";
import { launcherLock, projectID } from "./dev-support.mjs";
import { publishRelease } from "./release-support.mjs";

const o = await adapterOptions("pack", process.argv.slice(2));
const root = o.root,
  version = o.version,
  targets = o.config.pack.targets;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version))
  throw new Error("Invalid release version");
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {}
const outputDirectory = o.config.pack.outDir;
const bundle = path.join(root, "services/gateway/bundle");
await mkdir(path.join(root, ".local"), { recursive: true });
const unlock = await launcherLock(
  path.join(root, ".local/pack.lock"),
  await projectID(root),
);
if (!unlock)
  throw new Error(
    "Another package build is active; no shared staging was changed",
  );
// Keep staged packages on the output volume so publication can use atomic
// renames even when pack.outDir points to a different drive.
await mkdir(outputDirectory, { recursive: true });
const release = await mkdtemp(path.join(outputDirectory, ".linkos-stage-"));
async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const c = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: toolEnvironment(o),
      ...options,
    });
    c.on("error", reject);
    c.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest("hex");
}
async function tarGzip(directory, output) {
  const names = await readdir(directory);
  async function* blocks() {
    for (const name of names) {
      const file = path.join(directory, name),
        size = (await stat(file)).size;
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, "utf8");
      const octal = (offset, length, value) =>
        header.write(
          value.toString(8).padStart(length - 1, "0") + "\0",
          offset,
          length,
          "ascii",
        );
      octal(100, 8, name === "linkos" || name.endsWith(".sh") ? 0o755 : 0o644);
      octal(108, 8, 0);
      octal(116, 8, 0);
      octal(124, 12, size);
      octal(136, 12, 0);
      header.fill(32, 148, 156);
      header[156] = 48;
      header.write("ustar\0", 257, 6, "ascii");
      header.write("00", 263, 2, "ascii");
      const sum = header.reduce((s, b) => s + b, 0);
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
      yield header;
      for await (const block of createReadStream(file)) yield block;
      if (size % 512) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(blocks()),
    createGzip(),
    createWriteStream(output),
  );
}
try {
  await prepareProject(o, false);
  await run(o.config.tools.node, [
    path.join(root, "apps/web/node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--project",
    path.join(root, "apps/web"),
  ]);
  await run(
    o.config.tools.node,
    [path.join(root, "apps/web/node_modules/vite/bin/vite.js"), "build"],
    { cwd: path.join(root, "apps/web") },
  );
  // Staging lives entirely in a generated, ignored directory.
  await rm(bundle, { recursive: true, force: true });
  await mkdir(bundle, { recursive: true });
  await cp(path.join(root, "apps/web/dist"), path.join(bundle, "web"), {
    recursive: true,
  });
  await stagePlugins(
    path.join(root, "plugins"),
    path.join(bundle, "plugins"),
    version,
  );
  const outputs = [];
  for (const target of targets) {
    if (!["windows/amd64", "linux/amd64", "linux/arm64"].includes(target))
      throw new Error(`Unsupported target: ${target}`);
    const [os, arch] = target.split("/");
    const name = `linkos-${version}-${os}-${arch}`,
      dir = path.join(release, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const binary = path.join(dir, os === "windows" ? "linkos.exe" : "linkos");
    await run(
      o.config.tools.go,
      [
        "build",
        "-tags",
        "release",
        "-trimpath",
        "-ldflags",
        `-s -w -X main.buildVersion=${version} -X main.buildCommit=${commit}`,
        "-o",
        binary,
        "./services/gateway",
      ],
      {
        env: {
          ...toolEnvironment(o),
          GOOS: os,
          GOARCH: arch,
          CGO_ENABLED: "0",
        },
      },
    );
    await chmod(binary, 0o755);
    await writeFile(
      path.join(dir, "VERSION.json"),
      JSON.stringify(
        { version, commit, target, binarySHA256: await digest(binary) },
        null,
        2,
      ) + "\n",
    );
    if (os === "windows")
      await writeFile(
        path.join(dir, "start.cmd"),
        '@echo off\r\n"%~dp0linkos.exe" serve %*\r\nif errorlevel 1 pause\r\n',
      );
    else
      await writeFile(
        path.join(dir, "start.sh"),
        '#!/bin/sh\nset -eu\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/linkos" serve "$@"\n',
        { mode: 0o755 },
      );
    const output = path.join(
      release,
      name + (os === "windows" ? ".zip" : ".tar.gz"),
    );
    if (os === "windows") {
      if (process.platform === "win32")
        await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -LiteralPath '${binary.replaceAll("'", "''")}','${path.join(dir, "start.cmd").replaceAll("'", "''")}','${path.join(dir, "VERSION.json").replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`,
        ]);
      else
        await run("zip", [
          "-j",
          "-q",
          output,
          binary,
          path.join(dir, "start.cmd"),
          path.join(dir, "VERSION.json"),
        ]);
    } else await tarGzip(dir, output);
    outputs.push({
      file: path.basename(output),
      sha256: await digest(output),
      target,
    });
  }
  await writeFile(
    path.join(release, "SHA256SUMS"),
    outputs.map((o) => `${o.sha256}  ${o.file}`).join("\n") + "\n",
  );
  await writeFile(
    path.join(release, "manifest.json"),
    JSON.stringify({ version, commit, packages: outputs }, null, 2) + "\n",
  );
  await publishRelease(release, outputDirectory);
  console.log(`Release packages: ${outputDirectory}`);
} finally {
  if (path.dirname(release) !== outputDirectory)
    throw new Error("Invalid package staging path");
  await rm(release, { recursive: true, force: true });
  await unlock();
}
