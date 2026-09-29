import { Cpu, HardDrive, RefreshCw, Sparkles, Users, Wifi, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspace } from "../lib/workspace";

const activity = [
  {
    id: "a1",
    actor: "林墨",
    action: "更新了",
    target: "api-gateway / websocket.go",
    time: "刚刚",
  },
  {
    id: "a2",
    actor: "周予",
    action: "上传了",
    target: "release-candidate.tar.gz",
    time: "5 分钟前",
  },
  {
    id: "a3",
    actor: "Runner 02",
    action: "完成了",
    target: "go test ./...",
    time: "12 分钟前",
  },
  {
    id: "a4",
    actor: "陈一",
    action: "创建了频道",
    target: "#版本发布",
    time: "34 分钟前",
  },
];

function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="m-0 mt-2 text-2xl font-semibold">{value}</p>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{detail}</p>
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
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-muted text-foreground/70">
        <Cpu size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium">{name}</p>
        <p className="m-0 text-xs text-muted-foreground">{meta}</p>
      </div>
      <span
        className={`text-xs ${busy ? "text-warning-foreground" : "text-success-foreground"}`}
      >
        {status}
      </span>
    </div>
  );
}

export function SystemApp() {
  const { connected, lastSeq, resyncSeq } = useWorkspace();
  return (
    <div className="flex flex-col gap-4 p-4">
      {resyncSeq > 0 && (
        <div
          className="flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 p-3"
          role="status"
          data-testid="resync-indicator"
        >
          <span className="grid h-8 w-8 place-items-center rounded-full border text-foreground/70">
            <RefreshCw size={14} />
          </span>
          <div className="flex-1">
            <p className="m-0 text-sm font-medium">已按快照恢复会话</p>
            <p className="m-0 text-xs text-muted-foreground">
              历史事件超出重放窗口，已从服务端快照重建至事件 {resyncSeq}。
            </p>
          </div>
        </div>
      )}
      <div
        className={`flex items-center gap-3 rounded-lg border p-4 ${
          connected ? "bg-card" : "border-warning/40 bg-warning/10"
        }`}
        role="status"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full border text-foreground/70">
          <Wifi size={16} />
        </span>
        <div className="flex-1">
          <p className="m-0 text-sm font-medium">
            {connected ? "网络稳定" : "连接已断开"}
          </p>
          <p className="m-0 text-xs text-muted-foreground">
            Nimbus Lab ·{" "}
            {connected
              ? `局域网延迟 12 ms · 事件 ${lastSeq || "-"}`
              : "正在尝试重新连接..."}
          </p>
        </div>
        <span
          className={`text-sm font-medium ${connected ? "text-success-foreground" : "text-muted-foreground"}`}
        >
          {connected ? "在线" : "离线"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="在线成员"
          value="12"
          detail="+3 本周"
          icon={<Users size={14} />}
        />
        <Metric
          label="工作区文件"
          value="42.1 GB"
          detail="68 个资源"
          icon={<HardDrive size={14} />}
        />
        <Metric
          label="今日任务"
          value="18"
          detail="94.4% 成功"
          icon={<Zap size={14} />}
        />
        <Metric
          label="活跃插件"
          value="6 / 8"
          detail="全部健康"
          icon={<Sparkles size={14} />}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-4">
          <h3 className="m-0 text-sm font-semibold">最近动态</h3>
          <div className="mt-1 divide-y">
            {activity.map((item) => (
              <div className="flex items-center gap-3 py-2.5" key={item.id}>
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm">
                    <span className="font-medium">{item.actor}</span>{" "}
                    {item.action}{" "}
                    <span className="text-muted-foreground">{item.target}</span>
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.time}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-lg border bg-card p-4">
          <h3 className="m-0 text-sm font-semibold">Runner 节点</h3>
          <div className="mt-1 divide-y">
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
          </div>
          <div className="mt-3 border-t pt-3">
            <p className="m-0 text-xs text-muted-foreground">工作区存储</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <span className="block h-full w-[42%] rounded-full bg-foreground/70" />
            </div>
            <p className="m-0 mt-1.5 text-xs text-muted-foreground">
              42.1 GB / 100 GB
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
