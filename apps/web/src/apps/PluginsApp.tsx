import { useEffect, useRef, useState } from "react";
import type { PluginManifest, PluginRecord } from "@linkos/protocol";
import { Eye, PackagePlus, RotateCcw, ShieldCheck } from "lucide-react";
import { installPlugin, listPlugins, setPluginStatus } from "../lib/api";
import { useWorkspace } from "../lib/workspace";
import { useToast } from "../os/Toaster";
import { PluginFrame } from "./PluginFrame";

export function PluginsApp() {
  const { connected, lastEvent } = useWorkspace();
  const toast = useToast();
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [selected, setSelected] = useState<PluginRecord | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = () => void listPlugins().then((result) => { setPlugins(result.items); setSelected((current) => current ? result.items.find((item) => item.id === current.id) ?? null : null); }).catch(() => toast("插件列表加载失败"));
  useEffect(() => { if (connected) refresh(); }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lastEvent?.type === "plugin.updated") refresh(); }, [lastEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  const transition = async (plugin: PluginRecord, action: "enable" | "disable" | "rollback") => {
    if (action === "enable" && !window.confirm(`启用 ${plugin.name}？\n\n权限：\n${plugin.permissions.join("\n") || "无"}`)) return;
    try { const updated = await setPluginStatus(plugin.id, action); setPlugins((items) => items.map((item) => item.id === updated.id ? updated : item)); toast(`${plugin.name} 已${action === "enable" ? "启用" : action === "disable" ? "停用" : "回滚"}`); }
    catch (error) { toast("插件操作失败", error instanceof Error ? error.message : "请检查权限"); }
  };
  const onManifest = async (file: File) => {
    try {
      const manifest = JSON.parse(await file.text()) as PluginManifest;
      if (!window.confirm(`安装 ${manifest.name || manifest.id}？\n\n请求权限：\n${manifest.permissions?.join("\n") || "无"}`)) return;
      const installed = await installPlugin(manifest);
      setPlugins((items) => [...items.filter((item) => item.id !== installed.id), installed]);
      toast("插件已安装", installed.name);
    } catch (error) { toast("安装失败", error instanceof Error ? error.message : "manifest 无效"); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3"><ShieldCheck size={16} /><div className="min-w-0 flex-1"><p className="m-0 text-sm font-medium">插件中心</p><p className="m-0 mt-0.5 text-xs text-muted-foreground">API 1.0 · 签名验证 · 独立沙箱</p></div><input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onManifest(file); event.target.value = ""; }} /><button className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs hover:bg-accent" onClick={() => inputRef.current?.click()}><PackagePlus size={13} />安装</button></div>
      {!connected && <div className="border-b bg-warning/10 px-4 py-2 text-xs text-warning-foreground">网关离线，插件状态暂不可更改。</div>}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {plugins.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">没有已发现的插件</p>}
        <div className="grid gap-3 sm:grid-cols-2">{plugins.map((plugin) => <section className="rounded-md border bg-card p-3" key={plugin.id}><div className="flex items-start gap-3"><span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${plugin.health === "healthy" ? "bg-success" : "bg-warning"}`} /><div className="min-w-0 flex-1"><p className="m-0 truncate text-sm font-medium">{plugin.name}</p><p className="m-0 mt-0.5 font-mono text-[10px] text-muted-foreground">{plugin.id} · v{plugin.version}</p></div><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{plugin.status}</span></div><div className="mt-3 flex flex-wrap gap-1">{plugin.permissions.map((permission) => <span key={permission} className="rounded border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{permission}</span>)}</div><div className="mt-3 flex items-center gap-1 border-t pt-2"><button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" title="查看沙箱" aria-label="查看沙箱" onClick={() => setSelected(plugin)}><Eye size={13} /></button><button className="grid h-7 w-7 place-items-center rounded-md border-none bg-transparent hover:bg-accent" title="回滚插件" aria-label="回滚插件" disabled={!connected} onClick={() => void transition(plugin, "rollback")}><RotateCcw size={13} /></button><button className={`ml-auto h-6 w-10 rounded-full border-none p-0.5 ${plugin.status === "enabled" ? "bg-foreground" : "bg-input"}`} role="switch" aria-checked={plugin.status === "enabled"} disabled={!connected} onClick={() => void transition(plugin, plugin.status === "enabled" ? "disable" : "enable")}><span className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${plugin.status === "enabled" ? "translate-x-4" : "translate-x-0"}`} /></button></div></section>)}</div>
        {selected && <section className="mt-4 border-t pt-4"><div className="mb-2 flex items-center"><p className="m-0 flex-1 text-xs font-medium">{selected.name} 沙箱</p><button className="border-none bg-transparent text-xs text-muted-foreground" onClick={() => setSelected(null)}>关闭</button></div><PluginFrame plugin={selected} /></section>}
      </div>
    </div>
  );
}
