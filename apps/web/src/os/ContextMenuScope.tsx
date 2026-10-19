import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from "react";
import { useContextMenu } from "./ContextMenu";
import { createMenuScope, type MenuGetter, type MenuOwner, type MenuScope } from "./context-menu-controller";
import type { ContextMenuContent } from "./context-menu";

const ScopeContext = createContext<MenuScope | null>(null);

/** React identity is for registration only; dispatch always resolves physical DOM boundaries. */
export function useContextMenuScope(): MenuScope | null { return useContext(ScopeContext); }

export function ContextMenuScope({ owner, active = true, getMenu, children }: {
  owner: MenuOwner;
  active?: boolean;
  getMenu?: MenuGetter;
  children: (ref: RefCallback<HTMLElement>) => ReactNode;
}) {
  const { controller } = useContextMenu();
  // Owner values, not fresh object literals, determine scope identity.
  const identity = JSON.stringify(owner);
  const scope = useMemo(() => createMenuScope(owner, active), [identity]);
  const [element, ref] = useState<HTMLElement | null>(null);
  const latest = useRef(getMenu);
  latest.current = getMenu;
  useLayoutEffect(() => {
    controller.setScopeActive(scope, active);
  }, [controller, scope, active]);
  useLayoutEffect(() => {
    if (!element) return;
    const unregister = controller.registerScope(scope, element);
    const removeGetter = controller.registerGetter(scope, element, (trigger) => latest.current?.(trigger) ?? null);
    return () => { removeGetter(); unregister(); };
  }, [controller, scope, element]);
  return <ScopeContext.Provider value={scope}>{children(ref)}</ScopeContext.Provider>;
}

/** Attach ref to one physical root. Both pointer and menu keys use the document dispatcher. */
export function useContextMenuTrigger(content: ContextMenuContent | MenuGetter) {
  const { controller } = useContextMenu();
  const scope = useContextMenuScope();
  const latest = useRef(content);
  latest.current = content;
  const [element, ref] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!element || !scope) return;
    return controller.registerGetter(scope, element, (trigger) =>
      typeof latest.current === "function" ? latest.current(trigger) : latest.current);
  }, [controller, scope, element]);
  const open = useCallback((target: HTMLElement) => {
    const path: EventTarget[] = [];
    for (let node: Node | null = target; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) path.push(node);
    const rect = target.getBoundingClientRect();
    return controller.trigger(path, { source: "button", target, anchor: { x: rect.left, y: rect.bottom } });
  }, [controller]);
  return { ref, open };
}
