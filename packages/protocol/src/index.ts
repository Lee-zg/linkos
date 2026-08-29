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
  chatMessageCreated: "chat.message.created",
  jobStatusChanged: "job.status.changed",
  jobLogChunk: "job.log.chunk",
} as const;
