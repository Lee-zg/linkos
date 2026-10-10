import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pluginHasPermission,
  pluginEventMetadata,
  rpcByteLength,
  isBuiltinPlugin,
} from "./plugin-policy";
import { readDraft, writeDraft, removeDraft } from "./draft-storage";
import type { PluginRecord } from "@linkos/protocol";
test("plugin declarations use bounded namespaces and messages count UTF-8 bytes", () => {
  const plugin = { permissions: ["resource.read:code.*"] } as PluginRecord;
  assert.equal(pluginHasPermission(plugin, "resource.read:code.file"), true);
  assert.equal(
    pluginHasPermission(plugin, "resource.read:chat.message"),
    false,
  );
  assert.equal(isBuiltinPlugin("files.other"), false);
  assert.ok(rpcByteLength("中文".repeat(12000)) > 65536);
  assert.deepEqual(
    pluginEventMetadata({
      type: "resource.updated",
      seq: 3,
      eventId: "event",
      payload: { resourceId: "id", secret: "no" },
    }),
    { type: "resource.updated", seq: 3, eventId: "event", resourceId: "id" },
  );
});
test("draft survives denied storage and observes fresh storage from other tabs", () => {
  let raw: string | null = null,
    denied = false;
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => {
        if (denied) throw Error();
        return raw;
      },
      setItem: (_key: string, value: string) => {
        if (denied) throw Error();
        raw = value;
      },
      removeItem: () => {
        if (denied) throw Error();
        raw = null;
      },
    },
  });
  writeDraft("fixture", "one");
  raw = "external";
  assert.equal(readDraft("fixture"), "external");
  denied = true;
  writeDraft("fixture", "latest");
  assert.equal(readDraft("fixture"), "latest");
  removeDraft("fixture");
  assert.equal(readDraft("fixture"), null);
});
