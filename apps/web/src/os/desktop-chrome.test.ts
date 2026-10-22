import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveMenuBarVisibility,
  resolveChromeControlsVisible,
} from "./DesktopChrome";

// --- RED: Chrome four hideMode rules ---

test("hideMode=always hides menu bar in both fullscreen and desktop", () => {
  assert.equal(resolveMenuBarVisibility("always", true, false), false);
  assert.equal(resolveMenuBarVisibility("always", false, true), false);
  assert.equal(resolveMenuBarVisibility("always", false, false), false);
  assert.equal(resolveMenuBarVisibility("always", true, true), false);
});

test("hideMode=desktop-only hides menu bar only on desktop, visible in fullscreen", () => {
  assert.equal(resolveMenuBarVisibility("desktop-only", false, true), false);
  assert.equal(resolveMenuBarVisibility("desktop-only", true, false), true);
  assert.equal(resolveMenuBarVisibility("desktop-only", false, false), true);
});

test("hideMode=fullscreen-only hides menu bar only in fullscreen, visible on desktop", () => {
  assert.equal(resolveMenuBarVisibility("fullscreen-only", true, false), false);
  assert.equal(resolveMenuBarVisibility("fullscreen-only", false, true), true);
  assert.equal(resolveMenuBarVisibility("fullscreen-only", false, false), true);
});

test("hideMode=never keeps menu bar always visible", () => {
  assert.equal(resolveMenuBarVisibility("never", true, false), true);
  assert.equal(resolveMenuBarVisibility("never", false, true), true);
  assert.equal(resolveMenuBarVisibility("never", false, false), true);
  assert.equal(resolveMenuBarVisibility("never", true, true), true);
});

// --- RED: Chrome hidden controls reachability ---

test("chrome controls are visible when chrome is hidden but focus is near top edge", () => {
  // When chrome is hidden, the top-corner "show controls" button must be
  // reachable. The pure function decides visibility based on focus proximity.
  assert.equal(resolveChromeControlsVisible(false, true), true);
  assert.equal(resolveChromeControlsVisible(false, false), false);
  assert.equal(resolveChromeControlsVisible(true, true), true);
  assert.equal(resolveChromeControlsVisible(true, false), true);
});
