import { Cpu, Play, RefreshCw, ShieldCheck } from "lucide-react";
import type { JobStatus } from "@linkos/protocol";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

const statusLabels: Record<JobStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
  timed_out: "已超时",
};

function statusColor(status: JobStatus) {
  if (status === "succeeded") return "text-success-foreground";
  if (status === "failed" || status === "timed_out")
    return "text-destructive-foreground";
  if (status === "canceled") return "text-muted-foreground";
  return "text-warning-foreground";
}

function TaskRow({
  id,
  command,
  project,
  status,
  duration,
  runner,
}: {
  id: string;
  command: string;
  project: string;
  status: JobStatus;
  duration: string;
  runner: string;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate font-mono text-sm">{command}</p>
        <p className="m-0 mt-0.5 text-xs text-muted-foreground">
          {project} · {id}
        </p>
      </div>
      <span className={`w-14 shrink-0 text-xs ${statusColor(status)}`}>
        {statusLabels[status]}
      </span>
      <span className="hidden w-14 shrink-0 text-xs text-muted-foreground sm:block">
        {duration}
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
        <Cpu size={12} />
        {runner}
      </span>
    </div>
  );
}

export function TasksApp() {
  const { jobStatus, runTask } = useWorkspace();
  const toast = useToast();
  const running = jobStatus === "running" || jobStatus === "preparing";
  const onRun = () => {
    toast("任务已进入 Runner 队列", "go test ./... · Runner 02");
    void runTask();
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="m-0 text-xs text-muted-foreground">运行中</p>
          <p className="m-0 mt-1.5 text-2xl font-semibold">
            {running ? "1" : "0"}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="m-0 text-xs text-muted-foreground">今日完成</p>
          <p className="m-0 mt-1.5 text-2xl font-semibold">18</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="m-0 text-xs text-muted-foreground">平均耗时</p>
          <p className="m-0 mt-1.5 text-2xl font-semibold">42s</p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
          <ShieldCheck size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-medium">默认无网络</p>
          <p className="m-0 mt-0.5 text-xs text-muted-foreground">
            所有任务运行在隔离节点，network deny
          </p>
        </div>
        <button
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-none bg-primary px-3 py-2 text-xs text-primary-foreground hover:opacity-90"
          onClick={onRun}
        >
          {running ? (
            <RefreshCw size={13} className="animate-spin" />
          ) : (
            <Play size={13} />
          )}
          运行示例任务
        </button>
      </div>
      <section className="rounded-lg border bg-card px-4 py-3">
        <h3 className="m-0 text-sm font-semibold">最近任务</h3>
        <div className="mt-1 divide-y">
          <TaskRow
            id="job_01J8K3"
            command="go test ./..."
            project="api-gateway"
            status={jobStatus}
            duration="42s"
            runner="Runner 02"
          />
          <TaskRow
            id="job_01J8JZ"
            command="pnpm build"
            project="web"
            status="succeeded"
            duration="1m 18s"
            runner="Runner 01"
          />
          <TaskRow
            id="job_01J8JS"
            command="go vet ./..."
            project="api-gateway"
            status="failed"
            duration="8s"
            runner="Runner 02"
          />
        </div>
      </section>
    </div>
  );
}
