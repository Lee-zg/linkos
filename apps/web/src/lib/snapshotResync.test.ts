import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotCursorFrom } from "./snapshotResync.ts";

test("returns currentEventSeq when it is a finite non-negative number", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: 1002 }, 7), 1002);
});

test("accepts cursor 0 as valid", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: 0 }, 7), 0);
});

test("truncates a fractional currentEventSeq", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: 12.9 }, 0), 12);
});

test("ignores unrelated payload fields", () => {
  assert.equal(
    snapshotCursorFrom({ lastEventSeq: 3, currentEventSeq: 50 }, 0),
    50,
  );
});

test("falls back when payload is missing", () => {
  assert.equal(snapshotCursorFrom(undefined, 42), 42);
});

test("falls back when payload is not an object", () => {
  assert.equal(snapshotCursorFrom("nope", 42), 42);
  assert.equal(snapshotCursorFrom(123, 42), 42);
  assert.equal(snapshotCursorFrom(null, 42), 42);
});

test("falls back when currentEventSeq is absent", () => {
  assert.equal(snapshotCursorFrom({ lastEventSeq: 3 }, 42), 42);
});

test("falls back when currentEventSeq is a string", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: "1002" }, 42), 42);
});

test("falls back when currentEventSeq is negative", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: -1 }, 42), 42);
});

test("falls back when currentEventSeq is NaN or Infinity", () => {
  assert.equal(snapshotCursorFrom({ currentEventSeq: Number.NaN }, 42), 42);
  assert.equal(snapshotCursorFrom({ currentEventSeq: Infinity }, 42), 42);
  assert.equal(snapshotCursorFrom({ currentEventSeq: -Infinity }, 42), 42);
});
