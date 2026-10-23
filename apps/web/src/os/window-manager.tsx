import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  DesktopPlacement,
  DesktopState,
  DynamicAppId,
  Rect,
  WindowState,
} from "./types";
import type { DesktopPreferencesV1 } from "./desktop-preferences";
import { useAppRegistry } from "./app-registry";
import {
  createInitialDesktopState,
  deriveWindowState,
  desktopReducer,
} from "./desktop-windowing";
import {
  computeDesktopWorkarea,
  type DesktopWorkareaOptions,
} from "./desktop-geometry";
import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import { useDesktopViewport } from "./useDesktopViewport";

function readHostSafeInsets(): DesktopWorkareaOptions["safeInsets"] {
  if (typeof document === "undefined") return undefined;
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    ["top", "right", "bottom", "left"].map((edge) => [
      edge,
      Number.parseFloat(style.getPropertyValue(`--desktop-safe-${edge}`)) || 0,
    ]),
  );
}

export function desktopWorkareaFromPreferences(
  viewport: Rect,
  preferences: DesktopPreferencesV1,
  safeInsets?: DesktopWorkareaOptions["safeInsets"],
): Rect {
  return computeDesktopWorkarea(viewport, {
    safeInsets,
    dock: {
      persistent: !preferences.dock.autoHide,
      position: preferences.dock.position,
      size: preferences.dock.size,
    },
  });
}

export type WindowManager = {
  desktopState: DesktopState;
  /** Shared viewport/workarea for every shell surface and gesture. */
  viewport: Rect;
  workarea: Rect;
  tileMargins: boolean;
  windows: WindowState[];
  runningApps: DesktopState["runningApps"];
  recentApps: DesktopState["recentApps"];
  spaces: DesktopState["spaces"];
  currentSpaceId: string;
  activeId: string | null;
  overviewReturn: DesktopState["overviewReturn"];
  transitionEpoch: number;
  open: (appId: DynamicAppId) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  minimizeAll: () => void;
  toggleMaximize: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, w: number, h: number) => void;
  enterFullscreen: (id: string) => void;
  exitFullscreen: (id: string) => void;
  switchSpace: (spaceId: string) => void;
  setPlacement: (id: string, placement: DesktopPlacement) => void;
  setRect: (id: string, rect: Rect) => void;
  quitApp: (appId: DynamicAppId) => void;
  showOverview: () => void;
  dismissOverview: () => void;
  enterSplit: (windowIds: readonly [string, string], ratio: number) => void;
  exitSplit: (spaceId?: string) => void;
  swapSplit: (spaceId: string) => void;
  replaceSplitWindow: (
    spaceId: string,
    windowId: string,
    replacementId: string,
  ) => void;
};

const WindowManagerContext = createContext<WindowManager | null>(null);

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const catalog = useAppRegistry();
  const { preferences } = useDesktopPreferences();
  const viewport = useDesktopViewport();
  const workarea = useMemo(
    () =>
      desktopWorkareaFromPreferences(
        viewport,
        preferences,
        readHostSafeInsets(),
      ),
    [preferences, viewport],
  );
  const [desktopState, dispatch] = useReducer(
    desktopReducer,
    undefined,
    createInitialDesktopState,
  );
  const fallbackId = useRef(0);

  useEffect(() => {
    dispatch({
      type: "RECONCILE",
      available: catalog.apps.map((app) => app.id),
    });
  }, [catalog.apps]);

  const open = useCallback(
    (appId: DynamicAppId) => {
      const app = catalog.getApp(appId);
      if (!app) return;
      const generatedId =
        typeof window.crypto?.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `${Date.now()}-${fallbackId.current++}`;
      dispatch({
        type: "OPEN",
        appId,
        id: `${appId}-${generatedId}`,
        title: app.name,
        defaultSize: app.defaultSize,
        minSize: app.minSize,
        workarea,
      });
    },
    [catalog.getApp, workarea],
  );
  const close = useCallback(
    (id: string) => dispatch({ type: "CLOSE", id }),
    [],
  );
  const focus = useCallback(
    (id: string) => dispatch({ type: "FOCUS", id }),
    [],
  );
  const minimize = useCallback(
    (id: string) => dispatch({ type: "MINIMIZE", id }),
    [],
  );
  const minimizeAll = useCallback(() => dispatch({ type: "MINIMIZE_ALL" }), []);
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
  const enterFullscreen = useCallback(
    (id: string) => dispatch({ type: "ENTER_FULLSCREEN", id }),
    [],
  );
  const exitFullscreen = useCallback(
    (id: string) => dispatch({ type: "EXIT_FULLSCREEN", id }),
    [],
  );
  const switchSpace = useCallback(
    (spaceId: string) => {
      // A deliberate selection commits the destination; a later overlay
      // dismissal must not restore the space from before Mission Control.
      dispatch({ type: "DISMISS_OVERVIEW" });
      dispatch({ type: "SWITCH_SPACE", spaceId });
    },
    [],
  );
  const setPlacement = useCallback(
    (id: string, placement: DesktopPlacement) =>
      dispatch({ type: "SET_PLACEMENT", id, placement }),
    [],
  );
  const setRect = useCallback(
    (id: string, rect: Rect) => dispatch({ type: "SET_RECT", id, rect }),
    [],
  );
  const quitApp = useCallback(
    (appId: DynamicAppId) => dispatch({ type: "QUIT_APP", appId }),
    [],
  );
  const showOverview = useCallback(
    () => dispatch({ type: "SHOW_OVERVIEW" }),
    [],
  );
  const dismissOverview = useCallback(
    () => dispatch({ type: "DISMISS_OVERVIEW" }),
    [],
  );
  const enterSplit = useCallback(
    (windowIds: readonly [string, string], ratio: number) =>
      dispatch({ type: "ENTER_SPLIT", windowIds, ratio }),
    [],
  );
  const exitSplit = useCallback(
    (spaceId?: string) => dispatch({ type: "EXIT_SPLIT", spaceId }),
    [],
  );
  const swapSplit = useCallback(
    (spaceId: string) => dispatch({ type: "SWAP_SPLIT", spaceId }),
    [],
  );
  const replaceSplitWindow = useCallback(
    (spaceId: string, windowId: string, replacementId: string) =>
      dispatch({
        type: "REPLACE_SPLIT_WINDOW",
        spaceId,
        windowId,
        replacementId,
      }),
    [],
  );
  const windows = useMemo(
    () => deriveWindowState(desktopState),
    [desktopState],
  );
  const value = useMemo<WindowManager>(
    () => ({
      desktopState,
      viewport,
      workarea,
      tileMargins: preferences.window.tileMargins,
      windows,
      runningApps: desktopState.runningApps,
      recentApps: desktopState.recentApps,
      spaces: desktopState.spaces,
      currentSpaceId: desktopState.currentSpaceId,
      activeId: desktopState.activeId,
      overviewReturn: desktopState.overviewReturn,
      transitionEpoch: desktopState.transitionEpoch,
      open,
      close,
      focus,
      minimize,
      minimizeAll,
      toggleMaximize,
      move,
      resize,
      enterFullscreen,
      exitFullscreen,
      switchSpace,
      setPlacement,
      setRect,
      quitApp,
      showOverview,
      dismissOverview,
      enterSplit,
      exitSplit,
      swapSplit,
      replaceSplitWindow,
    }),
    [
      desktopState,
      viewport,
      workarea,
      preferences.window.tileMargins,
      windows,
      open,
      close,
      focus,
      minimize,
      minimizeAll,
      toggleMaximize,
      move,
      resize,
      enterFullscreen,
      exitFullscreen,
      switchSpace,
      setPlacement,
      setRect,
      quitApp,
      showOverview,
      dismissOverview,
      enterSplit,
      exitSplit,
      swapSplit,
      replaceSplitWindow,
    ],
  );
  return (
    <WindowManagerContext.Provider value={value}>
      {children}
    </WindowManagerContext.Provider>
  );
}

export function useWindowManager(): WindowManager {
  const context = useContext(WindowManagerContext);
  if (!context) {
    throw new Error(
      "useWindowManager must be used within WindowManagerProvider",
    );
  }
  return context;
}
