import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Minus, Square, X, Maximize2, Minimize2, Monitor, Grid3x3, Move, Crosshair } from "lucide-react";
import type { ManagedWindow } from "./types";
import { useAppRegistry } from "./app-registry";
import { useWindowManager } from "./window-manager";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ContextMenuScope } from "./ContextMenuScope";
import {
  getWindowDisplayRect,
  projectDesktopRect,
  resizeFromEdge,
} from "./desktop-geometry";
import {
  selectOwnerOccluders,
  selectWindowSurface,
  visibleOwnerRegions,
} from "./window-surface-state";
import { WindowSurface, useSurfaceInteractivity } from "./WindowSurface";
import { resolveDoubleClickAction } from "./desktop-windowing";
import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import { useWindowGeometryGesture } from "./useWindowGeometryGesture";
import type { GestureEdge } from "./window-geometry-gesture";

const TITLE_BAR_HEIGHT = 40;

export function Window({ win, order }: { win: ManagedWindow; order: number }) {
  const { getApp } = useAppRegistry();
  const manager = useWindowManager();
  const { preferences } = useDesktopPreferences();
  const {
    close,
    focus,
    minimize,
    toggleMaximize,
    setRect,
    setPlacement,
    enterFullscreen,
    exitFullscreen,
    exitSplit,
    switchSpace,
    showOverview,
    desktopState,
    viewport,
    workarea,
    tileMargins,
  } = manager;
  const { controller } = useContextMenu();
  const frameRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number>();
  const isMobile = viewport.w < 768;
  const [appeared, setAppeared] = useState(false);
  const [closing, setClosing] = useState(false);
  const app = getApp(win.appId);
  const Content = app?.component;
  const space = desktopState.spaces.find((item) => item.id === win.spaceId);
  const fullscreen = space?.type === "fullscreen";
  const specialSpace = space?.type === "fullscreen" || space?.type === "split";
  const surface = selectWindowSurface(desktopState, win, {
    closing,
    enabled: !!app,
    mobile: isMobile,
  });
  useSurfaceInteractivity(frameRef, surface.interactive);
  const options = {
    minSize: app?.minSize,
    preferredSize: app?.defaultSize,
    tileMargins,
  };
  const desktopSpace = desktopState.spaces.find(
    (item) => item.type === "desktop",
  )!;
  // Mobile compatibility is only a responsive display projection. It never
  // writes Fill/Full into canonical state, and explicit Full still uses viewport.
  const displayRect = getWindowDisplayRect(
    isMobile && !fullscreen ? { ...win, placement: "fill" } : win,
    isMobile && !fullscreen ? desktopSpace : (space ?? desktopSpace),
    viewport,
    workarea,
    options,
  );
  const canManipulate =
    surface.interactive &&
    !isMobile &&
    space?.type === "desktop" &&
    win.placement === "normal";
  const surfaceRect = useMemo(
    () => ({ x: displayRect.x, y: displayRect.y, w: displayRect.w, h: displayRect.h }),
    [displayRect.x, displayRect.y, displayRect.w, displayRect.h],
  );
  // Modal masks cover only the owner's visible app area below the host title.
  const ownerBounds = useMemo(
    () => ({
      x: surfaceRect.x,
      y: surfaceRect.y + TITLE_BAR_HEIGHT,
      w: surfaceRect.w,
      h: Math.max(0, surfaceRect.h - TITLE_BAR_HEIGHT),
    }),
    [surfaceRect],
  );
  // Owner portals sit above the window layer, so the parts of the owner that
  // higher windows cover are cut out of its modal mask (visually and for hits).
  const occluderKey = selectOwnerOccluders(desktopState, win, {
    mobile: isMobile,
  })
    .map((other) => {
      const otherSpace = desktopState.spaces.find(
        (item) => item.id === other.spaceId,
      );
      const otherApp = getApp(other.appId);
      const otherFull = otherSpace?.type === "fullscreen";
      const rect = getWindowDisplayRect(
        isMobile && !otherFull ? { ...other, placement: "fill" } : other,
        isMobile && !otherFull ? desktopSpace : (otherSpace ?? desktopSpace),
        viewport,
        workarea,
        {
          minSize: otherApp?.minSize,
          preferredSize: otherApp?.defaultSize,
          tileMargins,
        },
      );
      return `${rect.x},${rect.y},${rect.w},${rect.h}`;
    })
    .join(";");
  const ownerRegions = useMemo(() => {
    const occluders = occluderKey
      ? occluderKey.split(";").map((item) => {
          const [x, y, w, h] = item.split(",").map(Number);
          return { x, y, w, h };
        })
      : [];
    return visibleOwnerRegions(ownerBounds, occluders);
  }, [ownerBounds, occluderKey]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || !win.minimized) return;
    const target = document
      .querySelector<HTMLElement>(`[data-dock-app="${win.appId}"]`)
      ?.getBoundingClientRect();
    frame.style.setProperty(
      "--minimize-x",
      `${(target ? target.left + target.width / 2 : viewport.x + viewport.w / 2) - (displayRect.x + displayRect.w / 2)}px`,
    );
    frame.style.setProperty(
      "--minimize-y",
      `${(target ? target.top + target.height / 2 : workarea.y + workarea.h) - (displayRect.y + displayRect.h / 2)}px`,
    );
  }, [
    win.minimized,
    win.appId,
    displayRect.x,
    displayRect.y,
    displayRect.w,
    displayRect.h,
    viewport.x,
    viewport.w,
    workarea.y,
    workarea.h,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setAppeared(true));
    return () => {
      window.cancelAnimationFrame(frame);
      if (closeTimerRef.current !== undefined)
        window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const requestClose = () => {
    if (closing) return;
    // Disable in the initiating event as well as the ensuing layout commit.
    frameRef.current?.setAttribute("inert", "");
    controller.dismiss();
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => close(win.id), 150);
  };
  const toggleFullscreen = () =>
    fullscreen
      ? exitFullscreen(win.id)
      : space?.type === "split"
        ? exitSplit(space.id)
        : enterFullscreen(win.id);
  const titleBarMenu: ContextMenuItem[] = [
    {
      id: "minimize",
      label: "最小化",
      icon: <Minimize2 size={14} />,
      disabled: specialSpace,
      onClick: () => minimize(win.id),
    },
    {
      id: "fill",
      label: win.placement === "fill" ? "还原" : "填充",
      icon: <Maximize2 size={14} />,
      disabled: specialSpace,
      onClick: () => toggleMaximize(win.id),
    },
    {
      id: "fullscreen",
      label: specialSpace ? "退出全屏" : "进入全屏",
      icon: <Maximize2 size={14} />,
      onClick: toggleFullscreen,
    },
    {
      id: "desktop",
      label: "显示桌面",
      icon: <Monitor size={14} />,
      onClick: () => switchSpace(desktopSpace.id),
    },
    // Phase 5: Extended green button menu with grid layout
    {
      id: "fill-arrange",
      label: "Fill & Arrange",
      icon: <Grid3x3 size={14} />,
      disabled: specialSpace,
      grid: {
        layout: "2x2",
        cells: [
          { id: "top-left", label: "左上", onClick: () => setPlacement(win.id, "top-left") },
          { id: "top-right", label: "右上", onClick: () => setPlacement(win.id, "top-right") },
          { id: "bottom-left", label: "左下", onClick: () => setPlacement(win.id, "bottom-left") },
          { id: "bottom-right", label: "右下", onClick: () => setPlacement(win.id, "bottom-right") },
        ],
      },
      onClick: () => setPlacement(win.id, "fill"),
    },
    {
      id: "move-resize",
      label: "Move & Resize",
      icon: <Move size={14} />,
      disabled: specialSpace,
      onClick: () => {
        // Center the window as a basic move/resize action
        const centerX = workarea.x + (workarea.w - win.w) / 2;
        const centerY = workarea.y + (workarea.h - win.h) / 2;
        setRect(win.id, { x: centerX, y: centerY, w: win.w, h: win.h });
      },
    },
    {
      id: "center-window",
      label: "Center Window",
      icon: <Crosshair size={14} />,
      disabled: specialSpace,
      onClick: () => {
        const centerX = workarea.x + (workarea.w - win.w) / 2;
        const centerY = workarea.y + (workarea.h - win.h) / 2;
        setRect(win.id, { x: centerX, y: centerY, w: win.w, h: win.h });
      },
    },
    {
      id: "overview",
      label: "Mission Control",
      onClick: showOverview,
    },
    // Keep Space actions in the same owner/controller menu.
    ...desktopState.windows
      .filter((item) => item.id !== win.id)
      .map((item) => ({
        id: `focus:${item.id}`,
        label: `切换到 ${item.title}`,
        onClick: () => focus(item.id),
      })),
    {
      id: "close",
      label: "关闭",
      icon: <X size={14} />,
      onClick: requestClose,
    },
  ];

  // Phase 7: Transactional 8-direction resize and title bar drag
  const { startResize, startDrag, isGesturing, previewRect } =
    useWindowGeometryGesture({
      displayRect,
      workarea,
      minSize: app?.minSize ?? { w: 200, h: 150 },
      canManipulate,
      onCommit: (rect) => setRect(win.id, rect),
      optionAccelerates: preferences.window.optionAcceleratesTiling,
    });

  const renderedRect = isGesturing && previewRect ? previewRect : displayRect;
  const hidden = !appeared || !surface.visible;
  return (
    <WindowSurface
      win={win}
      state={surface}
      displayRect={surfaceRect}
      ownerBounds={ownerBounds}
      ownerRegions={ownerRegions}
    >
      <div
        ref={frameRef}
        className={`desktop-window fixed flex flex-col overflow-hidden bg-background shadow-2xl motion-reduce:transition-none ${win.minimized ? "is-minimized" : ""} ${fullscreen || isMobile ? "rounded-none border-0" : "rounded-xl border"} ${hidden ? "pointer-events-none scale-[0.97] opacity-0" : "pointer-events-auto scale-100 opacity-100"}`}
        style={{
          left: renderedRect.x,
          top: renderedRect.y,
          width: renderedRect.w,
          height: renderedRect.h,
          zIndex: order,
        }}
        role="dialog"
        aria-label={win.title}
        aria-hidden={!surface.visible || undefined}
        data-window-id={win.id}
        data-space-id={win.spaceId}
        data-space-type={space?.type ?? "missing"}
        data-placement={win.placement}
        data-visible={surface.visible}
        data-interactive={surface.interactive}
        data-active={surface.active}
        data-closing={closing}
        onPointerDown={() => surface.interactive && focus(win.id)}
      >
        <ContextMenuScope
          owner={{ kind: "shell", objectId: `window:${win.id}` }}
          active={surface.interactive}
          getMenu={({ target }) =>
            target.closest("button") ? null : titleBarMenu
          }
        >
          {(ref) => (
            <div
              ref={ref}
              className="relative flex h-10 shrink-0 items-center border-b bg-muted/50 px-3"
              onPointerDown={(event) => {
                if (
                  event.button !== 0 ||
                  !canManipulate ||
                  (event.target as Element).closest("button, input, textarea, select, a[href], [role=button], [contenteditable]")
                ) return;
                focus(win.id);
                startDrag(event);
              }}
              onDoubleClick={(e) => {
                if (
                  !(e.target as HTMLElement).closest("button") &&
                  !isMobile
                ) {
                  const spaceType = (space?.type ?? "desktop") as "desktop" | "fullscreen" | "split";
                  const action = resolveDoubleClickAction(
                    preferences.window.doubleClick,
                    spaceType,
                    isMobile,
                  );
                  switch (action) {
                    case "toggle-maximize":
                      toggleMaximize(win.id);
                      break;
                    case "host-zoom":
                      // Host zoom: use browser zoom API if available
                      if (typeof document !== "undefined" && "zoom" in document.documentElement.style) {
                        const currentZoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
                        document.documentElement.style.zoom = String(currentZoom === 1 ? 1.25 : 1);
                      }
                      break;
                    case "minimize":
                      minimize(win.id);
                      break;
                    case "none":
                      break;
                  }
                }
              }}
              tabIndex={0}
              aria-label={`${win.title} 标题栏`}
            >
              <div
                className="group flex items-center gap-0.5"
                aria-label="窗口控制"
              >
                <button
                  className="window-control"
                  aria-label={`关闭 ${win.title}`}
                  onClick={requestClose}
                  disabled={closing}
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full bg-[#ff5f57]">
                    <X size={8} className="opacity-0 group-hover:opacity-100" />
                  </span>
                </button>
                <button
                  className="window-control"
                  aria-label={`最小化 ${win.title}`}
                  onClick={() => minimize(win.id)}
                  disabled={closing || specialSpace}
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full bg-[#febc2e]">
                    <Minus
                      size={8}
                      className="opacity-0 group-hover:opacity-100"
                    />
                  </span>
                </button>
                <button
                  className="window-control"
                  aria-label={`${specialSpace ? "退出全屏" : "进入全屏"} ${win.title}`}
                  onClick={(e) => {
                    if (e.altKey) {
                      // Option/Alt-click: host zoom
                      if (typeof document !== "undefined" && "zoom" in document.documentElement.style) {
                        const currentZoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
                        document.documentElement.style.zoom = String(currentZoom === 1 ? 1.25 : 1);
                      }
                    } else {
                      toggleFullscreen();
                    }
                  }}
                  disabled={closing}
                >
                  <span className="grid h-3 w-3 place-items-center rounded-full bg-[#28c840]">
                    <Square
                      size={7}
                      className="opacity-0 group-hover:opacity-100"
                    />
                  </span>
                </button>
              </div>
              <span className="pointer-events-none absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate text-xs font-medium text-foreground/80">
                {win.title}
              </span>
            </div>
          )}
        </ContextMenuScope>
        <ContextMenuScope
          owner={{ kind: "app", appId: win.appId, windowId: win.id }}
          active={surface.interactive}
        >
          {(ref) => (
            <div
              ref={ref}
              data-context-menu-owner="app"
              className="min-h-0 flex-1 overflow-auto"
            >
              {Content && <Content />}
            </div>
          )}
        </ContextMenuScope>
        {canManipulate && (
          <>
            {/* 8-direction resize handles */}
            <div
              className="window-resize-handle window-resize-n"
              onPointerDown={startResize("n")}
            />
            <div
              className="window-resize-handle window-resize-e"
              onPointerDown={startResize("e")}
            />
            <div
              className="window-resize-handle window-resize-s"
              onPointerDown={startResize("s")}
            />
            <div
              className="window-resize-handle window-resize-w"
              onPointerDown={startResize("w")}
            />
            <div
              className="window-resize-handle window-resize-ne"
              onPointerDown={startResize("ne")}
            />
            <div
              className="window-resize-handle window-resize-nw"
              onPointerDown={startResize("nw")}
            />
            <div
              className="window-resize-handle window-resize-se"
              onPointerDown={startResize("se")}
            />
            <div
              className="window-resize-handle window-resize-sw"
              onPointerDown={startResize("sw")}
            />
          </>
        )}
      </div>
    </WindowSurface>
  );
}

export function WindowLayer() {
  const { desktopState } = useWindowManager();
  const ordered = [...desktopState.windows].sort((a, b) => a.z - b.z);
  // This parent bounds ONLY the window ordering. Owner portals are physically
  // outside it, so they cannot be trapped below another window's stacking context.
  return (
    <div className="window-layer" data-window-layer="">
      {desktopState.windows.map((win) => (
        <Window
          key={win.id}
          win={win}
          order={ordered.findIndex((item) => item.id === win.id) + 1}
        />
      ))}
    </div>
  );
}
