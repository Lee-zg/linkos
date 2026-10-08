import { useState } from "react";
import { ArrowUp, Folder } from "lucide-react";
import { Modal } from "../FileActions";
import { useFileBrowser } from "./useFileBrowser";

export function FolderPicker({
  title,
  onChoose,
  onClose,
  excludedIds = [],
}: {
  title: string;
  onChoose: (id: string) => Promise<void>;
  onClose: () => void;
  excludedIds?: string[];
}) {
  const browser = useFileBrowser({ persistPreferences: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <button
          aria-label="上一级"
          disabled={!browser.currentParentId}
          onClick={browser.goUp}
        >
          <ArrowUp size={16} />
        </button>
        <span className="truncate">
          {browser.ancestors.at(-1)?.name ?? "共享文件"}
        </span>
      </div>
      <div className="max-h-64 overflow-auto rounded-lg border p-1">
        {browser.items
          .filter((item) => item.type === "folder")
          .map((item) => (
            <button
              key={item.id}
              disabled={
                excludedIds.includes(item.id) ||
                item.meta?.systemLocation === "trash"
              }
              className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-muted disabled:opacity-40"
              onClick={() => browser.navigateTo(item.id)}
            >
              <Folder size={18} className="text-blue-500" />
              {item.name}
            </button>
          ))}
        {browser.loading && <p className="p-3 text-xs">加载中…</p>}
        {!browser.loading &&
          !browser.items.some((item) => item.type === "folder") && (
            <p className="p-3 text-xs text-muted-foreground">没有子文件夹</p>
          )}
        {browser.nextCursor && (
          <button
            className="p-2 text-xs"
            onClick={() => void browser.loadMore()}
          >
            加载更多
          </button>
        )}
      </div>
      {(error || browser.error) && (
        <p role="alert" className="my-2 text-xs text-red-600">
          {error || browser.error}
        </p>
      )}
      <button
        className="mt-3 w-full rounded-lg bg-blue-600 p-2 text-sm text-white disabled:opacity-40"
        disabled={busy || !browser.connected || !browser.canCreateChild}
        onClick={async () => {
          setBusy(true);
          try {
            await onChoose(browser.currentParentId);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "操作失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        选择此文件夹
      </button>
    </Modal>
  );
}
