import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeDesktopWorkarea,
  getWindowDisplayRect,
  projectDesktopRect,
  resizeFromEdge,
  type ResizeEdge,
} from "./desktop-geometry";
import type { DesktopSpace, ManagedWindow, Rect } from "./types";

const bounds: Rect = { x: 0, y: 0, w: 700, h: 600 };
const start: Rect = { x: 200, y: 80, w: 500, h: 480 };
const minSize = { w: 420, h: 360 };

test("west resize clamps at min width without moving the right edge", () => {
  assert.deepEqual(
    resizeFromEdge(start, "w", { x: 200, y: 0 }, minSize, bounds),
    { x: 280, y: 80, w: 420, h: 480 },
  );
});

test("north-west resize clamps both axes while preserving opposite corner", () => {
  assert.deepEqual(
    resizeFromEdge(start, "nw", { x: 200, y: 200 }, minSize, bounds),
    { x: 280, y: 200, w: 420, h: 360 },
  );
});

test("all resize edges move only their requested edges", () => {
  const base: Rect = { x: 100, y: 80, w: 400, h: 300 };
  const minimum = { w: 100, h: 100 };
  const roomy: Rect = { x: 0, y: 0, w: 1000, h: 800 };
  const expected: Record<ResizeEdge, Rect> = {
    n: { x: 100, y: 110, w: 400, h: 270 },
    e: { x: 100, y: 80, w: 420, h: 300 },
    s: { x: 100, y: 80, w: 400, h: 330 },
    w: { x: 120, y: 80, w: 380, h: 300 },
    ne: { x: 100, y: 110, w: 420, h: 270 },
    nw: { x: 120, y: 110, w: 380, h: 270 },
    se: { x: 100, y: 80, w: 420, h: 330 },
    sw: { x: 120, y: 80, w: 380, h: 330 },
  };
  for (const edge of Object.keys(expected) as ResizeEdge[]) {
    assert.deepEqual(
      resizeFromEdge(base, edge, { x: 20, y: 30 }, minimum, roomy),
      expected[edge],
      edge,
    );
  }
});

test("resize clamps moving edges to bounds and never creates negative sizes", () => {
  assert.deepEqual(
    resizeFromEdge(start, "se", { x: 500, y: 500 }, minSize, bounds),
    { x: 200, y: 80, w: 500, h: 520 },
  );
  assert.deepEqual(
    resizeFromEdge(start, "nw", { x: -500, y: -500 }, minSize, bounds),
    { x: 0, y: 0, w: 700, h: 560 },
  );
});

test("centered resize keeps the initial center stable and respects bounds and minimums", () => {
  const centeredStart = { x: 200, y: 150, w: 300, h: 200 };
  const centeredBounds = { x: 100, y: 50, w: 500, h: 400 };
  assert.deepEqual(
    resizeFromEdge(
      centeredStart,
      "e",
      { x: 500, y: 0 },
      { w: 120, h: 100 },
      centeredBounds,
      true,
    ),
    { x: 100, y: 150, w: 500, h: 200 },
  );
  assert.deepEqual(
    resizeFromEdge(
      centeredStart,
      "nw",
      { x: 500, y: 500 },
      { w: 120, h: 100 },
      centeredBounds,
      true,
    ),
    { x: 290, y: 200, w: 120, h: 100 },
  );
});

test("resize uses the original opposite edge when start is below the minimum", () => {
  const undersized = { x: 200, y: 100, w: 50, h: 40 };
  const minimum = { w: 100, h: 80 };
  const roomy = { x: 0, y: 0, w: 1000, h: 800 };

  assert.deepEqual(
    resizeFromEdge(undersized, "w", { x: 0, y: 0 }, minimum, roomy),
    { x: 150, y: 100, w: 100, h: 40 },
  );
  assert.deepEqual(
    resizeFromEdge(undersized, "n", { x: 0, y: 0 }, minimum, roomy),
    { x: 200, y: 60, w: 50, h: 80 },
  );
});

test("centered resize uses the original center and changes only the requested axis", () => {
  assert.deepEqual(
    resizeFromEdge(
      { x: 200, y: 100, w: 50, h: 40 },
      "e",
      { x: 0, y: 0 },
      { w: 100, h: 80 },
      { x: 0, y: 0, w: 1000, h: 800 },
      true,
    ),
    { x: 175, y: 100, w: 100, h: 40 },
  );
});

test("resize strictly constrains a start rectangle when its minimum fits bounds", () => {
  assert.deepEqual(
    resizeFromEdge(
      { x: -50, y: 24, w: 400, h: 100 },
      "w",
      { x: 0, y: 0 },
      { w: 100, h: 80 },
      { x: 0, y: 24, w: 300, h: 128 },
    ),
    { x: 0, y: 24, w: 300, h: 100 },
  );
});

test("resize preserves oversized minimums and fixed opposite edges in small bounds", () => {
  const smallBounds = { x: 0, y: 24, w: 300, h: 128 };
  const oversized = { x: -100, y: 24, w: 520, h: 420 };
  const minimum = { w: 520, h: 420 };

  const west = resizeFromEdge(
    oversized,
    "w",
    { x: 1000, y: 0 },
    minimum,
    smallBounds,
  );
  assert.equal(west.w, 520);
  assert.equal(west.x + west.w, oversized.x + oversized.w);

  const north = resizeFromEdge(
    oversized,
    "n",
    { x: 0, y: 1000 },
    minimum,
    smallBounds,
  );
  assert.equal(north.h, 420);
  assert.equal(north.y + north.h, oversized.y + oversized.h);
  assert.ok(Object.values({ ...west, ...north }).every(Number.isFinite));
});

test("centered resize preserves an oversized minimum and its center", () => {
  const smallBounds = { x: 0, y: 24, w: 300, h: 128 };
  const oversized = { x: -110, y: -122, w: 520, h: 420 };
  const resized = resizeFromEdge(
    oversized,
    "nw",
    { x: 1000, y: 1000 },
    { w: 520, h: 420 },
    smallBounds,
    true,
  );

  assert.deepEqual(resized, oversized);
  assert.equal(resized.x + resized.w / 2, 150);
  assert.equal(resized.y + resized.h / 2, 88);
});

test("centered resize does not shrink existing overflow when growing", () => {
  const smallBounds = { x: 0, y: 24, w: 300, h: 128 };
  const oversized = { x: -150, y: -162, w: 600, h: 500 };
  const minimum = { w: 520, h: 420 };

  assert.deepEqual(
    resizeFromEdge(oversized, "e", { x: 20, y: 0 }, minimum, smallBounds, true),
    oversized,
  );
  assert.deepEqual(
    resizeFromEdge(
      oversized,
      "e",
      { x: -20, y: 0 },
      minimum,
      smallBounds,
      true,
    ),
    { x: -130, y: -162, w: 560, h: 500 },
  );
});

test("centered west resize strictly constrains existing overflow when its center and minimum fit", () => {
  assert.deepEqual(
    resizeFromEdge(
      { x: -50, y: 24, w: 400, h: 100 },
      "w",
      { x: 0, y: 0 },
      { w: 100, h: 80 },
      { x: 0, y: 24, w: 300, h: 128 },
      true,
    ),
    { x: 0, y: 24, w: 300, h: 100 },
  );
});

test("centered north resize strictly constrains existing overflow when its center and minimum fit", () => {
  assert.deepEqual(
    resizeFromEdge(
      { x: 24, y: -50, w: 100, h: 400 },
      "n",
      { x: 0, y: 0 },
      { w: 80, h: 100 },
      { x: 24, y: 0, w: 128, h: 300 },
      true,
    ),
    { x: 24, y: 0, w: 100, h: 300 },
  );
});

test("centered horizontal resize treats a minimum that exactly fits around the center as feasible", () => {
  for (const minimumWidth of [100, 300]) {
    const centerX = minimumWidth / 2;
    for (const deltaX of [0, -20, 20]) {
      assert.deepEqual(
        resizeFromEdge(
          { x: centerX - 200, y: -10, w: 400, h: 40 },
          "w",
          { x: deltaX, y: 0 },
          { w: minimumWidth, h: 80 },
          { x: 0, y: 24, w: 300, h: 128 },
          true,
        ),
        { x: 0, y: -10, w: minimumWidth, h: 40 },
        `minimumWidth=${minimumWidth}, deltaX=${deltaX}`,
      );
    }
  }
});

test("centered vertical resize treats a minimum that exactly fits around the center as feasible", () => {
  for (const minimumHeight of [100, 300]) {
    const centerY = minimumHeight / 2;
    for (const deltaY of [0, -20, 20]) {
      assert.deepEqual(
        resizeFromEdge(
          { x: -10, y: centerY - 200, w: 40, h: 400 },
          "n",
          { x: 0, y: deltaY },
          { w: 80, h: minimumHeight },
          { x: 24, y: 0, w: 128, h: 300 },
          true,
        ),
        { x: -10, y: 0, w: 40, h: minimumHeight },
        `minimumHeight=${minimumHeight}, deltaY=${deltaY}`,
      );
    }
  }
});

test("centered horizontal resize controls overflow when the center is too close to or outside bounds", () => {
  for (const centerX of [49, 0, -1, 251, 300, 301]) {
    const overflowing = { x: centerX - 200, y: -10, w: 400, h: 40 };
    for (const deltaX of [0, -20, 20]) {
      const resized = resizeFromEdge(
        overflowing,
        "w",
        { x: deltaX, y: 0 },
        { w: 100, h: 80 },
        { x: 0, y: 24, w: 300, h: 128 },
        true,
      );
      assert.deepEqual(
        resized,
        deltaX > 0
          ? { ...overflowing, x: overflowing.x + 20, w: 360 }
          : overflowing,
        `centerX=${centerX}, deltaX=${deltaX}`,
      );
      assert.equal(resized.x + resized.w / 2, centerX);
    }
  }
});

test("centered vertical resize controls overflow when the center is too close to or outside bounds", () => {
  for (const centerY of [49, 0, -1, 251, 300, 301]) {
    const overflowing = { x: -10, y: centerY - 200, w: 40, h: 400 };
    for (const deltaY of [0, -20, 20]) {
      const resized = resizeFromEdge(
        overflowing,
        "n",
        { x: 0, y: deltaY },
        { w: 80, h: 100 },
        { x: 24, y: 0, w: 128, h: 300 },
        true,
      );
      assert.deepEqual(
        resized,
        deltaY > 0
          ? { ...overflowing, y: overflowing.y + 20, h: 360 }
          : overflowing,
        `centerY=${centerY}, deltaY=${deltaY}`,
      );
      assert.equal(resized.y + resized.h / 2, centerY);
    }
  }
});

test("centered corner resize determines strict bounds feasibility independently for each axis", () => {
  assert.deepEqual(
    resizeFromEdge(
      { x: -50, y: -151, w: 400, h: 400 },
      "nw",
      { x: -20, y: -20 },
      { w: 100, h: 100 },
      { x: 0, y: 0, w: 300, h: 300 },
      true,
    ),
    { x: 0, y: -151, w: 300, h: 400 },
  );
});

test("resize sanitizes non-finite input instead of returning non-finite values", () => {
  assert.deepEqual(
    resizeFromEdge(start, "e", { x: Number.NaN, y: 0 }, minSize, bounds),
    start,
  );
  assert.deepEqual(
    resizeFromEdge(
      start,
      "e",
      { x: 10, y: 0 },
      { w: Number.POSITIVE_INFINITY, h: 10 },
      bounds,
    ),
    start,
  );
  assert.deepEqual(
    resizeFromEdge(
      { ...start, x: Number.NaN },
      "e",
      { x: 10, y: 0 },
      minSize,
      bounds,
    ),
    { x: 0, y: 0, w: 0, h: 0 },
  );
  assert.deepEqual(
    resizeFromEdge(start, "e", { x: 10, y: 0 }, minSize, {
      ...bounds,
      h: Number.NaN,
    }),
    { x: 0, y: 0, w: 0, h: 0 },
  );
});

test("workarea combines safe insets with persistent menu bar and three dock sides", () => {
  const viewport = { x: 10, y: 20, w: 1000, h: 700 };
  const base = {
    menuBar: { persistent: true, size: 24 },
    safeInsets: { top: 10, right: 11, bottom: 12, left: 13 },
  };
  assert.deepEqual(
    computeDesktopWorkarea(viewport, {
      ...base,
      dock: { persistent: true, position: "bottom", size: 48 },
    }),
    { x: 23, y: 54, w: 976, h: 606 },
  );
  assert.deepEqual(
    computeDesktopWorkarea(viewport, {
      ...base,
      dock: { persistent: true, position: "left", size: 48 },
    }),
    { x: 71, y: 54, w: 928, h: 654 },
  );
  assert.deepEqual(
    computeDesktopWorkarea(viewport, {
      ...base,
      dock: { persistent: true, position: "right", size: 48 },
    }),
    { x: 23, y: 54, w: 928, h: 654 },
  );
});

test("workarea ignores auto-hidden chrome and clamps tiny viewports to zero size", () => {
  assert.deepEqual(
    computeDesktopWorkarea(
      { x: 4, y: 6, w: 20, h: 10 },
      {
        menuBar: { persistent: false, size: 30 },
        dock: { persistent: false, position: "bottom", size: 90 },
        safeInsets: { top: 8, right: 30, bottom: 8, left: 30 },
      },
    ),
    { x: 24, y: 14, w: 0, h: 0 },
  );
});

const workarea: Rect = { x: 20, y: 40, w: 1000, h: 700 };
const normal: Rect = { x: -80, y: 100, w: 1200, h: 500 };

test("projectDesktopRect projects normal, fill, zoom, halves, and quadrants", () => {
  assert.deepEqual(projectDesktopRect("normal", normal, workarea), {
    x: 20,
    y: 100,
    w: 1000,
    h: 500,
  });
  assert.deepEqual(projectDesktopRect("fill", normal, workarea), workarea);
  assert.deepEqual(
    projectDesktopRect("zoom", normal, workarea, {
      preferredSize: { w: 640, h: 480 },
      minSize: { w: 500, h: 400 },
    }),
    { x: 200, y: 150, w: 640, h: 480 },
  );
  assert.deepEqual(projectDesktopRect("left", normal, workarea), {
    x: 20,
    y: 40,
    w: 500,
    h: 700,
  });
  assert.deepEqual(projectDesktopRect("right", normal, workarea), {
    x: 520,
    y: 40,
    w: 500,
    h: 700,
  });
  assert.deepEqual(projectDesktopRect("top", normal, workarea), {
    x: 20,
    y: 40,
    w: 1000,
    h: 350,
  });
  assert.deepEqual(projectDesktopRect("bottom", normal, workarea), {
    x: 20,
    y: 390,
    w: 1000,
    h: 350,
  });
  assert.deepEqual(projectDesktopRect("top-left", normal, workarea), {
    x: 20,
    y: 40,
    w: 500,
    h: 350,
  });
  assert.deepEqual(projectDesktopRect("bottom-left", normal, workarea), {
    x: 20,
    y: 390,
    w: 500,
    h: 350,
  });
  assert.deepEqual(projectDesktopRect("bottom-right", normal, workarea), {
    x: 520,
    y: 390,
    w: 500,
    h: 350,
  });
});

test("normal projection keeps oversized minimums reachable in a small workarea", () => {
  const smallWorkarea = { x: 0, y: 24, w: 300, h: 128 };
  const centeredLargeWindow = { x: -110, y: -122, w: 520, h: 420 };
  const options = { minSize: { w: 520, h: 420 } };

  const projected = projectDesktopRect(
    "normal",
    centeredLargeWindow,
    smallWorkarea,
    options,
  );
  assert.deepEqual(projected, { x: -110, y: 24, w: 520, h: 420 });
  assert.ok(projected.w >= 520);
  assert.ok(projected.h >= 420);
  assert.ok(
    Math.min(projected.x + projected.w, smallWorkarea.x + smallWorkarea.w) -
      Math.max(projected.x, smallWorkarea.x) >=
      120,
  );

  for (const x of [-10_000, 10_000]) {
    const moved = projectDesktopRect(
      "normal",
      { ...centeredLargeWindow, x },
      smallWorkarea,
      options,
    );
    const visibleWidth =
      Math.min(moved.x + moved.w, smallWorkarea.x + smallWorkarea.w) -
      Math.max(moved.x, smallWorkarea.x);
    assert.ok(visibleWidth >= 120, `x=${x} left ${visibleWidth}px visible`);
    assert.equal(moved.y, 24);
  }
});

test("normal projection enforces the default title-bar reach as a safety floor", () => {
  const smallWorkarea = { x: 0, y: 24, w: 300, h: 128 };
  const distantWindow = { x: 10_000, y: 10_000, w: 600, h: 500 };
  const invalidReaches = [
    { w: 1, h: 1 },
    { w: 0, h: 0 },
    { w: Number.NaN, h: Number.NaN },
  ];

  for (const titleBarReach of invalidReaches) {
    const projected = projectDesktopRect(
      "normal",
      distantWindow,
      smallWorkarea,
      { minSize: { w: 600, h: 500 }, titleBarReach },
    );
    const visibleWidth =
      Math.min(projected.x + projected.w, smallWorkarea.x + smallWorkarea.w) -
      Math.max(projected.x, smallWorkarea.x);
    const reachableTitleHeight =
      Math.min(projected.y + 28, smallWorkarea.y + smallWorkarea.h) -
      Math.max(projected.y, smallWorkarea.y);

    assert.ok(visibleWidth >= 120, `${visibleWidth}px horizontally reachable`);
    assert.ok(
      reachableTitleHeight >= 28,
      `${reachableTitleHeight}px of title bar reachable`,
    );
  }
});

test("normal projection honors title-bar reach above the safety floor", () => {
  assert.deepEqual(
    projectDesktopRect(
      "normal",
      { x: 10_000, y: 10_000, w: 600, h: 500 },
      { x: 0, y: 24, w: 300, h: 128 },
      {
        minSize: { w: 600, h: 500 },
        titleBarReach: { w: 180, h: 40 },
      },
    ),
    { x: 120, y: 112, w: 600, h: 500 },
  );
});

test("normal reachability options do not affect fill or tiled placements", () => {
  const smallWorkarea = { x: 0, y: 24, w: 300, h: 128 };
  const options = {
    minSize: { w: 520, h: 420 },
    titleBarReach: { w: 180, h: 40 },
  };

  assert.deepEqual(
    projectDesktopRect("fill", normal, smallWorkarea, options),
    smallWorkarea,
  );
  assert.deepEqual(
    projectDesktopRect("top-left", normal, smallWorkarea, options),
    {
      x: 0,
      y: 24,
      w: 150,
      h: 64,
    },
  );
});

test("tile margins support a boolean default and an exact numeric gap", () => {
  assert.deepEqual(
    projectDesktopRect("left", normal, workarea, { tileMargins: true }),
    { x: 28, y: 48, w: 484, h: 684 },
  );
  assert.deepEqual(
    projectDesktopRect("top-right", normal, workarea, { tileMargins: 10 }),
    { x: 530, y: 50, w: 480, h: 330 },
  );
  assert.deepEqual(
    projectDesktopRect("fill", normal, workarea, { tileMargins: 10 }),
    workarea,
  );
});

test("zoom honors minimum size but never exceeds a small workarea", () => {
  assert.deepEqual(
    projectDesktopRect(
      "zoom",
      normal,
      { x: 5, y: 7, w: 200, h: 100 },
      {
        preferredSize: { w: 80, h: 50 },
        minSize: { w: 320, h: 240 },
      },
    ),
    { x: 5, y: 7, w: 200, h: 100 },
  );
});

function managed(overrides: Partial<ManagedWindow> = {}): ManagedWindow {
  return {
    id: "a",
    appId: "files",
    title: "Files",
    x: 100,
    y: 100,
    w: 600,
    h: 400,
    minimized: false,
    z: 1,
    spaceId: "desktop",
    placement: "normal",
    restoreRect: null,
    ...overrides,
  };
}

test("getWindowDisplayRect uses projection for desktop placements with side workareas", () => {
  const desktop: DesktopSpace = {
    id: "desktop",
    type: "desktop",
    lastActiveId: "a",
  };
  assert.deepEqual(
    getWindowDisplayRect(
      managed({ placement: "right" }),
      desktop,
      { x: 0, y: 0, w: 1200, h: 800 },
      { x: 60, y: 24, w: 1140, h: 776 },
    ),
    { x: 630, y: 24, w: 570, h: 776 },
  );
});

test("fullscreen always covers the display viewport including visual offsets", () => {
  const fullscreen: DesktopSpace = {
    id: "fullscreen:a",
    type: "fullscreen",
    windowId: "a",
  };
  const viewport = { x: 12, y: 34, w: 900, h: 500 };
  assert.deepEqual(
    getWindowDisplayRect(
      managed({ spaceId: fullscreen.id }),
      fullscreen,
      viewport,
      { x: 12, y: 58, w: 900, h: 400 },
      {
        minSize: { w: 2000, h: 1600 },
        titleBarReach: { w: 180, h: 40 },
      },
    ),
    viewport,
  );
});

test("split projects its windows by ratio without negative geometry", () => {
  const split: DesktopSpace = {
    id: "split:a-b",
    type: "split",
    windowIds: ["a", "b"],
    ratio: 0.4,
  };
  assert.deepEqual(
    getWindowDisplayRect(
      managed({ spaceId: split.id }),
      split,
      { x: 0, y: 0, w: 1200, h: 800 },
      { x: 0, y: 24, w: 1100, h: 776 },
    ),
    { x: 0, y: 24, w: 440, h: 776 },
  );
  assert.deepEqual(
    getWindowDisplayRect(
      managed({ id: "b", spaceId: split.id }),
      { ...split, ratio: Number.POSITIVE_INFINITY },
      { x: 0, y: 0, w: 1200, h: 800 },
      { x: 0, y: 24, w: 1100, h: 776 },
    ),
    { x: 550, y: 24, w: 550, h: 776 },
  );
  assert.deepEqual(
    getWindowDisplayRect(
      managed({ spaceId: split.id }),
      { ...split, ratio: -0.25 },
      { x: 0, y: 0, w: 1200, h: 800 },
      { x: 0, y: 24, w: 1100, h: 776 },
    ),
    { x: 0, y: 24, w: 550, h: 776 },
  );
});
