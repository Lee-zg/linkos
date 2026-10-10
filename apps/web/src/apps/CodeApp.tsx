import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodeConflict, CodeFile } from "@linkos/protocol";
import {
  AlertTriangle,
  Copy,
  FileCode2,
  Folder,
  Play,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  ApiError,
  getGatewayBase,
  getCodeFile,
  listCodeFiles,
  saveCodeFile,
  saveCodeFileAs,
} from "../lib/api";
import { readDraft, writeDraft, removeDraft } from "../lib/draft-storage";
import { useSession } from "../lib/session";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";
import { CodeEditor } from "./CodeEditor";

const DRAFT_PREFIX = "linkos.code.draft.";

export function CodeApp() {
  const { connected, jobStatus, runTask } = useWorkspace();
  const { profile } = useSession();
  const draftPrefix = `${DRAFT_PREFIX}${JSON.stringify([getGatewayBase(), profile.workspaceId, profile.userId])}.`;
  const toast = useToast();
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [file, setFile] = useState<CodeFile | null>(null);
  const [content, setContent] = useState("");
  const [baseVersion, setBaseVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<CodeConflict | null>(null);
  const [preview, setPreview] = useState<{
    lineEnd: number;
    totalLines: number;
    hasDraft: boolean;
  } | null>(null);
  const running =
    jobStatus === "running" ||
    jobStatus === "preparing" ||
    jobStatus === "queued";
  const readOnly =
    loading ||
    preview !== null ||
    !connected ||
    (file?.size ?? 0) > 5 * 1024 * 1024;

  const openFile = useCallback(
    async (next: CodeFile) => {
      setLoading(true);
      setConflict(null);
      try {
        const loaded = await getCodeFile(next.id);
        const draftKey = `${draftPrefix}${next.id}.${loaded.file.version}`;
        const draft = readDraft(draftKey);
        setFile(loaded.file);
        writeDraft(`${draftPrefix}active`, loaded.file.id);
        setBaseVersion(loaded.file.version);
        setPreview(
          loaded.truncated
            ? {
                lineEnd: loaded.lineEnd,
                totalLines: loaded.totalLines,
                hasDraft: draft !== null,
              }
            : null,
        );
        setContent(
          loaded.truncated ? loaded.content : (draft ?? loaded.content),
        );
        setDirty(
          !loaded.truncated && draft !== null && draft !== loaded.content,
        );
      } catch {
        toast("代码加载失败", "请检查权限和网关连接。");
      } finally {
        setLoading(false);
      }
    },
    [toast, draftPrefix],
  );

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    void listCodeFiles()
      .then((result) => {
        setFiles(result.items);
        const selected = readDraft(`${draftPrefix}active`);
        const next =
          result.items.find((item) => item.id === selected) ?? result.items[0];
        if (next) return openFile(next);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        toast("代码目录加载失败");
      });
  }, [connected, openFile, toast]);

  useEffect(() => {
    if (!file || !dirty) return;
    writeDraft(`${draftPrefix}${file.id}.${baseVersion}`, content);
  }, [baseVersion, content, dirty, file, draftPrefix]);

  const acceptVersion = (version: string) => {
    if (file) {
      removeDraft(`${draftPrefix}${file.id}.${baseVersion}`);
      setFile({ ...file, version, size: new Blob([content]).size });
    }
    setBaseVersion(version);
    setDirty(false);
    setConflict(null);
  };

  const save = async (force = false) => {
    if (!file || !dirty || readOnly) return;
    setSaving(true);
    try {
      const version = await saveCodeFile(file.id, content, baseVersion, force);
      acceptVersion(version.version);
      toast("已保存", `版本 ${version.version}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setConflict(error.details as unknown as CodeConflict);
      else
        toast(
          "保存失败",
          error instanceof Error ? error.message : "请检查权限和连接。",
        );
    } finally {
      setSaving(false);
    }
  };

  const saveAs = async () => {
    if (!file || readOnly) return;
    const path = window.prompt(
      "另存为项目内路径",
      file.path.replace(/(\.[^/.]+)?$/, "-copy$1"),
    );
    if (!path?.trim()) return;
    try {
      const result = await saveCodeFileAs({
        projectId: file.projectId,
        path: path.trim(),
        language: file.language,
        content,
      });
      setFiles((current) => [...current, result.file]);
      await openFile(result.file);
      toast("已另存为", result.file.path);
    } catch (error) {
      toast("另存失败", error instanceof Error ? error.message : "路径不可用");
    }
  };

  const lineCount = useMemo(() => content.split("\n").length, [content]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-52 shrink-0 flex-col border-r bg-muted/30 sm:flex">
        <div className="border-b px-3 py-3">
          <p className="m-0 text-sm font-semibold">api-gateway</p>
          <p className="m-0 mt-1 font-mono text-[10px] text-muted-foreground">
            project_gateway · {files.length} files
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-1 flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <Folder size={13} /> source
          </div>
          {files.map((item) => (
            <button
              key={item.id}
              onClick={() => void openFile(item)}
              className={`flex w-full items-center gap-2 rounded-md border-none px-2 py-1.5 text-left font-mono text-xs ${file?.id === item.id ? "bg-accent font-medium" : "bg-transparent text-muted-foreground hover:bg-accent/60"}`}
            >
              <FileCode2 size={13} className="shrink-0" />
              <span className="truncate">{item.path}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span className="min-w-0 truncate font-mono text-xs">
            <FileCode2 size={13} className="mr-1.5 inline" />
            {file?.path ?? "未选择文件"}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-accent"
              title="复制代码"
              aria-label="复制代码"
              onClick={() =>
                void navigator.clipboard
                  .writeText(content)
                  .then(() => toast("代码已复制"))
              }
            >
              <Copy size={14} />
            </button>
            <button
              className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-accent disabled:opacity-40"
              title="保存"
              aria-label="保存"
              disabled={!dirty || saving || readOnly}
              onClick={() => void save()}
            >
              <Save size={14} />
            </button>
            <button
              className="flex h-7 items-center gap-1.5 rounded-md border-none bg-primary px-2.5 text-xs text-primary-foreground disabled:opacity-40"
              onClick={() => void runTask()}
              disabled={!connected || running}
            >
              <Play size={13} />
              运行
            </button>
          </div>
        </div>
        {conflict && (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs"
            role="alert"
          >
            <AlertTriangle size={14} className="text-warning-foreground" />
            <span className="min-w-0 flex-1">
              服务器版本为 {conflict.current?.version}，当前草稿基于{" "}
              {conflict.baseVersion}。
            </span>
            <button
              className="rounded-md border bg-background px-2 py-1"
              onClick={() => file && void openFile(file)}
            >
              加载服务器版本
            </button>
            <button
              className="rounded-md border bg-background px-2 py-1"
              onClick={() => void saveAs()}
            >
              另存为
            </button>
            {(profile.role === "admin" || profile.role === "owner") && (
              <button
                className="rounded-md bg-destructive px-2 py-1 text-destructive-foreground"
                onClick={() => {
                  if (
                    window.confirm(
                      "覆盖服务器当前版本？此操作会创建新的审计版本。",
                    )
                  )
                    void save(true);
                }}
              >
                覆盖保存
              </button>
            )}
          </div>
        )}
        {!connected && (
          <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning-foreground">
            网关离线，草稿仍会保存在本机。
          </div>
        )}
        {preview && !loading && (
          <div
            className="border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
            role="alert"
          >
            仅预览前 {preview.lineEnd} 行，共 {preview.totalLines}{" "}
            行。内容未完整加载，已禁用编辑和保存，避免丢失未加载内容。
            {preview.hasDraft && "本机草稿已保留，未自动恢复。"}
          </div>
        )}
        <div className="flex items-center gap-4 border-b px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span>
            {preview
              ? "截断预览"
              : dirty
                ? "草稿已自动保存"
                : `已同步 ${baseVersion || "-"}`}
          </span>
          <span>{file?.language || "text"}</span>
          <span className="ml-auto">{lineCount} lines</span>
        </div>
        <div className="min-h-0 flex-1 bg-muted/20">
          {loading ? (
            <p className="p-4 text-xs text-muted-foreground">加载代码...</p>
          ) : file ? (
            <CodeEditor
              value={content}
              language={file.language}
              readOnly={readOnly}
              onChange={(next) => {
                setContent(next);
                setDirty(true);
              }}
            />
          ) : (
            <p className="p-4 text-xs text-muted-foreground">
              项目中没有代码文件。
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t px-3 py-2 text-[10px] text-muted-foreground">
          <span>{readOnly ? "只读" : "可编辑"}</span>
          <span>
            {file ? `${Math.max(1, Math.round(file.size / 1024))} KB` : "-"}
          </span>
          <span className="ml-auto">UTF-8</span>
          {saving && <RefreshCw size={11} className="animate-spin" />}
        </div>
      </div>
    </div>
  );
}
