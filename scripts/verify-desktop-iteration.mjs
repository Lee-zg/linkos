import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// Creates synthetic records; point this only at an isolated acceptance Gateway.
const base = process.env.LINKOS_ACCEPTANCE_GATEWAY?.replace(/\/$/, "");
assert.ok(base, "Set LINKOS_ACCEPTANCE_GATEWAY to an isolated Gateway URL");
async function request(token, method, path, data, expected = 200) {
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { "content-type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${response.status}`,
  );
  return result;
}
const sender = await request(
  null,
  "POST",
  "/api/v1/sessions",
  { workspaceId: "demo", displayName: "附件发送验收", accessType: "login" },
  201,
);
const receiver = await request(
  null,
  "POST",
  "/api/v1/sessions",
  { workspaceId: "demo", displayName: "附件接收验收", accessType: "login" },
  201,
);
const outsider = await request(
  null,
  "POST",
  "/api/v1/sessions",
  { workspaceId: "demo", displayName: "权限边界验收", accessType: "login" },
  201,
);
const a = sender.accessToken,
  b = receiver.accessToken,
  c = outsider.accessToken;
const ap = await request(a, "GET", "/api/v1/file-preferences");
const bp = await request(b, "GET", "/api/v1/file-preferences");
const channel = await request(
  a,
  "POST",
  "/api/v1/channels",
  { kind: "direct", name: "附件双端验收", memberIds: [receiver.userId] },
  201,
);
assert.deepEqual(
  new Set(channel.memberIds),
  new Set([sender.userId, receiver.userId]),
);
const bytes = Buffer.from(
  "LinkOS acceptance: real file and code delivery. 文件接收验收。\n",
);
const hash = createHash("sha256").update(bytes).digest("hex");
const upload = await request(
  a,
  "POST",
  "/api/v1/uploads",
  {
    name: "iteration-preview.txt",
    size: bytes.length,
    mimeType: "text/plain",
    contentHash: hash,
    parentId: ap.outgoingId,
  },
  201,
);
const preflight = await fetch(base + `/api/v1/uploads/${upload.id}/parts/0`, {
  method: "OPTIONS",
  headers: {
    Origin: "http://localhost:5174",
    "Access-Control-Request-Method": "PATCH",
    "Access-Control-Request-Headers": "authorization,x-part-sha256",
  },
});
assert.match(
  preflight.headers.get("access-control-allow-headers"),
  /X-Part-SHA256/i,
);
const part = await fetch(base + `/api/v1/uploads/${upload.id}/parts/0`, {
  method: "PATCH",
  headers: { authorization: `Bearer ${a}`, "x-part-sha256": hash },
  body: bytes,
});
assert.equal(part.status, 200);
const done = await request(
  a,
  "POST",
  `/api/v1/uploads/${upload.id}/complete`,
  { contentHash: hash },
  201,
);
const payload = {
  channelId: channel.id,
  body: "真实附件双端传输",
  clientMsgId: crypto.randomUUID(),
  blocks: [
    { type: "file.reference", value: { resourceId: done.entryId } },
    {
      type: "code.snippet",
      value: {
        language: "typescript",
        content: "await receive(file, downloads);",
      },
    },
  ],
};
const sent = await request(a, "POST", "/api/v1/messages", payload, 201);
const page = await request(
  b,
  "GET",
  `/api/v1/resources?scope=files&parentId=${bp.downloadsId}`,
);
assert.equal(
  page.items.filter((item) => item.meta?.messageId === sent.messageId).length,
  1,
  "immediate auto receipt",
);
const receipt = await request(
  b,
  "POST",
  `/api/v1/chat-receipts/${sent.messageId}`,
);
const content = await fetch(
  base + `/api/v1/files/${receipt.items[0].id}/content`,
  { headers: { authorization: `Bearer ${b}` } },
);
assert.equal(content.status, 200);
assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
const again = await request(a, "POST", "/api/v1/messages", payload);
assert.equal(again.status, "duplicate");
assert.equal(
  (await request(b, "POST", `/api/v1/chat-receipts/${sent.messageId}`)).items[0]
    .id,
  receipt.items[0].id,
);
await request(c, "GET", `/api/v1/channels/${channel.id}`, undefined, 403);
await request(
  c,
  "POST",
  `/api/v1/chat-receipts/${sent.messageId}`,
  undefined,
  403,
);
await request(c, "GET", `/api/v1/resources/${bp.downloadsId}`, undefined, 403);
const custom = await request(
  b,
  "POST",
  "/api/v1/resources",
  { name: "接收归档", type: "folder", parentId: bp.inboxId },
  201,
);
await request(b, "PATCH", "/api/v1/file-preferences", {
  receiveFolderId: custom.id,
});
const next = await request(
  a,
  "POST",
  "/api/v1/messages",
  { ...payload, clientMsgId: crypto.randomUUID() },
  201,
);
assert.equal(
  (await request(b, "POST", `/api/v1/chat-receipts/${next.messageId}`)).items[0]
    .parentId,
  custom.id,
);
const op = await request(b, "POST", "/api/v1/file-operations", {
  action: "copy",
  ids: [receipt.items[0].id],
  parentId: custom.id,
});
await request(b, "POST", "/api/v1/file-operations", {
  action: "trash",
  ids: [op.items[0].id],
});
await request(b, "POST", "/api/v1/file-operations", {
  action: "restore",
  ids: [op.items[0].id],
});
assert.equal(
  (await request(b, "GET", "/api/v1/resources/" + op.items[0].id)).parentId,
  custom.id,
);
console.log(
  "PASS: real multipart upload, CORS preflight, private conversation, automatic Downloads delivery, byte equality, retry deduplication, nonmember denial, custom receive folder, copy/trash/restore.",
);
