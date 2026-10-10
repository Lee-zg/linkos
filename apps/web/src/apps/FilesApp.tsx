import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Grid3x3,
  Info,
  List,
  Loader2,
  MoreHorizontal,
  Move,
  Pencil,
  RefreshCw,
  Trash2,
  UploadCloud,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useToast } from "../os/Toaster";
import { useContextMenu, type ContextMenuItem } from "../os/ContextMenu";
import { isEditableElement } from "../os/context-menu";
import {
  downloadResource,
  loadUploadedFiles,
  rememberUploadedFile,
  uploadFile,
  type UploadedFileRecord,
  type UploadProgress,
} from "../lib/uploads";
import { useFileBrowser, type SortField } from "./files/useFileBrowser";
import {
  canGoBack,
  canGoForward,
  fileTransferPercent,
  formatFileSize,
  formatRelativeTime,
} from "../lib/file-browser";
import {
  createFolder,
  deleteResource,
  getResource,
  getFilePreferences,
  operateFiles,
  listResources,
  moveResource,
  updateResource,
  type FileResource,
} from "../lib/api";
import type { FilePreferences } from "@linkos/protocol";
import {
  Clock,
  Copy,
  Eye,
  HardDrive,
  ClipboardPaste,
  Undo2,
} from "lucide-react";
import { QuickLook } from "./files/QuickLook";
import { FolderPicker } from "./files/FolderPicker";
import { subscribeFileLocation } from "../lib/file-intent";
import { DeleteConfirm, InfoPanel, MoveDialog, NameForm } from "./FileActions";
import {
  pendingUploads,
  queueUpload,
  finishUpload,
} from "../lib/paused-uploads";
import { useSession } from "../lib/session";
import { getGatewayBase } from "../lib/api";

interface TransferState {
  key: string;
  name: string;
  progress: UploadProgress;
  error?: string;
}
type Tab = "shared" | "recent" | "local" | "transfers";
type ModalState =
  | { type: "none" }
  | { type: "createFolder"; parentId: string }
  | { type: "rename" | "delete" | "move"; resource: FileResource }
  | { type: "info"; resource: FileResource; path?: string; pathError?: string }
  | { type: "preview"; resource: FileResource }
  | { type: "batch-move"; ids: string[] };
type Command =
  | "open"
  | "rename"
  | "delete"
  | "move"
  | "info"
  | "new-folder"
  | "upload"
  | "refresh";
const iconButton =
  "grid h-8 w-8 shrink-0 place-items-center rounded-md border-none bg-transparent text-muted-foreground hover:bg-muted focus-visible:outline disabled:opacity-40";
const tabs: Array<{ key: Tab; label: string }> = [
  { key: "shared", label: "共享文件" },
  { key: "recent", label: "最近文件" },
  { key: "local", label: "本机历史" },
  { key: "transfers", label: "传输队列" },
];
const phaseLabel: Record<UploadProgress["phase"], string> = {
  hashing: "校验内容",
  uploading: "传输分片",
  finalizing: "合并校验",
};

function getFileIcon(resource: FileResource): LucideIcon {
  if (resource.type === "folder") return Folder;
  const name = resource.name.toLowerCase();
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(name)) return Video;
  if (
    /\.(ts|tsx|js|jsx|go|py|rs|java|c|cpp|h|json|yaml|yml|toml|xml|html|css|scss|md|mdx)$/.test(
      name,
    )
  )
    return FileCode2;
  if (/\.(txt|pdf|doc|docx)$/.test(name)) return FileText;
  return Archive;
}

export function FilesApp() {
  const { profile } = useSession();
  const transferScope = `files:${JSON.stringify([getGatewayBase(), profile.workspaceId, profile.userId])}`;
  const uploadControllers = useRef(new Set<AbortController>());
  const [pausedCount, setPausedCount] = useState(
    () => pendingUploads(transferScope).length,
  );
  const toast = useToast();
  const contextMenu = useContextMenu();
  const browser = useFileBrowser();
  const { connected } = browser;
  const [tab, setTab] = useState<Tab>("shared");
  const [modal, setModal] = useState<ModalState>({ type: "none" });
  const [records, setRecords] = useState<UploadedFileRecord[]>(() =>
    loadUploadedFiles(),
  );
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [preferences, setPreferences] = useState<FilePreferences | null>(null);
  const [clipboard, setClipboard] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const operationLock = useRef(false);
  const atTrashRoot = browser.currentParentId === preferences?.trashId;
  const inTrash =
    atTrashRoot ||
    browser.ancestors.some((item) => item.id === preferences?.trashId);
  useEffect(() => {
    if (connected)
      void getFilePreferences()
        .then(setPreferences)
        .catch(() => undefined);
  }, [connected]);
  useEffect(() => {
    if (!preferences) return;
    return subscribeFileLocation((location) => {
      setTab("shared");
      browser.navigateTo(
        location === "downloads"
          ? preferences.downloadsId
          : preferences.trashId,
      );
    });
  }, [preferences, browser.navigateTo]);
  const operation = async (
    action: "copy" | "move" | "trash" | "restore",
    ids: string[],
    parentId?: string,
  ) => {
    if (operationLock.current || !connected || !ids.length) return;
    operationLock.current = true;
    setBusy(true);
    try {
      await operateFiles({ action, ids, parentId });
      await browser.refresh();
      toast(
        {
          copy: "已复制",
          move: "已移动",
          trash: "已移到废纸篓",
          restore: "已放回原处",
        }[action],
      );
    } catch (error) {
      toast("文件操作失败", error instanceof Error ? error.message : "请重试");
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };
  const locationsId = useId();
  const locationsRef = useRef<HTMLElement>(null);
  const locationsButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadControllers.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    if (locationsOpen)
      locationsRef.current
        ?.querySelector<HTMLButtonElement>("button[aria-pressed=true]")
        ?.focus();
  }, [locationsOpen]);
  const closeLocations = () => {
    setLocationsOpen(false);
    locationsButtonRef.current?.focus();
  };
  const displayedItems = browser.items; // The server is authoritative for filtering and ordering.
  const isListing = tab === "shared" || tab === "recent";
  const canCreate =
    isListing &&
    !inTrash &&
    !browser.recent &&
    connected &&
    browser.canWrite &&
    browser.canCreateChild;
  const canMutate = (resource: FileResource) => {
    const state = browser.getCurrent();
    const latest = state.items.find((item) => item.id === resource.id);
    return (
      browser.isOnline() &&
      state.canWrite &&
      !!latest &&
      latest.canWrite !== false
    );
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    if (locationsOpen) closeLocations();
    if (next === "shared" || next === "recent")
      browser.setRecent(next === "recent");
  };
  const navigate = (parentId: string) => {
    setTab("shared");
    browser.navigateTo(parentId);
  };
  const directoryTitle =
    tab === "shared"
      ? (browser.ancestors.at(-1)?.name ?? "共享根目录")
      : tabs.find((item) => item.key === tab)!.label;
  const closeModal = () => setModal({ type: "none" });

  const execute = (command: Command, resource?: FileResource) => {
    if (command === "refresh") {
      void browser.refresh();
      return;
    }
    if (command === "new-folder" || command === "upload") {
      const current = browser.getCurrent();
      if (
        !canCreate ||
        !browser.isOnline() ||
        !current.canWrite ||
        !current.canCreateChild
      )
        return;
      if (command === "upload") inputRef.current?.click();
      else
        setModal({ type: "createFolder", parentId: current.currentParentId });
      return;
    }
    if (!resource) return;
    if (command === "info") {
      setModal({ type: "info", resource });
      return;
    }
    if (command === "open") {
      if (!browser.isOnline() || resource.canRead === false) return;
      if (resource.type === "folder") navigate(resource.id);
      else
        void downloadResource(resource.id, resource.name).catch((error) =>
          toast(
            error instanceof Error
              ? error.message
              : `${resource.name} 下载失败`,
          ),
        );
      return;
    }
    if (command === "delete" && !inTrash) {
      if (canMutate(resource))
        void operation(
          "trash",
          browser.selectedIds.has(resource.id)
            ? [...browser.selectedIds]
            : [resource.id],
        );
      return;
    }
    if (canMutate(resource)) setModal({ type: command, resource });
  };
  const menuItems = (resource?: FileResource): ContextMenuItem[] => {
    if (!resource)
      return [
        {
          id: "paste",
          label: "粘贴项目",
          icon: <ClipboardPaste size={14} />,
          disabled: !canCreate || !clipboard.length || busy,
          onClick: () =>
            void operation("copy", clipboard, browser.currentParentId),
        },
        {
          id: "paste-move",
          label: "将项目移到此处",
          icon: <Move size={14} />,
          disabled: !canCreate || !clipboard.length || busy,
          onClick: () =>
            void operation("move", clipboard, browser.currentParentId),
        },
        {
          id: "new-folder",
          label: "新建文件夹",
          icon: <FolderPlus size={14} />,
          disabled: !canCreate,
          onClick: () => execute("new-folder"),
        },
        {
          id: "upload",
          label: "上传文件",
          icon: <UploadCloud size={14} />,
          disabled: !canCreate,
          onClick: () => execute("upload"),
        },
        {
          id: "refresh",
          label: "刷新",
          icon: <RefreshCw size={14} />,
          disabled: !connected,
          onClick: () => execute("refresh"),
        },
        {
          id: "list",
          label: `列表视图${browser.viewMode === "list" ? "（已选中）" : ""}`,
          icon: <List size={14} />,
          onClick: () => browser.setViewMode("list"),
        },
        {
          id: "grid",
          label: `图标视图${browser.viewMode === "grid" ? "（已选中）" : ""}`,
          icon: <Grid3x3 size={14} />,
          onClick: () => browser.setViewMode("grid"),
        },
        ...(
          [
            ["name", "名称"],
            ["updatedAt", "修改时间"],
            ["size", "大小"],
          ] as const
        ).map(([field, label]) => ({
          id: `sort-${field}`,
          label: `按${label}排序${browser.sortField === field ? (browser.sortOrder === "asc" ? "（升序）" : "（降序）") : ""}`,
          disabled: !connected,
          onClick: () => browser.setSort(field),
        })),
      ];
    const writable = canMutate(resource);
    return [
      {
        id: "open",
        label: resource.type === "folder" ? "打开" : "下载",
        icon:
          resource.type === "folder" ? (
            <Folder size={14} />
          ) : (
            <Download size={14} />
          ),
        disabled: !connected || resource.canRead === false,
        onClick: () => execute("open", resource),
      },
      {
        id: "preview",
        label: "快速查看",
        icon: <Eye size={14} />,
        onClick: () => setModal({ type: "preview", resource }),
      },
      {
        id: "copy",
        label: "复制",
        icon: <Copy size={14} />,
        disabled: !connected,
        onClick: () =>
          setClipboard(
            browser.selectedIds.has(resource.id)
              ? [...browser.selectedIds]
              : [resource.id],
          ),
      },
      ...(atTrashRoot
        ? [
            {
              id: "restore",
              label: "放回原处",
              icon: <Undo2 size={14} />,
              disabled: !writable,
              onClick: () => void operation("restore", [resource.id]),
            },
          ]
        : []),
      {
        id: "rename",
        label: "重命名",
        icon: <Pencil size={14} />,
        disabled: !writable,
        onClick: () => execute("rename", resource),
      },
      {
        id: "move",
        label: "移动到...",
        icon: <Move size={14} />,
        disabled: !writable,
        onClick: () =>
          browser.selectedIds.has(resource.id) && browser.selectedIds.size > 1
            ? setModal({ type: "batch-move", ids: [...browser.selectedIds] })
            : execute("move", resource),
      },
      {
        id: "delete",
        label: inTrash ? "永久删除" : "移到废纸篓",
        icon: <Trash2 size={14} />,
        disabled: !writable,
        onClick: () => execute("delete", resource),
      },
      {
        id: "info",
        label: "显示简介",
        icon: <Info size={14} />,
        onClick: () => execute("info", resource),
      },
    ];
  };
  const openMenu = (
    event: MouseEvent<HTMLElement>,
    resource?: FileResource,
  ) => {
    if (isEditableElement(event.target as HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.focus();
    if (resource && !browser.selectedIds.has(resource.id))
      browser.select(resource.id);
    const rect = target.getBoundingClientRect();
    contextMenu.open(
      event.clientX || rect.left,
      event.clientY || rect.bottom,
      menuItems(resource),
      target,
    );
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      modal.type !== "none" ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      isEditableElement(event.target as HTMLElement)
    )
      return;
    if (locationsOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLocations();
      return;
    }
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>("[data-resource-id]");
    const resource = displayedItems.find(
      (item) =>
        item.id ===
        (element?.dataset.resourceId ?? [...browser.selectedIds][0]),
    );
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.stopPropagation();
      const rect = (element ?? target).getBoundingClientRect();
      contextMenu.open(
        rect.left,
        rect.bottom,
        menuItems(resource),
        element ?? target,
      );
      return;
    }
    if (target.closest("button, select") || !isListing) return;
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && ["a", "c", "v"].includes(key)) {
      event.preventDefault();
      if (key === "a") browser.selectAll();
      if (key === "c") setClipboard([...browser.selectedIds]);
      if (key === "v" && canCreate)
        void operation(
          event.altKey ? "move" : "copy",
          clipboard,
          browser.currentParentId,
        );
      return;
    }
    if (modifier && event.shiftKey && key === "n") {
      event.preventDefault();
      execute("new-folder");
      return;
    }
    if (modifier && event.key === "ArrowUp") {
      event.preventDefault();
      browser.goUp();
      return;
    }
    if (modifier && event.key === "ArrowDown" && resource) {
      event.preventDefault();
      execute("open", resource);
      return;
    }
    if (modifier && event.key === "[") {
      event.preventDefault();
      browser.goBack();
      return;
    }
    if (modifier && event.key === "]") {
      event.preventDefault();
      browser.goForward();
      return;
    }
    if (event.key === " " && resource) {
      event.preventDefault();
      setModal({ type: "preview", resource });
      return;
    }
    const command: Command | undefined =
      event.key === "F2" || event.key === "Enter"
        ? "rename"
        : event.key === "Delete" || (modifier && event.key === "Backspace")
          ? "delete"
          : undefined;
    if (command && resource) {
      event.preventDefault();
      event.stopPropagation();
      execute(command, resource);
    } else if (
      [
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      const nodes = [
        ...rootRef.current!.querySelectorAll<HTMLElement>("[data-resource-id]"),
      ];
      const index = nodes.findIndex(
        (node) => node.dataset.resourceId === resource?.id,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? nodes.length - 1
            : Math.max(
                0,
                Math.min(
                  nodes.length - 1,
                  index +
                    (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1),
                ),
              );
      if (nodes[next]) {
        event.preventDefault();
        nodes[next].focus();
        browser.select(
          nodes[next].dataset.resourceId!,
          modifier,
          event.shiftKey,
        );
      }
    } else if (event.key === "Escape") browser.clearSelection();
  };

  const infoId = modal.type === "info" ? modal.resource.id : null;
  useEffect(() => {
    if (!infoId) return;
    let cancelled = false;
    void (async () => {
      try {
        const resource = await getResource(infoId);
        const location = await listResources({
          scope: "files",
          parentId: resource.parentId ?? "",
          limit: 1,
        });
        if (!cancelled)
          setModal((current) =>
            current.type === "info" && current.resource.id === infoId
              ? {
                  ...current,
                  resource,
                  path: [
                    "共享根目录",
                    ...location.ancestors.map((a) => a.name),
                    resource.name,
                  ].join(" / "),
                }
              : current,
          );
      } catch (error) {
        if (!cancelled)
          setModal((current) =>
            current.type === "info"
              ? {
                  ...current,
                  pathError:
                    error instanceof Error ? error.message : "无法读取路径",
                }
              : current,
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [infoId, browser.ancestors]);

  const mutate = async (action: () => Promise<unknown>, message: string) => {
    await action();
    if (!mounted.current) return;
    closeModal();
    toast(message);
    await browser.refresh();
  };
  const assertWritable = (resource: FileResource) => {
    if (!canMutate(resource)) throw new Error("离线或无写入权限");
  };
  const startUploads = async (picked: File[], parentId?: string) => {
    if (
      (!canCreate && parentId === undefined) ||
      !connected ||
      picked.length === 0
    )
      return;
    const target = parentId ?? browser.getCurrent().currentParentId;
    const controller = new AbortController();
    uploadControllers.current.add(controller);
    picked.forEach((file) =>
      queueUpload(transferScope, { file, parentId: target }),
    );
    for (const file of picked) {
      if (controller.signal.aborted) break;
      const key = crypto.randomUUID();
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
        const record = await uploadFile(
          file,
          target,
          (progress) => {
            if (mounted.current)
              setTransfers((current) =>
                current.map((item) =>
                  item.key === key ? { ...item, progress } : item,
                ),
              );
          },
          undefined,
          controller.signal,
        );
        finishUpload(transferScope, file, target);
        rememberUploadedFile(record);
        if (mounted.current) {
          setRecords(loadUploadedFiles());
          setTransfers((current) => current.filter((item) => item.key !== key));
          toast(`${file.name} 上传完成`);
          void browser.refresh();
        }
      } catch (error) {
        if (mounted.current)
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
      }
    }
    uploadControllers.current.delete(controller);
    if (mounted.current) setPausedCount(pendingUploads(transferScope).length);
  };

  const renderItem = (resource: FileResource) => {
    const Icon = getFileIcon(resource);
    const grid = browser.viewMode === "grid";
    const selected = browser.selectedIds.has(resource.id);
    return (
      <div
        key={resource.id}
        role={grid ? "gridcell" : "row"}
        aria-label={resource.name}
        data-resource-id={resource.id}
        aria-selected={selected}
        tabIndex={0}
        className={`finder-item min-w-0 cursor-default select-none outline-offset-[-2px] ${grid ? "relative flex flex-col items-center gap-1 rounded-lg p-2 pt-9" : "flex items-center gap-2 border-b px-3 py-2"} ${selected ? "finder-selected" : "hover:bg-muted/50"}`}
        draggable={!busy && resource.meta?.systemLocation === undefined}
        onDragStart={(event) => {
          const ids = selected ? [...browser.selectedIds] : [resource.id];
          event.dataTransfer.setData(
            "application/x-linkos-files",
            JSON.stringify(ids),
          );
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={(event) => {
          if (resource.type === "folder" && resource.canCreateChild) {
            event.preventDefault();
            event.currentTarget.classList.add("finder-drop-target");
          }
        }}
        onDragLeave={(event) =>
          event.currentTarget.classList.remove("finder-drop-target")
        }
        onDrop={(event) => {
          event.currentTarget.classList.remove("finder-drop-target");
          if (resource.type !== "folder" || !resource.canCreateChild) return;
          const raw = event.dataTransfer.getData("application/x-linkos-files");
          if (raw) {
            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            try {
              void operation(
                event.altKey ? "copy" : "move",
                JSON.parse(raw),
                resource.id,
              );
            } catch {
              toast("无法读取拖拽项目");
            }
          }
        }}
        onClick={(event) => {
          event.currentTarget.focus();
          browser.select(
            resource.id,
            event.metaKey || event.ctrlKey,
            event.shiftKey,
          );
          if (
            resource.type === "folder" &&
            window.matchMedia("(max-width: 767px)").matches
          )
            execute("open", resource);
        }}
        onDoubleClick={() => {
          if (
            !window.matchMedia("(max-width: 767px)").matches ||
            resource.type !== "folder"
          )
            execute("open", resource);
        }}
        onContextMenu={(event) => openMenu(event, resource)}
      >
        <span
          className={`finder-file-icon ${resource.type === "folder" ? "finder-folder" : ""} grid shrink-0 place-items-center ${grid ? "h-14 w-14" : "h-8 w-8"}`}
        >
          <Icon size={grid ? 42 : 23} strokeWidth={1.4} />
        </span>
        <span
          role={grid ? undefined : "gridcell"}
          title={resource.name}
          className={`min-w-0 ${grid ? "line-clamp-2 w-full break-all text-center text-xs" : "flex-1 truncate text-sm"}`}
        >
          {resource.name}
        </span>
        {!grid && (
          <>
            <span
              role="gridcell"
              className="hidden w-24 shrink-0 text-xs text-muted-foreground md:block"
            >
              {formatRelativeTime(resource.updatedAt)}
            </span>
            <span
              role="gridcell"
              className="hidden w-16 shrink-0 text-xs text-muted-foreground md:block"
            >
              {resource.type === "folder" ? "文件夹" : "文件"}
            </span>
            <span
              role="gridcell"
              className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:block"
            >
              {resource.type === "folder"
                ? "—"
                : formatFileSize(Number(resource.meta?.size ?? 0))}
            </span>
          </>
        )}
        <button
          className={`${iconButton} ${grid ? "absolute right-1 top-1" : ""}`}
          aria-label={`更多操作 ${resource.name}`}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => openMenu(event, resource)}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
    );
  };
  const renderListing = () => (
    <>
      {browser.error && (
        <div className="p-4 text-sm">
          <p role="alert" className="break-words text-warning">
            {browser.error}
          </p>
          <button
            className="mt-2 rounded-md border px-3 py-1 text-xs"
            onClick={() => void browser.refresh()}
          >
            重试
          </button>
        </div>
      )}
      {browser.loading && !browser.hasLoaded && (
        <div
          role="status"
          aria-label="文件列表加载中"
          className="space-y-3 p-3"
        >
          <span className="sr-only">加载中...</span>
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              aria-hidden="true"
              className="flex animate-pulse items-center gap-3"
            >
              <div className="h-9 w-9 rounded-lg bg-muted" />
              <div className="h-3 w-1/2 rounded bg-muted" />
            </div>
          ))}
        </div>
      )}
      {browser.loading && browser.hasLoaded && (
        <div
          role="status"
          aria-label="正在刷新文件"
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
        >
          <Loader2 size={14} className="animate-spin" />
          正在刷新文件...
        </div>
      )}
      {browser.hasLoaded && !browser.error && !displayedItems.length && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 p-3">
          <Folder size={24} className="text-muted-foreground" />
          <p className="text-sm">
            {browser.searchQuery
              ? "无搜索结果"
              : browser.recent
                ? "暂无最近文件"
                : "此文件夹为空"}
          </p>
          <p className="text-xs text-muted-foreground">
            {browser.searchQuery
              ? "尝试不同的搜索词"
              : canCreate
                ? "拖入文件或点击上传"
                : "当前列表只读"}
          </p>
        </div>
      )}
      {!!displayedItems.length && (
        <div
          role="grid"
          aria-label="文件列表"
          aria-multiselectable="true"
          className={
            browser.viewMode === "grid"
              ? "grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 p-3"
              : ""
          }
        >
          {browser.viewMode === "list" && (
            <div
              role="row"
              className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground"
            >
              <span className="w-8 shrink-0" />
              <span
                role="columnheader"
                aria-sort={
                  browser.sortField === "name"
                    ? browser.sortOrder === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className="min-w-0 flex-1"
              >
                <button
                  className="w-full text-left"
                  onClick={() => browser.setSort("name")}
                >
                  名称{" "}
                  {browser.sortField === "name"
                    ? browser.sortOrder === "asc"
                      ? "↑"
                      : "↓"
                    : ""}
                </button>
              </span>
              <span
                role="columnheader"
                aria-sort={
                  browser.sortField === "updatedAt"
                    ? browser.sortOrder === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className="hidden w-24 shrink-0 md:block"
              >
                <button
                  className="w-full text-left"
                  onClick={() => browser.setSort("updatedAt")}
                >
                  修改时间
                </button>
              </span>
              <span
                role="columnheader"
                className="hidden w-16 shrink-0 md:block"
              >
                类型
              </span>
              <span
                role="columnheader"
                aria-sort={
                  browser.sortField === "size"
                    ? browser.sortOrder === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className="hidden w-16 shrink-0 md:block"
              >
                <button
                  className="w-full text-right"
                  onClick={() => browser.setSort("size")}
                >
                  大小
                </button>
              </span>
              <span className="w-8" />
            </div>
          )}
          {displayedItems.map(renderItem)}
        </div>
      )}
      {browser.nextCursor && (
        <div className="flex justify-center py-3">
          <button
            className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-40"
            disabled={browser.loading || !connected}
            onClick={() => void browser.loadMore()}
          >
            加载更多
          </button>
        </div>
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      className="finder-app flex h-full min-w-0 flex-col overflow-hidden"
      onKeyDown={handleKey}
      aria-busy={busy}
    >
      {!connected && (
        <div
          className="border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs"
          role="alert"
        >
          网关离线，文件列表保持只读；连接恢复后可继续上传。
        </div>
      )}
      {browser.notice && (
        <p role="status" className="border-b px-3 py-2 text-xs">
          {browser.notice}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1 border-b p-2">
        <div className="flex w-full min-w-0 items-center gap-2 pb-1">
          <button
            ref={locationsButtonRef}
            className={`${iconButton} md:hidden`}
            aria-label="文件位置"
            aria-controls={locationsId}
            aria-expanded={locationsOpen}
            onClick={() =>
              locationsOpen ? closeLocations() : setLocationsOpen(true)
            }
          >
            <List size={15} />
          </button>
          <h2
            className="min-w-0 truncate text-sm font-medium"
            title={directoryTitle}
          >
            {directoryTitle}
          </h2>
        </div>
        <button
          className={iconButton}
          aria-label="后退"
          disabled={!canGoBack(browser)}
          onClick={() => {
            setTab("shared");
            browser.goBack();
          }}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="前进"
          disabled={!canGoForward(browser)}
          onClick={() => {
            setTab("shared");
            browser.goForward();
          }}
        >
          <ArrowRight size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="上一级"
          disabled={!browser.currentParentId}
          onClick={() => {
            setTab("shared");
            browser.goUp();
          }}
        >
          <ArrowUp size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="列表视图"
          aria-pressed={browser.viewMode === "list"}
          onClick={() => browser.setViewMode("list")}
        >
          <List size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="图标视图"
          aria-pressed={browser.viewMode === "grid"}
          onClick={() => browser.setViewMode("grid")}
        >
          <Grid3x3 size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="新建文件夹"
          disabled={!canCreate}
          onClick={() => execute("new-folder")}
        >
          <FolderPlus size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="上传文件"
          disabled={!canCreate}
          onClick={() => execute("upload")}
        >
          <UploadCloud size={15} />
        </button>
        {pausedCount > 0 && (
          <button
            className="rounded border px-2 py-1 text-xs"
            disabled={!connected}
            onClick={() => {
              const items = pendingUploads(transferScope);
              const groups = new Map<string, File[]>();
              for (const item of items)
                groups.set(item.parentId, [
                  ...(groups.get(item.parentId) ?? []),
                  item.file,
                ]);
              for (const [parent, files] of groups)
                void startUploads(files, parent);
            }}
          >
            继续暂停的上传（{pausedCount}）
          </button>
        )}
        <button
          className={iconButton}
          aria-label="刷新"
          disabled={!connected}
          onClick={() => execute("refresh")}
        >
          <RefreshCw size={15} />
        </button>
        <button
          className={iconButton}
          aria-label="更多操作"
          onClick={(event) => openMenu(event)}
        >
          <MoreHorizontal size={15} />
        </button>
        <div className="flex w-full min-w-0 flex-wrap gap-2">
          <input
            className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs"
            aria-label="搜索文件"
            placeholder="搜索文件..."
            value={browser.searchQuery}
            onChange={(event) => browser.setSearch(event.target.value)}
          />
          <select
            className="min-w-0 rounded-md border bg-background px-1 text-xs"
            aria-label="排序方式"
            value={browser.sortField}
            onChange={(event) =>
              browser.setSort(
                event.target.value as SortField,
                browser.sortOrder,
              )
            }
          >
            <option value="name">名称</option>
            <option value="updatedAt">修改时间</option>
            <option value="size">大小</option>
          </select>
          <button
            className="rounded-md border px-2 text-xs"
            aria-label="排序方向"
            onClick={() => browser.setSort(browser.sortField)}
          >
            {browser.sortOrder === "asc" ? "升序" : "降序"}
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {locationsOpen && (
          <button
            className="absolute inset-0 z-10 border-none bg-black/20 md:hidden"
            aria-label="关闭文件位置"
            onClick={closeLocations}
          />
        )}
        <nav
          ref={locationsRef}
          id={locationsId}
          aria-label="文件位置"
          className={`finder-sidebar ${locationsOpen ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r bg-background p-2 py-3 shadow-lg md:static md:flex md:w-40 md:shadow-none`}
        >
          <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground">
            个人收藏
          </p>
          {preferences &&
            [
              { id: preferences.inboxId, label: "个人文件", Icon: HardDrive },
              {
                id: preferences.downloadsId,
                label: "Downloads",
                Icon: Download,
              },
              { id: preferences.outgoingId, label: "聊天附件", Icon: Folder },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`finder-location ${browser.currentParentId === id && tab === "shared" ? "is-active" : ""}`}
                aria-pressed={
                  browser.currentParentId === id && tab === "shared"
                }
                onClick={() => {
                  navigate(id);
                  if (locationsOpen) closeLocations();
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          <p className="mt-3 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
            工作区
          </p>
          {tabs.map((item, index) => {
            const Icon = [Folder, Clock, HardDrive, UploadCloud][index];
            return (
              <button
                key={item.key}
                className={`finder-location ${tab === item.key && (item.key !== "shared" || !browser.currentParentId) ? "is-active" : ""}`}
                aria-pressed={
                  tab === item.key &&
                  (item.key !== "shared" || !browser.currentParentId)
                }
                onClick={() => {
                  switchTab(item.key);
                  if (item.key === "shared") navigate("");
                }}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
          {preferences && (
            <button
              className={`finder-location mt-auto ${inTrash ? "is-active" : ""}`}
              onClick={() => {
                navigate(preferences.trashId);
                if (locationsOpen) closeLocations();
              }}
            >
              <Trash2 size={16} />
              废纸篓
            </button>
          )}
        </nav>
        <div
          className={`finder-content min-h-0 min-w-0 flex-1 overflow-auto ${dragging ? "finder-drop-target" : ""}`}
          tabIndex={0}
          aria-label="文件内容"
          onContextMenu={(event) => openMenu(event)}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (
              target.closest(
                "[data-resource-id], button, input, select, textarea, a, [role=button]",
              ) ||
              isEditableElement(target)
            )
              return;
            browser.clearSelection();
            event.currentTarget.focus();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (canCreate) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!canCreate) return;
            const raw = event.dataTransfer.getData(
              "application/x-linkos-files",
            );
            if (raw) {
              try {
                void operation(
                  event.altKey ? "copy" : "move",
                  JSON.parse(raw),
                  browser.currentParentId,
                );
              } catch {
                toast("无法读取拖拽项目");
              }
            } else void startUploads(Array.from(event.dataTransfer.files));
          }}
        >
          {inTrash && (
            <div className="flex items-center justify-between border-b bg-muted/40 p-3 text-xs">
              <span>项目会保留在废纸篓，直到永久删除。</span>
              {atTrashRoot && (
                <button
                  className="rounded border px-2 py-1 disabled:opacity-40"
                  disabled={!browser.selectedIds.size || busy}
                  onClick={() =>
                    void operation("restore", [...browser.selectedIds])
                  }
                >
                  放回原处
                </button>
              )}
            </div>
          )}
          {isListing && renderListing()}
          {tab === "local" && (
            <div>
              <p className="p-3 text-xs text-muted-foreground">
                本机历史，仅此浏览器保存的上传记录；文件可能已移动或删除。
              </p>
              {records.map((record) => (
                <div
                  key={record.entryId ?? record.resourceId}
                  className="flex min-w-0 items-center gap-2 border-b px-3 py-2"
                >
                  <Archive size={16} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{record.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {(record.entryId ?? record.resourceId).slice(0, 16)} ·{" "}
                      {new Date(record.uploadedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    className={iconButton}
                    aria-label={`下载 ${record.name}`}
                    disabled={!connected}
                    onClick={() => {
                      if (browser.isOnline())
                        void downloadResource(
                          record.entryId ?? record.resourceId,
                          record.name,
                        ).catch((error) =>
                          toast(
                            error instanceof Error ? error.message : "下载失败",
                          ),
                        );
                    }}
                  >
                    <Download size={14} />
                  </button>
                </div>
              ))}
              {!records.length && (
                <p className="p-4 text-center text-sm">暂无本机历史</p>
              )}
            </div>
          )}
          {tab === "transfers" && (
            <div>
              {!transfers.length && (
                <p className="p-6 text-center text-sm">暂无传输任务</p>
              )}
              {transfers.map((transfer) => {
                const percent = fileTransferPercent(transfer.progress);
                return (
                  <div key={transfer.key} className="border-b p-3">
                    <div className="flex min-w-0 gap-2">
                      <UploadCloud size={16} className="shrink-0" />
                      <p className="min-w-0 flex-1 truncate text-sm">
                        {transfer.name}
                      </p>
                      <span className="text-xs">
                        {transfer.error ? "失败" : `${percent}%`}
                      </span>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      {transfer.error ??
                        `${phaseLabel[transfer.progress.phase]} · ${formatFileSize(transfer.progress.phase === "hashing" ? transfer.progress.hashedBytes : transfer.progress.sentBytes)}/${formatFileSize(transfer.progress.totalBytes)}`}
                    </p>
                    {!transfer.error && (
                      <div
                        role="progressbar"
                        aria-label={transfer.name}
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="mt-2 h-1 overflow-hidden rounded bg-muted"
                      >
                        <div
                          className="h-full bg-foreground/70"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <nav
        aria-label="文件路径"
        className="flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-t px-3 py-1 text-xs"
      >
        {[{ id: "", name: "共享根目录" }, ...browser.ancestors].map(
          (part, index, path) => (
            <span
              key={part.id}
              className="flex max-w-full shrink-0 items-center gap-1"
            >
              {index > 0 && (
                <ChevronRight
                  size={12}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <button
                className="max-w-48 truncate rounded px-1 py-0.5 hover:bg-muted"
                title={part.name}
                aria-current={
                  index === path.length - 1 ? "location" : undefined
                }
                onClick={() => navigate(part.id)}
              >
                {part.name}
              </button>
            </span>
          ),
        )}
      </nav>
      <div className="flex justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {isListing
            ? `${displayedItems.length} / ${browser.total} 个项目${browser.selectedIds.size ? ` · 已选择 ${browser.selectedIds.size} 项` : ""}`
            : tab === "local"
              ? `${records.length} 个本机历史`
              : `${transfers.length} 个传输任务`}
        </span>
        <span>{busy ? "正在处理…" : connected ? "已连接" : "离线"}</span>
      </div>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        aria-label="选择要上传的文件"
        onChange={(event) => {
          if (event.target.files)
            void startUploads(Array.from(event.target.files));
          event.currentTarget.value = "";
        }}
      />
      {modal.type === "createFolder" && (
        <NameForm
          title="新建文件夹"
          submitLabel="创建"
          disabled={!canCreate}
          onCancel={closeModal}
          onSubmit={(name) => {
            if (!canCreate || !browser.isOnline())
              throw new Error("离线或无写入权限");
            return mutate(
              () => createFolder({ name, parentId: modal.parentId }),
              `文件夹「${name}」已创建`,
            );
          }}
        />
      )}
      {modal.type === "rename" && (
        <NameForm
          title="重命名"
          initialValue={modal.resource.name}
          submitLabel="重命名"
          disabled={!canMutate(modal.resource)}
          onCancel={closeModal}
          onSubmit={(name) => {
            assertWritable(modal.resource);
            return mutate(
              () => updateResource(modal.resource.id, { name }),
              `已重命名为「${name}」`,
            );
          }}
        />
      )}
      {modal.type === "delete" && (
        <DeleteConfirm
          names={[modal.resource.name]}
          hasFolder={modal.resource.type === "folder"}
          disabled={!canMutate(modal.resource)}
          onCancel={closeModal}
          onConfirm={() => {
            assertWritable(modal.resource);
            return mutate(
              () =>
                deleteResource(
                  modal.resource.id,
                  modal.resource.type === "folder",
                ),
              `已删除「${modal.resource.name}」`,
            );
          }}
        />
      )}
      {modal.type === "move" && (
        <MoveDialog
          resource={modal.resource}
          disabled={!canMutate(modal.resource)}
          onCancel={closeModal}
          onMove={(target) => {
            assertWritable(modal.resource);
            return mutate(
              () => moveResource(modal.resource.id, target),
              `已移动「${modal.resource.name}」`,
            );
          }}
        />
      )}
      {modal.type === "info" && (
        <InfoPanel
          resource={{
            ...modal.resource,
            path: modal.path,
            pathError: modal.pathError,
          }}
          onClose={closeModal}
        />
      )}
      {modal.type === "preview" && (
        <QuickLook resource={modal.resource} onClose={closeModal} />
      )}
      {modal.type === "batch-move" && (
        <FolderPicker
          title="移动所选项目"
          excludedIds={modal.ids}
          onClose={closeModal}
          onChoose={async (parentId) => {
            await operateFiles({ action: "move", ids: modal.ids, parentId });
            await browser.refresh();
            toast("已移动所选项目");
          }}
        />
      )}
    </div>
  );
}
