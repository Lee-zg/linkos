import type { UploadCompleteResult, UploadSession } from "@linkos/protocol";
import { sha256 } from "js-sha256";
import { ApiError, getSessionToken } from "./api";

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const CONCURRENCY = 4;
const PART_RETRIES = 2;
const SESSION_INDEX_KEY = "linkos.upload-sessions";
const RECORDS_KEY = "linkos.uploaded-files";

export interface UploadProgress {
  phase: "hashing" | "uploading" | "finalizing";
  hashedBytes: number;
  sentParts: number;
  totalParts: number;
  sentBytes: number;
  totalBytes: number;
}

export interface UploadedFileRecord {
  name: string;
  size: number;
  mimeType: string;
  resourceId: string;
  contentHash: string;
  uploadedAt: string;
}

export function loadUploadedFiles(): UploadedFileRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    return raw ? (JSON.parse(raw) as UploadedFileRecord[]) : [];
  } catch {
    return [];
  }
}

function saveUploadedFiles(records: UploadedFileRecord[]) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records.slice(0, 100)));
}

export function rememberUploadedFile(record: UploadedFileRecord) {
  const records = loadUploadedFiles().filter(
    (item) => item.contentHash !== record.contentHash,
  );
  records.unshift(record);
  saveUploadedFiles(records);
}

function loadSessionIndex(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_INDEX_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveSessionIndex(index: Record<string, string>) {
  localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index));
}

function authHeaders(): HeadersInit {
  const token = getSessionToken();
  if (!token) {
    throw new ApiError(401, "会话不存在，请重新进入工作区");
  }
  return { authorization: `Bearer ${token}` };
}

async function parseError(response: Response): Promise<ApiError> {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: string; message?: string }
    | undefined;
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
  windowSize: number,
  onProgress: (hashedBytes: number) => void,
): Promise<string> {
  const hasher = sha256.create();
  let offset = 0;
  while (offset < file.size) {
    const window = await file
      .slice(offset, offset + windowSize)
      .arrayBuffer();
    hasher.update(window);
    offset += window.byteLength;
    onProgress(offset);
  }
  return hasher.hex();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

/**
 * Uploads a file through the chunked protocol with 4-way concurrency and
 * resume support. The full-file SHA-256 is computed by streaming the file
 * through an incremental hasher, and each part is re-read from the file on
 * demand, so memory usage stays bounded by the chunk size regardless of the
 * file size (risk R-04).
 */
export async function uploadFile(
  file: File,
  onProgress: (progress: UploadProgress) => void,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<UploadedFileRecord> {
  const reportHashing = (hashedBytes: number) =>
    onProgress({
      phase: "hashing",
      hashedBytes,
      sentParts: 0,
      totalParts: 0,
      sentBytes: 0,
      totalBytes: file.size,
    });
  reportHashing(0);
  const contentHash = await streamFileHash(file, chunkSize, reportHashing);
  const totalParts = Math.max(1, Math.ceil(file.size / chunkSize));

  const index = loadSessionIndex();
  const resumeKey = `${file.name}:${file.size}:${contentHash}`;
  let session = await tryResume(index[resumeKey]);
  if (!session) {
    session = await fetchJson<UploadSession>("/api/v1/uploads", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        contentHash,
        chunkSize,
      }),
    });
    index[resumeKey] = session.id;
    saveSessionIndex(index);
  }

  const received = new Set(session.receivedParts);
  let sentParts = received.size;
  let sentBytes = 0;
  for (const partNo of received) {
    sentBytes += partSize(file.size, chunkSize, totalParts, partNo);
  }
  const report = () =>
    onProgress({
      phase: "uploading",
      hashedBytes: file.size,
      sentParts,
      totalParts,
      sentBytes,
      totalBytes: file.size,
    });
  report();

  const pending: number[] = [];
  for (let partNo = 0; partNo < totalParts; partNo++) {
    if (!received.has(partNo)) pending.push(partNo);
  }
  await runPool(pending, async (partNo) => {
    const size = partSize(file.size, chunkSize, totalParts, partNo);
    const chunk = await file
      .slice(partNo * chunkSize, partNo * chunkSize + size)
      .arrayBuffer();
    const partHash = sha256Hex(chunk);
    await sendPart(session.id, partNo, chunk, partHash);
    sentParts += 1;
    sentBytes += size;
    report();
  });

  onProgress({
    phase: "finalizing",
    hashedBytes: file.size,
    sentParts,
    totalParts,
    sentBytes,
    totalBytes: file.size,
  });
  const result = await fetchJson<UploadCompleteResult>(
    `/api/v1/uploads/${session.id}/complete`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ contentHash }),
    },
  );
  delete index[resumeKey];
  saveSessionIndex(index);
  return {
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    resourceId: result.resourceId,
    contentHash,
    uploadedAt: new Date().toISOString(),
  };
}

async function tryResume(uploadId?: string): Promise<UploadSession | null> {
  if (!uploadId) return null;
  try {
    const session = await fetchJson<UploadSession>(
      `/api/v1/uploads/${uploadId}`,
      { headers: authHeaders() },
    );
    if (session.status === "created" || session.status === "uploading") {
      return session;
    }
    return null;
  } catch {
    return null;
  }
}

async function sendPart(
  uploadId: string,
  partNo: number,
  chunk: ArrayBuffer,
  partHash: string,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
    try {
      await fetchJson(`/api/v1/uploads/${uploadId}/parts/${partNo}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "x-part-sha256": partHash },
        body: new Blob([chunk]),
      });
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

/** Downloads a content-addressed resource and saves it under its file name. */
export async function downloadResource(
  resourceId: string,
  name: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/files/${encodeURIComponent(resourceId)}/content`,
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
