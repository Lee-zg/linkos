import { useEffect, useState } from "react";
import type { ChatMessage } from "@linkos/protocol";
import { Check, Copy, Download, FileText, Loader2 } from "lucide-react";
import { receiveAttachments, type FileResource } from "../../lib/api";
import { formatFileSize } from "../../lib/file-browser";
import { downloadResource } from "../../lib/uploads";

export function MessageContent({
  message,
  own,
}: {
  message: ChatMessage;
  own: boolean;
}) {
  const [received, setReceived] = useState<FileResource[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiptLoaded, setReceiptLoaded] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const hasFiles = message.blocks?.some(
    (block) => block.type === "file.reference",
  );
  const receive = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await receiveAttachments(message.id);
      setReceived(result.items);
      setReceiptLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "接收失败");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (hasFiles && !own) void receive();
  }, [message.id, hasFiles, own]);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      {message.body && <div className="message-text">{message.body}</div>}
      {message.blocks?.map((block, index) => {
        if (block.type === "code.snippet")
          return (
            <div className="message-code" key={index}>
              <div className="message-code-bar">
                <span>{String(block.value.language || "代码")}</span>
                <button
                  aria-label="复制代码"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(String(block.value.content ?? ""))
                      .then(() => setCopied(index))
                      .catch(() => setError("无法访问剪贴板，请选中代码复制"))
                  }
                >
                  {copied === index ? <Check size={13} /> : <Copy size={13} />}
                  {copied === index ? "已复制" : "复制"}
                </button>
              </div>
              <pre tabIndex={0}>
                <code>{String(block.value.content ?? "")}</code>
              </pre>
            </div>
          );
        if (block.type === "file.reference") {
          const entry = received.find(
            (item) => item.meta?.contentHash === block.value.contentHash,
          );
          const name = String(block.value.name ?? "附件");
          const id = own ? String(block.value.resourceId ?? "") : entry?.id;
          return (
            <div className="message-file" key={index}>
              <div className="message-file-icon">
                <FileText size={23} strokeWidth={1.5} />
              </div>
              <div className="min-w-0 flex-1">
                <strong title={name}>{name}</strong>
                <small>
                  {formatFileSize(Number(block.value.size ?? 0))} ·{" "}
                  {own
                    ? "已发送"
                    : entry
                      ? "已保存至接收目录"
                      : busy
                        ? "正在接收…"
                        : receiptLoaded
                          ? "接收文件已移除或无法访问"
                          : "等待接收"}
                </small>
              </div>
              <button
                aria-label={`下载 ${name}`}
                disabled={!id}
                onClick={() =>
                  id &&
                  void downloadResource(id, name).catch((err) =>
                    setError(String(err)),
                  )
                }
              >
                {busy ? (
                  <Loader2 size={17} className="animate-spin" />
                ) : (
                  <Download size={17} />
                )}
              </button>
            </div>
          );
        }
        return (
          <pre className="message-legacy" key={index}>
            {block.type === "text"
              ? String(block.value.text ?? "")
              : JSON.stringify(block.value, null, 2)}
          </pre>
        );
      })}
      {error && (
        <div className="message-error" role="alert">
          {error}
          {hasFiles && !own && (
            <button disabled={busy} onClick={() => void receive()}>
              重试接收
            </button>
          )}
        </div>
      )}
    </>
  );
}
