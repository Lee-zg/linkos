import { useState } from "react";
import { Code2, Files, MessageSquare, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";

type Plugin = {
  id: string;
  name: string;
  desc: string;
  version: string;
  enabled: boolean;
  icon: LucideIcon;
  gradient: string;
};

const pluginSeed: Plugin[] = [
  {
    id: "files.core",
    name: "文件",
    desc: "分片传输、版本和共享",
    version: "0.1.0",
    enabled: true,
    icon: Files,
    gradient: "linear-gradient(135deg, #fbbf24, #ea580c)",
  },
  {
    id: "chat.core",
    name: "聊天",
    desc: "频道、线程与资源引用",
    version: "0.1.0",
    enabled: true,
    icon: MessageSquare,
    gradient: "linear-gradient(135deg, #4ade80, #16a34a)",
  },
  {
    id: "code.workbench",
    name: "代码工作台",
    desc: "查看、编辑和运行代码",
    version: "0.1.0",
    enabled: true,
    icon: Code2,
    gradient: "linear-gradient(135deg, #818cf8, #4f46e5)",
  },
  {
    id: "runner.exec",
    name: "运行任务",
    desc: "Runner 调度与日志流",
    version: "0.1.0",
    enabled: true,
    icon: Terminal,
    gradient: "linear-gradient(135deg, #c084fc, #9333ea)",
  },
];

export function PluginsApp() {
  const { connected } = useWorkspace();
  const toast = useToast();
  const [plugins, setPlugins] = useState(pluginSeed);
  const onToggle = (id: string) => {
    const plugin = plugins.find((item) => item.id === id);
    if (!plugin) return;
    const enabled = !plugin.enabled;
    setPlugins((current) =>
      current.map((item) => (item.id === id ? { ...item, enabled } : item)),
    );
    toast(`${plugin.name}已${enabled ? "启用" : "停用"}`);
  };
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-medium">插件运行时已就绪</p>
          <p className="m-0 mt-0.5 text-xs text-muted-foreground">
            4 个官方插件正在运行，API 版本 1.0 兼容。
          </p>
        </div>
        <button
          className="shrink-0 cursor-pointer rounded-lg border bg-transparent px-3 py-1.5 text-xs hover:bg-accent"
          onClick={() => toast("插件开发文档已打开")}
        >
          开发 SDK
        </button>
      </div>
      {!connected && (
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
          role="alert"
        >
          网关离线，插件状态可能不是最新；当前修改仅保存在本地。
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {plugins.map((plugin) => {
          const Icon = plugin.icon;
          return (
            <section className="rounded-lg border bg-card p-4" key={plugin.id}>
              <div className="flex items-center gap-3">
                <span
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]"
                  style={{ background: plugin.gradient }}
                >
                  <Icon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm font-medium">{plugin.name}</p>
                  <p className="m-0 mt-0.5 truncate text-xs text-muted-foreground">
                    {plugin.desc}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t pt-3">
                <span className="font-mono text-xs text-muted-foreground">
                  {plugin.id} · v{plugin.version}
                </span>
                <button
                  className={`h-5 w-9 shrink-0 cursor-pointer rounded-full border-none p-0.5 transition-colors ${
                    plugin.enabled ? "bg-foreground" : "bg-input"
                  }`}
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`启用 ${plugin.name}`}
                  onClick={() => onToggle(plugin.id)}
                >
                  <span
                    className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                      plugin.enabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
