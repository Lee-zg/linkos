import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as geometry from "./desktop-geometry";
import * as surfaces from "./window-surface-state";
import * as gestures from "./window-geometry-gesture";
import type { ManagedWindow } from "./types";
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

// Run Window AND its gesture hook from source. The small hook/DOM host applies
// React's changed-style-only commit before executing real layout effects.
function windowFixture() {
  const slots: any[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const react = {
    useRef: (value: unknown) => {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useState: (value: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next: unknown) => { slots[index] = next; }];
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect() {},
    useLayoutEffect: (effect: () => void, deps: unknown[]) => {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) effects.push(effect);
      slots[index] = deps;
    },
  };
  const win: ManagedWindow = { ...start, id: "files-one", appId: "files", title: "Files", z: 1,
    minimized: false, placement: "normal", restoreRect: null, spaceId: "desktop" };
  const calls: string[] = [];
  const manager = {
    desktopState: { windows: [win], spaces: [{ id: "desktop", type: "desktop" }], currentSpaceId: "desktop", activeId: win.id },
    viewport: { x: 0, y: 0, w: 1200, h: 800 }, workarea, tileMargins: true,
    focus: (id: string) => calls.push(`focus:${id}`),
    setRect: (_id: string, rect: Rect) => { Object.assign(win, rect); calls.push("commit"); },
    setPlacement: (_id: string, placement: string) => calls.push(placement),
    close: () => calls.push("close"), minimize: () => calls.push("minimize"),
    toggleMaximize() {}, enterFullscreen: () => calls.push("fullscreen"), exitFullscreen() {}, exitSplit() {}, switchSpace() {},
  };
  const rafs = new Map<number, () => void>();
  let rafId = 0;
  const requestAnimationFrame = (callback: () => void) => { rafs.set(++rafId, callback); return rafId; };
  const cancelAnimationFrame = (id: number) => rafs.delete(id);
  const dependencies: Record<string, any> = {
    react,
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "lucide-react": {},
    "./app-registry": { useAppRegistry: () => ({ getApp: () => ({ minSize, defaultSize: start, component() {} }) }) },
    "./window-manager": { useWindowManager: () => manager },
    "./DesktopPreferencesProvider": { useDesktopPreferences: () => ({ preferences: { window: {} } }) },
    "./ContextMenu": { useContextMenu: () => ({ controller: { dismiss() {} } }) },
    "./ContextMenuScope": { ContextMenuScope: "scope" },
    "./WindowSurface": { WindowSurface: "surface", useSurfaceInteractivity() {} },
    "./window-surface-state": surfaces,
    "./desktop-geometry": geometry,
    "./desktop-windowing": {},
    "./window-geometry-gesture": gestures,
  };
  const load = (name: string) => {
    const filename = new URL(name, import.meta.url);
    const javascript = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename.pathname,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports: any = {};
    runInNewContext(javascript, { exports, require: (id: string) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    }, requestAnimationFrame, cancelAnimationFrame,
    window: { requestAnimationFrame, cancelAnimationFrame, setTimeout: (callback: () => void) => { callback(); return 1; } } });
    return exports;
  };
  dependencies["./useWindowGeometryGesture"] = load("./useWindowGeometryGesture.ts");
  const { Window } = load("./Window.tsx");
  const frame = { style: {} as Record<string, string>, setAttribute() {} };
  let previousStyle: Record<string, any> = {};
  let root: any, title: any, scope: any;
  const render = () => {
    cursor = 0;
    effects = [];
    root = Window({ win, order: 1 }).props.children;
    root.props.ref.current = frame;
    const style = root.props.style;
    for (const key of Object.keys(style)) {
      if (!Object.is(style[key], previousStyle[key])) frame.style[key] = `${style[key]}${key === "zIndex" ? "" : "px"}`;
    }
    previousStyle = { ...style };
    scope = root.props.children[0];
    title = scope.props.children({ current: null });
    effects.forEach(effect => effect());
  };
  const listeners = new Map<string, (event: any) => void>();
  const pointer = (control: string | null = null, button = 0) => {
    const event = { button, pointerId: 1, clientX: 220, clientY: 120, altKey: false,
      target: { closest: (selector: string) => control && selector.split(",").map(s => s.trim()).includes(control) ? {} : null },
      currentTarget: { setPointerCapture: () => calls.push("capture"), addEventListener: (type: string, fn: any) => listeners.set(type, fn) },
      preventDefault: () => calls.push("prevent"), stopPropagation: () => calls.push("stop") };
    title.props.onPointerDown(event);
    return event;
  };
  render();
  return { win, manager, frame, calls, render, pointer,
    title: () => title, scope: () => scope,
    send: (type: string) => listeners.get(type)?.({ pointerId: 1, clientX: 300, clientY: 180, altKey: false }),
    flush: () => { const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(callback => callback()); },
  };
}

function assertFrame(frame: ReturnType<typeof windowFixture>["frame"], rect: Rect) {
  assert.deepEqual([frame.style.left, frame.style.top, frame.style.width, frame.style.height],
    [rect.x, rect.y, rect.w, rect.h].map(value => `${value}px`));
}

test("Window initial layout effects preserve React-managed geometry", () => {
  const f = windowFixture();
  assertFrame(f.frame, start);
  f.render();
  assertFrame(f.frame, start);
});

for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
  test(`Window preview and ${ending} leave valid geometry`, () => {
    const f = windowFixture();
    f.pointer();
    f.render();
    f.send("pointermove"); f.flush(); f.render();
    const moved = { ...start, x: start.x + 80, y: start.y + 60 };
    assertFrame(f.frame, moved);
    f.send(ending); f.render();
    assertFrame(f.frame, ending === "pointerup" ? moved : start);
    assert.equal(f.calls.filter(call => call === "commit").length, ending === "pointerup" ? 1 : 0);
  });
}

for (const control of ["button", "input", "textarea", "select", "a[href]", "[role=button]", "[contenteditable]"]) {
  test(`Window title leaves ${control} descendants untouched`, () => {
    const f = windowFixture();
    f.pointer(control);
    assert.deepEqual(f.calls, [], "no preventDefault, propagation stop, focus or pointer capture");
  });
}

test("Window title focuses before starting only a manipulable primary drag", () => {
  const f = windowFixture();
  f.pointer(null, 2);
  assert.deepEqual(f.calls, []);
  f.win.placement = "fill"; f.render(); f.pointer();
  assert.deepEqual(f.calls, []);
  f.win.placement = "normal"; f.render(); f.pointer();
  assert.deepEqual(f.calls, [`focus:${f.win.id}`, "prevent", "stop", "capture"]);
});

test("Window controls remain clickable without initiating drag", () => {
  for (const [index, action] of [[0, "close"], [1, "minimize"], [2, "fullscreen"]] as const) {
    const f = windowFixture();
    f.pointer("button");
    f.title().props.children[0].props.children[index].props.onClick({ altKey: false });
    assert.deepEqual(f.calls, [action]);
  }
});

test("Window quadrants own placement callbacks while the parent still fills", () => {
  const f = windowFixture();
  const items = f.scope().props.getMenu({ target: { closest: () => null } });
  const arrange = items.find((item: any) => item.id === "fill-arrange");
  arrange.onClick();
  for (const cell of arrange.grid.cells) cell.onClick?.();
  assert.deepEqual(f.calls, ["fill", "top-left", "top-right", "bottom-left", "bottom-right"]);
});

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
