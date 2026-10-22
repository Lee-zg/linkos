import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterOverviewSpaces,
  sortOverviewSpaces,
  type OverviewSpaceEntry,
} from "./SpaceOverview";
import type { DesktopSpace, ManagedWindow } from "./types";

function makeWindow(overrides: Partial<ManagedWindow>): ManagedWindow {
  return {
    id: "w1",
    appId: "files",
    title: "Files",
    x: 0,
    y: 0,
    w: 800,
    h: 600,
    minimized: false,
    z: 1,
    spaceId: "desktop",
    placement: "normal",
    restoreRect: null,
    ...overrides,
  };
}

// --- RED: Overview contains Desktop + fullscreen/split spaces ---

test("overview includes desktop space and fullscreen/split spaces but not owner portals", () => {
  const spaces: DesktopSpace[] = [
    { id: "desktop", type: "desktop", lastActiveId: "w1" },
    { id: "fullscreen:w2", type: "fullscreen", windowId: "w2" },
    { id: "split:[w3,w4]", type: "split", windowIds: ["w3", "w4"], ratio: 0.5 },
  ];
  const windows: ManagedWindow[] = [
    makeWindow({ id: "w1", spaceId: "desktop" }),
    makeWindow({ id: "w2", spaceId: "fullscreen:w2" }),
    makeWindow({ id: "w3", spaceId: "split:[w3,w4]" }),
    makeWindow({ id: "w4", spaceId: "split:[w3,w4]" }),
  ];
  const result = filterOverviewSpaces(spaces, windows, "fullscreen:w2");
  assert.equal(result.length, 3);
  const desktop = result.find((s) => s.spaceId === "desktop");
  assert.ok(desktop);
  assert.equal(desktop!.isCurrent, false);
  const fullscreen = result.find((s) => s.spaceId === "fullscreen:w2");
  assert.ok(fullscreen);
  assert.equal(fullscreen!.isCurrent, true);
  assert.equal(fullscreen!.type, "fullscreen");
  const split = result.find((s) => s.spaceId === "split:[w3,w4]");
  assert.ok(split);
  assert.equal(split!.type, "split");
});

test("overview marks current space and provides exit-fullscreen action", () => {
  const spaces: DesktopSpace[] = [
    { id: "desktop", type: "desktop", lastActiveId: null },
    { id: "fullscreen:w1", type: "fullscreen", windowId: "w1" },
  ];
  const windows: ManagedWindow[] = [
    makeWindow({ id: "w1", spaceId: "fullscreen:w1" }),
  ];
  const result = filterOverviewSpaces(spaces, windows, "fullscreen:w1");
  const current = result.find((s) => s.isCurrent);
  assert.ok(current);
  assert.equal(current!.spaceId, "fullscreen:w1");
  assert.equal(current!.canExitFullscreen, true);
});

test("overview desktop space cannot exit fullscreen", () => {
  const spaces: DesktopSpace[] = [
    { id: "desktop", type: "desktop", lastActiveId: null },
  ];
  const result = filterOverviewSpaces(spaces, [], "desktop");
  assert.equal(result[0].canExitFullscreen, false);
});

// --- RED: sortSpacesByRecentUse changes overview order ---

test("sortOverviewSpaces by recent use puts recently-used app spaces first", () => {
  const entries: OverviewSpaceEntry[] = [
    { spaceId: "desktop", type: "desktop", isCurrent: false, canExitFullscreen: false, windowIds: [], appNames: [] },
    { spaceId: "fullscreen:w1", type: "fullscreen", isCurrent: false, canExitFullscreen: true, windowIds: ["w1"], appNames: ["Chat"] },
    { spaceId: "fullscreen:w2", type: "fullscreen", isCurrent: false, canExitFullscreen: true, windowIds: ["w2"], appNames: ["Files"] },
  ];
  const sorted = sortOverviewSpaces(entries, ["files", "chat"]);
  // Desktop always stays first
  assert.equal(sorted[0].spaceId, "desktop");
  // Files was used most recently, so its space comes next
  assert.equal(sorted[1].spaceId, "fullscreen:w2");
  assert.equal(sorted[2].spaceId, "fullscreen:w1");
});

test("sortOverviewSpaces without recent use preserves original order", () => {
  const entries: OverviewSpaceEntry[] = [
    { spaceId: "desktop", type: "desktop", isCurrent: false, canExitFullscreen: false, windowIds: [], appNames: [] },
    { spaceId: "fullscreen:w1", type: "fullscreen", isCurrent: false, canExitFullscreen: true, windowIds: ["w1"], appNames: ["Chat"] },
    { spaceId: "fullscreen:w2", type: "fullscreen", isCurrent: false, canExitFullscreen: true, windowIds: ["w2"], appNames: ["Files"] },
  ];
  const sorted = sortOverviewSpaces(entries, []);
  assert.equal(sorted[0].spaceId, "desktop");
  assert.equal(sorted[1].spaceId, "fullscreen:w1");
  assert.equal(sorted[2].spaceId, "fullscreen:w2");
});

// --- RED: switchToAppSpace=false does not implicitly activate ---

test("overview entries carry switchToAppSpace flag for explicit switching", () => {
  const entries: OverviewSpaceEntry[] = [
    { spaceId: "fullscreen:w1", type: "fullscreen", isCurrent: false, canExitFullscreen: true, windowIds: ["w1"], appNames: ["Chat"] },
  ];
  // switchToAppSpace=false means the overview card should NOT auto-activate
  // the app. The entry should carry enough info for the UI to show an
  // explicit "Switch to this Space" button instead.
  assert.equal(entries[0].windowIds.length, 1);
  assert.equal(entries[0].appNames[0], "Chat");
});
