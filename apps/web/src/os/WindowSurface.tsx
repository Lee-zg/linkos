import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useContextMenu } from "./ContextMenu";
import { ContextMenuScope } from "./ContextMenuScope";
import type { SurfaceState } from "./window-surface-state";
import type { MenuOwner } from "./context-menu-controller";
import type { Rect, ManagedWindow } from "./types";

type WindowOwner = Extract<MenuOwner, { kind: "app" }>;
export type WindowSurfaceValue = SurfaceState & {
  owner: WindowOwner;
  displayRect: Rect;
  /** The visible app area, excluding the host title controls. */
  ownerBounds: Rect;
  /** Disjoint parts of ownerBounds not covered by higher visible windows. */
  ownerRegions: Rect[];
  /** A stable, physically owned destination for Modal portals. */
  portalContainer: HTMLElement | null;
};
const SurfaceContext = createContext<WindowSurfaceValue | null>(null);

export function useWindowSurface(): WindowSurfaceValue | null {
  return useContext(SurfaceContext);
}

/** DOM and controller invalidation happen before paint, not in passive effects. */
export function useSurfaceInteractivity(
  root: RefObject<HTMLElement>,
  interactive: boolean,
) {
  const { controller } = useContextMenu();
  const previous = useRef(interactive);
  useLayoutEffect(() => {
    root.current?.toggleAttribute("inert", !interactive);
    if (!interactive && previous.current) controller.dismiss();
    previous.current = interactive;
  });
}

export function WindowSurface({
  win,
  state,
  displayRect,
  ownerBounds,
  ownerRegions,
  children,
}: {
  win: ManagedWindow;
  state: SurfaceState;
  displayRect: Rect;
  ownerBounds: Rect;
  ownerRegions: Rect[];
  children: ReactNode;
}) {
  const owner = useMemo<WindowOwner>(
    () => ({
      kind: "app",
      appId: win.appId,
      windowId: win.id,
    }),
    [win.appId, win.id],
  );
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const ownerRoot = useRef<HTMLElement | null>(null);
  // The scope root is the container's stable physical parent; both go inert together.
  ownerRoot.current = portalContainer?.parentElement ?? null;
  useSurfaceInteractivity(ownerRoot, state.interactive);
  useLayoutEffect(() => {
    portalContainer?.toggleAttribute("inert", !state.interactive);
  });
  const value = useMemo(
    () => ({ ...state, owner, displayRect, ownerBounds, ownerRegions, portalContainer }),
    [state.visible, state.interactive, state.active, owner, displayRect, ownerBounds, ownerRegions, portalContainer],
  );
  // The frame's empty physical area is silent. Title and app roots own their
  // own scopes. The separate portal root has an owner but no fallback getter:
  // its blank area is silent too, never a route to the Desktop beneath it.
  return (
    <SurfaceContext.Provider value={value}>
      <ContextMenuScope owner={{ kind: "silent" }} active={state.interactive}>
        {(ref) => (
          <div ref={ref} className="contents" data-window-surface={win.id}>
            {children}
          </div>
        )}
      </ContextMenuScope>
      {createPortal(
        <ContextMenuScope owner={owner} active={state.interactive}>
          {(ref) => (
            <div
              ref={ref}
              className="window-owner-portal"
              data-window-owner={win.id}
              data-visible={state.visible}
              data-interactive={state.interactive}
              aria-hidden={!state.visible || undefined}
            >
              <div
                ref={setPortalContainer}
                className="window-portal-container"
                aria-hidden={!state.visible || undefined}
              />
            </div>
          )}
        </ContextMenuScope>,
        document.body,
      )}
    </SurfaceContext.Provider>
  );
}
