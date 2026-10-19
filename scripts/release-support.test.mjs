import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishRelease } from "./release-support.mjs";

test("publication commits complete packages and publishes the manifest last", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkos-publish-"));
  try {
    const stage = path.join(root, "stage"),
      out = path.join(root, "out");
    await mkdir(stage);
    await mkdir(out);
    for (const name of ["app.zip", "manifest.json", "SHA256SUMS"]) {
      await writeFile(path.join(stage, name), "new " + name);
      await writeFile(path.join(out, name), "old " + name);
    }
    const order = [];
    await publishRelease(stage, out, {
      rename: async (a, b) => {
        if (path.dirname(a) === stage) order.push(path.basename(a));
        return rename(a, b);
      },
    });
    assert.equal(order.at(-1), "manifest.json");
    assert.equal(
      await readFile(path.join(out, "app.zip"), "utf8"),
      "new app.zip",
    );
    assert.equal(
      (await readdir(out)).some((name) => name.includes("previous")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a publication failure restores prior packages and the prior manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linkos-publish-"));
  try {
    const stage = path.join(root, "stage"),
      out = path.join(root, "out");
    await mkdir(stage);
    await mkdir(out);
    for (const name of ["app.zip", "manifest.json", "SHA256SUMS"]) {
      await writeFile(path.join(stage, name), "new " + name);
      await writeFile(path.join(out, name), "old " + name);
    }
    await assert.rejects(
      publishRelease(stage, out, {
        rename: async (a, b) => {
          if (path.dirname(a) === stage && path.basename(a) === "manifest.json")
            throw new Error("injected disk failure");
          return rename(a, b);
        },
      }),
      /injected disk failure/,
    );
    for (const name of ["app.zip", "manifest.json", "SHA256SUMS"])
      assert.equal(await readFile(path.join(out, name), "utf8"), "old " + name);
    assert.equal(
      (await readdir(out)).some((name) => name.includes("previous")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
