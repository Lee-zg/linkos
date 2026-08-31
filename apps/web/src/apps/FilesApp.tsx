import { useState } from "react";
import {
  Archive,
  FileCode2,
  FileText,
  Folder,
  MoreHorizontal,
  UploadCloud,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useToast } from "../os/Toaster";

const files: Array<{
  name: string;
  icon: LucideIcon;
  size: string;
  meta: string;
  progress: number | null;
}> = [
  { name: "release-candidate.tar.gz", icon: Archive, size: "1.82 GB", meta: "周予 · 5 分钟前", progress: 100 },
  { name: "api-gateway", icon: Folder, size: "28 items", meta: "林墨 · 今天 09:41", progress: null },
  { name: "design-system.md", icon: FileText, size: "42 KB", meta: "陈一 · 昨天", progress: null },
  { name: "runner-matrix.json", icon: FileCode2, size: "8 KB", meta: "自动同步 · 昨天", progress: null },
  { name: "demo-recording.mp4", icon: Video, size: "486 MB", meta: "周予 · 周二", progress: 62 },
];

export function FilesApp() {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState("最近");
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex rounded-lg border bg-muted/50 p-0.5">
          {["最近", "共享目录", "传输队列"].map((label) => (
            <button
              key={label}
              className={`cursor-pointer rounded-md border-none px-3 py-1.5 text-xs ${
                tab === label
                  ? "bg-background font-medium shadow-sm"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab(label)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          工作区 / 最近资源
        </span>
      </div>
      <button
        className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4 text-left transition-colors ${
          uploading ? "border-foreground/40 bg-muted" : "bg-transparent hover:bg-muted/60"
        }`}
        onClick={() => {
          setUploading(true);
          window.setTimeout(() => setUploading(false), 2600);
          toast("文件已加入传输队列");
        }}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-foreground/70">
          <UploadCloud size={17} />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-medium">
            {uploading ? "正在准备分片..." : "拖放文件到这里"}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            或点击选择，单文件最大 10 GB
          </span>
        </span>
      </button>
      <div className="divide-y rounded-lg border bg-card px-4">
        {files.map((file) => {
          const Icon = file.icon;
          return (
            <div className="flex items-center gap-3 py-3" key={file.name}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
                <Icon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm font-medium">{file.name}</p>
                <p className="m-0 truncate text-xs text-muted-foreground">
                  {file.meta}
                </p>
              </div>
              <span className="hidden w-20 shrink-0 text-xs text-muted-foreground sm:block">
                {file.size}
              </span>
              {file.progress !== null && file.progress < 100 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {file.progress}%
                </span>
              )}
              <button
                className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-accent"
                aria-label={`更多 ${file.name}`}
                onClick={() => toast(`${file.name} 的更多操作`)}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
