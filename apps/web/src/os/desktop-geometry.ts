import type {
  DesktopPlacement,
  DesktopSpace,
  ManagedWindow,
  Rect,
} from "./types";

export type ResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

export type DesktopWorkareaOptions = {
  dock?: {
    persistent: boolean;
    position: "bottom" | "left" | "right";
    size: number;
  };
  safeInsets?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
};

export type DesktopProjectionOptions = {
  tileMargins?: boolean | number;
  preferredSize?: Size;
  minSize?: Size;
  titleBarReach?: Size;
};

const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };
const DEFAULT_TILE_MARGIN = 8;
const DEFAULT_TITLE_BAR_REACH: Size = { w: 120, h: 28 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 0;
}

function isValidRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.w >= 0 &&
    rect.h >= 0
  );
}

function safeRect(rect: Rect): Rect {
  return isValidRect(rect) ? { ...rect } : { ...ZERO_RECT };
}

function projectNormalRect(
  rect: Rect,
  bounds: Rect,
  options: DesktopProjectionOptions,
): Rect {
  if (!isValidRect(bounds)) return { ...ZERO_RECT };
  const candidate = safeRect(rect);
  const minimumWidth = finiteNonNegative(options.minSize?.w);
  const minimumHeight = finiteNonNegative(options.minSize?.h);
  const w = Math.max(minimumWidth, Math.min(candidate.w, bounds.w));
  const h = Math.max(minimumHeight, Math.min(candidate.h, bounds.h));
  const requestedReach = options.titleBarReach;
  const visibleWidth = Math.min(
    Math.max(DEFAULT_TITLE_BAR_REACH.w, finiteNonNegative(requestedReach?.w)),
    w,
    bounds.w,
  );
  const visibleTitleBarHeight = Math.min(
    Math.max(DEFAULT_TITLE_BAR_REACH.h, finiteNonNegative(requestedReach?.h)),
    h,
    bounds.h,
  );
  const x =
    w <= bounds.w
      ? clamp(candidate.x, bounds.x, bounds.x + bounds.w - w)
      : clamp(
          candidate.x,
          bounds.x + visibleWidth - w,
          bounds.x + bounds.w - visibleWidth,
        );
  const y =
    h <= bounds.h
      ? clamp(candidate.y, bounds.y, bounds.y + bounds.h - h)
      : clamp(
          candidate.y,
          bounds.y,
          bounds.y + bounds.h - visibleTitleBarHeight,
        );
  return { x, y, w, h };
}

export function resizeFromEdge(
  start: Rect,
  edge: ResizeEdge,
  delta: Point,
  minSize: Size,
  bounds: Rect,
  centered = false,
): Rect {
  if (!isValidRect(bounds) || !isValidRect(start)) return { ...ZERO_RECT };
  if (
    !Number.isFinite(delta.x) ||
    !Number.isFinite(delta.y) ||
    !Number.isFinite(minSize.w) ||
    !Number.isFinite(minSize.h)
  ) {
    return { ...start };
  }

  const minimumWidth = finiteNonNegative(minSize.w);
  const minimumHeight = finiteNonNegative(minSize.h);
  const movesWest = edge.includes("w");
  const movesEast = edge.includes("e");
  const movesNorth = edge.includes("n");
  const movesSouth = edge.includes("s");

  if (centered) {
    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;
    let x = start.x;
    let y = start.y;
    let w = start.w;
    let h = start.h;

    if (movesWest || movesEast) {
      const initialHalfWidth = start.w / 2;
      const minimumHalfWidth = minimumWidth / 2;
      const boundedHalfWidth = Math.max(
        0,
        Math.min(centerX - bounds.x, bounds.x + bounds.w - centerX),
      );
      const maximumHalfWidth =
        boundedHalfWidth >= minimumHalfWidth
          ? boundedHalfWidth
          : Math.max(initialHalfWidth, minimumHalfWidth, boundedHalfWidth);
      const proposed = initialHalfWidth + (movesEast ? delta.x : -delta.x);
      const halfWidth = clamp(proposed, minimumHalfWidth, maximumHalfWidth);
      x = centerX - halfWidth;
      w = halfWidth * 2;
    }
    if (movesNorth || movesSouth) {
      const initialHalfHeight = start.h / 2;
      const minimumHalfHeight = minimumHeight / 2;
      const boundedHalfHeight = Math.max(
        0,
        Math.min(centerY - bounds.y, bounds.y + bounds.h - centerY),
      );
      const maximumHalfHeight =
        boundedHalfHeight >= minimumHalfHeight
          ? boundedHalfHeight
          : Math.max(initialHalfHeight, minimumHalfHeight, boundedHalfHeight);
      const proposed = initialHalfHeight + (movesSouth ? delta.y : -delta.y);
      const halfHeight = clamp(proposed, minimumHalfHeight, maximumHalfHeight);
      y = centerY - halfHeight;
      h = halfHeight * 2;
    }

    return { x, y, w, h };
  }

  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (movesWest) {
    if (minimumWidth <= bounds.w) {
      right = clamp(right, bounds.x + minimumWidth, bounds.x + bounds.w);
    }
    const minimumLeft = right - minimumWidth;
    const boundedLeft =
      minimumWidth > bounds.w
        ? Math.min(start.x, bounds.x, minimumLeft)
        : bounds.x;
    left = clamp(start.x + delta.x, boundedLeft, minimumLeft);
  } else if (movesEast) {
    if (minimumWidth <= bounds.w) {
      left = clamp(left, bounds.x, bounds.x + bounds.w - minimumWidth);
    }
    const minimumRight = left + minimumWidth;
    const boundedRight =
      minimumWidth > bounds.w
        ? Math.max(start.x + start.w, bounds.x + bounds.w, minimumRight)
        : bounds.x + bounds.w;
    right = clamp(start.x + start.w + delta.x, minimumRight, boundedRight);
  }
  if (movesNorth) {
    if (minimumHeight <= bounds.h) {
      bottom = clamp(bottom, bounds.y + minimumHeight, bounds.y + bounds.h);
    }
    const minimumTop = bottom - minimumHeight;
    const boundedTop =
      minimumHeight > bounds.h
        ? Math.min(start.y, bounds.y, minimumTop)
        : bounds.y;
    top = clamp(start.y + delta.y, boundedTop, minimumTop);
  } else if (movesSouth) {
    if (minimumHeight <= bounds.h) {
      top = clamp(top, bounds.y, bounds.y + bounds.h - minimumHeight);
    }
    const minimumBottom = top + minimumHeight;
    const boundedBottom =
      minimumHeight > bounds.h
        ? Math.max(start.y + start.h, bounds.y + bounds.h, minimumBottom)
        : bounds.y + bounds.h;
    bottom = clamp(start.y + start.h + delta.y, minimumBottom, boundedBottom);
  }

  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function computeDesktopWorkarea(
  viewport: Rect,
  options: DesktopWorkareaOptions = {},
): Rect {
  if (!isValidRect(viewport)) return { ...ZERO_RECT };
  const safe = options.safeInsets;
  const leftInset = Math.min(finiteNonNegative(safe?.left), viewport.w);
  const topInset = Math.min(finiteNonNegative(safe?.top), viewport.h);
  const rightInset = Math.min(
    finiteNonNegative(safe?.right),
    viewport.w - leftInset,
  );
  const bottomInset = Math.min(
    finiteNonNegative(safe?.bottom),
    viewport.h - topInset,
  );
  const result: Rect = {
    x: viewport.x + leftInset,
    y: viewport.y + topInset,
    w: viewport.w - leftInset - rightInset,
    h: viewport.h - topInset - bottomInset,
  };

  if (options.dock?.persistent) {
    const size = finiteNonNegative(options.dock.size);
    if (options.dock.position === "left") {
      const deduction = Math.min(size, result.w);
      result.x += deduction;
      result.w -= deduction;
    } else if (options.dock.position === "right") {
      result.w -= Math.min(size, result.w);
    } else {
      result.h -= Math.min(size, result.h);
    }
  }
  return result;
}

function tileMargin(value: boolean | number | undefined): number {
  if (value === true) return DEFAULT_TILE_MARGIN;
  return typeof value === "number" ? finiteNonNegative(value) : 0;
}

function insetRect(rect: Rect, amount: number): Rect {
  const horizontal = Math.min(amount, rect.w / 2);
  const vertical = Math.min(amount, rect.h / 2);
  return {
    x: rect.x + horizontal,
    y: rect.y + vertical,
    w: rect.w - horizontal * 2,
    h: rect.h - vertical * 2,
  };
}

export function projectDesktopRect(
  placement: DesktopPlacement,
  normalRect: Rect,
  workarea: Rect,
  options: DesktopProjectionOptions = {},
): Rect {
  if (!isValidRect(workarea)) return { ...ZERO_RECT };
  if (placement === "normal") {
    return projectNormalRect(normalRect, workarea, options);
  }
  if (placement === "fill") return { ...workarea };
  if (placement === "zoom") {
    const preferred = options.preferredSize ?? {
      w: safeRect(normalRect).w,
      h: safeRect(normalRect).h,
    };
    const minimum = options.minSize ?? { w: 0, h: 0 };
    const w = Math.min(
      workarea.w,
      Math.max(finiteNonNegative(preferred.w), finiteNonNegative(minimum.w)),
    );
    const h = Math.min(
      workarea.h,
      Math.max(finiteNonNegative(preferred.h), finiteNonNegative(minimum.h)),
    );
    return {
      x: workarea.x + (workarea.w - w) / 2,
      y: workarea.y + (workarea.h - h) / 2,
      w,
      h,
    };
  }

  const halfWidth = workarea.w / 2;
  const halfHeight = workarea.h / 2;
  let projected: Rect;
  switch (placement) {
    case "left":
      projected = { ...workarea, w: halfWidth };
      break;
    case "right":
      projected = {
        x: workarea.x + halfWidth,
        y: workarea.y,
        w: workarea.w - halfWidth,
        h: workarea.h,
      };
      break;
    case "top":
      projected = { ...workarea, h: halfHeight };
      break;
    case "bottom":
      projected = {
        x: workarea.x,
        y: workarea.y + halfHeight,
        w: workarea.w,
        h: workarea.h - halfHeight,
      };
      break;
    case "top-left":
      projected = { ...workarea, w: halfWidth, h: halfHeight };
      break;
    case "top-right":
      projected = {
        x: workarea.x + halfWidth,
        y: workarea.y,
        w: workarea.w - halfWidth,
        h: halfHeight,
      };
      break;
    case "bottom-left":
      projected = {
        x: workarea.x,
        y: workarea.y + halfHeight,
        w: halfWidth,
        h: workarea.h - halfHeight,
      };
      break;
    case "bottom-right":
      projected = {
        x: workarea.x + halfWidth,
        y: workarea.y + halfHeight,
        w: workarea.w - halfWidth,
        h: workarea.h - halfHeight,
      };
      break;
  }
  return insetRect(projected, tileMargin(options.tileMargins));
}

export function getWindowDisplayRect(
  window: ManagedWindow,
  space: DesktopSpace,
  viewport: Rect,
  workarea: Rect,
  options: DesktopProjectionOptions = {},
): Rect {
  if (space.type === "fullscreen" && space.windowId === window.id) {
    return safeRect(viewport);
  }
  if (space.type === "split") {
    const index = space.windowIds.indexOf(window.id);
    if (index !== -1) {
      const ratio =
        Number.isFinite(space.ratio) && space.ratio >= 0 && space.ratio <= 1
          ? space.ratio
          : 0.5;
      const area = safeRect(workarea);
      const firstWidth = area.w * ratio;
      return index === 0
        ? { ...area, w: firstWidth }
        : {
            x: area.x + firstWidth,
            y: area.y,
            w: area.w - firstWidth,
            h: area.h,
          };
    }
  }
  const currentRect = { x: window.x, y: window.y, w: window.w, h: window.h };
  const normalRect = window.restoreRect ?? currentRect;
  return projectDesktopRect(window.placement, normalRect, workarea, options);
}
