import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Download, LogOut, Minimize2, Pin, Trash2, X } from "lucide-react";
import { useAppRegistry } from "./app-registry";
import { AppIcon } from "./AppIcon";
import { useWindowManager } from "./window-manager";
import { useSession } from "../lib/session";
import type { ContextMenuItem } from "./ContextMenu";
import { ContextMenuScope } from "./ContextMenuScope";
import { requestFileLocation } from "../lib/file-intent";
import { getGatewayBase } from "../lib/api";
import type { DynamicAppId } from "./types";
import { apps as defaultApps } from "./apps";
import { selectDesktopSurface } from "./window-surface-state";
import { useSurfaceInteractivity } from "./WindowSurface";
import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import { createDockInteractionMachine } from "./dock-interaction";
import type { DockInteractionState } from "./dock-interaction";
import { computeDockLayout } from "./dock-layout";

export function Dock({ connected }: { connected: boolean }) {
  const { windows, desktopState, open, focus, close, minimize, quitApp, recentApps } =
    useWindowManager();
  const { preferences } = useDesktopPreferences();
  const dockPrefs = preferences.dock;
  const visible = selectDesktopSurface(desktopState);
  const wrap = useRef<HTMLDivElement>(null);
  useSurfaceInteractivity(wrap, visible);
  const { profile, exit } = useSession();
  const { apps, commands, getApp } = useAppRegistry();

  // ── Dock order persistence ──────────────────────────────────────────
  const key = `linkos.dock:${JSON.stringify([getGatewayBase(), profile.workspaceId, profile.userId])}`;
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(stored))
        return [
          ...new Set(
            stored.filter((id): id is string => typeof id === "string"),
          ),
        ];
    } catch {
      /* defaults */
    }
    return defaultApps.map((app) => app.id);
  });
  const knownApps = useRef(new Set(defaultApps.map((app) => app.id as string)));
  useEffect(() => {
    const added = apps.filter((app) => !knownApps.current.has(app.id));
    added.forEach((app) => knownApps.current.add(app.id));
    if (added.length)
      setOrder((current) => [
        ...new Set([...current, ...added.map((app) => app.id)]),
      ]);
  }, [apps]);

  // ── Dock layout computation ─────────────────────────────────────────
  const runningAppIds = useMemo(
    () => desktopState.runningApps,
    [desktopState.runningApps],
  );
  const minimizedWindowAppIds = useMemo(
    () =>
      windows
        .filter((win) => win.minimized && getApp(win.appId))
        .map((win) => win.appId as string),
    [windows, getApp],
  );
  const layout = useMemo(
    () =>
      computeDockLayout({
        pinnedIds: order,
        runningAppIds,
        recentAppIds: dockPrefs.showRecentApps ? recentApps : [],
        minimizedWindowAppIds,
        apps: apps.map((app) => ({ id: app.id, name: app.name })),
        maxRecentApps: 3,
        minimizeIntoAppIcon: dockPrefs.minimizeIntoAppIcon,
      }),
    [
      order,
      runningAppIds,
      recentApps,
      minimizedWindowAppIds,
      apps,
      dockPrefs.showRecentApps,
      dockPrefs.minimizeIntoAppIcon,
    ],
  );

  // Build the ordered app list from layout sections
  const ordered = useMemo(() => {
    const allIds = [
      ...layout.pinnedSection,
      ...layout.runningSection,
      ...layout.recentSection,
    ];
    return allIds
      .map((id) => apps.find((app) => app.id === id))
      .filter((app): app is (typeof apps)[number] => app != null);
  }, [layout, apps]);

  // ── Launching animation ─────────────────────────────────────────────
  const [launching, setLaunching] = useState<string | null>(null);
  useEffect(() => {
    if (!launching) return;
    const timer = setTimeout(() => setLaunching(null), 600);
    return () => clearTimeout(timer);
  }, [launching]);

  // ── Interaction state machine ───────────────────────────────────────
  const interactionMachine = useRef(createDockInteractionMachine()).current;
  const [interactionState, setInteractionState] =
    useState<DockInteractionState>("edge");
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (revealTimer.current) {
      clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const dispatch = useCallback(
    (event: Parameters<typeof interactionMachine.transition>[1]) => {
      setInteractionState((prev) => {
        const next = interactionMachine.transition(prev, event);
        if (next === "revealing" && prev !== "revealing") {
          clearTimers();
          revealTimer.current = setTimeout(() => {
            dispatch({ type: "REVEAL_COMPLETE", elapsed: 120 });
          }, 120);
        }
        if (next === "hiding" && prev !== "hiding") {
          clearTimers();
          hideTimer.current = setTimeout(() => {
            dispatch({ type: "HIDE_COMPLETE", elapsed: 220 });
          }, 220);
        }
        if (next === "edge" && prev !== "edge") {
          clearTimers();
        }
        return next;
      });
    },
    [interactionMachine, clearTimers],
  );

  // Auto-hide: dock is visible when shown/revealing or when autoHide is off
  const isDockVisible =
    visible &&
    (!dockPrefs.autoHide ||
      interactionState === "shown" ||
      interactionState === "revealing");

  // Cleanup on unmount
  useEffect(() => () => clearTimers(), [clearTimers]);

  // ── Magnification ───────────────────────────────────────────────────
  const surface = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const drag = useRef<string | null>(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = mq.matches;
    const handler = (e: MediaQueryListEvent) => {
      reducedMotion.current = e.matches;
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ── Slot sizing from preferences ────────────────────────────────────
  const effectiveSize = dockPrefs.size;

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current);
    surface.current
      ?.querySelectorAll<HTMLElement>(".dock-slot")
      .forEach((el) => {
        el.style.setProperty("--dock-scale", "1");
        el.style.setProperty("--dock-shift", "0px");
      });
    surface.current?.style.setProperty("--dock-bg-scale", "1");
  }, []);

  const magnify = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !dockPrefs.magnification ||
        event.pointerType !== "mouse" ||
        reducedMotion.current ||
        drag.current
      )
        return;
      const x = event.clientX;
      const y = event.clientY;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const root = surface.current;
        if (!root) return;
        const rect = root.getBoundingClientRect();
        const isVertical =
          dockPrefs.position === "left" || dockPrefs.position === "right";
        const pointer = isVertical ? y : x;
        const origin = isVertical ? rect.top : rect.left;
        const slots = [...root.querySelectorAll<HTMLElement>(".dock-slot")];
        const maxScale = dockPrefs.magnificationScale;
        const scales = slots.map((el) => {
          const center = isVertical
            ? el.offsetTop + el.offsetHeight / 2
            : el.offsetLeft + el.offsetWidth / 2;
          const distance = Math.abs(pointer - (origin + center));
          return (
            1 +
            (maxScale - 1) *
              Math.max(0, 1 - distance / 125) ** 2
          );
        });
        const extra = scales.map(
          (scale, i) => slots[i].offsetWidth * (scale - 1),
        );
        const total = extra.reduce((sum, value) => sum + value, 0);
        let offset = -total / 2;
        slots.forEach((el, i) => {
          el.style.setProperty("--dock-scale", String(scales[i]));
          el.style.setProperty("--dock-shift", `${offset + extra[i] / 2}px`);
          offset += extra[i];
        });
        root.style.setProperty(
          "--dock-bg-scale",
          String(1 + total / (isVertical ? rect.height : rect.width)),
        );
      });
    },
    [dockPrefs.magnification, dockPrefs.magnificationScale, dockPrefs.position],
  );

  // ── Persist order ───────────────────────────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(order));
    } catch {
      /* preferences are optional */
    }
  }, [key, order]);

  // ── Context menu ────────────────────────────────────────────────────
  const menu = (id: DynamicAppId): ContextMenuItem[] => {
    const win = windows.find((item) => item.appId === id);
    return [
      ...commands
        .filter((command) => command.id.startsWith(`${id}:`))
        .map((command) => ({
          id: command.id,
          label: command.title,
          onClick: command.run,
        })),
      {
        id: "open",
        label: win ? "显示窗口" : "打开",
        onClick: () => (win ? focus(win.id) : open(id)),
      },
      ...(win
        ? [
            {
              id: "minimize",
              label: "最小化",
              icon: <Minimize2 size={14} />,
              disabled:
                win.minimized ||
                desktopState.windows.find((item) => item.id === win.id)
                  ?.spaceId !== "desktop",
              onClick: () => minimize(win.id),
            },
          ]
        : []),
      {
        id: "pin",
        label: order.includes(id) ? "从 Dock 移除" : "保留在 Dock",
        icon: <Pin size={14} />,
        onClick: () =>
          setOrder((current) =>
            current.includes(id)
              ? current.filter((item) => item !== id)
              : [...current, id],
          ),
      },
      ...(win
        ? [
            {
              id: "quit",
              label: "退出应用",
              icon: <X size={14} />,
              onClick: () => quitApp(id),
            },
          ]
        : []),
    ];
  };

  const location = (target: "downloads" | "trash") => {
    if (!apps.some((app) => app.id === "files")) return;
    requestFileLocation(target);
    open("files");
  };

  // ── Position classes ────────────────────────────────────────────────
  const positionClass = `desktop-dock-wrap--${dockPrefs.position}`;
  const slotSize = effectiveSize;

  return (
    <div
      ref={wrap}
      className={`desktop-dock-wrap ${positionClass}`}
      data-visible={isDockVisible}
      data-interactive={isDockVisible}
      data-space-id={desktopState.currentSpaceId}
      data-position={dockPrefs.position}
      data-interaction-state={interactionState}
      data-auto-hide={dockPrefs.autoHide}
      aria-hidden={!isDockVisible || undefined}
      onPointerEnter={() => {
        if (dockPrefs.autoHide) dispatch("EDGE_ENTER");
      }}
      onPointerLeave={() => {
        if (dockPrefs.autoHide) dispatch("EDGE_LEAVE");
      }}
      onBlur={() => dispatch("BLUR")}
    >
      {/* Edge trigger zone for auto-hide */}
      {dockPrefs.autoHide && interactionState === "edge" && (
        <span
          className="dock-edge-trigger"
          data-position={dockPrefs.position}
          onPointerEnter={() => dispatch("EDGE_ENTER")}
        />
      )}
      <div
        ref={surface}
        className="desktop-dock"
        role="toolbar"
        aria-label="应用程序 Dock"
        data-position={dockPrefs.position}
        style={{ "--dock-slot-size": `${slotSize}px` } as React.CSSProperties}
        onPointerMove={magnify}
        onPointerLeave={() => {
          reset();
          if (dockPrefs.autoHide) dispatch("EDGE_LEAVE");
        }}
        onKeyDown={(event) => {
          const arrowKeys =
            dockPrefs.position === "bottom"
              ? ["ArrowLeft", "ArrowRight", "Home", "End"]
              : ["ArrowUp", "ArrowDown", "Home", "End"];
          if (!arrowKeys.includes(event.key)) return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ":scope > button",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const isReverse =
            event.key === "ArrowUp" || event.key === "ArrowLeft";
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (isReverse ? -1 : 1) + buttons.length) %
                  buttons.length;
          event.preventDefault();
          reset();
          buttons[next]?.focus();
        }}
      >
        <span
          className={`dock-connection ${connected ? "online" : ""}`}
          role="status"
          aria-label={connected ? "已连接工作区" : "连接已断开"}
        />
        {ordered.map((app) => {
          const win = windows.find((item) => item.appId === app.id);
          const isMinimized = win?.minimized ?? false;
          const isRunning = desktopState.runningApps.includes(app.id);
          return (
            <ContextMenuScope
              key={app.id}
              owner={{ kind: "shell", objectId: `dock:${app.id}` }}
              active={isDockVisible}
              getMenu={() => {
                reset();
                dispatch("CONTEXT_MENU_OPEN");
                return menu(app.id);
              }}
            >
              {(ref) => (
                <button
                  ref={ref}
                  data-dock-app={app.id}
                  className={`dock-slot ${launching === app.id && dockPrefs.animateOpening ? "is-launching" : ""} ${isMinimized && dockPrefs.minimizeIntoAppIcon ? "has-minimized" : ""}`}
                  aria-label={app.name}
                  aria-pressed={!!win && !win.minimized}
                  draggable
                  onDragStart={(event) => {
                    drag.current = app.id;
                    reset();
                    dispatch("DRAG_START");
                    event.dataTransfer.setData(
                      "application/x-linkos-dock",
                      app.id,
                    );
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    drag.current = null;
                    reset();
                    dispatch("DRAG_END");
                  }}
                  onDragOver={(event) => {
                    if (drag.current) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source = drag.current;
                    if (!source || source === app.id) return;
                    setOrder((current) => {
                      const next = current.filter((id) => id !== source);
                      next.splice(Math.max(0, next.indexOf(app.id)), 0, source);
                      return next;
                    });
                    drag.current = null;
                  }}
                  onClick={() => {
                    if (win) focus(win.id);
                    else {
                      setLaunching(app.id);
                      open(app.id);
                    }
                  }}
                >
                  <span className="dock-visual">
                    <AppIcon app={app} size={Math.round(slotSize * 0.92)} />
                    <span className="dock-tooltip">{app.name}{isMinimized ? " · 已最小化" : ""}</span>
                  </span>
                  <span
                    className={`dock-running ${isRunning ? "is-running" : ""}`}
                    style={{
                      opacity:
                        !dockPrefs.showRunningIndicators || !isRunning
                          ? 0
                          : undefined,
                    }}
                  />
                </button>
              )}
            </ContextMenuScope>
          );
        })}
        <span className="dock-divider" />
        {/* Minimized windows section (only when not absorbed into app icons) */}
        {!dockPrefs.minimizeIntoAppIcon &&
          windows
            .filter((win) => win.minimized && getApp(win.appId))
            .map((win) => (
              <button
                key={win.id}
                className="dock-slot dock-window"
                aria-label={`还原 ${win.title}`}
                onClick={() => focus(win.id)}
              >
                <span className="dock-visual">
                  <span className="dock-mini-window">
                    <span />
                    <AppIcon app={getApp(win.appId)!} size={Math.round(slotSize * 0.5)} />
                  </span>
                  <span className="dock-tooltip">{win.title}</span>
                </span>
              </button>
            ))}
        <button
          className="dock-slot"
          aria-label="打开 Downloads"
          onClick={() => location("downloads")}
        >
          <span className="dock-visual dock-special dock-downloads">
            <Download size={Math.round(slotSize * 0.54)} />
            <span className="dock-tooltip">Downloads</span>
          </span>
        </button>
        <button
          className="dock-slot"
          aria-label="打开废纸篓"
          onClick={() => location("trash")}
        >
          <span className="dock-visual dock-special dock-trash">
            <Trash2 size={Math.round(slotSize * 0.52)} />
            <span className="dock-tooltip">废纸篓</span>
          </span>
        </button>
        <button
          className="dock-exit"
          aria-label="退出登录"
          title={`退出登录（${profile.displayName}）`}
          onClick={exit}
        >
          <LogOut size={15} />
        </button>
      </div>
    </div>
  );
}
