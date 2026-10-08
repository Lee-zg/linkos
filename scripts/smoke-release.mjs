// Exercises only fresh, isolated workspaces; never attaches to daily services.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freePort, waitReady, stopGateway, delay } from "./dev-support.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(binary, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    c.once("error", reject);
    c.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed: ${code}`)),
    );
  });
}
async function exercise(base, passcode, restart) {
  let token, refresh;
  async function api(method, url, body, status = 200) {
    const r = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    assert.equal(r.status, status, `${method} ${url}: ${JSON.stringify(data)}`);
    return data;
  }
  assert.match(await (await fetch(base + "/")).text(), /<html/);
  assert.equal((await fetch(base + "/files")).status, 200);
  assert.equal((await fetch(base + "/api/no-such-route")).status, 404);
  const health = await api("GET", "/api/v1/readyz");
  assert.equal(health.capabilities.runner, false);
  assert.equal(health.capabilities.embeddedWeb, true);
  const session = await api(
    "POST",
    "/api/v1/sessions",
    {
      workspaceId: "demo",
      displayName: "release-smoke",
      accessType: "login",
      passcode,
    },
    201,
  );
  token = session.accessToken;
  refresh = session.refreshToken;
  assert.equal(session.role, "admin");
  const plugins = await api("GET", "/api/v1/plugins");
  for (const p of plugins.items) {
    assert.equal(
      p.version,
      health.version,
      "built-in plugin must match program release version",
    );
    const response = await fetch(
      base + `/api/v1/plugins/${p.id}/content/${p.manifest.entry.ui}`,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /linkos.plugin.ready/);
  }
  const preferences = await api("GET", "/api/v1/file-preferences");
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 19, 0x5a),
    hash = createHash("sha256").update(bytes).digest("hex");
  const upload = await api(
    "POST",
    "/api/v1/uploads",
    {
      name: "large-smoke.bin",
      size: bytes.length,
      chunkSize: bytes.length,
      contentHash: hash,
      parentId: preferences.outgoingId,
    },
    201,
  );
  const part = await fetch(base + `/api/v1/uploads/${upload.id}/parts/0`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "x-part-sha256": hash },
    body: bytes,
  });
  assert.equal(part.status, 200);
  const done = await api(
    "POST",
    `/api/v1/uploads/${upload.id}/complete`,
    { contentHash: hash },
    201,
  );
  const resume = await api(
    "POST",
    "/api/v1/uploads",
    {
      name: "resume.bin",
      size: 8,
      chunkSize: 4,
      parentId: preferences.outgoingId,
    },
    201,
  );
  // This body can be delayed past the old global 30-second deadline in CI.
  const slow = process.env.LINKOS_SLOW_SMOKE === "1";
  async function* slowPart() {
    yield Buffer.from("ab");
    if (slow) await delay(31000);
    yield Buffer.from("cd");
  }
  const pending = await fetch(base + `/api/v1/uploads/${resume.id}/parts/0`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "x-part-sha256": createHash("sha256").update("abcd").digest("hex"),
    },
    body: ReadableStream.from(slowPart()),
    duplex: "half",
  });
  assert.equal(pending.status, 200);
  const channel = await api(
    "POST",
    "/api/v1/channels",
    { name: "Smoke persisted channel", kind: "group" },
    201,
  );
  const ws = new WebSocket(
    base.replace(/^http/, "ws") +
      `/api/v1/ws?access_token=${encodeURIComponent(token)}`,
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket timeout")),
      5000,
    );
    ws.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    ws.onerror = reject;
  });
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket event timeout")),
      5000,
    );
    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === "chat.message.created") {
        clearTimeout(timeout);
        resolve();
      }
    };
  });
  await api(
    "POST",
    "/api/v1/messages",
    {
      channelId: channel.id,
      body: "persisted smoke message",
      clientMsgId: crypto.randomUUID(),
    },
    201,
  );
  await received;
  ws.close();
  async function verify() {
    const refreshed = await api("POST", "/api/v1/sessions/refresh", {
      refreshToken: refresh,
    });
    token = refreshed.accessToken;
    refresh = refreshed.refreshToken;
    assert.equal(refreshed.userId, session.userId);
    const response = await fetch(
      base + `/api/v1/files/${done.entryId}/content`,
      { headers: { authorization: `Bearer ${token}`, Range: "bytes=10-29" } },
    );
    assert.equal(response.status, 206);
    assert.equal(
      Buffer.from(await response.arrayBuffer()).compare(bytes.subarray(10, 30)),
      0,
    );
    const state = await api("GET", `/api/v1/uploads/${resume.id}`);
    assert.deepEqual(state.receivedParts, [0]);
    const messages = await api(
      "GET",
      `/api/v1/channels/${channel.id}/messages`,
    );
    assert.ok(messages.items.some((m) => m.body === "persisted smoke message"));
  }
  if (restart) await restart(verify);
  else await verify();
  console.log(
    "PASS: HTTPS, embedded Web/plugins, login, WS, >8 MiB upload, Range" +
      (restart
        ? ", persisted identity/chat/upload and full backup/restore"
        : "; live endpoint checks"),
  );
}

if (process.argv[2] === "--exercise") {
  const [binary, home, base] = process.argv.slice(3);
  const config = JSON.parse(
    await readFile(path.join(home, "linkos.json"), "utf8"),
  );
  let child;
  async function start(dir) {
    child = spawn(binary, ["serve", "--home", dir], {
      cwd: path.dirname(dir),
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, PATH: "" },
    });
    await waitReady(base + "/api/v1/readyz", child);
  }
  async function stop(dir) {
    const c = child;
    await stopGateway(dir, c.pid);
    await new Promise((resolve) =>
      c.exitCode !== null ? resolve() : c.once("exit", resolve),
    );
    child = null;
  }
  try {
    await start(home);
    await command(binary, ["status", "--home", home]);
    await exercise(base, config.adminPasscode, async (verify) => {
      // Backup must fail while a writer holds the data lock.
      let refused = false;
      try {
        await command(binary, [
          "backup",
          "--home",
          home,
          "--output",
          path.join(home, "online.tar.gz"),
        ]);
      } catch {
        refused = true;
      }
      assert.equal(refused, true);
      await stop(home);
      await start(home);
      await verify();
      await stop(home);
      const archive = path.join(home, "workspace.tar.gz");
      await command(binary, ["backup", "--home", home, "--output", archive]);
      const target = home + "-restored";
      await mkdir(target, { recursive: true });
      const restored = {
        ...config,
        dataDir: path.join(target, "data"),
        uploadDir: path.join(target, "data", "uploads"),
      };
      await writeFile(
        path.join(target, "linkos.json"),
        JSON.stringify(restored),
      );
      await command(binary, ["restore", archive, "--home", target]);
      await start(target);
      await verify();
      await stop(target);
    });
  } finally {
    if (child) await stop(home);
  }
} else if (process.argv[2] === "--url") {
  const maintenance = process.argv.includes("--compose-maintenance");
  await exercise(
    process.argv[3],
    process.env.LINKOS_SMOKE_PASSCODE,
    maintenance
      ? async (verify) => {
          await command("docker", ["compose", "stop", "gateway"]);
          await command("docker", [
            "compose",
            "run",
            "--rm",
            "--no-deps",
            "gateway",
            "backup",
            "--home",
            "/var/lib/linkos",
            "--output",
            "/var/lib/linkos/backups/ci-full.tar.gz",
          ]);
          await command("docker", [
            "compose",
            "run",
            "--rm",
            "--no-deps",
            "gateway",
            "restore",
            "/var/lib/linkos/backups/ci-full.tar.gz",
            "--home",
            "/var/lib/linkos",
            "--replace",
          ]);
          await command("docker", ["compose", "up", "-d", "--wait"]);
          await verify();
        }
      : null,
  );
} else {
  const binary = path.resolve(
    process.argv[2] ??
      path.join(
        root,
        "release",
        "linkos-0.1.0-dev-windows-amd64",
        "linkos.exe",
      ),
  );
  await mkdir(path.join(root, ".local"), { recursive: true });
  const home = await mkdtemp(path.join(root, ".local", "release-smoke-"));
  const port = await freePort(19887),
    base = `https://127.0.0.1:${port}`;
  await command(binary, [
    "init",
    "--lan",
    "--host",
    "127.0.0.1",
    "--home",
    home,
    "--listen",
    `127.0.0.1:${port}`,
    "--public-url",
    base,
  ]);
  await command(
    process.execPath,
    [fileURLToPath(import.meta.url), "--exercise", binary, home, base],
    {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: path.join(home, "tls", "ca.crt"),
      },
    },
  );
  console.log(`Smoke workspace retained: ${home}`);
}
