import type {
  AcceptedMessage,
  AccessPolicy,
  AccessRecord,
  AuditEntry,
  JobRef,
  JobSpec,
  MessageCreateInput,
  SessionCreateInput,
  SessionProfile,
  SessionToken,
} from "@linkos/protocol";
import { clearSession, loadToken, saveSession } from "./session";

let accessToken: string | null = loadToken();

class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function apiErrorFromPayload(status: number, payload: unknown): ApiError {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const code = typeof record.error === "string" ? record.error : undefined;
  const message =
    typeof record.message === "string"
      ? record.message
      : code ?? `请求失败（${status}）`;
  return new ApiError(status, message, code);
}

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const url = typeof input === "string" ? input : input.toString();
  if (
    !url.endsWith("/api/v1/sessions") &&
    !url.endsWith("/api/v1/healthz") &&
    !url.endsWith("/api/v1/discovery") &&
    !url.endsWith("/api/v1/access-policy") &&
    !url.endsWith("/api/v1/me")
  ) {
    await ensureSession();
  }
  const headers = new Headers(init?.headers);
  if (accessToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }
  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? error.message : "网络连接失败",
    );
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    if (response.ok) {
      throw new ApiError(response.status, "服务器返回了无效数据");
    }
  }

  if (!response.ok) {
    throw apiErrorFromPayload(response.status, payload);
  }

  return payload as T;
}

/**
 * Sessions are created explicitly by the access gate; this only reports the
 * token the current tab already holds (or null when the gate has not run).
 */
export async function ensureSession(): Promise<string | null> {
  return accessToken;
}

export function getSessionToken() {
  return accessToken;
}

export async function createSession(
  input: SessionCreateInput,
): Promise<SessionToken> {
  let response: Response;
  try {
    response = await fetch("/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo", ...input }),
    });
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? error.message : "网络连接失败",
    );
  }
  const payload = (await response.json().catch(() => undefined)) as
    | SessionToken
    | undefined;
  if (!response.ok || !payload) {
    throw apiErrorFromPayload(response.status, payload);
  }
  if (typeof payload.accessToken !== "string" || !payload.accessToken) {
    throw new ApiError(response.status, "服务器返回了无效会话");
  }
  accessToken = payload.accessToken;
  saveSession(payload.accessToken, {
    userId: payload.userId,
    displayName: payload.displayName,
    role: payload.role,
    accessType: payload.accessType,
    status: payload.status,
    workspaceId: payload.workspaceId,
  });
  return payload;
}

/** Returns null when the stored token is missing or no longer valid. */
export async function fetchMe(): Promise<SessionProfile | null> {
  if (!accessToken) return null;
  let response: Response;
  try {
    response = await fetch("/api/v1/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? error.message : "网络连接失败",
    );
  }
  if (response.status === 401) return null;
  if (!response.ok) {
    throw apiErrorFromPayload(response.status, undefined);
  }
  return (await response.json()) as SessionProfile;
}

export async function fetchPolicy(): Promise<AccessPolicy> {
  let response: Response;
  try {
    response = await fetch("/api/v1/access-policy");
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? error.message : "网络连接失败",
    );
  }
  if (!response.ok) {
    throw apiErrorFromPayload(response.status, undefined);
  }
  return (await response.json()) as AccessPolicy;
}

export function dropSession(): void {
  accessToken = null;
  clearSession();
}

export function updateAccessPolicy(patch: Partial<AccessPolicy>) {
  return request<AccessPolicy>("/api/v1/admin/access-policy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function listAccessRecords() {
  return request<{ items: AccessRecord[] }>("/api/v1/admin/access-records");
}

export function approveAccessRecord(id: string) {
  return request<AccessRecord>(
    `/api/v1/admin/access-records/${id}/approve`,
    { method: "POST" },
  );
}

export function rejectAccessRecord(id: string) {
  return request<AccessRecord>(
    `/api/v1/admin/access-records/${id}/reject`,
    { method: "POST" },
  );
}

export function listAuditEntries() {
  return request<{ items: AuditEntry[] }>("/api/v1/admin/audit-log");
}

export function sendMessage(payload: MessageCreateInput) {
  return request<AcceptedMessage>("/api/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function submitJob(spec: JobSpec) {
  return request<JobRef>("/api/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
}

export { ApiError };
