import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { AppId, WindowState } from "./types";
import { getApp } from "./apps";

type WindowAction =
  | { type: "OPEN"; appId: AppId }
  | { type: "CLOSE"; id: string }
  | { type: "FOCUS"; id: string }
  | { type: "MINIMIZE"; id: string }
  | { type: "TOGGLE_MAXIMIZE"; id: string }
  | { type: "MOVE"; id: string; x: number; y: number }
  | { type: "RESIZE"; id: string; w: number; h: number };

function nextZ(windows: WindowState[]) {
  return windows.reduce((max, w) => Math.max(max, w.z), 0) + 1;
}

function windowsReducer(
  windows: WindowState[],
  action: WindowAction,
): WindowState[] {
  switch (action.type) {
    case "OPEN": {
      const existing = windows.find((w) => w.appId === action.appId);
      if (existing) {
        return windows.map((w) =>
          w.id === existing.id
            ? { ...w, minimized: false, z: nextZ(windows) }
            : w,
        );
      }
      const app = getApp(action.appId);
      const offset = (windows.length % 8) * 24;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const w = Math.min(app.defaultSize.w, viewportW - 32);
      const h = Math.min(app.defaultSize.h, viewportH - 120);
      return [
        ...windows,
        {
          id: `${action.appId}-${windows.length}-${offset}`,
          appId: action.appId,
          title: app.name,
          x: Math.max(16, (viewportW - w) / 2 + offset - 48),
          y: Math.max(16, (viewportH - h) / 2 + offset - 72),
          w,
          h,
          minimized: false,
          maximized: false,
          z: nextZ(windows),
        },
      ];
    }
    case "CLOSE":
      return windows.filter((w) => w.id !== action.id);
    case "FOCUS":
      return windows.map((w) =>
        w.id === action.id
          ? { ...w, minimized: false, z: nextZ(windows) }
          : w,
      );
    case "MINIMIZE":
      return windows.map((w) =>
        w.id === action.id ? { ...w, minimized: true } : w,
      );
    case "TOGGLE_MAXIMIZE":
      return windows.map((w) =>
        w.id === action.id
          ? { ...w, maximized: !w.maximized, z: nextZ(windows) }
          : w,
      );
    case "MOVE":
      return windows.map((w) =>
        w.id === action.id ? { ...w, x: action.x, y: action.y } : w,
      );
    case "RESIZE":
      return windows.map((w) =>
        w.id === action.id ? { ...w, w: action.w, h: action.h } : w,
      );
  }
}

type WindowManager = {
  windows: WindowState[];
  open: (appId: AppId) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, w: number, h: number) => void;
};

const WindowManagerContext = createContext<WindowManager | null>(null);

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const open = useCallback(
    (appId: AppId) => dispatch({ type: "OPEN", appId }),
    [],
  );
  const close = useCallback((id: string) => dispatch({ type: "CLOSE", id }), []);
  const focus = useCallback((id: string) => dispatch({ type: "FOCUS", id }), []);
  const minimize = useCallback(
    (id: string) => dispatch({ type: "MINIMIZE", id }),
    [],
  );
  const toggleMaximize = useCallback(
    (id: string) => dispatch({ type: "TOGGLE_MAXIMIZE", id }),
    [],
  );
  const move = useCallback(
    (id: string, x: number, y: number) => dispatch({ type: "MOVE", id, x, y }),
    [],
  );
  const resize = useCallback(
    (id: string, w: number, h: number) =>
      dispatch({ type: "RESIZE", id, w, h }),
    [],
  );
  const value = useMemo(
    () => ({ windows, open, close, focus, minimize, toggleMaximize, move, resize }),
    [windows, open, close, focus, minimize, toggleMaximize, move, resize],
  );
  return (
    <WindowManagerContext.Provider value={value}>
      {children}
    </WindowManagerContext.Provider>
  );
}

export function useWindowManager() {
  const ctx = useContext(WindowManagerContext);
  if (!ctx)
    throw new Error("useWindowManager must be used within WindowManagerProvider");
  return ctx;
}
