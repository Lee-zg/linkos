import type {
  ResourceRecord,
  UploadCompleteResult,
  UploadSession,
} from "@linkos/protocol";
import { sha256 } from "js-sha256";
import { ApiError, apiURL, getSessionToken } from "./api";
import { evictCachedHash, getCachedHash, setCachedHash } from "./hashCache";
import { loadProfile } from "./session";
import { readDraft, writeDraft, removeDraft } from "./draft-storage";

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const CONCURRENCY = 4;
const PART_RETRIES = 2;
const SESSION_INDEX_KEY = "linkos.upload-sessions";
const RECORDS_KEY = "linkos.uploaded-files";
const hashStorage = {
  getItem: (key: string) => readDraft(key),
  setItem: (key: string, value: string) => writeDraft(key, value),
  removeItem: (key: string) => removeDraft(key),
};

export interface UploadProgress {
  phase: "hashing" | "uploading" | "finalizing";
  hashedBytes: number;
  sentParts: number;
  totalParts: number;
  sentBytes: number;
  totalBytes: number;
}

export interface UploadScope {
  readonly gatewayBase: string;
  readonly workspaceId: string;
  readonly userId: string;
}

/** History can include unscoped legacy CAS records without a directory entry. */
export interface UploadedFileRecord {
  name: string;
  size: number;
  mimeType: string;
  entryId?: string;
  resourceId: string;
  contentHash?: string;
  uploadedAt: string;
  scope?: UploadScope;
  legacy?: boolean;
}

export interface UploadedEntryRecord extends UploadedFileRecord {
  entryId: string;
  scope: UploadScope;
}

function currentScope(): UploadScope {
  const profile = loadProfile();
  return Object.freeze({
    gatewayBase: apiURL("") || window.location.origin,
    workspaceId: profile?.workspaceId ?? "unknown",
    userId: profile?.userId ?? "anonymous",
  });
}

function sameScope(a: UploadScope | undefined, b: UploadScope): boolean {
  return (
    a?.gatewayBase === b.gatewayBase &&
    a.workspaceId === b.workspaceId &&
    a.userId === b.userId
  );
}

function readUploadedFiles(): UploadedFileRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    return raw ? (JSON.parse(raw) as UploadedFileRecord[]) : [];
  } catch {
    return [];
  }
}

/** Legacy rows remain visible, explicitly marked; scoped rows never cross users. */
export function loadUploadedFiles(): UploadedFileRecord[] {
  const scope = currentScope();
  return readUploadedFiles()
    .filter((item) => !item.scope || sameScope(item.scope, scope))
    .map((item) => ({ ...item, legacy: !item.scope || !item.entryId }));
}

export function rememberUploadedFile(
  record: UploadedFileRecord & { entryId: string },
) {
  const scope = record.scope ?? currentScope();
  const records = readUploadedFiles().filter(
    (item) => !sameScope(item.scope, scope) || item.entryId !== record.entryId,
  );
  records.unshift({ ...record, scope });
  let scopedCount = 0;
  // Bound only this scope, without destroying other users' or legacy history.
  const retained = records.filter(
    (item) => !sameScope(item.scope, scope) || ++scopedCount <= 100,
  );
  localStorage.setItem(RECORDS_KEY, JSON.stringify(retained));
}

function loadSessionIndex(): Record<string, string> {
  try {
    const raw = readDraft(SESSION_INDEX_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveSessionIndex(index: Record<string, string>) {
  writeDraft(SESSION_INDEX_KEY, JSON.stringify(index));
}

function rememberSession(key: string, uploadId: string) {
  saveSessionIndex({ ...loadSessionIndex(), [key]: uploadId });
}

function forgetSession(key: string, uploadId: string) {
  const index = loadSessionIndex();
  // A simultaneous operation may have installed a newer session for this key.
  if (index[key] !== uploadId) return;
  delete index[key];
  saveSessionIndex(index);
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  if (!token) {
    throw new ApiError(401, "会话不存在，请重新进入工作区");
  }
  return { authorization: `Bearer ${token}` };
}

async function parseError(response: Response): Promise<ApiError> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: string; message?: string } | undefined;
  return new ApiError(
    response.status,
    payload?.message ?? payload?.error ?? `请求失败（${response.status}）`,
    payload?.error,
  );
}

function sha256Hex(data: ArrayBuffer): string {
  return sha256.hex(data);
}

/**
 * Streams the file through an incremental SHA-256 so memory stays bounded
 * by windowSize instead of the file size (risk R-04).
 */
async function streamFileHash(
  file: File,
  size: number,
  windowSize: number,
  onProgress: (hashedBytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hasher = sha256.create();
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const window = await file.slice(offset, offset + windowSize).arrayBuffer();
    hasher.update(window);
    offset += window.byteLength;
    onProgress(offset);
  }
  return hasher.hex();
}

interface UploadContext {
  readonly signal?: AbortSignal;
  readonly scope: UploadScope;
  readonly headers: Record<string, string>;
  readonly parentId: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly mimeType: string;
}

async function fetchJson<T>(
  context: UploadContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${context.scope.gatewayBase}${path}`, {
    signal: context.signal,
    ...init,
    headers: { ...context.headers, ...init?.headers },
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

/**
 * Uploads a file through the chunked protocol with 4-way concurrency and
 * resume support. The full-file SHA-256 is reused from a (name, size,
 * lastModified) cache when present, so resuming a large file starts in about a
 * second instead of paying the full re-hash cost (risk R-06); on a cache miss
 * it is computed by streaming the file through an incremental hasher and then
 * cached. Each part is re-read from the file on demand, so memory usage stays
 * bounded by the chunk size regardless of the file size (risk R-04).
 *
 * A cached hash can be stale if the content changed without bumping
 * `lastModified`; the server rejects the mismatched hash at completion, so we
 * evict the entry, recompute from the real bytes, and retry once.
 *
 * The resume index is isolated per gateway/workspace/user/directory to avoid
 * cross-contamination between different contexts or users.
 */
export async function uploadFile(
  file: File,
  parentId: string,
  onProgress: (progress: UploadProgress) => void,
  chunkSize = DEFAULT_CHUNK_SIZE,
  signal?: AbortSignal,
): Promise<UploadedEntryRecord> {
  signal?.throwIfAborted();
  // Capture even before the first progress callback or hash await. All requests
  // (including a stale-cache retry) keep this gateway, credential and identity.
  const context: UploadContext = Object.freeze({
    signal,
    scope: currentScope(),
    headers: authHeaders(),
    parentId,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: file.type || "application/octet-stream",
  });
  const reportHashing = (hashedBytes: number) =>
    onProgress({
      phase: "hashing",
      hashedBytes,
      sentParts: 0,
      totalParts: 0,
      sentBytes: 0,
      totalBytes: context.size,
    });

  const cached = getCachedHash(hashStorage, context);
  let contentHash: string;
  if (cached !== null) {
    contentHash = cached;
    reportHashing(context.size);
  } else {
    reportHashing(0);
    contentHash = await streamFileHash(
      file,
      context.size,
      chunkSize,
      reportHashing,
      signal,
    );
    setCachedHash(hashStorage, context, contentHash);
  }

  try {
    return await runUpload(file, context, contentHash, onProgress, chunkSize);
  } catch (error) {
    if (cached === null || !isHashMismatch(error)) throw error;
    evictCachedHash(hashStorage, context);
    reportHashing(0);
    contentHash = await streamFileHash(
      file,
      context.size,
      chunkSize,
      reportHashing,
      signal,
    );
    setCachedHash(hashStorage, context, contentHash);
    return await runUpload(file, context, contentHash, onProgress, chunkSize);
  }
}

function isHashMismatch(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.code === "UPLOAD_PART_INVALID"
  );
}

async function runUpload(
  file: File,
  context: UploadContext,
  contentHash: string,
  onProgress: (progress: UploadProgress) => void,
  requestedChunkSize: number,
): Promise<UploadedEntryRecord> {
  const { scope, parentId, name, size, mimeType } = context;
  // Tuple encoding avoids delimiter collisions in names and context IDs.
  const resumeKey = JSON.stringify([
    scope.gatewayBase,
    scope.workspaceId,
    scope.userId,
    parentId,
    name,
    size,
    contentHash,
  ]);
  let session = await tryResume(context, loadSessionIndex()[resumeKey]);

  if (!session) {
    session = await fetchJson<UploadSession>(context, "/api/v1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        size,
        mimeType,
        contentHash,
        chunkSize: requestedChunkSize,
        parentId,
      }),
    });
    rememberSession(resumeKey, session.id);
  }

  const { chunkSize, totalParts } = session;
  // If completion's response was lost, verify the entry still exists and use
  // its current name. A missing/deleted entry must never start another upload.
  if (session.status === "completed") {
    const entryId = requireEntryId(session.entryId);
    const entry = await completedEntry(context, entryId);
    onProgress({
      phase: "finalizing",
      hashedBytes: size,
      sentParts: totalParts,
      totalParts,
      sentBytes: size,
      totalBytes: size,
    });
    forgetSession(resumeKey, session.id);
    return {
      name: entry.name,
      size,
      mimeType,
      entryId,
      resourceId: session.resourceId ?? "",
      uploadedAt: new Date().toISOString(),
      scope,
    };
  }

  const received = new Set(session.receivedParts);
  let sentParts = received.size;
  let sentBytes = 0;
  for (const partNo of received) {
    sentBytes += partSize(size, chunkSize, totalParts, partNo);
  }
  const report = () =>
    onProgress({
      phase: "uploading",
      hashedBytes: size,
      sentParts,
      totalParts,
      sentBytes,
      totalBytes: size,
    });
  report();

  const pending: number[] = [];
  for (let partNo = 0; partNo < totalParts; partNo++) {
    if (!received.has(partNo)) pending.push(partNo);
  }
  await runPool(pending, async (partNo) => {
    context.signal?.throwIfAborted();
    const bytes = partSize(size, chunkSize, totalParts, partNo);
    const chunk = await file
      .slice(partNo * chunkSize, partNo * chunkSize + bytes)
      .arrayBuffer();
    const partHash = sha256Hex(chunk);
    await sendPart(context, session.id, partNo, chunk, partHash);
    sentParts += 1;
    sentBytes += bytes;
    report();
  });

  context.signal?.throwIfAborted();

  onProgress({
    phase: "finalizing",
    hashedBytes: size,
    sentParts,
    totalParts,
    sentBytes,
    totalBytes: size,
  });
  const result = await fetchJson<UploadCompleteResult>(
    context,
    `/api/v1/uploads/${encodeURIComponent(session.id)}/complete`,
    {
      method: "POST",
      // A completion already sent may finish when the app is disabled.
      signal: null,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentHash }),
    },
  );
  const entryId = requireEntryId(result.entryId);
  const finalName =
    result.name ||
    result.finalName ||
    (await completedEntry(context, entryId)).name;
  forgetSession(resumeKey, session.id);
  return {
    name: finalName,
    size,
    mimeType,
    entryId,
    resourceId: result.resourceId,
    uploadedAt: new Date().toISOString(),
    scope,
  };
}

function requireEntryId(entryId?: string): string {
  if (!entryId) {
    throw new ApiError(
      409,
      "上传会话已完成但缺少目录项标识",
      "UPLOAD_ENTRY_MISSING",
    );
  }
  return entryId;
}

async function completedEntry(
  context: UploadContext,
  entryId: string,
): Promise<ResourceRecord> {
  try {
    return await fetchJson<ResourceRecord>(
      context,
      `/api/v1/resources/${encodeURIComponent(entryId)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(
        404,
        "上传已完成，但目录项已删除或不存在，无法恢复",
        "UPLOAD_ENTRY_DELETED",
      );
    }
    throw error;
  }
}

async function tryResume(
  context: UploadContext,
  uploadId?: string,
): Promise<UploadSession | null> {
  if (!uploadId) return null;
  let session: UploadSession;
  try {
    session = await fetchJson<UploadSession>(
      context,
      `/api/v1/uploads/${encodeURIComponent(uploadId)}`,
    );
  } catch (error) {
    // Only the session endpoint's 404 permits a replacement. Keep the pointer
    // on auth/network errors, including errors while verifying a completed entry.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (
    session.status === "completed" ||
    session.status === "created" ||
    session.status === "uploading"
  ) {
    return session;
  }
  throw new ApiError(
    409,
    `上传会话状态为 ${session.status}，无法继续上传`,
    "UPLOAD_NOT_RESUMABLE",
  );
}

async function sendPart(
  context: UploadContext,
  uploadId: string,
  partNo: number,
  chunk: ArrayBuffer,
  partHash: string,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
    context.signal?.throwIfAborted();
    try {
      await fetchJson(
        context,
        `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}`,
        {
          method: "PATCH",
          headers: { "x-part-sha256": partHash },
          body: new Blob([chunk]),
        },
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("分片上传失败");
}

async function runPool(
  items: number[],
  worker: (item: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    async () => {
      while (cursor < items.length) {
        const current = cursor;
        cursor += 1;
        await worker(items[current]);
      }
    },
  );
  await Promise.all(runners);
}

function partSize(
  totalBytes: number,
  chunkSize: number,
  totalParts: number,
  partNo: number,
): number {
  if (partNo === totalParts - 1) {
    return Math.max(0, totalBytes - chunkSize * (totalParts - 1));
  }
  return chunkSize;
}

/** Pass an entryId for new files; CAS resourceIds are only for legacy history. */
export async function downloadResource(
  resourceId: string,
  name: string,
): Promise<void> {
  const response = await fetch(
    apiURL(`/api/v1/files/${encodeURIComponent(resourceId)}/content`),
    { headers: authHeaders() },
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
