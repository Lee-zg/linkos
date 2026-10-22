import type {
  DesktopPlacement,
  DesktopSpace,
  DesktopState,
  DynamicAppId,
  ManagedWindow,
  Rect,
  WindowState,
} from "./types";
import { projectDesktopRect } from "./desktop-geometry";

export const DESKTOP_SPACE_ID = "desktop" as const;

export type DesktopAction =
  | {
      type: "OPEN";
      appId: DynamicAppId;
      id: string;
      title: string;
      defaultSize: { w: number; h: number };
      minSize: { w: number; h: number };
      workarea: Rect;
      pinnedAppIds?: readonly DynamicAppId[];
    }
  | { type: "RECONCILE"; available: readonly DynamicAppId[] }
  | { type: "CLOSE"; id: string }
  | { type: "QUIT_APP"; appId: DynamicAppId }
  | { type: "FOCUS"; id: string }
  | { type: "MINIMIZE"; id: string }
  | { type: "MINIMIZE_ALL" }
  | { type: "TOGGLE_MAXIMIZE"; id: string }
  | { type: "SET_PLACEMENT"; id: string; placement: DesktopPlacement }
  | { type: "SET_RECT"; id: string; rect: Rect }
  | { type: "MOVE"; id: string; x: number; y: number }
  | { type: "RESIZE"; id: string; w: number; h: number }
  | { type: "ENTER_FULLSCREEN"; id: string }
  | { type: "EXIT_FULLSCREEN"; id: string }
  | { type: "SWITCH_SPACE"; spaceId: string }
  | {
      type: "ENTER_SPLIT";
      windowIds: readonly [string, string];
      ratio: number;
    }
  | { type: "EXIT_SPLIT"; spaceId?: string }
  | { type: "SWAP_SPLIT"; spaceId: string }
  | {
      type: "REPLACE_SPLIT_WINDOW";
      spaceId: string;
      windowId: string;
      replacementId: string;
    }
  | { type: "SHOW_OVERVIEW" }
  | { type: "DISMISS_OVERVIEW" };

export function createInitialDesktopState(): DesktopState {
  return {
    windows: [],
    runningApps: [],
    recentApps: [],
    spaces: [{ id: DESKTOP_SPACE_ID, type: "desktop", lastActiveId: null }],
    currentSpaceId: DESKTOP_SPACE_ID,
    activeId: null,
    overviewReturn: null,
    transitionEpoch: 0,
  };
}

export function fullscreenSpaceId(windowId: string): string {
  return `fullscreen:${windowId}`;
}

export function splitSpaceId(windowIds: readonly [string, string]): string {
  return `split:${JSON.stringify(windowIds)}`;
}

export type DoubleClickAction =
  | "toggle-maximize"
  | "host-zoom"
  | "minimize"
  | "none";

/**
 * Pure function: resolves the title bar double-click preference to a concrete
 * action. Fullscreen/split spaces and mobile always return "none".
 */
export function resolveDoubleClickAction(
  preference: "fill" | "zoom" | "minimize" | "none",
  spaceType: "desktop" | "fullscreen" | "split",
  isMobile: boolean,
): DoubleClickAction {
  if (isMobile || spaceType !== "desktop") return "none";
  switch (preference) {
    case "fill":
      return "toggle-maximize";
    case "zoom":
      return "host-zoom";
    case "minimize":
      return "minimize";
    case "none":
      return "none";
  }
}

export function updateRecentApps(
  recentApps: readonly DynamicAppId[],
  appId: DynamicAppId,
  pinnedAppIds: readonly DynamicAppId[] = [],
): DynamicAppId[] {
  const pinned = new Set(pinnedAppIds);
  return [appId, ...recentApps]
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => !pinned.has(candidate))
    .slice(0, 3);
}

export function deriveWindowState(state: DesktopState): WindowState[] {
  return state.windows.map((window) => ({
    ...window,
    maximized: window.placement === "fill",
  }));
}

function nextZ(windows: readonly ManagedWindow[]): number {
  return (
    windows.reduce((maximum, window) => Math.max(maximum, window.z), 0) + 1
  );
}

function rectOf(window: ManagedWindow): Rect {
  return { x: window.x, y: window.y, w: window.w, h: window.h };
}

function withDesktopLastActive(
  spaces: readonly DesktopSpace[],
  activeId: string | null,
): DesktopSpace[] {
  return spaces.map((space) =>
    space.type === "desktop" ? { ...space, lastActiveId: activeId } : space,
  );
}

function transitioned(state: DesktopState): DesktopState {
  return { ...state, transitionEpoch: state.transitionEpoch + 1 };
}

function activeForSpace(
  space: DesktopSpace,
  windows: readonly ManagedWindow[],
): string | null {
  if (space.type === "fullscreen") return space.windowId;
  if (space.type === "split") {
    return (
      [...space.windowIds]
        .map((id) => windows.find((window) => window.id === id))
        .filter((window): window is ManagedWindow => Boolean(window))
        .sort((left, right) => right.z - left.z)[0]?.id ?? null
    );
  }
  const lastActive = windows.find(
    (window) =>
      window.id === space.lastActiveId &&
      window.spaceId === DESKTOP_SPACE_ID &&
      !window.minimized,
  );
  if (lastActive) return lastActive.id;
  return (
    windows
      .filter(
        (window) => window.spaceId === DESKTOP_SPACE_ID && !window.minimized,
      )
      .sort((left, right) => right.z - left.z)[0]?.id ?? null
  );
}

function removeWindows(
  state: DesktopState,
  removedIds: ReadonlySet<string>,
): DesktopState {
  let windows = state.windows.filter((window) => !removedIds.has(window.id));
  const survivingIds = new Set(windows.map((window) => window.id));
  const spaces: DesktopSpace[] = [];
  const splitReplacements = new Map<string, string>();

  for (const space of state.spaces) {
    if (space.type === "desktop") {
      spaces.push({
        ...space,
        lastActiveId:
          space.lastActiveId && survivingIds.has(space.lastActiveId)
            ? space.lastActiveId
            : null,
      });
      continue;
    }
    if (space.type === "fullscreen") {
      if (survivingIds.has(space.windowId)) spaces.push(space);
      continue;
    }
    const survivors = space.windowIds.filter((id) => survivingIds.has(id));
    if (survivors.length === 2) {
      spaces.push(space);
    } else if (survivors.length === 1) {
      const windowId = survivors[0];
      const replacementId = fullscreenSpaceId(windowId);
      splitReplacements.set(space.id, replacementId);
      if (!spaces.some((candidate) => candidate.id === replacementId)) {
        spaces.push({ id: replacementId, type: "fullscreen", windowId });
      }
      windows = windows.map((window) =>
        window.id === windowId ? { ...window, spaceId: replacementId } : window,
      );
    }
  }

  let currentSpaceId =
    splitReplacements.get(state.currentSpaceId) ?? state.currentSpaceId;
  if (!spaces.some((space) => space.id === currentSpaceId)) {
    currentSpaceId = DESKTOP_SPACE_ID;
  }
  const currentSpace = spaces.find((space) => space.id === currentSpaceId)!;
  const activeWindow = windows.find(
    (window) =>
      window.id === state.activeId &&
      window.spaceId === currentSpaceId &&
      !window.minimized,
  );
  const activeId = activeWindow
    ? activeWindow.id
    : splitReplacements.has(state.currentSpaceId)
      ? activeForSpace(currentSpace, windows)
      : null;

  return {
    ...state,
    windows,
    spaces,
    currentSpaceId,
    activeId,
  };
}

function detachFromSpecialSpaces(
  state: DesktopState,
  ids: ReadonlySet<string>,
): Pick<DesktopState, "windows" | "spaces"> {
  let windows = state.windows;
  const spaces: DesktopSpace[] = [];
  for (const space of state.spaces) {
    if (space.type === "desktop") {
      spaces.push(space);
      continue;
    }
    if (space.type === "fullscreen") {
      if (!ids.has(space.windowId)) spaces.push(space);
      continue;
    }
    const detached = space.windowIds.filter((id) => ids.has(id));
    if (detached.length === 0) {
      spaces.push(space);
      continue;
    }
    const survivor = space.windowIds.find((id) => !ids.has(id));
    if (survivor) {
      const replacementId = fullscreenSpaceId(survivor);
      spaces.push({
        id: replacementId,
        type: "fullscreen",
        windowId: survivor,
      });
      windows = windows.map((window) =>
        window.id === survivor ? { ...window, spaceId: replacementId } : window,
      );
    }
  }
  return { windows, spaces };
}

function placeWindow(
  window: ManagedWindow,
  placement: DesktopPlacement,
): ManagedWindow {
  if (placement === window.placement) return window;
  if (placement === "normal") {
    return {
      ...window,
      ...(window.restoreRect ?? rectOf(window)),
      placement,
      restoreRect: null,
    };
  }
  return {
    ...window,
    placement,
    restoreRect: window.restoreRect ?? rectOf(window),
  };
}

export function desktopReducer(
  state: DesktopState,
  action: DesktopAction,
): DesktopState {
  switch (action.type) {
    case "OPEN": {
      const existing = state.windows.find(
        (window) => window.appId === action.appId,
      );
      const recentApps = updateRecentApps(
        state.recentApps,
        action.appId,
        action.pinnedAppIds,
      );
      const runningApps = state.runningApps.includes(action.appId)
        ? state.runningApps
        : [...state.runningApps, action.appId];
      if (existing) {
        const windows = state.windows.map((window) =>
          window.id === existing.id
            ? { ...window, minimized: false, z: nextZ(state.windows) }
            : window,
        );
        const spaces =
          existing.spaceId === DESKTOP_SPACE_ID
            ? withDesktopLastActive(state.spaces, existing.id)
            : [...state.spaces];
        return transitioned({
          ...state,
          windows,
          spaces,
          runningApps,
          recentApps,
          currentSpaceId: existing.spaceId,
          activeId: existing.id,
        });
      }
      const offset = (state.windows.length % 8) * 24;
      const w = Math.min(
        action.defaultSize.w,
        Math.max(action.minSize.w, action.workarea.w),
      );
      const h = Math.min(
        action.defaultSize.h,
        Math.max(action.minSize.h, action.workarea.h),
      );
      const projected = projectDesktopRect(
        "normal",
        {
          x: action.workarea.x + (action.workarea.w - w) / 2 + offset,
          y: action.workarea.y + (action.workarea.h - h) / 2 + offset,
          w,
          h,
        },
        action.workarea,
        { minSize: action.minSize },
      );
      const window: ManagedWindow = {
        id: action.id,
        appId: action.appId,
        title: action.title,
        ...projected,
        minimized: false,
        z: nextZ(state.windows),
        spaceId: DESKTOP_SPACE_ID,
        placement: "normal",
        restoreRect: null,
      };
      return transitioned({
        ...state,
        windows: [...state.windows, window],
        spaces: withDesktopLastActive(state.spaces, window.id),
        runningApps,
        recentApps,
        currentSpaceId: DESKTOP_SPACE_ID,
        activeId: window.id,
      });
    }
    case "FOCUS": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const windows = state.windows.map((window) =>
        window.id === target.id
          ? { ...window, minimized: false, z: nextZ(state.windows) }
          : window,
      );
      return transitioned({
        ...state,
        windows,
        spaces:
          target.spaceId === DESKTOP_SPACE_ID
            ? withDesktopLastActive(state.spaces, target.id)
            : state.spaces,
        currentSpaceId: target.spaceId,
        activeId: target.id,
      });
    }
    case "MINIMIZE": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || target.spaceId !== DESKTOP_SPACE_ID || target.minimized) {
        return state;
      }
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, minimized: true } : window,
        ),
        spaces: withDesktopLastActive(
          state.spaces,
          state.activeId === target.id ? null : state.activeId,
        ),
        activeId: state.activeId === target.id ? null : state.activeId,
      });
    }
    case "MINIMIZE_ALL": {
      const canMinimize = state.windows.some(
        (window) => window.spaceId === DESKTOP_SPACE_ID && !window.minimized,
      );
      if (!canMinimize) return state;
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.spaceId === DESKTOP_SPACE_ID
            ? { ...window, minimized: true }
            : window,
        ),
        spaces: withDesktopLastActive(state.spaces, null),
        activeId:
          state.currentSpaceId === DESKTOP_SPACE_ID ? null : state.activeId,
      });
    }
    case "TOGGLE_MAXIMIZE": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const placement = target.placement === "fill" ? "normal" : "fill";
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? placeWindow(window, placement) : window,
        ),
      });
    }
    case "SET_PLACEMENT": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const placed = placeWindow(target, action.placement);
      if (placed === target) return state;
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? placed : window,
        ),
      });
    }
    case "SET_RECT": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      if (
        target.x === action.rect.x &&
        target.y === action.rect.y &&
        target.w === action.rect.w &&
        target.h === action.rect.h
      ) {
        return state;
      }
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id ? { ...window, ...action.rect } : window,
        ),
      });
    }
    case "MOVE": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || (target.x === action.x && target.y === action.y))
        return state;
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id
            ? { ...window, x: action.x, y: action.y }
            : window,
        ),
      });
    }
    case "RESIZE": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || (target.w === action.w && target.h === action.h))
        return state;
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id
            ? { ...window, w: action.w, h: action.h }
            : window,
        ),
      });
    }
    case "ENTER_FULLSCREEN": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const spaceId = fullscreenSpaceId(target.id);
      if (target.spaceId === spaceId) {
        if (state.currentSpaceId === spaceId && state.activeId === target.id) {
          return state;
        }
        return transitioned({
          ...state,
          currentSpaceId: spaceId,
          activeId: target.id,
        });
      }
      const detached = detachFromSpecialSpaces(state, new Set([target.id]));
      const spaces = detached.spaces.some((space) => space.id === spaceId)
        ? detached.spaces
        : [
            ...detached.spaces,
            { id: spaceId, type: "fullscreen" as const, windowId: target.id },
          ];
      return transitioned({
        ...state,
        windows: detached.windows.map((window) =>
          window.id === target.id
            ? { ...window, spaceId, minimized: false, z: nextZ(state.windows) }
            : window,
        ),
        spaces,
        currentSpaceId: spaceId,
        activeId: target.id,
      });
    }
    case "EXIT_FULLSCREEN": {
      const target = state.windows.find((window) => window.id === action.id);
      const space = target
        ? state.spaces.find((candidate) => candidate.id === target.spaceId)
        : undefined;
      if (!target || space?.type !== "fullscreen") return state;
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          window.id === target.id
            ? {
                ...window,
                spaceId: DESKTOP_SPACE_ID,
                minimized: false,
                z: nextZ(state.windows),
              }
            : window,
        ),
        spaces: withDesktopLastActive(
          state.spaces.filter((candidate) => candidate.id !== space.id),
          target.id,
        ),
        currentSpaceId: DESKTOP_SPACE_ID,
        activeId: target.id,
      });
    }
    case "SWITCH_SPACE": {
      const space = state.spaces.find(
        (candidate) => candidate.id === action.spaceId,
      );
      if (!space) return state;
      const activeId = activeForSpace(space, state.windows);
      if (
        state.currentSpaceId === action.spaceId &&
        state.activeId === activeId
      ) {
        return state;
      }
      return transitioned({
        ...state,
        currentSpaceId: action.spaceId,
        activeId,
      });
    }
    case "ENTER_SPLIT": {
      const [firstId, secondId] = action.windowIds;
      if (
        firstId === secondId ||
        !Number.isFinite(action.ratio) ||
        action.ratio <= 0 ||
        action.ratio >= 1 ||
        !state.windows.some((window) => window.id === firstId) ||
        !state.windows.some((window) => window.id === secondId)
      ) {
        return state;
      }
      const windowIds: readonly [string, string] = [firstId, secondId];
      const ids = new Set(windowIds);
      const detached = detachFromSpecialSpaces(state, ids);
      const spaceId = splitSpaceId(windowIds);
      const space: DesktopSpace = {
        id: spaceId,
        type: "split",
        windowIds,
        ratio: action.ratio,
      };
      return transitioned({
        ...state,
        windows: detached.windows.map((window) =>
          ids.has(window.id)
            ? {
                ...window,
                spaceId,
                minimized: false,
                z: window.id === firstId ? nextZ(state.windows) : window.z,
              }
            : window,
        ),
        spaces: [...detached.spaces, space],
        currentSpaceId: spaceId,
        activeId: firstId,
      });
    }
    case "EXIT_SPLIT": {
      const spaceId = action.spaceId ?? state.currentSpaceId;
      const space = state.spaces.find(
        (candidate) => candidate.id === spaceId && candidate.type === "split",
      );
      if (!space || space.type !== "split") return state;
      const [firstId] = space.windowIds;
      const ids = new Set(space.windowIds);
      return transitioned({
        ...state,
        windows: state.windows.map((window) =>
          ids.has(window.id)
            ? {
                ...window,
                spaceId: DESKTOP_SPACE_ID,
                z: window.id === firstId ? nextZ(state.windows) : window.z,
              }
            : window,
        ),
        spaces: withDesktopLastActive(
          state.spaces.filter((candidate) => candidate.id !== space.id),
          firstId,
        ),
        currentSpaceId: DESKTOP_SPACE_ID,
        activeId: firstId,
      });
    }
    case "SWAP_SPLIT": {
      const space = state.spaces.find(
        (candidate) =>
          candidate.id === action.spaceId && candidate.type === "split",
      );
      if (!space || space.type !== "split") return state;
      const [firstId, secondId] = space.windowIds;
      const swapped: DesktopSpace = {
        ...space,
        windowIds: [secondId, firstId],
        ratio: 1 - space.ratio,
      };
      return transitioned({
        ...state,
        spaces: state.spaces.map((candidate) =>
          candidate.id === space.id ? swapped : candidate,
        ),
      });
    }
    case "REPLACE_SPLIT_WINDOW": {
      const space = state.spaces.find(
        (candidate) =>
          candidate.id === action.spaceId && candidate.type === "split",
      );
      if (!space || space.type !== "split") return state;
      if (action.windowId === action.replacementId) return state;
      const targetIndex = space.windowIds.indexOf(action.windowId);
      if (targetIndex === -1) return state;
      if (!state.windows.some((w) => w.id === action.replacementId))
        return state;

      const newWindowIds: readonly [string, string] =
        targetIndex === 0
          ? [action.replacementId, space.windowIds[1]]
          : [space.windowIds[0], action.replacementId];

      const detached = detachFromSpecialSpaces(
        state,
        new Set([action.replacementId]),
      );

      return transitioned({
        ...state,
        windows: detached.windows.map((window) => {
          if (window.id === action.windowId) {
            return { ...window, spaceId: DESKTOP_SPACE_ID };
          }
          if (window.id === action.replacementId) {
            return { ...window, spaceId: action.spaceId };
          }
          return window;
        }),
        spaces: detached.spaces.map((candidate) =>
          candidate.id === space.id
            ? { ...candidate, windowIds: newWindowIds }
            : candidate,
        ),
      });
    }
    case "CLOSE": {
      if (!state.windows.some((window) => window.id === action.id))
        return state;
      return transitioned(removeWindows(state, new Set([action.id])));
    }
    case "QUIT_APP": {
      const removedIds = new Set(
        state.windows
          .filter((window) => window.appId === action.appId)
          .map((window) => window.id),
      );
      const hasAppState =
        removedIds.size > 0 ||
        state.runningApps.includes(action.appId) ||
        state.recentApps.includes(action.appId);
      if (!hasAppState) return state;
      const next = removeWindows(state, removedIds);
      return transitioned({
        ...next,
        runningApps: next.runningApps.filter((appId) => appId !== action.appId),
        recentApps: next.recentApps.filter((appId) => appId !== action.appId),
      });
    }
    case "RECONCILE": {
      const available = new Set(action.available);
      const removedIds = new Set(
        state.windows
          .filter((window) => !available.has(window.appId))
          .map((window) => window.id),
      );
      const survivingIds = new Set(
        state.windows
          .filter((window) => !removedIds.has(window.id))
          .map((window) => window.id),
      );
      const hasOrphanedSpace = state.spaces.some((space) => {
        if (space.type === "desktop") return false;
        if (space.type === "fullscreen") {
          return !survivingIds.has(space.windowId);
        }
        return space.windowIds.some((id) => !survivingIds.has(id));
      });
      const runningApps = state.runningApps.filter((appId) =>
        available.has(appId),
      );
      const recentApps = state.recentApps.filter((appId) =>
        available.has(appId),
      );
      if (
        removedIds.size === 0 &&
        !hasOrphanedSpace &&
        runningApps.length === state.runningApps.length &&
        recentApps.length === state.recentApps.length
      ) {
        return state;
      }
      const next = removeWindows(state, removedIds);
      return transitioned({ ...next, runningApps, recentApps });
    }
    case "SHOW_OVERVIEW":
      if (state.overviewReturn) return state;
      return transitioned({
        ...state,
        overviewReturn: {
          spaceId: state.currentSpaceId,
          activeId: state.activeId,
        },
        activeId: null,
      });
    case "DISMISS_OVERVIEW": {
      if (!state.overviewReturn) return state;
      const savedSpace = state.spaces.find(
        (space) => space.id === state.overviewReturn?.spaceId,
      );
      const space =
        savedSpace ??
        state.spaces.find((candidate) => candidate.id === DESKTOP_SPACE_ID)!;
      const savedWindow = state.windows.find(
        (window) =>
          window.id === state.overviewReturn?.activeId &&
          window.spaceId === space.id &&
          !window.minimized,
      );
      return transitioned({
        ...state,
        currentSpaceId: space.id,
        activeId: savedWindow?.id ?? null,
        overviewReturn: null,
      });
    }
  }
}
