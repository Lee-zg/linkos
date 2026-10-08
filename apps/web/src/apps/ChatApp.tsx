import { useCallback, useEffect, useState } from "react";
import type { ChatChannel } from "@linkos/protocol";
import { Hash, MessageCircle, Pencil, Plus, Search } from "lucide-react";
import { listChannels } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { NewConversation } from "./chat/NewConversation";
import { Conversation } from "./chat/Conversation";

export function ChatApp() {
  const { connected, chatVersion } = useWorkspace();
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await listChannels();
      setChannels(result.items);
      setSelected((current) =>
        result.items.some((item) => item.id === current)
          ? current
          : (result.items[0]?.id ?? ""),
      );
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (connected) void refresh();
    else setLoading(false);
  }, [connected, refresh]);
  useEffect(() => {
    if (connected && chatVersion) void refresh();
  }, [chatVersion, connected, refresh]);
  const channel = channels.find((item) => item.id === selected);
  return (
    <div className="messages-app">
      <aside className={`messages-sidebar ${sidebar ? "is-open" : ""}`}>
        <div className="messages-sidebar-title">
          <h2>信息</h2>
          <button
            aria-label="创建频道"
            title="新建会话"
            onClick={() => setCreating(true)}
            disabled={!connected}
          >
            <Pencil size={17} />
          </button>
        </div>
        <label className="messages-search">
          <Search size={14} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <div className="messages-section-label">
          工作区会话 <span>{channels.length}</span>
        </div>
        <nav aria-label="聊天频道" className="messages-conversations">
          {channels
            .filter((item) =>
              item.name.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((item, index) => (
              <button
                key={item.id}
                className={`conversation-row ${selected === item.id ? "is-selected" : ""}`}
                onClick={() => {
                  setSelected(item.id);
                  setSidebar(false);
                }}
                aria-current={selected === item.id ? "page" : undefined}
              >
                <span
                  className={`conversation-avatar avatar-tone-${index % 4}`}
                >
                  {item.kind === "direct" ? (
                    item.name.slice(0, 1)
                  ) : (
                    <Hash size={21} />
                  )}
                </span>
                <span className="conversation-label">
                  <strong>{item.name}</strong>
                  <small>
                    {item.kind === "direct"
                      ? "私密会话"
                      : "分享想法、文件与代码"}
                  </small>
                </span>
              </button>
            ))}
          {loading && <p className="messages-empty-small">正在加载会话…</p>}
          {loadError && (
            <button
              className="messages-empty-small"
              onClick={() => void refresh()}
            >
              加载失败，点击重试
            </button>
          )}
          {!loading && !loadError && channels.length === 0 && (
            <p className="messages-empty-small">创建一个频道，开始协作。</p>
          )}
        </nav>
        <div className="messages-sidebar-footer">
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          {connected ? "工作区已连接" : "正在等待连接"}
        </div>
      </aside>
      {channel ? (
        <Conversation
          key={channel.id}
          channel={channel}
          showSidebar={() => setSidebar(true)}
        />
      ) : (
        <div className="messages-welcome">
          <MessageCircle size={48} strokeWidth={1} />
          <h3>让想法在这里相遇</h3>
          <p>文字、文件和代码，一个会话就够了。</p>
          <button onClick={() => setCreating(true)} disabled={!connected}>
            <Plus size={15} />
            创建频道
          </button>
        </div>
      )}
      {creating && (
        <NewConversation
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setChannels((current) =>
              current.some((old) => old.id === item.id)
                ? current
                : [...current, item],
            );
            setSelected(item.id);
            setCreating(false);
            setSidebar(false);
          }}
        />
      )}
    </div>
  );
}
