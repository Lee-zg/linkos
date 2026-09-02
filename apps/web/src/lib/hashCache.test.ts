import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashCacheKey,
  getCachedHash,
  setCachedHash,
  evictCachedHash,
  MAX_HASH_CACHE_ENTRIES,
  type HashCacheStorage,
  type FileIdentity,
} from "./hashCache.ts";

function fakeStorage(): HashCacheStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const fileA: FileIdentity = {
  name: "report.bin",
  size: 1024,
  lastModified: 1_700_000_000_000,
};

test("hashCacheKey combines name, size and lastModified", () => {
  assert.equal(hashCacheKey(fileA), "report.bin:1024:1700000000000");
});

test("getCachedHash returns null on a miss", () => {
  assert.equal(getCachedHash(fakeStorage(), fileA), null);
});

test("setCachedHash then getCachedHash round-trips the hash", () => {
  const storage = fakeStorage();
  setCachedHash(storage, fileA, "abc123");
  assert.equal(getCachedHash(storage, fileA), "abc123");
});

test("evictCachedHash removes a stored hash", () => {
  const storage = fakeStorage();
  setCachedHash(storage, fileA, "abc123");
  evictCachedHash(storage, fileA);
  assert.equal(getCachedHash(storage, fileA), null);
});

test("a changed lastModified does not return the stale hash", () => {
  const storage = fakeStorage();
  setCachedHash(storage, fileA, "abc123");
  const edited: FileIdentity = { ...fileA, lastModified: fileA.lastModified + 1000 };
  assert.equal(getCachedHash(storage, edited), null);
});

test("re-setting the same file refreshes its hash", () => {
  const storage = fakeStorage();
  setCachedHash(storage, fileA, "old");
  setCachedHash(storage, fileA, "new");
  assert.equal(getCachedHash(storage, fileA), "new");
});

test("getCachedHash tolerates storage that throws on read", () => {
  const storage: HashCacheStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.equal(getCachedHash(storage, fileA), null);
});

test("setCachedHash tolerates storage that throws on write", () => {
  const storage: HashCacheStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => setCachedHash(storage, fileA, "abc123"));
});

test("cache is bounded and evicts the oldest entry past the limit", () => {
  const storage = fakeStorage();
  const identity = (i: number): FileIdentity => ({
    name: `f${i}.bin`,
    size: i,
    lastModified: i,
  });
  for (let i = 0; i <= MAX_HASH_CACHE_ENTRIES; i++) {
    setCachedHash(storage, identity(i), `h${i}`);
  }
  assert.equal(getCachedHash(storage, identity(0)), null);
  assert.equal(
    getCachedHash(storage, identity(MAX_HASH_CACHE_ENTRIES)),
    `h${MAX_HASH_CACHE_ENTRIES}`,
  );
});
