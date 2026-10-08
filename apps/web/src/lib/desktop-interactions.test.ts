import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFileRange } from "./file-browser";
import { readChatDraft } from "./chat-draft";

test("Finder shift-selection grows from its anchor in both directions", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(
    [...selectFileRange(ids, new Set(["c"]), "a", "c", false, true)],
    ["a", "b", "c"],
  );
  assert.deepEqual(
    [...selectFileRange(ids, new Set(["a"]), "d", "b", true, true)],
    ids,
  );
  assert.deepEqual(
    [...selectFileRange(ids, new Set(["a", "c"]), "c", "a", true)],
    ["a"],
  );
  assert.deepEqual(
    [...selectFileRange(ids, new Set(["a"]), "d", "deleted", false, true)],
    ["d"],
  );
});

test("chat drafts restore attachment and retry identity, and tolerate old storage", () => {
  const draft = {
    body: "hello",
    blocks: [
      { type: "code.snippet", value: { language: "go", content: "main()" } },
    ],
    clientMsgId: "retry-1",
  };
  assert.deepEqual(readChatDraft(JSON.stringify(draft)), draft);
  assert.deepEqual(readChatDraft("old plain text draft"), {
    body: "old plain text draft",
    blocks: [],
  });
  assert.deepEqual(
    readChatDraft('{"body":42,"blocks":[null, {"type":"unknown","value":{}}]}')
      .blocks,
    [],
  );
  assert.deepEqual(readChatDraft(null), { body: "", blocks: [] });
});
