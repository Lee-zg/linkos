export type ResourceType =
  | "workspace"
  | "folder"
  | "file"
  | "chat.channel"
  | "chat.message"
  | "code.project"
  | "code.file"
  | "job"
  | "plugin";

export type Permission =
  | "workspace.read"
  | "member.manage"
  | "device.manage"
  | "resource.read"
  | "resource.write"
  | "chat.read"
  | "chat.send"
  | "chat.moderate"
  | "code.read"
  | "code.write"
  | "code.run"
  | "job.submit"
  | "job.cancel"
  | "runner.read"
  | "plugin.read"
  | "plugin.install"
  | "plugin.manage"
  | string;

export type Role = "owner" | "admin" | "member" | "guest";

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface DiscoveryWorkspace {
  id: string;
  name: string;
  address: string;
  version?: string;
  onlineMembers: number;
  tls: boolean;
  source?: "mdns" | "udp" | "manual" | "gateway";
}

export interface DeviceRegistrationInput {
  workspaceId: string;
  publicKey: string;
  displayName: string;
  inviteCode?: string;
}

export interface DeviceRegistration {
  id: string;
  userId: string;
  workspaceId: string;
  displayName: string;
  publicKey: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  workspaceId: string;
  userId: string;
  role: Role | string;
}

export interface ResourceAcl {
  ownerId?: string;
  grants: Array<{ subject: string; actions: Permission[] }>;
}

export interface ResourceRef {
  type: ResourceType | string;
  id: string;
}

export interface ResourceRecord {
  id: string;
  workspaceId: string;
  type: ResourceType | string;
  name: string;
  parentId?: string;
  ownerId?: string;
  acl?: ResourceAcl;
  meta?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

export interface ResourceShareLink {
  token: string;
  resourceId: string;
  expiresAt: string;
  singleUse: boolean;
  createdBy: string;
  createdAt: string;
  usedAt?: string;
  revokedAt?: string;
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
  | "DEVICE_CHALLENGE_REQUIRED"
  | "DEVICE_CHALLENGE_FAILED"
  | "RESOURCE_VERSION_MISMATCH"
  | "UPLOAD_PART_INVALID"
  | "QUOTA_EXCEEDED"
  | "INSUFFICIENT_STORAGE"
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
  traceId?: string;
  previousHash?: string;
  hash?: string;
}

export interface SessionCreateInput {
  workspaceId?: string;
  displayName?: string;
  accessType: AccessType;
  passcode?: string;
  note?: string;
  deviceId?: string;
  publicKey?: string;
  inviteCode?: string;
  challengeId?: string;
  signature?: string;
}

export interface SessionToken {
  accessToken: string;
  refreshToken?: string;
  deviceId?: string;
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
  threadId?: string;
  mentions?: string[];
  blocks?: MessageBlock[];
}

export interface MessageBlock {
  type:
    | "text"
    | "file.reference"
    | "code.reference"
    | "code.snippet"
    | "run.result";
  value: Record<string, unknown>;
}

/** Paths refer to the recipient's LinkOS workspace, not the host OS. */
export interface FilePreferences {
  downloadsId: string;
  inboxId: string;
  trashId: string;
  outgoingId: string;
  receiveFolderId: string;
}

export interface FileOperationInput {
  action: "copy" | "move" | "trash" | "restore";
  ids: string[];
  parentId?: string;
}

export interface ChatChannel {
  id: string;
  workspaceId: string;
  name: string;
  kind: "channel" | "direct";
  memberIds: string[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  body: string;
  blocks?: MessageBlock[];
  mentions?: string[];
  clientMsgId?: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  version: number;
}

export interface MessageSearchQuery {
  channelId?: string;
  authorId?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface AcceptedMessage {
  messageId: string;
  status: "accepted" | "duplicate";
  serverMsgId?: string;
  seq?: number;
}

export type UploadStatus =
  "created" | "uploading" | "verifying" | "completed" | "failed" | "canceled";

export interface UploadCreateInput {
  name: string;
  size: number;
  mimeType?: string;
  contentHash?: string;
  chunkSize?: number;
  parentId?: string;
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
  parentId?: string;
  ownerId?: string;
  workspaceId?: string;
  resourceId?: string;
  entryId?: string;
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
  entryId?: string;
  name?: string;
  finalName?: string;
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
  env?: Record<string, string>;
  artifactGlobs?: string[];
}
export interface JobRef {
  id: string;
  status: JobStatus;
  runnerId?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface JobLogChunk {
  jobId: string;
  seq: number;
  level: "debug" | "info" | "warn" | "error";
  chunk: string;
  at: string;
}

export interface JobArtifact {
  id: string;
  jobId: string;
  name: string;
  resourceId?: string;
  size: number;
  contentHash?: string;
  createdAt: string;
}

export interface RunnerInfo {
  id: string;
  workspaceId: string;
  platform: string;
  version: string;
  capabilities: string[];
  labels: Record<string, string>;
  status: "online" | "paused" | "draining" | "offline";
  lastSeenAt: string;
  credentialVersion?: number;
  revokedAt?: string;
}

export interface RunnerRegistrationToken {
  token: string;
  expiresAt: string;
  singleUse: true;
}

export interface RunnerRegistration {
  runner: RunnerInfo;
  credential: string;
}

export type PluginStatus =
  | "discovered"
  | "installed"
  | "enabled"
  | "disabled"
  | "uninstalled"
  | "failed";

export interface PluginRecord {
  source?: "builtin" | "package" | "legacy";
  runtime?: "native" | "iframe";
  revision: number;
  artifactDigest?: string;
  canRollback: boolean;
  actions: Array<
    "open" | "enable" | "disable" | "install" | "uninstall" | "rollback"
  >;
  healthReason?: string;
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  status: PluginStatus;
  manifest: PluginManifest;
  signature?: string;
  permissions: string[];
  installedAt?: string;
  health?: "healthy" | "degraded" | "failed";
  previous?: {
    manifest: PluginManifest;
    signature?: string;
    status: PluginStatus;
    artifactDigest?: string;
    source?: string;
  };
}

export interface PluginPackageInspection {
  stageId: string;
  manifest: PluginManifest;
  artifactDigest: string;
  trusted: boolean;
  signature?: string;
  expectedRevision: number;
  addedPermissions: string[];
  removedPermissions: string[];
  expiresAt: string;
}
export interface PluginViewTicket {
  nonce: string;
  protocol: "1.0";
  src: string;
  expiresAt: string;
}

export interface PluginHostInit {
  type:"linkos.host.init";
  pluginId:string;
  version:string;
  protocol:"1.0";
  nonce:string;
  permissions:string[];
}
export interface PluginReady {
  type:"linkos.plugin.ready";
  pluginId:string;
  version:string;
  protocol:"1.0";
  nonce:string;
}

export interface CodeFile {
  id: string;
  projectId: string;
  path: string;
  language: string;
  size: number;
  contentHash: string;
  version: string;
  updatedAt: string;
}

export interface CodeVersion {
  id: string;
  fileId: string;
  version: string;
  contentHash: string;
  content: string;
  createdBy: string;
  createdAt: string;
  diffSummary?: { added: number; removed: number };
}

export interface CodeSaveInput {
  content: string;
  baseVersion: string;
  message?: string;
}

export interface CodeConflict {
  error: "RESOURCE_VERSION_MISMATCH";
  current: CodeVersion;
  baseVersion: string;
  diff: string;
}

export const EVENT_TYPES = {
  workspaceReady: "workspace.ready",
  workspaceSnapshotRequired: "workspace.snapshot.required",
  chatMessageCreated: "chat.message.created",
  jobStatusChanged: "job.status.changed",
  accessRecordCreated: "access.record.created",
  accessRecordApproved: "access.record.approved",
  accessRecordRejected: "access.record.rejected",
  accessPolicyUpdated: "access.policy.updated",
  chatMessageUpdated: "chat.message.updated",
  chatMessageDeleted: "chat.message.deleted",
  jobLogChunk: "job.log.chunk",
  runnerUpdated: "runner.updated",
  pluginUpdated: "plugin.updated",
  codeVersionCreated: "code.version.created",
  resourceCreated: "resource.created",
  resourceUpdated: "resource.updated",
  resourceDeleted: "resource.deleted",
} as const;
