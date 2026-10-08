import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ChatChannel,
  ChatMessage,
  FilePreferences,
} from "@linkos/protocol";
import {
  Check,
  ChevronLeft,
  Download,
  MessageCircle,
  MessageSquareReply,
  Pencil,
  Search,
  Settings2,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  deleteMessage,
  editMessage,
  getFilePreferences,
  listMessages,
  listThreadMessages,
  setReceiveFolder,
} from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWorkspace } from "../../lib/workspace";
import { useToast } from "../../os/Toaster";
import { Modal } from "../FileActions";
import { FolderPicker } from "../files/FolderPicker";
import { MessageContent } from "./MessageContent";
import { Composer } from "./Composer";

export function Conversation({
  channel,
  showSidebar,
}: {
  channel: ChatChannel;
  showSidebar: () => void;
}) {
  const { connected, chatVersion } = useWorkspace();
  const { profile } = useSession();
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<ChatMessage | null>(null);
  const [threadItems, setThreadItems] = useState<ChatMessage[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preferences, setPreferences] = useState<FilePreferences | null>(null);
  const [settings, setSettings] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [editBody, setEditBody] = useState("");
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const request = useRef(0);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const refresh = useCallback(
    async (append = false, next = "") => {
      const generation = ++request.current;
      setLoading(true);
      setError("");
      try {
        if (thread) {
          const result = await listThreadMessages(thread.id);
          if (generation === request.current) setThreadItems(result.items);
        } else {
          const result = await listMessages({
            channelId: channel.id,
            q: query || undefined,
            cursor: append ? next : undefined,
            limit: 100,
            newest: true,
          });
          result.items.reverse();
          if (generation === request.current) {
            if (append && listRef.current) {
              scrollAnchor.current = {
                height: listRef.current.scrollHeight,
                top: listRef.current.scrollTop,
              };
              stickToBottom.current = false;
            }
            setMessages((current) =>
              append
                ? [
                    ...result.items.filter(
                      (item) => !current.some((old) => old.id === item.id),
                    ),
                    ...current,
                  ].slice(0, 500)
                : result.items,
            );
            setCursor(result.nextCursor ?? "");
          }
        }
      } catch (err) {
        if (generation === request.current)
          setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (generation === request.current) setLoading(false);
      }
    },
    [channel.id, query, thread],
  );
  useEffect(() => {
    if (connected) void refresh();
    else setLoading(false);
    return () => {
      request.current++;
    };
  }, [connected, refresh]);
  useEffect(() => {
    if (chatVersion) void refresh();
  }, [chatVersion, refresh]);
  useEffect(() => {
    if (connected)
      void getFilePreferences()
        .then(setPreferences)
        .catch(() => undefined);
  }, [connected]);
  const visible = thread ? threadItems : messages;
  useLayoutEffect(() => {
    const list = listRef.current;
    const anchor = scrollAnchor.current;
    if (list && anchor) {
      list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    }
  }, [visible]);
  useEffect(() => {
    if (!query && stickToBottom.current)
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [visible, query]);
  const modify = async (action: () => Promise<unknown>) => {
    setMutationBusy(true);
    try {
      await action();
      setEditing(null);
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast("操作失败", String(err));
    } finally {
      setMutationBusy(false);
    }
  };
  return (
    <section className="messages-conversation">
      <header className="messages-header">
        <button
          className="messages-back"
          aria-label="会话列表"
          onClick={showSidebar}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="messages-header-avatar">
          {channel.kind === "direct" ? (
            <MessageCircle size={20} />
          ) : (
            <Users size={20} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3>{channel.name}</h3>
          <p>
            {thread
              ? "回复线程"
              : channel.kind === "direct"
                ? "私密会话"
                : "团队频道"}{" "}
            · {connected ? "在线" : "离线"}
          </p>
        </div>
        <button
          aria-label="聊天设置"
          title="文件接收设置"
          onClick={() => setSettings(true)}
        >
          <Settings2 size={18} />
        </button>
      </header>
      <div className="messages-filter">
        <Search size={13} />
        <input
          aria-label="搜索消息"
          placeholder="搜索此会话中的消息"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing)
              setQuery(search.trim());
          }}
        />
        <span>↵</span>
        {search && (
          <button
            aria-label="清除搜索"
            onClick={() => {
              setSearch("");
              setQuery("");
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {!connected && (
        <div className="messages-notice" role="status">
          当前离线，草稿已保存在此浏览器。
        </div>
      )}
      {thread && (
        <div className="messages-thread-banner">
          <MessageSquareReply size={15} />
          <span>
            回复 {thread.authorName}：{thread.body || "附件"}
          </span>
          <button aria-label="关闭线程" onClick={() => setThread(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        className="messages-timeline"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {!thread &&
          cursor &&
          (messages.length < 500 ? (
            <button
              className="messages-load-more"
              disabled={loading}
              onClick={() => void refresh(true, cursor)}
            >
              加载更早的消息
            </button>
          ) : (
            <p className="messages-empty-small">
              已显示 500 条消息，可搜索更早的内容。
            </p>
          ))}
        {error && (
          <div className="messages-notice" role="alert">
            {error}
            <button onClick={() => void refresh()}>重试</button>
          </div>
        )}
        {loading && visible.length === 0 && (
          <div className="messages-empty-small">正在加载消息…</div>
        )}
        {!loading && visible.length === 0 && (
          <div className="messages-empty">
            <MessageCircle size={38} strokeWidth={1.2} />
            <h4>{query ? "没有匹配消息" : "对话，从一句问候开始"}</h4>
            <p>{query ? "试试其他关键词" : "拖入文件，或分享一段代码。"}</p>
          </div>
        )}
        {visible.map((message, index) => {
          const own = message.authorId === profile.userId;
          const canModify =
            own || profile.role === "admin" || profile.role === "owner";
          const date = new Date(message.createdAt).toLocaleDateString();
          const newDate =
            index === 0 ||
            date !==
              new Date(visible[index - 1].createdAt).toLocaleDateString();
          return (
            <div key={message.id}>
              {newDate && (
                <div className="message-date">
                  {new Date(message.createdAt).toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                  })}
                </div>
              )}
              <article className={`message-row ${own ? "own" : ""}`}>
                {!own && (
                  <div className="message-avatar">
                    {message.authorName.slice(0, 1)}
                  </div>
                )}
                <div className="message-stack">
                  <div className="message-author">
                    {own ? "你" : message.authorName}
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    {message.editedAt && <span>已编辑</span>}
                  </div>
                  <div className="message-bubble">
                    <MessageContent message={message} own={own} />
                  </div>
                  <div className="message-actions">
                    <button
                      aria-label="回复线程"
                      onClick={() => {
                        setThread(message);
                        setThreadItems([]);
                      }}
                    >
                      <MessageSquareReply size={12} />
                      回复
                    </button>
                    {canModify && (
                      <>
                        <button
                          aria-label="编辑消息"
                          onClick={() => {
                            setEditing(message);
                            setEditBody(message.body);
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          aria-label="删除消息"
                          onClick={() => setDeleting(message)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                    {own && (
                      <span>
                        <Check size={11} />
                        已发送
                      </span>
                    )}
                  </div>
                </div>
              </article>
            </div>
          );
        })}
      </div>
      <Composer
        key={`${channel.id}:${thread?.id ?? "main"}`}
        channelId={channel.id}
        threadId={thread?.id}
        preferences={preferences}
        onSent={async () => {
          stickToBottom.current = true;
          await refresh();
        }}
      />
      {settings && (
        <Modal title="文件接收设置" onClose={() => setSettings(false)}>
          <div className="receive-settings">
            <Download size={28} />
            <h4>文件自动归档，随时可找</h4>
            <p>
              收到的附件会自动保存到你的 LinkOS 文件目录。默认目录为 Downloads。
            </p>
            <div className="receive-location">
              {preferences?.receiveFolderId === preferences?.downloadsId
                ? "Downloads"
                : "自定义接收目录"}
            </div>
            <button
              disabled={!preferences}
              onClick={() => {
                setSettings(false);
                setChoosingFolder(true);
              }}
            >
              更改接收目录
            </button>
            <button
              disabled={!preferences}
              onClick={() =>
                void setReceiveFolder("")
                  .then(setPreferences)
                  .catch((err) => toast("设置失败", String(err)))
              }
            >
              恢复默认目录
            </button>
            <small>下载到本机的位置由浏览器的下载设置决定。</small>
          </div>
        </Modal>
      )}
      {choosingFolder && (
        <FolderPicker
          title="选择接收文件夹"
          onClose={() => setChoosingFolder(false)}
          onChoose={async (id) => {
            if (!id) throw new Error("请选择一个文件夹");
            setPreferences(await setReceiveFolder(id));
            toast("接收目录已更新");
          }}
        />
      )}
      {editing && (
        <Modal
          title="编辑消息"
          busy={mutationBusy}
          onClose={() => setEditing(null)}
        >
          <textarea
            aria-label="消息内容"
            className="w-full rounded-lg border p-2 text-sm"
            rows={5}
            value={editBody}
            onChange={(event) => setEditBody(event.target.value)}
          />
          <button
            className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white"
            disabled={mutationBusy || !editBody.trim()}
            onClick={() =>
              void modify(() => editMessage(editing.id, editBody.trim()))
            }
          >
            保存
          </button>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除消息"
          alert
          busy={mutationBusy}
          onClose={() => setDeleting(null)}
        >
          <p className="text-sm">删除这条消息？已经接收的文件仍会保留。</p>
          <button
            className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm text-white"
            disabled={mutationBusy}
            onClick={() => void modify(() => deleteMessage(deleting.id))}
          >
            删除
          </button>
        </Modal>
      )}
    </section>
  );
}
