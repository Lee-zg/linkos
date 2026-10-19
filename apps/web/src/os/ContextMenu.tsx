import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeMenuPosition, isEditableElement, findEnabledMenuItem } from "./context-menu";
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
  const items = groups.flatMap((group) => group.items);

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
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[index]?.focus();
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
          focusItem(findEnabledMenuItem(items, focusIndex, event.key === "ArrowDown" ? "next" : "prev"));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          focusItem(event.key === "Home" ? items.findIndex((item) => !item.disabled) : findEnabledMenuItem(items, 0, "prev"));
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          controller.activate(menu.token, focusIndex);
        }
      }}>
      {groups.map((group, groupIndex) => <div key={group.id}>
        {groupIndex > 0 && <div role="separator" className="my-1 border-t" />}
        {group.items.map((item) => <button key={item.id} role="menuitem" type="button" tabIndex={-1}
          disabled={item.disabled} aria-disabled={item.disabled || undefined}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:opacity-40"
          onClick={() => controller.activate(menu.token, items.indexOf(item))} onFocus={() => setFocusIndex(items.indexOf(item))}>
          {item.icon}<span>{item.label}</span>
        </button>)}
      </div>)}
    </div>
  );
}
