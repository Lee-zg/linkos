import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DomainEvent, JobStatus } from "@linkos/protocol";

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

type Workspace = {
  connected: boolean;
  messages: Message[];
  sendMessage: (body: string) => void;
  jobStatus: JobStatus;
  runTask: () => Promise<void>;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(true);
  const [messages, setMessages] = useState(initialMessages);
  const [jobStatus, setJobStatus] = useState<JobStatus>("succeeded");

  useEffect(() => {
    let socket: WebSocket | undefined;
    try {
      const p = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${p}://${window.location.host}/api/v1/ws?workspace=demo`,
      );
      socket.onopen = () => setConnected(true);
      socket.onclose = () => setConnected(false);
      socket.onerror = () => setConnected(false);
      socket.onmessage = (raw) => {
        try {
          const event = JSON.parse(raw.data) as DomainEvent<{
            body?: string;
            author?: string;
            clientMsgId?: string;
          }>;
          const messageBody = event.payload.body;
          if (
            event.type === "chat.message.created" &&
            messageBody &&
            !event.payload.clientMsgId
          )
            setMessages((current) => [
              ...current,
              {
                id: event.eventId,
                author: event.payload.author ?? "成员",
                initials: "M",
                body: messageBody,
                time: "现在",
                own: true,
              },
            ]);
        } catch {
          /* Ignore malformed demo events. */
        }
      };
    } catch {
      setConnected(false);
    }
    return () => socket?.close();
  }, []);

  const sendMessage = useCallback((body: string) => {
    const clientMsgId = `local-${Date.now()}`;
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
    fetch("/api/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, channelId: "engineering", clientMsgId }),
    }).catch(() => undefined);
  }, []);

  const runTask = useCallback(async () => {
    setJobStatus("preparing");
    try {
      const res = await fetch("/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "api-gateway",
          command: "go test ./...",
          timeoutSeconds: 600,
          memoryMb: 512,
          network: "deny",
        }),
      });
      if (res.ok)
        setJobStatus(
          ((await res.json()) as { status?: JobStatus }).status ?? "queued",
        );
    } catch {
      setJobStatus("queued");
    }
    window.setTimeout(() => setJobStatus("running"), 650);
    window.setTimeout(() => setJobStatus("succeeded"), 2600);
  }, []);

  const value = useMemo(
    () => ({ connected, messages, sendMessage, jobStatus, runTask }),
    [connected, messages, sendMessage, jobStatus, runTask],
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
