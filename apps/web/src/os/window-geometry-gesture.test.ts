import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeGestureRect,
  computeSplitLayout,
  canSplitWindows,
  type GestureEdge,
  type GestureInput,
  type GestureRect,
} from "./window-geometry-gesture";
import type { Rect } from "./types";

const workarea: Rect = { x: 0, y: 24, w: 1200, h: 760 };
const start: Rect = { x: 200, y: 100, w: 500, h: 400 };
const minSize = { w: 300, h: 200 };

// --- 8-direction resize pure function tests ---

test("computeGestureRect: north edge moves top edge only", () => {
  const input: GestureInput = {
    edge: "n",
    start,
    delta: { x: 0, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 150);
  assert.equal(result.h, 350);
  assert.equal(result.x, 200);
  assert.equal(result.w, 500);
});

test("computeGestureRect: south edge moves bottom edge only", () => {
  const input: GestureInput = {
    edge: "s",
    start,
    delta: { x: 0, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 100);
  assert.equal(result.h, 450);
  assert.equal(result.x, 200);
  assert.equal(result.w, 500);
});

test("computeGestureRect: east edge moves right edge only", () => {
  const input: GestureInput = {
    edge: "e",
    start,
    delta: { x: 50, y: 0 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.x, 200);
  assert.equal(result.w, 550);
  assert.equal(result.y, 100);
  assert.equal(result.h, 400);
});

test("computeGestureRect: west edge moves left edge only", () => {
  const input: GestureInput = {
    edge: "w",
    start,
    delta: { x: 50, y: 0 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.x, 250);
  assert.equal(result.w, 450);
  assert.equal(result.y, 100);
  assert.equal(result.h, 400);
});

test("computeGestureRect: ne corner moves top and right edges", () => {
  const input: GestureInput = {
    edge: "ne",
    start,
    delta: { x: 50, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 150);
  assert.equal(result.h, 350);
  assert.equal(result.x, 200);
  assert.equal(result.w, 550);
});

test("computeGestureRect: nw corner moves top and left edges", () => {
  const input: GestureInput = {
    edge: "nw",
    start,
    delta: { x: 50, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 150);
  assert.equal(result.h, 350);
  assert.equal(result.x, 250);
  assert.equal(result.w, 450);
});

test("computeGestureRect: se corner moves bottom and right edges", () => {
  const input: GestureInput = {
    edge: "se",
    start,
    delta: { x: 50, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 100);
  assert.equal(result.h, 450);
  assert.equal(result.x, 200);
  assert.equal(result.w, 550);
});

test("computeGestureRect: sw corner moves bottom and left edges", () => {
  const input: GestureInput = {
    edge: "sw",
    start,
    delta: { x: 50, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.y, 100);
  assert.equal(result.h, 450);
  assert.equal(result.x, 250);
  assert.equal(result.w, 450);
});

// --- minSize constraint tests ---

test("computeGestureRect: minSize prevents shrinking below minimum", () => {
  const input: GestureInput = {
    edge: "se",
    start,
    delta: { x: -500, y: -500 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.ok(result.w >= minSize.w, `width ${result.w} >= ${minSize.w}`);
  assert.ok(result.h >= minSize.h, `height ${result.h} >= ${minSize.h}`);
});

test("computeGestureRect: minSize does not translate window when at minimum", () => {
  const tightStart: Rect = { x: 200, y: 100, w: 300, h: 200 };
  const input: GestureInput = {
    edge: "se",
    start: tightStart,
    delta: { x: -100, y: -100 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.x, 200);
  assert.equal(result.y, 100);
  assert.equal(result.w, 300);
  assert.equal(result.h, 200);
});

// --- bounds constraint tests ---

test("computeGestureRect: bounds prevent exceeding workarea", () => {
  const input: GestureInput = {
    edge: "se",
    start,
    delta: { x: 1000, y: 1000 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.ok(result.x + result.w <= workarea.x + workarea.w);
  assert.ok(result.y + result.h <= workarea.y + workarea.h);
});

test("computeGestureRect: bounds prevent negative coordinates", () => {
  const input: GestureInput = {
    edge: "nw",
    start,
    delta: { x: -1000, y: -1000 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.ok(result.x >= workarea.x);
  assert.ok(result.y >= workarea.y);
});

test("computeGestureRect: no negative sizes when delta exceeds start", () => {
  const input: GestureInput = {
    edge: "nw",
    start: { x: 100, y: 100, w: 50, h: 50 },
    delta: { x: -200, y: -200 },
    minSize: { w: 30, h: 30 },
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.ok(result.w >= 0, `width ${result.w} >= 0`);
  assert.ok(result.h >= 0, `height ${result.h} >= 0`);
});

// --- centered mode tests ---

test("computeGestureRect: centered mode keeps center stable", () => {
  const centerStart: Rect = { x: 300, y: 200, w: 200, h: 150 };
  const centerX = centerStart.x + centerStart.w / 2;
  const centerY = centerStart.y + centerStart.h / 2;
  const input: GestureInput = {
    edge: "se",
    start: centerStart,
    delta: { x: 50, y: 50 },
    minSize: { w: 100, h: 100 },
    bounds: workarea,
    centered: true,
  };
  const result = computeGestureRect(input);
  const resultCenterX = result.x + result.w / 2;
  const resultCenterY = result.y + result.h / 2;
  assert.equal(resultCenterX, centerX);
  assert.equal(resultCenterY, centerY);
});

test("computeGestureRect: centered mode respects minSize", () => {
  const centerStart: Rect = { x: 350, y: 250, w: 100, h: 100 };
  const input: GestureInput = {
    edge: "nw",
    start: centerStart,
    delta: { x: -200, y: -200 },
    minSize,
    bounds: workarea,
    centered: true,
  };
  const result = computeGestureRect(input);
  assert.ok(result.w >= minSize.w);
  assert.ok(result.h >= minSize.h);
});

// --- drag (move) tests ---

test("computeGestureRect: drag moves window without resizing", () => {
  const input: GestureInput = {
    edge: null,
    start,
    delta: { x: 100, y: 50 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.equal(result.x, 300);
  assert.equal(result.y, 150);
  assert.equal(result.w, 500);
  assert.equal(result.h, 400);
});

test("computeGestureRect: drag clamps to bounds", () => {
  const input: GestureInput = {
    edge: null,
    start,
    delta: { x: 2000, y: 2000 },
    minSize,
    bounds: workarea,
    centered: false,
  };
  const result = computeGestureRect(input);
  assert.ok(result.x >= workarea.x);
  assert.ok(result.y >= workarea.y);
  assert.ok(result.x + result.w <= workarea.x + workarea.w);
  assert.ok(result.y + result.h <= workarea.y + workarea.h);
});

// --- split view pure function tests ---

test("computeSplitLayout: 50/50 ratio splits workarea in half", () => {
  const layout = computeSplitLayout(workarea, 0.5, minSize);
  assert.equal(layout.left.x, workarea.x);
  assert.equal(layout.left.y, workarea.y);
  assert.equal(layout.left.w, workarea.w / 2);
  assert.equal(layout.left.h, workarea.h);
  assert.equal(layout.right.x, workarea.x + workarea.w / 2);
  assert.equal(layout.right.y, workarea.y);
  assert.equal(layout.right.w, workarea.w / 2);
  assert.equal(layout.right.h, workarea.h);
});

test("computeSplitLayout: custom ratio respects proportion", () => {
  const layout = computeSplitLayout(workarea, 0.3, minSize);
  assert.equal(layout.left.w, Math.round(workarea.w * 0.3));
  assert.equal(layout.right.w, workarea.w - layout.left.w);
});

test("computeSplitLayout: ratio clamped to minSize on both sides", () => {
  const layout = computeSplitLayout(workarea, 0.1, minSize);
  assert.ok(layout.left.w >= minSize.w);
  assert.ok(layout.right.w >= minSize.w);
});

test("canSplitWindows: returns true when workarea fits both minSizes", () => {
  const result = canSplitWindows(workarea, minSize);
  assert.equal(result, true);
});

test("canSplitWindows: returns false when workarea too narrow", () => {
  const narrow: Rect = { x: 0, y: 0, w: 400, h: 600 };
  const result = canSplitWindows(narrow, minSize);
  assert.equal(result, false);
});

test("canSplitWindows: returns false when workarea too short", () => {
  const short: Rect = { x: 0, y: 0, w: 1200, h: 150 };
  const result = canSplitWindows(short, minSize);
  assert.equal(result, false);
});
