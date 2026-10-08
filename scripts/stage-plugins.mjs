import { cp, readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function stagePlugins(source, target, version) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version))
    throw new Error("Invalid plugin release version");
  await cp(source, target, { recursive: true });
  for (const directory of await readdir(target)) {
    const base = path.join(target, directory),
      file = path.join(base, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    for (const entry of Object.values(manifest.entry)) {
      if (
        !entry ||
        entry.includes("..") ||
        entry.includes("\\") ||
        path.isAbsolute(entry)
      )
        throw new Error(`Unsafe plugin entry: ${entry}`);
      if (!(await stat(path.join(base, entry))).isFile())
        throw new Error(`Missing plugin entry: ${entry}`);
    }
    manifest.version = version;
    await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [source, target, version] = process.argv.slice(2);
  await stagePlugins(source, target, version);
}
