import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { sha256 } from "js-sha256";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: storage,
    location: { origin: "https://desktop.test" },
  },
});

// Load the real modules after installing browser storage. Only fetch is replaced.
const {
  uploadFile,
  rememberUploadedFile,
  loadUploadedFiles,
  downloadResource,
} = await import("./uploads.js");
const { createSession, setGatewayBase, ApiError } = await import("./api.js");
const { refreshProfile } = await import("./session.js");
const { getCachedHash, setCachedHash } = await import("./hashCache.js");
const INDEX = "linkos.upload-sessions";
const HISTORY = "linkos.uploaded-files";
const profile = {
  userId: "user1",
  workspaceId: "ws1",
  displayName: "Test",
  role: "member",
  accessType: "full",
  status: "active",
};
const scope = {
  gatewayBase: "https://desktop.test",
  workspaceId: "ws1",
  userId: "user1",
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
const noProgress = () => {};
const file = (name = "test.txt", content = "abcdefghij") =>
  new File([content], name, { type: "text/plain", lastModified: 123 });
const index = (): Record<string, string> =>
  JSON.parse(storage.getItem(INDEX) ?? "{}");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("disabling an app pauses upload and reselecting resumes the same session", async () => {
  const state = server(),
    input = file(),
    controller = new AbortController();
  await assert.rejects(
    uploadFile(
      input,
      "parent",
      (progress) => {
        if (progress.phase === "uploading") controller.abort();
      },
      4,
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(state.sessions.size, 1);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 0);
  const result = await uploadFile(input, "parent", noProgress, 4);
  assert.ok(result.entryId);
  assert.equal(state.sessions.size, 1);
});

beforeEach(async () => {
  storage.clear();
  globalThis.fetch = async () => json({ ...profile, accessToken: "token1" });
  await createSession({ displayName: "Test", workspaceId: "ws1" });
});

type Call = { url: string; path: string; method: string; init: RequestInit };
function server() {
  const sessions = new Map<string, any>();
  const entries = new Map<string, any>();
  const calls: Call[] = [];
  const state = {
    sessions,
    entries,
    calls,
    loseComplete: false,
    negotiatedChunkSize: undefined as number | undefined,
    completionFields: {} as Record<string, unknown>,
    intercept: undefined as
      | ((call: Call) => Promise<Response | undefined> | Response | undefined)
      | undefined,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url, "https://desktop.test").pathname;
    const call = { url, path, method: init.method ?? "GET", init };
    calls.push(call);
    const intercepted = await state.intercept?.(call);
    if (intercepted) return intercepted;
    if (path === "/api/v1/uploads" && call.method === "POST") {
      const body = JSON.parse(String(init.body));
      const chunkSize = state.negotiatedChunkSize ?? body.chunkSize;
      const id = `upload_${sessions.size + 1}`;
      const session = {
        ...body,
        id,
        chunkSize,
        totalParts: Math.max(1, Math.ceil(body.size / chunkSize)),
        status: "created",
        receivedParts: [],
      };
      sessions.set(id, session);
      return json(session, 201);
    }
    const match = path.match(/^\/api\/v1\/uploads\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session)
        return json({ error: "NOT_FOUND", message: "upload not found" }, 404);
      const suffix = match[2];
      if (!suffix && call.method === "GET") return json(session);
      if (suffix?.startsWith("parts/") && call.method === "PATCH") {
        const partNo = Number(suffix.slice(6));
        const bytes = await (init.body as Blob).arrayBuffer();
        assert.equal(
          new Headers(init.headers).get("x-part-sha256"),
          sha256.hex(bytes),
        );
        if (!session.receivedParts.includes(partNo))
          session.receivedParts.push(partNo);
        session.status = "uploading";
        return json({ accepted: true });
      }
      if (suffix === "complete" && call.method === "POST") {
        session.status = "completed";
        session.entryId = `entry_${session.id}`;
        session.resourceId = `sha256:${session.contentHash}`;
        const name = `server-${session.name}`;
        entries.set(session.entryId, {
          id: session.entryId,
          type: "file",
          name,
          workspaceId: profile.workspaceId,
          meta: { size: session.size },
        });
        if (state.loseComplete) throw new TypeError("completion response lost");
        return json({
          uploadId: session.id,
          entryId: session.entryId,
          resourceId: session.resourceId,
          contentHash: session.contentHash,
          name,
          status: "completed",
          ...state.completionFields,
        });
      }
    }
    if (path.startsWith("/api/v1/resources/") && call.method === "GET") {
      const entry = entries.get(
        decodeURIComponent(path.slice("/api/v1/resources/".length)),
      );
      return entry
        ? json(entry)
        : json({ error: "NOT_FOUND", message: "resource not found" }, 404);
    }
    throw new Error(`Unexpected fetch: ${call.method} ${url}`);
  };
  return state;
}
function creates(state: ReturnType<typeof server>) {
  return state.calls.filter(
    (call) => call.path === "/api/v1/uploads" && call.method === "POST",
  );
}
async function lostCompletion(
  state: ReturnType<typeof server>,
  input = file(),
) {
  state.loseComplete = true;
  await assert.rejects(
    uploadFile(input, "parent", noProgress, 4),
    /completion response lost/,
  );
  state.loseComplete = false;
  assert.equal(Object.values(index()).length, 1);
  return input;
}

test("completion uses the entry ID and server conflict-resolved name", async () => {
  const state = server();
  const record = await uploadFile(file(), "parent", noProgress, 4);
  assert.equal(record.entryId, "entry_upload_1");
  assert.equal(record.name, "server-test.txt");
  assert.deepEqual(record.scope, scope);
  assert.equal(JSON.parse(String(creates(state)[0].init.body)).chunkSize, 4);
  assert.deepEqual(index(), {});
});

test("completion accepts the gateway finalName field", async () => {
  const state = server();
  state.completionFields = { name: undefined, finalName: "collision (2).txt" };
  assert.equal(
    (await uploadFile(file(), "parent", noProgress, 4)).name,
    "collision (2).txt",
  );
});

test("completion without a final name resolves the current entry instead of the local name", async () => {
  const state = server();
  state.completionFields = { name: undefined };
  assert.equal(
    (await uploadFile(file(), "parent", noProgress, 4)).name,
    "server-test.txt",
  );
  assert.equal(
    state.calls.filter((call) => call.path.startsWith("/api/v1/resources/"))
      .length,
    1,
  );
});

test("freezes gateway, identity, metadata and parent before hashing yields", async () => {
  setGatewayBase("https://gateway-a.test");
  const state = server();
  const input = file();
  const originalSlice = input.slice.bind(input);
  const entered = deferred<void>();
  const release = deferred<void>();
  let hashing = true;
  Object.defineProperty(input, "slice", {
    value: (start: number, end: number) => {
      const blob = originalSlice(start, end);
      if (!hashing) return blob;
      hashing = false;
      return {
        arrayBuffer: async () => {
          entered.resolve();
          await release.promise;
          return blob.arrayBuffer();
        },
      };
    },
  });
  let parent = "original-parent";
  const uploading = uploadFile(input, parent, noProgress, 4);
  await entered.promise;
  setGatewayBase("https://gateway-b.test");
  const uploadFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    json({
      ...profile,
      userId: "user2",
      workspaceId: "ws2",
      accessToken: "token2",
    });
  await createSession({ displayName: "Other", workspaceId: "ws2" });
  globalThis.fetch = uploadFetch;
  parent = "other-parent";
  Object.defineProperty(input, "name", { value: "mutated.txt" });
  Object.defineProperty(input, "size", { value: 1 });
  release.resolve();
  const record = await uploading;
  assert.ok(
    state.calls.every((call) => call.url.startsWith("https://gateway-a.test/")),
  );
  assert.ok(
    state.calls.every(
      (call) =>
        new Headers(call.init.headers).get("authorization") === "Bearer token1",
    ),
  );
  const body = JSON.parse(String(creates(state)[0].init.body));
  assert.equal(body.parentId, "original-parent");
  assert.equal(body.name, "test.txt");
  assert.equal(body.size, 10);
  assert.equal(body.contentHash, sha256.hex("abcdefghij"));
  assert.equal(record.size, 10);
  assert.deepEqual(record.scope, {
    ...scope,
    gatewayBase: "https://gateway-a.test",
  });
  rememberUploadedFile(record);
  assert.equal(
    loadUploadedFiles().length,
    0,
    "remember uses the original upload scope, not the current UI scope",
  );
  setGatewayBase("https://gateway-a.test");
  refreshProfile(profile);
  assert.equal(loadUploadedFiles()[0].entryId, record.entryId);
});

for (const dimension of [
  "gateway",
  "workspace",
  "user",
  "parent",
  "name",
  "size",
  "hash",
] as const) {
  test(`resume index isolates ${dimension}`, async () => {
    const state = server();
    const input = await lostCompletion(state);
    if (dimension === "gateway") setGatewayBase("https://another.test");
    if (dimension === "workspace")
      refreshProfile({ ...profile, workspaceId: "other" });
    if (dimension === "user") refreshProfile({ ...profile, userId: "other" });
    const next =
      dimension === "name"
        ? file("other.txt")
        : dimension === "size"
          ? file("test.txt", "short")
          : dimension === "hash"
            ? new File(["0123456789"], "test.txt", { lastModified: 456 })
            : input;
    await uploadFile(
      next,
      dimension === "parent" ? "other" : "parent",
      noProgress,
      4,
    );
    assert.equal(creates(state).length, 2);
    assert.deepEqual(
      Object.values(index()),
      ["upload_1"],
      "the unrelated retry pointer remains",
    );
  });
}

test("resume identity is delimiter-safe", async () => {
  const state = server();
  refreshProfile({ ...profile, workspaceId: "ws:one", userId: "two" });
  const input = await lostCompletion(state);
  refreshProfile({ ...profile, workspaceId: "ws", userId: "one:two" });
  await uploadFile(input, "parent", noProgress, 4);
  assert.equal(creates(state).length, 2);
});

test("lost completion recovers the same entry and its current name without POSTing", async () => {
  const state = server();
  const input = await lostCompletion(state);
  state.entries.get("entry_upload_1").name = "renamed-after-upload.txt";
  const before = state.calls.length;
  const record = await uploadFile(input, "parent", noProgress, 7);
  assert.equal(record.entryId, "entry_upload_1");
  assert.equal(record.name, "renamed-after-upload.txt");
  assert.deepEqual(
    state.calls.slice(before).map((call) => [call.method, call.path]),
    [
      ["GET", "/api/v1/uploads/upload_1"],
      ["GET", "/api/v1/resources/entry_upload_1"],
    ],
  );
  assert.deepEqual(index(), {});
});

test("a completed session missing entryId never uses its CAS ID", async () => {
  const state = server();
  const input = await lostCompletion(state);
  delete state.sessions.get("upload_1").entryId;
  const saved = index();
  await assert.rejects(
    uploadFile(input, "parent", noProgress, 4),
    /entry|目录项/i,
  );
  assert.deepEqual(index(), saved);
  assert.equal(creates(state).length, 1);
});

test("a completion response missing entryId preserves the retry pointer", async () => {
  const state = server();
  state.completionFields = { entryId: undefined };
  await assert.rejects(
    uploadFile(file(), "parent", noProgress, 4),
    /entry|目录项/i,
  );
  assert.deepEqual(Object.values(index()), ["upload_1"]);
});

test("deleted completed entries fail explicitly and cannot be resurrected by repeated retry", async () => {
  const state = server();
  const input = await lostCompletion(state);
  state.entries.clear();
  const saved = index();
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(
      uploadFile(input, "parent", noProgress, 4),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 404 &&
        /deleted|删除/i.test(error.message),
    );
    assert.deepEqual(index(), saved);
  }
  assert.equal(creates(state).length, 1);
});

for (const target of ["session", "entry"] as const) {
  for (const failure of ["network", 401, 403, 500] as const) {
    test(`${target} ${failure} failures preserve the pointer without a replacement upload`, async () => {
      const state = server();
      const input = await lostCompletion(state);
      const saved = index();
      state.intercept = (call) => {
        const path =
          target === "session"
            ? "/api/v1/uploads/upload_1"
            : "/api/v1/resources/entry_upload_1";
        if (call.path !== path) return;
        if (failure === "network") throw new TypeError("offline");
        return json({ error: "UNAVAILABLE" }, failure);
      };
      await assert.rejects(uploadFile(input, "parent", noProgress, 4));
      assert.deepEqual(index(), saved);
      assert.equal(creates(state).length, 1);
    });
  }
}

test("only an actual upload-session 404 permits creating a replacement", async () => {
  const state = server();
  const input = await lostCompletion(state);
  state.intercept = (call) =>
    call.path === "/api/v1/uploads/upload_1"
      ? json({ error: "NOT_FOUND" }, 404)
      : undefined;
  const record = await uploadFile(input, "parent", noProgress, 4);
  assert.equal(record.entryId, "entry_upload_2");
  assert.equal(creates(state).length, 2);
  assert.deepEqual(index(), {});
});

for (const status of ["failed", "canceled", "verifying"]) {
  test(`${status} session cannot silently create a replacement`, async () => {
    const state = server();
    const input = await lostCompletion(state);
    state.sessions.get("upload_1").status = status;
    const saved = index();
    await assert.rejects(
      uploadFile(input, "parent", noProgress, 4),
      /session|会话/i,
    );
    assert.deepEqual(index(), saved);
    assert.equal(creates(state).length, 1);
  });
}

test("fresh upload uses server-negotiated chunks", async () => {
  const state = server();
  state.negotiatedChunkSize = 3;
  await uploadFile(file(), "parent", noProgress, 8);
  const parts = state.calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(
    await Promise.all(parts.map((call) => (call.init.body as Blob).text())),
    ["abc", "def", "ghi", "j"],
  );
});

test("resume uses the session chunk size, skips received parts and reports negotiated progress", async () => {
  const state = server();
  const input = file();
  state.intercept = (call) =>
    call.method === "PATCH" ? json({ error: "OFFLINE" }, 503) : undefined;
  await assert.rejects(uploadFile(input, "parent", noProgress, 4));
  state.sessions.get("upload_1").receivedParts = [0, 2];
  state.intercept = undefined;
  const before = state.calls.length;
  const progress: any[] = [];
  await uploadFile(input, "parent", (value) => progress.push(value), 7);
  const parts = state.calls
    .slice(before)
    .filter((call) => call.method === "PATCH");
  assert.deepEqual(
    parts.map((call) => call.path),
    ["/api/v1/uploads/upload_1/parts/1"],
  );
  assert.equal(await (parts[0].init.body as Blob).text(), "efgh");
  assert.deepEqual(
    progress.find((value) => value.phase === "uploading"),
    {
      phase: "uploading",
      hashedBytes: 10,
      sentParts: 2,
      totalParts: 3,
      sentBytes: 6,
      totalBytes: 10,
    },
  );
  assert.equal(progress.at(-1).sentBytes, 10);
  assert.equal(creates(state).length, 1);
});

test("simultaneous session creation merges both retry pointers", async () => {
  const state = server();
  const both = deferred<void>();
  const release = deferred<void>();
  let count = 0;
  state.intercept = async (call) => {
    if (call.path === "/api/v1/uploads") {
      count += 1;
      if (count === 2) both.resolve();
      await release.promise;
    }
    if (call.method === "PATCH") return json({ error: "OFFLINE" }, 503);
  };
  const first = assert.rejects(
    uploadFile(file("first.txt"), "parent", noProgress, 4),
  );
  const second = assert.rejects(
    uploadFile(file("second.txt"), "parent", noProgress, 4),
  );
  await both.promise;
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(Object.values(index()).sort(), ["upload_1", "upload_2"]);
});

test("completion removes only its pointer using the latest storage", async () => {
  const state = server();
  state.intercept = (call) => {
    if (call.path.endsWith("/complete"))
      storage.setItem(
        INDEX,
        JSON.stringify({ ...index(), unrelated: "in-flight" }),
      );
  };
  await uploadFile(file(), "parent", noProgress, 4);
  assert.deepEqual(index(), { unrelated: "in-flight" });
});

test("completion cannot remove a newer session for the same identity", async () => {
  const state = server();
  state.intercept = (call) => {
    if (call.path.endsWith("/complete")) {
      const key = Object.keys(index())[0];
      storage.setItem(
        INDEX,
        JSON.stringify({ ...index(), [key]: "newer-session" }),
      );
    }
  };
  await uploadFile(file(), "parent", noProgress, 4);
  assert.deepEqual(Object.values(index()), ["newer-session"]);
});

test("completed recovery removes only its pointer using latest storage", async () => {
  const state = server();
  const input = await lostCompletion(state);
  state.intercept = (call) => {
    if (call.path.startsWith("/api/v1/resources/"))
      storage.setItem(
        INDEX,
        JSON.stringify({ ...index(), unrelated: "in-flight" }),
      );
  };
  await uploadFile(input, "parent", noProgress, 4);
  assert.deepEqual(index(), { unrelated: "in-flight" });
});

test("retry reuses the cached hash rather than reading the whole file again", async () => {
  const state = server();
  const input = await lostCompletion(state);
  Object.defineProperty(input, "slice", {
    value: () => {
      throw new Error("must reuse cached hash");
    },
  });
  const record = await uploadFile(input, "parent", noProgress, 4);
  assert.equal(record.entryId, "entry_upload_1");
});

test("stale cached hash is recomputed once without drifting upload context", async () => {
  const state = server();
  const input = file();
  const stale = sha256.hex("stale data");
  setCachedHash(storage, input, stale);
  state.intercept = (call) => {
    if (
      call.path.endsWith("/complete") &&
      JSON.parse(String(call.init.body)).contentHash === stale
    ) {
      setGatewayBase("https://other.test");
      refreshProfile({ ...profile, userId: "other", workspaceId: "other" });
      return json({ error: "UPLOAD_PART_INVALID" }, 422);
    }
  };
  const record = await uploadFile(input, "parent", noProgress, 4);
  const bodies = creates(state).map((call) =>
    JSON.parse(String(call.init.body)),
  );
  assert.deepEqual(
    bodies.map((body) => body.contentHash),
    [stale, sha256.hex("abcdefghij")],
  );
  assert.equal(getCachedHash(storage, input), sha256.hex("abcdefghij"));
  assert.deepEqual(record.scope, scope);
  assert.ok(
    state.calls.every(
      (call) =>
        new URL(call.url, scope.gatewayBase).origin === scope.gatewayBase,
    ),
  );
});

test("a second hash mismatch is surfaced instead of retrying forever", async () => {
  const state = server();
  const input = file();
  setCachedHash(storage, input, sha256.hex("stale data"));
  state.intercept = (call) =>
    call.path.endsWith("/complete")
      ? json({ error: "UPLOAD_PART_INVALID" }, 422)
      : undefined;
  await assert.rejects(
    uploadFile(input, "parent", noProgress, 4),
    (error: unknown) => error instanceof ApiError && error.status === 422,
  );
  assert.equal(creates(state).length, 2);
});

test("same-content entries coexist and updating one entry replaces only that row", async () => {
  const record = {
    name: "one.txt",
    size: 10,
    mimeType: "text/plain",
    entryId: "entry1",
    resourceId: "sha256:shared",
    uploadedAt: "2026-01-01T00:00:00Z",
  };
  rememberUploadedFile(record);
  rememberUploadedFile({ ...record, entryId: "entry2", name: "two.txt" });
  rememberUploadedFile({ ...record, name: "renamed.txt" });
  assert.deepEqual(
    loadUploadedFiles().map((item) => [item.entryId, item.name]),
    [
      ["entry1", "renamed.txt"],
      ["entry2", "two.txt"],
    ],
  );
});

for (const dimension of ["gateway", "workspace", "user"] as const) {
  test(`new history isolates ${dimension} while legacy contentHash rows remain available`, () => {
    const legacy = {
      name: "legacy.txt",
      size: 10,
      mimeType: "text/plain",
      resourceId: "sha256:shared",
      contentHash: "shared",
      uploadedAt: "2025-01-01T00:00:00Z",
    };
    storage.setItem(
      HISTORY,
      JSON.stringify([
        legacy,
        { ...legacy, name: "legacy-two.txt", contentHash: "another" },
      ]),
    );
    const record = {
      name: "new.txt",
      size: 10,
      mimeType: "text/plain",
      entryId: "entry1",
      resourceId: "sha256:shared",
      uploadedAt: "2026-01-01T00:00:00Z",
    };
    rememberUploadedFile(record);
    if (dimension === "gateway") setGatewayBase("https://other.test");
    if (dimension === "workspace")
      refreshProfile({ ...profile, workspaceId: "other" });
    if (dimension === "user") refreshProfile({ ...profile, userId: "other" });
    assert.deepEqual(
      loadUploadedFiles().map((item) => item.name),
      ["legacy.txt", "legacy-two.txt"],
    );
    assert.ok(
      loadUploadedFiles().every(
        (item) => item.legacy === true && !item.entryId,
      ),
    );
    rememberUploadedFile({ ...record, name: "other-scope.txt" });
    assert.deepEqual(
      loadUploadedFiles().map((item) => item.name),
      ["other-scope.txt", "legacy.txt", "legacy-two.txt"],
    );
    setGatewayBase("");
    refreshProfile(profile);
    const records = loadUploadedFiles();
    assert.deepEqual(
      records.map((item) => item.name),
      ["new.txt", "legacy.txt", "legacy-two.txt"],
    );
    assert.equal(records[0].legacy, false);
    assert.deepEqual(
      JSON.parse(storage.getItem(HISTORY)!).filter((item: any) => !item.scope),
      [legacy, { ...legacy, name: "legacy-two.txt", contentHash: "another" }],
    );
  });
}

test("history limiting never truncates legacy rows or other scopes", () => {
  const legacy = {
    name: "legacy.txt",
    size: 0,
    mimeType: "text/plain",
    resourceId: "sha256:old",
    contentHash: "old",
    uploadedAt: "2025-01-01",
  };
  storage.setItem(HISTORY, JSON.stringify([legacy]));
  const record = {
    name: "new.txt",
    size: 0,
    mimeType: "text/plain",
    entryId: "other",
    resourceId: "sha256:shared",
    uploadedAt: "2026-01-01",
  };
  setGatewayBase("https://other.test");
  rememberUploadedFile(record);
  setGatewayBase("");
  for (let n = 0; n < 105; n++)
    rememberUploadedFile({ ...record, entryId: `entry_${n}` });
  assert.equal(loadUploadedFiles().filter((item) => !item.legacy).length, 100);
  assert.equal(loadUploadedFiles().filter((item) => item.legacy).length, 1);
  setGatewayBase("https://other.test");
  assert.deepEqual(
    loadUploadedFiles().map((item) => item.name),
    ["new.txt", "legacy.txt"],
  );
});

test("downloads use bearer auth and the current API gateway with an encoded entry ID", async (t) => {
  const clicks: string[] = [];
  const anchor = {
    href: "",
    download: "",
    click() {
      clicks.push(this.download);
    },
    remove() {},
  };
  t.mock.method(URL, "createObjectURL", () => "blob:download");
  t.mock.method(URL, "revokeObjectURL", () => {});
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => anchor,
      querySelector: () => null,
      body: { append() {} },
    },
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, "document", prior);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const calls: Array<[string, string | null]> = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), new Headers(init?.headers).get("authorization")]);
    return new Response("file content");
  };
  setGatewayBase("https://download-a.test");
  await downloadResource("entry/one", "one.txt");
  setGatewayBase("https://download-b.test");
  await downloadResource("entry/two", "two.txt");
  assert.deepEqual(calls, [
    [
      "https://download-a.test/api/v1/files/entry%2Fone/content",
      "Bearer token1",
    ],
    [
      "https://download-b.test/api/v1/files/entry%2Ftwo/content",
      "Bearer token1",
    ],
  ]);
  assert.deepEqual(clicks, ["one.txt", "two.txt"]);
});
