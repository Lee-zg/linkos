/**
 * Recovery helpers for the ADR-001 §2.4 out-of-window path: when a client's
 * `last_event_seq` has fallen behind the gateway's retention window, the server
 * sends `workspace.snapshot.required` carrying `currentEventSeq`. The client
 * adopts that sequence as its new replay cursor before resyncing state.
 */

/**
 * Derives the new replay cursor from a `workspace.snapshot.required` payload.
 * Returns the payload's `currentEventSeq` when it is a finite, non-negative
 * number (truncated to an integer); otherwise returns `fallback` so a malformed
 * frame can never move the cursor backwards or to a non-number.
 */
export function snapshotCursorFrom(payload: unknown, fallback: number): number {
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>).currentEventSeq;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return fallback;
}
