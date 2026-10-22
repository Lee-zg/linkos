import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialDesktopState,
  desktopReducer,
  deriveWindowState,
  fullscreenSpaceId,
  splitSpaceId,
  updateRecentApps,
  resolveDoubleClickAction,
  type DesktopAction,
} from "./desktop-windowing";
import type { DesktopState, DynamicAppId, Rect } from "./types";

const workarea: Rect = { x: 0, y: 24, w: 1200, h: 760 };

function openAction(
  appId: DynamicAppId,
  id: string,
  pinnedAppIds: readonly DynamicAppId[] = [],
): DesktopAction {
  return {
    type: "OPEN",
    appId,
    id,
    title: appId,
    defaultSize: { w: 800, h: 560 },
    minSize: { w: 320, h: 240 },
    workarea,
    pinnedAppIds,
  };
}

function reduce(...actions: DesktopAction[]): DesktopState {
  return actions.reduce(desktopReducer, createInitialDesktopState());
}

test("OPEN creates a centered desktop window and reuses an existing app window", () => {
  const opened = reduce(openAction("files", "files-1"));
  assert.equal(opened.windows.length, 1);
  assert.deepEqual(opened.windows[0], {
    id: "files-1",
    appId: "files",
    title: "files",
    x: 200,
    y: 124,
    w: 800,
    h: 560,
    minimized: false,
    z: 1,
    spaceId: "desktop",
    placement: "normal",
    restoreRect: null,
  });
  const reused = desktopReducer(
    opened,
    openAction("files", "must-not-be-used"),
  );
  assert.equal(reused.windows.length, 1);
  assert.equal(reused.windows[0].id, "files-1");
  assert.deepEqual(reused.runningApps, ["files"]);
  assert.deepEqual(reused.recentApps, ["files"]);
});

test("OPEN keeps an oversized app minimum and reachable title bar in a small workarea", () => {
  const opened = reduce({
    ...openAction("files", "files-small"),
    defaultSize: { w: 800, h: 560 },
    minSize: { w: 520, h: 420 },
    workarea: { x: 0, y: 24, w: 300, h: 128 },
  });
  const window = opened.windows[0];

  assert.deepEqual(
    { x: window.x, y: window.y, w: window.w, h: window.h },
    { x: -110, y: 24, w: 520, h: 420 },
  );
  assert.ok(window.w >= 520);
  assert.ok(window.h >= 420);
  assert.ok(Math.min(window.x + window.w, 300) - Math.max(window.x, 0) >= 120);
});

test("normal and fill layouts survive fullscreen entry and exit", () => {
  for (const placement of ["normal", "fill"] as const) {
    let state = reduce(openAction("files", "a"));
    if (placement === "fill") {
      state = desktopReducer(state, { type: "TOGGLE_MAXIMIZE", id: "a" });
    }
    const before = state.windows[0];
    state = desktopReducer(state, { type: "ENTER_FULLSCREEN", id: "a" });
    assert.equal(state.currentSpaceId, fullscreenSpaceId("a"));
    assert.deepEqual(
      {
        x: state.windows[0].x,
        y: state.windows[0].y,
        w: state.windows[0].w,
        h: state.windows[0].h,
        placement: state.windows[0].placement,
        restoreRect: state.windows[0].restoreRect,
      },
      {
        x: before.x,
        y: before.y,
        w: before.w,
        h: before.h,
        placement: before.placement,
        restoreRect: before.restoreRect,
      },
    );
    state = desktopReducer(state, { type: "EXIT_FULLSCREEN", id: "a" });
    assert.equal(state.currentSpaceId, "desktop");
    assert.equal(state.windows[0].spaceId, "desktop");
    assert.equal(state.windows[0].placement, placement);
    assert.deepEqual(
      deriveWindowState(state)[0].maximized,
      placement === "fill",
    );
  }
});

test("two apps retain independent fullscreen spaces while switching", () => {
  let state = reduce(
    openAction("files", "a"),
    { type: "ENTER_FULLSCREEN", id: "a" },
    openAction("chat", "b"),
    { type: "ENTER_FULLSCREEN", id: "b" },
  );
  assert.ok(state.spaces.some((space) => space.id === fullscreenSpaceId("a")));
  assert.ok(state.spaces.some((space) => space.id === fullscreenSpaceId("b")));
  state = desktopReducer(state, {
    type: "SWITCH_SPACE",
    spaceId: fullscreenSpaceId("a"),
  });
  assert.equal(state.activeId, "a");
  state = desktopReducer(state, { type: "EXIT_FULLSCREEN", id: "a" });
  assert.ok(state.windows.some((window) => window.id === "b"));
  assert.ok(state.spaces.some((space) => space.id === fullscreenSpaceId("b")));
});

test("exiting fullscreen raises the restored window above newer desktop windows", () => {
  let state = reduce(
    openAction("files", "a"),
    { type: "ENTER_FULLSCREEN", id: "a" },
    openAction("code", "c"),
    { type: "FOCUS", id: "c" },
    { type: "SWITCH_SPACE", spaceId: fullscreenSpaceId("a") },
  );

  state = desktopReducer(state, { type: "EXIT_FULLSCREEN", id: "a" });

  const target = state.windows.find((window) => window.id === "a");
  const desktopZ = state.windows
    .filter((window) => window.spaceId === "desktop")
    .map((window) => window.z);
  assert.equal(state.activeId, "a");
  assert.equal(target?.z, Math.max(...desktopZ));
});

test("FOCUS restores a minimized window and switches to its space", () => {
  let state = reduce(openAction("files", "a"));
  state = desktopReducer(state, { type: "MINIMIZE", id: "a" });
  assert.equal(state.windows[0].minimized, true);
  state = desktopReducer(state, { type: "FOCUS", id: "a" });
  assert.equal(state.windows[0].minimized, false);
  assert.equal(state.currentSpaceId, "desktop");
  assert.equal(state.activeId, "a");
});

test("layout actions do not activate hidden or restore minimized desktop windows", () => {
  const actions: DesktopAction[] = [
    { type: "TOGGLE_MAXIMIZE", id: "a" },
    { type: "SET_PLACEMENT", id: "a", placement: "left" },
  ];

  for (const action of actions) {
    const fullscreen = reduce(
      openAction("files", "a"),
      openAction("chat", "b"),
      { type: "ENTER_FULLSCREEN", id: "b" },
    );
    const laidOut = desktopReducer(fullscreen, action);
    assert.equal(laidOut.currentSpaceId, fullscreenSpaceId("b"));
    assert.equal(laidOut.activeId, "b");

    const minimized = reduce(
      openAction("files", "a"),
      { type: "MINIMIZE", id: "a" },
      openAction("chat", "b"),
      { type: "ENTER_FULLSCREEN", id: "b" },
    );
    const minimizedAfterLayout = desktopReducer(minimized, action);
    assert.equal(
      minimizedAfterLayout.windows.find((window) => window.id === "a")
        ?.minimized,
      true,
    );
    assert.equal(minimizedAfterLayout.activeId, "b");
  }
});

test("TOGGLE_MAXIMIZE preserves desktop z-order while another space is visible", () => {
  let state = reduce(
    openAction("files", "a"),
    openAction("code", "c"),
    openAction("chat", "b"),
    { type: "ENTER_FULLSCREEN", id: "b" },
  );
  const beforeZ = state.windows.find((window) => window.id === "a")?.z;

  state = desktopReducer(state, { type: "TOGGLE_MAXIMIZE", id: "a" });
  assert.equal(state.windows.find((window) => window.id === "a")?.z, beforeZ);
  assert.equal(state.currentSpaceId, fullscreenSpaceId("b"));
  assert.equal(state.activeId, "b");

  state = desktopReducer(state, {
    type: "SWITCH_SPACE",
    spaceId: "desktop",
  });
  assert.equal(state.activeId, "c");
});

test("minimize ignores fullscreen and split spaces while minimize-all only changes desktop", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"));
  state = desktopReducer(state, {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.5,
  });
  const splitState = desktopReducer(state, { type: "MINIMIZE", id: "a" });
  assert.strictEqual(splitState, state);
  state = desktopReducer(state, { type: "EXIT_SPLIT" });
  state = desktopReducer(state, { type: "ENTER_FULLSCREEN", id: "a" });
  assert.strictEqual(
    desktopReducer(state, { type: "MINIMIZE", id: "a" }),
    state,
  );
  state = desktopReducer(state, openAction("code", "c"));
  state = desktopReducer(state, { type: "MINIMIZE_ALL" });
  assert.equal(
    state.windows.find((window) => window.id === "a")?.minimized,
    false,
  );
  assert.equal(
    state.windows.find((window) => window.id === "c")?.minimized,
    true,
  );
});

test("split keeps its first window active after switching away and back", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"), {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.5,
  });
  const splitId = splitSpaceId(["a", "b"]);
  assert.equal(state.activeId, "a");
  state = desktopReducer(state, { type: "SWITCH_SPACE", spaceId: "desktop" });
  state = desktopReducer(state, { type: "SWITCH_SPACE", spaceId: splitId });
  assert.equal(state.activeId, "a");
});

test("ENTER_SPLIT copies its window tuple before storing state", () => {
  const windowIds: [string, string] = ["a", "b"];
  let state = reduce(openAction("files", "a"), openAction("chat", "b"));
  state = desktopReducer(state, {
    type: "ENTER_SPLIT",
    windowIds,
    ratio: 0.5,
  });
  const enteredSpaceId = state.currentSpaceId;

  windowIds[0] = "changed-first";
  windowIds[1] = "changed-second";

  const split = state.spaces.find((space) => space.id === enteredSpaceId);
  assert.ok(split && split.type === "split");
  assert.deepEqual(split.windowIds, ["a", "b"]);
  assert.equal(enteredSpaceId, splitSpaceId(["a", "b"]));

  state = desktopReducer(state, { type: "EXIT_SPLIT" });
  assert.deepEqual(
    state.windows.map((window) => [window.id, window.spaceId]),
    [
      ["a", "desktop"],
      ["b", "desktop"],
    ],
  );
  assert.equal(state.activeId, "a");
});

test("exiting split makes its first window the top active desktop window", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"), {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.5,
  });
  state = desktopReducer(state, { type: "EXIT_SPLIT" });
  const desktop = state.spaces.find((space) => space.type === "desktop");
  const topWindow = [...state.windows].sort(
    (left, right) => right.z - left.z,
  )[0];
  assert.equal(state.activeId, "a");
  assert.equal(topWindow.id, "a");
  assert.equal(desktop?.lastActiveId, "a");
});

test("legacy move and resize actions update only their rectangle fields", () => {
  let state = reduce(openAction("files", "a"));
  state = desktopReducer(state, { type: "MOVE", id: "a", x: 11, y: 22 });
  assert.deepEqual(
    { x: state.windows[0].x, y: state.windows[0].y },
    { x: 11, y: 22 },
  );
  state = desktopReducer(state, { type: "RESIZE", id: "a", w: 640, h: 480 });
  assert.deepEqual(
    { w: state.windows[0].w, h: state.windows[0].h },
    { w: 640, h: 480 },
  );
});

test("unknown ids and spaces are strict no-ops", () => {
  const state = reduce(openAction("files", "a"));
  const actions: DesktopAction[] = [
    { type: "CLOSE", id: "missing" },
    { type: "FOCUS", id: "missing" },
    { type: "MINIMIZE", id: "missing" },
    { type: "TOGGLE_MAXIMIZE", id: "missing" },
    { type: "SET_RECT", id: "missing", rect: workarea },
    { type: "SET_PLACEMENT", id: "missing", placement: "left" },
    { type: "ENTER_FULLSCREEN", id: "missing" },
    { type: "EXIT_FULLSCREEN", id: "missing" },
    { type: "SWITCH_SPACE", spaceId: "missing" },
    { type: "ENTER_SPLIT", windowIds: ["a", "missing"], ratio: 0.5 },
    { type: "EXIT_SPLIT", spaceId: "missing" },
  ];
  for (const action of actions)
    assert.strictEqual(desktopReducer(state, action), state);
});

test("close destroys a window space but keeps the app running; quit removes all app state", () => {
  let state = reduce(openAction("files", "a"), {
    type: "ENTER_FULLSCREEN",
    id: "a",
  });
  state = desktopReducer(state, { type: "CLOSE", id: "a" });
  assert.equal(state.windows.length, 0);
  assert.deepEqual(state.runningApps, ["files"]);
  assert.deepEqual(state.recentApps, ["files"]);
  assert.deepEqual(
    state.spaces.map((space) => space.id),
    ["desktop"],
  );
  state = desktopReducer(state, openAction("files", "a2"));
  state = desktopReducer(state, { type: "QUIT_APP", appId: "files" });
  assert.equal(state.windows.length, 0);
  assert.deepEqual(state.runningApps, []);
  assert.deepEqual(state.recentApps, []);
});

test("reconcile removes unavailable app state and downgrades a split survivor to fullscreen", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"));
  state = desktopReducer(state, {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.4,
  });
  const oldSplitId = splitSpaceId(["a", "b"]);
  assert.equal(state.currentSpaceId, oldSplitId);
  state = desktopReducer(state, { type: "RECONCILE", available: ["files"] });
  assert.deepEqual(state.runningApps, ["files"]);
  assert.deepEqual(state.recentApps, ["files"]);
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].spaceId, fullscreenSpaceId("a"));
  assert.equal(state.currentSpaceId, fullscreenSpaceId("a"));
  assert.ok(!state.spaces.some((space) => space.id === oldSplitId));
  assert.ok(state.spaces.some((space) => space.id === fullscreenSpaceId("a")));
});

test("reconcile returns to desktop when the current dedicated space disappears", () => {
  let state = reduce(
    openAction("files", "a"),
    { type: "ENTER_FULLSCREEN", id: "a" },
    openAction("chat", "b"),
    { type: "ENTER_FULLSCREEN", id: "b" },
  );
  state = desktopReducer(state, { type: "RECONCILE", available: ["files"] });
  assert.equal(state.currentSpaceId, "desktop");
  assert.equal(state.activeId, null);
  assert.ok(state.spaces.some((space) => space.id === fullscreenSpaceId("a")));
});

test("reconcile removes pre-existing orphan spaces even when app availability is unchanged", () => {
  const opened = reduce(openAction("files", "a"));
  const state: DesktopState = {
    ...opened,
    spaces: [
      ...opened.spaces,
      { id: "fullscreen:missing", type: "fullscreen", windowId: "missing" },
    ],
    currentSpaceId: "fullscreen:missing",
    activeId: null,
  };
  const reconciled = desktopReducer(state, {
    type: "RECONCILE",
    available: ["files"],
  });
  assert.deepEqual(
    reconciled.spaces.map((space) => space.id),
    ["desktop"],
  );
  assert.equal(reconciled.currentSpaceId, "desktop");
});

test("overview dismissal restores the saved valid scene", () => {
  let state = reduce(openAction("files", "a"));
  state = desktopReducer(state, { type: "SHOW_OVERVIEW" });
  assert.deepEqual(state.overviewReturn, { spaceId: "desktop", activeId: "a" });
  assert.equal(state.activeId, null);
  state = desktopReducer(state, { type: "DISMISS_OVERVIEW" });
  assert.equal(state.overviewReturn, null);
  assert.equal(state.currentSpaceId, "desktop");
  assert.equal(state.activeId, "a");
});

test("recent apps are unpinned, deduplicated, and capped at three", () => {
  let recent: DynamicAppId[] = [];
  recent = updateRecentApps(recent, "files", ["files"]);
  recent = updateRecentApps(recent, "chat");
  recent = updateRecentApps(recent, "code");
  recent = updateRecentApps(recent, "tasks");
  recent = updateRecentApps(recent, "chat");
  assert.deepEqual(recent, ["chat", "tasks", "code"]);
});

// --- Phase 5: Title bar double-click dispatch ---

test("resolveDoubleClickAction maps preference to action for normal desktop windows", () => {
  assert.equal(resolveDoubleClickAction("fill", "desktop", false), "toggle-maximize");
  assert.equal(resolveDoubleClickAction("zoom", "desktop", false), "host-zoom");
  assert.equal(resolveDoubleClickAction("minimize", "desktop", false), "minimize");
  assert.equal(resolveDoubleClickAction("none", "desktop", false), "none");
});

test("resolveDoubleClickAction returns none for fullscreen/split spaces regardless of preference", () => {
  assert.equal(resolveDoubleClickAction("fill", "fullscreen", false), "none");
  assert.equal(resolveDoubleClickAction("zoom", "split", false), "none");
  assert.equal(resolveDoubleClickAction("minimize", "fullscreen", false), "none");
  assert.equal(resolveDoubleClickAction("none", "split", false), "none");
});

test("resolveDoubleClickAction returns none for mobile regardless of preference", () => {
  assert.equal(resolveDoubleClickAction("fill", "desktop", true), "none");
  assert.equal(resolveDoubleClickAction("zoom", "desktop", true), "none");
});

// --- Phase 7: Split View swap and replace ---

test("SWAP_SPLIT exchanges the two windows in a split space", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"), {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.4,
  });
  const splitId = splitSpaceId(["a", "b"]);
  const before = state.spaces.find((s) => s.id === splitId);
  assert.ok(before && before.type === "split");
  assert.deepEqual(before.windowIds, ["a", "b"]);
  assert.equal(before.ratio, 0.4);

  state = desktopReducer(state, { type: "SWAP_SPLIT", spaceId: splitId });
  const after = state.spaces.find((s) => s.id === splitId);
  assert.ok(after && after.type === "split");
  assert.deepEqual(after.windowIds, ["b", "a"]);
  assert.equal(after.ratio, 0.6);
});

test("SWAP_SPLIT is no-op for unknown space", () => {
  const state = reduce(openAction("files", "a"));
  const result = desktopReducer(state, {
    type: "SWAP_SPLIT",
    spaceId: "unknown",
  });
  assert.strictEqual(result, state);
});

test("REPLACE_SPLIT_WINDOW swaps one window with another from desktop", () => {
  let state = reduce(
    openAction("files", "a"),
    openAction("chat", "b"),
    openAction("code", "c"),
    { type: "ENTER_SPLIT", windowIds: ["a", "b"], ratio: 0.5 },
  );
  const splitId = splitSpaceId(["a", "b"]);

  state = desktopReducer(state, {
    type: "REPLACE_SPLIT_WINDOW",
    spaceId: splitId,
    windowId: "b",
    replacementId: "c",
  });

  const split = state.spaces.find((s) => s.id === splitId);
  assert.ok(split && split.type === "split");
  assert.deepEqual(split.windowIds, ["a", "c"]);

  const bWindow = state.windows.find((w) => w.id === "b");
  assert.equal(bWindow?.spaceId, "desktop");

  const cWindow = state.windows.find((w) => w.id === "c");
  assert.equal(cWindow?.spaceId, splitId);
});

test("REPLACE_SPLIT_WINDOW is no-op when replacement is same as target", () => {
  let state = reduce(openAction("files", "a"), openAction("chat", "b"), {
    type: "ENTER_SPLIT",
    windowIds: ["a", "b"],
    ratio: 0.5,
  });
  const splitId = splitSpaceId(["a", "b"]);
  const result = desktopReducer(state, {
    type: "REPLACE_SPLIT_WINDOW",
    spaceId: splitId,
    windowId: "a",
    replacementId: "a",
  });
  assert.strictEqual(result, state);
});
