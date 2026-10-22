import { useEffect, useRef } from "react";
import { useWindowManager } from "./window-manager";
import { useAppRegistry } from "./app-registry";
import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import { X, Monitor } from "lucide-react";
import type { DesktopSpace, DynamicAppId, ManagedWindow } from "./types";

export interface OverviewSpaceEntry {
  spaceId: string;
  type: "desktop" | "fullscreen" | "split";
  isCurrent: boolean;
  canExitFullscreen: boolean;
  windowIds: string[];
  appNames: string[];
}

/**
 * Pure function: filters spaces for the overview, including desktop + fullscreen/split.
 * Marks current space and determines if exit-fullscreen is available.
 */
export function filterOverviewSpaces(
  spaces: readonly DesktopSpace[],
  windows: readonly ManagedWindow[],
  currentSpaceId: string,
): OverviewSpaceEntry[] {
  return spaces.map((space) => {
    const isCurrent = space.id === currentSpaceId;
    if (space.type === "desktop") {
      return {
        spaceId: space.id,
        type: "desktop" as const,
        isCurrent,
        canExitFullscreen: false,
        windowIds: [],
        appNames: [],
      };
    }
    if (space.type === "fullscreen") {
      const win = windows.find((w) => w.id === space.windowId);
      return {
        spaceId: space.id,
        type: "fullscreen" as const,
        isCurrent,
        canExitFullscreen: true,
        windowIds: [space.windowId],
        appNames: win ? [win.title] : [],
      };
    }
    // split
    const spaceWindows = space.windowIds
      .map((id) => windows.find((w) => w.id === id))
      .filter((w): w is ManagedWindow => !!w);
    return {
      spaceId: space.id,
      type: "split" as const,
      isCurrent,
      canExitFullscreen: false,
      windowIds: [...space.windowIds],
      appNames: spaceWindows.map((w) => w.title),
    };
  });
}

/**
 * Pure function: sorts overview spaces by recent use. Desktop always stays first.
 * Other spaces are ordered by the most recently used app they contain.
 */
export function sortOverviewSpaces(
  entries: OverviewSpaceEntry[],
  recentApps: readonly DynamicAppId[],
): OverviewSpaceEntry[] {
  const desktop = entries.find((e) => e.type === "desktop");
  const others = entries.filter((e) => e.type !== "desktop");

  // Sort by recent use: spaces containing more recently used apps come first
  others.sort((a, b) => {
    const aIndex = Math.min(
      ...a.appNames.map((name) => {
        const idx = recentApps.findIndex(
          (appId) => appId === name || appId.includes(name.toLowerCase()),
        );
        return idx === -1 ? Infinity : idx;
      }),
    );
    const bIndex = Math.min(
      ...b.appNames.map((name) => {
        const idx = recentApps.findIndex(
          (appId) => appId === name || appId.includes(name.toLowerCase()),
        );
        return idx === -1 ? Infinity : idx;
      }),
    );
    if (aIndex === bIndex) return 0;
    if (aIndex === Infinity) return 1;
    if (bIndex === Infinity) return -1;
    return aIndex - bIndex;
  });

  return desktop ? [desktop, ...others] : others;
}

export function SpaceOverview() {
  const {
    desktopState,
    overviewReturn,
    dismissOverview,
    switchSpace,
    exitFullscreen,
    focus,
  } = useWindowManager();
  const { getApp } = useAppRegistry();
  const { preferences } = useDesktopPreferences();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Focus the overlay when overview opens
  useEffect(() => {
    if (overviewReturn) {
      overlayRef.current?.focus();
    }
  }, [overviewReturn]);

  if (!overviewReturn) return null;

  const entries = filterOverviewSpaces(
    desktopState.spaces,
    desktopState.windows,
    desktopState.currentSpaceId,
  );

  const sorted = preferences.missionControl.sortSpacesByRecentUse
    ? sortOverviewSpaces(entries, desktopState.recentApps)
    : entries;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      dismissOverview();
    }
  };

  const handleSpaceClick = (entry: OverviewSpaceEntry) => {
    if (preferences.missionControl.switchToAppSpace || entry.type === "desktop") {
      // Direct switch: user explicitly clicked a space card
      switchSpace(entry.spaceId);
      if (entry.windowIds.length > 0) {
        focus(entry.windowIds[0]);
      }
    }
    // When switchToAppSpace is false, we still switch because the user clicked
    dismissOverview();
  };

  return (
    <div
      ref={overlayRef}
      className="space-overview"
      data-overview=""
      role="dialog"
      aria-label="Mission Control"
      aria-modal="true"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--layer-overview)",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(12px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: "24px",
          maxWidth: "1200px",
          width: "100%",
        }}
      >
        {sorted.map((entry) => {
          const app = entry.windowIds[0]
            ? getApp(
                desktopState.windows.find((w) => w.id === entry.windowIds[0])
                  ?.appId ?? "files",
              )
            : null;
          const Icon = app?.icon ?? Monitor;

          return (
            <button
              key={entry.spaceId}
              className={`space-overview-card ${entry.isCurrent ? "is-current" : ""}`}
              data-space-id={entry.spaceId}
              data-space-type={entry.type}
              onClick={() => handleSpaceClick(entry)}
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                padding: "24px 16px",
                borderRadius: "16px",
                border: entry.isCurrent
                  ? "2px solid rgba(255,255,255,0.5)"
                  : "2px solid transparent",
                background: "rgba(255,255,255,0.1)",
                color: "white",
                cursor: "pointer",
                transition: "background 150ms ease, border-color 150ms ease",
              }}
            >
              {entry.isCurrent && (
                <span
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    fontSize: "10px",
                    background: "rgba(255,255,255,0.2)",
                    padding: "2px 8px",
                    borderRadius: "4px",
                  }}
                >
                  当前
                </span>
              )}
              <Icon size={48} style={{ opacity: 0.8 }} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>
                {entry.type === "desktop"
                  ? "桌面"
                  : entry.appNames.join(" + ") || entry.type}
              </span>
              {entry.canExitFullscreen && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="退出全屏"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (entry.windowIds[0]) {
                      exitFullscreen(entry.windowIds[0]);
                    }
                    dismissOverview();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (entry.windowIds[0]) {
                        exitFullscreen(entry.windowIds[0]);
                      }
                      dismissOverview();
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    padding: "4px 8px",
                    borderRadius: "6px",
                    background: "rgba(255,255,255,0.15)",
                    cursor: "pointer",
                  }}
                >
                  <X size={12} />
                  退出全屏
                </span>
              )}
              {!preferences.missionControl.switchToAppSpace &&
                entry.type !== "desktop" &&
                !entry.isCurrent && (
                  <span
                    style={{
                      fontSize: "10px",
                      opacity: 0.7,
                      padding: "2px 6px",
                      borderRadius: "4px",
                      background: "rgba(255,255,255,0.1)",
                    }}
                  >
                    点击切换到该空间
                  </span>
                )}
            </button>
          );
        })}
      </div>
      <button
        aria-label="关闭概览"
        onClick={dismissOverview}
        style={{
          position: "absolute",
          top: 24,
          right: 24,
          width: 44,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: "rgba(255,255,255,0.1)",
          border: "none",
          color: "white",
          cursor: "pointer",
          fontSize: "18px",
        }}
      >
        <X size={20} />
      </button>
    </div>
  );
}
