import {
  ChevronDown,
  Copy,
  FileCode2,
  Folder,
  GitBranch,
  Play,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

const codeLines: Array<[string, string]> = [
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

function TreeRow({
  icon,
  label,
  active,
  depth = 0,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  depth?: number;
}) {
  return (
    <button
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-mono text-xs ${
        active
          ? "bg-accent font-medium"
          : "bg-transparent text-muted-foreground hover:bg-accent/60"
      }`}
      style={{ paddingLeft: 8 + depth * 14 }}
      aria-current={active ? "page" : undefined}
    >
      <span className="shrink-0 text-foreground/50">{icon}</span>
      {label}
    </button>
  );
}

export function CodeApp() {
  const { connected, jobStatus, runTask } = useWorkspace();
  const toast = useToast();
  const running = jobStatus === "running" || jobStatus === "preparing";
  const onRun = () => {
    toast("任务已进入 Runner 队列", "go test ./... · Runner 02");
    void runTask();
  };
  return (
    <div className="flex h-full">
      <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/30 sm:flex">
        <div className="px-3 pt-3 pb-2">
          <p className="m-0 text-sm font-semibold">api-gateway</p>
          <button className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-md border bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground">
            <GitBranch size={12} />
            main
            <ChevronDown size={12} className="ml-auto" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-2">
          <TreeRow icon={<Folder size={13} />} label="cmd" />
          <TreeRow icon={<Folder size={13} />} label="internal" />
          <TreeRow icon={<Folder size={13} />} label="events" depth={1} />
          <TreeRow icon={<FileCode2 size={13} />} label="hub.go" depth={1} />
          <TreeRow
            icon={<FileCode2 size={13} />}
            label="websocket.go"
            depth={1}
            active
          />
          <TreeRow icon={<Folder size={13} />} label="storage" />
          <TreeRow icon={<FileCode2 size={13} />} label="go.mod" />
          <TreeRow icon={<FileCode2 size={13} />} label="README.md" />
        </div>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          main · 已同步 3 分钟前
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 items-center gap-2 border-b px-3">
          <span className="flex items-center gap-1.5 border-b-2 border-foreground px-1 font-mono text-xs leading-[38px]">
            <FileCode2 size={13} className="text-foreground/60" />
            websocket.go
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-accent"
              aria-label="复制代码"
              onClick={() => toast("代码已复制到剪贴板")}
            >
              <Copy size={14} />
            </button>
            <button
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-none bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onRun}
              disabled={!connected || running}
              aria-label={running ? "运行测试中" : "运行测试"}
            >
              {running ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {running ? "运行中..." : "运行测试"}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4 border-b px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span>未提交修改</span>
          <span>UTF-8</span>
          <span>Go</span>
          <span className="ml-auto">Ln 9, Col 4</span>
        </div>
        {!connected && (
          <div
            className="border-b bg-warning/10 px-4 py-2 text-xs text-warning-foreground"
            role="alert"
          >
            网关离线，代码保持只读；连接恢复后可继续运行任务。
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto bg-muted/20 py-2 font-mono text-xs leading-6">
          {codeLines.map(([line, text], index) => (
            <div
              className={`grid grid-cols-[44px_1fr] pr-3 ${
                index === 8 ? "bg-accent" : ""
              }`}
              key={line}
            >
              <span className="pr-3 text-right text-foreground/30 select-none">
                {line}
              </span>
              <code className="whitespace-pre text-foreground/80">{text}</code>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>只读预览</span>
          <span>2.4 KB</span>
          <span className="ml-auto font-mono">+8 -2</span>
        </div>
      </div>
    </div>
  );
}
