/**
 * dock-interaction.ts – Edge show/hide state machine pure functions
 *
 * States: edge → revealing → shown → hiding → edge
 *
 * Timing (host-approximate, not Apple-official):
 *   - Edge trigger zone: 2 CSS px
 *   - Reveal delay: 120 ms
 *   - Hide delay: 180 ms
 *   - Show/hide animation: 220 ms
 *
 * Pause conditions (prevent hiding):
 *   - Pointer moving toward Dock
 *   - Keyboard focus-within
 *   - Context menu open
 *   - Drag reorder in progress
 *
 * Clear conditions:
 *   - blur / cancel → edge immediately
 *   - Fullscreen + autoHide → edge
 */

export type DockInteractionState = "edge" | "revealing" | "shown" | "hiding";

export type DockInteractionEvent =
  | "EDGE_ENTER"
  | "EDGE_LEAVE"
  | "BLUR"
  | "CANCEL"
  | "DRAG_START"
  | "DRAG_END"
  | "CONTEXT_MENU_OPEN"
  | "CONTEXT_MENU_CLOSE"
  | "FOCUS_WITHIN"
  | "FOCUS_LOST"
  | "POINTER_TOWARD_DOCK"
  | "FULLSCREEN_EXIT"
  | { type: "REVEAL_COMPLETE"; elapsed: number }
  | { type: "HIDE_COMPLETE"; elapsed: number }
  | { type: "FULLSCREEN_ENTER"; autoHide: boolean };

export type DockInteractionTimers = {
  revealDelayMs: number;
  hideDelayMs: number;
  animationMs: number;
};

const REVEAL_DELAY_MS = 120;
const HIDE_DELAY_MS = 180;
const ANIMATION_MS = 220;

export type DockInteractionMachine = {
  transition(
    state: DockInteractionState,
    event: DockInteractionEvent,
  ): DockInteractionState;
  getTimers(state: DockInteractionState): DockInteractionTimers;
};

export function createDockInteractionMachine(): DockInteractionMachine {
  let paused = false;
  let focused = false;
  let fullscreen = false;

  function transition(
    state: DockInteractionState,
    event: DockInteractionEvent,
  ): DockInteractionState {
    // ── Global resets ──────────────────────────────────────────────────
    if (event === "BLUR") {
      paused = false;
      focused = false;
      fullscreen = false;
      return "edge";
    }
    if (event === "CANCEL") {
      paused = false;
      focused = false;
      return "edge";
    }

    // ── Fullscreen ─────────────────────────────────────────────────────
    if (typeof event === "object" && event.type === "FULLSCREEN_ENTER") {
      fullscreen = true;
      if (event.autoHide) {
        paused = false;
        focused = false;
        return "edge";
      }
      return state;
    }
    if (event === "FULLSCREEN_EXIT") {
      fullscreen = false;
      return state;
    }

    // ── Pause/resume guards ────────────────────────────────────────────
    if (event === "DRAG_START") {
      paused = true;
      return state === "hiding" ? "shown" : state;
    }
    if (event === "DRAG_END") {
      paused = false;
      return state;
    }
    if (event === "CONTEXT_MENU_OPEN") {
      paused = true;
      return "shown";
    }
    if (event === "CONTEXT_MENU_CLOSE") {
      paused = false;
      return state;
    }
    if (event === "FOCUS_WITHIN") {
      focused = true;
      return "shown";
    }
    if (event === "FOCUS_LOST") {
      focused = false;
      return state;
    }

    // ── Pointer toward dock cancels hide ───────────────────────────────
    if (event === "POINTER_TOWARD_DOCK") {
      if (state === "hiding") return "shown";
      return state;
    }

    // ── Edge enter ─────────────────────────────────────────────────────
    if (event === "EDGE_ENTER") {
      if (fullscreen) return state;
      return "revealing";
    }

    // ── Edge leave ─────────────────────────────────────────────────────
    if (event === "EDGE_LEAVE") {
      if (paused || focused) return state;
      if (state === "revealing") return "edge";
      if (state === "shown") return "hiding";
      return state;
    }

    // ── Reveal complete ────────────────────────────────────────────────
    if (typeof event === "object" && event.type === "REVEAL_COMPLETE") {
      if (state === "revealing" && event.elapsed >= REVEAL_DELAY_MS) {
        return "shown";
      }
      return state;
    }

    // ── Hide complete ──────────────────────────────────────────────────
    if (typeof event === "object" && event.type === "HIDE_COMPLETE") {
      if (state === "hiding" && event.elapsed >= ANIMATION_MS) {
        return "edge";
      }
      return state;
    }

    return state;
  }

  function getTimers(state: DockInteractionState): DockInteractionTimers {
    switch (state) {
      case "revealing":
        return {
          revealDelayMs: REVEAL_DELAY_MS,
          hideDelayMs: 0,
          animationMs: ANIMATION_MS,
        };
      case "hiding":
        return {
          revealDelayMs: 0,
          hideDelayMs: HIDE_DELAY_MS,
          animationMs: ANIMATION_MS,
        };
      default:
        return { revealDelayMs: 0, hideDelayMs: 0, animationMs: ANIMATION_MS };
    }
  }

  return { transition, getTimers };
}
