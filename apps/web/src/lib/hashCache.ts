export interface HashCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FileIdentity {
  name: string;
  size: number;
  lastModified: number;
}

export const MAX_HASH_CACHE_ENTRIES = 200;

const HASH_CACHE_KEY = "linkos.file-hash-cache";

/**
 * Identity used to reuse a previously computed whole-file SHA-256. A content
 * change that rewrites the file bumps `lastModified`, so a stale hash is not
 * returned for edited files (risk R-06).
 */
export function hashCacheKey(file: FileIdentity): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function readCache(storage: HashCacheStorage): Record<string, string> {
  try {
    const raw = storage.getItem(HASH_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeCache(
  storage: HashCacheStorage,
  cache: Record<string, string>,
): void {
  try {
    storage.setItem(HASH_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable (private mode / quota) — the cache is best-effort.
  }
}

export function getCachedHash(
  storage: HashCacheStorage,
  file: FileIdentity,
): string | null {
  return readCache(storage)[hashCacheKey(file)] ?? null;
}

export function setCachedHash(
  storage: HashCacheStorage,
  file: FileIdentity,
  hash: string,
): void {
  const cache = readCache(storage);
  const key = hashCacheKey(file);
  // Re-insert so the freshly used entry sits at the newest position.
  delete cache[key];
  cache[key] = hash;
  const keys = Object.keys(cache);
  while (keys.length > MAX_HASH_CACHE_ENTRIES) {
    const oldest = keys.shift();
    if (oldest === undefined) break;
    delete cache[oldest];
  }
  writeCache(storage, cache);
}

export function evictCachedHash(
  storage: HashCacheStorage,
  file: FileIdentity,
): void {
  const cache = readCache(storage);
  delete cache[hashCacheKey(file)];
  writeCache(storage, cache);
}
