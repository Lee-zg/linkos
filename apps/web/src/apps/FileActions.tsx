import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { formatFileSize, validateFileName } from "../lib/file-browser";
import type { FileResource } from "../lib/api";
import { useFileBrowser } from "./files/useFileBrowser";

const buttonClass = "rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40";
const primaryClass = "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-40";
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败";

export function Modal({ title, busy = false, onClose, children, alert = false }: {
  title: string; busy?: boolean; onClose: () => void; children: ReactNode; alert?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref.current!;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    const initial = panel.querySelector<HTMLElement>("[data-initial-focus]") ?? panel.querySelector<HTMLElement>("input, textarea") ?? focusable()[0] ?? panel;
    initial.focus();
    if (initial instanceof HTMLInputElement) initial.select();
    const onFocus = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) (focusable()[0] ?? panel).focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0] ?? panel;
        const last = elements[elements.length - 1] ?? panel;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-3"
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) onClose(); }}
      onContextMenu={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <div ref={ref} role={alert ? "alertdialog" : "dialog"} aria-label={title} aria-modal="true" aria-busy={busy} tabIndex={-1}
        className="max-h-[calc(100dvh-24px)] w-80 max-w-full overflow-auto rounded-xl border bg-background p-4 shadow-2xl outline-none">
        <div className="mb-3 flex items-center justify-between gap-2">
          {alert && <AlertTriangle size={16} className="shrink-0 text-warning" />}
          <h3 className="min-w-0 flex-1 text-sm font-medium">{title}</h3>
          <button className={buttonClass} disabled={busy} onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        {children}
      </div>
    </div>, document.body,
  );
}

export function NameForm({ title, initialValue = "", onSubmit, onCancel, submitLabel = "确认", disabled = false }: {
  title: string; initialValue?: string; onSubmit: (name: string) => void | Promise<void>; onCancel: () => void; submitLabel?: string; disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const validation = validateFileName(value);
  const message = error ?? (touched && !validation.valid ? validation.error ?? "名称无效" : null);
  const submit = async () => {
    if (disabled || submittingRef.current) return;
    if (!validation.valid) { setTouched(true); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try { await onSubmit(value.trim()); }
    catch (err) { setError(errorText(err)); }
    finally { submittingRef.current = false; setSubmitting(false); }
  };
  return <Modal title={title} busy={submitting} onClose={onCancel}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <input aria-label="名称" className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40"
        value={value} onChange={event => { setValue(event.target.value); setTouched(true); setError(null); }} disabled={submitting} aria-invalid={!!message} />
      {message && <p role="alert" className="mt-2 break-words text-xs text-warning">{message}</p>}
      {disabled && <p className="mt-2 text-xs text-muted-foreground">离线或无写入权限</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={buttonClass} onClick={onCancel} disabled={submitting}>取消</button>
        <button type="submit" className={primaryClass} disabled={submitting || disabled || !validation.valid}>{submitting ? "处理中..." : submitLabel}</button>
      </div>
    </form>
  </Modal>;
}

export function DeleteConfirm({ names, hasFolder, onConfirm, onCancel, disabled = false }: {
  names: string[]; hasFolder: boolean; onConfirm: () => void | Promise<void>; onCancel: () => void; disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setConfirming(true);
    setError(null);
    try { await onConfirm(); }
    catch (err) { setError(errorText(err)); }
    finally { pending.current = false; setConfirming(false); }
  };
  return <Modal title="确认删除" busy={confirming} onClose={onCancel} alert>
    <p className="mb-2 text-xs text-muted-foreground">以下项目将被永久删除，无法恢复：</p>
    <ul className="mb-2 max-h-32 overflow-y-auto rounded-md border px-3 py-2 text-xs">
      {names.map(name => <li key={name} className="truncate py-0.5">{name}</li>)}
    </ul>
    {hasFolder && <p className="mb-2 text-xs text-warning">文件夹包含的内容将一并删除。</p>}
    {error && <p role="alert" className="mb-2 break-words text-xs text-warning">{error}</p>}
    <div className="flex justify-end gap-2">
      <button data-initial-focus className={buttonClass} onClick={onCancel} disabled={confirming}>取消</button>
      <button className={primaryClass} onClick={() => void confirm()} disabled={confirming || disabled}>{confirming ? "删除中..." : "删除"}</button>
    </div>
  </Modal>;
}

export function InfoPanel({ resource, onClose }: {
  resource: Pick<FileResource, "name" | "type" | "updatedAt" | "createdAt" | "meta"> & { path?: string; pathError?: string };
  onClose: () => void;
}) {
  const fields = [
    ["名称", resource.name], ["类型", resource.type === "folder" ? "文件夹" : "文件"],
    ["修改时间", new Date(resource.updatedAt).toLocaleString("zh-CN")], ["创建时间", new Date(resource.createdAt).toLocaleString("zh-CN")],
    ["位置", resource.path ?? "读取路径中..."],
  ];
  if (resource.meta?.size !== undefined) fields.splice(2, 0, ["大小", formatFileSize(Number(resource.meta.size))]);
  return <Modal title="显示简介" onClose={onClose}>
    <dl className="space-y-2 text-xs">{fields.map(([label, value]) => <div key={label} className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-all text-right">{value}</dd>
    </div>)}</dl>
    {resource.pathError && <p role="alert" className="mt-2 text-xs text-warning">{resource.pathError}</p>}
    <div className="mt-4 flex justify-end"><button className={buttonClass} onClick={onClose}>关闭</button></div>
  </Modal>;
}

export function MoveDialog({ resource, onMove, onCancel, disabled = false }: {
  resource: FileResource; onMove: (targetParentId: string) => void | Promise<void>; onCancel: () => void; disabled?: boolean;
}) {
  const picker = useFileBrowser({ persistPreferences: false });
  const [moving, setMoving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const invalidPath = picker.currentParentId === resource.id || picker.ancestors.some(a => a.id === resource.id);
  const canMove = !disabled && picker.connected && !picker.loading && !picker.error && picker.canWrite && picker.canCreateChild && !invalidPath && picker.currentParentId !== (resource.parentId ?? "");
  const move = async () => {
    if (!canMove || pending.current) return;
    pending.current = true;
    setMoving(true);
    setError(null);
    try { await onMove(picker.currentParentId); }
    catch (err) { setError(errorText(err)); }
    finally { pending.current = false; setMoving(false); }
  };
  return <Modal title="移动到" busy={moving} onClose={onCancel}>
    <p className="mb-2 truncate text-xs">移动「{resource.name}」到</p>
    <nav aria-label="目标路径" className="mb-2 flex flex-wrap gap-1 text-xs">
      {[{ id: "", name: "共享根目录" }, ...picker.ancestors].map(part => <button key={part.id} className={buttonClass} disabled={moving}
        onClick={() => picker.navigateTo(part.id)}>{part.name}</button>)}
    </nav>
    <div className="max-h-52 overflow-y-auto rounded-md border">
      {picker.items.filter(item => item.type === "folder").map(folder => <button key={folder.id}
        className="block w-full truncate px-3 py-2 text-left text-xs hover:bg-muted disabled:opacity-40"
        disabled={moving || !picker.connected || invalidPath || folder.id === resource.id || folder.canRead === false || folder.canWrite === false || folder.canCreateChild === false}
        onClick={() => picker.navigateTo(folder.id)}>{folder.name}</button>)}
      {!picker.loading && !picker.items.some(item => item.type === "folder") && <p className="p-3 text-xs text-muted-foreground">没有子文件夹</p>}
      {picker.loading && <p className="p-3 text-xs">加载中...</p>}
      {picker.nextCursor && <button className={buttonClass} disabled={moving || picker.loading || !picker.connected} onClick={() => void picker.loadMore()}>加载更多</button>}
    </div>
    {(error || picker.error) && <p role="alert" className="mt-2 break-words text-xs text-warning">{error ?? picker.error}</p>}
    {picker.error && <button className={buttonClass} disabled={moving} onClick={() => void picker.refresh()}>重试</button>}
    {picker.notice && <p role="status" className="mt-2 text-xs">{picker.notice}</p>}
    <div className="mt-3 flex justify-end gap-2">
      <button className={buttonClass} onClick={onCancel} disabled={moving}>取消</button>
      <button className={primaryClass} onClick={() => void move()} disabled={moving || !canMove}>{moving ? "移动中..." : "移动"}</button>
    </div>
  </Modal>;
}
