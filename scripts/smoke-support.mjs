import { cp, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { probe } from "./dev-support.mjs";

// Hot-reload tests edit only this copy, so daily watchers never see invalid Go.
export async function sourceFixture(root) {
  let state;
  try {
    state = JSON.parse(
      await readFile(path.join(root, ".local/linkos/dev.json"), "utf8"),
    );
  } catch {}
  const ca = state?.webCA
    ? await readFile(state.webCA).catch(() => undefined)
    : undefined;
  if (state?.gatewayURL)
    await probe(state.gatewayURL + "/api/v1/healthz", { ca });
  if (state?.webURL) await probe(state.webURL + "/__linkos/dev", { ca });
  await mkdir(path.join(root, ".local"), { recursive: true });
  const fixture = await mkdtemp(path.join(root, ".local/dev-source-"));
  const ignored = new Set([
    "node_modules",
    "dist",
    "bundle",
    "test-results",
    ".local",
    ".git",
  ]);
  for (const name of [
    "apps",
    "services",
    "packages",
    "plugins",
    "scripts",
    "schemas",
    "examples",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "go.work",
    "go.work.sum",
    "linkos.config.json",
    ".npmrc",
  ]) {
    const source = path.join(root, name);
    if (existsSync(source))
      await cp(source, path.join(fixture, name), {
        recursive: true,
        filter: (file) => !ignored.has(path.basename(file)),
      });
  }
  const link = async (source, target) => {
    if (existsSync(source)) {
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(
        source,
        target,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  };
  await link(
    path.join(root, "node_modules"),
    path.join(fixture, "node_modules"),
  );
  for (const dir of ["apps/web", "packages/protocol", "packages/plugin-sdk"])
    await link(
      path.join(root, dir, "node_modules"),
      path.join(fixture, dir, "node_modules"),
    );
  await link(
    path.join(root, ".local/tooling"),
    path.join(fixture, ".local/tooling"),
  );
  await mkdir(path.join(fixture, ".local"), { recursive: true });
  if (existsSync(path.join(root, ".local/setup.json")))
    await cp(
      path.join(root, ".local/setup.json"),
      path.join(fixture, ".local/setup.json"),
    );
  return fixture;
}
