import type { ReactNode } from "react";

export interface ContextMenuAction {
  id: string;
  label: string;
  disabled?: boolean;
  restoreFocus?: boolean;
  onClick?: () => void;
}

export type ContextMenuGridCell = ContextMenuAction;

export interface ContextMenuGrid {
  layout: string;
  cells: ContextMenuGridCell[];
}

export interface ContextMenuItem extends ContextMenuAction {
  icon?: ReactNode;
  grid?: ContextMenuGrid;
}
export interface ContextMenuGroup {
  id: string;
  items: ContextMenuItem[];
}
export type ContextMenuContent = ContextMenuItem[] | ContextMenuGroup[];

export function normalizeMenuContent(content: ContextMenuContent): ContextMenuGroup[] {
  if (!content.length) return [];
  const groups = "items" in content[0]
    ? content as ContextMenuGroup[]
    : [{ id: "items", items: content as ContextMenuItem[] }];
  return groups.filter((group) => group.items.length > 0);
}

/** Shared visual/activation order; disabled actions retain their positions. */
export function flattenMenuActions(groups: ContextMenuGroup[]): ContextMenuAction[] {
  return groups.flatMap((group) => group.items.flatMap((item) => [
    item,
    ...(item.grid?.cells.map((cell) => ({
      ...cell,
      disabled: item.disabled || cell.disabled,
      restoreFocus: cell.restoreFocus ?? item.restoreFocus,
    })) ?? []),
  ]));
}

export interface MenuPosition {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export function computeMenuPosition(
  trigger: MenuPosition,
  menu: MenuSize,
  viewport: ViewportSize
): MenuPosition {
  let x = trigger.x;
  let y = trigger.y;

  if (x + menu.width > viewport.width) {
    x = Math.max(0, viewport.width - menu.width);
  }

  if (y + menu.height > viewport.height) {
    y = Math.max(0, viewport.height - menu.height);
  }

  return { x: Math.max(0, x), y: Math.max(0, y) };
}

export function isEditableElement(element: HTMLElement | null | undefined): boolean {
  if (!element) return false;

  const tagName = element.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA") {
    return true;
  }

  if (element.isContentEditable) {
    return true;
  }

  return !!element.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor');
}

export interface MenuItem {
  id: string;
  disabled?: boolean;
}

export function findEnabledMenuItem<T extends MenuItem>(
  items: T[],
  startIndex: number,
  direction: "next" | "prev"
): number {
  if (items.length === 0) return -1;

  const allDisabled = items.every((item) => item.disabled);
  if (allDisabled) return -1;

  let index = startIndex < 0 && direction === "prev" ? 0 : startIndex;
  const step = direction === "next" ? 1 : -1;

  for (let i = 0; i < items.length; i++) {
    index = (index + step + items.length) % items.length;
    if (!items[index].disabled) {
      return index;
    }
  }

  return -1;
}
