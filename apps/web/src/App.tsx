import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  FileCode2,
  FileUp,
  Files,
  Folder,
  GitBranch,
  HardDrive,
  LayoutDashboard,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  UploadCloud,
  Users,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import type { DomainEvent, JobStatus } from "@linkos/protocol";

type View = "overview" | "files" | "chat" | "code" | "tasks" | "plugins";
type Tone = "blue" | "green" | "amber" | "violet";
type Message = {
  id: string;
  author: string;
  initials: string;
  body: string;
  time: string;
  own?: boolean;
  accent?: string;
};
type ActivityItem = {
  id: string;
  actor: string;
  action: string;
  target: string;
  time: string;
  tone: Tone;
};

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof LayoutDashboard;
  count?: string;
}> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "files", label: "文件", icon: Files, count: "12" },
  { id: "chat", label: "聊天", icon: MessageSquare, count: "3" },
  { id: "code", label: "代码", icon: Code2 },
  { id: "tasks", label: "任务", icon: Terminal, count: "2" },
  { id: "plugins", label: "插件", icon: Sparkles },
];
const initialActivity: ActivityItem[] = [
  {
    id: "a1",
    actor: "林墨",
    action: "更新了",
    target: "api-gateway / websocket.go",
    time: "刚刚",
    tone: "blue",
  },
  {
    id: "a2",
    actor: "周予",
    action: "上传了",
    target: "release-candidate.tar.gz",
    time: "5 分钟前",
    tone: "green",
  },
  {
    id: "a3",
    actor: "Runner 02",
    action: "完成了",
    target: "go test ./...",
    time: "12 分钟前",
    tone: "violet",
  },
  {
    id: "a4",
    actor: "陈一",
    action: "创建了频道",
    target: "#版本发布",
    time: "34 分钟前",
    tone: "amber",
  },
];
const initialMessages: Message[] = [
  {
    id: "m1",
    author: "林墨",
    initials: "LM",
    body: "Gateway 的重连补发已经接通了，大家可以直接在任务面板里看事件序号。",
    time: "09:41",
    accent: "cyan",
  },
  {
    id: "m2",
    author: "周予",
    initials: "ZY",
    body: "收到。我把大文件上传切到分片模式，今晚压一下 1GB 的构建包。",
    time: "09:43",
    accent: "lime",
  },
  {
    id: "m3",
    author: "陈一",
    initials: "CY",
    body: "好的，发布频道先保留在工作区内，Runner 02 的网络策略还是 deny。",
    time: "09:46",
    accent: "amber",
  },
];
const files = [
  {
    name: "release-candidate.tar.gz",
    type: "archive",
    size: "1.82 GB",
    meta: "周予 · 5 分钟前",
    progress: 100,
  },
  {
    name: "api-gateway",
    type: "folder",
    size: "28 items",
    meta: "林墨 · 今天 09:41",
    progress: null,
  },
  {
    name: "design-system.md",
    type: "doc",
    size: "42 KB",
    meta: "陈一 · 昨天",
    progress: null,
  },
  {
    name: "runner-matrix.json",
    type: "code",
    size: "8 KB",
    meta: "自动同步 · 昨天",
    progress: null,
  },
  {
    name: "demo-recording.mp4",
    type: "video",
    size: "486 MB",
    meta: "周予 · 周二",
    progress: 62,
  },
];
const pluginSeed = [
  {
    id: "files.core",
    name: "文件",
    desc: "分片传输、版本和共享",
    version: "0.1.0",
    enabled: true,
    icon: Files,
    color: "blue",
  },
  {
    id: "chat.core",
    name: "聊天",
    desc: "频道、线程与资源引用",
    version: "0.1.0",
    enabled: true,
    icon: MessageSquare,
    color: "lime",
  },
  {
    id: "code.workbench",
    name: "代码工作台",
    desc: "查看、编辑和运行代码",
    version: "0.1.0",
    enabled: true,
    icon: Code2,
    color: "amber",
  },
  {
    id: "runner.exec",
    name: "运行任务",
    desc: "Runner 调度与日志流",
    version: "0.1.0",
    enabled: true,
    icon: Terminal,
    color: "violet",
  },
];
const codeLines = [
  ["1", "package gateway"],
  ["2", ""],
  ["3", "import ("],
  ["4", '  "context"'],
  ["5", '  "log"'],
  ["6", '  "net/http"'],
  ["7", ")"],
  ["8", ""],
  ["9", "func (h *Hub) Broadcast(ctx context.Context, event Event) error {"],
  ["10", "  if err := h.store.Append(ctx, event); err != nil {"],
  ["11", "    return err"],
  ["12", "  }"],
  ["13", "  for client := range h.clients {"],
  ["14", "    client.Send(event)"],
  ["15", "  }"],
  ["16", "  return nil"],
  ["17", "}"],
];

function App() {
  const [view, setView] = useState<View>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  const [messages, setMessages] = useState(initialMessages);
  const [composer, setComposer] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus>("succeeded");
  const [plugins, setPlugins] = useState(pluginSeed);
  useEffect(() => {
    let socket: WebSocket | undefined;
    try {
      const p = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${p}://${window.location.host}/api/v1/ws?workspace=demo`,
      );
      socket.onopen = () => setIsConnected(true);
      socket.onclose = () => setIsConnected(false);
      socket.onerror = () => setIsConnected(false);
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
                accent: "cyan",
              },
            ]);
        } catch {
          /* Ignore malformed demo events. */
        }
      };
    } catch {
      setIsConnected(false);
    }
    return () => socket?.close();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const selectView = (next: View) => {
    setView(next);
    setMobileNavOpen(false);
  };
  const notify = (message: string) => setToast(message);
  const sendMessage = useCallback(() => {
    const body = composer.trim();
    if (!body) return;
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
        accent: "cyan",
      },
    ]);
    setComposer("");
    notify("消息已发送到 #工程协作");
    fetch("/api/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, channelId: "engineering", clientMsgId }),
    }).catch(() => undefined);
  }, [composer]);
  const runTask = useCallback(async () => {
    setJobStatus("preparing");
    notify("任务已进入 Runner 队列");
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
  const pageTitle = navItems.find((item) => item.id === view)?.label ?? "总览";
  return (
    <div className="app-shell">
      <div className="aurora" aria-hidden="true" />
      <div className="grid-noise" aria-hidden="true" />
      <header className="topbar">
        <button
          className="brand"
          onClick={() => selectView("overview")}
          aria-label="返回总览"
        >
          <span className="brand-mark">
            <span />
          </span>
          <span className="brand-name">
            LINK<span>/</span>OS
          </span>
        </button>
        <button
          className="workspace-switcher"
          onClick={() => notify("当前工作区：Nimbus Lab")}
        >
          <span className="workspace-dot" />
          <span>
            <strong>Nimbus Lab</strong>
            <small>局域网工作区</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="topbar-center">
          <div className="command-search">
            <Search size={16} />
            <span>搜索资源、消息和运行任务</span>
            <kbd>⌘ K</kbd>
          </div>
        </div>
        <div className="topbar-actions">
          <div
            className={`connection-pill ${isConnected ? "online" : "offline"}`}
          >
            <span className="pulse" />
            {isConnected ? "已连接" : "重连中"}
            <small>12 ms</small>
          </div>
          <button
            className="icon-button"
            aria-label="通知"
            onClick={() => notify("没有新的重要通知")}
          >
            <Bell size={17} />
            <i />
          </button>
          <button
            className="avatar"
            aria-label="打开个人菜单"
            onClick={() => notify("个人菜单即将开放")}
          >
            LM
          </button>
        </div>
        <button
          className="mobile-menu"
          aria-label="打开导航"
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <Menu size={20} />
        </button>
      </header>
      <div className="workspace-layout">
        <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
          <div className="sidebar-scroll">
            <div className="sidebar-label">工作区</div>
            <nav className="nav-list" aria-label="工作区导航">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${view === item.id ? "active" : ""}`}
                    onClick={() => selectView(item.id)}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.count && <em>{item.count}</em>}
                  </button>
                );
              })}
            </nav>
            <div className="sidebar-divider" />
            <div className="sidebar-label row-label">
              <span>频道</span>
              <button
                className="mini-icon"
                aria-label="新建频道"
                onClick={() => notify("频道创建流程即将开放")}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="channel-list">
              <button className="channel-item active">
                <span>#</span>工程协作<i>3</i>
              </button>
              <button className="channel-item">
                <span>#</span>版本发布
              </button>
              <button className="channel-item">
                <span>#</span>设计评审
              </button>
              <button className="channel-item">
                <span>#</span>随手记录
              </button>
            </div>
          </div>
          <div className="sidebar-bottom">
            <div className="storage-meter">
              <div className="storage-title">
                <HardDrive size={14} />
                <span>工作区存储</span>
                <strong>42%</strong>
              </div>
              <div className="meter">
                <span />
              </div>
              <small>42.1 GB / 100 GB</small>
            </div>
            <button
              className="nav-item"
              onClick={() => notify("设置面板即将开放")}
            >
              <Settings2 size={17} />
              <span>设置</span>
            </button>
          </div>
        </aside>
        <main className="main-content">
          <div className="mobile-page-title">
            <span>{pageTitle}</span>
            <button
              className="icon-button"
              aria-label="打开右侧面板"
              onClick={() => notify("上下文面板已固定")}
            >
              <PanelRight size={18} />
            </button>
          </div>
          {view === "overview" && (
            <Overview onAction={notify} onRun={runTask} jobStatus={jobStatus} />
          )}
          {view === "files" && <FilesView onAction={notify} />}
          {view === "chat" && (
            <ChatView
              messages={messages}
              composer={composer}
              setComposer={setComposer}
              onSend={sendMessage}
            />
          )}
          {view === "code" && (
            <CodeView onRun={runTask} jobStatus={jobStatus} onAction={notify} />
          )}
          {view === "tasks" && (
            <TasksView jobStatus={jobStatus} onRun={runTask} />
          )}
          {view === "plugins" && (
            <PluginsView
              plugins={plugins}
              onToggle={(id) =>
                setPlugins((current) =>
                  current.map((plugin) =>
                    plugin.id === id
                      ? { ...plugin, enabled: !plugin.enabled }
                      : plugin,
                  ),
                )
              }
              onAction={notify}
            />
          )}
        </main>
        <aside className="context-panel">
          <div className="context-header">
            <span>实时状态</span>
            <button
              className="icon-button"
              aria-label="更多状态选项"
              onClick={() => notify("状态筛选即将开放")}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
          <div className="context-card signal-card">
            <div className="signal-ring">
              <Wifi size={17} />
            </div>
            <div>
              <strong>网络稳定</strong>
              <small>局域网延迟 12 ms</small>
            </div>
            <span className="signal-value">A+</span>
          </div>
          <ContextSection title="在线成员">
            <div className="member-stack">
              <span className="member-avatar cyan">LM</span>
              <span className="member-avatar lime">ZY</span>
              <span className="member-avatar amber">CY</span>
              <span className="member-avatar violet">+9</span>
            </div>
            <div className="member-caption">
              <span className="online-dot" />
              12 人在线 · 4 个设备
            </div>
          </ContextSection>
          <ContextSection title="Runner 节点">
            <RunnerRow
              name="Runner 02"
              meta="Go 1.23 · 4 cores"
              status="空闲"
            />
            <RunnerRow
              name="Runner 01"
              meta="Node 22 · 8 cores"
              status="运行中"
              busy
            />
          </ContextSection>
          <ContextSection title="快捷命令">
            <div className="quick-command">
              <button onClick={() => notify("正在打开命令面板")}>
                <span className="command-key">/</span>
                <span>搜索或执行操作</span>
                <kbd>Enter</kbd>
              </button>
              <button onClick={() => notify("诊断包已准备好下载")}>
                <ShieldCheck size={15} />
                <span>生成诊断包</span>
                <ArrowUpRight size={14} />
              </button>
            </div>
          </ContextSection>
        </aside>
      </div>
      {toast && (
        <div className="toast">
          <span className="toast-icon">
            <Check size={14} />
          </span>
          <span>{toast}</span>
          <button aria-label="关闭通知" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
  actionIcon,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: string;
  actionIcon?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">
          <span className="eyebrow-line" />
          {eyebrow}
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && (
        <button className="primary-button" onClick={() => undefined}>
          {actionIcon}
          {action}
        </button>
      )}
    </div>
  );
}
function ContextSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="context-section">
      <div className="context-title">
        <span>{title}</span>
        <MoreHorizontal size={15} className="muted-icon" />
      </div>
      {children}
    </div>
  );
}
function RunnerRow({
  name,
  meta,
  status,
  busy,
}: {
  name: string;
  meta: string;
  status: string;
  busy?: boolean;
}) {
  return (
    <div className="runner-row">
      <div className={`runner-icon ${busy ? "busy" : ""}`}>
        <Cpu size={16} />
      </div>
      <div>
        <strong>{name}</strong>
        <small>{meta}</small>
      </div>
      <span className={`runner-status ${busy ? "busy" : ""}`}>{status}</span>
    </div>
  );
}
function Overview({
  onAction,
  onRun,
  jobStatus,
}: {
  onAction: (message: string) => void;
  onRun: () => void;
  jobStatus: JobStatus;
}) {
  const activity = initialActivity;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="工作区 / 2026.08.29"
        title="保持连接，继续工作。"
        description="Nimbus Lab 正在运行。你的团队、文件和执行环境都在同一条低延迟链路上。"
      />
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="hero-tag">
            <span className="hero-tag-dot" />
            LOCAL-FIRST WORKSPACE
          </div>
          <h2>
            把上下文留在
            <br />
            <em>一个工作区。</em>
          </h2>
          <p>
            从文件到消息，从代码到任务，每一次协作都有连续的资源引用和可追溯状态。
          </p>
          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={() => onAction("文件工作区已打开")}
            >
              <UploadCloud size={16} />
              上传文件
            </button>
            <button
              className="secondary-button"
              onClick={() => onAction("正在打开新频道")}
            >
              <Plus size={16} />
              新建频道
            </button>
          </div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit-core">
            <Network size={24} />
            <span>12ms</span>
          </div>
          <span className="orbit-label label-top">事件总线</span>
          <span className="orbit-label label-right">RUNNER 02</span>
          <span className="orbit-label label-bottom">内容寻址</span>
        </div>
        <div className="hero-footer">
          <span>
            <span className="live-indicator" />
            系统在线
          </span>
          <span>
            事件序号 <strong>#18,421</strong>
          </span>
          <span>
            最后同步 <strong>刚刚</strong>
          </span>
        </div>
      </section>
      <section className="metric-grid">
        <Metric
          label="在线成员"
          value="12"
          detail="+3 本周"
          icon={<Users size={16} />}
          tone="blue"
        />
        <Metric
          label="工作区文件"
          value="42.1 GB"
          detail="68 个资源"
          icon={<HardDrive size={16} />}
          tone="green"
        />
        <Metric
          label="今日任务"
          value="18"
          detail="94.4% 成功"
          icon={<Zap size={16} />}
          tone="amber"
        />
        <Metric
          label="活跃插件"
          value="6 / 8"
          detail="全部健康"
          icon={<Sparkles size={16} />}
          tone="violet"
        />
      </section>
      <div className="split-grid">
        <section className="surface-panel activity-panel">
          <SectionHeading
            kicker="EVENT STREAM"
            title="最近动态"
            action="查看事件流"
            onAction={() => onAction("事件流筛选已打开")}
          />
          <div className="activity-list">
            {activity.map((item) => (
              <div className="activity-row" key={item.id}>
                <span className={`activity-dot ${item.tone}`} />
                <div className="activity-content">
                  <p>
                    <strong>{item.actor}</strong> {item.action}{" "}
                    <span>{item.target}</span>
                  </p>
                  <small>{item.time}</small>
                </div>
                <button
                  className="icon-button"
                  aria-label={`打开 ${item.target}`}
                  onClick={() => onAction(`正在打开 ${item.target}`)}
                >
                  <ArrowUpRight size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="surface-panel focus-panel">
          <SectionHeading kicker="NEXT ACTION" title="继续工作" />
          <FocusCard
            icon={<FileCode2 size={18} />}
            title="完成 WebSocket 事件回归"
            meta="api-gateway / websocket.go"
            onAction={() => onAction("已定位到 websocket.go")}
          />
          <FocusCard
            icon={<Terminal size={18} />}
            tone="amber"
            title="运行 Go 测试"
            meta="Runner 02 · network deny"
            action={
              <button
                className="run-mini"
                aria-label="运行 Go 测试"
                onClick={onRun}
              >
                {jobStatus === "running" ? (
                  <RefreshCw size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
              </button>
            }
          />
        </section>
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone: Tone;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small className={tone === "green" ? "positive" : ""}>{detail}</small>
      </div>
      <ArrowUpRight size={15} className="metric-arrow" />
    </div>
  );
}
function SectionHeading({
  kicker,
  title,
  action,
  onAction,
}: {
  kicker: string;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-heading">
      <div>
        <span className="section-kicker">{kicker}</span>
        <h3>{title}</h3>
      </div>
      {action && (
        <button className="text-action" onClick={onAction}>
          {action} <ArrowUpRight size={14} />
        </button>
      )}
    </div>
  );
}
function FocusCard({
  icon,
  tone,
  title,
  meta,
  action,
  onAction,
}: {
  icon: ReactNode;
  tone?: string;
  title: string;
  meta: string;
  action?: ReactNode;
  onAction?: () => void;
}) {
  return (
    <div className="focus-card">
      <div className={`focus-card-icon ${tone ?? ""}`}>{icon}</div>
      <div>
        <strong>{title}</strong>
        <p>{meta}</p>
      </div>
      {action ?? (
        <button
          className="icon-button"
          aria-label="打开资源"
          onClick={onAction}
        >
          <ArrowUpRight size={16} />
        </button>
      )}
    </div>
  );
}

function FilesView({ onAction }: { onAction: (message: string) => void }) {
  const [uploading, setUploading] = useState(false);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="资源 / 文件"
        title="文件在这里流动。"
        description="局域网内分片传输、断点续传，文件始终带着版本和权限。"
        action="上传文件"
        actionIcon={<UploadCloud size={16} />}
      />
      <div className="toolbar-row">
        <div className="segmented">
          <button className="selected">最近</button>
          <button>共享目录</button>
          <button>
            传输队列 <span>1</span>
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className="secondary-button compact"
            onClick={() => onAction("文件视图已切换为列表")}
          >
            <Menu size={15} />
            列表
          </button>
          <button
            className="icon-button outlined"
            aria-label="筛选文件"
            onClick={() => onAction("文件筛选已打开")}
          >
            <HashIcon />
          </button>
        </div>
      </div>
      <section className="surface-panel file-panel">
        <div className="file-panel-head">
          <div className="file-path">
            <Folder size={16} />
            <span>工作区</span>
            <span>/</span>
            <strong>最近资源</strong>
          </div>
          <button
            className="text-action"
            onClick={() => onAction("存储管理已打开")}
          >
            存储管理 <ArrowUpRight size={14} />
          </button>
        </div>
        <div
          className={`drop-zone ${uploading ? "uploading" : ""}`}
          onClick={() => {
            setUploading(true);
            window.setTimeout(() => setUploading(false), 2600);
            onAction("文件已加入传输队列");
          }}
        >
          <div className="drop-icon">
            <UploadCloud size={20} />
          </div>
          <div>
            <strong>{uploading ? "正在准备分片..." : "拖放文件到这里"}</strong>
            <span>或点击选择，单文件最大 10 GB</span>
          </div>
          <kbd>⌘ V</kbd>
        </div>
        <div className="file-list">
          {files.map((file) => (
            <div className="file-row" key={file.name}>
              <div className={`file-type ${file.type}`}>
                <FileCode2 size={16} />
              </div>
              <div className="file-info">
                <strong>{file.name}</strong>
                <small>{file.meta}</small>
              </div>
              <span className="file-size">{file.size}</span>
              {file.progress !== null ? (
                <div className="file-progress">
                  <div className="progress-track">
                    <span style={{ width: `${file.progress}%` }} />
                  </div>
                  <small>{file.progress}%</small>
                </div>
              ) : (
                <span className="file-version">v4</span>
              )}
              <button
                className="icon-button"
                aria-label={`更多 ${file.name}`}
                onClick={() => onAction(`${file.name} 的更多操作`)}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
function HashIcon() {
  return <span className="hash-icon">#</span>;
}

function ChatView({
  messages,
  composer,
  setComposer,
  onSend,
}: {
  messages: Message[];
  composer: string;
  setComposer: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="协作 / 聊天"
        title="# 工程协作"
        description="消息、文件和代码引用共享一条事件流。"
      />
      <div className="chat-layout">
        <section className="surface-panel chat-panel">
          <div className="chat-head">
            <div>
              <strong>#工程协作</strong>
              <small>12 位成员 · 过去 7 天 1,284 条消息</small>
            </div>
            <div className="chat-head-actions">
              <button className="icon-button" aria-label="搜索频道">
                <Search size={16} />
              </button>
              <button className="icon-button" aria-label="频道成员">
                <Users size={16} />
              </button>
            </div>
          </div>
          <div className="pinned-note">
            <span>
              <ShieldCheck size={15} />
              置顶
            </span>
            <p>Runner 网络策略保持 deny，发布前请在任务结果中附上提交版本。</p>
            <ArrowUpRight size={14} />
          </div>
          <div className="message-list">
            {messages.map((message) => (
              <div
                className={`message-row ${message.own ? "own" : ""}`}
                key={message.id}
              >
                <span className={`message-avatar ${message.accent}`}>
                  {message.initials}
                </span>
                <div className="message-body">
                  <div>
                    <strong>{message.author}</strong>
                    <time>{message.time}</time>
                  </div>
                  <p>{message.body}</p>
                </div>
                <button
                  className="icon-button message-menu"
                  aria-label="消息菜单"
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="composer-wrap">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                  onSend();
              }}
              placeholder="发送消息到 #工程协作"
              rows={1}
            />
            <div className="composer-actions">
              <div>
                <button className="icon-button" aria-label="添加文件">
                  <FileUp size={16} />
                </button>
                <button className="icon-button" aria-label="插入代码">
                  <Code2 size={16} />
                </button>
                <span className="composer-hint">⌘ Enter 发送</span>
              </div>
              <button
                className="send-button"
                aria-label="发送消息"
                onClick={onSend}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </section>
        <aside className="thread-panel">
          <div className="thread-head">
            <span>频道详情</span>
            <button className="icon-button" aria-label="关闭详情">
              <X size={16} />
            </button>
          </div>
          <div className="thread-summary">
            <div className="channel-glyph">#</div>
            <strong>工程协作</strong>
            <p>讨论实现细节、测试结果和发布准备。</p>
            <div className="thread-tags">
              <span>研发</span>
              <span>默认频道</span>
            </div>
          </div>
          <div className="thread-section">
            <span className="section-kicker">SHARED RECENTLY</span>
            <div className="shared-item">
              <FileCode2 size={15} />
              <div>
                <strong>websocket.go</strong>
                <small>林墨 · 2 分钟前</small>
              </div>
              <ArrowUpRight size={14} />
            </div>
            <div className="shared-item">
              <HardDrive size={15} />
              <div>
                <strong>release-candidate.tar.gz</strong>
                <small>周予 · 5 分钟前</small>
              </div>
              <ArrowUpRight size={14} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CodeView({
  onRun,
  jobStatus,
  onAction,
}: {
  onRun: () => void;
  jobStatus: JobStatus;
  onAction: (message: string) => void;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="开发 / 代码"
        title="代码，带着上下文。"
        description="查看、修改、运行；每次保存都保留版本和来源。"
      />
      <div className="code-layout">
        <aside className="repo-panel surface-panel">
          <div className="repo-head">
            <div>
              <span className="section-kicker">PROJECT</span>
              <strong>api-gateway</strong>
            </div>
            <button className="icon-button" aria-label="仓库操作">
              <MoreHorizontal size={16} />
            </button>
          </div>
          <div className="branch-select">
            <GitBranch size={14} />
            <span>main</span>
            <ChevronDown size={13} />
          </div>
          <div className="tree">
            <TreeRow icon={<Folder size={15} />} label="cmd" />
            <TreeRow icon={<Folder size={15} />} label="internal" open>
              <TreeRow icon={<Folder size={15} />} label="events" />
              <TreeRow icon={<FileCode2 size={15} />} label="hub.go" />
              <TreeRow
                icon={<FileCode2 size={15} />}
                label="websocket.go"
                active
              />
            </TreeRow>
            <TreeRow icon={<Folder size={15} />} label="storage" />
            <TreeRow icon={<FileCode2 size={15} />} label="go.mod" />
            <TreeRow icon={<FileCode2 size={15} />} label="README.md" />
          </div>
          <div className="repo-footer">
            <span>
              <span className="online-dot" />
              已同步
            </span>
            <span>main · 3 分钟前</span>
          </div>
        </aside>
        <section className="editor-panel surface-panel">
          <div className="editor-tabs">
            <div className="editor-tab active">
              <FileCode2 size={14} />
              websocket.go <X size={13} />
            </div>
            <button className="icon-button" aria-label="新建编辑器标签">
              <Plus size={15} />
            </button>
            <div className="editor-tab-actions">
              <button
                className="icon-button"
                aria-label="复制代码"
                onClick={() => onAction("代码已复制到剪贴板")}
              >
                <Copy size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="运行文件"
                onClick={onRun}
              >
                {jobStatus === "running" ? (
                  <RefreshCw size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
              </button>
            </div>
          </div>
          <div className="editor-meta">
            <span>
              <span className="unsaved-dot" />
              未提交修改
            </span>
            <span>UTF-8</span>
            <span>Go</span>
            <span className="editor-meta-right">Ln 9, Col 4</span>
          </div>
          <div className="code-viewer">
            {codeLines.map(([line, text], index) => (
              <div
                className={`code-line ${index === 8 ? "highlight" : ""}`}
                key={line}
              >
                <span className="line-number">{line}</span>
                <code
                  className={
                    text.includes("func") ||
                    text.includes("return") ||
                    text.includes("if")
                      ? "keyword"
                      : ""
                  }
                >
                  {text}
                </code>
              </div>
            ))}
          </div>
          <div className="editor-status">
            <span>
              <ShieldCheck size={13} />
              只读预览
            </span>
            <span>2.4 KB</span>
            <button onClick={onRun}>
              <Play size={13} />
              运行测试
            </button>
          </div>
        </section>
        <aside className="code-side-panel">
          <div className="code-side-head">
            <span>变更预览</span>
            <span className="diff-count">+8 -2</span>
          </div>
          <div className="diff-block">
            <div className="diff-line removed">- client.Send(event)</div>
            <div className="diff-line added">+ client.Send(ctx, event)</div>
            <div className="diff-line added">+ metrics.Inc("broadcast")</div>
          </div>
          <div className="code-side-section">
            <span className="section-kicker">RUN PROFILE</span>
            <div className="run-profile">
              <div>
                <Cpu size={15} />
                <span>Runner 02</span>
              </div>
              <small>Go 1.23 · 4 cores · 512 MB</small>
              <div className="run-policy">
                <ShieldCheck size={13} /> network deny
              </div>
            </div>
            <button className="primary-button full" onClick={onRun}>
              <Play size={15} />
              {jobStatus === "running" ? "运行中..." : "运行 go test ./..."}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
function TreeRow({
  icon,
  label,
  active,
  open,
  children,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <button
        className={`tree-row ${active ? "active" : ""} ${open ? "open" : ""}`}
      >
        <span className="tree-indent">
          {open ? <ChevronDown size={13} /> : <span />}
        </span>
        {icon}
        <span>{label}</span>
      </button>
      {open && <div className="tree-children">{children}</div>}
    </>
  );
}

function TasksView({
  jobStatus,
  onRun,
}: {
  jobStatus: JobStatus;
  onRun: () => void;
}) {
  const labels: Record<JobStatus, string> = {
    queued: "排队中",
    preparing: "准备中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    canceled: "已取消",
    timed_out: "已超时",
  };
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="执行 / 任务"
        title="每次运行都可追溯。"
        description="任务、日志和产物共享同一个资源模型。"
        action="新建任务"
        actionIcon={<Plus size={16} />}
      />
      <section className="task-overview">
        <div className="task-stat">
          <span>运行中</span>
          <strong>{jobStatus === "running" ? "1" : "0"}</strong>
          <small>Runner 02</small>
        </div>
        <div className="task-stat">
          <span>今日完成</span>
          <strong>18</strong>
          <small className="positive">94.4% 成功</small>
        </div>
        <div className="task-stat">
          <span>平均耗时</span>
          <strong>42s</strong>
          <small>过去 24 小时</small>
        </div>
        <div className="task-run-cta">
          <div>
            <span className="section-kicker">SAFE EXECUTION</span>
            <strong>默认无网络</strong>
            <small>所有任务运行在隔离节点</small>
          </div>
          <button className="primary-button" onClick={onRun}>
            <Play size={15} />
            运行示例任务
          </button>
        </div>
      </section>
      <section className="surface-panel task-panel">
        <div className="task-panel-head">
          <div>
            <span className="section-kicker">RECENT JOBS</span>
            <h3>最近任务</h3>
          </div>
          <div className="segmented small">
            <button className="selected">全部</button>
            <button>我的任务</button>
            <button>失败</button>
          </div>
        </div>
        <div className="task-list">
          <TaskRow
            id="job_01J8K3"
            command="go test ./..."
            project="api-gateway"
            status={jobStatus}
            statusLabel={labels[jobStatus]}
            duration="42s"
            runner="Runner 02"
          />
          <TaskRow
            id="job_01J8JZ"
            command="pnpm build"
            project="web"
            status="succeeded"
            statusLabel="成功"
            duration="1m 18s"
            runner="Runner 01"
          />
          <TaskRow
            id="job_01J8JS"
            command="go vet ./..."
            project="api-gateway"
            status="failed"
            statusLabel="失败"
            duration="8s"
            runner="Runner 02"
          />
        </div>
      </section>
    </div>
  );
}
function TaskRow({
  id,
  command,
  project,
  status,
  statusLabel,
  duration,
  runner,
}: {
  id: string;
  command: string;
  project: string;
  status: JobStatus;
  statusLabel: string;
  duration: string;
  runner: string;
}) {
  return (
    <div className="task-row">
      <div className={`task-status ${status}`}>
        <span />
      </div>
      <div className="task-main">
        <strong>{command}</strong>
        <small>
          {project} · {id}
        </small>
      </div>
      <span className={`status-text ${status}`}>{statusLabel}</span>
      <span className="task-duration">{duration}</span>
      <span className="task-runner">
        <Cpu size={13} />
        {runner}
      </span>
      <button className="icon-button" aria-label="打开任务">
        <ArrowUpRight size={15} />
      </button>
    </div>
  );
}

function PluginsView({
  plugins,
  onToggle,
  onAction,
}: {
  plugins: typeof pluginSeed;
  onToggle: (id: string) => void;
  onAction: (message: string) => void;
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="系统 / 插件"
        title="让工作台持续生长。"
        description="每个能力都有自己的权限、版本和健康状态。"
        action="安装插件"
        actionIcon={<Plus size={16} />}
      />
      <div className="plugin-banner">
        <div className="plugin-banner-icon">
          <Sparkles size={20} />
        </div>
        <div>
          <strong>插件运行时已就绪</strong>
          <p>4 个官方插件正在运行，API 版本 1.0 兼容。</p>
        </div>
        <button
          className="text-action"
          onClick={() => onAction("插件开发文档已打开")}
        >
          开发 SDK <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="plugin-grid">
        {plugins.map((plugin) => {
          const Icon = plugin.icon;
          return (
            <section className="surface-panel plugin-card" key={plugin.id}>
              <div className="plugin-card-head">
                <div className={`plugin-icon ${plugin.color}`}>
                  <Icon size={18} />
                </div>
                <div className="plugin-health">
                  <span className="online-dot" />
                  健康
                </div>
                <button
                  className="icon-button"
                  aria-label={`${plugin.name} 更多操作`}
                  onClick={() => onAction(`${plugin.name} 的更多操作`)}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
              <strong>{plugin.name}</strong>
              <p>{plugin.desc}</p>
              <div className="plugin-meta">
                <span>{plugin.id}</span>
                <span>v{plugin.version}</span>
              </div>
              <div className="plugin-card-footer">
                <span>{plugin.enabled ? "已启用" : "已禁用"}</span>
                <button
                  className={`toggle ${plugin.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`启用 ${plugin.name}`}
                  onClick={() => onToggle(plugin.id)}
                >
                  <span />
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default App;
