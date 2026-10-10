import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (data) => createHash("sha256").update(data).digest("hex");
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Store-only ZIP keeps packaging portable and reproducible without a ZIP binary.
export function zipFiles(files) {
  const entries = [],
    central = [];
  let offset = 0;
  for (const [name, contents] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const data = Buffer.from(contents),
      filename = Buffer.from(name),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entries.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, index, end]);
}
export function packageFiles(resources, privateKey) {
  const files = new Map(resources);
  if (!files.has("manifest.json")) throw new Error("manifest.json required");
  const checks = {
    format: 1,
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, data]) => ({
        path: name,
        size: Buffer.byteLength(data),
        sha256: hash(data),
      })),
  };
  const raw = Buffer.from(JSON.stringify(checks));
  files.set("checksums.json", raw);
  if (privateKey)
    files.set(
      "signature.ed25519",
      Buffer.from(
        sign(null, raw, privateKey).toString("base64").replace(/=+$/, ""),
      ),
    );
  const result = zipFiles(files);
  if (result.length > 50 * 1024 * 1024)
    throw new Error("Package exceeds 50 MiB");
  return result;
}
export async function packPlugin(source, output, keyFile) {
  source = path.resolve(source);
  const files = new Map();
  let total = 0;
  async function collect(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name,
        full = path.join(directory, entry.name),
        info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Symlink refused: ${name}`);
      if (info.isDirectory()) await collect(full, name + "/");
      else {
        if (info.size > 16 * 1024 * 1024)
          throw new Error(`File exceeds 16 MiB: ${name}`);
        total += info.size;
        if (total > 128 * 1024 * 1024 || files.size >= 997)
          throw new Error("Package exceeds limits");
        files.set(name, await readFile(full));
      }
    }
  }
  files.set(
    "manifest.json",
    await readFile(path.join(source, "manifest.json")),
  );
  await collect(path.join(source, "ui"), "ui/");
  const manifest = JSON.parse(files.get("manifest.json"));
  if (
    manifest.apiVersion !== "1.0" ||
    !manifest.entry?.ui?.endsWith(".html") ||
    !files.has(manifest.entry.ui)
  )
    throw new Error("API 1.0 and a packaged HTML UI entry required");
  // The emitted SDK has no runtime imports; it works behind the network-deny CSP.
  const require = createRequire(path.join(root, "apps/web/package.json")),
    ts = require("typescript");
  const sdk = await readFile(
    path.join(root, "packages/plugin-sdk/src/index.ts"),
    "utf8",
  );
  files.set(
    "ui/linkos-sdk.js",
    Buffer.from(
      ts.transpileModule(sdk, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    ),
  );
  const key = keyFile ? createPrivateKey(await readFile(keyFile)) : undefined;
  if (key && key.asymmetricKeyType !== "ed25519")
    throw new Error("Ed25519 private key required");
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, packageFiles(files, key));
  console.log(
    `Packaged ${manifest.id} ${manifest.version}: ${path.resolve(output)}`,
  );
}
async function main() {
  const [command, source, output, ...args] = process.argv.slice(2);
  if (command === "keygen") {
    if (!source)
      throw new Error("Usage: plugin-package.mjs keygen <private-key.pem>");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await writeFile(
      source,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600, flag: "wx" },
    );
    console.log(
      "LINKOS_PLUGIN_TRUSTED_KEYS=" +
        publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("hex"),
    );
  } else if (command === "pack" && source && output) {
    await packPlugin(
      source,
      output,
      args[0] === "--key-file" ? args[1] : undefined,
    );
  } else
    throw new Error(
      "Usage: plugin-package.mjs pack <directory> <output.linkos-plugin> [--key-file key.pem]",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
