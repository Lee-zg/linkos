import { useCallback, useRef, useState, type PointerEvent } from "react";
import { useWindowManager } from "./window-manager";
import { computeSplitLayout, canSplitWindows } from "./window-geometry-gesture";
import type { ManagedWindow, Rect } from "./types";

export type SplitViewProps = {
  spaceId: string;
  windowIds: readonly [string, string];
  ratio: number;
  workarea: Rect;
  minSize: { w: number; h: number };
};

/**
 * SplitView: renders two windows side-by-side with a draggable divider.
 * Double-click resets to 50/50. Divider drag updates ratio atomically.
 */
export function SplitView({
  spaceId,
  windowIds,
  ratio,
  workarea,
  minSize,
}: SplitViewProps) {
  const { setRect, swapSplit, desktopState } = useWindowManager();
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startRatio: number;
  } | null>(null);

  const layout = computeSplitLayout(workarea, ratio, minSize);
  const canSplit = canSplitWindows(workarea, minSize);

  const leftWindow = desktopState.windows.find((w) => w.id === windowIds[0]);
  const rightWindow = desktopState.windows.find((w) => w.id === windowIds[1]);

  const handleDividerPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRatio: ratio,
      };
      setIsDragging(true);
    },
    [ratio],
  );

  const handleDividerPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      if (event.pointerId !== dragRef.current.pointerId) return;

      const deltaX = event.clientX - dragRef.current.startX;
      const deltaRatio = deltaX / workarea.w;
      const newRatio = Math.max(0.1, Math.min(0.9, dragRef.current.startRatio + deltaRatio));

      // Update both windows' rects based on new ratio
      const newLayout = computeSplitLayout(workarea, newRatio, minSize);
      if (leftWindow) {
        setRect(leftWindow.id, newLayout.left);
      }
      if (rightWindow) {
        setRect(rightWindow.id, newLayout.right);
      }
    },
    [workarea, minSize, leftWindow, rightWindow, setRect],
  );

  const handleDividerPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      if (event.pointerId !== dragRef.current.pointerId) return;

      const deltaX = event.clientX - dragRef.current.startX;
      const deltaRatio = deltaX / workarea.w;
      const newRatio = Math.max(0.1, Math.min(0.9, dragRef.current.startRatio + deltaRatio));

      // Commit final ratio by updating rects
      const newLayout = computeSplitLayout(workarea, newRatio, minSize);
      if (leftWindow) {
        setRect(leftWindow.id, newLayout.left);
      }
      if (rightWindow) {
        setRect(rightWindow.id, newLayout.right);
      }

      dragRef.current = null;
      setIsDragging(false);
    },
    [workarea, minSize, leftWindow, rightWindow, setRect],
  );

  const handleDividerDoubleClick = useCallback(() => {
    // Reset to 50/50
    const newLayout = computeSplitLayout(workarea, 0.5, minSize);
    if (leftWindow) {
      setRect(leftWindow.id, newLayout.left);
    }
    if (rightWindow) {
      setRect(rightWindow.id, newLayout.right);
    }
  }, [workarea, minSize, leftWindow, rightWindow, setRect]);

  if (!canSplit || !leftWindow || !rightWindow) {
    return null;
  }

  return (
    <>
      {/* Divider */}
      <div
        className="split-view-divider"
        data-dragging={isDragging}
        style={{
          position: "fixed",
          left: layout.dividerX - 2,
          top: workarea.y,
          width: 4,
          height: workarea.h,
          cursor: "col-resize",
          background: isDragging ? "rgba(44, 131, 232, 0.3)" : "transparent",
          zIndex: 1000,
        }}
        onPointerDown={handleDividerPointerDown}
        onPointerMove={handleDividerPointerMove}
        onPointerUp={handleDividerPointerUp}
        onDoubleClick={handleDividerDoubleClick}
      />
    </>
  );
}

/**
 * Pure function: determines if a split can be created between two windows.
 */
export function canCreateSplit(
  windows: readonly ManagedWindow[],
  windowIds: readonly [string, string],
  workarea: Rect,
  minSize: { w: number; h: number },
): boolean {
  const [firstId, secondId] = windowIds;
  if (firstId === secondId) return false;
  if (!windows.some((w) => w.id === firstId)) return false;
  if (!windows.some((w) => w.id === secondId)) return false;
  return canSplitWindows(workarea, minSize);
}
