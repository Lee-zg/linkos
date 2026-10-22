/** Pure focus/key decisions for window-owned and standalone modals. */
export type ModalSurface = { visible: boolean; active: boolean } | null;
export type ModalKeyAction = "close" | "consume" | "wrap-first" | "wrap-last" | null;
export type SelectionSnapshot = { start: number; end: number; direction: "forward" | "backward" | "none" };

type SelectionTarget = {
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: "forward" | "backward" | "none" | null;
  setSelectionRange?: (start: number, end: number, direction?: "forward" | "backward" | "none") => void;
};

/** Without a WindowSurface the modal keeps its panel behaviour; inside one it only traps while visible and active. */
export function shouldTrapModal(surface: ModalSurface): boolean {
  return !surface || (surface.visible && surface.active);
}

/** First activation focuses/selects once; later ones restore the remembered element and selection. */
export function modalActivation(trap: boolean, initialized: boolean): "initial" | "restore" | null {
  if (!trap) return null;
  return initialized ? "restore" : "initial";
}

export function modalKeyAction(
  event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number },
  ctx: { trap: boolean; panelHasFocus: boolean; busy: boolean; atFirst: boolean; atLast: boolean },
): ModalKeyAction {
  if (!ctx.trap || !ctx.panelHasFocus) return null;
  if (event.key === "Escape") {
    if (event.isComposing || event.keyCode === 229) return null;
    return ctx.busy ? "consume" : "close";
  }
  if (event.key === "Tab") {
    if (event.shiftKey) return ctx.atFirst ? "wrap-last" : null;
    return ctx.atLast ? "wrap-first" : null;
  }
  return null;
}

/** Only focus moving into the owner's own (inert-free) app content is pulled back. */
export function shouldReclaimFocus(input: {
  trap: boolean; ownerScoped: boolean; targetInPanel: boolean; targetInOwnerApp: boolean;
}): boolean {
  return input.trap && input.ownerScoped && !input.targetInPanel && input.targetInOwnerApp;
}

/** Leaving a Space/minimizing must not drag focus back to where the modal was opened. */
export function shouldRestorePreviousFocus(input: { trap: boolean; activeInPanel: boolean; activeIsBody: boolean }): boolean {
  return input.trap && (input.activeInPanel || input.activeIsBody);
}

export function captureSelection(element: object): SelectionSnapshot | null {
  const el = element as SelectionTarget;
  if (typeof el.selectionStart !== "number" || typeof el.selectionEnd !== "number") return null;
  return { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection ?? "none" };
}

export function restoreSelection(element: object, snapshot: SelectionSnapshot | null): void {
  const el = element as SelectionTarget;
  if (!snapshot || typeof el.setSelectionRange !== "function") return;
  el.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
}
