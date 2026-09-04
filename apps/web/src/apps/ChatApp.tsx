import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatChannel, ChatMessage } from "@linkos/protocol";
import { MessageSquareReply, Pencil, Plus, Search, Send, Trash2, X } from "lucide-react";
import { createChannel, deleteMessage, editMessage, listChannels, listMessages, listThreadMessages, sendMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

export function ChatApp() {
  const { connected, lastEvent } = useWorkspace();
  const { profile } = useSession();
  const toast = useToast();
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<{ root: ChatMessage; items: ChatMessage[] } | null>(null);
  const [composer, setComposer] = useState("");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshMessages = useCallback(async (selected: string, query = "") => {
    if (!selected) return;
    setLoading(true);
    try {
      const result = await listMessages({ channelId: selected, q: query || undefined, limit: 100 });
      setMessages(result.items);
    } catch { toast("消息加载失败", "请检查网关连接与频道权限。"); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => {
    if (!connected) { setLoading(false); return; }
    void listChannels().then((result) => {
      setChannels(result.items);
      const next = channelId || result.items[0]?.id || "";
      setChannelId(next);
      return refreshMessages(next);
    }).catch(() => { setLoading(false); toast("频道加载失败"); });
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!lastEvent || !lastEvent.type.startsWith("chat.message.")) return;
    void refreshMessages(channelId, search);
    if (thread) void listThreadMessages(thread.root.id).then((result) => setThread({ ...thread, items: result.items }));
  }, [lastEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!search) void refreshMessages(channelId); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.length]);

  const submit = async () => {
    const body = composer.trim();
    if (!body || !connected || !channelId) return;
    try {
      await sendMessage({ body, channelId, threadId: thread?.root.id, clientMsgId: crypto.randomUUID() });
      setComposer("");
      await refreshMessages(channelId, search);
      if (thread) {
        const result = await listThreadMessages(thread.root.id);
        setThread({ ...thread, items: result.items });
      }
    } catch (error) { toast("发送失败", error instanceof Error ? error.message : "请稍后重试"); }
  };

  const runSearch = async () => { setSearching(true); await refreshMessages(channelId, search.trim()); setSearching(false); };
  const startThread = async (message: ChatMessage) => { const result = await listThreadMessages(message.id); setThread({ root: message, items: result.items }); };
  const modify = async (message: ChatMessage) => {
    const body = window.prompt("编辑消息", message.body);
    if (!body?.trim() || body === message.body) return;
    try { await editMessage(message.id, body.trim()); await refreshMessages(channelId, search); }
    catch (error) { toast("编辑失败", error instanceof Error ? error.message : "权限不足"); }
  };
  const remove = async (message: ChatMessage) => {
    if (!window.confirm("删除这条消息？删除操作会保留审计版本。")) return;
    try { await deleteMessage(message.id); await refreshMessages(channelId, search); }
    catch (error) { toast("删除失败", error instanceof Error ? error.message : "权限不足"); }
  };
  const addChannel = async () => {
    const name = window.prompt("新频道名称");
    if (!name?.trim()) return;
    try { const created = await createChannel({ name: name.trim() }); setChannels((current) => [...current, created]); setChannelId(created.id); await refreshMessages(created.id); }
    catch (error) { toast("创建失败", error instanceof Error ? error.message : "频道名称不可用"); }
  };

  const selected = channels.find((item) => item.id === channelId);
  const visible = thread ? thread.items : messages;
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/30 sm:flex">
        <div className="flex items-center px-3 py-2"><p className="m-0 flex-1 text-xs font-medium text-muted-foreground">频道</p><button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" onClick={() => void addChannel()} title="创建频道" aria-label="创建频道"><Plus size={14} /></button></div>
        <div className="min-h-0 flex-1 overflow-auto px-2">{channels.map((channel) => <button key={channel.id} className={`flex w-full items-center rounded-md border-none px-2 py-1.5 text-left text-sm ${channelId === channel.id ? "bg-accent font-medium" : "bg-transparent text-muted-foreground hover:bg-accent/60"}`} onClick={() => { setChannelId(channel.id); setThread(null); setSearch(""); void refreshMessages(channel.id); }}><span className="mr-1.5">{channel.kind === "direct" ? "@" : "#"}</span><span className="truncate">{channel.name}</span></button>)}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          {thread ? <button className="min-w-0 flex-1 truncate border-none bg-transparent text-left text-sm font-semibold" onClick={() => setThread(null)}># {selected?.name} / 线程</button> : <p className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{selected?.kind === "direct" ? "@" : "#"} {selected?.name ?? "频道"}</p>}
          {!thread && <div className="flex h-8 w-44 items-center gap-2 rounded-md border bg-background px-2"><Search size={13} className={searching ? "animate-pulse" : "text-muted-foreground"} /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} placeholder="搜索消息" aria-label="搜索消息" className="min-w-0 flex-1 border-none bg-transparent text-xs outline-none" />{search && <button className="grid h-5 w-5 place-items-center border-none bg-transparent" onClick={() => setSearch("")} aria-label="清除搜索"><X size={12} /></button>}</div>}
          {thread && <button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" onClick={() => setThread(null)} aria-label="关闭线程"><X size={14} /></button>}
        </div>
        {!connected && <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning-foreground" role="alert">当前离线，消息保留在服务端，连接恢复后可继续。</div>}
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {loading && <p className="py-8 text-center text-xs text-muted-foreground">加载消息...</p>}
          {!loading && visible.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">{search ? "没有匹配消息" : "频道中还没有消息"}</p>}
          {visible.map((message) => {
            const canModify = message.authorId === profile.userId || profile.role === "admin" || profile.role === "owner";
            return <div className="group flex items-start gap-3 border-b border-border/50 py-3 last:border-none" key={message.id}><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-medium">{message.authorName.slice(0, 2)}</span><div className="min-w-0 flex-1"><p className="m-0 text-sm"><span className="font-medium">{message.authorName}</span><time className="ml-2 text-[10px] text-muted-foreground">{new Date(message.createdAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>{message.editedAt && <span className="ml-1 text-[10px] text-muted-foreground">已编辑</span>}</p><p className="m-0 mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/80">{message.body}</p>{message.blocks?.map((block, index) => <pre key={index} className="mt-2 overflow-auto rounded-md border bg-muted/40 p-2 text-[10px]">{JSON.stringify(block.value, null, 2)}</pre>)}</div><div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" title="回复线程" aria-label="回复线程" onClick={() => void startThread(message)}><MessageSquareReply size={13} /></button>{canModify && <button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" title="编辑消息" aria-label="编辑消息" onClick={() => void modify(message)}><Pencil size={13} /></button>}{canModify && <button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent text-destructive-foreground hover:bg-destructive/10" title="删除消息" aria-label="删除消息" onClick={() => void remove(message)}><Trash2 size={13} /></button>}</div></div>;
          })}
        </div>
        <div className="shrink-0 border-t p-3"><div className="flex items-end gap-2 rounded-md border bg-background px-3 py-2"><textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={thread ? "回复线程" : `发送到 #${selected?.name ?? "频道"}`} rows={1} className="max-h-32 min-w-0 flex-1 resize-none border-none bg-transparent text-sm outline-none" /><button className="grid h-8 w-8 place-items-center rounded-md border-none bg-primary text-primary-foreground disabled:opacity-40" disabled={!composer.trim() || !connected} onClick={() => void submit()} aria-label="发送消息"><Send size={15} /></button></div></div>
      </div>
    </div>
  );
}
