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
  ChatChannel,
  ChatMessage,
  CodeFile,
  CodeVersion,
  PluginRecord,
  RunnerInfo,
  ResourceRecord,
  ResourceShareLink,
} from "@linkos/protocol";
import { clearSession, loadRefreshToken, loadToken, saveSession } from "./session";
import { getOrCreateDeviceIdentity } from "./deviceIdentity";

let accessToken: string | null = loadToken();
let refreshToken: string | null = loadRefreshToken();
const GATEWAY_KEY = "linkos.gateway_base";

export function getGatewayBase(): string {
  try { return window.localStorage.getItem(GATEWAY_KEY) ?? ""; } catch { return ""; }
}

export function setGatewayBase(value: string): void {
  const normalized = value.trim().replace(/\/$/, "");
  if (normalized) {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("网关地址必须使用 http 或 https");
  }
  try { if (normalized) window.localStorage.setItem(GATEWAY_KEY, normalized); else window.localStorage.removeItem(GATEWAY_KEY); } catch { /* keep current tab usable */ }
}

export function apiURL(path: string): string { return `${getGatewayBase()}${path}`; }

class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
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
  return new ApiError(status, message, code, record);
}

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const url = typeof input === "string" ? input : input.toString();
  const resolvedInput = typeof input === "string" && input.startsWith("/") ? apiURL(input) : input;
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
    response = await fetch(resolvedInput, { ...init, headers });
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

  if (response.status === 401 && refreshToken && !url.endsWith("/api/v1/sessions/refresh")) {
    try {
      const rotated = await refreshSession(refreshToken);
      if (rotated) return request<T>(input, init);
    } catch { /* fall through to the original auth error */ }
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
	const identity = await getOrCreateDeviceIdentity();
  let response: Response;
  try {
    response = await fetch(apiURL("/api/v1/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo", ...(identity ?? {}), ...input }),
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
  refreshToken = payload.refreshToken ?? null;
  saveSession(payload.accessToken, {
    userId: payload.userId,
    displayName: payload.displayName,
    role: payload.role,
    accessType: payload.accessType,
    status: payload.status,
    workspaceId: payload.workspaceId,
  }, refreshToken ?? undefined);
  return payload;
}

/** Returns null when the stored token is missing or no longer valid. */
export async function fetchMe(): Promise<SessionProfile | null> {
  if (!accessToken) return null;
  let response: Response;
  try {
    response = await fetch(apiURL("/api/v1/me"), {
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
    response = await fetch(apiURL("/api/v1/access-policy"));
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
  refreshToken = null;
  clearSession();
}

async function refreshSession(token: string): Promise<boolean> {
  const response = await fetch(apiURL("/api/v1/sessions/refresh"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
  if (!response.ok) { dropSession(); return false; }
  const payload = (await response.json()) as SessionToken;
  if (!payload.accessToken) { dropSession(); return false; }
  accessToken = payload.accessToken;
  refreshToken = payload.refreshToken ?? null;
  saveSession(payload.accessToken, { userId: payload.userId, displayName: payload.displayName, role: payload.role, accessType: payload.accessType, status: payload.status, workspaceId: payload.workspaceId }, refreshToken ?? undefined);
  return true;
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

export function listChannels() {
  return request<{ items: ChatChannel[]; nextCursor?: string }>("/api/v1/channels");
}

export function createChannel(input: { name: string; kind?: "channel" | "direct"; memberIds?: string[] }) {
  return request<ChatChannel>("/api/v1/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function listMessages(input: { channelId?: string; q?: string; cursor?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") params.set(key, String(value));
  return request<{ items: ChatMessage[]; nextCursor?: string }>(`/api/v1/messages?${params}`);
}

export function listThreadMessages(id: string) {
  return request<{ items: ChatMessage[] }>(`/api/v1/messages/${encodeURIComponent(id)}/thread`);
}

export function editMessage(id: string, body: string) {
  return request<ChatMessage>(`/api/v1/messages/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
}

export function deleteMessage(id: string) {
  return request<ChatMessage>(`/api/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listCodeFiles(projectId = "project_gateway") {
  return request<{ items: CodeFile[]; nextCursor?: string }>(`/api/v1/code/projects/${encodeURIComponent(projectId)}`);
}

export function getCodeFile(id: string) {
  return request<{ file: CodeFile; content: string }>(`/api/v1/code/files/${encodeURIComponent(id)}`);
}

export function saveCodeFile(id: string, content: string, baseVersion: string, force = false) {
  const suffix = force ? "?force=true" : "";
  return request<CodeVersion>(`/api/v1/code/files/${encodeURIComponent(id)}/save${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion }) });
}

export function saveCodeFileAs(input: { projectId: string; path: string; language: string; content: string }) {
  return request<{ file: CodeFile; version: CodeVersion }>("/api/v1/code/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function listRunners() {
  return request<{ items: RunnerInfo[]; nextCursor?: string }>("/api/v1/runners");
}

export function getJob(id: string) {
  return request<JobRef>(`/api/v1/jobs/${encodeURIComponent(id)}`);
}

export function listJobLogs(id: string) {
  return request<{ items: Array<{ jobId: string; seq: number; level: string; chunk: string; at: string }>; nextCursor?: string }>(`/api/v1/jobs/${encodeURIComponent(id)}/logs`);
}

export function listJobArtifacts(id: string) {
  return request<{ items: Array<{ id: string; jobId: string; name: string; resourceId?: string; size: number; contentHash?: string; createdAt: string }>; nextCursor?: string }>(`/api/v1/jobs/${encodeURIComponent(id)}/artifacts`);
}

export function cancelJob(id: string) {
  return request<JobRef>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function listPlugins() {
  return request<{ items: PluginRecord[]; nextCursor?: string }>("/api/v1/plugins");
}

export function listResources(input: { type?: string; parentId?: string; cursor?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") params.set(key, String(value));
  return request<{ items: ResourceRecord[]; nextCursor?: string }>(`/api/v1/resources?${params}`);
}

export function updateResource(id: string, patch: { name?: string; meta?: Record<string, unknown>; acl?: unknown }) {
  return request<ResourceRecord>(`/api/v1/resources/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}

export function createResourceShare(id: string, ttlSeconds?: number) {
  return request<ResourceShareLink>(`/api/v1/resources/${encodeURIComponent(id)}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttlSeconds }) });
}

export function setPluginStatus(id: string, action: "install" | "enable" | "disable" | "rollback" | "uninstall") {
  return request<PluginRecord>(`/api/v1/plugins/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

export function installPlugin(manifest: PluginRecord["manifest"], signature = "") {
  return request<PluginRecord>(`/api/v1/plugins/${encodeURIComponent(manifest.id)}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest, signature }) });
}

export function listDevices() {
  return request<{ items: Array<Record<string, unknown>>; nextCursor?: string }>("/api/v1/devices");
}

export function createInvite() {
  return request<{ code: string; expiresAt: string; singleUse: boolean }>("/api/v1/admin/invites", { method: "POST" });
}

export function listMembers() {
  return request<{ items: Array<{ userId: string; displayName: string; role: string; status: string; deviceCount: number }>; nextCursor?: string }>("/api/v1/admin/members");
}

export function updateMemberRole(userId: string, role: string) {
  return request<{ userId: string; role: string }>(`/api/v1/admin/members/${encodeURIComponent(userId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
}

export function revokeDevice(id: string) {
  return request<{ id: string; status: string }>(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "POST" });
}

export { ApiError };
