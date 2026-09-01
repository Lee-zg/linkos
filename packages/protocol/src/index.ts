export type ResourceType =
  | "workspace"
  | "file"
  | "chat.channel"
  | "chat.message"
  | "code.project"
  | "code.file"
  | "job"
  | "plugin";

export interface ResourceRef {
  type: ResourceType | string;
  id: string;
}

export interface DomainEvent<T = unknown> {
  v: 1;
  type: string;
  eventId: string;
  seq: number;
  ts: string;
  workspaceId: string;
  actorId?: string;
  resource?: ResourceRef;
  payload: T;
}

/** Stable error identifiers shared by HTTP, WebSocket and plugin adapters. */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "ACCESS_DENIED"
  | "ACCESS_PENDING"
  | "ACCESS_REJECTED"
  | "ACCESS_REVOKED"
  | "RESOURCE_VERSION_MISMATCH"
  | "UPLOAD_PART_INVALID"
  | "QUOTA_EXCEEDED"
  | "JOB_POLICY_DENIED"
  | "RUNNER_UNAVAILABLE"
  | "PLUGIN_INCOMPATIBLE"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error: ErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

export type AccessType = "login" | "anonymous" | "guest";

export type AccessStatus = "pending" | "active" | "rejected" | "revoked";

export interface AccessPolicy {
  allowAnonymousApplication: boolean;
  allowFullAnonymous: boolean;
}

export interface AccessRecord {
  id: string;
  userId: string;
  displayName: string;
  accessType: AccessType;
  status: AccessStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  note?: string;
  remoteAddr?: string;
}

export type AuditAction =
  | "session.issue"
  | "session.denied"
  | "access.policy.update"
  | "access.record.approve"
  | "access.record.reject";

export interface AuditEntry {
  id: string;
  at: string;
  actorUserId?: string;
  actorName?: string;
  action: AuditAction | string;
  target?: string;
  detail?: string;
  remoteAddr?: string;
}

export interface SessionCreateInput {
  workspaceId?: string;
  displayName?: string;
  accessType: AccessType;
  passcode?: string;
  note?: string;
}

export interface SessionToken {
  accessToken: string;
  expiresIn: number;
  workspaceId: string;
  userId: string;
  displayName: string;
  role: string;
  accessType: AccessType;
  status: AccessStatus;
}

export interface SessionProfile {
  userId: string;
  displayName: string;
  role: string;
  accessType: AccessType;
  status: AccessStatus;
  workspaceId: string;
}

export interface MessageCreateInput {
  body: string;
  channelId: string;
  clientMsgId: string;
}

export interface AcceptedMessage {
  messageId: string;
  status: "accepted" | "duplicate";
  serverMsgId?: string;
  seq?: number;
}

export type UploadStatus =
  | "created"
  | "uploading"
  | "verifying"
  | "completed"
  | "failed"
  | "canceled";

export interface UploadCreateInput {
  name: string;
  size: number;
  mimeType?: string;
  contentHash?: string;
  chunkSize?: number;
}

export interface UploadSession {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalParts: number;
  receivedParts: number[];
  status: UploadStatus;
  contentHash?: string;
}

export interface UploadPartInput {
  partNo: number;
  sha256: string;
  size: number;
}

export interface UploadPartResult {
  uploadId: string;
  partNo: number;
  accepted: boolean;
  receivedParts: number[];
}

export interface UploadCompleteInput {
  contentHash: string;
}

export interface UploadCompleteResult {
  uploadId: string;
  resourceId: string;
  contentHash: string;
  status: "completed";
}

export interface WorkspaceSnapshot {
  workspace: {
    id: string;
    name: string;
    status: "online" | "offline";
    onlineMembers: number;
    totalMembers: number;
  };
  resources: Array<{
    id: string;
    type: ResourceType | string;
    name: string;
    meta?: Record<string, string | number>;
  }>;
  activity: Array<{
    id: string;
    actor: string;
    action: string;
    target: string;
    time: string;
    tone: "blue" | "green" | "amber" | "violet";
  }>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  entry: { ui?: string; service?: string; runner?: string };
  permissions: string[];
  contributes: {
    routes?: string[];
    commands?: string[];
    resourceTypes?: string[];
    messageBlocks?: string[];
  };
  network?: { mode: "deny" | "allowlist"; domains?: string[] };
  runner?: { required: boolean };
}

export type JobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export interface JobSpec {
  projectId: string;
  command: string;
  baseVersion?: string;
  timeoutSeconds: number;
  memoryMb: number;
  network: "deny" | "allowlist";
  priority?: "low" | "normal" | "high";
}
export interface JobRef {
  id: string;
  status: JobStatus;
  runnerId?: string;
}

export const EVENT_TYPES = {
  workspaceReady: "workspace.ready",
  workspaceSnapshotRequired: "workspace.snapshot.required",
  chatMessageCreated: "chat.message.created",
  jobStatusChanged: "job.status.changed",
  jobLogChunk: "job.log.chunk",
  accessRecordCreated: "access.record.created",
  accessRecordApproved: "access.record.approved",
  accessRecordRejected: "access.record.rejected",
  accessPolicyUpdated: "access.policy.updated",
} as const;
