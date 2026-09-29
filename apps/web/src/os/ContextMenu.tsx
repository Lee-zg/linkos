import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { computeMenuPosition, isEditableElement, findEnabledMenuItem } from "./context-menu";
import { useWindowManager } from "./window-manager";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

export interface ContextMenuGroup {
  id: string;
  items: ContextMenuItem[];
}

export type ContextMenuContent = ContextMenuItem[] | ContextMenuGroup[];

interface ContextMenuState {
  x: number;
  y: number;
  content: ContextMenuContent;
  target: HTMLElement | null;
}

interface ContextMenuContextValue {
  open: (x: number, y: number, content: ContextMenuContent, target?: HTMLElement | null) => void;
  close: () => void;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

export function useContextMenu(): ContextMenuContextValue {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

function isGroupArray(content: ContextMenuContent): content is ContextMenuGroup[] {
  return content.length > 0 && "items" in content[0];
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const { open: openApp, minimizeAll } = useWindowManager();
  const open = useCallback((x: number, y: number, content: ContextMenuContent, target?: HTMLElement | null) => {
    targetRef.current = target ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMenu({ x, y, content, target: targetRef.current });
  }, []);
  const close = useCallback(() => {
    setMenu(null);
    targetRef.current?.focus({ preventScroll: true });
  }, []);
  const dismiss = useCallback(() => setMenu(null), []);
  const fallback: ContextMenuItem[] = [
    { id: "files", label: "打开文件管理器", onClick: () => openApp("files") },
    { id: "desktop", label: "显示桌面", onClick: minimizeAll },
    { id: "settings", label: "系统设置", onClick: () => openApp("settings") },
  ];

  return (
    <ContextMenuContext.Provider value={{ open, close }}>
      <div className="contents" onContextMenu={(event) => {
        if (event.defaultPrevented || isEditableElement(event.target as HTMLElement)) return;
        event.preventDefault();
        open(event.clientX, event.clientY, fallback, event.target as HTMLElement);
      }} onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || isEditableElement(event.target as HTMLElement)) return;
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        open(rect.left, rect.bottom, fallback, target);
      }}>
        {children}
      </div>
      {menu && createPortal(<ContextMenuOverlay menu={menu} onClose={close} onDismiss={dismiss} />, document.body)}
    </ContextMenuContext.Provider>
  );
}

function ContextMenuOverlay({ menu, onClose, onDismiss }: {
  menu: ContextMenuState;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  const [focusIndex, setFocusIndex] = useState(-1);
  const groups = isGroupArray(menu.content) ? menu.content : [{ id: "items", items: menu.content }];
  const items = groups.flatMap((group) => group.items);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(computeMenuPosition(menu, rect, { width: window.innerWidth, height: window.innerHeight }));
    setFocusIndex(-1);
    element.focus();
  }, [menu]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss]);

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onClick?.();
  };
  const focusItem = (index: number) => {
    setFocusIndex(index);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[index]?.focus();
  };

  return (
    <div ref={ref} role="menu" tabIndex={-1}
      className="fixed z-[9999] min-w-40 max-w-[calc(100vw-8px)] overflow-y-auto rounded-lg border bg-popover py-1 text-popover-foreground shadow-xl outline-none"
      style={{ left: position.x, top: position.y, maxHeight: "calc(100dvh - 8px)" }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || isEditableElement(event.target as HTMLElement)) return;
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(findEnabledMenuItem(items, focusIndex, event.key === "ArrowDown" ? "next" : "prev"));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          focusItem(event.key === "Home" ? items.findIndex((item) => !item.disabled) : findEnabledMenuItem(items, 0, "prev"));
        } else if ((event.key === "Enter" || event.key === " ") && focusIndex >= 0) {
          event.preventDefault();
          activate(items[focusIndex]);
        }
      }}>
      {groups.map((group, groupIndex) => <div key={group.id}>
        {groupIndex > 0 && <div role="separator" className="my-1 border-t" />}
        {group.items.map((item) => <button key={item.id} role="menuitem" type="button" tabIndex={-1}
          disabled={item.disabled} aria-disabled={item.disabled || undefined}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:opacity-40"
          onClick={() => activate(item)} onFocus={() => setFocusIndex(items.indexOf(item))}>
          {item.icon}<span>{item.label}</span>
        </button>)}
      </div>)}
    </div>
  );
}

export function useContextMenuTrigger(content: ContextMenuContent) {
  const { open } = useContextMenu();
  return { onContextMenu: (event: React.MouseEvent) => {
    if (isEditableElement(event.target as HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    open(event.clientX, event.clientY, content, event.currentTarget as HTMLElement);
  } };
}
