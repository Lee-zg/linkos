import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureSelection,
  modalActivation,
  modalKeyAction,
  restoreSelection,
  shouldReclaimFocus,
  shouldRestorePreviousFocus,
  shouldTrapModal,
} from "./modal-focus";

test("a window-owned modal traps only while its surface is visible and active", () => {
  assert.equal(shouldTrapModal({ visible: true, active: true }), true);
  assert.equal(shouldTrapModal({ visible: true, active: false }), false);
  assert.equal(shouldTrapModal({ visible: false, active: true }), false);
  assert.equal(shouldTrapModal({ visible: false, active: false }), false);
  // A standalone Modal without a WindowSurface keeps its own panel behaviour.
  assert.equal(shouldTrapModal(null), true);
});

test("initial focus runs once, later activations restore instead of reselecting", () => {
  assert.equal(modalActivation(false, false), null);
  assert.equal(modalActivation(true, false), "initial");
  assert.equal(modalActivation(true, true), "restore");
  assert.equal(modalActivation(false, true), null);
});

const key = (k: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean; keyCode: number }> = {}) => ({
  key: k, shiftKey: false, isComposing: false, keyCode: 0, ...extra,
});
const ctx = (extra: Partial<{ trap: boolean; panelHasFocus: boolean; busy: boolean; atFirst: boolean; atLast: boolean }> = {}) => ({
  trap: true, panelHasFocus: true, busy: false, atFirst: false, atLast: false, ...extra,
});

test("Escape closes only when the panel owns focus and no composition is active", () => {
  assert.equal(modalKeyAction(key("Escape"), ctx()), "close");
  assert.equal(modalKeyAction(key("Escape"), ctx({ busy: true })), "consume");
  assert.equal(modalKeyAction(key("Escape"), ctx({ panelHasFocus: false })), null);
  assert.equal(modalKeyAction(key("Escape"), ctx({ trap: false })), null);
  assert.equal(modalKeyAction(key("Escape", { isComposing: true }), ctx()), null);
  assert.equal(modalKeyAction(key("Escape", { keyCode: 229 }), ctx()), null);
});

test("Tab wraps only at the panel edges while the panel owns focus", () => {
  assert.equal(modalKeyAction(key("Tab"), ctx({ atLast: true })), "wrap-first");
  assert.equal(modalKeyAction(key("Tab", { shiftKey: true }), ctx({ atFirst: true })), "wrap-last");
  assert.equal(modalKeyAction(key("Tab"), ctx({ atFirst: true })), null);
  assert.equal(modalKeyAction(key("Tab", { shiftKey: true }), ctx({ atLast: true })), null);
  assert.equal(modalKeyAction(key("Tab"), ctx({ atLast: true, panelHasFocus: false })), null);
  assert.equal(modalKeyAction(key("Tab"), ctx({ atLast: true, trap: false })), null);
  assert.equal(modalKeyAction(key("Enter"), ctx({ atLast: true })), null);
});

test("focus is reclaimed only from the owner's own app content", () => {
  const base = { trap: true, ownerScoped: true, targetInPanel: false, targetInOwnerApp: true };
  assert.equal(shouldReclaimFocus(base), true);
  assert.equal(shouldReclaimFocus({ ...base, targetInPanel: true }), false);
  // Host Dock, title bar, global menus and other windows stay focusable.
  assert.equal(shouldReclaimFocus({ ...base, targetInOwnerApp: false }), false);
  assert.equal(shouldReclaimFocus({ ...base, trap: false }), false);
  // The body fallback never pulls focus back from the rest of the page.
  assert.equal(shouldReclaimFocus({ ...base, ownerScoped: false }), false);
});

test("the previous external focus is restored only by an active unmount", () => {
  assert.equal(shouldRestorePreviousFocus({ trap: true, activeInPanel: true, activeIsBody: false }), true);
  assert.equal(shouldRestorePreviousFocus({ trap: true, activeInPanel: false, activeIsBody: true }), true);
  assert.equal(shouldRestorePreviousFocus({ trap: true, activeInPanel: false, activeIsBody: false }), false);
  assert.equal(shouldRestorePreviousFocus({ trap: false, activeInPanel: true, activeIsBody: false }), false);
  assert.equal(shouldRestorePreviousFocus({ trap: false, activeInPanel: false, activeIsBody: true }), false);
});

test("a text selection snapshot keeps range and direction", () => {
  const input = {
    selectionStart: 1 as number | null, selectionEnd: 4 as number | null,
    selectionDirection: "backward" as "forward" | "backward" | "none" | null,
    calls: [] as unknown[][],
    setSelectionRange(start: number, end: number, direction?: "forward" | "backward" | "none") {
      this.calls.push([start, end, direction]);
    },
  };
  const snapshot = captureSelection(input);
  assert.deepEqual(snapshot, { start: 1, end: 4, direction: "backward" });
  restoreSelection(input, snapshot);
  assert.deepEqual(input.calls, [[1, 4, "backward"]]);
  assert.equal(captureSelection({}), null);
  assert.equal(captureSelection({ ...input, selectionStart: null }), null);
  restoreSelection(input, null);
  assert.equal(input.calls.length, 1);
});
