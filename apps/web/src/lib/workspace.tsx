import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { JobSpec, JobStatus, WorkspaceSnapshot } from "@linkos/protocol";
import { getJob, getSnapshot, listMessages, sendMessage as postMessage, submitJob } from "./api";
import { useWorkspaceSocket, type SocketEvent } from "./useWorkspaceSocket";

export type Message = {
  id: string;
  author: string;
  initials: string;
  body: string;
  time: string;
  own?: boolean;
};

const jobStatuses = new Set<JobStatus>([
  "queued",
  "preparing",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
]);

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && jobStatuses.has(value as JobStatus);
}

type Workspace = {
  connected: boolean;
  lastSeq: number;
  resyncSeq: number;
  directoryVersion: number;
  chatVersion: number;
  snapshot: WorkspaceSnapshot | null;
  lastEvent: SocketEvent | null;
  messages: Message[];
  sendMessage: (body: string, channelId?: string, threadId?: string) => void;
  jobStatus: JobStatus;
  currentJobId: string | null;
  runTask: (spec?: Partial<JobSpec>) => Promise<string | null>;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [jobStatus, setJobStatus] = useState<JobStatus>("queued");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<SocketEvent | null>(null);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const [chatVersion, setChatVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const localMessageIds = useRef(new Set<string>());
  const messageCounter = useRef(0);

  const refetchMessages = useCallback(() => {
    return listMessages({ channelId: "engineering", limit: 100 })
      .then((result) => {
        setMessages(
          result.items.map((message) => ({
            id: message.id,
            author: message.authorName,
            initials: message.authorName.slice(0, 1),
            body: message.body,
            time: new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })),
        );
      })
      .catch(() => undefined);
  }, []);

  const onSnapshotRequired = useCallback(() => {
    setDirectoryVersion((version) => version + 1);
    localMessageIds.current.clear();
    setSnapshot(null);
    void getSnapshot()
      .then((value) => setSnapshot(value))
      .catch(() => undefined);
    void refetchMessages();
  }, [refetchMessages]);

  const onSocketEvent = useCallback((event: SocketEvent) => {
    setLastEvent(event);
    if (event.type.startsWith("chat.")) setChatVersion(version => version + 1);
    if (event.type === "resources.changed") {
      setDirectoryVersion((version) => version + 1);
    }
    if (event.type === "chat.message.created") {
      if (event.payload && typeof event.payload === "object" && "messageId" in event.payload) { void refetchMessages(); return; }
      const payload = event.payload as {
        body?: string;
        author?: string;
        clientMsgId?: string;
      };
      if (!payload || typeof payload !== "object" || !payload.body) return;
      if (
        payload.clientMsgId &&
        localMessageIds.current.has(payload.clientMsgId)
      ) {
        localMessageIds.current.delete(payload.clientMsgId);
        return;
      }
      const messageBody = payload.body;
      setMessages((current) => {
        if (current.some((message) => message.id === event.eventId))
          return current;
        return [
          ...current,
          {
            id: event.eventId,
            author: payload.author ?? "成员",
            initials: "M",
            body: messageBody,
            time: "现在",
          },
        ];
      });
    }
    if (event.type === "job.status.changed") {
      const payload = event.payload as { id?: string; jobId?: string; status?: unknown };
      if (
        payload &&
        typeof payload === "object" &&
        isJobStatus(payload.status)
      ) {
        setJobStatus(payload.status);
      }
    }
  }, [refetchMessages]);

  const { connected, lastSeq, resyncSeq } = useWorkspaceSocket({
    onEvent: onSocketEvent,
    onSnapshotRequired,
  });

  useEffect(() => {
    if (!connected) return;
    void refetchMessages();
  }, [connected, refetchMessages]);

  useEffect(() => {
    if (!currentJobId || !["queued", "preparing", "running"].includes(jobStatus)) return;
    const timer = window.setInterval(() => { void getJob(currentJobId).then((job) => setJobStatus(job.status)).catch(() => undefined); }, 500);
    return () => window.clearInterval(timer);
  }, [currentJobId, jobStatus]);

  const sendMessage = useCallback((body: string, channelId = "engineering", threadId?: string) => {
    const clientMsgId = `local-${Date.now()}-${messageCounter.current++}`;
    localMessageIds.current.add(clientMsgId);
    if (localMessageIds.current.size > 100) {
      const oldest = localMessageIds.current.values().next().value;
      if (oldest) localMessageIds.current.delete(oldest);
    }
    setMessages((current) => [
      ...current,
      {
        id: clientMsgId,
        author: "你",
        initials: "ME",
        body,
        time: "现在",
        own: true,
      },
    ]);
    void postMessage({ body, channelId, threadId, clientMsgId }).catch(
      () => undefined,
    );
  }, []);

  const runTask = useCallback(async (overrides: Partial<JobSpec> = {}) => {
    setJobStatus("preparing");
    const spec: JobSpec = {
      projectId: "project_gateway",
      command: "go test ./...",
      timeoutSeconds: 600,
      memoryMb: 512,
      network: "deny",
      ...overrides,
    };
    try {
      const job = await submitJob(spec);
      setCurrentJobId(job.id);
      setJobStatus(job.status);
      return job.id;
    } catch {
      setJobStatus("failed");
      return null;
    }
  }, []);

  const value = useMemo(
    () => ({
      connected,
      lastSeq,
      resyncSeq,
      directoryVersion,
      chatVersion,
      snapshot,
      lastEvent,
      messages,
      sendMessage,
      jobStatus,
      currentJobId,
      runTask,
    }),
    [connected, lastSeq, resyncSeq, directoryVersion, chatVersion, snapshot, lastEvent, messages, sendMessage, jobStatus, currentJobId, runTask],
  );
  return (
      <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx)
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
