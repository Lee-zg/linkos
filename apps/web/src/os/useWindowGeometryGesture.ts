import { useCallback, useRef, useState, type PointerEvent } from "react";
import { computeGestureRect, type GestureEdge } from "./window-geometry-gesture";
import type { Rect } from "./types";

export type UseWindowGeometryGestureOptions = {
  /** Current display rect of the window */
  displayRect: Rect;
  /** Workarea bounds for clamping */
  workarea: Rect;
  /** Minimum window size */
  minSize: { w: number; h: number };
  /** Whether the window can be manipulated */
  canManipulate: boolean;
  /** Callback to commit the final rect */
  onCommit: (rect: Rect) => void;
  /** Whether Option key forces centered resize */
  optionAccelerates?: boolean;
};

export type UseWindowGeometryGestureReturn = {
  /** Start a resize gesture from an edge/corner handle */
  startResize: (edge: GestureEdge) => (event: PointerEvent<HTMLDivElement>) => void;
  /** Start a drag gesture from the title bar */
  startDrag: (event: PointerEvent<HTMLDivElement>) => void;
  /** Whether a gesture is in progress */
  isGesturing: boolean;
  /** Preview rect during gesture (for rendering) */
  previewRect: Rect | null;
};

/**
 * Hook: manages 8-direction resize and title bar drag gestures with
 * transactional semantics (RAF preview, atomic commit on pointerup,
 * rollback on cancel/blur).
 */
export function useWindowGeometryGesture(
  options: UseWindowGeometryGestureOptions,
): UseWindowGeometryGestureReturn {
  const { displayRect, workarea, minSize, canManipulate, onCommit } = options;

  const [isGesturing, setIsGesturing] = useState(false);
  const [previewRect, setPreviewRect] = useState<Rect | null>(null);

  const gestureRef = useRef<{
    pointerId: number;
    edge: GestureEdge;
    startX: number;
    startY: number;
    startRect: Rect;
    rafId: number | null;
  } | null>(null);

  const cleanup = useCallback(() => {
    if (gestureRef.current?.rafId) {
      cancelAnimationFrame(gestureRef.current.rafId);
    }
    gestureRef.current = null;
    setIsGesturing(false);
    setPreviewRect(null);
  }, []);

  const handlePointerMove = useCallback(
    (event: globalThis.PointerEvent) => {
      if (!gestureRef.current) return;
      const gesture = gestureRef.current;
      if (event.pointerId !== gesture.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      if (gesture.rafId) {
        cancelAnimationFrame(gesture.rafId);
      }

      gesture.rafId = requestAnimationFrame(() => {
        if (!gestureRef.current) return;
        const rect = computeGestureRect({
          edge: gesture.edge,
          start: gesture.startRect,
          delta: { x: deltaX, y: deltaY },
          minSize,
          bounds: workarea,
          centered: event.altKey,
        });
        setPreviewRect(rect);
      });
    },
    [minSize, workarea],
  );

  const handlePointerUp = useCallback(
    (event: globalThis.PointerEvent) => {
      if (!gestureRef.current) return;
      const gesture = gestureRef.current;
      if (event.pointerId !== gesture.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      const finalRect = computeGestureRect({
        edge: gesture.edge,
        start: gesture.startRect,
        delta: { x: deltaX, y: deltaY },
        minSize,
        bounds: workarea,
        centered: event.altKey,
      });

      onCommit(finalRect);
      cleanup();
    },
    [minSize, workarea, onCommit, cleanup],
  );

  const handlePointerCancel = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const startGesture = useCallback(
    (edge: GestureEdge, event: PointerEvent<HTMLDivElement>) => {
      if (!canManipulate || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);

      gestureRef.current = {
        pointerId: event.pointerId,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        startRect: { ...displayRect },
        rafId: null,
      };

      setIsGesturing(true);

      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerup", handlePointerUp);
      target.addEventListener("pointercancel", handlePointerCancel);
      target.addEventListener("lostpointercapture", handlePointerCancel);
    },
    [
      canManipulate,
      displayRect,
      handlePointerMove,
      handlePointerUp,
      handlePointerCancel,
    ],
  );

  const startResize = useCallback(
    (edge: GestureEdge) => (event: PointerEvent<HTMLDivElement>) => {
      startGesture(edge, event);
    },
    [startGesture],
  );

  const startDrag = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      startGesture(null, event);
    },
    [startGesture],
  );

  return {
    startResize,
    startDrag,
    isGesturing,
    previewRect,
  };
}
