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
import type { JobSpec, JobStatus } from "@linkos/protocol";
import { sendMessage as postMessage, submitJob } from "./api";
import { useWorkspaceSocket, type SocketEvent } from "./useWorkspaceSocket";

export type Message = {
  id: string;
  author: string;
  initials: string;
  body: string;
  time: string;
  own?: boolean;
};

const initialMessages: Message[] = [
  {
    id: "m1",
    author: "林墨",
    initials: "LM",
    body: "Gateway 的重连补发已经接通了，大家可以直接在任务面板里看事件序号。",
    time: "09:41",
  },
  {
    id: "m2",
    author: "周予",
    initials: "ZY",
    body: "收到。我把大文件上传切到分片模式，今晚压一下 1GB 的构建包。",
    time: "09:43",
  },
  {
    id: "m3",
    author: "陈一",
    initials: "CY",
    body: "好的，发布频道先保留在工作区内，Runner 02 的网络策略还是 deny。",
    time: "09:46",
  },
];

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
  lastEvent: SocketEvent | null;
  messages: Message[];
  sendMessage: (body: string) => void;
  jobStatus: JobStatus;
  runTask: () => Promise<void>;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState(initialMessages);
  const [jobStatus, setJobStatus] = useState<JobStatus>("succeeded");
  const [lastEvent, setLastEvent] = useState<SocketEvent | null>(null);
  const jobTimers = useRef<number[]>([]);
  const localMessageIds = useRef(new Set<string>());
  const messageCounter = useRef(0);

  useEffect(() => {
    return () => {
      jobTimers.current.forEach((timer) => window.clearTimeout(timer));
      jobTimers.current = [];
    };
  }, []);

  const onSocketEvent = useCallback((event: SocketEvent) => {
    setLastEvent(event);
    if (event.type === "chat.message.created") {
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
      const payload = event.payload as { status?: unknown };
      if (
        payload &&
        typeof payload === "object" &&
        isJobStatus(payload.status)
      ) {
        setJobStatus(payload.status);
      }
    }
  }, []);

  const { connected, lastSeq } = useWorkspaceSocket({ onEvent: onSocketEvent });

  const sendMessage = useCallback((body: string) => {
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
    void postMessage({ body, channelId: "engineering", clientMsgId }).catch(
      () => undefined,
    );
  }, []);

  const runTask = useCallback(async () => {
    jobTimers.current.forEach((timer) => window.clearTimeout(timer));
    jobTimers.current = [];
    setJobStatus("preparing");
    const spec: JobSpec = {
      projectId: "api-gateway",
      command: "go test ./...",
      timeoutSeconds: 600,
      memoryMb: 512,
      network: "deny",
    };
    try {
      await submitJob(spec);
      setJobStatus("preparing");
    } catch {
      setJobStatus("queued");
      return;
    }
    jobTimers.current = [
      window.setTimeout(() => setJobStatus("running"), 650),
      window.setTimeout(() => setJobStatus("succeeded"), 2600),
    ];
  }, []);

  const value = useMemo(
    () => ({
      connected,
      lastSeq,
      lastEvent,
      messages,
      sendMessage,
      jobStatus,
      runTask,
    }),
    [connected, lastSeq, lastEvent, messages, sendMessage, jobStatus, runTask],
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
