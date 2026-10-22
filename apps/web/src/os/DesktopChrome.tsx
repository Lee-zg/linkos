import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import { useWindowManager } from "./window-manager";
import { selectDesktopSurface } from "./window-surface-state";
import type { ContextMenuItem } from "./ContextMenu";
import { ContextMenuScope } from "./ContextMenuScope";
import {
  LogOut,
  Monitor,
  Settings,
  LayoutGrid,
  Layers,
  Columns2,
} from "lucide-react";
import { useSession } from "../lib/session";
import { useAppRegistry } from "./app-registry";

export type MenuBarHideMode = "always" | "desktop-only" | "fullscreen-only" | "never";

/**
 * Pure function: determines whether the menu bar should be visible based on
 * the hideMode preference and the current desktop state.
 *
 * - "always": hidden in both fullscreen and desktop
 * - "desktop-only": hidden only on desktop (visible in fullscreen)
 * - "fullscreen-only": hidden only in fullscreen (visible on desktop) - default
 * - "never": always visible
 */
export function resolveMenuBarVisibility(
  hideMode: MenuBarHideMode,
  isFullscreen: boolean,
  isDesktop: boolean,
): boolean {
  switch (hideMode) {
    case "always":
      return false;
    case "desktop-only":
      return !isDesktop;
    case "fullscreen-only":
      return !isFullscreen;
    case "never":
      return true;
  }
}

/**
 * Pure function: determines whether the chrome controls (top-corner button)
 * should be visible. When the chrome is hidden, the controls are only shown
 * when focus is near the top edge (e.g. user is keyboard-navigating or
 * hovering near the top).
 */
export function resolveChromeControlsVisible(
  chromeVisible: boolean,
  focusNearTopEdge: boolean,
): boolean {
  if (chromeVisible) return true;
  return focusNearTopEdge;
}

const CHROME_HEIGHT = 28;
const EDGE_THRESHOLD = 8;

export function DesktopChrome() {
  const { preferences } = useDesktopPreferences();
  const { desktopState, showOverview, minimizeAll, switchSpace, open, enterSplit } =
    useWindowManager();
  const { exit } = useSession();
  const { apps } = useAppRegistry();
  const desktopVisible = selectDesktopSurface(desktopState);
  const currentSpace = desktopState.spaces.find(
    (s) => s.id === desktopState.currentSpaceId,
  );
  const isFullscreen = currentSpace?.type === "fullscreen";
  const isDesktop = currentSpace?.type === "desktop";

  // Phase 7: Split View - find two visible desktop windows for split
  const desktopWindows = desktopState.windows.filter(
    (w) => w.spaceId === "desktop" && !w.minimized,
  );
  const canSplit = desktopWindows.length >= 2;

  const chromeVisible = resolveMenuBarVisibility(
    preferences.menuBar.hideMode,
    !!isFullscreen,
    !!isDesktop,
  );

  const [focusNearTop, setFocusNearTop] = useState(false);
  const chromeRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number>();

  // Track whether focus or pointer is within the chrome or near the top edge
  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (chromeRef.current?.contains(target)) {
        setFocusNearTop(true);
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = undefined;
        }
      }
    };
    const handleFocusOut = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      const related = e.relatedTarget as HTMLElement | null;
      if (
        chromeRef.current?.contains(target) &&
        !chromeRef.current?.contains(related)
      ) {
        setFocusNearTop(false);
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);

  const controlsVisible = resolveChromeControlsVisible(
    chromeVisible,
    focusNearTop,
  );

  const handleMouseEnter = () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
  };

  const handleMouseLeave = () => {
    if (!chromeRef.current?.contains(document.activeElement)) {
      setFocusNearTop(false);
    }
  };

  const chromeMenu: ContextMenuItem[] = [
    {
      id: "overview",
      label: "Mission Control",
      icon: <LayoutGrid size={14} />,
      onClick: showOverview,
    },
    {
      id: "show-desktop",
      label: "显示桌面",
      icon: <Monitor size={14} />,
      onClick: minimizeAll,
    },
    {
      id: "split-view",
      label: "Split View",
      icon: <Columns2 size={14} />,
      disabled: !canSplit,
      onClick: () => {
        if (desktopWindows.length >= 2) {
          const [first, second] = desktopWindows;
          enterSplit([first.id, second.id], 0.5);
        }
      },
    },
    ...(desktopState.spaces
      .filter((s) => s.type !== "desktop")
      .map((space) => ({
        id: `space:${space.id}`,
        label: `切换到 ${space.type === "fullscreen" ? desktopState.windows.find((w) => w.id === (space as any).windowId)?.title ?? "全屏" : "分屏"}`,
        icon: <Layers size={14} />,
        onClick: () => switchSpace(space.id),
      }))),
    {
      id: "settings",
      label: "系统设置",
      icon: <Settings size={14} />,
      onClick: () => open("settings"),
    },
    {
      id: "logout",
      label: "退出登录",
      icon: <LogOut size={14} />,
      onClick: exit,
    },
  ];

  const showBackground = preferences.menuBar.showBackground;
  const effectiveVisible = chromeVisible || controlsVisible;

  return (
    <ContextMenuScope
      owner={{ kind: "shell", objectId: "desktop-chrome" }}
      active={effectiveVisible}
      getMenu={() => chromeMenu}
    >
      {(ref) => (
        <div
          ref={(node) => {
            (chromeRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            ref(node);
          }}
          className="desktop-chrome"
          data-visible={effectiveVisible}
          data-show-background={showBackground}
          data-hide-mode={preferences.menuBar.hideMode}
          role="menubar"
          aria-label="桌面菜单栏"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: effectiveVisible ? CHROME_HEIGHT : EDGE_THRESHOLD,
            zIndex: "var(--layer-chrome)",
            transition: "transform 200ms ease, opacity 200ms ease",
            transform: chromeVisible ? "translateY(0)" : "translateY(-100%)",
            opacity: chromeVisible ? 1 : 0,
            pointerEvents: effectiveVisible ? "auto" : "none",
          }}
          tabIndex={0}
        >
          {showBackground && (
            <div
              className="desktop-chrome-bg"
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(255,255,255,0.75)",
                backdropFilter: "blur(20px) saturate(1.5)",
                borderBottom: "1px solid rgba(0,0,0,0.08)",
              }}
            />
          )}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              height: "100%",
              padding: "0 12px",
              gap: "16px",
              fontSize: "13px",
              fontWeight: 500,
            }}
            tabIndex={0}
            aria-label="菜单栏焦点"
          >
            <span style={{ fontWeight: 600 }}>LinkOS</span>
            {apps.slice(0, 5).map((app) => (
              <button
                key={app.id}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  fontSize: "12px",
                }}
                onClick={() => {
                  const win = desktopState.windows.find(
                    (w) => w.appId === app.id,
                  );
                  if (win) switchSpace(win.spaceId);
                  else open(app.id);
                }}
              >
                {app.name}
              </button>
            ))}
          </div>
          {/* Top-corner controls for when chrome is hidden */}
          {!chromeVisible && controlsVisible && (
            <button
              className="desktop-chrome-controls-btn"
              aria-label="显示窗口控件"
              tabIndex={0}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                minWidth: 44,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255,255,255,0.9)",
                border: "1px solid rgba(0,0,0,0.1)",
                borderRadius: "0 0 0 8px",
                cursor: "pointer",
                fontSize: "11px",
                zIndex: 1,
              }}
              onClick={() => setFocusNearTop(true)}
            >
              <LayoutGrid size={14} />
            </button>
          )}
        </div>
      )}
    </ContextMenuScope>
  );
}
