import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDockInteractionMachine,
  type DockInteractionEvent,
  type DockInteractionState,
} from "./dock-interaction";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function runEvents(
  events: DockInteractionEvent[],
  initial: DockInteractionState = "edge",
) {
  const machine = createDockInteractionMachine();
  let state = initial;
  for (const event of events) {
    state = machine.transition(state, event);
  }
  return state;
}

/* ─── state machine transitions ───────────────────────────────────────────── */

test("edge → revealing on EDGE_ENTER", () => {
  assert.equal(runEvents(["EDGE_ENTER"]), "revealing");
});

test("revealing → shown after REVEAL_COMPLETE (120ms elapsed)", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  assert.equal(state, "revealing");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  assert.equal(state, "shown");
});

test("revealing → edge on EDGE_LEAVE before reveal completes", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  assert.equal(state, "revealing");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 60 });
  // 60ms < 120ms threshold, should stay revealing
  assert.equal(state, "revealing");
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "edge");
});

test("shown → hiding on EDGE_LEAVE (180ms delay)", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  assert.equal(state, "shown");
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
});

test("hiding → edge after HIDE_COMPLETE (220ms elapsed)", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
  state = machine.transition(state, { type: "HIDE_COMPLETE", elapsed: 220 });
  assert.equal(state, "edge");
});

test("hiding → shown on POINTER_TOWARD_DOCK (pause hide)", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
  state = machine.transition(state, "POINTER_TOWARD_DOCK");
  assert.equal(state, "shown");
});

test("hiding → edge on HIDE_COMPLETE before full elapsed", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "EDGE_LEAVE");
  state = machine.transition(state, { type: "HIDE_COMPLETE", elapsed: 100 });
  // 100ms < 220ms threshold, should stay hiding
  assert.equal(state, "hiding");
});

/* ─── blur / cancel clear timers ──────────────────────────────────────────── */

test("BLUR from revealing returns to edge", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  assert.equal(state, "revealing");
  state = machine.transition(state, "BLUR");
  assert.equal(state, "edge");
});

test("BLUR from hiding snaps to edge immediately", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
  state = machine.transition(state, "BLUR");
  assert.equal(state, "edge");
});

test("CANCEL from shown returns to edge", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  assert.equal(state, "shown");
  state = machine.transition(state, "CANCEL");
  assert.equal(state, "edge");
});

test("CANCEL from revealing returns to edge", () => {
  assert.equal(runEvents(["EDGE_ENTER", "CANCEL"]), "edge");
});

/* ─── fullscreen + autoHide ───────────────────────────────────────────────── */

test("FULLSCREEN_ENTER with autoHide forces edge state", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  assert.equal(state, "shown");
  state = machine.transition(state, {
    type: "FULLSCREEN_ENTER",
    autoHide: true,
  });
  assert.equal(state, "edge");
});

test("FULLSCREEN_ENTER without autoHide keeps shown state", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  assert.equal(state, "shown");
  state = machine.transition(state, {
    type: "FULLSCREEN_ENTER",
    autoHide: false,
  });
  assert.equal(state, "shown");
});

test("FULLSCREEN_EXIT restores normal behavior", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, {
    type: "FULLSCREEN_ENTER",
    autoHide: true,
  });
  assert.equal(state, "edge");
  state = machine.transition(state, "FULLSCREEN_EXIT");
  // After exiting fullscreen, state should be edge (default)
  assert.equal(state, "edge");
  // But now EDGE_ENTER should work normally
  state = machine.transition(state, "EDGE_ENTER");
  assert.equal(state, "revealing");
});

/* ─── pause / resume during drag and context menu ─────────────────────────── */

test("DRAG_START from shown pauses hide transitions", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "DRAG_START");
  assert.equal(state, "shown");
  // EDGE_LEAVE during drag should not start hiding
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "shown");
});

test("DRAG_END from shown allows normal transitions again", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "DRAG_START");
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "shown");
  state = machine.transition(state, "DRAG_END");
  // Now EDGE_LEAVE should trigger hiding
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
});

test("CONTEXT_MENU_OPEN from shown keeps state shown", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "CONTEXT_MENU_OPEN");
  assert.equal(state, "shown");
  // EDGE_LEAVE during context menu should not start hiding
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "shown");
});

test("CONTEXT_MENU_CLOSE allows normal transitions", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "CONTEXT_MENU_OPEN");
  state = machine.transition(state, "CONTEXT_MENU_CLOSE");
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
});

test("FOCUS_WITHIN from shown keeps state", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "FOCUS_WITHIN");
  assert.equal(state, "shown");
  state = machine.transition(state, "EDGE_LEAVE");
  // Focus within should prevent hiding
  assert.equal(state, "shown");
});

test("FOCUS_LOST allows hiding", () => {
  const machine = createDockInteractionMachine();
  let state: DockInteractionState = "edge";
  state = machine.transition(state, "EDGE_ENTER");
  state = machine.transition(state, { type: "REVEAL_COMPLETE", elapsed: 120 });
  state = machine.transition(state, "FOCUS_WITHIN");
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "shown");
  state = machine.transition(state, "FOCUS_LOST");
  // Now we should transition to hiding on next EDGE_LEAVE
  state = machine.transition(state, "EDGE_LEAVE");
  assert.equal(state, "hiding");
});

/* ─── getTimers ───────────────────────────────────────────────────────────── */

test("getTimers returns reveal delay for revealing state", () => {
  const machine = createDockInteractionMachine();
  const timers = machine.getTimers("revealing");
  assert.equal(timers.revealDelayMs, 120);
  assert.equal(timers.hideDelayMs, 0);
  assert.equal(timers.animationMs, 220);
});

test("getTimers returns hide delay for hiding state", () => {
  const machine = createDockInteractionMachine();
  const timers = machine.getTimers("hiding");
  assert.equal(timers.revealDelayMs, 0);
  assert.equal(timers.hideDelayMs, 180);
  assert.equal(timers.animationMs, 220);
});

test("getTimers returns zero for edge and shown states", () => {
  const machine = createDockInteractionMachine();
  const edgeTimers = machine.getTimers("edge");
  assert.equal(edgeTimers.revealDelayMs, 0);
  assert.equal(edgeTimers.hideDelayMs, 0);
  const shownTimers = machine.getTimers("shown");
  assert.equal(shownTimers.revealDelayMs, 0);
  assert.equal(shownTimers.hideDelayMs, 0);
});
