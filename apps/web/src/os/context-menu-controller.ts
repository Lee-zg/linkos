import { normalizeMenuContent, type ContextMenuContent, type ContextMenuGroup, type MenuPosition } from "./context-menu";

export type MenuOwner =
  | { kind: "desktop" }
  | { kind: "shell"; objectId: string }
  | { kind: "app"; appId: string; windowId: string }
  | { kind: "silent" };
export interface MenuScope { readonly owner: MenuOwner; active: boolean }
export type MenuToken = symbol;
export type MenuCloseReason = "dismiss" | "close" | "activate";
export interface MenuTrigger {
  source: "pointer" | "keyboard" | "button";
  target: HTMLElement;
  anchor: MenuPosition;
}
export type MenuGetter = (trigger: MenuTrigger) => ContextMenuContent | null;
export interface MenuOpenOptions {
  anchor: MenuPosition;
  content: ContextMenuContent;
  target?: HTMLElement | null;
  onClose?: (token: MenuToken, reason: MenuCloseReason) => void;
}
export interface MenuSnapshot extends MenuOpenOptions {
  token: MenuToken;
  scope: MenuScope;
  groups: ContextMenuGroup[];
}
export function createMenuScope(owner: MenuOwner, active = true): MenuScope {
  return { owner, active };
}

type Boundary = { scope: MenuScope; element: HTMLElement };
type GetterRegistration = { scope: MenuScope; getter: MenuGetter };

/** One controller per desktop. Ownership follows physical composedPath, never React ancestry. */
export class ContextMenuController {
  private generation = 0;
  private menu: MenuSnapshot | null = null;
  private menuGetter: GetterRegistration | null = null;
  private scopes = new Map<MenuScope, Boundary>();
  private boundaries = new WeakMap<EventTarget, Boundary>();
  private getters = new WeakMap<EventTarget, GetterRegistration>();
  private listeners = new Set<() => void>();
  get epoch() { return this.generation; }
  getSnapshot = () => this.menu;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit() { this.listeners.forEach((listener) => listener()); }

  registerScope(scope: MenuScope, element: HTMLElement): () => void {
    const previous = this.scopes.get(scope);
    if (previous) {
      this.generation++;
      if (this.boundaries.get(previous.element) === previous) this.boundaries.delete(previous.element);
    }
    const registration = { scope, element };
    this.scopes.set(scope, registration);
    this.boundaries.set(element, registration);
    return () => {
      if (this.scopes.get(scope) !== registration) return;
      this.scopes.delete(scope);
      if (this.boundaries.get(element) === registration) this.boundaries.delete(element);
      if (this.menu?.scope === scope) this.dismiss(this.menu.token);
      else this.generation++;
    };
  }
  registerGetter(scope: MenuScope, element: HTMLElement, getter: MenuGetter): () => void {
    const registration = { scope, getter };
    this.getters.set(element, registration);
    return () => {
      if (this.getters.get(element) === registration) this.getters.delete(element);
      if (this.menuGetter === registration) this.dismiss();
    };
  }
  setScopeActive(scope: MenuScope, active: boolean) {
    const changed = scope.active !== active;
    scope.active = active;
    if (!active) {
      if (this.menu?.scope === scope) this.dismiss(this.menu.token);
      else if (changed) this.generation++;
    }
  }
  isScopeActive(scope: MenuScope) {
    const registration = this.scopes.get(scope);
    return !!(scope.active && registration?.element.isConnected && this.boundaries.get(registration.element) === registration);
  }
  trigger(path: EventTarget[], trigger: MenuTrigger): MenuToken | null {
    this.dismiss();
    const epoch = this.epoch;
    const boundaryIndex = path.findIndex((node) => this.boundaries.has(node));
    if (boundaryIndex < 0) return null;
    const { scope } = this.boundaries.get(path[boundaryIndex])!;
    if (!this.isScopeActive(scope) || scope.owner.kind === "silent") return null;
    for (const node of path.slice(0, boundaryIndex + 1)) {
      const registration = this.getters.get(node);
      if (!registration || registration.scope !== scope) continue;
      const content = registration.getter(trigger);
      // An empty provider owns this gesture too; never continue to another provider.
      if (!content || epoch !== this.epoch || this.getters.get(node) !== registration) return null;
      const target = trigger.target.closest?.<HTMLElement>("button, input, textarea, select, a[href], [tabindex], [contenteditable]") ?? trigger.target;
      return this.show(scope, { anchor: trigger.anchor, content, target }, registration);
    }
    return null;
  }
  open(scope: MenuScope, options: MenuOpenOptions): MenuToken | null {
    return this.show(scope, options, null);
  }
  private show(scope: MenuScope, options: MenuOpenOptions, getter: GetterRegistration | null): MenuToken | null {
    if (!this.isScopeActive(scope) || scope.owner.kind === "silent") return null;
    const epoch = this.epoch + 1;
    this.dismiss();
    const groups = normalizeMenuContent(options.content);
    if (!groups.length || epoch !== this.epoch || !this.isScopeActive(scope)) return null;
    const token = Symbol("context-menu");
    this.menu = { ...options, anchor: { ...options.anchor }, scope, token, groups };
    this.menuGetter = getter;
    this.emit();
    return token;
  }
  private finish(token: MenuToken | undefined, reason: MenuCloseReason, restoreFocus: boolean) {
    if (token !== undefined && this.menu?.token !== token) return;
    this.generation++;
    const menu = this.menu;
    this.menu = null;
    this.menuGetter = null;
    if (!menu) return;
    this.emit();
    // Restore before callbacks: callbacks may intentionally move focus or open another menu.
    if (restoreFocus && menu.target?.isConnected && this.isScopeActive(menu.scope)) menu.target.focus({ preventScroll: true });
    menu.onClose?.(menu.token, reason);
  }
  dismiss(token?: MenuToken, reason: MenuCloseReason = "dismiss") { this.finish(token, reason, false); }
  close(token?: MenuToken) { this.finish(token, "close", true); }
  activate(token: MenuToken, index: number) {
    const menu = this.menu;
    if (!menu || menu.token !== token) return;
    if (!this.isScopeActive(menu.scope)) { this.dismiss(token); return; }
    const item = menu.groups.flatMap((group) => group.items)[index];
    if (!item || item.disabled) return;
    this.finish(token, "activate", item.restoreFocus !== false);
    item.onClick?.();
  }
}

/** The only native context-menu/key entry point. Editable content is not exempt. */
export function bindContextMenuEvents(controller: ContextMenuController, doc: Document): () => void {
  const view = doc.defaultView;
  let menuKeyTime = -Infinity;
  const inOverlay = (path: EventTarget[]) => path.some((node) =>
    (node as HTMLElement).hasAttribute?.("data-context-menu-overlay"));
  const targetIn = (path: EventTarget[]) => path.find((node) =>
    "offsetWidth" in node && typeof (node as HTMLElement).getBoundingClientRect === "function") as HTMLElement | undefined;
  const contextmenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const path = event.composedPath();
    if (inOverlay(path)) return;
    // A real pointer gesture resets this latch on pointerdown, independent of button encoding.
    if (event.timeStamp - menuKeyTime < 1000) return;
    const target = targetIn(path);
    if (target) controller.trigger(path, { source: "pointer", target, anchor: { x: event.clientX, y: event.clientY } });
    else controller.dismiss();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape" || event.key === "Tab") {
      // Pending opens have no overlay to handle dismissal; leave the application's key alone.
      if (!controller.getSnapshot()) controller.dismiss();
      return;
    }
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    menuKeyTime = event.timeStamp;
    const path = event.composedPath();
    if (event.repeat || inOverlay(path)) return;
    const target = targetIn(path);
    if (!target) { controller.dismiss(); return; }
    const rect = target.getBoundingClientRect();
    controller.trigger(path, { source: "keyboard", target, anchor: { x: rect.left, y: rect.bottom } });
  };
  const pointerdown = (event: Event) => {
    menuKeyTime = -Infinity;
    if (!inOverlay(event.composedPath())) controller.dismiss();
  };
  const scroll = (event: Event) => {
    if (!inOverlay(event.composedPath())) controller.dismiss();
  };
  const invalidate = () => controller.dismiss();
  doc.addEventListener("contextmenu", contextmenu, { capture: true });
  doc.addEventListener("keydown", keydown, { capture: true });
  doc.addEventListener("pointerdown", pointerdown, { capture: true });
  doc.addEventListener("scroll", scroll, { capture: true });
  view?.addEventListener("resize", invalidate);
  view?.addEventListener("blur", invalidate);
  return () => {
    doc.removeEventListener("contextmenu", contextmenu, { capture: true });
    doc.removeEventListener("keydown", keydown, { capture: true });
    doc.removeEventListener("pointerdown", pointerdown, { capture: true });
    doc.removeEventListener("scroll", scroll, { capture: true });
    view?.removeEventListener("resize", invalidate);
    view?.removeEventListener("blur", invalidate);
  };
}
