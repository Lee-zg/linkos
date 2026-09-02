import { useMemo, useRef, useState } from "react";
import {
  Archive,
  Download,
  FileCode2,
  FileText,
  Folder,
  MoreHorizontal,
  UploadCloud,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";
import {
  downloadResource,
  loadUploadedFiles,
  rememberUploadedFile,
  uploadFile,
} from "../lib/uploads";
import type { UploadedFileRecord, UploadProgress } from "../lib/uploads";

const sharedFiles: Array<{
  name: string;
  icon: LucideIcon;
  size: string;
  meta: string;
}> = [
  {
    name: "api-gateway",
    icon: Folder,
    size: "28 items",
    meta: "林墨 · 今天 09:41",
  },
  {
    name: "design-system.md",
    icon: FileText,
    size: "42 KB",
    meta: "陈一 · 昨天",
  },
  {
    name: "runner-matrix.json",
    icon: FileCode2,
    size: "8 KB",
    meta: "自动同步 · 昨天",
  },
];

interface TransferState {
  key: string;
  name: string;
  progress: UploadProgress;
  error?: string;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const phaseLabel: Record<UploadProgress["phase"], string> = {
  hashing: "校验内容",
  uploading: "传输分片",
  finalizing: "合并校验",
};

export function FilesApp() {
  const { connected } = useWorkspace();
  const toast = useToast();
  const [tab, setTab] = useState("最近");
  const [records, setRecords] = useState<UploadedFileRecord[]>(() =>
    loadUploadedFiles(),
  );
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = transfers.some((item) => !item.error);

  const visibleFiles = useMemo(() => {
    if (tab === "共享目录") {
      return sharedFiles.map((file) => (
        <div className="flex items-center gap-3 py-3" key={file.name}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
            <file.icon size={16} />
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
        </div>
      ));
    }
    if (tab === "传输队列") {
      if (transfers.length === 0) return null;
      return transfers.map((transfer) => {
        const { progress } = transfer;
        const percent =
          progress.totalParts > 0
            ? Math.round((progress.sentParts / progress.totalParts) * 100)
            : 0;
        return (
          <div className="py-3" key={transfer.key}>
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
                <UploadCloud size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm font-medium">
                  {transfer.name}
                </p>
                <p className="m-0 truncate text-xs text-muted-foreground">
                  {transfer.error ??
                    `${phaseLabel[progress.phase]} · ${formatBytes(
                      progress.phase === "hashing"
                        ? progress.hashedBytes
                        : progress.sentBytes,
                    )}/${formatBytes(progress.totalBytes)}`}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {transfer.error ? "失败" : `${percent}%`}
              </span>
            </div>
            {!transfer.error && (
              <div className="mt-2 h-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-foreground/70 transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
          </div>
        );
      });
    }
    const recordRows = records.map((record) => (
      <div className="flex items-center gap-3 py-3" key={record.contentHash}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/70">
          <Archive size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-sm font-medium">{record.name}</p>
          <p className="m-0 truncate text-xs text-muted-foreground">
            {`sha256:${record.contentHash.slice(0, 12)}… · ${new Date(record.uploadedAt).toLocaleString()}`}
          </p>
        </div>
        <span className="hidden w-20 shrink-0 text-xs text-muted-foreground sm:block">
          {formatBytes(record.size)}
        </span>
        <button
          className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-accent"
          aria-label={`下载 ${record.name}`}
          onClick={() => {
            downloadResource(record.resourceId, record.name).catch(() => {
              toast(`${record.name} 下载失败`);
            });
          }}
        >
          <Download size={15} />
        </button>
      </div>
    ));
    if (recordRows.length === 0) return null;
    return recordRows;
  }, [tab, records, transfers, toast]);

  const startUploads = async (picked: File[]) => {
    if (picked.length === 0) return;
    for (const file of picked) {
      const key = `${file.name}:${file.size}:${Date.now()}`;
      setTransfers((current) => [
        ...current,
        {
          key,
          name: file.name,
          progress: {
            phase: "hashing",
            hashedBytes: 0,
            sentParts: 0,
            totalParts: 0,
            sentBytes: 0,
            totalBytes: file.size,
          },
        },
      ]);
      try {
        const record = await uploadFile(file, (progress) => {
          setTransfers((current) =>
            current.map((item) =>
              item.key === key ? { ...item, progress } : item,
            ),
          );
        });
        rememberUploadedFile(record);
        setRecords(loadUploadedFiles());
        setTransfers((current) =>
          current.filter((item) => item.key !== key),
        );
        toast(`${file.name} 上传完成`);
      } catch (error) {
        setTransfers((current) =>
          current.map((item) =>
            item.key === key
              ? {
                  ...item,
                  error: error instanceof Error ? error.message : "上传失败",
                }
              : item,
          ),
        );
        toast(`${file.name} 上传失败`);
      }
    }
  };

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
        <span className="text-xs text-muted-foreground">工作区 / 最近资源</span>
      </div>
      {!connected && (
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          网关离线，文件列表保持只读；连接恢复后可继续上传。
        </div>
      )}
      <button
        className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          busy
            ? "border-foreground/40 bg-muted"
            : "bg-transparent hover:bg-muted/60"
        }`}
        onClick={() => {
          if (!busy && connected) inputRef.current?.click();
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (connected && event.dataTransfer.files.length > 0) {
            void startUploads(Array.from(event.dataTransfer.files));
          }
        }}
        aria-busy={busy}
        aria-disabled={!connected}
        disabled={!connected || busy}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-foreground/70">
          <UploadCloud size={17} />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-medium">
            {busy ? "正在传输分片..." : "拖放文件到这里"}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            或点击选择，8 MiB 分片、4 路并发、断点续传
          </span>
        </span>
      </button>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        onChange={(event) => {
          const picked = event.target.files;
          if (connected && picked?.length) {
            void startUploads(Array.from(picked));
          }
          event.currentTarget.value = "";
        }}
        aria-label="选择要上传的文件"
      />
      <div className="divide-y rounded-lg border bg-card px-4">
        {visibleFiles === null ? (
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center">
            <Folder size={20} className="text-muted-foreground" />
            <p className="m-0 text-sm font-medium">这里还没有文件</p>
            <p className="m-0 text-xs text-muted-foreground">
              {tab === "传输队列" ? "上传文件后这里显示传输进度" : "拖入文件即可开始传输"}
            </p>
          </div>
        ) : (
          visibleFiles
        )}
      </div>
    </div>
  );
}
