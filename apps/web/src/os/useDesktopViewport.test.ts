import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDesktopViewportObserver,
  readDesktopViewport,
  type DesktopViewportEventTarget,
  type DesktopViewportRuntime,
} from "./useDesktopViewport";
import { DEFAULT_DESKTOP_PREFERENCES } from "./desktop-preferences";
import { desktopWorkareaFromPreferences } from "./window-manager";

class FakeTarget implements DesktopViewportEventTarget {
  readonly listeners = new Map<string, Set<() => void>>();
  readonly added: string[] = [];
  readonly removed: string[] = [];

  addEventListener(type: string, listener: () => void) {
    this.added.push(type);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.removed.push(type);
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeRuntime extends FakeTarget implements DesktopViewportRuntime {
  innerWidth = 1200;
  innerHeight = 800;
  visualViewport?: FakeTarget & {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
  };
  private nextFrame = 1;
  readonly frames = new Map<number, () => void>();
  readonly cancelled: number[] = [];

  requestAnimationFrame(callback: () => void) {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: number) {
    this.cancelled.push(id);
    this.frames.delete(id);
  }

  flushFrame() {
    const frames = [...this.frames.values()];
    this.frames.clear();
    for (const frame of frames) frame();
  }
}

function visualViewport(
  values: Partial<{
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
  }> = {},
) {
  return Object.assign(new FakeTarget(), {
    width: 900,
    height: 600,
    offsetLeft: 12,
    offsetTop: 34,
    ...values,
  });
}

test("readDesktopViewport falls back when visualViewport is missing", () => {
  const runtime = new FakeRuntime();
  assert.deepEqual(readDesktopViewport(runtime), {
    x: 0,
    y: 0,
    w: 1200,
    h: 800,
  });
});

test("readDesktopViewport uses valid visual viewport dimensions and offsets", () => {
  const runtime = new FakeRuntime();
  runtime.visualViewport = visualViewport();
  assert.deepEqual(readDesktopViewport(runtime), {
    x: 12,
    y: 34,
    w: 900,
    h: 600,
  });
});

test("readDesktopViewport falls back for zero or non-finite visual values", () => {
  for (const values of [
    { width: 0 },
    { height: 0 },
    { width: Number.NaN },
    { offsetLeft: Number.POSITIVE_INFINITY },
  ]) {
    const runtime = new FakeRuntime();
    runtime.visualViewport = visualViewport(values);
    assert.deepEqual(readDesktopViewport(runtime), {
      x: 0,
      y: 0,
      w: 1200,
      h: 800,
    });
  }
});

test("viewport resize and visual resize/scroll coalesce into one RAF update", () => {
  const runtime = new FakeRuntime();
  runtime.visualViewport = visualViewport();
  const updates: unknown[] = [];
  const dispose = createDesktopViewportObserver(runtime, (viewport) => {
    updates.push(viewport);
  });

  runtime.emit("resize");
  runtime.visualViewport.emit("resize");
  runtime.visualViewport.emit("scroll");
  assert.equal(runtime.frames.size, 1);
  assert.equal(updates.length, 0);

  runtime.visualViewport.width = 700;
  runtime.visualViewport.offsetTop = 90;
  runtime.flushFrame();
  assert.deepEqual(updates, [{ x: 12, y: 90, w: 700, h: 600 }]);
  dispose();
});

test("observer cleanup removes every listener and cancels a queued RAF", () => {
  const runtime = new FakeRuntime();
  runtime.visualViewport = visualViewport();
  const dispose = createDesktopViewportObserver(runtime, () => undefined);

  runtime.visualViewport.emit("scroll");
  const queued = [...runtime.frames.keys()][0];
  dispose();

  assert.deepEqual(runtime.added, ["resize"]);
  assert.deepEqual(runtime.removed, ["resize"]);
  assert.deepEqual(runtime.visualViewport.added, ["resize", "scroll"]);
  assert.deepEqual(runtime.visualViewport.removed, ["resize", "scroll"]);
  assert.deepEqual(runtime.cancelled, [queued]);
  assert.equal(runtime.frames.size, 0);
});

test("desktop workarea reserves no top menu bar and deducts only the persistent dock", () => {
  const viewport = { x: 0, y: 0, w: 1200, h: 800 };
  assert.deepEqual(
    desktopWorkareaFromPreferences(viewport, DEFAULT_DESKTOP_PREFERENCES),
    { x: 0, y: 0, w: 1200, h: 752 },
  );
  assert.deepEqual(
    desktopWorkareaFromPreferences(viewport, {
      ...DEFAULT_DESKTOP_PREFERENCES,
      dock: {
        ...DEFAULT_DESKTOP_PREFERENCES.dock,
        autoHide: true,
        position: "left",
      },
    }),
    viewport,
  );
  assert.deepEqual(
    desktopWorkareaFromPreferences(viewport, {
      ...DEFAULT_DESKTOP_PREFERENCES,
      dock: {
        ...DEFAULT_DESKTOP_PREFERENCES.dock,
        position: "right",
        size: 60,
      },
    }),
    { x: 0, y: 0, w: 1140, h: 800 },
  );
});
