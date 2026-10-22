import assert from "node:assert/strict";
import { test } from "node:test";
import * as desktopPreferencesModule from "./desktop-preferences";
import {
  DEFAULT_DESKTOP_PREFERENCES,
  createDesktopPreferencesStorageController,
  desktopPreferencesKey,
  parseDesktopPreferences,
  readDesktopPreferences,
  validateDesktopPreferences,
  writeDesktopPreferences,
  type DesktopPreferencesIdentity,
  type DesktopPreferencesV1,
  type StorageLike,
} from "./desktop-preferences";

function preferencesWithSize(size: number): DesktopPreferencesV1 {
  return {
    ...DEFAULT_DESKTOP_PREFERENCES,
    dock: { ...DEFAULT_DESKTOP_PREFERENCES.dock, size },
  };
}

class MemoryStorage implements StorageLike {
  readonly values: Map<string, string>;
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly removals: string[] = [];
  denyReads = false;
  denyWrites = false;

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.values = new Map(entries);
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    if (this.denyReads) throw new DOMException("denied", "SecurityError");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (this.denyWrites) throw new DOMException("full", "QuotaExceededError");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removals.push(key);
    this.values.delete(key);
  }
}

const identity = (
  gateway: string,
  workspaceId: string,
  userId: string,
): DesktopPreferencesIdentity => ({ gateway, workspaceId, userId });

test("兼容默认仅在全屏自动隐藏菜单栏", () => {
  assert.equal(DEFAULT_DESKTOP_PREFERENCES.menuBar.hideMode, "fullscreen-only");
  assert.equal(
    parseDesktopPreferences("{bad json").menuBar.hideMode,
    "fullscreen-only",
  );
});

test("invalid JSON, enums, non-finite numbers, ranges, and versions fall back to defaults", () => {
  const invalidValues: unknown[] = [
    { version: 1, dock: { position: "top" } },
    { version: 1, dock: { size: 23 } },
    { version: 1, dock: { size: 81 } },
    { version: 1, dock: { magnificationScale: 0.99 } },
    { version: 1, dock: { magnificationScale: 2.01 } },
    { version: 1, dock: { size: Number.NaN } },
    { version: 2 },
  ];
  assert.deepEqual(
    parseDesktopPreferences("{bad json"),
    DEFAULT_DESKTOP_PREFERENCES,
  );
  for (const value of invalidValues) {
    assert.equal(validateDesktopPreferences(value), null);
    assert.deepEqual(
      parseDesktopPreferences(JSON.stringify(value)),
      DEFAULT_DESKTOP_PREFERENCES,
    );
  }
});

test("valid partial version-one values merge defaults and ignore unknown fields", () => {
  const parsed = parseDesktopPreferences(
    JSON.stringify({
      version: 1,
      dock: { size: 64, unknownDockSetting: true },
      window: { doubleClick: "zoom" },
      unknownRootSetting: "ignored",
    }),
  );
  assert.equal(parsed.dock.size, 64);
  assert.equal(parsed.dock.position, DEFAULT_DESKTOP_PREFERENCES.dock.position);
  assert.equal(parsed.window.doubleClick, "zoom");
  assert.equal("unknownRootSetting" in parsed, false);
  assert.equal("unknownDockSetting" in parsed.dock, false);
});

test("preference keys isolate delimiter-containing gateway, workspace, and user identities", () => {
  const keys = [
    desktopPreferencesKey(identity("https://gate:a", "b", "c")),
    desktopPreferencesKey(identity("https://gate", "a:b", "c")),
    desktopPreferencesKey(identity("https://gate", "a", "b:c")),
    desktopPreferencesKey(identity("https://other", "a", "b:c")),
  ];
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith("linkos.desktop-preferences:")));
});

test("storage denial falls back to memory without throwing or touching unrelated keys", () => {
  const unrelatedKey = "linkos.dock:legacy";
  const key = "prefs:denied-fixture";
  const storage = new MemoryStorage([[unrelatedKey, "keep"]]);
  storage.denyReads = true;
  storage.denyWrites = true;
  const preferences = preferencesWithSize(72);

  assert.deepEqual(
    readDesktopPreferences(storage, key),
    DEFAULT_DESKTOP_PREFERENCES,
  );
  assert.doesNotThrow(() => writeDesktopPreferences(storage, key, preferences));
  assert.deepEqual(readDesktopPreferences(storage, key), preferences);

  assert.deepEqual(storage.reads, [key]);
  assert.deepEqual(storage.writes, [key]);
  assert.deepEqual(storage.removals, []);
  assert.equal(storage.values.get(unrelatedKey), "keep");
  assert.equal(storage.reads.includes(unrelatedKey), false);
  assert.equal(storage.writes.includes(unrelatedKey), false);
  assert.equal(storage.removals.includes(unrelatedKey), false);
});

test("a failed storage write keeps memory authoritative until a later write succeeds", () => {
  const key = "prefs:temporarily-denied-fixture";
  const values = new Map([[key, JSON.stringify(preferencesWithSize(40))]]);
  let denyWrites = true;
  const storage: StorageLike = {
    getItem: (storageKey) => values.get(storageKey) ?? null,
    setItem: (storageKey, value) => {
      if (denyWrites) throw new DOMException("full", "QuotaExceededError");
      values.set(storageKey, value);
    },
  };

  writeDesktopPreferences(storage, key, preferencesWithSize(72));
  assert.equal(readDesktopPreferences(storage, key).dock.size, 72);

  denyWrites = false;
  writeDesktopPreferences(storage, key, preferencesWithSize(64));
  values.set(key, JSON.stringify(preferencesWithSize(56)));
  assert.equal(readDesktopPreferences(storage, key).dock.size, 56);
});

test("preference writes report validation rather than storage availability", () => {
  const key = "prefs:return-value-fixture";
  const invalid = preferencesWithSize(Number.NaN);
  assert.equal(writeDesktopPreferences(null, key, invalid), false);
  assert.equal(
    writeDesktopPreferences(null, key, preferencesWithSize(72)),
    true,
  );

  const controller = createDesktopPreferencesStorageController(null);
  controller.hydrate(identity("gateway", "workspace-return", "user"));
  assert.equal(controller.write(controller.getCurrentKey()!, invalid), false);
});

test("preference updates reject NaN and normalize accepted values", () => {
  type ApplyPreferencesUpdate = (
    current: DesktopPreferencesV1,
    update:
      | DesktopPreferencesV1
      | ((preferences: DesktopPreferencesV1) => DesktopPreferencesV1),
  ) => DesktopPreferencesV1;
  const apply = (
    desktopPreferencesModule as typeof desktopPreferencesModule & {
      applyDesktopPreferencesUpdate?: ApplyPreferencesUpdate;
    }
  ).applyDesktopPreferencesUpdate;
  assert.equal(typeof apply, "function");
  if (!apply) return;

  const current = preferencesWithSize(48);
  assert.strictEqual(
    apply(current, () => preferencesWithSize(Number.NaN)),
    current,
  );
  const normalized = apply(
    current,
    () =>
      ({
        ...preferencesWithSize(64),
        unknownRootSetting: true,
      }) as DesktopPreferencesV1,
  );
  assert.equal(normalized.dock.size, 64);
  assert.equal("unknownRootSetting" in normalized, false);
});

test("storage controller hydrates a new identity before allowing writes to its key", () => {
  const storage = new MemoryStorage();
  const controller = createDesktopPreferencesStorageController(storage);
  const firstIdentity = identity("gateway", "workspace-a", "user");
  const secondIdentity = identity("gateway", "workspace-b", "user");
  const firstKey = desktopPreferencesKey(firstIdentity);
  const secondKey = desktopPreferencesKey(secondIdentity);
  storage.values.set(firstKey, JSON.stringify(preferencesWithSize(40)));
  storage.values.set(secondKey, JSON.stringify(preferencesWithSize(70)));

  assert.equal(controller.write(firstKey, preferencesWithSize(50)), false);
  const first = controller.hydrate(firstIdentity);
  assert.equal(first.preferences.dock.size, 40);
  assert.equal(controller.write(firstKey, preferencesWithSize(52)), true);
  assert.equal(controller.write(secondKey, preferencesWithSize(60)), false);
  assert.equal(storage.writes.includes(secondKey), false);

  const second = controller.hydrate(secondIdentity);
  assert.equal(second.preferences.dock.size, 70);
  assert.equal(controller.getCurrentKey(), secondKey);
  assert.equal(controller.write(firstKey, preferencesWithSize(44)), false);
  assert.equal(controller.write(secondKey, preferencesWithSize(68)), true);
});

test("storage events only accept valid values for the hydrated current key", () => {
  const storage = new MemoryStorage();
  const controller = createDesktopPreferencesStorageController(storage);
  const current = identity("gateway", "workspace", "user");
  const currentKey = desktopPreferencesKey(current);
  controller.hydrate(current);

  assert.equal(
    controller.acceptStorage(
      "another-key",
      JSON.stringify(preferencesWithSize(60)),
    ),
    null,
  );
  assert.equal(controller.acceptStorage(currentKey, "{bad"), null);
  assert.equal(
    controller.acceptStorage(
      currentKey,
      JSON.stringify({ version: 1, dock: { position: "top" } }),
    ),
    null,
  );
  assert.equal(
    controller.acceptStorage(
      currentKey,
      JSON.stringify(preferencesWithSize(60)),
    )?.dock.size,
    60,
  );
});

test("storage events wait for a successful local write after storage denial", () => {
  const current = identity("gateway", "workspace-interleaved", "user");
  const currentKey = desktopPreferencesKey(current);
  const storage = new MemoryStorage([
    [currentKey, JSON.stringify(preferencesWithSize(40))],
  ]);
  const controller = createDesktopPreferencesStorageController(storage);

  assert.equal(controller.hydrate(current).preferences.dock.size, 40);
  storage.denyWrites = true;
  assert.equal(controller.write(currentKey, preferencesWithSize(72)), true);
  assert.equal(
    controller.acceptStorage(
      currentKey,
      JSON.stringify(preferencesWithSize(40)),
    ),
    null,
  );
  assert.equal(readDesktopPreferences(storage, currentKey).dock.size, 72);

  storage.denyWrites = false;
  assert.equal(controller.write(currentKey, preferencesWithSize(64)), true);
  const externalRaw = JSON.stringify(preferencesWithSize(56));
  storage.values.set(currentKey, externalRaw);
  assert.equal(
    controller.acceptStorage(currentKey, externalRaw)?.dock.size,
    56,
  );
  assert.equal(readDesktopPreferences(storage, currentKey).dock.size, 56);
});
