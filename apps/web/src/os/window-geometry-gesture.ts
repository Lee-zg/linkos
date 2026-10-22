import type { Rect } from "./types";
import { resizeFromEdge, type ResizeEdge } from "./desktop-geometry";

export type GestureEdge = ResizeEdge | null;

export type GestureRect = Rect;

export type GestureInput = {
  edge: GestureEdge;
  start: Rect;
  delta: { x: number; y: number };
  minSize: { w: number; h: number };
  bounds: Rect;
  centered: boolean;
};

export type SplitLayout = {
  left: Rect;
  right: Rect;
  dividerX: number;
};

/**
 * Pure function: computes the gesture rectangle for resize or drag operations.
 * Delegates to resizeFromEdge for resize, or applies delta for drag.
 */
export function computeGestureRect(input: GestureInput): GestureRect {
  const { edge, start, delta, minSize, bounds, centered } = input;

  if (edge === null) {
    // Drag operation: move window by delta, clamped to bounds
    const x = Math.max(
      bounds.x,
      Math.min(start.x + delta.x, bounds.x + bounds.w - start.w),
    );
    const y = Math.max(
      bounds.y,
      Math.min(start.y + delta.y, bounds.y + bounds.h - start.h),
    );
    return { x, y, w: start.w, h: start.h };
  }

  // Resize operation: delegate to resizeFromEdge
  return resizeFromEdge(start, edge, delta, minSize, bounds, centered);
}

/**
 * Pure function: computes the split layout for two windows side by side.
 * Ratio determines the left window's width proportion.
 */
export function computeSplitLayout(
  workarea: Rect,
  ratio: number,
  minSize: { w: number; h: number },
): SplitLayout {
  // Clamp ratio to ensure both sides meet minSize
  const minRatio = minSize.w / workarea.w;
  const maxRatio = 1 - minRatio;
  const clampedRatio = Math.max(minRatio, Math.min(ratio, maxRatio));

  const leftWidth = Math.round(workarea.w * clampedRatio);
  const rightWidth = workarea.w - leftWidth;
  const dividerX = workarea.x + leftWidth;

  return {
    left: {
      x: workarea.x,
      y: workarea.y,
      w: leftWidth,
      h: workarea.h,
    },
    right: {
      x: dividerX,
      y: workarea.y,
      w: rightWidth,
      h: workarea.h,
    },
    dividerX,
  };
}

/**
 * Pure function: determines whether the workarea can accommodate a split view
 * with both windows meeting their minimum size requirements.
 */
export function canSplitWindows(
  workarea: Rect,
  minSize: { w: number; h: number },
): boolean {
  return workarea.w >= minSize.w * 2 && workarea.h >= minSize.h;
}
