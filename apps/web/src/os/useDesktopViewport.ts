import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Rect } from "./types";

export type DesktopViewportEventTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export type DesktopVisualViewport = DesktopViewportEventTarget & {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};

export type DesktopViewportRuntime = DesktopViewportEventTarget & {
  innerWidth: number;
  innerHeight: number;
  visualViewport?: DesktopVisualViewport | null;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
};

const EMPTY_VIEWPORT: Rect = { x: 0, y: 0, w: 0, h: 0 };

function finiteDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function browserRuntime(): DesktopViewportRuntime | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as DesktopViewportRuntime);
}

export function readDesktopViewport(runtime?: DesktopViewportRuntime): Rect {
  if (!runtime) return { ...EMPTY_VIEWPORT };
  const visual = runtime.visualViewport;
  if (
    visual &&
    Number.isFinite(visual.width) &&
    visual.width > 0 &&
    Number.isFinite(visual.height) &&
    visual.height > 0 &&
    Number.isFinite(visual.offsetLeft) &&
    Number.isFinite(visual.offsetTop)
  ) {
    return {
      x: visual.offsetLeft,
      y: visual.offsetTop,
      w: visual.width,
      h: visual.height,
    };
  }
  return {
    x: 0,
    y: 0,
    w: finiteDimension(runtime.innerWidth),
    h: finiteDimension(runtime.innerHeight),
  };
}

export function createDesktopViewportObserver(
  runtime: DesktopViewportRuntime,
  onChange: (viewport: Rect) => void,
): () => void {
  let frame: number | null = null;
  let active = true;
  const visual = runtime.visualViewport;
  const schedule = () => {
    if (!active || frame !== null) return;
    frame = runtime.requestAnimationFrame(() => {
      frame = null;
      if (active) onChange(readDesktopViewport(runtime));
    });
  };

  runtime.addEventListener("resize", schedule);
  visual?.addEventListener("resize", schedule);
  visual?.addEventListener("scroll", schedule);

  return () => {
    if (!active) return;
    active = false;
    runtime.removeEventListener("resize", schedule);
    visual?.removeEventListener("resize", schedule);
    visual?.removeEventListener("scroll", schedule);
    if (frame !== null) {
      runtime.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}

const DesktopViewportContext = createContext<Rect | null>(null);

export function DesktopViewportProvider({
  children,
  runtime: providedRuntime,
}: {
  children: ReactNode;
  runtime?: DesktopViewportRuntime;
}) {
  const runtime = providedRuntime ?? browserRuntime();
  const [viewport, setViewport] = useState<Rect>(() =>
    readDesktopViewport(runtime),
  );

  useEffect(() => {
    setViewport(readDesktopViewport(runtime));
    if (!runtime) return;
    return createDesktopViewportObserver(runtime, (next) => {
      setViewport((current) =>
        current.x === next.x &&
        current.y === next.y &&
        current.w === next.w &&
        current.h === next.h
          ? current
          : next,
      );
    });
  }, [runtime]);

  return createElement(
    DesktopViewportContext.Provider,
    { value: viewport },
    children,
  );
}

export function useDesktopViewport(): Rect {
  const viewport = useContext(DesktopViewportContext);
  if (!viewport) {
    throw new Error(
      "useDesktopViewport must be used within DesktopViewportProvider",
    );
  }
  return viewport;
}
