import type { DesktopState, ManagedWindow, Rect } from "./types";

export type SurfaceState = {
  visible: boolean;
  interactive: boolean;
  active: boolean;
};

/** Overview previews deliberately remain a later visual projection of this DOM. */
export function selectWindowSurface(
  state: DesktopState,
  win: ManagedWindow,
  options: { closing?: boolean; enabled?: boolean; mobile?: boolean } = {},
): SurfaceState {
  const space = state.spaces.find((item) => item.id === win.spaceId);
  const member =
    !!space &&
    (space.type === "desktop" ||
      (space.type === "fullscreen" && space.windowId === win.id) ||
      (space.type === "split" && space.windowIds.includes(win.id)));
  const visible =
    member &&
    state.windows.some((item) => item.id === win.id) &&
    win.spaceId === state.currentSpaceId &&
    !state.overviewReturn &&
    !win.minimized &&
    !options.closing &&
    options.enabled !== false &&
    (!options.mobile || state.activeId === win.id);
  return {
    visible,
    interactive: visible,
    active: visible && state.activeId === win.id,
  };
}

export function selectDesktopSurface(state: DesktopState): boolean {
  return (
    !state.overviewReturn &&
    state.spaces.some(
      (space) => space.id === state.currentSpaceId && space.type === "desktop",
    )
  );
}

/** Windows stacked above `win` that are currently visible and may cover it. */
export function selectOwnerOccluders(
  state: DesktopState,
  win: ManagedWindow,
  options: { mobile?: boolean } = {},
): ManagedWindow[] {
  if (options.mobile) return [];
  return state.windows.filter(
    (other) =>
      other.id !== win.id &&
      other.z > win.z &&
      selectWindowSurface(state, other, options).visible,
  );
}

/** Subtract occluders from `bounds`, returning disjoint visible rects. */
export function visibleOwnerRegions(bounds: Rect, occluders: Rect[]): Rect[] {
  let regions: Rect[] = bounds.w > 0 && bounds.h > 0 ? [bounds] : [];
  for (const cut of occluders) {
    const next: Rect[] = [];
    for (const r of regions) {
      const x1 = Math.max(r.x, cut.x);
      const y1 = Math.max(r.y, cut.y);
      const x2 = Math.min(r.x + r.w, cut.x + cut.w);
      const y2 = Math.min(r.y + r.h, cut.y + cut.h);
      if (x1 >= x2 || y1 >= y2) {
        next.push(r);
        continue;
      }
      const pieces: Rect[] = [
        { x: r.x, y: r.y, w: r.w, h: y1 - r.y },
        { x: r.x, y: y2, w: r.w, h: r.y + r.h - y2 },
        { x: r.x, y: y1, w: x1 - r.x, h: y2 - y1 },
        { x: x2, y: y1, w: r.x + r.w - x2, h: y2 - y1 },
      ];
      next.push(...pieces.filter((piece) => piece.w > 0 && piece.h > 0));
    }
    regions = next;
  }
  return regions;
}
