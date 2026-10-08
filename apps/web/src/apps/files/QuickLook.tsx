import { useEffect, useState } from "react";
import { Download, FileText, Folder } from "lucide-react";
import { previewFile, type FileResource } from "../../lib/api";
import { downloadResource } from "../../lib/uploads";
import { formatFileSize } from "../../lib/file-browser";
import { Modal } from "../FileActions";

export function QuickLook({
  resource,
  onClose,
}: {
  resource: FileResource;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<{
    url?: string;
    text?: string;
    error?: string;
  }>({});
  const image = /\.(png|jpe?g|gif|webp|avif)$/i.test(resource.name);
  const text =
    /\.(txt|md|tsx?|jsx?|json|css|html|go|py|rs|yaml|yml|csv|log|sh)$/i.test(
      resource.name,
    );
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    if (resource.type === "file" && (image || text)) {
      void previewFile(resource.id, controller.signal)
        .then(async (blob) => {
          if (controller.signal.aborted) return;
          if (image) {
            url = URL.createObjectURL(blob);
            setPreview({ url });
          } else {
            const content = await blob.text();
            if (!controller.signal.aborted) setPreview({ text: content });
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setPreview({
              error: error instanceof Error ? error.message : "预览失败",
            });
        });
    }
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [resource.id, image, text]);
  return (
    <Modal title={resource.name} onClose={onClose}>
      <div className="quick-look-content">
        {preview.url ? (
          <img src={preview.url} alt={resource.name} />
        ) : preview.text !== undefined ? (
          <pre>{preview.text}</pre>
        ) : (
          <div className="flex flex-col items-center gap-3 py-10">
            {resource.type === "folder" ? (
              <Folder size={64} className="text-blue-400" />
            ) : (
              <FileText size={64} className="text-blue-400" />
            )}
            <p className="text-xs text-muted-foreground">
              {preview.error ??
                (resource.type === "folder"
                  ? "文件夹"
                  : image || text
                    ? "正在加载预览…"
                    : "此格式可下载后查看")}
            </p>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {resource.type === "folder"
            ? "文件夹"
            : formatFileSize(Number(resource.meta?.size ?? 0))}
        </span>
        {resource.type === "file" && (
          <button
            className="flex items-center gap-1 rounded-md border px-2 py-1"
            onClick={() =>
              void downloadResource(resource.id, resource.name).catch((error) =>
                setPreview({ error: String(error) }),
              )
            }
          >
            <Download size={13} />
            下载
          </button>
        )}
      </div>
      <p className="mt-3 text-center text-[10px] text-muted-foreground">
        Esc 关闭快速查看
      </p>
    </Modal>
  );
}
