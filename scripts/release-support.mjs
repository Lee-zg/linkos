import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

// All targets must already be built. Keep replaced entries until the entire
// publication succeeds, including the manifest and checksums.
export async function publishRelease(staging, destination, operations = {}) {
  const move = operations.rename ?? rename;
  await mkdir(destination, { recursive: true });
  const moved = [],
    replaced = [];
  const names = (await readdir(staging)).sort(
    (a, b) => Number(a === "manifest.json") - Number(b === "manifest.json"),
  );
  try {
    for (const name of names) {
      const target = path.join(destination, name),
        backup = target + ".previous-" + process.pid;
      try {
        await move(target, backup);
        replaced.push([backup, target]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await move(path.join(staging, name), target);
      moved.push(target);
    }
  } catch (error) {
    for (const target of moved.reverse())
      await rm(target, { recursive: true, force: true });
    for (const [backup, target] of replaced.reverse())
      await rename(backup, target);
    throw error;
  }
  for (const [backup] of replaced)
    await rm(backup, { recursive: true, force: true });
}
