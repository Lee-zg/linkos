import { useEffect, useState } from "react";
import type { JobArtifact, JobStatus } from "@linkos/protocol";
import { Box, Cpu, Download, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { cancelJob, getJob, listJobArtifacts, listJobLogs, listRunners } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

const statusLabels: Record<JobStatus, string> = { queued: "排队中", preparing: "准备中", running: "运行中", succeeded: "成功", failed: "失败", canceled: "已取消", timed_out: "已超时" };
const activeStatuses: JobStatus[] = ["queued", "preparing", "running"];

export function TasksApp() {
  const { connected, jobStatus, currentJobId, runTask } = useWorkspace();
  const toast = useToast();
  const [runnerSummary, setRunnerSummary] = useState("检测中...");
  const [logs, setLogs] = useState<Array<{ seq: number; level: string; chunk: string }>>([]);
  const [artifacts, setArtifacts] = useState<JobArtifact[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const running = activeStatuses.includes(jobStatus);

  useEffect(() => {
    if (!connected) return;
    const refresh = () => void listRunners().then((result) => { const online = result.items.filter((runner) => runner.status === "online").length; setRunnerSummary(`${online}/${result.items.length} 在线`); }).catch(() => setRunnerSummary("不可用"));
    refresh(); const timer = window.setInterval(refresh, 10_000); return () => window.clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    if (!currentJobId) { setLogs([]); setArtifacts([]); return; }
    const refresh = async () => {
      const [job, logPage, artifactPage] = await Promise.all([getJob(currentJobId), listJobLogs(currentJobId), listJobArtifacts(currentJobId)]);
      setLogs(logPage.items); setArtifacts(artifactPage.items);
      return job.status;
    };
    void refresh().catch(() => undefined);
    if (!running) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 500);
    return () => window.clearInterval(timer);
  }, [currentJobId, running]);

  const onRun = async () => {
    if (!window.confirm("任务将在隔离容器中执行，默认无网络。确认提交 go test ./...？")) return;
    setSubmitting(true);
    try {
      const id = await runTask();
      if (id) toast("任务已提交", id);
      else toast("Runner 不可用", "请检查 Runner 注册、容器运行时和网关配置。");
    } finally { setSubmitting(false); }
  };
  const onCancel = async () => {
    if (!currentJobId) return;
    try { await cancelJob(currentJobId); toast("取消请求已发送", currentJobId); }
    catch (error) { toast("取消失败", error instanceof Error ? error.message : "请稍后重试"); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted"><ShieldCheck size={16} /></span>
        <div className="min-w-0 flex-1"><p className="m-0 text-sm font-medium">隔离执行 · network deny</p><p className="m-0 mt-0.5 text-xs text-muted-foreground">只读根文件系统 · 非特权 · Runner {runnerSummary}</p></div>
        {running && currentJobId ? <button className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs hover:bg-accent" onClick={() => void onCancel()}><Square size={12} />取消</button> : <button className="flex h-8 items-center gap-1.5 rounded-md border-none bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40" disabled={!connected || submitting} onClick={() => void onRun()}>{submitting ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}运行测试</button>}
      </div>
      {!connected && <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning-foreground">网关离线，暂时无法提交或取消任务。</div>}
      <div className="grid shrink-0 grid-cols-3 divide-x border-b">
        <div className="px-4 py-3"><p className="m-0 text-[10px] text-muted-foreground">当前状态</p><p className="m-0 mt-1 text-sm font-semibold">{currentJobId ? statusLabels[jobStatus] : "暂无任务"}</p></div>
        <div className="px-4 py-3"><p className="m-0 text-[10px] text-muted-foreground">任务 ID</p><p className="m-0 mt-1 truncate font-mono text-xs">{currentJobId ?? "-"}</p></div>
        <div className="px-4 py-3"><p className="m-0 text-[10px] text-muted-foreground">节点</p><p className="m-0 mt-1 flex items-center gap-1 text-xs"><Cpu size={12} />{runnerSummary}</p></div>
      </div>
      <div className="grid min-h-0 flex-1 sm:grid-cols-[minmax(0,1fr)_220px]">
        <section className="min-h-0 overflow-auto bg-[#111310] p-3 font-mono text-xs leading-5 text-[#c9d6c2]" aria-label="任务日志">
          {logs.length === 0 ? <span className="text-white/40">{currentJobId ? "等待日志..." : "提交任务后日志会显示在这里"}</span> : logs.map((line) => <pre key={line.seq} className={`m-0 whitespace-pre-wrap break-words ${line.level === "error" ? "text-[#ff9f9f]" : ""}`}>{line.chunk}</pre>)}
          {running && <span className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-[#9bc88d]" />}
        </section>
        <aside className="min-h-0 overflow-auto border-l p-3"><div className="mb-2 flex items-center gap-2 text-xs font-medium"><Box size={13} />产物</div>{artifacts.length === 0 && <p className="text-xs text-muted-foreground">暂无产物</p>}{artifacts.map((artifact) => <a key={artifact.id} href={artifact.resourceId ? `/api/v1/files/${encodeURIComponent(artifact.resourceId)}/content` : undefined} className="flex items-center gap-2 border-b py-2 text-xs text-foreground no-underline"><Download size={13} /><span className="min-w-0 flex-1 truncate">{artifact.name}</span><span className="text-[10px] text-muted-foreground">{artifact.size} B</span></a>)}</aside>
      </div>
    </div>
  );
}
