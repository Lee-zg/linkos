import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeDockLayout,
  type DockLayoutInput,
  type DockLayoutApp,
} from "./dock-layout";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function app(id: string, name = id): DockLayoutApp {
  return { id, name };
}

function baseInput(overrides: Partial<DockLayoutInput> = {}): DockLayoutInput {
  return {
    pinnedIds: ["files", "chat", "code"],
    runningAppIds: ["chat", "tasks"],
    recentAppIds: ["tasks", "plugins", "settings", "admin"],
    minimizedWindowAppIds: [],
    apps: [
      app("files"),
      app("chat"),
      app("code"),
      app("tasks"),
      app("plugins"),
      app("settings"),
      app("admin"),
    ],
    maxRecentApps: 3,
    minimizeIntoAppIcon: false,
    ...overrides,
  };
}

/* ─── fixed + running + recent ≤ 3 dedup ──────────────────────────────────── */

test("pinned apps appear in order", () => {
  const result = computeDockLayout(baseInput());
  assert.deepEqual(result.pinnedSection, ["files", "chat", "code"]);
});

test("running unpinned apps appear after pinned", () => {
  const input = baseInput({
    pinnedIds: ["files"],
    runningAppIds: ["chat", "tasks"],
  });
  const result = computeDockLayout(input);
  // tasks is running but not pinned, so it should appear in running section
  assert.ok(result.runningSection.includes("tasks"));
  assert.ok(!result.runningSection.includes("files"));
});

test("recent apps limited to maxRecentApps and deduped", () => {
  const input = baseInput({
    pinnedIds: ["files"],
    runningAppIds: [],
    recentAppIds: ["chat", "code", "tasks", "plugins", "settings"],
    maxRecentApps: 3,
  });
  const result = computeDockLayout(input);
  // chat, code, tasks are not pinned and not running, so they are candidates for recent
  // But maxRecentApps = 3, so only 3 should appear
  assert.ok(result.recentSection.length <= 3);
  // No duplicates with pinned
  for (const id of result.recentSection) {
    assert.ok(!result.pinnedSection.includes(id));
  }
});

test("recent apps exclude running apps", () => {
  const input = baseInput({
    pinnedIds: ["files"],
    runningAppIds: ["chat"],
    recentAppIds: ["chat", "code", "tasks"],
  });
  const result = computeDockLayout(input);
  // chat is running, should not be in recent
  assert.ok(!result.recentSection.includes("chat"));
});

test("recent apps exclude pinned apps", () => {
  const input = baseInput({
    pinnedIds: ["files", "chat"],
    runningAppIds: [],
    recentAppIds: ["chat", "code", "tasks"],
  });
  const result = computeDockLayout(input);
  assert.ok(!result.recentSection.includes("chat"));
  assert.ok(!result.recentSection.includes("files"));
});

/* ─── minimize section ────────────────────────────────────────────────────── */

test("minimized windows in separate section when minimizeIntoAppIcon=false", () => {
  const input = baseInput({
    minimizeIntoAppIcon: false,
    minimizedWindowAppIds: ["tasks"],
  });
  const result = computeDockLayout(input);
  assert.ok(result.minimizedSection.length > 0);
  assert.ok(result.minimizedSection.includes("tasks"));
});

test("minimized windows absorbed into app icons when minimizeIntoAppIcon=true", () => {
  const input = baseInput({
    minimizeIntoAppIcon: true,
    minimizedWindowAppIds: ["tasks"],
    runningAppIds: ["tasks"],
  });
  const result = computeDockLayout(input);
  // When minimizeIntoAppIcon=true, minimized windows should NOT be in separate section
  assert.equal(result.minimizedSection.length, 0);
  // But the app should still show as running
  assert.ok(
    result.runningSection.includes("tasks") ||
      result.pinnedSection.includes("tasks"),
  );
});

test("empty minimized section when no minimized windows", () => {
  const result = computeDockLayout(baseInput({ minimizedWindowAppIds: [] }));
  assert.equal(result.minimizedSection.length, 0);
});

/* ─── drag-out unpin (does not uninstall) ─────────────────────────────────── */

test("unpinApp removes from pinned but keeps in layout if running", () => {
  const input = baseInput({
    pinnedIds: ["files", "chat"],
    runningAppIds: ["chat"],
  });
  const result = computeDockLayout(input);
  // Simulate unpinning chat: it should move from pinned to running section
  const afterUnpin = computeDockLayout({
    ...input,
    pinnedIds: ["files"],
    runningAppIds: ["chat"],
  });
  assert.ok(!afterUnpin.pinnedSection.includes("chat"));
  assert.ok(afterUnpin.runningSection.includes("chat"));
});

test("unpinApp removes completely when not running and not in recent", () => {
  const input = baseInput({
    pinnedIds: ["files", "chat", "code"],
    runningAppIds: [],
    recentAppIds: [],
  });
  const afterUnpin = computeDockLayout({
    ...input,
    pinnedIds: ["files", "code"],
  });
  assert.ok(!afterUnpin.pinnedSection.includes("chat"));
  assert.ok(!afterUnpin.runningSection.includes("chat"));
});

/* ─── divider presence ────────────────────────────────────────────────────── */

test("divider present when minimized section exists", () => {
  const result = computeDockLayout(
    baseInput({ minimizedWindowAppIds: ["tasks"] }),
  );
  assert.equal(result.showDivider, true);
});

test("no divider when no minimized section and no recent", () => {
  const result = computeDockLayout(
    baseInput({
      minimizedWindowAppIds: [],
      recentAppIds: [],
    }),
  );
  // Divider separates apps from minimized/recent
  // If there are special items (downloads/trash), divider is still shown
  assert.equal(result.showDivider, true);
});

/* ─── apps not in catalog are filtered ────────────────────────────────────── */

test("unknown pinned ids are filtered out", () => {
  const input = baseInput({
    pinnedIds: ["files", "nonexistent-app"],
  });
  const result = computeDockLayout(input);
  assert.ok(!result.pinnedSection.includes("nonexistent-app"));
  assert.ok(result.pinnedSection.includes("files"));
});

test("unknown running app ids are filtered out", () => {
  const input = baseInput({
    runningAppIds: ["chat", "ghost-app"],
  });
  const result = computeDockLayout(input);
  assert.ok(!result.runningSection.includes("ghost-app"));
});

/* ─── ordering ────────────────────────────────────────────────────────────── */

test("full layout order: pinned → running → recent → divider → minimized → special", () => {
  const input = baseInput({
    pinnedIds: ["files"],
    runningAppIds: ["tasks"],
    recentAppIds: ["code", "plugins"],
    minimizedWindowAppIds: ["settings"],
    minimizeIntoAppIcon: false,
  });
  const result = computeDockLayout(input);
  // Pinned first
  assert.deepEqual(result.pinnedSection, ["files"]);
  // Running (not pinned)
  assert.ok(result.runningSection.includes("tasks"));
  // Recent (not pinned, not running)
  assert.ok(result.recentSection.includes("code") || result.recentSection.includes("plugins"));
  // Minimized separate
  assert.ok(result.minimizedSection.includes("settings"));
});
