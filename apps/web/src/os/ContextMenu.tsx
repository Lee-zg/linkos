import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeMenuPosition, isEditableElement, findEnabledMenuItem, flattenMenuActions } from "./context-menu";
import { bindContextMenuEvents, ContextMenuController, type MenuSnapshot } from "./context-menu-controller";

export type { ContextMenuItem, ContextMenuGroup, ContextMenuContent } from "./context-menu";
export { useContextMenuTrigger } from "./ContextMenuScope";

interface ContextMenuContextValue { controller: ContextMenuController }
const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

export function useContextMenu(): ContextMenuContextValue {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

export function useContextMenuSnapshot(): MenuSnapshot | null {
  const { controller } = useContextMenu();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new ContextMenuController());
  const value = useMemo(() => ({ controller }), [controller]);
  const menu = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => {
    const unbind = bindContextMenuEvents(controller, document);
    return () => { unbind(); controller.dismiss(); };
  }, [controller]);
  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {menu && createPortal(<ContextMenuOverlay menu={menu} controller={controller} />, document.body)}
    </ContextMenuContext.Provider>
  );
}

function ContextMenuOverlay({ menu, controller }: { menu: MenuSnapshot; controller: ContextMenuController }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(menu.anchor);
  const [focusIndex, setFocusIndex] = useState(-1);
  const groups = menu.groups;
  const actions = flattenMenuActions(groups);
  let actionIndex = 0;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(computeMenuPosition(menu.anchor, rect, { width: window.innerWidth, height: window.innerHeight }));
    setFocusIndex(-1);
    element.focus();
  }, [menu]);

  const focusItem = (index: number) => {
    setFocusIndex(index);
    if (index < 0) { ref.current?.focus(); return; }
    ref.current?.querySelector<HTMLButtonElement>(`[data-menu-action-index="${index}"]`)?.focus();
  };

  return (
    <div ref={ref} role="menu" tabIndex={-1} data-context-menu-overlay=""
      className="fixed z-[9999] min-w-40 max-w-[calc(100vw-8px)] overflow-y-auto rounded-lg border bg-popover py-1 text-popover-foreground shadow-xl outline-none"
      style={{ left: position.x, top: position.y, maxHeight: "calc(100dvh - 8px)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || isEditableElement(event.target as HTMLElement)) return;
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); controller.close(menu.token); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(findEnabledMenuItem(actions, focusIndex, event.key === "ArrowDown" ? "next" : "prev"));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          focusItem(findEnabledMenuItem(actions, -1, event.key === "Home" ? "next" : "prev"));
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          controller.activate(menu.token, focusIndex);
        }
      }}>
      {groups.map((group, groupIndex) => <div key={group.id}>
        {groupIndex > 0 && <div role="separator" className="my-1 border-t" />}
        {group.items.map((item) => {
          const index = actionIndex++;
          return <div key={item.id}>
            <button role="menuitem" type="button" tabIndex={-1}
              data-menu-action-index={index}
              disabled={actions[index].disabled} aria-disabled={actions[index].disabled || undefined}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:opacity-40"
              onClick={() => controller.activate(menu.token, index)} onFocus={() => setFocusIndex(index)}>
              {item.icon}<span>{item.label}</span>
            </button>
            {item.grid && (
              <div className={`menu-grid menu-grid-${item.grid.layout}`} role="group" aria-label={`${item.label} grid`}>
                {item.grid.cells.map((cell) => {
                  const cellIndex = actionIndex++;
                  const action = actions[cellIndex];
                  return <button
                    key={cell.id}
                    className="menu-grid-cell"
                    role="menuitem"
                    type="button"
                    tabIndex={-1}
                    data-menu-action-index={cellIndex}
                    disabled={action.disabled}
                    aria-disabled={action.disabled || undefined}
                    onFocus={() => setFocusIndex(cellIndex)}
                    onClick={() => controller.activate(menu.token, cellIndex)}
                  >
                    {cell.label}
                  </button>;
                })}
              </div>
            )}
          </div>;
        })}
      </div>)}
    </div>
  );
}
