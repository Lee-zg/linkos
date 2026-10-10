import { useEffect, useRef, useState } from "react";
import type {
  FilePreferences,
  MessageBlock,
  MessageCreateInput,
} from "@linkos/protocol";
import { ArrowUp, Code2, Paperclip, X } from "lucide-react";
import { getGatewayBase, getResource, sendMessage } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWorkspace } from "../../lib/workspace";
import { uploadFile } from "../../lib/uploads";
import { fileTransferPercent } from "../../lib/file-browser";
import { Modal } from "../FileActions";
import { readChatDraft } from "../../lib/chat-draft";
import { readDraft, writeDraft, removeDraft } from "../../lib/draft-storage";
import {
  queueUpload,
  pendingUploads,
  finishUpload,
} from "../../lib/paused-uploads";

export function Composer({
  channelId,
  threadId,
  preferences,
  onSent,
}: {
  channelId: string;
  threadId?: string;
  preferences: FilePreferences | null;
  onSent: () => Promise<void>;
}) {
  const { connected } = useWorkspace();
  const { profile } = useSession();
  const draftKey = `linkos.chat.draft:${JSON.stringify([getGatewayBase(), profile.workspaceId, profile.userId, channelId, threadId ?? ""])}`;
  const [draft] = useState(() => {
    try {
      return readChatDraft(readDraft(draftKey));
    } catch {
      return readChatDraft(null);
    }
  });
  const [body, setBody] = useState(draft.body);
  const [blocks, setBlocks] = useState<MessageBlock[]>(draft.blocks);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState(draft.code ?? "");
  const [language, setLanguage] = useState(draft.language ?? "typescript");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<MessageCreateInput | null>(
    draft.clientMsgId
      ? {
          body: draft.body,
          blocks: draft.blocks,
          channelId,
          threadId,
          clientMsgId: draft.clientMsgId,
        }
      : null,
  );
  const busy = useRef(false);
  const uploadingRef = useRef(false);
  const mounted = useRef(true);
  const uploadController = useRef<AbortController | null>(null);
  const [pausedCount, setPausedCount] = useState(
    () => pendingUploads(draftKey).length,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      if (body || blocks.length || code)
        writeDraft(
          draftKey,
          JSON.stringify({
            body,
            blocks,
            code,
            language,
            clientMsgId: pending.current?.clientMsgId,
          }),
        );
      else removeDraft(draftKey);
    } catch {
      /* storage can be disabled */
    }
  }, [body, blocks, code, language, draftKey, sending]);
  const attach = async (files: File[], parentId?: string) => {
    if (!connected || !preferences || uploadingRef.current || busy.current)
      return;
    if (files.length + blocks.length > 16) {
      setError("每条消息最多 16 个附件");
      return;
    }
    uploadingRef.current = true;
    const target = parentId ?? preferences.outgoingId;
    const controller = new AbortController();
    uploadController.current = controller;
    for (const file of files) queueUpload(draftKey, { file, parentId: target });
    setError("");
    try {
      for (const file of files) {
        controller.signal.throwIfAborted();
        setUploading(`正在准备 ${file.name}`);
        const record = await uploadFile(
          file,
          target,
          (progress) => {
            if (mounted.current)
              setUploading(
                `${file.name} · ${progress.phase === "hashing" ? "校验" : "上传"} ${fileTransferPercent(progress)}%`,
              );
          },
          undefined,
          controller.signal,
        );
        finishUpload(draftKey, file, target);
        const attachment: MessageBlock = {
          type: "file.reference",
          value: {
            resourceId: record.entryId,
            name: record.name,
            size: record.size,
          },
        };
        if (!mounted.current) {
          const saved = readChatDraft(readDraft(draftKey));
          writeDraft(
            draftKey,
            JSON.stringify({
              ...saved,
              blocks: [...saved.blocks, attachment].slice(0, 16),
            }),
          );
        }
        if (mounted.current) {
          setBlocks((current) => [
            ...current,
            {
              type: "file.reference",
              value: {
                resourceId: record.entryId,
                name: record.name,
                size: record.size,
              },
            },
          ]);
          pending.current = null;
        }
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : "上传失败，请重试");
    } finally {
      uploadingRef.current = false;
      if (mounted.current) {
        setUploading("");
        setPausedCount(pendingUploads(draftKey).length);
      }
    }
  };
  const submit = async () => {
    if (
      busy.current ||
      uploadingRef.current ||
      !connected ||
      (!body.trim() && !blocks.length)
    )
      return;
    busy.current = true;
    setSending(true);
    setError("");
    // Retain the exact payload/ID on failure; retries must not duplicate delivery.
    const payload = pending.current ?? {
      body: body.trim(),
      blocks,
      channelId,
      threadId,
      clientMsgId: crypto.randomUUID(),
    };
    pending.current = payload;
    try {
      await sendMessage(payload);
      try {
        removeDraft(draftKey);
      } catch {
        /* optional */
      }
      if (mounted.current) {
        setBody("");
        setBlocks([]);
        pending.current = null;
        await onSent();
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : "发送失败，请重试");
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const attachReferences = async (raw: string) => {
    if (!connected || busy.current || uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading("正在读取文件…");
    setError("");
    try {
      const ids: unknown = JSON.parse(raw);
      if (
        !Array.isArray(ids) ||
        ids.length + blocks.length > 16 ||
        ids.some((id) => typeof id !== "string")
      )
        throw new Error("每条消息最多 16 个附件");
      const items = await Promise.all(ids.map((id) => getResource(id)));
      if (items.some((item) => item.type !== "file" || item.canRead === false))
        throw new Error("请选择有读取权限的文件，暂不支持文件夹");
      if (mounted.current) {
        setBlocks((current) => [
          ...current,
          ...items.map((item) => ({
            type: "file.reference" as const,
            value: {
              resourceId: item.id,
              name: item.name,
              size: item.meta?.size,
            },
          })),
        ]);
        pending.current = null;
      }
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : "无法添加文件");
    } finally {
      uploadingRef.current = false;
      if (mounted.current) setUploading("");
    }
  };
  return (
    <div
      className={`messages-compose ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        if (
          event.dataTransfer.types.some(
            (type) => type === "Files" || type === "application/x-linkos-files",
          )
        ) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const raw = event.dataTransfer.getData("application/x-linkos-files");
        if (raw) void attachReferences(raw);
        else void attach(Array.from(event.dataTransfer.files));
      }}
    >
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {uploading && (
        <div className="composer-progress" role="status">
          <span />
          {uploading}
        </div>
      )}
      {pausedCount > 0 && !uploading && (
        <button
          className="px-3 py-2 text-xs"
          disabled={!connected || sending}
          onClick={() => {
            const items = pendingUploads(draftKey);
            const parent = items[0]?.parentId;
            if (parent !== undefined)
              void attach(
                items
                  .filter((item) => item.parentId === parent)
                  .map((item) => item.file),
                parent,
              );
          }}
        >
          继续暂停的附件上传（{pausedCount}）
        </button>
      )}
      {blocks.length > 0 && (
        <div className="composer-attachments">
          {blocks.map((block, index) => (
            <div key={index}>
              {block.type === "file.reference" ? (
                <Paperclip size={13} />
              ) : (
                <Code2 size={13} />
              )}
              <span>
                {String(block.value.name ?? block.value.language ?? "代码")}
              </span>
              <button
                aria-label="移除附件"
                disabled={sending || !!uploading}
                onClick={() => {
                  setBlocks((current) => current.filter((_, i) => i !== index));
                  pending.current = null;
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-input">
        <textarea
          aria-label="消息输入"
          placeholder={threadId ? "回复线程…" : "发送信息…"}
          rows={2}
          value={body}
          disabled={sending}
          maxLength={65536}
          onChange={(event) => {
            setBody(event.target.value);
            pending.current = null;
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              void attach(Array.from(event.clipboardData.files));
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="composer-send"
          aria-label="发送消息"
          disabled={
            !connected ||
            sending ||
            !!uploading ||
            (!body.trim() && !blocks.length)
          }
          onClick={() => void submit()}
        >
          <ArrowUp size={20} strokeWidth={2.5} />
        </button>
      </div>
      <div className="composer-toolbar">
        <button
          aria-label="发送文件"
          title="发送文件"
          disabled={!connected || !preferences || sending || !!uploading}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <button
          aria-label="发送代码"
          title="发送代码片段"
          disabled={sending || !!uploading || blocks.length >= 16}
          onClick={() => setCodeOpen(true)}
        >
          <Code2 size={19} />
        </button>
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择聊天附件"
        onChange={(event) => {
          void attach(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {codeOpen && (
        <Modal title="分享代码片段" onClose={() => setCodeOpen(false)}>
          <label className="mb-2 block text-xs">
            语言
            <select
              className="ml-2 rounded border p-1"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {[
                "typescript",
                "javascript",
                "python",
                "go",
                "rust",
                "html",
                "css",
                "json",
                "sql",
                "shell",
                "text",
              ].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="代码内容"
            spellCheck={false}
            className="code-composer"
            rows={10}
            value={code}
            maxLength={65536}
            onChange={(event) => setCode(event.target.value)}
            placeholder="在这里粘贴代码…"
          />
          <button
            className="mt-3 w-full rounded-lg bg-blue-600 p-2 text-sm text-white disabled:opacity-40"
            disabled={!code.trim()}
            onClick={() => {
              setBlocks((current) => [
                ...current,
                { type: "code.snippet", value: { content: code, language } },
              ]);
              pending.current = null;
              setCode("");
              setCodeOpen(false);
            }}
          >
            添加到消息
          </button>
        </Modal>
      )}
    </div>
  );
}
