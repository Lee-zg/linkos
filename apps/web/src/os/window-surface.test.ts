import assert from "node:assert/strict";
import test from "node:test";
import { createInitialDesktopState, desktopReducer } from "./desktop-windowing";
import {
  selectWindowSurface,
  selectDesktopSurface,
  selectOwnerOccluders,
  visibleOwnerRegions,
} from "./window-surface-state";
import type { DesktopState, ManagedWindow } from "./types";

function opened(): DesktopState {
  return desktopReducer(createInitialDesktopState(), {
    type: "OPEN",
    appId: "chat",
    id: "a",
    title: "Chat",
    defaultSize: { w: 500, h: 400 },
    minSize: { w: 300, h: 200 },
    workarea: { x: 0, y: 24, w: 1000, h: 700 },
  });
}

test("surface visibility is canonical Space membership, not Fill or z", () => {
  const state = opened();
  const win = state.windows[0];
  assert.deepEqual(selectWindowSurface(state, win), {
    visible: true,
    interactive: true,
    active: true,
  });
  const filled = desktopReducer(state, {
    type: "SET_PLACEMENT",
    id: "a",
    placement: "fill",
  });
  assert.equal(selectWindowSurface(filled, filled.windows[0]).visible, true);
  const full = desktopReducer(filled, { type: "ENTER_FULLSCREEN", id: "a" });
  const desktop = desktopReducer(full, {
    type: "SWITCH_SPACE",
    spaceId: "desktop",
  });
  assert.deepEqual(selectWindowSurface(desktop, desktop.windows[0]), {
    visible: false,
    interactive: false,
    active: false,
  });
  assert.equal(selectDesktopSurface(full), false);
  assert.equal(selectDesktopSurface(desktop), true);
});

test("overview, minimize, closing, missing app and orphaned membership are immediately noninteractive", () => {
  const state = opened();
  const win = state.windows[0];
  const off = { visible: false, interactive: false, active: false };
  assert.deepEqual(selectWindowSurface(state, win, { closing: true }), off);
  assert.deepEqual(selectWindowSurface(state, win, { enabled: false }), off);
  assert.deepEqual(
    selectWindowSurface(state, { ...win, minimized: true }),
    off,
  );
  assert.deepEqual(
    selectWindowSurface(state, { ...win, spaceId: "missing" }),
    off,
  );
  const overview = desktopReducer(state, { type: "SHOW_OVERVIEW" });
  assert.deepEqual(selectWindowSurface(overview, win), off);
  assert.equal(selectDesktopSurface(overview), false);
  const removed = desktopReducer(state, { type: "CLOSE", id: "a" });
  assert.deepEqual(selectWindowSurface(removed, win), off);
});

test("mobile projects just the active surface without changing canonical placement", () => {
  const state = desktopReducer(opened(), {
    type: "OPEN",
    appId: "files",
    id: "b",
    title: "Files",
    defaultSize: { w: 500, h: 400 },
    minSize: { w: 300, h: 200 },
    workarea: { x: 0, y: 24, w: 1000, h: 700 },
  });
  assert.equal(selectWindowSurface(state, state.windows[0]).interactive, true);
  assert.equal(
    selectWindowSurface(state, state.windows[0], { mobile: true }).visible,
    false,
  );
  assert.equal(
    selectWindowSurface(state, state.windows[1], { mobile: true }).active,
    true,
  );
  assert.equal(state.windows[0].placement, "normal");
});

test("split membership is explicit and Desktop is inactive even for a corrupt occupant", () => {
  const state = opened();
  const win = state.windows[0];
  const split: DesktopState = {
    ...state,
    currentSpaceId: "split",
    spaces: [
      ...state.spaces,
      { id: "split", type: "split", windowIds: ["a", "b"], ratio: 0.5 },
    ],
    windows: [{ ...win, spaceId: "split" }],
  };
  assert.equal(selectDesktopSurface(split), false);
  assert.equal(selectWindowSurface(split, split.windows[0]).visible, true);
  const orphan: ManagedWindow = { ...win, id: "orphan", spaceId: "split" };
  assert.equal(
    selectWindowSurface(
      { ...split, windows: [...split.windows, orphan] },
      orphan,
    ).interactive,
    false,
  );
});

test("owner occluders are the visible windows stacked above it", () => {
  const state = desktopReducer(opened(), {
    type: "OPEN",
    appId: "files",
    id: "b",
    title: "Files",
    defaultSize: { w: 500, h: 400 },
    minSize: { w: 300, h: 200 },
    workarea: { x: 0, y: 24, w: 1000, h: 700 },
  });
  const [a, b] = state.windows;
  assert.ok(b.z > a.z);
  assert.deepEqual(
    selectOwnerOccluders(state, a).map((win) => win.id),
    ["b"],
  );
  assert.deepEqual(selectOwnerOccluders(state, b), []);
  const minimized = desktopReducer(state, { type: "MINIMIZE", id: "b" });
  assert.deepEqual(selectOwnerOccluders(minimized, minimized.windows[0]), []);
  // Mobile projects only the active surface, so nothing can occlude it.
  assert.deepEqual(selectOwnerOccluders(state, a, { mobile: true }), []);
});

test("visible owner regions subtract occluding windows into disjoint rects", () => {
  const bounds = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(visibleOwnerRegions(bounds, []), [bounds]);
  // An occluder outside the bounds changes nothing.
  assert.deepEqual(
    visibleOwnerRegions(bounds, [{ x: 600, y: 0, w: 100, h: 100 }]),
    [bounds],
  );
  assert.deepEqual(visibleOwnerRegions(bounds, [{ x: 0, y: 0, w: 1000, h: 1000 }]), []);
  const regions = visibleOwnerRegions(bounds, [
    { x: 300, y: 200, w: 400, h: 400 },
    { x: 250, y: 150, w: 100, h: 100 },
  ]);
  const area = (r: { w: number; h: number }) => r.w * r.h;
  const covered = 200 * 200 + (100 * 100 - 50 * 50);
  assert.equal(regions.reduce((sum, r) => sum + area(r), 0), area(bounds) - covered);
  for (const [i, r] of regions.entries()) {
    assert.ok(r.w > 0 && r.h > 0);
    assert.ok(r.x >= 100 && r.y >= 100 && r.x + r.w <= 500 && r.y + r.h <= 400);
    for (const other of regions.slice(i + 1))
      assert.ok(
        r.x + r.w <= other.x || other.x + other.w <= r.x || r.y + r.h <= other.y || other.y + other.h <= r.y,
      );
  }
});
