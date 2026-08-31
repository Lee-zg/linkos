import { useEffect, useRef, useState } from "react";
import { Send, ShieldCheck } from "lucide-react";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

const channels = ["工程协作", "版本发布", "设计评审", "随手记录"];

export function ChatApp() {
  const { messages, sendMessage } = useWorkspace();
  const toast = useToast();
  const [composer, setComposer] = useState("");
  const [channel, setChannel] = useState("工程协作");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const onSend = () => {
    const body = composer.trim();
    if (!body) return;
    sendMessage(body);
    setComposer("");
    toast("消息已发送到 #工程协作");
  };

  return (
    <div className="flex h-full">
      <aside className="hidden w-44 shrink-0 flex-col border-r bg-muted/30 p-2 sm:flex">
        <p className="m-0 px-2 py-1.5 text-xs font-medium text-muted-foreground">
          频道
        </p>
        {channels.map((name) => (
          <button
            key={name}
            className={`cursor-pointer rounded-md border-none px-2 py-1.5 text-left text-sm ${
              channel === name
                ? "bg-accent font-medium"
                : "bg-transparent text-muted-foreground hover:bg-accent/60"
            }`}
            onClick={() => setChannel(name)}
          >
            <span className="mr-1.5 text-muted-foreground"># </span>
            {name}
          </button>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b px-4 py-3">
          <p className="m-0 text-sm font-semibold"># {channel}</p>
          <p className="m-0 mt-0.5 text-xs text-muted-foreground">
            12 位成员 · 过去 7 天 1,284 条消息
          </p>
        </div>
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <ShieldCheck size={14} className="shrink-0 text-muted-foreground" />
          <p className="m-0 truncate text-xs text-muted-foreground">
            Runner 网络策略保持 deny，发布前请在任务结果中附上提交版本。
          </p>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-4 py-2">
          {messages.map((message) => (
            <div className="flex items-start gap-3 py-2.5" key={message.id}>
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-xs font-medium text-foreground/70">
                {message.initials}
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-sm">
                  <span className="font-medium">{message.author}</span>
                  <time className="ml-2 text-xs text-muted-foreground">
                    {message.time}
                  </time>
                </p>
                <p className="m-0 mt-0.5 text-sm leading-relaxed text-foreground/80">
                  {message.body}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t p-3">
          <div className="flex items-end gap-2 rounded-lg border bg-background px-3 py-2">
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                  onSend();
              }}
              placeholder={`发送消息到 #${channel}`}
              rows={1}
              className="max-h-32 min-w-0 flex-1 resize-none border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border-none bg-primary text-primary-foreground hover:opacity-90"
              aria-label="发送消息"
              onClick={onSend}
            >
              <Send size={15} />
            </button>
          </div>
          <p className="m-0 mt-1.5 text-xs text-muted-foreground">
            Ctrl + Enter 发送
          </p>
        </div>
      </div>
    </div>
  );
}
